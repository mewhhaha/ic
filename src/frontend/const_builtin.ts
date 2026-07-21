import { expect } from "../expect.ts";
import type { Binding, Env, FrontExpr, ResolvedFrontExpr } from "./ast.ts";
import { lookup_field, lookup_type_field, type_fields_expr } from "./fields.ts";
import { layout_expr, layout_type } from "./layout.ts";
import { i32_expr } from "./numeric.ts";
import { is_builtin_type_name } from "./types.ts";
import {
  describe_comptime_cases,
  describe_comptime_fields,
  describe_comptime_type,
} from "./comptime_descriptor.ts";
import { resolve_comptime_type } from "./comptime_value.ts";
import { text_byte_length } from "./text.ts";

export type ConstBuiltinHooks = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  lookup: (env: Env, name: string) => Binding | undefined;
  lookup_const_field: (
    value: FrontExpr,
    name: string,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
  resolve_const_expr_with_env: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_extended_type_value: (expr: FrontExpr, env: Env) => FrontExpr;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) => {
    expr: Extract<FrontExpr, { tag: "struct_value" }>;
    env: Env;
  } | undefined;
};

export function eval_const_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: ConstBuiltinHooks,
): FrontExpr | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  if (
    expr.func.name !== "@size_of" &&
    expr.func.name !== "@align_of" &&
    expr.func.name !== "@layout" &&
    expr.func.name !== "@is_struct" &&
    expr.func.name !== "@is_union" &&
    expr.func.name !== "@has" &&
    expr.func.name !== "@fields_of" &&
    expr.func.name !== "@cases_of" &&
    expr.func.name !== "@describe_type" &&
    expr.func.name !== "@describe_fields" &&
    expr.func.name !== "@describe_cases" &&
    expr.func.name !== "@len" &&
    expr.func.name !== "@get" &&
    expr.func.name !== "@include"
  ) {
    return undefined;
  }

  if (expr.func.name === "@include") {
    throw new Error(
      "include requires source file context; use a file-loading compiler API",
    );
  }

  if (expr.func.name === "@len") {
    expect(expr.args.length === 1, "len expects 1 argument");
    const collection = expr.args[0];
    expect(collection, "Missing len argument");
    const array = hooks.resolve_const_expr_with_env(collection, env);

    if (array !== undefined && array.expr.tag === "text") {
      return i32_expr(text_byte_length(array.expr.value));
    }

    if (
      array !== undefined && array.expr.tag === "array" &&
      array.expr.rest === undefined
    ) {
      return i32_expr(array.expr.items.length);
    }

    if (array !== undefined && array.expr.tag === "product") {
      return i32_expr(array.expr.entries.length);
    }

    const target = hooks.resolve_struct_value(collection, env);
    expect(target, "len requires a compile-time collection value");
    return i32_expr(target.expr.fields.length);
  }

  if (expr.func.name === "@get") {
    expect(expr.args.length === 2, "get expects 2 arguments");
    const collection = expr.args[0];
    const index = expr.args[1];
    expect(collection, "Missing get collection argument");
    expect(index, "Missing get index argument");
    const item = hooks.resolve_index_expr(
      { tag: "index", object: collection, index },
      env,
    );
    expect(item, "get requires a compile-time collection value");
    return hooks.capture_expr(item.expr, item.env);
  }

  expect(
    expr.args.length === 1,
    expr.func.name + " expects 1 argument",
  );
  const arg = expr.args[0];
  expect(arg, "Missing " + expr.func.name + " argument");

  if (
    expr.func.name === "@describe_type" ||
    expr.func.name === "@describe_fields" ||
    expr.func.name === "@describe_cases"
  ) {
    const type = resolve_comptime_type(arg, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });
    expect(type, expr.func.name + " requires a compile-time type value");

    if (expr.func.name === "@describe_type") {
      return describe_comptime_type(type);
    }

    if (expr.func.name === "@describe_fields") {
      return describe_comptime_fields(type);
    }

    return describe_comptime_cases(type);
  }

  if (expr.func.name === "@has") {
    if (has_const_fact(arg, env, hooks)) {
      return i32_expr(1);
    }

    return i32_expr(0);
  }

  const value = hooks.resolve_const_expr(arg, env);
  expect(value, expr.func.name + " requires a compile-time type value");
  const type_value = hooks.resolve_extended_type_value(value, env);

  if (expr.func.name === "@is_struct") {
    if (type_value.tag === "struct_type") {
      return i32_expr(1);
    }

    return i32_expr(0);
  }

  if (expr.func.name === "@is_union") {
    if (type_value.tag === "union_type") {
      return i32_expr(1);
    }

    return i32_expr(0);
  }

  if (expr.func.name === "@fields_of") {
    if (type_value.tag !== "struct_type") {
      throw new Error("fields_of expects struct type value");
    }

    return type_fields_expr(type_value.fields);
  }

  if (expr.func.name === "@cases_of") {
    if (type_value.tag !== "union_type") {
      throw new Error("cases_of expects union type value");
    }

    return type_fields_expr(type_value.cases);
  }

  const layout = layout_type(type_value);

  if (expr.func.name === "@size_of") {
    return i32_expr(layout.size);
  }

  if (expr.func.name === "@align_of") {
    return i32_expr(layout.align);
  }

  return layout_expr(layout);
}

function has_const_fact(
  expr: FrontExpr,
  env: Env,
  hooks: ConstBuiltinHooks,
): boolean {
  if (expr.tag === "captured") {
    return has_const_fact(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "field") {
    return has_const_field_fact(expr, env, hooks);
  }

  if (expr.tag !== "var") {
    const value = hooks.resolve_const_expr(expr, env);

    if (value) {
      return true;
    }

    return false;
  }

  if (is_builtin_type_name(expr.name)) {
    return true;
  }

  const binding = hooks.lookup(env, expr.name);

  if (binding && binding.is_const) {
    return true;
  }

  return false;
}

function has_const_field_fact(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: ConstBuiltinHooks,
): boolean {
  const value = hooks.resolve_const_expr_with_env(expr.object, env);

  if (!value) {
    return false;
  }

  if (value.expr.tag === "struct_value") {
    return lookup_field(value.expr.fields, expr.name) !== undefined;
  }

  if (hooks.lookup_const_field(value.expr, expr.name, value.env)) {
    return true;
  }

  const type_value = hooks.resolve_extended_type_value(value.expr, value.env);

  if (type_value.tag === "struct_type") {
    return lookup_type_field(type_value.fields, expr.name) !== undefined;
  }

  if (type_value.tag === "union_type") {
    return lookup_type_field(type_value.cases, expr.name) !== undefined;
  }

  return false;
}
