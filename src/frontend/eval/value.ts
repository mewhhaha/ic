import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { capture_deferred_expr, capture_expr } from "../capture.ts";
import { validate_const_expr } from "../constness.ts";
import { call_message } from "../call_message.ts";
import {
  comptime_type_key,
  type ComptimeType,
  resolve_comptime_type,
} from "../comptime_value.ts";
import { substitute_front_expr } from "../substitute.ts";
import { parse_type_expr } from "../type_expr.ts";
import { tokenize } from "../tokenize.ts";
import type { FrontEvalHooks } from "./types.ts";

export type FrontValueEvalApi = {
  eval_front_block: (
    stmts: Stmt[],
    env: Env,
    hooks: FrontEvalHooks,
  ) => FrontExpr;
  eval_front_value: (
    expr: FrontExpr,
    env: Env,
    hooks: FrontEvalHooks,
  ) => FrontExpr;
};

export function eval_front_value_impl(
  expr: FrontExpr,
  env: Env,
  hooks: FrontEvalHooks,
  api: FrontValueEvalApi,
): FrontExpr {
  if (expr.tag === "block") {
    return api.eval_front_block(expr.statements, env, hooks);
  }

  if (expr.tag === "comptime") {
    validate_const_expr(
      expr.expr,
      env,
      new Set(),
      "comptime expression requires compile-time values",
    );
    return api.eval_front_value(expr.expr, env, hooks);
  }

  if (
    expr.tag === "match" &&
    expr.arms.some((arm) => arm.pattern.tag === "type")
  ) {
    const target = resolve_comptime_type(expr.target, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });

    if (!target) {
      throw new Error("Type match requires a compile-time type value");
    }

    for (const arm of expr.arms) {
      let matches = false;
      let body = arm.body;

      if (arm.pattern.tag === "type") {
        matches = comptime_type_pattern_matches(
          arm.pattern.pattern,
          target,
          env,
          hooks,
        );
      } else if (arm.pattern.tag === "wildcard") {
        matches = true;
      } else if (arm.pattern.tag === "binding") {
        if (arm.pattern.mode === "linear") {
          throw new Error(
            "Linear bindings are not supported in compile-time type matches",
          );
        }

        matches = true;
        body = substitute_front_expr(
          body,
          new Map([[arm.pattern.name, capture_expr(expr.target, env)]]),
        );
      } else {
        throw new Error(
          "Compile-time type match arm must use a type pattern or catch-all",
        );
      }

      if (!matches) {
        continue;
      }

      if (arm.guard !== undefined) {
        const guard = hooks.eval_i32_expr(
          arm.guard,
          env,
          "type match guard",
        );

        if (guard === 0) {
          continue;
        }
      }

      return api.eval_front_value(body, env, hooks);
    }

    throw new Error("Non-exhaustive type match for compile-time type value");
  }

  if (expr.tag === "app") {
    if (expr.func.tag === "var" && expr.func.name === "@fail") {
      throw new Error("@fail: " + call_message(expr.args));
    }

    const union_value = hooks.resolve_union_constructor_call(expr, env);

    if (union_value) {
      return union_value.expr;
    }

    const value = hooks.eval_const_call(expr, env, true);

    if (value) {
      return value;
    }

    const deferred = hooks.inline_deferred_const_call(expr, env);

    if (deferred) {
      return capture_expr(deferred.expr, deferred.env);
    }
  }

  if (expr.tag === "prim") {
    const text_value = hooks.visible_text_value(expr, env, new Set());

    if (text_value) {
      return api.eval_front_value(text_value, env, hooks);
    }
  }

  if (expr.tag === "field") {
    const const_field = hooks.resolve_const_field_expr(expr, env);

    if (const_field) {
      return api.eval_front_value(const_field, env, hooks);
    }

    const struct_field = hooks.resolve_struct_field_expr(expr, env);

    if (struct_field) {
      return api.eval_front_value(struct_field.expr, struct_field.env, hooks);
    }

    throw new Error("Missing const field: " + expr.name);
  }

  if (expr.tag === "index") {
    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      return api.eval_front_value(item.expr, item.env, hooks);
    }

    throw new Error("Cannot evaluate dynamic index access yet");
  }

  return capture_deferred_expr(expr, env);
}

function comptime_type_pattern_matches(
  pattern: import("../ast.ts").TypePattern,
  target: ComptimeType,
  env: Env,
  hooks: FrontEvalHooks,
): boolean {
  let fields: import("../comptime_value.ts").ComptimeTypeField[];

  if (pattern.kind === "struct") {
    if (target.tag !== "record") {
      return false;
    }

    fields = target.fields;
  } else {
    if (target.tag !== "sum") {
      return false;
    }

    fields = target.cases;
  }

  for (const expected of pattern.fields) {
    const actual = fields.find((field) => field.name === expected.name);

    if (!actual) {
      return false;
    }

    const expected_type = resolve_comptime_type(
      {
        tag: "set_type",
        type_expr: parse_type_expr(tokenize(expected.type_name)),
      },
      env,
      { resolve_const_expr_with_env: hooks.resolve_const_expr_with_env },
    );

    if (!expected_type) {
      throw new Error(
        "Type match pattern has unresolved field type " + expected.type_name,
      );
    }

    if (comptime_type_key(actual.type) !== comptime_type_key(expected_type)) {
      return false;
    }
  }

  if (!pattern.open && fields.length !== pattern.fields.length) {
    return false;
  }

  return true;
}
