import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr } from "../ast.ts";
import { unwrap_ownership_wrapper_expr } from "../ownership.ts";
import { lower_expr_as_front_type } from "../typed_lower.ts";
import type { BuiltinCallHooks } from "./hooks.ts";

export function lower_text_read_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  const len = lower_len_builtin(expr, env, hooks);

  if (len) {
    return len;
  }

  return lower_get_builtin(expr, env, hooks);
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
