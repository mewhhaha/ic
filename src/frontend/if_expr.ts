import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { lower_dynamic_function_if } from "./if_function.ts";
import {
  can_implicit_fallback_type,
  implicit_fallback_expr,
} from "./implicit_fallback.ts";
import { select_prim_for_branches } from "./numeric.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import { common_front_type, front_type_name } from "./types.ts";

export type IfExprHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_dynamic_struct_if: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_dynamic_union_if: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export function lower_if_expr(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: IfExprHooks,
): IcNode {
  check_if_condition(expr.cond, env, hooks);
  const cond = Ic.reduce(
    hooks.lower_expr(unwrap_ownership_wrapper_expr(expr.cond), env),
  );
  let target_expr = expr;

  if (cond.tag === "num") {
    if (cond.type !== "i32") {
      throw new Error("If condition expects i32, got " + cond.type);
    }

    const value = cond.value;
    expect(typeof value === "number", "Expected i32 if condition");

    if (value !== 0) {
      return hooks.lower_expr(expr.then_branch, env);
    }

    if (expr.implicit_else) {
      const then_type = hooks.infer_expr(expr.then_branch, env);
      const fallback = implicit_fallback_expr(then_type, env, hooks);

      if (!fallback) {
        throw_no_else_implicit_fallback("if", then_type);
      }

      return hooks.lower_expr(fallback, env);
    }

    return hooks.lower_expr(expr.else_branch, env);
  }

  const then_type = hooks.infer_expr(expr.then_branch, env);
  let else_type = hooks.infer_expr(expr.else_branch, env);

  if (expr.implicit_else) {
    const fallback = implicit_fallback_expr(then_type, env, hooks);

    if (fallback) {
      target_expr = {
        ...expr,
        else_branch: fallback,
        implicit_else: undefined,
      };
      else_type = hooks.infer_expr(fallback, env);
    } else {
      throw_no_else_implicit_fallback("if", then_type);
    }
  }

  const branch_type = common_if_type(expr.implicit_else, then_type, else_type);

  if (!branch_type) {
    if (expr.implicit_else) {
      throw_no_else_implicit_fallback("if", then_type);
    }

    if (then_type.tag === "fn" && else_type.tag === "fn") {
      const fn_if = lower_dynamic_function_if(expr, cond, env, hooks);

      if (fn_if) {
        return fn_if;
      }
    }

    const union_if = hooks.lower_dynamic_union_if(expr, env);

    if (union_if) {
      return union_if;
    }

    throw new Error("If branches must have the same type");
  }

  const struct_if = hooks.lower_dynamic_struct_if(target_expr, env);

  if (struct_if) {
    return struct_if;
  }

  const union_if = hooks.lower_dynamic_union_if(target_expr, env);

  if (union_if) {
    return union_if;
  }

  if (branch_type.tag === "fn") {
    const fn_if = lower_dynamic_function_if(expr, cond, env, hooks);

    if (fn_if) {
      return fn_if;
    }
  }

  if (branch_type.tag === "text") {
    return {
      tag: "prim",
      prim: "i32.select",
      args: [
        hooks.lower_expr(target_expr.then_branch, env),
        lower_if_else_branch(target_expr, branch_type, env, hooks),
        cond,
      ],
    };
  }

  if (branch_type.tag !== "bool" && branch_type.tag !== "int") {
    throw new Error(
      "Cannot lower dynamic if with " + front_type_name(branch_type) +
        " branches to Ic frontend",
    );
  }

  let select_prim: Prim = "i32.select";

  if (!expr.implicit_else) {
    select_prim = select_prim_for_branches(
      expr.then_branch,
      expr.else_branch,
    );
  }

  if (branch_type.tag === "int" && branch_type.type === "i64") {
    select_prim = "i64.select";
  }

  if (branch_type.tag === "int" && branch_type.type === "f32") {
    select_prim = "f32.select";
  }

  if (branch_type.tag === "int" && branch_type.type === "f64") {
    select_prim = "f64.select";
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      hooks.lower_expr(target_expr.then_branch, env),
      lower_if_else_branch(target_expr, branch_type, env, hooks),
      cond,
    ],
  };
}

function common_if_type(
  implicit_else: boolean | undefined,
  then_type: FrontType,
  else_type: FrontType,
): FrontType | undefined {
  const branch_type = common_front_type(then_type, else_type);

  if (branch_type) {
    return branch_type;
  }

  if (
    implicit_else &&
    can_implicit_fallback_type(then_type)
  ) {
    return then_type;
  }

  return undefined;
}

function lower_if_else_branch(
  expr: Extract<FrontExpr, { tag: "if" }>,
  branch_type: FrontType,
  env: Env,
  hooks: IfExprHooks,
): IcNode {
  if (expr.implicit_else) {
    const fallback = implicit_fallback_expr(branch_type, env, hooks);

    if (!fallback) {
      throw_no_else_implicit_fallback("if", branch_type);
    }

    return hooks.lower_expr(fallback, env);
  }

  return hooks.lower_expr(expr.else_branch, env);
}

function throw_no_else_implicit_fallback(
  label: string,
  type: FrontType,
): never {
  throw new Error(
    "No-else " + label +
      " implicit fallback supports Bool, Int, I64, Text, struct, or union, got " +
      front_type_name(type),
  );
}

function check_if_condition(
  expr: FrontExpr,
  env: Env,
  hooks: Pick<IfExprHooks, "infer_expr">,
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
