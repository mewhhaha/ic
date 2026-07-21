import {
  type NumType,
  Prim,
  prim_preserves_integer_type,
  specialize_prim_for_operands,
  type ValType,
} from "../../op.ts";
import type { Env, FrontExpr, FrontType } from "../ast.ts";
import { lookup } from "../env.ts";
import { numeric_builtin_call, prim_result_type } from "../numeric.ts";
import type { InferExprFn, InferHooks } from "./types.ts";
import { Callable } from "../../trait.ts";
import { infer_f32x4_builtin_call } from "../f32x4.ts";
import { front_type_from_type_name } from "../types.ts";
import { compiler_builtin_args } from "../call_args.ts";

export function infer_prim_result_type(
  expr: Extract<FrontExpr, { tag: "prim" }>,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): NumType {
  const left_type = infer_prim_operand_type(expr.left, env, hooks, infer_expr);
  const right_type = infer_prim_operand_type(
    expr.right,
    env,
    hooks,
    infer_expr,
  );
  const prim = specialize_prim_for_operands(
    expr.prim,
    left_type,
    right_type,
  );
  const result = prim_result_type(prim);

  if (result === "v128") {
    throw new Error("Infix primitives cannot produce F32x4 values");
  }

  return result;
}

export function infer_builtin_call_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): FrontType | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  if (
    (expr.func.name === "@cast" || expr.func.name === "@seal" ||
      expr.func.name === "@representation" ||
      expr.func.name === "@integer.wrap") &&
    !lookup(env, expr.func.name)
  ) {
    const args = compiler_builtin_args(expr);
    const target = args[1];

    if (
      args.length === 2 && target !== undefined &&
      (target.tag === "var" || target.tag === "type_name")
    ) {
      return front_type_from_type_name(target.name);
    }

    return { tag: "unknown" };
  }

  const f32x4_call = infer_f32x4_builtin_call(expr, env);

  if (f32x4_call) {
    return f32x4_call;
  }

  const numeric_call = numeric_builtin_call(expr);

  if (numeric_call && !lookup(env, expr.func.name)) {
    const expected = Callable.arity(Prim, numeric_call.prim);

    if (numeric_call.args.length !== expected) {
      return { tag: "unknown" };
    }

    if (expected === 2) {
      const left = numeric_call.args[0];
      const right = numeric_call.args[1];

      if (!left || !right) {
        throw new Error("Missing numeric builtin argument");
      }

      const left_type = infer_prim_operand_type(
        left,
        env,
        hooks,
        infer_expr,
      );
      const right_type = infer_prim_operand_type(
        right,
        env,
        hooks,
        infer_expr,
      );
      const prim = specialize_prim_for_operands(
        numeric_call.prim,
        left_type,
        right_type,
      );
      const result = prim_result_type(prim);

      if (result === "v128") {
        throw new Error("Numeric builtin cannot produce F32x4 values");
      }

      if (prim_preserves_integer_type(prim)) {
        const left_front_type = infer_expr(left, env, hooks);
        const right_front_type = infer_expr(right, env, hooks);

        if (
          left_front_type.tag === "wide_int" &&
          right_front_type.tag === "wide_int" &&
          left_front_type.integer.signed === right_front_type.integer.signed &&
          left_front_type.integer.width === right_front_type.integer.width
        ) {
          return left_front_type;
        }

        if (
          left_front_type.tag === "int" && right_front_type.tag === "int" &&
          left_front_type.integer && right_front_type.integer &&
          left_front_type.integer.signed === right_front_type.integer.signed &&
          left_front_type.integer.width === right_front_type.integer.width
        ) {
          return left_front_type;
        }
      }

      return { tag: "int", type: result };
    }

    const result = Callable.type(Prim, numeric_call.prim).result;
    if (result === "v128") {
      throw new Error("Numeric builtin cannot produce F32x4 values");
    }
    return { tag: "int", type: result };
  }

  if (expr.func.name === "@len" && expr.args.length === 1) {
    return { tag: "int", type: "i32" };
  }

  if (expr.func.name === "@type_of" && expr.args.length === 1) {
    return { tag: "type" };
  }

  if (expr.func.name === "@Bytes.generate" && expr.args.length === 2) {
    return { tag: "text", encoding: "bytes" };
  }

  if (expr.func.name === "@Utf8.encode" && expr.args.length === 1) {
    return { tag: "text", encoding: "bytes" };
  }

  if (
    (expr.func.name === "@Utf8.decode" || expr.func.name === "@format_i32" ||
      expr.func.name === "@format_i64") && expr.args.length === 1
  ) {
    return { tag: "text" };
  }

  if (expr.func.name === "@format_f32" && expr.args.length === 2) {
    return { tag: "text" };
  }

  if (expr.func.name === "@slice" && expr.args.length === 3) {
    const value = expr.args[0];

    if (!value) {
      throw new Error("Missing slice value argument");
    }

    const value_type = infer_builtin_text_arg_type(value, env);

    if (value_type) {
      return value_type;
    }

    return { tag: "text" };
  }

  if (
    expr.func.name === "@append" && expr.args.length === 2 &&
    !lookup(env, expr.func.name)
  ) {
    const left = expr.args[0];
    const right = expr.args[1];

    if (!left || !right) {
      throw new Error("Missing append argument");
    }

    const left_type = infer_builtin_text_arg_type(left, env);
    const right_type = infer_builtin_text_arg_type(right, env);

    if (
      left_type && right_type &&
      left_type.encoding === right_type.encoding
    ) {
      return left_type;
    }

    return { tag: "text" };
  }

  return undefined;
}

function infer_builtin_text_arg_type(
  expr: FrontExpr,
  env: Env,
): Extract<FrontType, { tag: "text" }> | undefined {
  if (expr.tag === "text") {
    return { tag: "text", encoding: expr.encoding };
  }

  if (expr.tag !== "var" && expr.tag !== "linear") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || binding.type.tag !== "text") {
    return undefined;
  }

  return binding.type;
}

function infer_prim_operand_type(
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): ValType | undefined {
  const type = infer_expr(expr, env, hooks);

  if (type.tag === "int") {
    return type.type;
  }

  return undefined;
}
