import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, TypeField } from "./ast.ts";
import { lookup } from "./env.ts";
import type { RuntimeStructHooks } from "./runtime_struct_hooks.ts";
import { val_type_from_type_name } from "./types.ts";

export function lower_runtime_struct_projection(
  object: FrontExpr,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: RuntimeStructHooks,
): IcNode {
  const deferred = lower_deferred_runtime_struct_projection(
    object,
    field_index,
    fields,
    env,
    hooks,
  );

  if (deferred) {
    return deferred;
  }

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
    func: hooks.lower_expr(object, env),
    arg: selector,
  };
}

function lower_deferred_runtime_struct_projection(
  object: FrontExpr,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: RuntimeStructHooks,
): IcNode | undefined {
  if (object.tag === "captured") {
    return lower_deferred_runtime_struct_projection(
      object.expr,
      field_index,
      fields,
      object.env,
      hooks,
    );
  }

  if (object.tag === "var") {
    const binding = lookup(env, object.name);

    if (binding && binding.is_deferred && binding.value) {
      let value_env = env;

      if (binding.value_env) {
        value_env = binding.value_env;
      }

      return lower_deferred_runtime_struct_projection(
        binding.value,
        field_index,
        fields,
        value_env,
        hooks,
      );
    }

    return undefined;
  }

  if (object.tag !== "if") {
    return undefined;
  }

  const field = fields[field_index];
  expect(
    field,
    "Missing deferred runtime struct field " + field_index.toString(),
  );
  const select_prim = runtime_struct_field_select_prim(field);

  if (!select_prim) {
    return undefined;
  }

  const cond = Ic.reduce(hooks.lower_expr(object.cond, env));

  if (cond.tag === "num") {
    expect(
      cond.type === "i32",
      "Runtime struct projection condition must lower to i32",
    );
    const value = cond.value;
    expect(
      typeof value === "number",
      "Expected i32 runtime struct projection condition",
    );

    if (value !== 0) {
      return lower_runtime_struct_projection(
        object.then_branch,
        field_index,
        fields,
        env,
        hooks,
      );
    }

    if (object.implicit_else) {
      return runtime_struct_field_fallback_ic(field);
    }

    return lower_runtime_struct_projection(
      object.else_branch,
      field_index,
      fields,
      env,
      hooks,
    );
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      lower_runtime_struct_projection(
        object.then_branch,
        field_index,
        fields,
        env,
        hooks,
      ),
      runtime_struct_field_else_projection(
        object,
        field,
        field_index,
        fields,
        env,
        hooks,
      ),
      cond,
    ],
  };
}

function runtime_struct_field_else_projection(
  object: Extract<FrontExpr, { tag: "if" }>,
  field: TypeField,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: RuntimeStructHooks,
): IcNode {
  if (object.implicit_else) {
    return runtime_struct_field_fallback_ic(field);
  }

  return lower_runtime_struct_projection(
    object.else_branch,
    field_index,
    fields,
    env,
    hooks,
  );
}

function runtime_struct_field_fallback_ic(field: TypeField): IcNode {
  if (field.type_name === "I64") {
    return { tag: "num", type: "i64", value: 0n };
  }

  if (
    field.type_name === "Bool" || field.type_name === "Char" ||
    field.type_name === "Int" || field.type_name === "I32" ||
    field.type_name === "U32"
  ) {
    return { tag: "num", type: "i32", value: 0 };
  }

  if (field.type_name === "Text" || field.type_name === "Bytes") {
    return { tag: "text", value: "" };
  }

  throw new Error(
    "Cannot synthesize implicit fallback for struct field: " + field.name,
  );
}

function runtime_struct_field_select_prim(field: TypeField): Prim | undefined {
  if (field.type_name === "Text" || field.type_name === "Bytes") {
    return "i32.select";
  }

  const type = val_type_from_type_name(field.type_name);

  if (type === "i64") {
    return "i64.select";
  }

  if (type === "i32") {
    return "i32.select";
  }

  return undefined;
}
