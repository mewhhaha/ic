import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Binding, Env, FrontExpr, ResolvedFrontExpr } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";

export type StaticExprHooks = {
  lookup: (env: Env, name: string) => Binding | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
};

export function eval_i32_expr(
  expr: FrontExpr,
  env: Env,
  label: string,
  hooks: StaticExprHooks,
): number {
  let lowered = lower_static_expr(expr, env, new Set(), hooks);

  if (!lowered) {
    lowered = hooks.lower_expr(expr, env);
  }

  const reduced = Ic.reduce(lowered);

  if (reduced.tag !== "num" || reduced.type !== "i32") {
    throw new Error(
      "Cannot lower dynamic " + label + " to Ic frontend yet" +
        structured_core_route,
    );
  }

  const value = reduced.value;
  expect(typeof value === "number", "Expected i32 " + label);
  return value;
}

export function lower_static_expr(
  expr: FrontExpr,
  env: Env,
  seen: Set<Binding>,
  hooks: StaticExprHooks,
): IcNode | undefined {
  if (expr.tag === "bool") {
    let value = 0;

    if (expr.value) {
      value = 1;
    }

    return { tag: "num", type: "i32", value };
  }

  if (expr.tag === "num") {
    const lowered: IcNode = {
      tag: "num",
      type: expr.type,
      value: expr.value,
    };

    if (expr.integer) {
      lowered.integer = expr.integer;
    }

    return lowered;
  }

  if (expr.tag === "type_name") {
    return undefined;
  }

  if (expr.tag === "captured") {
    return lower_static_expr(expr.expr, expr.env, seen, hooks);
  }

  if (expr.tag === "prim") {
    const left = lower_static_expr(expr.left, env, seen, hooks);
    const right = lower_static_expr(expr.right, env, seen, hooks);

    if (!left || !right) {
      return undefined;
    }

    return { tag: "prim", prim: expr.prim, args: [left, right] };
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return lower_static_expr(field.expr, field.env, seen, hooks);
  }

  if (expr.tag === "index") {
    const static_index = resolve_static_i32_expr(expr.index, env, hooks);

    if (static_index === undefined) {
      return undefined;
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (!item) {
      return undefined;
    }

    return lower_static_expr(item.expr, item.env, seen, hooks);
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = hooks.lookup(env, expr.name);

  if (!binding || !binding.value) {
    return undefined;
  }

  if (seen.has(binding)) {
    throw new Error("Recursive static value: " + expr.name);
  }

  seen.add(binding);
  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const value = lower_static_expr(binding.value, value_env, seen, hooks);
  seen.delete(binding);
  return value;
}

export function resolve_static_i32_expr(
  expr: FrontExpr,
  env: Env,
  hooks: StaticExprHooks,
): number | undefined {
  const lowered = lower_static_expr(expr, env, new Set(), hooks);

  if (!lowered) {
    return undefined;
  }

  const reduced = Ic.reduce(lowered);

  if (reduced.tag !== "num" || reduced.type !== "i32") {
    return undefined;
  }

  const value = reduced.value;
  expect(typeof value === "number", "Expected static i32 expression");
  return value;
}
