import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import { find_core_field, static_indexed_field } from "../analysis/field.ts";
import { maybe_static_i32 } from "../analysis/static_i32.ts";
import {
  core_scratch_return_ownership,
  core_scratch_return_rejection_detail,
} from "../cleanup.ts";
import { static_collection_item_type } from "../index_expr.ts";
import {
  core_expr_ownership,
  core_non_scalar_ownership_message,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "../ownership.ts";
import {
  core_freeze_lifetime_decision,
  core_lifetime_rejection_message,
  core_scratch_return_lifetime_decision,
} from "../lifetime.ts";
import {
  runtime_aggregate_field_info,
  runtime_aggregate_index_field,
  runtime_aggregate_type_expr,
  runtime_struct_update_value,
} from "../runtime_aggregate.ts";
import { dynamic_if_let_can_match } from "../union_static.ts";
import { if_let_expr_type } from "./if_let.ts";
import { core_expr_definitely_exits } from "./control.ts";
import { prim_expr_type } from "./prim.ts";
import type {
  CoreExprTypeBlockCtx,
  CoreExprTypeCtx,
  CoreExprTypeHooks,
} from "./types.ts";

export function stmt_result_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): ValType {
  if (stmt.tag === "expr") {
    return expr_type(stmt.expr, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return expr_type(stmt.value, ctx, hooks);
  }

  if (stmt.tag === "assign") {
    return "i32";
  }

  throw new Error("Core final statement does not produce a value: " + stmt.tag);
}

export function expr_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): ValType {
  switch (expr.tag) {
    case "num":
      return expr.type;

    case "text":
      return "i32";

    case "linear":
    case "var": {
      const lookup_expr: CoreExpr = { tag: "var", name: expr.name };
      const text_value = hooks.static_text_value(lookup_expr, ctx);

      if (text_value) {
        return "i32";
      }

      const union_value = hooks.core_runtime_union_value(lookup_expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      if (hooks.static_struct_value(lookup_expr, ctx)) {
        return "i32";
      }

      if (expr_type_closure_fn_type(lookup_expr, ctx, hooks)) {
        return "i32";
      }

      if (ctx.statics.has(expr.name)) {
        throw new Error("Cannot type core static value directly: " + expr.name);
      }

      const type = ctx.locals.get(expr.name);
      expect(type, "Unbound core local: " + expr.name);
      return type;
    }

    case "prim":
      return prim_expr_type(expr, ctx, hooks, expr_type);

    case "app": {
      const union_value = hooks.core_runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      if (hooks.runtime_union_target(expr, ctx)) {
        return "i32";
      }

      return hooks.app_type(expr, ctx);
    }

    case "if": {
      const fn_type = expr_type_closure_fn_type(expr, ctx, hooks);

      if (fn_type) {
        return "i32";
      }

      const union_value = hooks.core_runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      if (hooks.runtime_union_target(expr, ctx)) {
        return "i32";
      }

      const cond_type = expr_type(expr.cond, ctx, hooks);
      expect(cond_type === "i32", "Core if condition must be i32");
      const then_exits = core_expr_definitely_exits(expr.then_branch);
      const else_exits = core_expr_definitely_exits(expr.else_branch);

      if (then_exits && else_exits) {
        return "i32";
      }

      if (then_exits) {
        return expr_type(expr.else_branch, ctx, hooks);
      }

      const then_type = expr_type(expr.then_branch, ctx, hooks);

      if (expr.implicit_else) {
        return then_type;
      }

      if (else_exits) {
        return then_type;
      }

      const else_type = expr_type(expr.else_branch, ctx, hooks);

      expect(then_type === else_type, "Core if branch type mismatch");
      return then_type;
    }

    case "if_let": {
      const fn_type = expr_type_closure_fn_type(expr, ctx, hooks);

      if (fn_type) {
        return "i32";
      }

      return if_let_expr_type(expr, ctx, hooks, expr_type);
    }

    case "block": {
      const final_stmt = expr.statements[expr.statements.length - 1];
      expect(final_stmt, "Core block has no result statement");
      const block_ctx = hooks.create_block_ctx(ctx);

      for (let index = 0; index + 1 < expr.statements.length; index += 1) {
        const stmt = expr.statements[index];
        expect(stmt, "Missing core block statement " + index.toString());
        hooks.collect_stmt_locals(stmt, block_ctx);
      }

      return stmt_result_type(final_stmt, block_ctx, hooks);
    }

    case "loop":
      return loop_expr_type(expr, ctx, hooks);

    case "borrow": {
      const result_type = expr_type(expr.value, ctx, hooks);
      return result_type;
    }

    case "freeze": {
      const result_type = expr_type(expr.value, ctx, hooks);
      const ownership = core_expr_ownership(expr.value, ctx, {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.create_block_ctx,
        collect_stmt_locals: (stmt, value_ctx) =>
          hooks.collect_stmt_locals(stmt, value_ctx as unknown as block_ctx),
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.value) {
            return result_type;
          }

          return expr_type(value, value_ctx, hooks);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.create_block_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.core_runtime_union_value,
        scratch_return_ctx: (value_ctx) => {
          const scratch_ctx = hooks.create_block_ctx(value_ctx);
          const scratch_depth = scratch_ctx.scratch_depth;
          if (scratch_depth === undefined) {
            scratch_ctx.scratch_depth = 1;
          } else {
            scratch_ctx.scratch_depth = scratch_depth + 1;
          }
          return scratch_ctx;
        },
        runtime_aggregate_type_expr: (value, value_ctx) =>
          runtime_aggregate_type_expr(value, value_ctx, {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          }),
        static_runtime_union_match_branch_ctx:
          hooks.static_runtime_union_match_branch_ctx,
        static_struct_value: hooks.static_struct_value,
        static_core_call_requires_scope: hooks.static_core_call_requires_scope,
        static_core_call_target: hooks.static_core_call_target,
        static_core_call_value: hooks.static_core_call_value,
        static_capture_value: (name, value_ctx) =>
          value_ctx.static_capture_values?.get(name),
        static_union_case: hooks.static_union_case,
        static_text_value: hooks.static_text_value,
      });
      const decision = core_freeze_lifetime_decision(ownership);
      expect(
        decision.tag === "allowed",
        core_lifetime_rejection_message(
          core_non_scalar_ownership_message(
            "Cannot type core freeze value",
            ownership,
          ),
          decision,
        ),
      );
      return result_type;
    }

    case "scratch": {
      const result_type = expr_type(expr.body, ctx, hooks);
      const ownership_hooks: CoreOwnershipHooks<ctx> = {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.create_block_ctx,
        collect_stmt_locals: (stmt, value_ctx) =>
          hooks.collect_stmt_locals(stmt, value_ctx as unknown as block_ctx),
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.body) {
            return result_type;
          }

          return expr_type(value, value_ctx, hooks);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.create_block_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.core_runtime_union_value,
        runtime_aggregate_type_expr: (value, value_ctx) =>
          runtime_aggregate_type_expr(value, value_ctx, {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          }),
        static_runtime_union_match_branch_ctx:
          hooks.static_runtime_union_match_branch_ctx,
        static_struct_value: hooks.static_struct_value,
        static_core_call_requires_scope: hooks.static_core_call_requires_scope,
        static_core_call_target: hooks.static_core_call_target,
        static_core_call_value: hooks.static_core_call_value,
        static_capture_value: (name, value_ctx) =>
          value_ctx.static_capture_values?.get(name),
        static_union_case: hooks.static_union_case,
        static_text_value: hooks.static_text_value,
      };
      const ownership = core_scratch_return_ownership(
        expr.body,
        ctx,
        ownership_hooks,
      );
      const decision = core_scratch_return_lifetime_decision(ownership);
      const detail = core_scratch_return_rejection_detail(
        expr.body,
        ctx,
        ownership_hooks,
      );
      expect(
        decision.tag === "allowed",
        core_lifetime_rejection_message(
          core_scratch_rejection_message(
            "Cannot type core scratch block",
            ownership,
            detail,
          ),
          decision,
        ),
      );
      return result_type;
    }

    case "field": {
      const struct_value = hooks.static_struct_value(expr.object, ctx);

      if (!struct_value) {
        const field_info = runtime_aggregate_field_info(
          expr.object,
          expr.name,
          ctx,
          {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          },
        );

        if (!field_info) {
          throw new Error("Cannot type core field expression yet");
        }

        if (field_info.tag === "struct") {
          return "i32";
        }

        expect(field_info.tag === "value", "Core unit field has no value");
        return field_info.type;
      }

      const field = find_core_field(struct_value.fields, expr.name);
      expect(field, "Missing static core field: " + expr.name);
      return expr_type(field.value, ctx, hooks);
    }

    case "index": {
      const fields = hooks.static_collection_fields(expr.object, ctx);

      if (!fields) {
        const text_byte = hooks.static_text_byte_index_expr(expr, ctx);

        if (text_byte) {
          return expr_type(text_byte, ctx, hooks);
        }

        if (hooks.core_expr_is_text(expr.object, ctx)) {
          const index_type = expr_type(expr.index, ctx, hooks);
          expect(index_type === "i32", "Core text byte index must be i32");
          return "i32";
        }

        const index = maybe_static_i32(expr.index);
        if (index !== undefined) {
          const field = runtime_aggregate_index_field(
            expr.object,
            index,
            ctx,
            {
              check_closure_call_args: hooks.check_closure_call_args,
              closure_fn_type: hooks.closure_fn_type,
            },
          );
          if (field) {
            expect(field.tag !== "unit", "Core unit index has no value");
            if (field.tag === "struct") {
              return "i32";
            }
            return field.type;
          }
        }

        throw new Error("Cannot type core index expression yet");
      }

      const index_type = expr_type(expr.index, ctx, hooks);
      expect(index_type === "i32", "Core index expression index must be i32");
      const index = maybe_static_i32(expr.index);

      if (index !== undefined) {
        const field = static_indexed_field(fields, index);
        return expr_type(field.value, ctx, hooks);
      }

      const item_type = static_collection_item_type(fields, ctx, {
        expr_type: (value: CoreExpr, item_ctx: ctx) =>
          expr_type(value, item_ctx, hooks),
      });
      expect(item_type, "Core dynamic index requires non-empty collection");
      return item_type;
    }

    case "struct_value":
      return "i32";

    case "struct_update": {
      const updated = runtime_struct_update_value(expr, ctx, {
        check_closure_call_args: hooks.check_closure_call_args,
        closure_fn_type: hooks.closure_fn_type,
        static_struct_value: hooks.static_struct_value,
      });
      expect(updated, "Cannot update non-struct core value");
      return "i32";
    }

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        throw new Error("Missing host capability method: " + expr.text);
      }

      throw new Error("Cannot type core " + expr.tag + " expression yet");

    case "type_name":
    case "rec":
    case "comptime":
    case "with":
    case "struct_type":
    case "union_type":
      throw new Error("Cannot type core " + expr.tag + " expression yet");

    case "union_case":
      return hooks.runtime_union_value_type(expr, ctx);

    case "lam": {
      const fn_type = hooks.closure_fn_type(expr, ctx);

      if (fn_type) {
        return "i32";
      }

      throw new Error("Cannot type core " + expr.tag + " expression yet");
    }

    case "rec_ref":
      // rec name stands for the function; calls are handled specially; type as i32 (ptr-like or direct)
      return "i32";
  }
}

function loop_expr_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "loop" }>,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): ValType {
  const break_types: ValType[] = [];
  const loop_ctx = hooks.create_block_ctx(ctx);
  collect_loop_break_types(expr.body, loop_ctx, hooks, break_types);
  expect(
    break_types.length > 0,
    "Core value-producing loop requires at least one direct break value",
  );
  const result_type = break_types[0];
  expect(result_type, "Core loop break type is missing");

  for (const type of break_types) {
    expect(type === result_type, "Core loop break value type mismatch");
  }

  return result_type;
}

function collect_loop_break_types<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  statements: CoreStmt[],
  ctx: block_ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  break_types: ValType[],
): void {
  for (const stmt of statements) {
    switch (stmt.tag) {
      case "break": {
        if (!stmt.value) {
          break_types.push("i32");
          continue;
        }
        const type = expr_type(stmt.value, ctx, hooks);
        const ownership = core_expr_ownership(stmt.value, ctx, {
          closure_fn_type: hooks.closure_fn_type,
          core_expr_is_text: hooks.core_expr_is_text,
          bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
          bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
          block_ctx: hooks.create_block_ctx,
          collect_stmt_locals: (stmt, value_ctx) =>
            hooks.collect_stmt_locals(
              stmt,
              value_ctx as unknown as block_ctx,
            ),
          dynamic_union_if: hooks.dynamic_union_if,
          expr_type: (value, value_ctx) => expr_type(value, value_ctx, hooks),
          frozen_local: frozen_core_local,
          if_let_branch_ctx: hooks.create_block_ctx,
          runtime_union_match_info: hooks.runtime_union_match_info,
          runtime_union_target: hooks.runtime_union_target,
          runtime_union_value: hooks.core_runtime_union_value,
          runtime_aggregate_type_expr: (value, value_ctx) =>
            runtime_aggregate_type_expr(value, value_ctx, {
              check_closure_call_args: hooks.check_closure_call_args,
              closure_fn_type: hooks.closure_fn_type,
            }),
          static_runtime_union_match_branch_ctx:
            hooks.static_runtime_union_match_branch_ctx,
          static_struct_value: hooks.static_struct_value,
          static_core_call_requires_scope:
            hooks.static_core_call_requires_scope,
          static_core_call_target: hooks.static_core_call_target,
          static_core_call_value: hooks.static_core_call_value,
          static_capture_value: (name, value_ctx) =>
            value_ctx.static_capture_values?.get(name),
          static_union_case: hooks.static_union_case,
          static_text_value: hooks.static_text_value,
        });
        expect(
          ownership.tag === "scalar_local",
          core_non_scalar_ownership_message(
            "Core value-producing loop break result must be scalar",
            ownership,
          ),
        );
        break_types.push(type);
        continue;
      }

      case "if_stmt":
        expect(
          expr_type(stmt.cond, ctx, hooks) === "i32",
          "Core if condition must be i32",
        );
        collect_loop_break_types(
          stmt.body,
          hooks.create_block_ctx(ctx),
          hooks,
          break_types,
        );
        continue;

      case "if_else_stmt":
        expect(
          expr_type(stmt.cond, ctx, hooks) === "i32",
          "Core if condition must be i32",
        );
        collect_loop_break_types(
          stmt.then_body,
          hooks.create_block_ctx(ctx),
          hooks,
          break_types,
        );
        collect_loop_break_types(
          stmt.else_body,
          hooks.create_block_ctx(ctx),
          hooks,
          break_types,
        );
        continue;

      case "if_let_stmt":
        {
          const branch_ctx = loop_if_let_branch_ctx(
            stmt.case_name,
            stmt.value_name,
            stmt.target,
            ctx,
            hooks,
          );

          if (branch_ctx) {
            collect_loop_break_types(
              stmt.body,
              branch_ctx,
              hooks,
              break_types,
            );
          }
        }
        continue;

      case "range_loop":
      case "collection_loop":
        continue;

      case "bind":
      case "assign":
        hooks.collect_stmt_locals(stmt, ctx);
        continue;

      case "index_assign":
      case "type_check":
      case "return":
      case "continue":
      case "unsupported":
        hooks.collect_stmt_locals(stmt, ctx);
        continue;

      case "expr":
        collect_loop_expr_break_types(stmt.expr, ctx, hooks, break_types);
        continue;
    }
  }
}

function collect_loop_expr_break_types<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: CoreExpr,
  ctx: block_ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  break_types: ValType[],
): void {
  switch (expr.tag) {
    case "loop":
    case "lam":
    case "rec":
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "rec_ref":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "block":
      collect_loop_break_types(
        expr.statements,
        hooks.create_block_ctx(ctx),
        hooks,
        break_types,
      );
      return;

    case "if":
      expect(
        expr_type(expr.cond, ctx, hooks) === "i32",
        "Core if condition must be i32",
      );
      collect_loop_expr_break_types(
        expr.then_branch,
        hooks.create_block_ctx(ctx),
        hooks,
        break_types,
      );
      collect_loop_expr_break_types(
        expr.else_branch,
        hooks.create_block_ctx(ctx),
        hooks,
        break_types,
      );
      return;

    case "if_let":
      collect_loop_expr_break_types(expr.target, ctx, hooks, break_types);
      {
        const branch_ctx = loop_if_let_branch_ctx(
          expr.case_name,
          expr.value_name,
          expr.target,
          ctx,
          hooks,
        );

        if (branch_ctx) {
          collect_loop_expr_break_types(
            expr.then_branch,
            branch_ctx,
            hooks,
            break_types,
          );
        }
      }
      collect_loop_expr_break_types(
        expr.else_branch,
        hooks.create_block_ctx(ctx),
        hooks,
        break_types,
      );
      return;

    case "prim":
      for (const arg of expr.args) {
        collect_loop_expr_break_types(arg, ctx, hooks, break_types);
      }
      return;

    case "app":
      collect_loop_expr_break_types(expr.func, ctx, hooks, break_types);
      for (const arg of expr.args) {
        collect_loop_expr_break_types(arg, ctx, hooks, break_types);
      }
      return;

    case "comptime":
      collect_loop_expr_break_types(expr.expr, ctx, hooks, break_types);
      return;

    case "borrow":
    case "freeze":
      collect_loop_expr_break_types(expr.value, ctx, hooks, break_types);
      return;

    case "scratch":
      collect_loop_expr_break_types(expr.body, ctx, hooks, break_types);
      return;

    case "with":
      collect_loop_expr_break_types(expr.base, ctx, hooks, break_types);
      collect_loop_field_break_types(expr.fields, ctx, hooks, break_types);
      return;

    case "struct_value":
      collect_loop_expr_break_types(expr.type_expr, ctx, hooks, break_types);
      collect_loop_field_break_types(expr.fields, ctx, hooks, break_types);
      return;

    case "struct_update":
      collect_loop_expr_break_types(expr.base, ctx, hooks, break_types);
      collect_loop_field_break_types(expr.fields, ctx, hooks, break_types);
      return;

    case "field":
      collect_loop_expr_break_types(expr.object, ctx, hooks, break_types);
      return;

    case "index":
      collect_loop_expr_break_types(expr.object, ctx, hooks, break_types);
      collect_loop_expr_break_types(expr.index, ctx, hooks, break_types);
      return;

    case "union_case":
      if (expr.value) {
        collect_loop_expr_break_types(expr.value, ctx, hooks, break_types);
      }
      if (expr.type_expr) {
        collect_loop_expr_break_types(expr.type_expr, ctx, hooks, break_types);
      }
      return;
  }
}

function loop_if_let_branch_ctx<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: block_ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): block_ctx | undefined {
  const union_case = hooks.static_union_case(target, ctx);

  if (union_case) {
    const branch_ctx = hooks.create_block_ctx(ctx);

    if (union_case.name !== case_name) {
      return undefined;
    }

    hooks.bind_core_if_let_payload_fact(
      value_name,
      union_case,
      branch_ctx,
    );

    return branch_ctx;
  }

  const dynamic_target = hooks.dynamic_union_if(target, ctx);

  if (dynamic_target) {
    const branch_ctx = hooks.create_block_ctx(ctx);

    if (!dynamic_if_let_can_match(case_name, dynamic_target)) {
      return undefined;
    }

    hooks.bind_dynamic_if_let_payload(
      case_name,
      value_name,
      dynamic_target,
      branch_ctx,
    );
    hooks.clear_optional_core_union_local(value_name, branch_ctx);

    return branch_ctx;
  }

  const runtime_target = hooks.runtime_union_target(target, ctx);

  if (!runtime_target) {
    throw new Error(
      "Core loop if let target requires union type facts: " +
        JSON.stringify(target),
    );
  }

  const info = hooks.runtime_union_match_info(case_name, runtime_target, ctx);
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    value_name,
    info,
    ctx,
  );
  return hooks.create_block_ctx(branch_ctx);
}

function collect_loop_field_break_types<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  fields: CoreField[],
  ctx: block_ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  break_types: ValType[],
): void {
  for (const field of fields) {
    collect_loop_expr_break_types(field.value, ctx, hooks, break_types);
  }
}

function expr_type_closure_fn_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): CoreFnType | undefined {
  try {
    return hooks.closure_fn_type(expr, ctx);
  } catch (error) {
    if (expr_type_closure_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function expr_type_closure_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith(
    "Core first-class closure parameter must use a scalar annotation:",
  );
}

function core_scratch_rejection_message(
  prefix: string,
  ownership: CoreOwnership,
  detail: string | undefined,
): string {
  if (detail) {
    return prefix + " with unsafe scratch return " + detail + " and " +
      "non-scalar " + core_ownership_result_text(ownership) + " result yet";
  }

  return core_non_scalar_ownership_message(prefix, ownership);
}

function frozen_core_local<ctx extends { frozen_locals?: Set<string> }>(
  name: string,
  ctx: ctx,
): boolean {
  if (!ctx.frozen_locals) {
    return false;
  }

  return ctx.frozen_locals.has(name);
}
