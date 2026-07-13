import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { clone_env } from "./env.ts";
import {
  bind_function_if_params,
  function_if_param_types,
  resolve_direct_lambda,
} from "./function_if.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import {
  contains_reserved_linear_effect,
  linear_param_names,
  validate_linear_lam,
} from "./linear.ts";
import { common_front_type } from "./types.ts";

export type DynamicFunctionIfHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export function lower_dynamic_function_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  cond: IcNode,
  env: Env,
  hooks: DynamicFunctionIfHooks,
): IcNode | undefined {
  const then_lam = resolve_direct_lambda(expr.then_branch, env);
  const else_lam = resolve_direct_lambda(expr.else_branch, env);

  if (!then_lam || !else_lam) {
    return undefined;
  }

  const param_types = function_if_param_types(
    then_lam.expr.params,
    then_lam.env,
    else_lam.expr.params,
    else_lam.env,
    hooks,
  );

  if (!param_types) {
    throw new Error(
      "Dynamic function branches must have compatible parameters",
    );
  }

  validate_linear_function_if_branch(then_lam.expr);
  validate_linear_function_if_branch(else_lam.expr);

  const then_env = clone_env(then_lam.env);
  const else_env = clone_env(else_lam.env);
  const names = bind_function_if_params(
    then_lam.expr.params,
    then_env,
    else_lam.expr.params,
    else_env,
    param_types,
  );

  if (!names) {
    return undefined;
  }

  const then_type = hooks.infer_expr(then_lam.expr.body, then_env);
  const else_type = hooks.infer_expr(else_lam.expr.body, else_env);
  const branch_if: FrontExpr = {
    tag: "if",
    cond: { tag: "captured", expr: expr.cond, env },
    then_branch: {
      tag: "captured",
      expr: then_lam.expr.body,
      env: then_env,
    },
    else_branch: {
      tag: "captured",
      expr: else_lam.expr.body,
      env: else_env,
    },
  };
  let result_type = common_front_type(then_type, else_type);

  if (!result_type) {
    const branch_if_type = hooks.infer_expr(branch_if, env);

    if (branch_if_type.tag !== "union_value") {
      return undefined;
    }

    result_type = branch_if_type;
  }

  let body: IcNode | undefined;

  if (result_type.tag === "text") {
    body = {
      tag: "prim",
      prim: "i32.select",
      args: [
        hooks.lower_expr(then_lam.expr.body, then_env),
        hooks.lower_expr(else_lam.expr.body, else_env),
        cond,
      ],
    };
  } else if (result_type.tag === "bool" || result_type.tag === "int") {
    let select_prim: Prim = "i32.select";

    if (result_type.tag === "int" && result_type.type === "i64") {
      select_prim = "i64.select";
    }

    body = {
      tag: "prim",
      prim: select_prim,
      args: [
        hooks.lower_expr(then_lam.expr.body, then_env),
        hooks.lower_expr(else_lam.expr.body, else_env),
        cond,
      ],
    };
  } else if (
    result_type.tag === "struct" || result_type.tag === "union" ||
    result_type.tag === "union_value"
  ) {
    body = hooks.lower_expr(branch_if, env);
  }

  if (!body) {
    return undefined;
  }

  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    expect(name, "Missing function-if parameter " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function validate_linear_function_if_branch(
  expr: Extract<FrontExpr, { tag: "lam" }>,
): void {
  const linear_names = linear_param_names(expr);

  if (linear_names.size === 0) {
    return;
  }

  validate_linear_lam(expr);

  if (contains_reserved_linear_effect(expr.body, linear_names)) {
    throw new Error(
      "Cannot lower linear function to Ic frontend yet" +
        structured_core_route,
    );
  }
}
