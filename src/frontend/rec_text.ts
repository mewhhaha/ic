import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Binding, Env, FrontExpr, FrontType } from "./ast.ts";
import { text_byte_length } from "./text.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type StaticRecTextHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lookup: (env: Env, name: string) => Binding | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
};

type LowerRecResult = (expr: FrontExpr, env: Env) => IcNode;

export function lower_rec_len_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecTextHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "len") {
    return undefined;
  }

  if (expr.args.length !== 1) {
    throw new Error("len expects 1 argument");
  }

  const arg = expr.args[0];
  expect(arg, "Missing len argument");
  const text_len = lower_rec_text_len(arg, env, new Set(), hooks, lower_result);

  if (text_len) {
    return text_len;
  }

  const arg_type = hooks.infer_expr(arg, env);

  if (arg_type.tag !== "text") {
    return undefined;
  }

  return {
    tag: "prim",
    prim: "i32.load",
    args: [lower_result(arg, env)],
  };
}

export function lower_rec_get_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecTextHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  if (expr.func.tag !== "var" || expr.func.name !== "get") {
    return undefined;
  }

  if (expr.args.length !== 2) {
    throw new Error("get expects 2 arguments");
  }

  const collection = expr.args[0];
  const index = expr.args[1];
  expect(collection, "Missing get collection argument");
  expect(index, "Missing get index argument");
  return lower_rec_runtime_text_byte_index(
    collection,
    index,
    env,
    hooks,
    lower_result,
  );
}

function lower_rec_text_len(
  expr: FrontExpr,
  env: Env,
  seen: Set<string>,
  hooks: StaticRecTextHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  if (expr.tag === "captured") {
    return lower_rec_text_len(expr.expr, expr.env, seen, hooks, lower_result);
  }

  if (expr.tag === "text") {
    return {
      tag: "num",
      type: "i32",
      value: text_byte_length(expr.value),
    };
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  if (seen.has(expr.name)) {
    return undefined;
  }

  const binding = hooks.lookup(env, expr.name);

  if (!binding) {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const next_seen = new Set(seen);
  next_seen.add(expr.name);

  if (binding.value) {
    const value_len = lower_rec_text_len(
      binding.value,
      value_env,
      next_seen,
      hooks,
      lower_result,
    );

    if (value_len) {
      return value_len;
    }

    if (binding.is_deferred) {
      return {
        tag: "prim",
        prim: "i32.load",
        args: [
          lower_expr_as_front_type(
            binding.value,
            { tag: "text" },
            value_env,
            {
              infer_expr: hooks.infer_expr,
              lower_expr: lower_result,
            },
          ),
        ],
      };
    }
  }

  if (binding.type.tag !== "text") {
    return undefined;
  }

  let target: IcNode = { tag: "var", name: binding.ic_name };

  if (binding.value) {
    target = lower_expr_as_front_type(
      binding.value,
      binding.type,
      value_env,
      {
        infer_expr: hooks.infer_expr,
        lower_expr: lower_result,
      },
    );
  }

  return {
    tag: "prim",
    prim: "i32.load",
    args: [target],
  };
}

export function lower_rec_runtime_text_byte_index(
  object: FrontExpr,
  index: FrontExpr,
  env: Env,
  hooks: StaticRecTextHooks,
  lower_result: LowerRecResult,
): IcNode | undefined {
  const object_type = hooks.infer_expr(object, env);

  if (object_type.tag !== "text") {
    return undefined;
  }

  const index_type = hooks.infer_expr(index, env);

  if (
    index_type.tag === "int" && index_type.type !== undefined &&
    index_type.type !== "i32"
  ) {
    throw new Error("Text index must be i32");
  }

  const static_index = hooks.resolve_static_i32_expr(index, env);

  if (static_index !== undefined && static_index < 0) {
    throw new Error("Text index out of bounds: " + static_index.toString());
  }

  const lowered_object = lower_result(object, env);
  const lowered_index = lower_result(index, env);
  const length: IcNode = {
    tag: "prim",
    prim: "i32.load",
    args: [lowered_object],
  };
  const byte: IcNode = {
    tag: "prim",
    prim: "i32.load8_u",
    args: [
      {
        tag: "prim",
        prim: "i32.add",
        args: [
          {
            tag: "prim",
            prim: "i32.add",
            args: [
              lowered_object,
              { tag: "num", type: "i32", value: 4 },
            ],
          },
          lowered_index,
        ],
      },
    ],
  };
  const trap: IcNode = { tag: "prim", prim: "i32.trap", args: [] };

  return {
    tag: "prim",
    prim: "i32.select",
    args: [
      trap,
      {
        tag: "prim",
        prim: "i32.select",
        args: [
          byte,
          trap,
          {
            tag: "prim",
            prim: "i32.lt_s",
            args: [
              lowered_index,
              length,
            ],
          },
        ],
      },
      {
        tag: "prim",
        prim: "i32.lt_s",
        args: [
          lowered_index,
          { tag: "num", type: "i32", value: 0 },
        ],
      },
    ],
  };
}
