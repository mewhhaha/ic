import { expect } from "../../../expect.ts";
import type { Env, Field, FrontExpr, TypeField } from "../../ast.ts";
import { capture_expr } from "../../capture.ts";
import { clone_env, fresh, push_binding } from "../../env.ts";
import {
  check_object_fields,
  is_object_type_expr,
  lookup_field,
  lookup_type_field,
} from "../../fields.ts";
import { implicit_fallback_expr } from "../../implicit_fallback.ts";
import type { DynamicBranchHooks, ResolvedStructValue } from "../types.ts";
import {
  dynamic_front_type_for_type_name,
  dynamic_struct_type_for_type_name,
  if_let_field_expr,
  same_type_fields,
} from "./helpers.ts";

export function resolve_dynamic_if_let_struct_value(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): ResolvedStructValue | undefined {
  const cases = if_let_case_fields(expr, env, hooks);

  if (!cases) {
    return undefined;
  }

  const matched = lookup_type_field(cases, expr.case_name);

  if (!matched) {
    return undefined;
  }

  const then_env = clone_env(env);

  if (expr.value_name) {
    if (matched.type_name === "Unit") {
      throw new Error("Union case has no payload: " + expr.case_name);
    }

    push_binding(then_env, {
      name: expr.value_name,
      ic_name: fresh(then_env, expr.value_name),
      type: dynamic_front_type_for_type_name(matched.type_name, env, hooks),
      is_const: false,
      is_linear: false,
      value: undefined,
      value_env: undefined,
    });
  }

  let target_expr = expr;

  if (expr.implicit_else) {
    const then_type = hooks.infer_expr(expr.then_branch, then_env);
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

  const then_branch = hooks.resolve_struct_value(
    target_expr.then_branch,
    then_env,
  );
  const else_branch = hooks.resolve_struct_value(target_expr.else_branch, env);

  if (!then_branch || !else_branch) {
    return undefined;
  }

  return merge_if_let_struct_branches(
    target_expr,
    then_branch,
    else_branch,
    env,
    hooks,
  );
}

function if_let_case_fields(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): TypeField[] | undefined {
  const target_type = hooks.infer_expr(expr.target, env);

  if (target_type.tag === "union_value") {
    return target_type.cases;
  }

  return hooks.infer_dynamic_if_let_cases(expr.target, env);
}

function merge_if_let_struct_branches(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  then_branch: ResolvedStructValue,
  else_branch: ResolvedStructValue,
  env: Env,
  hooks: DynamicBranchHooks,
): ResolvedStructValue | undefined {
  if (
    is_object_type_expr(then_branch.expr.type_expr) &&
    is_object_type_expr(else_branch.expr.type_expr)
  ) {
    return merge_if_let_object_branches(
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
    return merge_mixed_if_let_struct_branches(
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
      value: dynamic_if_let_struct_field_expr(
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

function merge_mixed_if_let_struct_branches(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
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
      value: dynamic_if_let_struct_field_expr(
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

function merge_if_let_object_branches(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
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
      value: if_let_field_expr(expr, then_field, else_field, else_branch.env),
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

function dynamic_if_let_struct_field_expr(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
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
    const nested = nested_if_let_struct_value(
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

  return if_let_field_expr(expr, then_field, else_field, else_env);
}

function nested_if_let_struct_value(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
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
      value: dynamic_if_let_struct_field_expr(
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
