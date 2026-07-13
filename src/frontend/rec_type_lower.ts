import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { infer_rec_expr } from "./rec_infer.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import type { StaticRecBlockLowerer } from "./rec_result.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type StaticRecExprLowerer = (
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
) => IcNode;

export function lower_rec_expr_as_type(
  expr: FrontExpr,
  type: FrontType,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
  lower_rec_result_expr: StaticRecExprLowerer,
): IcNode {
  return lower_expr_as_front_type(expr, type, env, {
    infer_expr: (value, value_env) => infer_rec_expr(value, value_env, hooks),
    lower_expr: (value, value_env) =>
      lower_rec_result_expr(
        value,
        value_env,
        hooks,
        lower_static_rec_block,
      ),
    resolve_annotation_type: hooks.resolve_annotation_type,
  });
}

export function can_lower_rec_bound_value_as_type(type: FrontType): boolean {
  if (type.tag === "bool" || type.tag === "int" || type.tag === "text") {
    return true;
  }

  return type.tag === "struct" || type.tag === "union_value";
}
