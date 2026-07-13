import type { Env, FrontExpr, FrontType, ResolvedFrontExpr } from "./ast.ts";
import { clone_env } from "./env.ts";
import { is_object_type_expr } from "./fields.ts";
import {
  bind_function_if_params,
  function_if_param_types,
  resolve_direct_lambda,
} from "./function_if.ts";
import { implicit_fallback_expr } from "./implicit_fallback.ts";
import { common_front_type } from "./types.ts";

export type CallDeferredHooks = {
  can_lower_dynamic_union_if_as_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => boolean;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_dynamic_if_let_struct_value: (
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export function is_deferred_frontend_value(
  expr: FrontExpr,
  env: Env | undefined,
  hooks: CallDeferredHooks,
): boolean {
  if (expr.tag === "captured") {
    return is_deferred_frontend_value(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "struct_value") {
    if (is_object_type_expr(expr.type_expr)) {
      return true;
    }

    return false;
  }

  if (expr.tag === "union_case") {
    return !expr.type_expr;
  }

  if (expr.tag === "if" && env) {
    const type = hooks.infer_expr(expr, env);

    if (type.tag === "fn") {
      return is_deferred_function_if(expr, env, hooks);
    }

    if (type.tag === "struct" && !type.field_types) {
      return true;
    }

    if (type.tag === "unknown") {
      const then_target = resolve_direct_lambda(expr.then_branch, env);
      const else_target = resolve_direct_lambda(expr.else_branch, env);

      if (then_target && else_target) {
        return false;
      }

      return true;
    }

    return type.tag === "union_value" &&
      !hooks.can_lower_dynamic_union_if_as_value(expr, env);
  }

  if (expr.tag === "if_let" && env) {
    if (hooks.resolve_dynamic_if_let_struct_value(expr, env)) {
      return true;
    }

    if (expr.implicit_else) {
      const type = hooks.infer_expr(expr, env);
      const fallback = implicit_fallback_expr(type, env, hooks);

      if (fallback) {
        return hooks.resolve_dynamic_if_let_struct_value({
          ...expr,
          else_branch: fallback,
          implicit_else: undefined,
        }, env) !== undefined;
      }
    }
  }

  return false;
}

function is_deferred_function_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: CallDeferredHooks,
): boolean {
  const then_target = resolve_direct_lambda(expr.then_branch, env);

  if (!then_target) {
    return false;
  }

  const else_target = resolve_direct_lambda(expr.else_branch, env);

  if (!else_target) {
    return false;
  }

  const param_types = function_if_param_types(
    then_target.expr.params,
    then_target.env,
    else_target.expr.params,
    else_target.env,
    hooks,
  );

  if (!param_types) {
    return false;
  }

  const then_env = clone_env(then_target.env);
  const else_env = clone_env(else_target.env);
  const names = bind_function_if_params(
    then_target.expr.params,
    then_env,
    else_target.expr.params,
    else_env,
    param_types,
  );

  if (!names) {
    return false;
  }

  const then_type = hooks.infer_expr(then_target.expr.body, then_env);
  const else_type = hooks.infer_expr(else_target.expr.body, else_env);
  const result_type = common_front_type(then_type, else_type);

  if (result_type && is_lowerable_function_if_result_type(result_type)) {
    return false;
  }

  const branch_if_type = hooks.infer_expr({
    tag: "if",
    cond: { tag: "captured", expr: expr.cond, env },
    then_branch: {
      tag: "captured",
      expr: then_target.expr.body,
      env: then_env,
    },
    else_branch: {
      tag: "captured",
      expr: else_target.expr.body,
      env: else_env,
    },
  }, env);

  if (branch_if_type.tag === "union_value") {
    return false;
  }

  return true;
}

function is_lowerable_function_if_result_type(type: FrontType): boolean {
  if (type.tag === "bool" || type.tag === "int" || type.tag === "text") {
    return true;
  }

  return type.tag === "struct" || type.tag === "union" ||
    type.tag === "union_value";
}

export function resolve_deferred_frontend_value(
  expr: FrontExpr,
  env: Env,
  hooks: CallDeferredHooks,
): ResolvedFrontExpr | undefined {
  const struct_value = hooks.resolve_struct_value(expr, env);

  if (struct_value) {
    return struct_value;
  }

  const union_value = hooks.resolve_union_value(expr, env);

  if (union_value) {
    return union_value;
  }

  return undefined;
}

export function resolve_deferred_text_value(
  expr: FrontExpr,
  env: Env,
  hooks: Pick<CallDeferredHooks, "visible_text_value">,
): ResolvedFrontExpr | undefined {
  const text_value = hooks.visible_text_value(expr, env, new Set());

  if (!text_value) {
    return undefined;
  }

  return { expr: text_value, env };
}
