import type { Env, FrontExpr, ResolvedFrontExpr } from "./ast.ts";

export type FrontPrepareHooks = {
  apply_struct_update: (
    expr: Extract<FrontExpr, { tag: "struct_update" }>,
    env: Env,
  ) => FrontExpr;
  capture_const_ref: (expr: FrontExpr, env: Env) => FrontExpr;
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  inline_deferred_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_constructor_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  try_eval_all_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
  validate_struct_value: (
    value: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => void;
};

export function prepare_const_value(
  expr: FrontExpr,
  env: Env,
  hooks: FrontPrepareHooks,
): FrontExpr {
  if (expr.tag === "with" || expr.tag === "struct_update") {
    return {
      tag: "with",
      base: hooks.capture_const_ref(expr.base, env),
      fields: expr.fields,
    };
  }

  if (expr.tag === "app") {
    const union_value = hooks.resolve_union_constructor_call(expr, env);

    if (union_value) {
      return union_value.expr;
    }
  }

  if (expr.tag === "struct_value") {
    hooks.validate_struct_value(expr, env);
  }

  return expr;
}

export function prepare_runtime_value(
  expr: FrontExpr,
  env: Env,
  hooks: FrontPrepareHooks,
): FrontExpr {
  if (expr.tag === "app") {
    const union_value = hooks.resolve_union_constructor_call(expr, env);

    if (union_value) {
      return union_value.expr;
    }

    const value = hooks.try_eval_all_const_call(expr, env);

    if (value) {
      return value;
    }

    const deferred = hooks.inline_deferred_const_call(expr, env);

    if (deferred) {
      return hooks.capture_expr(deferred.expr, deferred.env);
    }
  }

  if (expr.tag === "struct_update") {
    const value = hooks.apply_struct_update(expr, env);

    if (value.tag === "struct_value") {
      hooks.validate_struct_value(value, env);
    }

    return value;
  }

  if (expr.tag === "struct_value") {
    hooks.validate_struct_value(expr, env);
  }

  return expr;
}
