import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import { assigned_stmt_names } from "./assigned_names.ts";
import {
  is_stable_static_expr,
  stable_static_struct_value,
  stable_static_text_value,
} from "./static_stability.ts";
import type { StaticValuePlan } from "./static_values.ts";
import {
  dynamic_struct_if_value,
  expect_same_static_struct_fields,
} from "./struct_static.ts";

export type StaticMergeCtx = {
  statics: Map<string, CoreExpr>;
};

export type StaticMergeHooks<
  ctx extends StaticMergeCtx,
  emit_ctx extends ctx,
> = {
  plan_static_struct_value: (
    value: Extract<CoreExpr, { tag: "struct_value" }>,
    ctx: ctx,
    emit_ctx: emit_ctx | undefined,
  ) => StaticValuePlan;
};

export function merge_if_else_static_assignments<
  ctx extends StaticMergeCtx,
  emit_ctx extends ctx,
>(
  stmt: CoreStmt,
  cond: CoreExpr,
  then_statics: Map<string, CoreExpr>,
  else_statics: Map<string, CoreExpr>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticMergeHooks<ctx, emit_ctx>,
): Wat {
  const setup: string[] = [];

  for (const name of assigned_stmt_names(stmt)) {
    const then_value = then_statics.get(name);
    const else_value = else_statics.get(name);

    if (!then_value || !else_value) {
      ctx.statics.delete(name);
      continue;
    }

    const merged = merged_if_else_static_value(
      cond,
      then_value,
      else_value,
      hooks,
    );

    if (!merged) {
      ctx.statics.delete(name);
      continue;
    }

    if (merged.tag === "struct_value") {
      const planned = hooks.plan_static_struct_value(merged, ctx, emit_ctx);
      ctx.statics.set(name, planned.value);

      if (planned.setup !== "") {
        setup.push(planned.setup);
      }

      continue;
    }

    ctx.statics.set(name, merged);
  }

  return setup.join("\n");
}

function merged_if_else_static_value<
  ctx extends StaticMergeCtx,
  emit_ctx extends ctx,
>(
  cond: CoreExpr,
  then_value: CoreExpr,
  else_value: CoreExpr,
  hooks: StaticMergeHooks<ctx, emit_ctx>,
): CoreExpr | undefined {
  const then_struct = mergeable_static_struct_value(then_value);
  const else_struct = mergeable_static_struct_value(else_value);

  if (then_struct && else_struct) {
    expect_same_static_struct_fields(then_struct, else_struct);
    return dynamic_struct_if_value(cond, {
      then_struct,
      else_struct,
    });
  }

  const then_text = stable_static_text_value(then_value);
  const else_text = stable_static_text_value(else_value);

  if (then_text && else_text) {
    return {
      tag: "if",
      cond,
      then_branch: then_text,
      else_branch: else_text,
    };
  }

  const then_union = static_union_case_value(then_value);
  const else_union = static_union_case_value(else_value);

  if (then_union && else_union) {
    if (
      then_union.type_expr &&
      else_union.type_expr &&
      same_static_core_expr(then_union.type_expr, else_union.type_expr)
    ) {
      return {
        tag: "if",
        cond,
        then_branch: then_union,
        else_branch: else_union,
      };
    }
  }

  return undefined;
}

function mergeable_static_struct_value(
  value: CoreExpr,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const stable = stable_static_struct_value(value);

  if (stable) {
    return stable;
  }

  if (value.tag !== "struct_value") {
    return undefined;
  }

  for (const field of value.fields) {
    if (!is_mergeable_static_branch_expr(field.value)) {
      return undefined;
    }
  }

  return value;
}

function is_mergeable_static_branch_expr(expr: CoreExpr): boolean {
  if (is_stable_static_expr(expr)) {
    return true;
  }

  if (expr.tag === "var") {
    return is_generated_temp_name(expr.name);
  }

  if (expr.tag === "if") {
    return is_mergeable_static_branch_expr(expr.cond) &&
      is_mergeable_static_branch_expr(expr.then_branch) &&
      is_mergeable_static_branch_expr(expr.else_branch);
  }

  return false;
}

function is_generated_temp_name(name: string): boolean {
  return name.startsWith("_") && name.includes("#");
}

function static_union_case_value(
  value: CoreExpr,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (value.tag === "union_case") {
    return value;
  }

  return undefined;
}

function same_static_core_expr(left: CoreExpr, right: CoreExpr): boolean {
  if (left.tag !== right.tag) {
    return false;
  }

  switch (left.tag) {
    case "num":
      return right.tag === "num" &&
        left.type === right.type &&
        left.value === right.value;

    case "text":
      return right.tag === "text" && left.value === right.value;

    case "type_name":
      return right.tag === "type_name" && left.name === right.name;

    case "var":
      return right.tag === "var" && left.name === right.name;

    case "linear":
      return right.tag === "linear" && left.name === right.name;

    case "prim":
      return right.tag === "prim" &&
        left.prim === right.prim &&
        same_core_expr_list(left.args, right.args);

    case "app":
      return right.tag === "app" &&
        same_static_core_expr(left.func, right.func) &&
        same_core_expr_list(left.args, right.args);

    case "field":
      return right.tag === "field" &&
        left.name === right.name &&
        same_static_core_expr(left.object, right.object);

    case "index":
      return right.tag === "index" &&
        same_static_core_expr(left.object, right.object) &&
        same_static_core_expr(left.index, right.index);

    case "borrow":
      return right.tag === "borrow" &&
        same_static_core_expr(left.value, right.value);

    case "freeze":
      return right.tag === "freeze" &&
        same_static_core_expr(left.value, right.value);

    case "scratch":
      return right.tag === "scratch" &&
        same_static_core_expr(left.body, right.body);

    case "if":
      return right.tag === "if" &&
        same_static_core_expr(left.cond, right.cond) &&
        same_static_core_expr(left.then_branch, right.then_branch) &&
        same_static_core_expr(left.else_branch, right.else_branch);

    case "struct_type":
      return right.tag === "struct_type" &&
        same_type_fields(left.fields, right.fields);

    case "union_type":
      return right.tag === "union_type" &&
        same_type_fields(left.cases, right.cases);

    case "struct_value":
      return right.tag === "struct_value" &&
        same_static_core_expr(left.type_expr, right.type_expr) &&
        same_core_fields(left.fields, right.fields);

    case "union_case":
      return right.tag === "union_case" &&
        left.name === right.name &&
        same_optional_core_expr(left.value, right.value) &&
        same_optional_core_expr(left.type_expr, right.type_expr);

    case "struct_update":
      return right.tag === "struct_update" &&
        same_static_core_expr(left.base, right.base) &&
        same_core_fields(left.fields, right.fields);

    case "block":
    case "comptime":
    case "with":
    case "lam":
    case "rec":
    case "if_let":
    case "unsupported":
      return false;
  }
}

function same_optional_core_expr(
  left: CoreExpr | undefined,
  right: CoreExpr | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return same_static_core_expr(left, right);
}

function same_core_expr_list(left: CoreExpr[], right: CoreExpr[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_item = left[index];
    const right_item = right[index];

    if (!left_item || !right_item) {
      return false;
    }

    if (!same_static_core_expr(left_item, right_item)) {
      return false;
    }
  }

  return true;
}

function same_type_fields(
  left: { name: string; type_name: string }[],
  right: { name: string; type_name: string }[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_field = left[index];
    const right_field = right[index];

    if (!left_field || !right_field) {
      return false;
    }

    if (
      left_field.name !== right_field.name ||
      left_field.type_name !== right_field.type_name
    ) {
      return false;
    }
  }

  return true;
}

function same_core_fields(
  left: { name: string; value: CoreExpr }[],
  right: { name: string; value: CoreExpr }[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_field = left[index];
    const right_field = right[index];

    if (!left_field || !right_field) {
      return false;
    }

    if (left_field.name !== right_field.name) {
      return false;
    }

    if (!same_static_core_expr(left_field.value, right_field.value)) {
      return false;
    }
  }

  return true;
}
