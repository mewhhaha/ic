import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr, CoreField, CoreFnType } from "./ast.ts";
import { find_core_field } from "./analysis/field.ts";
import {
  runtime_aggregate_layout_for_type,
  type RuntimeAggregateField,
} from "./runtime_aggregate.ts";
import { record_core_expr_provenance } from "./subject_provenance.ts";
import { static_core_call_branch_app } from "./static_call.ts";
import { static_block_result } from "./type_static.ts";
import type { StaticStructIfBranches } from "./model/static_value.ts";

export type { StaticStructIfBranches } from "./model/static_value.ts";

export type StaticStructCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type StaticStructHooks<ctx extends StaticStructCtx> = {
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
};

export function static_struct_value<ctx extends StaticStructCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: StaticStructHooks<ctx>,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return static_struct_value(inlined, ctx, hooks);
  }

  if (expr.tag === "app") {
    const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

    if (branch_static_call) {
      return static_struct_value(branch_static_call, ctx, hooks);
    }
  }

  if (expr.tag === "struct_value") {
    return expr;
  }

  if (expr.tag === "struct_update") {
    return static_struct_update_value(expr, ctx, hooks);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return static_struct_value(expr.value, ctx, hooks);
  }

  const block_value = static_block_result(expr);

  if (block_value) {
    return static_struct_value(block_value, ctx, hooks);
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value && value.tag === "struct_value") {
      return value;
    }

    if (value) {
      return static_struct_value(value, ctx, hooks);
    }
  }

  if (expr.tag === "if") {
    const branches = static_struct_if_branches(expr, ctx, hooks);

    if (!branches) {
      return undefined;
    }

    return record_core_expr_provenance(
      dynamic_struct_if_value(expr.cond, branches),
      expr,
    );
  }

  if (expr.tag === "field") {
    const object = static_struct_value(expr.object, ctx, hooks);

    if (!object) {
      return undefined;
    }

    const field = find_core_field(object.fields, expr.name);
    expect(field, "Missing static core field: " + expr.name);
    return static_struct_value(field.value, ctx, hooks);
  }

  return undefined;
}

export function static_struct_update_value<ctx extends StaticStructCtx>(
  expr: Extract<CoreExpr, { tag: "struct_update" }>,
  ctx: ctx,
  hooks: StaticStructHooks<ctx>,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const target = static_struct_value(expr.base, ctx, hooks);

  if (!target) {
    return undefined;
  }

  const fields: CoreField[] = [];

  for (const field of target.fields) {
    fields.push({
      name: field.name,
      value: field.value,
    });
  }

  for (const update of expr.fields) {
    const existing = find_core_field(fields, update.name);
    expect(existing, "Missing static core field: " + update.name);
    const existing_type = hooks.expr_type(existing.value, ctx);
    const update_type = hooks.expr_type(update.value, ctx);
    expect(
      update_type === existing_type,
      "Core struct update field " + update.name + " expects " +
        existing_type + ", got " + update_type,
    );
    existing.value = update.value;
  }

  return {
    tag: "struct_value",
    type_expr: target.type_expr,
    fields,
  };
}

export function static_struct_binding<ctx extends StaticStructCtx>(
  name: string,
  ctx: ctx,
  hooks: StaticStructHooks<ctx>,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const value = ctx.statics.get(name);

  if (value && value.tag === "freeze") {
    return undefined;
  }

  if (value && value.tag === "struct_value") {
    return value;
  }

  return static_struct_value({ tag: "var", name }, ctx, hooks);
}

export function static_struct_if_branches<ctx extends StaticStructCtx>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  ctx: ctx,
  hooks: StaticStructHooks<ctx>,
): StaticStructIfBranches | undefined {
  const then_struct = static_struct_value(expr.then_branch, ctx, hooks);

  if (!then_struct) {
    return undefined;
  }

  const else_struct = static_struct_value(expr.else_branch, ctx, hooks);

  if (!else_struct) {
    return undefined;
  }

  expect_same_static_struct_fields(then_struct, else_struct);
  return { then_struct, else_struct };
}

export function dynamic_struct_if_value(
  cond: CoreExpr,
  branches: StaticStructIfBranches,
): Extract<CoreExpr, { tag: "struct_value" }> {
  const fields: CoreField[] = [];

  for (let index = 0; index < branches.then_struct.fields.length; index += 1) {
    const then_field = branches.then_struct.fields[index];
    const else_field = branches.else_struct.fields[index];
    expect(then_field, "Missing then struct field " + index.toString());
    expect(else_field, "Missing else struct field " + index.toString());
    fields.push({
      name: then_field.name,
      value: {
        tag: "if",
        cond,
        then_branch: then_field.value,
        else_branch: else_field.value,
      },
    });
  }

  return {
    tag: "struct_value",
    type_expr: branches.then_struct.type_expr,
    fields,
  };
}

export function expect_same_static_struct_fields(
  left: Extract<CoreExpr, { tag: "struct_value" }>,
  right: Extract<CoreExpr, { tag: "struct_value" }>,
): void {
  expect(
    left.fields.length === right.fields.length,
    "Core dynamic struct if branches must have the same fields",
  );

  for (let index = 0; index < left.fields.length; index += 1) {
    const left_field = left.fields[index];
    const right_field = right.fields[index];
    expect(left_field, "Missing left struct field " + index.toString());
    expect(right_field, "Missing right struct field " + index.toString());
    expect(
      left_field.name === right_field.name,
      "Core dynamic struct if field mismatch: " + left_field.name +
        ", got " + right_field.name,
    );
  }
}

export function static_collection_fields<ctx extends StaticStructCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: StaticStructHooks<ctx>,
): CoreField[] | undefined {
  const struct_value = static_struct_value(expr, ctx, hooks);

  if (!struct_value) {
    return runtime_aggregate_collection_fields(expr, ctx, hooks);
  }

  return struct_value.fields;
}

function runtime_aggregate_collection_fields<ctx extends StaticStructCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: Pick<StaticStructHooks<ctx>, "runtime_aggregate_type_expr">,
): CoreField[] | undefined {
  const type_expr = hooks.runtime_aggregate_type_expr(expr, ctx);

  if (!type_expr) {
    return undefined;
  }

  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  const fields: CoreField[] = [];

  for (const field of layout.fields) {
    const value = runtime_aggregate_collection_field_value(expr, field);

    if (value) {
      fields.push({ name: field.name, value });
    }
  }

  return fields;
}

function runtime_aggregate_collection_field_value(
  object: CoreExpr,
  field: RuntimeAggregateField,
): CoreExpr | undefined {
  if (field.tag === "unit") {
    return undefined;
  }

  return {
    tag: "field",
    object,
    name: field.name,
  };
}
