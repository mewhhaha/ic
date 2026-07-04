import { expect } from "../../../expect.ts";
import type { Env, Field, FrontExpr, TypeField } from "../../ast.ts";
import { capture_expr } from "../../capture.ts";
import {
  check_object_fields,
  is_object_type_expr,
  lookup_field,
} from "../../fields.ts";
import { implicit_fallback_expr } from "../../implicit_fallback.ts";
import type { DynamicBranchHooks, ResolvedStructValue } from "../types.ts";
import {
  dynamic_struct_type_for_type_name,
  same_type_fields,
} from "./helpers.ts";

export function lower_dynamic_struct_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
) {
  const value = resolve_dynamic_struct_if_value(expr, env, hooks);

  if (!value) {
    return undefined;
  }

  return hooks.lower_struct_value(value.expr, value.env);
}

export function resolve_dynamic_struct_if_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): ResolvedStructValue | undefined {
  let target_expr = expr;

  if (expr.implicit_else) {
    const then_type = hooks.infer_expr(expr.then_branch, env);
    const fallback = implicit_fallback_expr(then_type, env, hooks);

    if (!fallback) {
      return undefined;
    }

    target_expr = {
      ...expr,
      else_branch: fallback,
      implicit_else: undefined,
    };
  }

  const then_branch = hooks.resolve_struct_value(target_expr.then_branch, env);
  const else_branch = hooks.resolve_struct_value(target_expr.else_branch, env);

  if (!then_branch || !else_branch) {
    return undefined;
  }

  if (
    is_object_type_expr(then_branch.expr.type_expr) &&
    is_object_type_expr(else_branch.expr.type_expr)
  ) {
    return resolve_dynamic_object_if_value(
      expr,
      then_branch,
      else_branch,
      env,
    );
  }

  if (
    is_object_type_expr(then_branch.expr.type_expr) ||
    is_object_type_expr(else_branch.expr.type_expr)
  ) {
    return resolve_dynamic_mixed_struct_if_value(
      expr,
      then_branch,
      else_branch,
      env,
      hooks,
    );
  }

  const then_type = hooks.resolve_struct_type_value(
    then_branch.expr.type_expr,
    then_branch.env,
  );
  const else_type = hooks.resolve_struct_type_value(
    else_branch.expr.type_expr,
    else_branch.env,
  );

  if (!then_type || !else_type || !same_type_fields(then_type, else_type)) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const field_type of then_type.fields) {
    const then_field = lookup_field(then_branch.expr.fields, field_type.name);
    const else_field = lookup_field(else_branch.expr.fields, field_type.name);
    expect(then_field, "Missing then struct field: " + field_type.name);
    expect(else_field, "Missing else struct field: " + field_type.name);
    fields.push({
      name: field_type.name,
      value: dynamic_struct_if_field_expr(
        expr,
        field_type,
        then_field,
        then_branch.env,
        else_field,
        else_branch.env,
        env,
        hooks,
      ),
    });
  }

  return {
    expr: {
      tag: "struct_value",
      type_expr: capture_expr(then_branch.expr.type_expr, then_branch.env),
      fields,
    },
    env,
  };
}

function resolve_dynamic_mixed_struct_if_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  then_branch: ResolvedStructValue,
  else_branch: ResolvedStructValue,
  env: Env,
  hooks: DynamicBranchHooks,
): ResolvedStructValue | undefined {
  let object_branch = then_branch;
  let typed_branch = else_branch;
  let object_is_then = true;

  if (!is_object_type_expr(then_branch.expr.type_expr)) {
    object_branch = else_branch;
    typed_branch = then_branch;
    object_is_then = false;
  }

  check_object_fields(object_branch.expr.fields);

  const typed_type = hooks.resolve_struct_type_value(
    typed_branch.expr.type_expr,
    typed_branch.env,
  );

  if (!typed_type) {
    return undefined;
  }

  if (object_branch.expr.fields.length !== typed_type.fields.length) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const field_type of typed_type.fields) {
    const object_field = lookup_field(
      object_branch.expr.fields,
      field_type.name,
    );
    const typed_field = lookup_field(typed_branch.expr.fields, field_type.name);

    if (!object_field || !typed_field) {
      return undefined;
    }

    let then_field = object_field;
    let then_env = object_branch.env;
    let else_field = typed_field;
    let else_env = typed_branch.env;

    if (!object_is_then) {
      then_field = typed_field;
      then_env = typed_branch.env;
      else_field = object_field;
      else_env = object_branch.env;
    }

    fields.push({
      name: field_type.name,
      value: dynamic_struct_if_field_expr(
        expr,
        field_type,
        then_field,
        then_env,
        else_field,
        else_env,
        env,
        hooks,
      ),
    });
  }

  return {
    expr: {
      tag: "struct_value",
      type_expr: capture_expr(typed_branch.expr.type_expr, typed_branch.env),
      fields,
    },
    env,
  };
}

function resolve_dynamic_object_if_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  then_branch: ResolvedStructValue,
  else_branch: ResolvedStructValue,
  env: Env,
): ResolvedStructValue | undefined {
  check_object_fields(then_branch.expr.fields);
  check_object_fields(else_branch.expr.fields);

  if (then_branch.expr.fields.length !== else_branch.expr.fields.length) {
    return undefined;
  }

  const fields: Field[] = [];

  for (let index = 0; index < then_branch.expr.fields.length; index += 1) {
    const then_field = then_branch.expr.fields[index];
    const else_field = else_branch.expr.fields[index];
    expect(then_field, "Missing then object field " + index.toString());
    expect(else_field, "Missing else object field " + index.toString());

    if (then_field.name !== else_field.name) {
      return undefined;
    }

    fields.push({
      name: then_field.name,
      value: {
        tag: "if",
        cond: expr.cond,
        then_branch: capture_expr(then_field.value, then_branch.env),
        else_branch: capture_expr(else_field.value, else_branch.env),
      },
    });
  }

  return {
    expr: {
      tag: "struct_value",
      type_expr: { tag: "var", name: "object_type" },
      fields,
    },
    env,
  };
}

function dynamic_struct_if_field_expr(
  expr: Extract<FrontExpr, { tag: "if" }>,
  field_type: TypeField,
  then_field: Field,
  then_env: Env,
  else_field: Field,
  else_env: Env,
  env: Env,
  hooks: DynamicBranchHooks,
): FrontExpr {
  const nested_type = dynamic_struct_type_for_type_name(
    field_type.type_name,
    env,
    hooks,
  );

  if (nested_type) {
    const nested = nested_struct_if_value(
      expr,
      field_type.type_name,
      nested_type,
      then_field.value,
      then_env,
      else_field.value,
      else_env,
      env,
      hooks,
    );

    if (nested) {
      return nested;
    }
  }

  return {
    tag: "if",
    cond: expr.cond,
    then_branch: capture_expr(then_field.value, then_env),
    else_branch: capture_expr(else_field.value, else_env),
  };
}

function nested_struct_if_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  type_name: string,
  type_fields: TypeField[],
  then_value: FrontExpr,
  then_env: Env,
  else_value: FrontExpr,
  else_env: Env,
  env: Env,
  hooks: DynamicBranchHooks,
): FrontExpr | undefined {
  const then_struct = hooks.resolve_struct_value(then_value, then_env);
  const else_struct = hooks.resolve_struct_value(else_value, else_env);

  if (!then_struct || !else_struct) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const nested_field_type of type_fields) {
    const then_field = lookup_field(
      then_struct.expr.fields,
      nested_field_type.name,
    );
    const else_field = lookup_field(
      else_struct.expr.fields,
      nested_field_type.name,
    );
    expect(then_field, "Missing then struct field: " + nested_field_type.name);
    expect(else_field, "Missing else struct field: " + nested_field_type.name);
    fields.push({
      name: nested_field_type.name,
      value: dynamic_struct_if_field_expr(
        expr,
        nested_field_type,
        then_field,
        then_struct.env,
        else_field,
        else_struct.env,
        env,
        hooks,
      ),
    });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: type_name },
    fields,
  };
}
