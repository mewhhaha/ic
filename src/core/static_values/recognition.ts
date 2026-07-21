import type { CoreExpr } from "../ast.ts";
import { static_block_result } from "../type_static.ts";
import { is_scratch_free_static_value_expr } from "./scratch_free.ts";
import type { StaticValueRecognitionHooks } from "./types.ts";

type StaticValueAliasCtx = {
  statics: Map<string, CoreExpr>;
  scratch_depth?: number;
};

export function is_static_value_expr<ctx extends StaticValueAliasCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: StaticValueRecognitionHooks<ctx>,
): boolean {
  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return is_static_value_expr(inlined, ctx, hooks);
  }

  if (hooks.static_text_value(value, ctx)) {
    return true;
  }

  const block_result = static_value_block_result_with_ctx(value, ctx, hooks);

  if (block_result) {
    return is_static_value_expr(block_result.expr, block_result.ctx, hooks);
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    if (union_case.resume_payload) {
      return false;
    }

    return true;
  }

  if (hooks.dynamic_union_if(value, ctx)) {
    return true;
  }

  if (hooks.static_struct_value(value, ctx)) {
    return true;
  }

  if (value.tag === "var") {
    const static_value = ctx.statics.get(value.name);

    if (static_value) {
      return is_static_value_expr(static_value, ctx, hooks);
    }
  }

  if (value.tag === "text") {
    return true;
  }

  if (value.tag === "struct_value") {
    return true;
  }

  if (value.tag === "union_case") {
    return true;
  }

  if (value.tag === "if") {
    return is_static_value_expr(value.then_branch, ctx, hooks) &&
      is_static_value_expr(value.else_branch, ctx, hooks);
  }

  if (value.tag === "struct_update") {
    return false;
  }

  if (value.tag === "scratch") {
    const scratch_result = static_value_block_result_with_ctx(
      value.body,
      ctx,
      hooks,
      true,
    );

    if (scratch_result) {
      return is_static_value_expr(
        scratch_result.expr,
        scratch_result.ctx,
        hooks,
      ) &&
        is_scratch_free_static_value_expr(
          scratch_result.expr,
          scratch_result.ctx,
          hooks,
        );
    }

    return is_static_value_expr(value.body, ctx, hooks) &&
      is_scratch_free_static_value_expr(value.body, ctx, hooks);
  }

  const block_value = static_block_result(value);

  if (block_value) {
    return is_static_value_expr(block_value, ctx, hooks);
  }

  return false;
}

export function static_scratch_aggregate_alias_materializes(
  value: CoreExpr,
): boolean {
  if (value.tag !== "scratch" || value.body.tag !== "block") {
    return false;
  }
  const final_stmt = value.body.statements[value.body.statements.length - 1];
  if (!final_stmt) {
    throw new Error("Missing static scratch aggregate final statement");
  }
  let final_value: CoreExpr | undefined;
  if (final_stmt.tag === "expr") {
    final_value = final_stmt.expr;
  } else if (final_stmt.tag === "return") {
    final_value = final_stmt.value;
  }
  if (
    !final_value ||
    (final_value.tag !== "var" && final_value.tag !== "linear")
  ) {
    return false;
  }
  const result = static_scratch_block_result_value(value);
  return result !== undefined && result.tag === "struct_value";
}

export function static_scratch_block_result_value(
  value: CoreExpr,
): CoreExpr | undefined {
  if (value.tag !== "scratch" || value.body.tag !== "block") {
    return undefined;
  }
  if (value.body.statements.length <= 1) {
    return undefined;
  }
  const final_stmt = value.body.statements[value.body.statements.length - 1];
  if (!final_stmt) {
    throw new Error("Missing static scratch aggregate final statement");
  }
  let result: CoreExpr | undefined;
  if (final_stmt.tag === "expr") {
    result = final_stmt.expr;
  } else if (final_stmt.tag === "return") {
    result = final_stmt.value;
  }
  if (!result) {
    return undefined;
  }
  if (result.tag !== "var" && result.tag !== "linear") {
    return result;
  }

  let name = result.name;
  const visiting = new Set<string>();
  while (!visiting.has(name)) {
    visiting.add(name);
    let source: CoreExpr | undefined;
    for (
      let index = value.body.statements.length - 2;
      index >= 0;
      index -= 1
    ) {
      const stmt = value.body.statements[index];
      if (!stmt) {
        throw new Error("Missing static scratch aggregate statement");
      }
      if (
        (stmt.tag === "bind" || stmt.tag === "assign") &&
        stmt.name === name
      ) {
        source = stmt.value;
        break;
      }
    }
    if (!source) {
      return undefined;
    }
    if (source.tag !== "var" && source.tag !== "linear") {
      return source;
    }
    name = source.name;
  }
  return undefined;
}

function static_value_block_result_with_ctx<ctx extends StaticValueAliasCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: StaticValueRecognitionHooks<ctx>,
  scratch = false,
): { expr: CoreExpr; ctx: ctx } | undefined {
  if (value.tag !== "block") {
    return undefined;
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    return undefined;
  }

  const block_ctx = hooks.block_ctx(ctx);
  if (scratch) {
    const scratch_depth = block_ctx.scratch_depth;
    if (scratch_depth === undefined) {
      block_ctx.scratch_depth = 1;
    } else {
      block_ctx.scratch_depth = scratch_depth + 1;
    }
  }

  for (let index = 0; index < value.statements.length; index += 1) {
    const stmt = value.statements[index];

    if (!stmt) {
      throw new Error("Missing static value block statement");
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
