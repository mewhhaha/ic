import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { lower_rec_bound_value_app } from "./rec_bound_app.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import { lower_rec_prim } from "./rec_prim.ts";
import { lower_rec_struct_value } from "./rec_struct_value.ts";
import {
  lower_rec_get_call,
  lower_rec_len_call,
  lower_rec_runtime_text_byte_index,
} from "./rec_text.ts";
import {
  lower_rec_runtime_struct_field_access,
  lower_rec_runtime_struct_index_access,
  lower_rec_struct_get_call,
} from "./rec_struct.ts";
import { lower_rec_if_let } from "./rec_union.ts";
import { lower_rec_if as lower_rec_if_with_hooks } from "./rec_if.ts";
import { create_rec_struct_hooks } from "./rec_if_struct.ts";
import {
  can_lower_rec_bound_value_as_type,
  lower_rec_expr_as_type,
} from "./rec_type_lower.ts";

export type StaticRecResult =
  | { tag: "done"; value: IcNode }
  | { tag: "call"; args: FrontExpr[] };

export type StaticRecBlockLowerer = (
  stmts: Stmt[],
  env: Env,
  hooks: StaticRecHooks,
  expected_type?: FrontType,
) => StaticRecResult | undefined;

export function lower_rec_result_expr(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
): IcNode {
  const value = hooks.lower_static_expr(expr, env, new Set());

  if (value) {
    return value;
  }

  if (expr.tag === "captured") {
    return lower_rec_result_expr(
      expr.expr,
      expr.env,
      hooks,
      lower_static_rec_block,
    );
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return lower_rec_result_expr(
      expr.value,
      env,
      hooks,
      lower_static_rec_block,
    );
  }

  if (expr.tag === "scratch") {
    return lower_rec_result_expr(
      expr.body,
      env,
      hooks,
      lower_static_rec_block,
    );
  }

  if (expr.tag === "block") {
    const result = lower_static_rec_block(expr.statements, env, hooks);

    if (!result) {
      throw new Error(
        "Cannot lower rec block without result to Ic frontend yet" +
          structured_core_route,
      );
    }

    if (result.tag === "call") {
      throw new Error(
        "Cannot lower dynamic rec call to Ic frontend yet" +
          structured_core_route,
      );
    }

    return result.value;
  }

  if (expr.tag === "var") {
    const binding = hooks.lookup(env, expr.name);

    if (!binding) {
      return hooks.lower_expr(expr, env);
    }

    if (binding.value) {
      let value_env = env;

      if (binding.value_env) {
        value_env = binding.value_env;
      }

      const bound = hooks.lower_static_expr(
        binding.value,
        value_env,
        new Set(),
      );

      if (bound) {
        return bound;
      }

      if (binding.value.tag !== "lam" && binding.value.tag !== "rec") {
        if (can_lower_rec_bound_value_as_type(binding.type)) {
          return lower_rec_expr_as_type(
            binding.value,
            binding.type,
            value_env,
            hooks,
            lower_static_rec_block,
            lower_rec_result_expr,
          );
        }

        return lower_rec_result_expr(
          binding.value,
          value_env,
          hooks,
          lower_static_rec_block,
        );
      }
    }

    return { tag: "var", name: binding.ic_name };
  }

  if (expr.tag === "app") {
    const struct_hooks = create_rec_struct_hooks(hooks);
    const len = lower_rec_len_call(
      expr,
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

    if (len) {
      return len;
    }

    const get = lower_rec_get_call(
      expr,
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

    if (get) {
      return get;
    }

    const struct_get = lower_rec_struct_get_call(
      expr,
      env,
      struct_hooks,
      (value, value_env) =>
        lower_rec_result_expr(
          value,
          value_env,
          hooks,
          lower_static_rec_block,
        ),
    );

    if (struct_get) {
      return struct_get;
    }

    const bound_value_app = lower_rec_bound_value_app(
      expr,
      env,
      hooks,
      lower_static_rec_block,
      lower_rec_result_expr,
    );

    if (bound_value_app) {
      return bound_value_app;
    }
  }

  if (expr.tag === "prim") {
    return lower_rec_prim(
      expr,
      env,
      hooks,
      lower_static_rec_block,
      lower_rec_result_expr,
    );
  }

  if (expr.tag === "field") {
    const struct_hooks = create_rec_struct_hooks(hooks);
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (field) {
      return lower_rec_result_expr(
        field.expr,
        field.env,
        hooks,
        lower_static_rec_block,
      );
    }

    const runtime_field = lower_rec_runtime_struct_field_access(
      expr,
      env,
      struct_hooks,
      (value, value_env) =>
        lower_rec_result_expr(
          value,
          value_env,
          hooks,
          lower_static_rec_block,
        ),
    );

    if (runtime_field) {
      return runtime_field;
    }
  }

  if (expr.tag === "if") {
    const lowered_if = lower_rec_if_with_hooks(
      expr,
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

    if (lowered_if) {
      return lowered_if;
    }
  }

  if (expr.tag === "struct_value") {
    return lower_rec_struct_value(
      expr,
      env,
      hooks,
      lower_static_rec_block,
      lower_rec_result_expr,
    );
  }

  if (expr.tag === "if_let") {
    const if_let = lower_rec_if_let(
      expr,
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

    if (if_let) {
      return if_let;
    }
  }

  if (expr.tag === "index") {
    const struct_hooks = create_rec_struct_hooks(hooks);
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index !== undefined) {
      const item = hooks.resolve_index_expr(expr, env);

      if (item) {
        return lower_rec_result_expr(
          item.expr,
          item.env,
          hooks,
          lower_static_rec_block,
        );
      }
    }

    const runtime_struct_index = lower_rec_runtime_struct_index_access(
      expr.object,
      expr.index,
      env,
      struct_hooks,
      (value, value_env) =>
        lower_rec_result_expr(
          value,
          value_env,
          hooks,
          lower_static_rec_block,
        ),
    );

    if (runtime_struct_index) {
      return runtime_struct_index;
    }

    const runtime_text_byte = lower_rec_runtime_text_byte_index(
      expr.object,
      expr.index,
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

    if (runtime_text_byte) {
      return runtime_text_byte;
    }
  }

  return hooks.lower_expr(expr, env);
}
