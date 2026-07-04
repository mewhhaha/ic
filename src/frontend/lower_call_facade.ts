import type { Ic as IcNode } from "../ic.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedCallTarget,
  ResolvedFrontExpr,
} from "./ast.ts";
import type { FrontendCallGraph } from "./lower_call_graph.ts";
import type { TypedFrontExpr } from "./typed_lower.ts";

export function create_frontend_call_facade(
  graph: () => FrontendCallGraph,
): FrontendCallGraph {
  function check_dynamic_function_if_args(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): TypedFrontExpr[] | undefined {
    return graph().check_dynamic_function_if_args(expr, env);
  }

  function eval_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
    allow_unmarked_params: boolean,
  ): FrontExpr | undefined {
    return graph().eval_const_call(expr, env, allow_unmarked_params);
  }

  function infer_call_union_result_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontType | undefined {
    return graph().infer_call_union_result_type(expr, env);
  }

  function infer_specialized_app_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontType | undefined {
    return graph().infer_specialized_app_type(expr, env);
  }

  function inline_deferred_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return graph().inline_deferred_const_call(expr, env);
  }

  function inline_runtime_call_expr(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return graph().inline_runtime_call_expr(expr, env);
  }

  function inline_specialized_call_expr(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return graph().inline_specialized_call_expr(expr, env);
  }

  function is_deferred_frontend_value(
    expr: FrontExpr,
    env: Env | undefined,
  ): boolean {
    return graph().is_deferred_frontend_value(expr, env);
  }

  function lower_specialized_app(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): IcNode | undefined {
    return graph().lower_specialized_app(expr, env);
  }

  function requires_specialized_call(
    expr: Extract<FrontExpr, { tag: "lam" }>,
    env: Env,
  ): boolean {
    return graph().requires_specialized_call(expr, env);
  }

  function resolve_call_target(
    expr: FrontExpr,
    env: Env,
  ): Extract<FrontExpr, { tag: "lam" }> | undefined {
    return graph().resolve_call_target(expr, env);
  }

  function resolve_call_target_with_env(
    expr: FrontExpr,
    env: Env,
  ): ResolvedCallTarget | undefined {
    return graph().resolve_call_target_with_env(expr, env);
  }

  function resolve_const_call_target(
    expr: FrontExpr,
    env: Env,
  ): ResolvedCallTarget | undefined {
    return graph().resolve_const_call_target(expr, env);
  }

  function resolve_deferred_frontend_value(
    expr: FrontExpr,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return graph().resolve_deferred_frontend_value(expr, env);
  }

  function resolve_deferred_text_value(
    expr: FrontExpr,
    env: Env,
  ): ResolvedFrontExpr | undefined {
    return graph().resolve_deferred_text_value(expr, env);
  }

  function should_specialize_app(
    target: Extract<FrontExpr, { tag: "lam" }>,
    args: FrontExpr[],
    env: Env,
  ): boolean {
    return graph().should_specialize_app(target, args, env);
  }

  function try_eval_all_const_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ): FrontExpr | undefined {
    return graph().try_eval_all_const_call(expr, env);
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
