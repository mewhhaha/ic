import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import {
  inline_runtime_call_expr as inline_runtime_call_expr_with_hooks,
} from "./call_inline.ts";
import { contains_unresolved_linear_effect } from "./call_linear_effect.ts";
import { is_deferred_frontend_value } from "./call_deferred.ts";
import {
  parameter_arguments,
  push_const_specialized_arg,
  push_runtime_specialized_arg,
  type RuntimeSpecializedArg,
} from "./call_args.ts";
import { resolve_call_target_with_env } from "./call_resolve.ts";
import { resolve_dynamic_function_if_target } from "./call_resolve.ts";
import { should_specialize_app } from "./call_specialize_decision.ts";
import type { CallSpecializeHooks } from "./call_specialize_types.ts";
import { structured_core_route } from "./diagnostic.ts";
import { clone_env } from "./env.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { linear_param_names, validate_linear_lam } from "./linear.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type { CallSpecializeHooks } from "./call_specialize_types.ts";
export { check_dynamic_function_if_args } from "./call_dynamic_args.ts";
export {
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
} from "./call_inline.ts";
export {
  resolve_call_target,
  resolve_call_target_with_env,
} from "./call_resolve.ts";
export {
  requires_specialized_call,
  should_specialize_app,
} from "./call_specialize_decision.ts";
export { infer_call_union_result_type } from "./call_union_result.ts";
export {
  is_deferred_frontend_value,
  resolve_deferred_frontend_value,
  resolve_deferred_text_value,
} from "./call_deferred.ts";
export {
  can_eval_const_call,
  eval_const_call,
  resolve_const_call_target,
  try_eval_all_const_call,
} from "./call_const.ts";

export function lower_specialized_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): IcNode | undefined {
  const target = resolve_call_target_with_env(expr.func, env, hooks);

  if (!target) {
    return lower_deferred_dynamic_function_if_app(expr, env, hooks);
  }

  if (!should_specialize_app(target.expr, expr.args, env, hooks)) {
    const dynamic = lower_deferred_dynamic_function_if_app(expr, env, hooks);

    if (dynamic) {
      return dynamic;
    }

    return undefined;
  }

  const bindings = parameter_arguments(target.expr.params, expr.args);

  if (bindings === undefined) {
    throw new Error(
      "Specialized call expected " +
        target.expr.params.length.toString() +
        " arguments, got " +
        expr.args.length.toString(),
    );
  }

  const linear_names = linear_param_names(target.expr);

  if (linear_names.size > 0) {
    validate_linear_lam(target.expr);
  }

  const call_env = clone_env(target.env);
  const runtime_args: RuntimeSpecializedArg[] = [];
  const runtime_names: string[] = [];

  for (const { param, arg } of bindings) {
    if (param.is_const) {
      push_const_specialized_arg(
        param.name,
        param.annotation,
        arg,
        env,
        call_env,
        hooks,
      );
    } else {
      push_runtime_specialized_arg(
        target.expr,
        param,
        arg,
        env,
        call_env,
        runtime_args,
        runtime_names,
        hooks,
      );
    }
  }

  if (linear_names.size > 0) {
    if (
      contains_unresolved_linear_effect(
        target.expr.body,
        linear_names,
        call_env,
        hooks,
      )
    ) {
      throw new Error(
        "Cannot lower linear function to Ic frontend yet" +
          structured_core_route,
      );
    }
  }

  let result = hooks.lower_expr(target.expr.body, call_env);

  for (let index = runtime_names.length - 1; index >= 0; index -= 1) {
    const name = runtime_names[index];
    expect(name, "Missing runtime parameter " + index);
    result = lower_lambda_binding(name, result);
  }

  for (const arg of runtime_args) {
    result = {
      tag: "app",
      func: result,
      arg: lower_expr_as_front_type(arg.value, arg.type, env, hooks),
    };
  }

  return result;
}

function lower_deferred_dynamic_function_if_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): IcNode | undefined {
  const dynamic_target = resolve_dynamic_function_if_target(
    expr.func,
    env,
    hooks,
  );

  if (!dynamic_target) {
    return undefined;
  }

  if (
    !is_deferred_frontend_value(
      dynamic_target.expr,
      dynamic_target.env,
      hooks,
    )
  ) {
    return undefined;
  }

  const inlined_dynamic = inline_runtime_call_expr_with_hooks(
    expr,
    env,
    hooks,
  );

  if (!inlined_dynamic) {
    return undefined;
  }

  return hooks.lower_expr(inlined_dynamic.expr, inlined_dynamic.env);
}

export function infer_specialized_app_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ReturnType<CallSpecializeHooks["infer_expr"]> | undefined {
  const target = resolve_call_target_with_env(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  const bindings = parameter_arguments(target.expr.params, expr.args);

  if (bindings === undefined) {
    return undefined;
  }

  const call_env = clone_env(target.env);
  const runtime_args: RuntimeSpecializedArg[] = [];
  const runtime_names: string[] = [];

  for (const { param, arg } of bindings) {
    if (param.is_linear) {
      return undefined;
    }

    if (param.is_const) {
      push_const_specialized_arg(
        param.name,
        param.annotation,
        arg,
        env,
        call_env,
        hooks,
      );
    } else {
      push_runtime_specialized_arg(
        target.expr,
        param,
        arg,
        env,
        call_env,
        runtime_args,
        runtime_names,
        hooks,
      );
    }
  }

  return hooks.infer_expr(target.expr.body, call_env);
}
