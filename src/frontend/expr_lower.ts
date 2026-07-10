import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { clone_env } from "./env.ts";
import { structured_core_route } from "./diagnostic.ts";
import {
  lower_app_expr,
  lower_field_expr,
  lower_index_expr,
} from "./expr_lower_access.ts";
import {
  lower_lam_expr,
  lower_linear_expr,
  lower_var_expr,
} from "./expr_lower_binding.ts";
import type { ExprLowerHooks } from "./expr_lower_types.ts";
import { lower_ownership_wrapper_expr } from "./expr_ownership.ts";
import { lower_prim_expr } from "./expr_primitive.ts";
import { validate_rec_tail } from "./rec.ts";
import { validate_const_expr } from "./constness.ts";

export type { ExprLowerHooks } from "./expr_lower_types.ts";

export function lower_expr(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  switch (expr.tag) {
    case "num":
      return { tag: "num", type: expr.type, value: expr.value };

    case "unit":
      return { tag: "num", type: "i32", value: 0 };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      throw new Error(
        "Compile-time type name cannot be emitted as an Ic result: " +
          expr.name,
      );

    case "var":
      return lower_var_expr(expr, env, hooks, lower_expr);

    case "prim":
      return lower_prim_expr(expr, env, hooks, lower_expr);

    case "lam":
      return lower_lam_expr(expr, env, hooks, lower_expr);

    case "rec":
      validate_rec_tail(expr.body);
      throw new Error(
        "Cannot lower rec function value to Ic frontend yet" +
          structured_core_route,
      );

    case "app":
      return lower_app_expr(expr, env, hooks, lower_expr);

    case "block": {
      const local = clone_env(env);
      return hooks.lower_statements(expr.statements, 0, local);
    }

    case "comptime": {
      validate_const_expr(
        expr.expr,
        env,
        new Set(),
        "comptime expression requires compile-time values",
      );
      const value = lower_expr(expr.expr, env, hooks);
      return Ic.reduce(value);
    }

    case "borrow":
    case "freeze":
    case "scratch":
      return lower_ownership_wrapper_expr(expr, env, hooks, lower_expr);

    case "captured":
      return lower_expr(expr.expr, expr.env, hooks);

    case "handler":
      throw new Error(
        "Handler expression must be elaborated before Ic lowering",
      );

    case "try_with":
      throw new Error(
        "Try-with expression must be elaborated before Ic lowering",
      );

    case "with":
      throw new Error(
        "Compile-time extension value cannot be emitted as an Ic result",
      );

    case "struct_type":
      throw new Error(
        "Compile-time struct type cannot be emitted as an Ic result",
      );

    case "struct_value":
      return hooks.lower_struct_value(expr, env);

    case "struct_update":
      return lower_expr(
        hooks.apply_struct_update(expr, env),
        env,
        hooks,
      );

    case "union_type":
      throw new Error(
        "Compile-time union type cannot be emitted as an Ic result",
      );

    case "if":
      return hooks.lower_if_expr(expr, env);

    case "if_let":
      return hooks.lower_if_let(expr, env);

    case "field":
      return lower_field_expr(expr, env, hooks, lower_expr);

    case "index":
      return lower_index_expr(expr, env, hooks);

    case "union_case":
      return hooks.lower_union_case_value(expr, env);

    case "linear":
      return lower_linear_expr(expr, env, hooks, lower_expr);

    case "unsupported":
      throw new Error(
        "Cannot lower " + expr.feature + " to Ic frontend yet" +
          structured_core_route,
      );
  }
}
