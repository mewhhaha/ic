import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import { static_block_result } from "../type_static.ts";

export type ScratchFreeStaticValueHooks<ctx> = {
  block_ctx?: (ctx: ctx) => ctx;
  closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
  collect_stmt_locals?: (stmt: CoreStmt, ctx: ctx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  frozen_local?: (name: string, ctx: ctx) => boolean;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export function is_scratch_free_static_value_expr<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: ScratchFreeStaticValueHooks<ctx>,
): boolean {
  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return is_scratch_free_static_value_expr(inlined, ctx, hooks);
  }

  if (hooks.static_text_value(value, ctx)) {
    return true;
  }

  if (value.tag === "var" && hooks.frozen_local) {
    if (hooks.frozen_local(value.name, ctx)) {
      return true;
    }
  }

  const block_result = scratch_free_block_result_with_ctx(value, ctx, hooks);

  if (block_result) {
    return is_scratch_free_static_value_expr(
      block_result.expr,
      block_result.ctx,
      hooks,
    );
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    if (!union_case.value) {
      return true;
    }

    return is_scratch_free_static_value_expr(union_case.value, ctx, hooks);
  }

  if (value.tag === "if") {
    const union_if = hooks.dynamic_union_if(value, ctx);

    if (union_if) {
      return is_scratch_free_static_value_expr(
        union_if.cond,
        ctx,
        hooks,
      ) &&
        is_scratch_free_static_value_expr(union_if.then_case, ctx, hooks) &&
        is_scratch_free_static_value_expr(union_if.else_case, ctx, hooks);
    }
  }

  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    for (const field of struct_value.fields) {
      if (!is_scratch_free_static_value_expr(field.value, ctx, hooks)) {
        return false;
      }
    }

    return true;
  }

  const block_value = static_block_result(value);

  if (block_value) {
    return is_scratch_free_static_value_expr(block_value, ctx, hooks);
  }

  switch (value.tag) {
    case "num":
    case "text":
      return true;

    case "var":
    case "app":
    case "prim":
    case "if":
    case "field":
    case "index":
      return is_scratch_free_scalar_expr(value, ctx, hooks);

    case "borrow":
      return is_scratch_free_static_value_expr(value.value, ctx, hooks);

    case "freeze":
      return is_scratch_free_static_value_expr(value.value, ctx, hooks);

    case "scratch":
      return is_scratch_free_static_value_expr(value.body, ctx, hooks);

    case "linear":
    case "lam":
    case "rec":
    case "block":
    case "comptime":
    case "with":
    case "type_name":
    case "struct_type":
    case "struct_value":
    case "struct_update":
    case "union_type":
    case "if_let":
    case "union_case":
    case "unsupported":
      return false;
  }
}

function scratch_free_block_result_with_ctx<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: ScratchFreeStaticValueHooks<ctx>,
): { expr: CoreExpr; ctx: ctx } | undefined {
  if (value.tag !== "block") {
    return undefined;
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    return undefined;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < value.statements.length; index += 1) {
    const stmt = value.statements[index];

    if (!stmt) {
      throw new Error("Missing scratch-free block statement");
    }

    const is_final = index + 1 >= value.statements.length;

    if (is_final) {
      if (stmt.tag === "expr") {
        return { expr: stmt.expr, ctx: block_ctx };
      }

      if (stmt.tag === "return") {
        return { expr: stmt.value, ctx: block_ctx };
      }
    }

    hooks.collect_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

function is_scratch_free_scalar_expr<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: ScratchFreeStaticValueHooks<ctx>,
): boolean {
  if (hooks.core_expr_is_text(value, ctx)) {
    return false;
  }

  if (hooks.closure_fn_type(value, ctx)) {
    return false;
  }

  if (hooks.runtime_aggregate_type_expr(value, ctx)) {
    return false;
  }

  if (hooks.runtime_union_type_expr(value, ctx)) {
    return false;
  }

  hooks.expr_type(value, ctx);
  return true;
}
