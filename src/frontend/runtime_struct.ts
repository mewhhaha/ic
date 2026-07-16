import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { NumType, ValType } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { clone_env, lookup } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import {
  lower_runtime_struct_projection as lower_runtime_struct_projection_impl,
} from "./runtime_struct_projection.ts";
import { val_type_from_type_name } from "./types.ts";
import type { RuntimeStructHooks } from "./runtime_struct_hooks.ts";

export { lower_runtime_struct_projection } from "./runtime_struct_projection.ts";
export type { RuntimeStructHooks } from "./runtime_struct_hooks.ts";

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

  return lower_runtime_struct_projection_impl(
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
      return lower_runtime_struct_projection_impl(
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

export function indexed_result_type_from_fields(
  fields: TypeField[],
): NumType {
  if (indexed_type_fields_are_text(fields)) {
    return "i32";
  }

  if (indexed_type_fields_are_bool(fields)) {
    return "i32";
  }

  let result_type: ValType | undefined;

  for (const field of fields) {
    if (field.type_name === "Bool") {
      throw new Error("Mixed Bool and numeric indexed values");
    }

    const field_type = val_type_from_type_name(field.type_name);

    if (!field_type) {
      throw new Error(
        "Cannot lower dynamic index for non-numeric field: " + field.name,
      );
    }

    if (field_type === "v128") {
      throw new Error(
        "Dynamic indexing of F32x4 fields requires 16-byte aggregate layout",
      );
    }

    if (result_type && result_type !== field_type) {
      throw new Error("Mixed i32 and i64 indexed values");
    }

    result_type = field_type;
  }

  if (result_type === "i64" || result_type === "f32") {
    return result_type;
  }

  return "i32";
}

export function dynamic_index_type_from_fields(fields: TypeField[]): FrontType {
  if (indexed_type_fields_are_text(fields)) {
    return { tag: "text" };
  }

  if (indexed_type_fields_are_bool(fields)) {
    return { tag: "bool" };
  }

  return {
    tag: "int",
    type: indexed_result_type_from_fields(fields),
  };
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

export function indexed_type_fields_are_bool(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Bool") {
      return false;
    }
  }

  return true;
}
