import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { indexed_result_type_from_fields } from "./runtime_struct.ts";

export type StaticRecStructHooks = {
  fresh: (env: Env, name: string) => string;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
};

type LowerRecResult = (expr: FrontExpr, env: Env) => IcNode;

export function lower_rec_struct_get_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecStructHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "@get") {
    return undefined;
  }

  if (expr.args.length !== 2) {
    throw new Error("get expects 2 arguments");
  }

  const collection = expr.args[0];
  const index = expr.args[1];
  expect(collection, "Missing get collection argument");
  expect(index, "Missing get index argument");
  return lower_rec_runtime_struct_index_access(
    collection,
    index,
    env,
    hooks,
    lower_result,
  );
}

export function lower_rec_runtime_struct_index_access(
  object: FrontExpr,
  index: FrontExpr,
  env: Env,
  hooks: StaticRecStructHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  const object_type = hooks.infer_expr(object, env);

  if (object_type.tag !== "struct" || !object_type.field_types) {
    return undefined;
  }

  const static_index = hooks.resolve_static_i32_expr(index, env);

  if (static_index !== undefined) {
    if (static_index < 0 || static_index >= object_type.field_types.length) {
      throw new Error("Index out of bounds: " + static_index.toString());
    }

    return lower_rec_runtime_struct_projection(
      object,
      static_index,
      object_type.field_types,
      env,
      hooks,
      lower_result,
    );
  }

  const result_type = indexed_result_type_from_fields(object_type.field_types);
  let trap_prim: Prim = "i32.trap";
  let select_prim: Prim = "i32.select";

  if (result_type === "i64") {
    trap_prim = "i64.trap";
    select_prim = "i64.select";
  }

  let result: IcNode = { tag: "prim", prim: trap_prim, args: [] };

  for (
    let field_index = object_type.field_types.length - 1;
    field_index >= 0;
    field_index -= 1
  ) {
    result = {
      tag: "prim",
      prim: select_prim,
      args: [
        lower_rec_runtime_struct_projection(
          object,
          field_index,
          object_type.field_types,
          env,
          hooks,
          lower_result,
        ),
        result,
        {
          tag: "prim",
          prim: "i32.eq",
          args: [
            lower_result(index, env),
            { tag: "num", type: "i32", value: field_index },
          ],
        },
      ],
    };
  }

  return result;
}

export function lower_rec_runtime_struct_field_access(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: StaticRecStructHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  const object_type = hooks.infer_expr(expr.object, env);

  if (object_type.tag !== "struct" || !object_type.field_types) {
    return undefined;
  }

  for (let index = 0; index < object_type.field_types.length; index += 1) {
    const field = object_type.field_types[index];
    expect(field, "Missing runtime struct field " + index.toString());

    if (field.name === expr.name) {
      return lower_rec_runtime_struct_projection(
        expr.object,
        index,
        object_type.field_types,
        env,
        hooks,
        lower_result,
      );
    }
  }

  throw new Error("Missing struct field: " + expr.name);
}

export function lower_rec_runtime_struct_projection(
  object: FrontExpr,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: StaticRecStructHooks,
  lower_result: LowerRecResult,
): IcNode {
  return lower_rec_runtime_struct_projection_from_value(
    lower_result(object, env),
    field_index,
    fields,
    env,
    hooks,
  );
}

export function lower_rec_runtime_struct_projection_from_value(
  object: IcNode,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: StaticRecStructHooks,
): IcNode {
  const names: string[] = [];

  for (const field of fields) {
    names.push(hooks.fresh(env, "field_" + field.name));
  }

  const selected_name = names[field_index];
  expect(selected_name, "Missing selected runtime struct field");
  let selector: IcNode = { tag: "var", name: selected_name };

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    expect(name, "Missing runtime struct selector field " + index.toString());
    selector = { tag: "lam", name, body: selector };
  }

  return {
    tag: "app",
    func: object,
    arg: selector,
  };
}
