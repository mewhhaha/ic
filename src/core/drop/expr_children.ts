import { type CoreDropStmtScanner, scan_drop_block_expr } from "./block.ts";
import {
  clone_drop_owners,
  loop_exit_owners,
  next_loop_scope,
} from "./state.ts";
import {
  drop_loop_local_owners,
  merge_carried_loop_owners,
} from "./loop_stmt.ts";
import { scan_drop_closure_body } from "./closure_body.ts";
import {
  scan_drop_if_expr,
  scan_drop_if_let_expr,
} from "./conditional_expr.ts";
import type { CoreDropResultExprScanner } from "./expr_result.ts";
import {
  consume_host_transfer_args,
  consume_runtime_aggregate_resume_field_owners,
  consume_runtime_union_payload_owner,
  unique_heap_ownership,
} from "./ownership.ts";
import { emit_drop } from "./emit.ts";
import { find_core_diagnostic_subject } from "../source_origin.ts";
import { canonical_core_expr } from "../subject_provenance.ts";
import { consume_static_host_transfer_call } from "./static_transfer.ts";
import type {
  CoreDropExitOwners,
  CoreDropHooks,
  CoreDropOwner,
  CoreDropState,
  CoreExpr,
  CoreField,
  CoreStmt,
} from "./types.ts";

type CoreDropStmtsScanner<ctx> = (
  statements: CoreStmt[],
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  drop_fallthrough_owners?: boolean,
) => boolean;

export function scan_drop_expr_children_impl<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_stmt: CoreDropStmtScanner<ctx>,
  scan_drop_stmts: CoreDropStmtsScanner<ctx>,
  scan_drop_result_expr: CoreDropResultExprScanner<ctx>,
): boolean {
  const scan_children = (
    child: CoreExpr,
    child_scope: string,
    child_owners: Map<string, CoreDropOwner>,
    child_exit_owners: CoreDropExitOwners,
    child_ctx: ctx,
    child_hooks: CoreDropHooks<ctx>,
    child_state: CoreDropState,
  ): boolean => {
    return scan_drop_expr_children_impl(
      child,
      child_scope,
      child_owners,
      child_exit_owners,
      child_ctx,
      child_hooks,
      child_state,
      scan_drop_stmt,
      scan_drop_stmts,
      scan_drop_result_expr,
    );
  };

  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "rec_ref":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return true;

    case "lam":
    case "rec":
      return scan_drop_closure_body(
        expr,
        ctx,
        hooks,
        state,
        scan_drop_stmts,
        scan_children,
      );

    case "prim":
      for (const arg of expr.args) {
        const continues = scan_children(
          arg,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        );
        if (!continues) {
          return false;
        }
      }
      return true;

    case "app": {
      const transfer_start = state.steps.length;
      const continues = scan_children(
        expr.func,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      if (!continues) {
        return false;
      }
      for (const arg of expr.args) {
        const continues = scan_children(
          arg,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        );
        if (!continues) {
          return false;
        }
      }
      consume_host_transfer_args(expr, scope, owners, ctx, hooks, state);
      consume_static_host_transfer_call(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      consume_runtime_union_payload_owner(expr, owners, ctx, hooks, state);
      drop_temporary_app_args(
        expr,
        scope,
        ctx,
        hooks,
        state.steps.slice(transfer_start),
        state,
      );
      return true;
    }

    case "block": {
      return scan_drop_block_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
        scan_drop_stmt,
        scan_drop_result_expr,
      );
    }

    case "loop": {
      const loop_scope = next_loop_scope(state);
      const carried = clone_drop_owners(owners);
      const loop_owners = clone_drop_owners(carried);
      scan_drop_stmts(
        expr.body,
        loop_scope,
        loop_owners,
        loop_exit_owners(carried, exit_owners),
        ctx,
        hooks,
        state,
        false,
      );
      drop_loop_local_owners(loop_scope, loop_owners, carried, state);
      merge_carried_loop_owners(
        owners,
        loop_owners,
        Array.from(carried.keys()),
      );
      state.expr_results.set(expr, { tag: "none" });
      return true;
    }

    case "comptime":
      return scan_children(
        expr.expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "borrow":
    case "freeze":
      return scan_children(
        expr.value,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "scratch": {
      let scratch_ctx = ctx;
      if (hooks.scratch_return_ctx) {
        scratch_ctx = hooks.scratch_return_ctx(ctx);
      }
      return scan_children(
        expr.body,
        scope,
        owners,
        exit_owners,
        scratch_ctx,
        hooks,
        state,
      );
    }

    case "with":
      if (
        !scan_children(
          expr.base,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_fields(
        expr.fields,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
        scan_children,
      );

    case "struct_value":
      if (
        !scan_children(
          expr.type_expr,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      {
        const continues = scan_drop_fields(
          expr.fields,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
          scan_children,
        );
        if (!continues) {
          return false;
        }
        consume_runtime_aggregate_resume_field_owners(
          expr,
          owners,
          ctx,
          hooks,
          state,
        );
        return true;
      }

    case "struct_update":
      if (
        !scan_children(
          expr.base,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_fields(
        expr.fields,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
        scan_children,
      );

    case "if": {
      return scan_drop_if_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
        scan_children,
        scan_drop_result_expr,
      );
    }

    case "if_let": {
      return scan_drop_if_let_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
        scan_children,
        scan_drop_result_expr,
      );
    }

    case "field":
      return scan_children(
        expr.object,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "index":
      if (
        !scan_children(
          expr.object,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_children(
        expr.index,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "union_case":
      if (expr.value) {
        const continues = scan_children(
          expr.value,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        );
        if (!continues) {
          return false;
        }
      }

      if (expr.type_expr) {
        const continues = scan_children(
          expr.type_expr,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        );
        if (!continues) {
          return false;
        }
      }

      consume_runtime_union_payload_owner(expr, owners, ctx, hooks, state);
      return true;
  }
}

function scan_drop_fields<ctx>(
  fields: CoreField[],
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_children: (
    child: CoreExpr,
    child_scope: string,
    child_owners: Map<string, CoreDropOwner>,
    child_exit_owners: CoreDropExitOwners,
    child_ctx: ctx,
    child_hooks: CoreDropHooks<ctx>,
    child_state: CoreDropState,
  ) => boolean,
): boolean {
  for (const field of fields) {
    const continues = scan_children(
      field.value,
      scope,
      owners,
      exit_owners,
      ctx,
      hooks,
      state,
    );
    if (!continues) {
      return false;
    }
  }

  return true;
}

function drop_temporary_app_args<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  call_steps: CoreDropState["steps"],
  state: CoreDropState,
): void {
  let union_payload: CoreExpr | undefined;
  const union_value = hooks.runtime_union_value(expr, ctx);
  if (union_value && union_value.tag === "union_case") {
    union_payload = union_value.value;
  }

  for (let index = 0; index < expr.args.length; index += 1) {
    const arg = expr.args[index];
    if (!arg) {
      throw new Error("Missing temporary app argument " + index.toString());
    }
    if (
      expr.func.tag === "var" && expr.func.name === "@Bytes.generate" &&
      index === 1
    ) {
      continue;
    }
    if (arg.tag === "var" || arg.tag === "linear") {
      continue;
    }
    if (arg.tag === "borrow" || arg.tag === "freeze") {
      continue;
    }
    if (
      state.consumed_temporary_subjects.has(arg) ||
      state.consumed_temporary_subjects.has(canonical_core_expr(arg))
    ) {
      continue;
    }
    const aggregate_access = static_aggregate_text_access(arg);
    if (aggregate_access) {
      if (state.frozen_aggregate_owners.has(aggregate_access.owner)) {
        continue;
      }
      const fields = state.static_aggregate_fields.get(aggregate_access.owner);
      if (fields && fields.static_texts.has(aggregate_access.path)) {
        continue;
      }
    }
    if (hooks.static_text_value(arg, ctx)) {
      continue;
    }
    const static_value = hooks.static_value(arg, ctx);
    if (static_value) {
      if (static_value.tag === "text") {
        continue;
      }
      if (hooks.static_text_value(static_value, ctx)) {
        continue;
      }
    }
    if (
      union_payload &&
      canonical_core_expr(union_payload) === canonical_core_expr(arg)
    ) {
      continue;
    }
    if (
      call_steps.some((step) => {
        if (step.tag !== "host_transfer") {
          return false;
        }
        const subject = find_core_diagnostic_subject(step);
        if (!subject || !drop_subject_is_expr(subject)) {
          return false;
        }
        return canonical_core_expr(subject) === canonical_core_expr(arg);
      })
    ) {
      continue;
    }

    const ownership = unique_heap_ownership(arg, ctx, hooks);
    if (!ownership) {
      continue;
    }
    emit_drop(
      "discarded_expr",
      scope,
      undefined,
      { name: "", ownership, pointer: "temporary", subject: arg },
      state,
      arg,
    );
  }
}

function static_aggregate_text_access(
  expr: CoreExpr,
): { owner: string; path: string } | undefined {
  if (expr.tag !== "field") {
    return undefined;
  }
  if (expr.object.tag === "var" || expr.object.tag === "linear") {
    return { owner: expr.object.name, path: expr.name };
  }
  const parent = static_aggregate_text_access(expr.object);
  if (!parent) {
    return undefined;
  }
  return { owner: parent.owner, path: parent.path + "." + expr.name };
}

function drop_subject_is_expr(
  subject: import("../source_origin.ts").CoreSourceSubject,
): subject is CoreExpr {
  switch (subject.tag) {
    case "bind":
    case "assign":
    case "index_assign":
    case "range_loop":
    case "collection_loop":
    case "if_stmt":
    case "if_else_stmt":
    case "if_let_stmt":
    case "type_check":
    case "break":
    case "continue":
    case "return":
    case "expr":
      return false;
    default:
      return true;
  }
}
