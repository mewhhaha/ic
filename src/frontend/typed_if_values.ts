import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { fresh } from "./env.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { front_type_name } from "./types.ts";
import { typed_if_else_branch } from "./typed_if_fallback.ts";
import type {
  FrontTypedLowerHooks,
  LowerExprAsFrontType,
} from "./typed_hooks.ts";
import { type_for_type_name } from "./typed_type.ts";

export function lower_struct_if_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const field_values: IcNode[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing dynamic typed struct field " + index.toString());
    field_values.push(
      lower_struct_if_field_as_front_type(
        expr,
        index,
        fields,
        cond,
        env,
        hooks,
        lower_as,
      ),
    );
  }

  return lower_struct_fields_as_ic(field_values, env);
}

export function lower_union_if_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  cases: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const type: FrontType = { tag: "union_value", cases };

  return lower_union_if_values_as_front_type(
    lower_as(expr.then_branch, type, env, hooks),
    lower_as(
      typed_if_else_branch(expr, type, env, hooks),
      type,
      env,
      hooks,
    ),
    cases,
    cond,
    env,
  );
}

function lower_struct_if_field_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  field_index: number,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const field = fields[field_index];
  expect(
    field,
    "Missing dynamic typed struct field " + field_index.toString(),
  );
  return lower_selected_ic_as_type(
    type_for_type_name(field.type_name, env, hooks),
    lower_struct_branch_field(
      expr.then_branch,
      field_index,
      fields,
      env,
      hooks,
      lower_as,
    ),
    lower_struct_branch_field(
      typed_if_else_branch(expr, front_struct_type(fields), env, hooks),
      field_index,
      fields,
      env,
      hooks,
      lower_as,
    ),
    cond,
    env,
    hooks,
    lower_as,
  );
}

function front_struct_type(fields: TypeField[]): FrontType {
  const names: string[] = [];

  for (const field of fields) {
    names.push(field.name);
  }

  return { tag: "struct", fields: names, field_types: fields };
}

function lower_struct_branch_field(
  branch: FrontExpr,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  return lower_struct_value_field(
    lower_as(branch, front_struct_type(fields), env, hooks),
    field_index,
    fields,
    env,
  );
}

function lower_selected_ic_as_type(
  type: FrontType,
  then_value: IcNode,
  else_value: IcNode,
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const select_prim = select_prim_for_front_type(type);

  if (select_prim) {
    return {
      tag: "prim",
      prim: select_prim,
      args: [then_value, else_value, cond],
    };
  }

  if (type.tag === "struct" && type.field_types) {
    return lower_struct_if_values_as_front_type(
      then_value,
      else_value,
      type.field_types,
      cond,
      env,
      hooks,
      lower_as,
    );
  }

  if (type.tag === "union_value") {
    return lower_union_if_values_as_front_type(
      then_value,
      else_value,
      type.cases,
      cond,
      env,
    );
  }

  throw new Error(
    "Cannot lower dynamic if with " + front_type_name(type) +
      " branches to Ic frontend",
  );
}

function lower_struct_if_values_as_front_type(
  then_value: IcNode,
  else_value: IcNode,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const field_values: IcNode[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing nested dynamic typed struct field " + index);
    field_values.push(
      lower_selected_ic_as_type(
        type_for_type_name(field.type_name, env, hooks),
        lower_struct_value_field(then_value, index, fields, env),
        lower_struct_value_field(else_value, index, fields, env),
        cond,
        env,
        hooks,
        lower_as,
      ),
    );
  }

  return lower_struct_fields_as_ic(field_values, env);
}

function lower_struct_fields_as_ic(
  field_values: IcNode[],
  env: Env,
): IcNode {
  const handler_name = fresh(env, "pick");
  let body: IcNode = { tag: "var", name: handler_name };

  for (const value of field_values) {
    body = {
      tag: "app",
      func: body,
      arg: value,
    };
  }

  return lower_lambda_binding(handler_name, body);
}

function lower_struct_value_field(
  value: IcNode,
  field_index: number,
  fields: TypeField[],
  env: Env,
): IcNode {
  const names: string[] = [];

  for (const field of fields) {
    names.push(fresh(env, "field_" + field.name));
  }

  const selected_name = names[field_index];
  expect(selected_name, "Missing selected typed struct field");
  let selector: IcNode = { tag: "var", name: selected_name };

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    expect(name, "Missing typed struct selector field " + index.toString());
    selector = { tag: "lam", name, body: selector };
  }

  return {
    tag: "app",
    func: value,
    arg: selector,
  };
}

function lower_union_if_values_as_front_type(
  then_value: IcNode,
  else_value: IcNode,
  cases: TypeField[],
  cond: IcNode,
  env: Env,
): IcNode {
  const handler_names: string[] = [];

  for (const union_case of cases) {
    handler_names.push(fresh(env, "case_" + union_case.name));
  }

  let body: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [
      apply_union_handlers(then_value, handler_names),
      apply_union_handlers(else_value, handler_names),
      cond,
    ],
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing typed union handler " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function apply_union_handlers(
  value: IcNode,
  handler_names: string[],
): IcNode {
  let result = value;

  for (const handler_name of handler_names) {
    result = {
      tag: "app",
      func: result,
      arg: { tag: "var", name: handler_name },
    };
  }

  return result;
}

function select_prim_for_front_type(type: FrontType): Prim | undefined {
  if (type.tag === "bool" || type.tag === "text") {
    return "i32.select";
  }

  if (type.tag === "int") {
    if (type.type === "i64") {
      return "i64.select";
    }

    return "i32.select";
  }

  return undefined;
}
