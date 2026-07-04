import type { ValType } from "../op.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import type { DynamicUnionIf } from "./if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "./runtime_union.ts";
import { static_block_result } from "./type_static.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";

export type CoreOwnership =
  | {
    tag: "scalar_local";
    type: ValType;
  }
  | {
    tag: "unique_heap";
    reason: CoreOwnershipPointerReason;
  }
  | {
    tag: "frozen_shareable";
    reason: CoreOwnershipPointerReason | "freeze";
  }
  | {
    tag: "borrow_view";
    source: CoreOwnership;
  }
  | {
    tag: "scratch_backed";
    source: CoreOwnership;
  };

export type CoreOwnershipPointerReason =
  | "text"
  | "closure"
  | "runtime_union"
  | "runtime_aggregate";

export type CoreOwnershipHooks<ctx> = {
  bind_core_if_let_payload_fact?: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => void;
  bind_dynamic_if_let_payload?: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: ctx,
  ) => void;
  block_ctx?: (ctx: ctx) => ctx;
  closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
  collect_stmt_locals?: (stmt: CoreStmt, ctx: ctx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  dynamic_union_if?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  frozen_local?: (name: string, ctx: ctx) => boolean;
  host_import_result_ownership?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreOwnership | undefined;
  if_let_branch_ctx?: (ctx: ctx) => ctx;
  runtime_aggregate_type_expr?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_match_info?: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => RuntimeUnionTarget | undefined;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_runtime_union_match_branch_ctx?: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => ctx;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  scoped_static_core_call_value?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_union_case?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export function core_expr_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership {
  const block_value = static_block_result(expr);

  if (block_value) {
    return core_expr_ownership(block_value, ctx, hooks);
  }

  const block_result = core_block_result_with_ctx(expr, ctx, hooks);

  if (block_result) {
    return core_expr_ownership(block_result.expr, block_result.ctx, hooks);
  }

  if (expr.tag === "borrow") {
    const source = core_expr_ownership(expr.value, ctx, hooks);

    if (
      source.tag === "scalar_local" ||
      source.tag === "frozen_shareable"
    ) {
      return source;
    }

    return { tag: "borrow_view", source };
  }

  if (expr.tag === "freeze") {
    const source = core_expr_ownership(expr.value, ctx, hooks);

    if (source.tag === "scalar_local") {
      return source;
    }

    return { tag: "frozen_shareable", reason: "freeze" };
  }

  if (expr.tag === "scratch") {
    const source = core_expr_ownership(expr.body, ctx, hooks);

    if (
      source.tag === "scalar_local" ||
      source.tag === "frozen_shareable"
    ) {
      return source;
    }

    return { tag: "scratch_backed", source };
  }

  if (expr.tag === "app") {
    const scoped = scoped_static_ownership_call_value(expr, ctx, hooks);

    if (scoped) {
      return core_expr_ownership(scoped.value, scoped.ctx, hooks);
    }
  }

  if (
    expr.tag === "if" &&
    !expr.implicit_else &&
    (
      hooks.core_expr_is_text(expr, ctx) ||
      core_if_branches_are_freeze_results(expr)
    )
  ) {
    const merged = core_if_branch_ownership(expr, ctx, hooks);

    if (merged) {
      return merged;
    }
  }

  if (
    expr.tag === "if_let" &&
    !expr.implicit_else &&
    hooks.core_expr_is_text(expr, ctx)
  ) {
    const merged = core_if_let_branch_ownership(expr, ctx, hooks);

    if (merged) {
      return merged;
    }
  }

  if (hooks.static_struct_value(expr, ctx)) {
    return { tag: "unique_heap", reason: "runtime_aggregate" };
  }

  if (hooks.host_import_result_ownership) {
    const host_import_result = hooks.host_import_result_ownership(expr, ctx);

    if (host_import_result) {
      return host_import_result;
    }
  }

  if (expr.tag === "var" && hooks.frozen_local) {
    if (hooks.frozen_local(expr.name, ctx)) {
      return { tag: "frozen_shareable", reason: "freeze" };
    }
  }

  if (hooks.runtime_aggregate_type_expr) {
    const aggregate_type = hooks.runtime_aggregate_type_expr(expr, ctx);

    if (aggregate_type) {
      if (expr.tag === "field") {
        return {
          tag: "borrow_view",
          source: { tag: "unique_heap", reason: "runtime_aggregate" },
        };
      }

      return { tag: "unique_heap", reason: "runtime_aggregate" };
    }
  }

  if (hooks.closure_fn_type(expr, ctx)) {
    return { tag: "unique_heap", reason: "closure" };
  }

  if (hooks.core_expr_is_text(expr, ctx)) {
    if (hooks.static_text_value(expr, ctx)) {
      return { tag: "frozen_shareable", reason: "text" };
    }

    return { tag: "unique_heap", reason: "text" };
  }

  const union_target = try_runtime_union_target(expr, ctx, hooks);

  if (union_target) {
    return { tag: "unique_heap", reason: "runtime_union" };
  }

  if (hooks.runtime_union_value(expr, ctx)) {
    return { tag: "unique_heap", reason: "runtime_union" };
  }

  const type = hooks.expr_type(expr, ctx);

  return { tag: "scalar_local", type };
}

function scoped_static_ownership_call_value<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): { value: CoreExpr; ctx: ctx } | undefined {
  if (
    !hooks.static_core_call_target ||
    !hooks.scoped_static_core_call_value ||
    !hooks.static_core_call_requires_scope
  ) {
    return undefined;
  }

  const target = hooks.static_core_call_target(expr.func, ctx);

  if (!target) {
    return undefined;
  }

  if (!hooks.static_core_call_requires_scope(target)) {
    return undefined;
  }

  return hooks.scoped_static_core_call_value(expr, target, ctx);
}

function try_runtime_union_target<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): RuntimeUnionTarget | undefined {
  if (!hooks.runtime_union_target) {
    return undefined;
  }

  try {
    return hooks.runtime_union_target(expr, ctx);
  } catch {
    return undefined;
  }
}

function core_if_branch_ownership<ctx>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  const then_ownership = core_expr_ownership(expr.then_branch, ctx, hooks);
  const else_ownership = core_expr_ownership(expr.else_branch, ctx, hooks);

  return merge_core_branch_ownership(then_ownership, else_ownership);
}

function core_if_branches_are_freeze_results(
  expr: Extract<CoreExpr, { tag: "if" }>,
): boolean {
  return core_expr_result_is_freeze(expr.then_branch) &&
    core_expr_result_is_freeze(expr.else_branch);
}

function core_expr_result_is_freeze(expr: CoreExpr): boolean {
  const block_value = static_block_result(expr);

  if (block_value) {
    return core_expr_result_is_freeze(block_value);
  }

  if (expr.tag === "freeze") {
    return true;
  }

  if (expr.tag === "if" && !expr.implicit_else) {
    return core_if_branches_are_freeze_results(expr);
  }

  if (expr.tag !== "block") {
    return false;
  }

  const final_stmt = expr.statements[expr.statements.length - 1];

  if (!final_stmt) {
    return false;
  }

  if (final_stmt.tag === "expr") {
    return core_expr_result_is_freeze(final_stmt.expr);
  }

  if (final_stmt.tag === "return") {
    return core_expr_result_is_freeze(final_stmt.value);
  }

  return false;
}

function merge_core_branch_ownership(
  left: CoreOwnership,
  right: CoreOwnership,
): CoreOwnership | undefined {
  switch (left.tag) {
    case "scalar_local":
      if (right.tag !== "scalar_local") {
        return undefined;
      }

      if (left.type !== right.type) {
        return undefined;
      }

      return left;

    case "unique_heap":
      if (right.tag !== "unique_heap") {
        return undefined;
      }

      if (left.reason !== right.reason) {
        return undefined;
      }

      return left;

    case "frozen_shareable":
      if (right.tag !== "frozen_shareable") {
        return undefined;
      }

      return {
        tag: "frozen_shareable",
        reason: merge_frozen_branch_reason(left.reason, right.reason),
      };

    case "borrow_view":
    case "scratch_backed":
      return undefined;
  }
}

function merge_frozen_branch_reason(
  left: CoreOwnershipPointerReason | "freeze",
  right: CoreOwnershipPointerReason | "freeze",
): CoreOwnershipPointerReason | "freeze" {
  if (left === right) {
    return left;
  }

  if (left === "text" && right === "text") {
    return "text";
  }

  return "freeze";
}

function core_if_let_branch_ownership<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  if (
    !hooks.if_let_branch_ctx ||
    !hooks.static_union_case ||
    !hooks.dynamic_union_if ||
    !hooks.bind_core_if_let_payload_fact ||
    !hooks.bind_dynamic_if_let_payload
  ) {
    return undefined;
  }

  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    return core_if_let_case_ownership(expr, union_case, ctx, hooks);
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    const cond_type = hooks.expr_type(dynamic_target.cond, ctx);

    if (cond_type !== "i32") {
      return undefined;
    }

    if (!dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      return core_expr_ownership(expr.else_branch, ctx, hooks);
    }

    const then_ownership = core_if_let_dynamic_case_ownership(
      expr,
      dynamic_target.then_case,
      dynamic_target,
      ctx,
      hooks,
    );
    const else_ownership = core_if_let_dynamic_case_ownership(
      expr,
      dynamic_target.else_case,
      dynamic_target,
      ctx,
      hooks,
    );

    return merge_core_branch_ownership(then_ownership, else_ownership);
  }

  if (
    !hooks.runtime_union_target ||
    !hooks.runtime_union_match_info ||
    !hooks.static_runtime_union_match_branch_ctx
  ) {
    return undefined;
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    return undefined;
  }

  const info = hooks.runtime_union_match_info(
    expr.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );
  const then_ownership = core_expr_ownership(
    expr.then_branch,
    branch_ctx,
    hooks,
  );
  const else_ownership = core_expr_ownership(expr.else_branch, ctx, hooks);

  return merge_core_branch_ownership(then_ownership, else_ownership);
}

function core_if_let_dynamic_case_ownership<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership {
  if (union_case.name !== expr.case_name) {
    return core_expr_ownership(expr.else_branch, ctx, hooks);
  }

  const branch_ctx = hooks.if_let_branch_ctx!(ctx);
  hooks.bind_dynamic_if_let_payload!(
    expr.case_name,
    expr.value_name,
    target,
    branch_ctx,
  );
  return core_expr_ownership(expr.then_branch, branch_ctx, hooks);
}

function core_if_let_case_ownership<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  if (union_case.name !== expr.case_name) {
    return core_expr_ownership(expr.else_branch, ctx, hooks);
  }

  const branch_ctx = hooks.if_let_branch_ctx!(ctx);
  hooks.bind_core_if_let_payload_fact!(
    expr.value_name,
    union_case,
    branch_ctx,
  );
  const then_ownership = core_expr_ownership(
    expr.then_branch,
    branch_ctx,
    hooks,
  );
  const else_ownership = core_expr_ownership(expr.else_branch, ctx, hooks);

  return merge_core_branch_ownership(then_ownership, else_ownership);
}

function core_block_result_with_ctx<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): { expr: CoreExpr; ctx: ctx } | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    return undefined;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (!stmt) {
      throw new Error("Missing ownership block statement");
    }

    const is_final = index + 1 >= expr.statements.length;

    if (!is_final) {
      hooks.collect_stmt_locals(stmt, block_ctx);
      continue;
    }

    if (stmt.tag === "expr") {
      return { expr: stmt.expr, ctx: block_ctx };
    }

    if (stmt.tag === "return") {
      return { expr: stmt.value, ctx: block_ctx };
    }

    hooks.collect_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

export function core_ownership_result_text(
  ownership: CoreOwnership,
): string {
  switch (ownership.tag) {
    case "scalar_local":
      return "scalar_local " + ownership.type;

    case "unique_heap":
      return "unique_heap " + ownership.reason;

    case "frozen_shareable":
      return "frozen_shareable " + ownership.reason;

    case "borrow_view":
      return "borrow_view over " + core_ownership_result_text(
        ownership.source,
      );

    case "scratch_backed":
      return "scratch_backed over " + core_ownership_result_text(
        ownership.source,
      );
  }
}

export function core_non_scalar_ownership_message(
  prefix: string,
  ownership: CoreOwnership,
): string {
  return prefix + " with non-scalar " +
    core_ownership_result_text(ownership) + " result yet";
}
