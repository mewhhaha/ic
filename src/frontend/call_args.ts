import type { Env, FrontExpr, FrontType, Param } from "./ast.ts";
import { capture_const_ref } from "./capture.ts";
import {
  type CallDeferredHooks,
  resolve_deferred_frontend_value,
  resolve_deferred_text_value,
} from "./call_deferred.ts";
import { validate_const_expr } from "./constness.ts";
import { fresh, push_binding } from "./env.ts";
import { unwrap_ownership_wrapper_context_expr } from "./ownership.ts";
import { param_can_defer_visible_text } from "./visible_params.ts";

export type CallArgHooks = CallDeferredHooks & {
  apply_annotation_context: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => FrontExpr;
  check_binding_annotation: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => void;
  check_const_annotation: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => void;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export type RuntimeSpecializedArg = {
  value: FrontExpr;
  type: FrontType;
};

export function has_const_param(
  expr: Extract<FrontExpr, { tag: "lam" }>,
): boolean {
  for (const param of expr.params) {
    if (param.is_const) {
      return true;
    }
  }

  return false;
}

export function has_runtime_annotation_param(
  expr: Extract<FrontExpr, { tag: "lam" }>,
  env: Env,
  hooks: CallArgHooks,
): boolean {
  for (const param of expr.params) {
    if (!param.is_const && param.annotation) {
      const type = hooks.resolve_annotation_type(param.annotation, env);

      if (type) {
        if (type.tag === "union_value") {
          return true;
        }

        continue;
      }

      return true;
    }
  }

  return false;
}

export function push_const_specialized_arg(
  name: string,
  annotation: string | undefined,
  arg: FrontExpr,
  env: Env,
  call_env: Env,
  hooks: CallArgHooks,
): void {
  validate_const_arg(name, arg, env);
  const value = capture_const_ref(arg, env);

  if (annotation) {
    hooks.check_const_annotation(annotation, value, env);
  }

  push_binding(call_env, {
    name,
    ic_name: name,
    type: hooks.infer_expr(value, env),
    is_const: true,
    is_linear: false,
    value,
    value_env: undefined,
  });
}

export function push_runtime_specialized_arg(
  target: Extract<FrontExpr, { tag: "lam" }>,
  param: Param,
  arg: FrontExpr,
  env: Env,
  call_env: Env,
  runtime_args: RuntimeSpecializedArg[],
  runtime_names: string[],
  hooks: CallArgHooks,
): void {
  let arg_value = arg;
  let arg_type = hooks.infer_expr(arg, env);

  if (param.annotation) {
    const annotation_type = hooks.resolve_annotation_type(
      param.annotation,
      env,
    );

    if (arg_type.tag !== "unknown") {
      hooks.check_binding_annotation(param.annotation, arg, env);
    }

    if (annotation_type) {
      arg_type = annotation_type;
    }

    arg_value = hooks.apply_annotation_context(param.annotation, arg, env);
    arg_value = unwrap_ownership_wrapper_context_expr(arg_value);
  }

  let deferred = resolve_deferred_frontend_value(arg_value, env, hooks);

  if (!deferred && param_can_defer_visible_text(target, param)) {
    deferred = resolve_deferred_text_value(arg_value, env, hooks);
  }

  if (deferred) {
    push_binding(call_env, {
      name: param.name,
      ic_name: param.name,
      type: arg_type,
      is_const: false,
      is_linear: param.is_linear,
      value: deferred.expr,
      value_env: deferred.env,
    });
    return;
  }

  const ic_name = fresh(call_env, param.name);
  runtime_args.push({ value: arg_value, type: arg_type });
  runtime_names.push(ic_name);
  push_binding(call_env, {
    name: param.name,
    ic_name,
    type: arg_type,
    is_const: false,
    is_linear: param.is_linear,
    value: undefined,
    value_env: undefined,
  });
}

function validate_const_arg(
  name: string,
  arg: FrontExpr,
  env: Env,
): void {
  validate_const_expr(
    arg,
    env,
    new Set(),
    "Const parameter " + name + " requires compile-time argument",
  );
}
