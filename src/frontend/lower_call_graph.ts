import type { Ic as IcNode } from "../ic.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedCallTarget,
  ResolvedFrontExpr,
} from "./ast.ts";
import type { TypedFrontExpr } from "./typed_lower.ts";
import {
  type CallSpecializeHooks,
  check_dynamic_function_if_args as check_dynamic_function_if_args_with_hooks,
  eval_const_call as eval_const_call_with_hooks,
  infer_call_union_result_type as infer_call_union_result_type_with_hooks,
  infer_specialized_app_type as infer_specialized_app_type_with_hooks,
  inline_deferred_const_call as inline_deferred_const_call_with_hooks,
  inline_runtime_call_expr as inline_runtime_call_expr_with_hooks,
  inline_specialized_call_expr as inline_specialized_call_expr_with_hooks,
  is_deferred_frontend_value as is_deferred_frontend_value_with_hooks,
  lower_specialized_app as lower_specialized_app_with_hooks,
  requires_specialized_call as requires_specialized_call_with_hooks,
  resolve_call_target as resolve_call_target_with_hooks,
  resolve_call_target_with_env as resolve_call_target_with_env_with_hooks,
  resolve_const_call_target as resolve_const_call_target_with_hooks,
  resolve_deferred_frontend_value as resolve_deferred_frontend_value_with_hooks,
  resolve_deferred_text_value as resolve_deferred_text_value_with_hooks,
  should_specialize_app as should_specialize_app_with_hooks,
  try_eval_all_const_call as try_eval_all_const_call_with_hooks,
} from "./call_specialize.ts";

export type FrontendCallGraph = {
  check_dynamic_function_if_args: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => TypedFrontExpr[] | undefined;
  eval_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
    allow_unmarked_params: boolean,
  ) => FrontExpr | undefined;
  infer_call_union_result_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  infer_specialized_app_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  inline_deferred_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_runtime_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_specialized_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  is_deferred_frontend_value: (
    expr: FrontExpr,
    env: Env | undefined,
  ) => boolean;
  lower_specialized_app: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => IcNode | undefined;
  requires_specialized_call: (
    expr: Extract<FrontExpr, { tag: "lam" }>,
    env: Env,
  ) => boolean;
  resolve_call_target: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "lam" }> | undefined;
  resolve_call_target_with_env: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedCallTarget | undefined;
  resolve_const_call_target: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedCallTarget | undefined;
  resolve_deferred_frontend_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_deferred_text_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  should_specialize_app: (
    target: Extract<FrontExpr, { tag: "lam" }>,
    args: FrontExpr[],
    env: Env,
  ) => boolean;
  try_eval_all_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
};

export function create_frontend_call_graph(
  hooks: CallSpecializeHooks,
): FrontendCallGraph {
  function requires_specialized_call(
    expr: Extract<FrontExpr, { tag: "lam" }>,
    env: Env,
  ): boolean {
    return requires_specialized_call_with_hooks(expr, env, hooks);
  }

  function lower_specialized_app(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): IcNode | undefined {
    return lower_specialized_app_with_hooks(expr, env, hooks);
  }

  function should_specialize_app(
    target: Extract<FrontExpr, { tag: "lam" }>,
    args: FrontExpr[],
    env: Env,
  ): boolean {
    return should_specialize_app_with_hooks(target, args, env, hooks);
  }

  function infer_call_union_result_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontType | undefined {
    return infer_call_union_result_type_with_hooks(expr, env, hooks);
  }

  function infer_specialized_app_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontType | undefined {
    return infer_specialized_app_type_with_hooks(expr, env, hooks);
  }

  function resolve_deferred_frontend_value(
    expr: FrontExpr,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return resolve_deferred_frontend_value_with_hooks(expr, env, hooks);
  }

  function resolve_deferred_text_value(
    expr: FrontExpr,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return resolve_deferred_text_value_with_hooks(expr, env, hooks);
  }

  function resolve_call_target(
    expr: FrontExpr,
    env: Env,
  ): Extract<FrontExpr, { tag: "lam" }> | undefined {
    return resolve_call_target_with_hooks(expr, env, hooks);
  }

  function resolve_call_target_with_env(
    expr: FrontExpr,
    env: Env,
  ): ResolvedCallTarget | undefined {
    return resolve_call_target_with_env_with_hooks(expr, env, hooks);
  }

  function try_eval_all_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontExpr | undefined {
    return try_eval_all_const_call_with_hooks(expr, env, hooks);
  }

  function eval_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
    allow_unmarked_params: boolean,
  ): FrontExpr | undefined {
    return eval_const_call_with_hooks(expr, env, allow_unmarked_params, hooks);
  }

  function resolve_const_call_target(
    expr: FrontExpr,
    env: Env,
  ): ResolvedCallTarget | undefined {
    return resolve_const_call_target_with_hooks(expr, env, hooks);
  }

  function check_dynamic_function_if_args(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): TypedFrontExpr[] | undefined {
    return check_dynamic_function_if_args_with_hooks(expr, env, hooks);
  }

  function is_deferred_frontend_value(
    expr: FrontExpr,
    env: Env | undefined,
  ): boolean {
    return is_deferred_frontend_value_with_hooks(expr, env, hooks);
  }

  function inline_deferred_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return inline_deferred_const_call_with_hooks(expr, env, hooks);
  }

  function inline_specialized_call_expr(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return inline_specialized_call_expr_with_hooks(expr, env, hooks);
  }

  function inline_runtime_call_expr(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return inline_runtime_call_expr_with_hooks(expr, env, hooks);
  }

  return {
    check_dynamic_function_if_args,
    eval_const_call,
    infer_call_union_result_type,
    infer_specialized_app_type,
    inline_deferred_const_call,
    inline_runtime_call_expr,
    inline_specialized_call_expr,
    is_deferred_frontend_value,
    lower_specialized_app,
    requires_specialized_call,
    resolve_call_target,
    resolve_call_target_with_env,
    resolve_const_call_target,
    resolve_deferred_frontend_value,
    resolve_deferred_text_value,
    should_specialize_app,
    try_eval_all_const_call,
  };
}
