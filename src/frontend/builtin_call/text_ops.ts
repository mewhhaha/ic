import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr } from "../ast.ts";
import { structured_core_route } from "../diagnostic.ts";
import {
  concat_visible_text_values,
  slice_visible_text_value,
} from "../text.ts";
import type { BuiltinCallHooks } from "./hooks.ts";

export function lower_text_operation_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  const text_slice = lower_slice_builtin(expr, env, hooks);

  if (text_slice) {
    return text_slice;
  }

  return lower_append_builtin(expr, env, hooks);
}

function lower_slice_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "@slice") {
    return undefined;
  }

  expect(expr.args.length === 3, "slice expects 3 arguments");
  const text = expr.args[0];
  const start = expr.args[1];
  const end = expr.args[2];
  expect(text, "Missing slice text argument");
  expect(start, "Missing slice start argument");
  expect(end, "Missing slice end argument");
  const visible_text = hooks.visible_text_value(text, env, new Set());
  const start_value = hooks.resolve_static_i32_expr(start, env);
  const end_value = hooks.resolve_static_i32_expr(end, env);

  if (visible_text && start_value !== undefined && end_value !== undefined) {
    const sliced = slice_visible_text_value(
      visible_text,
      start_value,
      end_value,
    );
    expect(sliced, "Missing sliced text value");
    return hooks.lower_expr(sliced, env);
  }

  const text_type = hooks.infer_expr(text, env);

  if (text_type.tag === "text") {
    throw new Error(
      "Text slice with runtime text or offsets requires structured Core/Wasm lowering" +
        structured_core_route,
    );
  }

  throw new Error("slice expects Text as its first argument");
}

function lower_append_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "@append") {
    return undefined;
  }

  if (hooks.lookup(env, expr.func.name)) {
    return undefined;
  }

  expect(expr.args.length === 2, "append expects 2 arguments");
  const left = expr.args[0];
  const right = expr.args[1];
  expect(left, "Missing append left argument");
  expect(right, "Missing append right argument");
  const left_type = hooks.infer_expr(left, env);
  const right_type = hooks.infer_expr(right, env);

  if (left_type.tag !== "text" || right_type.tag !== "text") {
    throw new Error("append expects Text arguments");
  }

  if (left_type.encoding !== right_type.encoding) {
    throw new Error("append arguments must both be Text or both be Bytes");
  }

  const left_text = hooks.visible_text_value(left, env, new Set());
  const right_text = hooks.visible_text_value(right, env, new Set());

  if (left_text && right_text) {
    const appended = concat_visible_text_values(left_text, right_text);
    expect(appended, "Missing appended text value");
    return hooks.lower_expr(appended, env);
  }

  throw new Error(
    "Text append with runtime text requires structured Core/Wasm lowering" +
      structured_core_route,
  );
}
