import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { select_prim_for_branches } from "./numeric.ts";
import { lower_rec_dynamic_struct_if } from "./rec_if_struct.ts";
import { infer_rec_expr } from "./rec_infer.ts";
import { lower_rec_dynamic_union_if } from "./rec_union.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import { common_front_type, front_type_name } from "./types.ts";

export type RecResultLowerer = (expr: FrontExpr, env: Env) => IcNode;

export function lower_rec_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: StaticRecHooks,
  lower_result: RecResultLowerer,
): IcNode | undefined {
  check_rec_if_condition(expr.cond, env, hooks);
  const cond = Ic.reduce(lower_result(expr.cond, env));

  if (cond.tag === "num") {
    if (cond.type !== "i32") {
      throw new Error("If condition expects i32, got " + cond.type);
    }

    const value = cond.value;
    expect(typeof value === "number", "Expected i32 if condition");

    if (value !== 0) {
      return lower_result(expr.then_branch, env);
    }

    return lower_result(expr.else_branch, env);
  }

  const then_type = infer_rec_expr(expr.then_branch, env, hooks);
  const else_type = infer_rec_expr(expr.else_branch, env, hooks);
  const branch_type = common_front_type(then_type, else_type);

  if (!branch_type) {
    return undefined;
  }

  if (branch_type.tag === "text") {
    return {
      tag: "prim",
      prim: "i32.select",
      args: [
        lower_rec_branch_result(expr.then_branch, env, hooks, lower_result),
        lower_rec_branch_result(expr.else_branch, env, hooks, lower_result),
        cond,
      ],
    };
  }

  if (branch_type.tag === "struct" && branch_type.field_types) {
    return lower_rec_dynamic_struct_if(
      expr,
      branch_type.field_types,
      env,
      hooks,
      lower_result,
    );
  }

  if (branch_type.tag === "union_value") {
    const union_if = lower_rec_dynamic_union_if(
      expr,
      branch_type.cases,
      env,
      hooks,
      lower_result,
    );

    if (union_if) {
      return union_if;
    }
  }

  if (branch_type.tag !== "bool" && branch_type.tag !== "int") {
    return undefined;
  }

  let select_prim = select_prim_for_branches(
    expr.then_branch,
    expr.else_branch,
  );

  if (branch_type.tag === "int" && branch_type.type === "i64") {
    select_prim = "i64.select";
  }

  if (branch_type.tag === "int" && branch_type.type === "f32") {
    select_prim = "f32.select";
  }

  if (branch_type.tag === "int" && branch_type.type === "f64") {
    select_prim = "f64.select";
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      lower_rec_branch_result(expr.then_branch, env, hooks, lower_result),
      lower_rec_branch_result(expr.else_branch, env, hooks, lower_result),
      cond,
    ],
  };
}

function lower_rec_branch_result(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  lower_result: RecResultLowerer,
): IcNode {
  const resolved = resolve_rec_runtime_alias(expr, env, hooks, new Set());

  if (resolved) {
    return lower_result(resolved.expr, resolved.env);
  }

  return lower_result(expr, env);
}

function resolve_rec_runtime_alias(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  seen: Set<object>,
): { expr: FrontExpr; env: Env } | undefined {
  if (expr.tag === "captured") {
    return resolve_rec_runtime_alias(expr.expr, expr.env, hooks, seen);
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = hooks.lookup(env, expr.name);

  if (!binding || !binding.value) {
    return undefined;
  }

  if (binding.value.tag === "lam" || binding.value.tag === "rec") {
    return undefined;
  }

  if (seen.has(binding)) {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  seen.add(binding);
  const nested = resolve_rec_runtime_alias(
    binding.value,
    value_env,
    hooks,
    seen,
  );
  seen.delete(binding);

  if (nested) {
    return nested;
  }

  return { expr: binding.value, env: value_env };
}

function check_rec_if_condition(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
): void {
  const type = hooks.infer_expr(expr, env);

  if (type.tag === "unknown") {
    return;
  }

  if (type.tag === "bool") {
    return;
  }

  if (type.tag === "int" && type.type === "i32") {
    return;
  }

  throw new Error(
    "If condition expects Bool or I32, got " + front_type_name(type),
  );
}
