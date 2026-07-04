import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim, ValType } from "../op.ts";
import type {
  Binding,
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import { lookup_field, lookup_type_field } from "./fields.ts";
import { numeric_expr_type } from "./numeric.ts";
import { indexed_result_type_from_fields } from "./runtime_struct.ts";
import type { StructValueTarget } from "./struct_values.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";
import {
  front_type_from_type_name,
  front_type_name,
  val_type_from_type_name,
} from "./types.ts";

export type StructAccessHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_static_expr: (
    expr: FrontExpr,
    env: Env,
    in_progress: Set<Binding>,
  ) => IcNode | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_struct_value_type_fields: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => TypeField[] | undefined;
};

export type StaticAggregateResolveHooks = {
  eval_i32_expr: (expr: FrontExpr, env: Env, label: string) => number;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
};

export function resolve_struct_field_expr(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: StaticAggregateResolveHooks,
): ResolvedFrontExpr | undefined {
  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return undefined;
  }

  const field = lookup_field(target.expr.fields, expr.name);

  if (!field) {
    throw new Error("Missing struct field: " + expr.name);
  }

  return { expr: field.value, env: target.env };
}

export function resolve_index_expr(
  expr: Extract<FrontExpr, { tag: "index" }>,
  env: Env,
  hooks: StaticAggregateResolveHooks,
): ResolvedFrontExpr | undefined {
  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return undefined;
  }

  const index = hooks.eval_i32_expr(expr.index, env, "index access");

  if (index < 0 || index >= target.expr.fields.length) {
    throw new Error("Index out of bounds: " + index.toString());
  }

  const field = target.expr.fields[index];
  expect(field, "Missing indexed field " + index.toString());
  return { expr: field.value, env: target.env };
}

export function lower_expr_as_declared_type(
  expr: FrontExpr,
  env: Env,
  type_name: string | undefined,
  hooks: StructAccessHooks,
): IcNode {
  if (!type_name) {
    return hooks.lower_expr(expr, env);
  }

  if (expr.tag === "captured") {
    return lower_expr_as_declared_type(expr.expr, expr.env, type_name, hooks);
  }

  const value_type = val_type_from_type_name(type_name);
  const is_text = type_name === "Text";

  if (!value_type && !is_text) {
    return hooks.lower_expr(expr, env);
  }

  if (expr.tag === "if_let") {
    return lower_expr_as_front_type(
      expr,
      front_type_from_type_name(type_name),
      env,
      {
        infer_expr: hooks.infer_expr,
        lower_expr: hooks.lower_expr,
      },
    );
  }

  if (expr.tag !== "if") {
    return hooks.lower_expr(expr, env);
  }

  check_struct_access_if_condition(expr.cond, env, hooks);
  const cond = Ic.reduce(hooks.lower_expr(expr.cond, env));

  if (cond.tag === "num") {
    if (cond.type !== "i32") {
      throw new Error("If condition expects i32, got " + cond.type);
    }

    const value = cond.value;
    expect(typeof value === "number", "Expected i32 if condition");

    if (value !== 0) {
      return lower_expr_as_declared_type(
        expr.then_branch,
        env,
        type_name,
        hooks,
      );
    }

    return lower_expr_as_declared_type(
      expr.else_branch,
      env,
      type_name,
      hooks,
    );
  }

  let select_prim: Prim = "i32.select";

  if (value_type === "i64") {
    select_prim = "i64.select";
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      lower_expr_as_declared_type(expr.then_branch, env, type_name, hooks),
      lower_expr_as_declared_type(expr.else_branch, env, type_name, hooks),
      cond,
    ],
  };
}

function check_struct_access_if_condition(
  expr: FrontExpr,
  env: Env,
  hooks: StructAccessHooks,
): void {
  const type = hooks.infer_expr(expr, env);

  if (type.tag === "unknown") {
    return;
  }

  if (type.tag === "int" && type.type !== "i64") {
    return;
  }

  throw new Error("If condition expects i32, got " + front_type_name(type));
}

export function declared_struct_field_type(
  object: FrontExpr,
  name: string,
  env: Env,
  hooks: StructAccessHooks,
): string | undefined {
  const target = hooks.resolve_struct_value(object, env);

  if (!target) {
    return undefined;
  }

  const fields = hooks.resolve_struct_value_type_fields(
    target.expr,
    target.env,
  );

  if (!fields) {
    return undefined;
  }

  const field = lookup_type_field(fields, name);

  if (!field) {
    return undefined;
  }

  return field.type_name;
}

export function declared_struct_index_type(
  object: FrontExpr,
  index: number,
  env: Env,
  hooks: StructAccessHooks,
): string | undefined {
  const target = hooks.resolve_struct_value(object, env);

  if (!target) {
    return undefined;
  }

  const fields = hooks.resolve_struct_value_type_fields(
    target.expr,
    target.env,
  );

  if (!fields) {
    return undefined;
  }

  if (index < 0 || index >= fields.length) {
    return undefined;
  }

  const field = fields[index];
  expect(field, "Missing declared indexed field " + index.toString());
  return field.type_name;
}

export function indexed_result_type(
  target: StructValueTarget,
  hooks: StructAccessHooks,
): ValType {
  const field_types = hooks.resolve_struct_value_type_fields(
    target.expr,
    target.env,
  );

  if (field_types) {
    return indexed_result_type_from_fields(field_types);
  }

  if (indexed_values_are_text(target, hooks)) {
    return "i32";
  }

  let result_type: ValType | undefined;

  for (const field of target.expr.fields) {
    let field_type = numeric_expr_type(field.value);

    if (!field_type) {
      const lowered = hooks.lower_static_expr(
        field.value,
        target.env,
        new Set(),
      );

      if (lowered) {
        const reduced = Ic.reduce(lowered);

        if (reduced.tag === "num") {
          field_type = reduced.type;
        }
      }
    }

    if (!field_type) {
      throw new Error(
        "Cannot lower dynamic index for non-numeric field: " + field.name,
      );
    }

    if (result_type && result_type !== field_type) {
      throw new Error("Mixed i32 and i64 indexed values");
    }

    result_type = field_type;
  }

  if (result_type === "i64") {
    return "i64";
  }

  return "i32";
}

export function indexed_values_are_text(
  target: StructValueTarget,
  hooks: StructAccessHooks,
): boolean {
  if (target.expr.fields.length === 0) {
    return false;
  }

  for (const field of target.expr.fields) {
    const field_type = hooks.infer_expr(field.value, target.env);

    if (field_type.tag !== "text") {
      return false;
    }
  }

  return true;
}
