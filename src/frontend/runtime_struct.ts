import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim, ValType } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { clone_env, lookup } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import { val_type_from_type_name } from "./types.ts";

export type RuntimeStructHooks = {
  fresh: (env: Env, name: string) => string;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
};

export type RuntimeStructTypeHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_app_result_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_struct_value_type_fields: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => TypeField[] | undefined;
};

export function resolve_runtime_struct_type(
  expr: FrontExpr,
  env: Env,
  hooks: RuntimeStructTypeHooks,
): { fields: TypeField[] } | undefined {
  const unwrapped = unwrap_ownership_wrapper_expr(expr);

  if (unwrapped !== expr) {
    return resolve_runtime_struct_type(unwrapped, env, hooks);
  }

  if (expr.tag === "captured") {
    return resolve_runtime_struct_type(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing runtime struct block statement");

    if (stmt.tag === "expr") {
      return resolve_runtime_struct_type(stmt.expr, clone_env(env), hooks);
    }

    if (stmt.tag === "return") {
      return resolve_runtime_struct_type(stmt.value, clone_env(env), hooks);
    }
  }

  if (expr.tag === "struct_value") {
    const fields = hooks.resolve_struct_value_type_fields(expr, env);

    if (!fields) {
      return undefined;
    }

    return { fields };
  }

  if (expr.tag === "field") {
    const target = resolve_runtime_struct_type(expr.object, env, hooks);

    if (!target) {
      return undefined;
    }

    const field = lookup_type_field(target.fields, expr.name);

    if (!field) {
      throw new Error("Missing struct field: " + expr.name);
    }

    return runtime_struct_type_from_type_name(field.type_name, env, hooks);
  }

  if (expr.tag === "app") {
    const result_type = hooks.resolve_app_result_type(expr, env);

    if (result_type && result_type.tag === "struct") {
      if (result_type.field_types) {
        return { fields: result_type.field_types };
      }
    }
  }

  if (
    expr.tag === "if" || expr.tag === "if_let" || expr.tag === "app" ||
    expr.tag === "block"
  ) {
    const inferred = hooks.infer_expr(expr, env);

    if (inferred.tag === "struct" && inferred.field_types) {
      return { fields: inferred.field_types };
    }
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding) {
    return undefined;
  }

  if (binding.type.tag === "struct" && binding.type.field_types) {
    return { fields: binding.type.field_types };
  }

  if (binding.value && binding.value.tag === "struct_value") {
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    const fields = hooks.resolve_struct_value_type_fields(
      binding.value,
      value_env,
    );

    if (fields) {
      return { fields };
    }
  }

  return undefined;
}

function runtime_struct_type_from_type_name(
  type_name: string,
  env: Env,
  hooks: RuntimeStructTypeHooks,
): { fields: TypeField[] } | undefined {
  const type = hooks.resolve_annotation_type(type_name, env);

  if (!type || type.tag !== "struct" || !type.field_types) {
    return undefined;
  }

  return { fields: type.field_types };
}

export function lower_runtime_struct_index_access(
  object: FrontExpr,
  index: number,
  env: Env,
  hooks: RuntimeStructHooks,
): IcNode | undefined {
  const runtime_target = hooks.resolve_runtime_struct_type(object, env);

  if (!runtime_target) {
    return undefined;
  }

  if (index < 0 || index >= runtime_target.fields.length) {
    throw new Error("Index out of bounds: " + index.toString());
  }

  return lower_runtime_struct_projection(
    object,
    index,
    runtime_target.fields,
    env,
    hooks,
  );
}

export function lower_runtime_struct_field_access(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: RuntimeStructHooks,
): IcNode | undefined {
  const runtime_target = hooks.resolve_runtime_struct_type(expr.object, env);

  if (!runtime_target) {
    return undefined;
  }

  for (let index = 0; index < runtime_target.fields.length; index += 1) {
    const field = runtime_target.fields[index];
    expect(field, "Missing runtime struct field " + index.toString());

    if (field.name === expr.name) {
      return lower_runtime_struct_projection(
        expr.object,
        index,
        runtime_target.fields,
        env,
        hooks,
      );
    }
  }

  throw new Error("Missing struct field: " + expr.name);
}

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
    field.type_name === "Int" || field.type_name === "I32" ||
    field.type_name === "U32"
  ) {
    return { tag: "num", type: "i32", value: 0 };
  }

  if (field.type_name === "Text") {
    return { tag: "text", value: "" };
  }

  throw new Error(
    "Cannot synthesize implicit fallback for struct field: " + field.name,
  );
}

function runtime_struct_field_select_prim(field: TypeField): Prim | undefined {
  if (field.type_name === "Text") {
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

export function indexed_result_type_from_fields(
  fields: TypeField[],
): ValType {
  if (indexed_type_fields_are_text(fields)) {
    return "i32";
  }

  let result_type: ValType | undefined;

  for (const field of fields) {
    const field_type = val_type_from_type_name(field.type_name);

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

export function indexed_type_fields_are_text(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Text") {
      return false;
    }
  }

  return true;
}
