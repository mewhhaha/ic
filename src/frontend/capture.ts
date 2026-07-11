import { expect } from "../expect.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { lookup } from "./env.ts";

export function capture_expr(expr: FrontExpr, env: Env): FrontExpr {
  return { tag: "captured", expr, env };
}

export function capture_const_ref(expr: FrontExpr, env: Env): FrontExpr {
  if (expr.tag !== "var") {
    return expr;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.is_const) {
    return expr;
  }

  expect(binding.value, "Missing const value: " + expr.name);

  if (binding.value_env) {
    return capture_expr(binding.value, binding.value_env);
  }

  return binding.value;
}

export function capture_deferred_expr(expr: FrontExpr, env: Env): FrontExpr {
  if (expr.tag === "struct_value") {
    return {
      tag: "struct_value",
      type_expr: capture_expr(expr.type_expr, env),
      fields: expr.fields.map((field) => ({
        name: field.name,
        value: capture_expr(field.value, env),
      })),
      bracketed: expr.bracketed,
    };
  }

  if (expr.tag === "union_case") {
    let value: FrontExpr | undefined;
    let type_expr: FrontExpr | undefined;

    if (expr.value) {
      value = capture_expr(expr.value, env);
    }

    if (expr.type_expr) {
      type_expr = capture_expr(expr.type_expr, env);
    }

    return {
      tag: "union_case",
      name: expr.name,
      value,
      type_expr,
    };
  }

  return capture_expr(expr, env);
}
