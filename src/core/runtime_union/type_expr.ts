import { expect } from "../../expect.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { find_core_field } from "../backend/util.ts";
import { runtime_aggregate_field_info } from "../runtime_aggregate.ts";
import {
  resolve_core_type_name,
  static_block_result,
  static_type_value,
  type TypeStaticCtx,
} from "../type_static.ts";
import type { RuntimeUnionCtx, RuntimeUnionHooks } from "./types.ts";
import { core_runtime_union_value } from "./value.ts";
import { core_host_import_result_type_expr } from "../host_import.ts";

export function runtime_union_type_expr<ctx extends RuntimeUnionCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): CoreExpr | undefined {
  const union_value = core_runtime_union_value(value, ctx, hooks);

  if (union_value) {
    return runtime_union_value_type_expr(union_value, ctx);
  }

  const constructor_type = runtime_union_constructor_type_expr(value, ctx);

  if (constructor_type) {
    return constructor_type;
  }

  if (value.tag === "var") {
    const local = ctx.union_locals.get(value.name);

    if (local) {
      return local;
    }

    const static_value = ctx.statics.get(value.name);

    if (static_value) {
      return runtime_union_type_expr(static_value, ctx, hooks);
    }
  }

  if (value.tag === "app") {
    const host_type = core_host_import_result_type_expr(value, ctx);

    if (host_type) {
      return host_type;
    }

    const fn_type = hooks.closure_fn_type(value.func, ctx);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_union;
    }
  }

  if (value.tag === "field") {
    const object = hooks.static_struct_value(value.object, ctx);

    if (object) {
      const field = find_core_field(object.fields, value.name);
      expect(field, "Missing core runtime union field: " + value.name);
      return runtime_union_type_expr(field.value, ctx, hooks);
    }

    const runtime_field = runtime_aggregate_field_info(
      value.object,
      value.name,
      ctx,
      hooks,
    );

    if (runtime_field && runtime_field.tag === "value") {
      return runtime_field.union_type_expr;
    }
  }

  const collection_type = runtime_union_collection_item_type_expr(
    value,
    ctx,
    hooks,
  );

  if (collection_type) {
    return collection_type;
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return runtime_union_type_expr(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return runtime_union_type_expr(value.body, ctx, hooks);
  }

  if (value.tag === "block") {
    return runtime_union_block_result_type_expr(value, ctx, hooks);
  }

  return undefined;
}

function runtime_union_collection_item_type_expr<
  ctx extends RuntimeUnionCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): CoreExpr | undefined {
  let collection: CoreExpr | undefined;

  if (value.tag === "index") {
    collection = value.object;
  }

  if (
    value.tag === "app" &&
    value.func.tag === "var" &&
    value.func.name === "get"
  ) {
    collection = value.args[0];
  }

  if (!collection) {
    return undefined;
  }

  const fields = hooks.static_collection_fields(collection, ctx);
  if (!fields || fields.length === 0) {
    return undefined;
  }

  let result: CoreExpr | undefined;
  let saw_non_union = false;

  for (const field of fields) {
    const item = runtime_union_type_expr(field.value, ctx, hooks);

    if (!item) {
      if (result) {
        throw new Error("Core collection item union fact mismatch");
      }
      saw_non_union = true;
      continue;
    }

    if (saw_non_union) {
      throw new Error("Core collection item union fact mismatch");
    }

    if (!result) {
      result = item;
      continue;
    }

    if (!same_runtime_union_type_expr(result, item, ctx)) {
      throw new Error("Core collection item union fact mismatch");
    }
  }

  return result;
}

function runtime_union_block_result_type_expr<ctx extends RuntimeUnionCtx>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): CoreExpr | undefined {
  const block_value = static_block_result(value);

  if (block_value) {
    return runtime_union_type_expr(block_value, ctx, hooks);
  }

  const final_stmt = value.statements[value.statements.length - 1];

  if (!final_stmt) {
    return undefined;
  }

  const final_expr = runtime_union_block_final_expr(final_stmt);

  if (!final_expr) {
    return undefined;
  }

  const direct = runtime_union_type_expr(final_expr, ctx, hooks);

  if (direct) {
    return direct;
  }

  const alias = runtime_union_result_alias(final_expr);

  if (!alias) {
    return undefined;
  }

  return runtime_union_block_alias_type_expr(
    alias,
    value.statements,
    ctx,
    hooks,
  );
}

function runtime_union_block_final_expr(
  stmt: CoreStmt,
): CoreExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function runtime_union_result_alias(expr: CoreExpr): string | undefined {
  const block_value = static_block_result(expr);

  if (block_value) {
    return runtime_union_result_alias(block_value);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return runtime_union_result_alias(expr.value);
  }

  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

function runtime_union_block_alias_type_expr<ctx extends RuntimeUnionCtx>(
  alias: string,
  statements: CoreStmt[],
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): CoreExpr | undefined {
  for (let index = statements.length - 2; index >= 0; index -= 1) {
    const stmt = statements[index];
    expect(stmt, "Missing runtime union block statement");

    if (stmt.tag === "bind" && stmt.name === alias) {
      const annotation_type = runtime_union_annotation_type_expr(
        stmt.annotation,
        ctx,
      );

      if (annotation_type) {
        return annotation_type;
      }

      return runtime_union_type_expr(stmt.value, ctx, hooks);
    }

    if (stmt.tag === "assign" && stmt.name === alias) {
      return runtime_union_type_expr(stmt.value, ctx, hooks);
    }
  }

  return undefined;
}

function runtime_union_annotation_type_expr<ctx extends TypeStaticCtx>(
  annotation: string | undefined,
  ctx: ctx,
): CoreExpr | undefined {
  if (!annotation) {
    return undefined;
  }

  const type_expr: CoreExpr = { tag: "var", name: annotation };
  const type_value = static_type_value(type_expr, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  return type_expr;
}

function runtime_union_constructor_type_expr<ctx extends RuntimeUnionCtx>(
  value: CoreExpr,
  ctx: ctx,
): CoreExpr | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  if (value.func.tag !== "field") {
    return undefined;
  }

  const type_value = static_type_value(value.func.object, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  for (const field of type_value.cases) {
    if (field.name === value.func.name) {
      return value.func.object;
    }
  }

  return undefined;
}

export function same_runtime_union_type_expr<ctx extends TypeStaticCtx>(
  left: CoreExpr | undefined,
  right: CoreExpr | undefined,
  ctx?: ctx,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (ctx) {
    const left_type = static_type_value(left, ctx);
    const right_type = static_type_value(right, ctx);

    if (
      left_type && left_type.tag === "union_type" &&
      right_type && right_type.tag === "union_type"
    ) {
      return same_runtime_union_type_value(left_type, right_type, ctx);
    }
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function runtime_union_value_type_expr<ctx extends TypeStaticCtx>(
  value: CoreExpr,
  ctx: ctx,
): CoreExpr | undefined {
  if (value.tag === "if") {
    const then_type = runtime_union_value_type_expr(value.then_branch, ctx);
    const else_type = runtime_union_value_type_expr(value.else_branch, ctx);
    expect(
      same_runtime_union_type_expr(then_type, else_type, ctx),
      "Core runtime union if branch type mismatch",
    );
    return then_type;
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );
  const type_expr = value.type_expr;
  expect(type_expr, "Core runtime union case requires a union type");
  return type_expr;
}

function same_runtime_union_type_value<ctx extends TypeStaticCtx>(
  left: Extract<CoreExpr, { tag: "union_type" }>,
  right: Extract<CoreExpr, { tag: "union_type" }>,
  ctx: ctx,
): boolean {
  if (left.cases.length !== right.cases.length) {
    return false;
  }

  for (let index = 0; index < left.cases.length; index += 1) {
    const left_case = left.cases[index];
    const right_case = right.cases[index];
    expect(left_case, "Missing left core union case " + index);
    expect(right_case, "Missing right core union case " + index);

    if (left_case.name !== right_case.name) {
      return false;
    }

    const left_type = resolve_core_type_name(left_case.type_name, ctx);
    const right_type = resolve_core_type_name(right_case.type_name, ctx);

    if (left_type !== right_type) {
      return false;
    }
  }

  return true;
}
