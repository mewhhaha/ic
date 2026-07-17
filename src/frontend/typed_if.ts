import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { clone_env, fresh, push_binding } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import { front_type_name } from "./types.ts";
import {
  typed_if_else_branch,
  typed_if_let_else_branch,
} from "./typed_if_fallback.ts";
import {
  lower_struct_if_as_front_type,
  lower_union_if_as_front_type,
} from "./typed_if_values.ts";
import type {
  FrontTypedLowerHooks,
  LowerExprAsFrontType,
} from "./typed_hooks.ts";
import { type_for_type_name } from "./typed_type.ts";

export function lower_if_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  if (type.tag !== "bool" && type.tag !== "int" && type.tag !== "text") {
    if (type.tag === "struct" || type.tag === "union_value") {
      const direct = try_lower_dynamic_if_directly(expr, env, hooks);

      if (direct) {
        return direct;
      }
    } else {
      return hooks.lower_expr(expr, env);
    }
  }

  if (
    type.tag !== "bool" && type.tag !== "int" && type.tag !== "text" &&
    type.tag !== "struct" && type.tag !== "union_value"
  ) {
    return hooks.lower_expr(expr, env);
  }

  check_typed_if_condition(expr.cond, env, hooks);
  const cond = Ic.reduce(
    hooks.lower_expr(unwrap_ownership_wrapper_expr(expr.cond), env),
  );

  if (cond.tag === "num") {
    if (cond.type !== "i32") {
      throw new Error("If condition expects i32, got " + cond.type);
    }

    const value = cond.value;
    expect(typeof value === "number", "Expected i32 if condition");

    if (value !== 0) {
      return lower_as(expr.then_branch, type, env, hooks);
    }

    return lower_as(
      typed_if_else_branch(expr, type, env, hooks),
      type,
      env,
      hooks,
    );
  }

  if (type.tag === "struct") {
    if (!type.field_types) {
      return hooks.lower_expr(expr, env);
    }

    return lower_struct_if_as_front_type(
      expr,
      type.field_types,
      cond,
      env,
      hooks,
      lower_as,
    );
  }

  if (type.tag === "union_value") {
    return lower_union_if_as_front_type(
      expr,
      type.cases,
      cond,
      env,
      hooks,
      lower_as,
    );
  }

  let select_prim: Prim = "i32.select";

  if (type.tag === "int" && type.type === "i64") {
    select_prim = "i64.select";
  }

  if (type.tag === "int" && type.type === "f32") {
    select_prim = "f32.select";
  }

  if (type.tag === "int" && type.type === "f64") {
    select_prim = "f64.select";
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      lower_as(expr.then_branch, type, env, hooks),
      lower_as(
        typed_if_else_branch(expr, type, env, hooks),
        type,
        env,
        hooks,
      ),
      cond,
    ],
  };
}

export function lower_if_let_as_front_type(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const direct = try_lower_if_let_directly(expr, env, hooks);

  if (direct) {
    return direct;
  }

  const target_type = hooks.infer_expr(expr.target, env);

  if (target_type.tag !== "union_value") {
    return hooks.lower_expr(expr, env);
  }

  const matched = lookup_type_field(target_type.cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  if (expr.value_name && matched.type_name === "Unit") {
    throw new Error("Union case has no payload: " + expr.case_name);
  }

  let result = hooks.lower_expr(expr.target, env);

  for (const union_case of target_type.cases) {
    result = {
      tag: "app",
      func: result,
      arg: lower_if_let_handler_as_front_type(
        expr,
        union_case,
        type,
        env,
        hooks,
        lower_as,
      ),
    };
  }

  return result;
}

function try_lower_if_let_directly(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode | undefined {
  try {
    return hooks.lower_expr(expr, env);
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message.startsWith(
          "Cannot lower borrow view result through pure Ic",
        )
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower freeze result through pure Ic")
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower scratch result through pure Ic")
      ) {
        return undefined;
      }

      if (
        err.message.startsWith(
          "No-else if let implicit fallback supports ",
        )
      ) {
        return undefined;
      }

      if (
        err.message.startsWith(
          "Cannot lower dynamic if let branch result type ",
        )
      ) {
        return undefined;
      }
    }

    throw err;
  }
}

function lower_if_let_handler_as_front_type(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  union_case: TypeField,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
  lower_as: LowerExprAsFrontType,
): IcNode {
  const handler_env = clone_env(env);
  const payload_name = fresh(handler_env, "payload_" + union_case.name);
  let body_expr: FrontExpr;

  if (union_case.name === expr.case_name) {
    if (expr.value_name) {
      push_binding(handler_env, {
        name: expr.value_name,
        ic_name: payload_name,
        type: type_for_type_name(union_case.type_name, handler_env, hooks),
        is_const: false,
        is_linear: false,
        value: undefined,
        value_env: undefined,
      });
    }

    body_expr = expr.then_branch;
  } else {
    body_expr = typed_if_let_else_branch(expr, type, handler_env, hooks);
  }

  return lower_lambda_binding(
    payload_name,
    lower_as(body_expr, type, handler_env, hooks),
  );
}

function try_lower_dynamic_if_directly(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode | undefined {
  if (expr.implicit_else) {
    return undefined;
  }

  try {
    return hooks.lower_expr(expr, env);
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message ===
          "Cannot lower dynamic if with unknown branches to Ic frontend"
      ) {
        return undefined;
      }

      if (
        err.message ===
          "No-else if implicit fallback supports Bool, Int, I64, Text, struct, or union, got unknown"
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower dynamic if with ") &&
        err.message.endsWith(" branches to Ic frontend")
      ) {
        return undefined;
      }
    }

    throw err;
  }
}

function check_typed_if_condition(
  expr: FrontExpr,
  env: Env,
  hooks: FrontTypedLowerHooks,
): void {
  const type = hooks.infer_expr(expr, env);

  if (type.tag === "unknown") {
    return;
  }

  if (type.tag === "bool") {
    return;
  }

  if (type.tag === "int" && type.type === "i32") {
    return;
  }

  throw new Error(
    "If condition expects Bool or I32, got " + front_type_name(type),
  );
}
