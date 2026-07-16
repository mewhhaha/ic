import { expect } from "../expect.ts";
import type { Env, FrontExpr } from "./ast.ts";
import {
  concat_visible_text_values,
  slice_visible_text_value,
} from "./text.ts";
import type { TextLowerHooks } from "./text_lower_types.ts";
import { visible_if_let_value } from "./text_visible_if_let.ts";

export function visible_text_value(
  expr: FrontExpr,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): FrontExpr | undefined {
  if (expr.tag === "captured") {
    return visible_text_value(expr.expr, expr.env, seen, hooks);
  }

  if (expr.tag === "text") {
    return expr;
  }

  if (expr.tag === "comptime") {
    return visible_text_value(expr.expr, env, seen, hooks);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return visible_text_value(expr.value, env, seen, hooks);
  }

  if (expr.tag === "scratch") {
    return visible_text_value(expr.body, env, seen, hooks);
  }

  if (expr.tag === "prim" && expr.prim === "i32.add") {
    const left = visible_text_value(expr.left, env, seen, hooks);
    const right = visible_text_value(expr.right, env, seen, hooks);

    if (!left || !right) {
      return undefined;
    }

    return concat_visible_text_values(left, right);
  }

  if (expr.tag === "var") {
    if (seen.has(expr.name)) {
      return undefined;
    }

    const binding = hooks.lookup(env, expr.name);

    if (!binding || !binding.value) {
      return undefined;
    }

    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    const next_seen = new Set(seen);
    next_seen.add(expr.name);
    return visible_text_value(binding.value, value_env, next_seen, hooks);
  }

  if (expr.tag === "if") {
    const then_branch = visible_text_value(
      expr.then_branch,
      env,
      seen,
      hooks,
    );

    if (!then_branch) {
      return undefined;
    }

    let else_branch: FrontExpr | undefined;

    if (expr.implicit_else) {
      else_branch = { tag: "text", value: "" };
    } else {
      else_branch = visible_text_value(
        expr.else_branch,
        env,
        seen,
        hooks,
      );
    }

    if (!else_branch) {
      return undefined;
    }

    return {
      tag: "if",
      cond: expr.cond,
      then_branch,
      else_branch,
    };
  }

  if (expr.tag === "if_let") {
    return visible_if_let_value(expr, env, seen, hooks, visible_text_value);
  }

  if (expr.tag === "block") {
    let value: FrontExpr | undefined;

    try {
      value = hooks.eval_simple_front_block(expr, env);
    } catch {
      value = undefined;
    }

    if (value) {
      return visible_text_value(value, env, seen, hooks);
    }

    if (expr.statements.length !== 1) {
      return undefined;
    }

    const final_stmt = expr.statements[0];
    expect(final_stmt, "Missing text block statement");

    if (final_stmt.tag === "expr") {
      return visible_text_value(final_stmt.expr, env, seen, hooks);
    }

    if (final_stmt.tag === "return") {
      return visible_text_value(final_stmt.value, env, seen, hooks);
    }

    return undefined;
  }

  if (expr.tag === "app") {
    const slice = visible_slice_value(expr, env, seen, hooks);

    if (slice) {
      return slice;
    }

    const append = visible_append_value(expr, env, seen, hooks);

    if (append) {
      return append;
    }

    const value = hooks.try_eval_all_const_call(expr, env);

    if (value) {
      return visible_text_value(value, env, seen, hooks);
    }

    let runtime: { expr: FrontExpr; env: Env } | undefined;

    try {
      runtime = hooks.inline_runtime_call_expr(expr, env);
    } catch {
      runtime = undefined;
    }

    if (!runtime) {
      return undefined;
    }

    return visible_text_value(runtime.expr, runtime.env, seen, hooks);
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return visible_text_value(field.expr, field.env, seen, hooks);
  }

  if (expr.tag === "index") {
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index === undefined) {
      return undefined;
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (!item) {
      return undefined;
    }

    return visible_text_value(item.expr, item.env, seen, hooks);
  }

  return undefined;
}

function visible_slice_value(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): FrontExpr | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "@slice") {
    return undefined;
  }

  if (expr.args.length !== 3) {
    return undefined;
  }

  const text_arg = expr.args[0];
  const start_arg = expr.args[1];
  const end_arg = expr.args[2];
  expect(text_arg, "Missing slice text argument");
  expect(start_arg, "Missing slice start argument");
  expect(end_arg, "Missing slice end argument");
  const text = visible_text_value(text_arg, env, seen, hooks);
  const start = hooks.resolve_static_i32_expr(start_arg, env);
  const end = hooks.resolve_static_i32_expr(end_arg, env);

  if (!text || start === undefined || end === undefined) {
    return undefined;
  }

  return slice_visible_text_value(text, start, end);
}

function visible_append_value(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): FrontExpr | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "@append") {
    return undefined;
  }

  if (hooks.lookup(env, expr.func.name)) {
    return undefined;
  }

  if (expr.args.length !== 2) {
    return undefined;
  }

  const left_arg = expr.args[0];
  const right_arg = expr.args[1];
  expect(left_arg, "Missing append left argument");
  expect(right_arg, "Missing append right argument");
  const left = visible_text_value(left_arg, env, seen, hooks);
  const right = visible_text_value(right_arg, env, seen, hooks);

  if (!left || !right) {
    return undefined;
  }

  return concat_visible_text_values(left, right);
}

export function check_text_concat_operand_visibility(
  expr: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): void {
  if (expr.tag !== "prim" || expr.prim !== "i32.add") {
    return;
  }

  const left = visible_text_value(expr.left, env, new Set(), hooks);
  const right = visible_text_value(expr.right, env, new Set(), hooks);

  if ((left && !right) || (!left && right)) {
    throw new Error("Text concatenation requires visible text operands");
  }
}
