import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type {
  Env,
  Field,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import {
  check_object_fields,
  is_object_type_expr,
  lookup_field,
  lookup_type_field,
} from "./fields.ts";
import { format_expr } from "./format.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { front_type_name, type_name_from_front_type } from "./types.ts";

export type StructValueTarget = {
  expr: Extract<FrontExpr, { tag: "struct_value" }>;
  env: Env;
};

export type StructValueHooks = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  inline_deferred_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_runtime_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_specialized_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  lower_expr_as_declared_type: (
    expr: FrontExpr,
    env: Env,
    type_name: string | undefined,
  ) => IcNode;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
  resolve_dynamic_if_let_struct_value: (
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    env: Env,
  ) => StructValueTarget | undefined;
  resolve_dynamic_struct_if_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => StructValueTarget | undefined;
  resolve_extended_type_value: (expr: FrontExpr, env: Env) => FrontExpr;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
};

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

export function apply_struct_update(
  expr: Extract<FrontExpr, { tag: "struct_update" }>,
  env: Env,
  hooks: StructValueHooks,
): FrontExpr {
  const struct_type = maybe_struct_type_value(expr.base, env, hooks);

  if (struct_type) {
    const value: FrontExpr = {
      tag: "struct_value",
      type_expr: expr.base,
      fields: expr.fields,
    };
    expect(value.tag === "struct_value", "Expected struct update value");
    validate_struct_value(value, env, hooks);
    return value;
  }

  const target = resolve_struct_value(expr.base, env, hooks);

  if (!target) {
    throw new Error("Cannot update non-struct value");
  }

  const fields: Field[] = [];

  for (const field of target.expr.fields) {
    fields.push({
      name: field.name,
      value: hooks.capture_expr(field.value, target.env),
    });
  }

  for (const update of expr.fields) {
    const existing = lookup_field(fields, update.name);

    if (!existing) {
      throw new Error("Missing struct field: " + update.name);
    }

    existing.value = update.value;
  }

  return {
    tag: "struct_value",
    type_expr: target.expr.type_expr,
    fields,
  };
}

export function lower_struct_value(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StructValueHooks,
): IcNode {
  const fields: { field: Field; type_name: string | undefined }[] = [];

  if (is_object_type_expr(expr.type_expr)) {
    check_object_fields(expr.fields);

    for (const field of expr.fields) {
      fields.push({ field, type_name: undefined });
    }
  } else {
    const struct_type = resolve_struct_type_value(
      expr.type_expr,
      env,
      hooks,
    );

    if (!struct_type) {
      throw new Error("Cannot lower struct value to Ic frontend yet");
    }

    check_struct_fields(struct_type, expr.fields, env, hooks);

    for (const declared of struct_type.fields) {
      const field = lookup_field(expr.fields, declared.name);
      expect(field, "Missing struct field: " + declared.name);
      fields.push({ field, type_name: declared.type_name });
    }
  }

  const handler_name = fresh(env, "pick");
  let body: IcNode = { tag: "var", name: handler_name };

  for (const field_info of fields) {
    body = {
      tag: "app",
      func: body,
      arg: hooks.lower_expr_as_declared_type(
        field_info.field.value,
        env,
        field_info.type_name,
      ),
    };
  }

  return lower_lambda_binding(handler_name, body);
}

export function resolve_struct_value(
  expr: FrontExpr,
  env: Env,
  hooks: StructValueHooks,
): StructValueTarget | undefined {
  if (expr.tag === "captured") {
    return resolve_struct_value(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "struct_value") {
    return { expr, env };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resolve_struct_value(expr.value, env, hooks);
  }

  if (expr.tag === "scratch") {
    return resolve_struct_value(expr.body, env, hooks);
  }

  if (is_non_struct_const_builtin(expr)) {
    return undefined;
  }

  const const_value = hooks.resolve_const_expr(expr, env);

  if (const_value && const_value.tag === "struct_value") {
    return { expr: const_value, env };
  }

  if (expr.tag === "struct_update") {
    const value = apply_struct_update(expr, env, hooks);
    expect(value.tag === "struct_value", "Expected struct update value");
    return { expr: value, env };
  }

  if (expr.tag === "if") {
    return hooks.resolve_dynamic_struct_if_value(expr, env);
  }

  if (expr.tag === "if_let") {
    return hooks.resolve_dynamic_if_let_struct_value(expr, env);
  }

  if (expr.tag === "app") {
    const inlined = hooks.inline_deferred_const_call(expr, env);

    if (inlined) {
      return resolve_struct_value(inlined.expr, inlined.env, hooks);
    }

    const specialized = hooks.inline_specialized_call_expr(expr, env);

    if (specialized) {
      return resolve_struct_value(specialized.expr, specialized.env, hooks);
    }

    const runtime = hooks.inline_runtime_call_expr(expr, env);

    if (runtime) {
      return resolve_struct_value(runtime.expr, runtime.env, hooks);
    }
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing block statement");

    if (stmt.tag === "expr") {
      return resolve_struct_value(stmt.expr, clone_env(env), hooks);
    }

    if (stmt.tag === "return") {
      return resolve_struct_value(stmt.value, clone_env(env), hooks);
    }
  }

  if (expr.tag === "block") {
    const block = resolve_struct_block_value(expr, env, hooks);

    if (block) {
      return block;
    }

    const value = hooks.eval_simple_front_block(expr, env);

    if (value) {
      return resolve_struct_value(value, env, hooks);
    }
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return resolve_struct_value(field.expr, field.env, hooks);
  }

  if (expr.tag === "index") {
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index === undefined) {
      return undefined;
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (!item) {
      return undefined;
    }

    return resolve_struct_value(item.expr, item.env, hooks);
  }

  if (expr.tag !== "var" && expr.tag !== "linear") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.value) {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const resolved = resolve_struct_value(binding.value, value_env, hooks);

  if (resolved) {
    return resolved;
  }

  return undefined;
}

function resolve_struct_block_value(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  hooks: StructValueHooks,
): StructValueTarget | undefined {
  if (expr.statements.length <= 1) {
    return undefined;
  }

  const local = clone_env(env);

  for (const stmt of expr.statements) {
    if (stmt.tag === "bind") {
      if (stmt.kind !== "let" || stmt.is_linear) {
        return undefined;
      }

      const value_env = clone_env(local);
      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: hooks.infer_expr(stmt.value, value_env),
        is_const: false,
        is_linear: false,
        value: stmt.value,
        value_env,
      });
      continue;
    }

    if (stmt.tag === "expr") {
      return resolve_struct_value(stmt.expr, local, hooks);
    }

    if (stmt.tag === "return") {
      return resolve_struct_value(stmt.value, local, hooks);
    }

    return undefined;
  }

  return undefined;
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

function is_non_struct_const_builtin(expr: FrontExpr): boolean {
  if (expr.tag === "captured") {
    return is_non_struct_const_builtin(expr.expr);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing block statement");

    if (stmt.tag === "expr") {
      return is_non_struct_const_builtin(stmt.expr);
    }

    if (stmt.tag === "return") {
      return is_non_struct_const_builtin(stmt.value);
    }
  }

  if (expr.tag !== "app") {
    return false;
  }

  if (expr.func.tag !== "var") {
    return false;
  }

  return expr.func.name === "len" || expr.func.name === "size_of" ||
    expr.func.name === "align_of" || expr.func.name === "is_struct" ||
    expr.func.name === "is_union" || expr.func.name === "has";
}

function validate_field_type(
  name: string,
  expected: string,
  actual: FrontType,
): void {
  if (actual.tag === "unknown") {
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
