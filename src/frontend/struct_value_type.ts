import { expect } from "../expect.ts";
import type { Env, Field, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { clone_env } from "./env.ts";
import { is_object_type_expr, lookup_type_field } from "./fields.ts";
import { format_expr } from "./format.ts";
import type { StructValueHooks } from "./struct_values/types.ts";
import { front_type_name, type_name_from_front_type } from "./types.ts";

export function validate_struct_value(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StructValueHooks,
): void {
  if (!expr.type_expr) {
    return;
  }

  const struct_type = resolve_struct_type_value(expr.type_expr, env, hooks);

  if (!struct_type) {
    return;
  }

  check_struct_fields(struct_type, expr.fields, env, hooks);
}

export function check_struct_fields(
  struct_type: Extract<FrontExpr, { tag: "struct_type" }>,
  fields: Field[],
  env: Env,
  hooks: StructValueHooks,
): void {
  const seen = new Set<string>();

  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error("Duplicate struct field: " + field.name);
    }

    seen.add(field.name);
    const declared = lookup_type_field(struct_type.fields, field.name);

    if (!declared) {
      throw new Error("Unknown struct field: " + field.name);
    }

    const actual = hooks.infer_expr(field.value, env);
    validate_field_type(field.name, declared.type_name, actual);
  }

  for (const field of struct_type.fields) {
    if (!seen.has(field.name)) {
      throw new Error("Missing struct field: " + field.name);
    }
  }
}

export function resolve_struct_type_value(
  expr: FrontExpr,
  env: Env,
  hooks: StructValueHooks,
): Extract<FrontExpr, { tag: "struct_type" }> | undefined {
  if (expr.tag === "var" && expr.name === "object_type") {
    return undefined;
  }

  const value = hooks.resolve_const_expr(expr, env);
  expect(value, "Missing struct type value: " + format_expr(expr));
  const type_value = hooks.resolve_extended_type_value(value, env);

  if (type_value.tag !== "struct_type") {
    throw new Error("Expected struct type value");
  }

  return type_value;
}

export function maybe_struct_type_value(
  expr: FrontExpr,
  env: Env,
  hooks: StructValueHooks,
): Extract<FrontExpr, { tag: "struct_type" }> | undefined {
  if (expr.tag === "var" && expr.name === "object_type") {
    return undefined;
  }

  const value = hooks.resolve_const_expr(expr, env);

  if (!value) {
    return undefined;
  }

  const type_value = hooks.resolve_extended_type_value(value, env);

  if (type_value.tag !== "struct_type") {
    return undefined;
  }

  return type_value;
}

export function resolve_struct_value_type_fields(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StructValueHooks,
): TypeField[] | undefined {
  if (is_object_type_expr(expr.type_expr)) {
    return infer_object_type_fields(expr, env, hooks);
  }

  const struct_type = resolve_struct_type_value(expr.type_expr, env, hooks);

  if (!struct_type) {
    return undefined;
  }

  return struct_type.fields;
}

function infer_object_type_fields(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StructValueHooks,
): TypeField[] | undefined {
  const fields: TypeField[] = [];
  const type_env = clone_env(env);

  for (const field of expr.fields) {
    const field_type = hooks.infer_expr(field.value, type_env);
    const type_name = type_name_from_front_type(field_type);

    if (!type_name) {
      return undefined;
    }

    fields.push({ name: field.name, type_name });
  }

  return fields;
}

function validate_field_type(
  name: string,
  expected: string,
  actual: FrontType,
): void {
  if (actual.tag === "unknown") {
    return;
  }

  if (expected === "Resume") {
    if (
      actual.tag !== "fn" &&
      (actual.tag !== "int" || actual.type !== "i32")
    ) {
      throw new Error(
        "Struct field " + name + " expects Resume, got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "Int" || expected === "I32" || expected === "U32") {
    if (actual.tag !== "int" || actual.type === "i64") {
      throw new Error(
        "Struct field " + name + " expects " + expected + ", got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "I64") {
    if (actual.tag !== "int" || actual.type !== "i64") {
      throw new Error(
        "Struct field " + name + " expects I64, got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "Text") {
    if (actual.tag !== "text") {
      throw new Error(
        "Struct field " + name + " expects Text, got " +
          front_type_name(actual),
      );
    }

    return;
  }
}
