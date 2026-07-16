import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import type {
  StaticRecBlockLowerer,
  StaticRecExprLowerer,
} from "./rec_contract.ts";
import { lower_rec_bound_if_let_union_result_app } from "./rec_union.ts";

export function lower_rec_bound_value_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
  lower_rec_result_expr: StaticRecExprLowerer,
): IcNode | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  const binding = hooks.lookup(env, expr.func.name);

  if (!binding) {
    return undefined;
  }

  if (!binding.value) {
    return undefined;
  }

  if (binding.value.tag === "lam" || binding.value.tag === "rec") {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const union_result_app = lower_rec_bound_if_let_union_result_app(
    binding.value,
    value_env,
    expr.args,
    env,
    hooks,
    (value, value_env) =>
      lower_rec_result_expr(
        value,
        value_env,
        hooks,
        lower_static_rec_block,
      ),
  );

  if (union_result_app) {
    return union_result_app;
  }

  let result = lower_rec_result_expr(
    expr.func,
    env,
    hooks,
    lower_static_rec_block,
  );

  for (const arg of expr.args) {
    result = {
      tag: "app",
      func: result,
      arg: lower_rec_result_expr(
        arg,
        env,
        hooks,
        lower_static_rec_block,
      ),
    };
  }

  return result;
}
