import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { clone_env, fresh } from "./env.ts";
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
import { is_const_expr_known } from "./const_known.ts";
import { lower_ownership_wrapper_expr } from "./expr_ownership.ts";
import { lower_prim_expr } from "./expr_primitive.ts";
import { validate_rec_tail } from "./rec.ts";
import { validate_const_expr } from "./constness.ts";
import { atom_i32 } from "./atom.ts";
import {
  elaborate_array_repeat_expr,
  elaborate_fixed_array_expr,
  elaborate_product_as_expr,
  elaborate_product_expr,
} from "./aggregate.ts";

export type { ExprLowerHooks } from "./expr_lower_types.ts";

export function lower_expr(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  switch (expr.tag) {
    case "bool": {
      let value = 0;

      if (expr.value) {
        value = 1;
      }

      return { tag: "num", type: "i32", value };
    }

    case "atom":
      return { tag: "num", type: "i32", value: atom_i32(expr.name) };

    case "num": {
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

    case "unit":
      return { tag: "num", type: "i32", value: 0 };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      throw new Error(
        "Compile-time type name cannot be emitted as an Ic result: " +
          expr.name,
      );

    case "set_type":
      throw new Error(
        "Compile-time set type cannot be emitted as an Ic result",
      );

    case "is":
      throw new Error("`is` expression must be elaborated before Ic lowering");

    case "as":
      return lower_expr(elaborate_product_as_expr(expr), env, hooks);

    case "match":
      throw new Error(
        "Match expression must be elaborated before Ic lowering",
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

    case "product":
      return lower_expr(elaborate_product_expr(expr), env, hooks);

    case "shape":
      throw new Error("Compile-time shape cannot be emitted as an Ic result");

    case "array":
      return lower_expr(elaborate_fixed_array_expr(expr), env, hooks);

    case "array_repeat":
      return lower_expr(
        elaborate_array_repeat_expr(expr, fresh(env, "array_repeat")),
        env,
        hooks,
      );

    case "import":
      throw new Error(
        "Expression import must be resolved before Ic lowering: " + expr.path,
      );

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

    case "loop":
      throw new Error(
        "Cannot lower loop through pure Ic" + structured_core_route,
      );

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

    case "with": {
      let base = expr.base;

      while (base.tag === "with") {
        base = base.base;
      }

      if (base.tag === "struct_type") {
        throw new Error(
          "Compile-time struct type cannot be emitted as an Ic result",
        );
      }

      throw new Error(
        "Compile-time extension value cannot be emitted as an Ic result",
      );
    }

    case "struct_type":
      throw new Error(
        "Compile-time struct type cannot be emitted as an Ic result",
      );

    case "struct_value":
      return hooks.lower_struct_value(expr, env);

    case "struct_update":
      if (is_const_expr_known(expr.base, env, new Set())) {
        throw new Error(
          "Compile-time extension value cannot be emitted as an Ic result",
        );
      }

      return lower_expr(
        hooks.apply_struct_update(expr, env),
        env,
        hooks,
      );

    case "type_with":
      throw new Error(
        "Computed type members must be elaborated before Ic lowering",
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
