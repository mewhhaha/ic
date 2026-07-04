import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type {
  Binding,
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { call_message } from "./fields.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import {
  concat_visible_text_values,
  slice_visible_text_value,
} from "./text.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type BuiltinCallHooks = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  eval_const_builtin: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lookup: (env: Env, name: string) => Binding | undefined;
  lower_dynamic_index_access: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_runtime_struct_index_access: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_text_byte_index: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_static_text_byte_index: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_text_len: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => IcNode | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export function lower_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  if (expr.func.name === "fail") {
    throw new Error("fail: " + call_message(expr.args));
  }

  if (expr.func.name === "panic") {
    call_message(expr.args);
    return { tag: "prim", prim: "i32.trap", args: [] };
  }

  const len = lower_len_builtin(expr, env, hooks);

  if (len) {
    return len;
  }

  const dynamic_get = lower_get_builtin(expr, env, hooks);

  if (dynamic_get) {
    return dynamic_get;
  }

  const text_slice = lower_slice_builtin(expr, env, hooks);

  if (text_slice) {
    return text_slice;
  }

  const text_append = lower_append_builtin(expr, env, hooks);

  if (text_append) {
    return text_append;
  }

  const value = hooks.eval_const_builtin(expr, env);

  if (!value) {
    return undefined;
  }

  return hooks.lower_expr(value, env);
}

export function lower_method_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  if (expr.func.object.tag !== "var" && expr.func.object.tag !== "linear") {
    return undefined;
  }

  const receiver_binding = hooks.lookup(env, expr.func.object.name);

  if (
    !receiver_binding || receiver_binding.is_const ||
    receiver_binding.is_linear !== true
  ) {
    return undefined;
  }

  const method = hooks.resolve_struct_field_expr(expr.func, env);

  if (!method) {
    return undefined;
  }

  if (method.expr.tag !== "lam") {
    return undefined;
  }

  const receiver_name = expr.func.object.name;
  const args: FrontExpr[] = [{ tag: "linear", name: receiver_name }];

  for (const arg of expr.args) {
    args.push(arg);
  }

  return hooks.lower_expr(
    {
      tag: "app",
      func: hooks.capture_expr(method.expr, method.env),
      args,
    },
    env,
  );
}

function lower_len_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "len") {
    return undefined;
  }

  expect(expr.args.length === 1, "len expects 1 argument");
  let collection = expr.args[0];
  expect(collection, "Missing len argument");

  const direct_text_len = hooks.lower_text_len(collection, env, new Set());

  if (direct_text_len) {
    return direct_text_len;
  }

  collection = normalize_text_read_collection(collection, env, hooks);

  const text_len = hooks.lower_text_len(collection, env, new Set());

  if (text_len) {
    return text_len;
  }

  const collection_type = hooks.infer_expr(collection, env);

  if (collection_type.tag === "text") {
    return {
      tag: "prim",
      prim: "i32.load",
      args: [hooks.lower_expr(collection, env)],
    };
  }

  if (collection_type.tag === "unknown" && collection.tag === "if_let") {
    return {
      tag: "prim",
      prim: "i32.load",
      args: [
        lower_expr_as_front_type(collection, { tag: "text" }, env, hooks),
      ],
    };
  }

  const runtime_target = hooks.resolve_runtime_struct_type(collection, env);

  if (!runtime_target) {
    return undefined;
  }

  return {
    tag: "num",
    type: "i32",
    value: runtime_target.fields.length,
  };
}

function normalize_text_read_collection(
  expr: FrontExpr,
  env: Env,
  hooks: BuiltinCallHooks,
): FrontExpr {
  let current = expr;

  while (true) {
    if (current.tag === "block") {
      const value = hooks.eval_simple_front_block(current, env);

      if (value) {
        current = value;
        continue;
      }

      if (current.statements.length === 1) {
        const stmt = current.statements[0];
        expect(stmt, "Missing text read block statement");

        if (stmt.tag === "expr") {
          current = stmt.expr;
          continue;
        }
      }
    }

    const unwrapped = unwrap_ownership_wrapper_expr(current);

    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }

    return current;
  }
}

function lower_get_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "get") {
    return undefined;
  }

  expect(expr.args.length === 2, "get expects 2 arguments");
  let collection = expr.args[0];
  const index = expr.args[1];
  expect(collection, "Missing get collection argument");
  expect(index, "Missing get index argument");
  collection = unwrap_ownership_wrapper_expr(collection);

  if (hooks.resolve_static_i32_expr(index, env) !== undefined) {
    const static_index = hooks.resolve_static_i32_expr(index, env);
    expect(static_index !== undefined, "Missing static get index");
    const item = hooks.resolve_index_expr(
      { tag: "index", object: collection, index },
      env,
    );

    if (item) {
      return hooks.lower_expr(item.expr, item.env);
    }

    const runtime_index = hooks.lower_runtime_struct_index_access(
      collection,
      static_index,
      env,
    );

    if (runtime_index) {
      return runtime_index;
    }

    const text_byte = hooks.lower_static_text_byte_index(
      collection,
      static_index,
      env,
    );

    if (text_byte) {
      return text_byte;
    }

    const runtime_text_byte = hooks.lower_runtime_text_byte_index(
      collection,
      index,
      env,
    );

    if (runtime_text_byte) {
      return runtime_text_byte;
    }

    throw new Error("get requires a compile-time collection value");
  }

  const dynamic_index = hooks.lower_dynamic_index_access(
    collection,
    index,
    env,
  );

  if (dynamic_index) {
    return dynamic_index;
  }

  const runtime_text_byte = hooks.lower_runtime_text_byte_index(
    collection,
    index,
    env,
  );

  if (runtime_text_byte) {
    return runtime_text_byte;
  }

  return undefined;
}

function lower_slice_builtin(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "slice") {
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
  if (expr.func.tag !== "var" || expr.func.name !== "append") {
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
