import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import type { ExprLowerHooks, LowerExprFn } from "./expr_lower_types.ts";
import { front_expr_is_static_shareable_text } from "./ownership.ts";

export function lower_ownership_wrapper_expr(
  expr: Extract<FrontExpr, { tag: "borrow" | "freeze" | "scratch" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const value = ownership_wrapper_value(expr);

  if (can_lower_ownership_wrapper_to_ic(value, env, hooks)) {
    return lower_expr(value, env, hooks);
  }

  throw new Error(
    "Cannot lower " + ownership_wrapper_label(expr) +
      " result through pure Ic" + structured_core_route,
  );
}

function ownership_wrapper_value(
  expr: Extract<FrontExpr, { tag: "borrow" | "freeze" | "scratch" }>,
): FrontExpr {
  if (expr.tag === "scratch") {
    return expr.body;
  }

  return expr.value;
}

function ownership_wrapper_label(
  expr: Extract<FrontExpr, { tag: "borrow" | "freeze" | "scratch" }>,
): string {
  if (expr.tag === "borrow") {
    return "borrow view";
  }

  return expr.tag;
}

function can_lower_ownership_wrapper_to_ic(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
): boolean {
  const result_type = hooks.infer_expr(expr, env);

  if (result_type.tag === "bool" || result_type.tag === "int") {
    return true;
  }

  if (front_expr_is_static_shareable_text(expr, env, hooks)) {
    return true;
  }

  if (result_type.tag === "text") {
    return true;
  }

  if (result_type.tag === "struct") {
    return true;
  }

  if (result_type.tag === "union" || result_type.tag === "union_value") {
    return true;
  }

  if (result_type.tag === "fn") {
    return true;
  }

  return false;
}
