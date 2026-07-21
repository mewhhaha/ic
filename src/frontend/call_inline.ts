import { expect } from "../expect.ts";
import type {
  Env,
  FrontExpr,
  Param,
  ResolvedCallTarget,
  ResolvedFrontExpr,
  Stmt,
} from "./ast.ts";
import { capture_const_ref, capture_expr } from "./capture.ts";
import { resolve_const_call_target } from "./call_const.ts";
import { parameter_arguments } from "./call_args.ts";
import { is_deferred_frontend_value } from "./call_deferred.ts";
import {
  resolve_call_target_with_env,
  resolve_dynamic_function_if_target,
} from "./call_resolve.ts";
import { should_specialize_app } from "./call_specialize_decision.ts";
import type { CallSpecializeHooks } from "./call_specialize_types.ts";
import { validate_const_expr } from "./constness.ts";
import { unwrap_ownership_wrapper_context_expr } from "./ownership.ts";
import { substitute_front_expr } from "./substitute.ts";

export function inline_deferred_const_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  const inlined = inline_const_call_expr(expr, env, hooks);

  if (!inlined) {
    return undefined;
  }

  const dynamic_union = hooks.resolve_dynamic_union_if_target(
    inlined.expr,
    inlined.env,
  );

  if (dynamic_union) {
    return dynamic_union;
  }

  if (is_deferred_frontend_value(inlined.expr, inlined.env, hooks)) {
    return inlined;
  }

  return undefined;
}

export function inline_specialized_call_expr(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  return inline_call_expr_with_target(expr, env, true, hooks);
}

export function inline_runtime_call_expr(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  return inline_call_expr_with_target(expr, env, false, hooks);
}

function inline_call_expr_with_target(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  require_specialization: boolean,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  const target = resolve_call_target_with_env(expr.func, env, hooks);

  if (target) {
    if (require_specialization) {
      if (!should_specialize_app(target.expr, expr.args, env, hooks)) {
        return undefined;
      }
    }

    return inline_resolved_call_target(target, expr.args, env, hooks);
  }

  const dynamic_target = resolve_dynamic_function_if_target(
    expr.func,
    env,
    hooks,
  );

  if (!dynamic_target) {
    return undefined;
  }

  const then_target = resolve_call_target_with_env(
    dynamic_target.expr.then_branch,
    dynamic_target.env,
    hooks,
  );
  const else_target = resolve_call_target_with_env(
    dynamic_target.expr.else_branch,
    dynamic_target.env,
    hooks,
  );

  if (!then_target || !else_target) {
    return undefined;
  }

  const then_body = inline_resolved_call_target(
    then_target,
    expr.args,
    env,
    hooks,
  );
  const else_body = inline_resolved_call_target(
    else_target,
    expr.args,
    env,
    hooks,
  );

  if (!then_body || !else_body) {
    return undefined;
  }

  return {
    expr: {
      tag: "if",
      cond: capture_expr(dynamic_target.expr.cond, dynamic_target.env),
      then_branch: capture_expr(then_body.expr, then_body.env),
      else_branch: capture_expr(else_body.expr, else_body.env),
    },
    env,
  };
}

function inline_resolved_call_target(
  target: ResolvedCallTarget,
  args: FrontExpr[],
  env: Env,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  const bindings = parameter_arguments(target.expr.params, args);

  if (bindings === undefined) {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();
  const prefix: Stmt[] = [];

  for (const { param, arg } of bindings) {
    if (param.is_linear) {
      return undefined;
    }

    if (should_bind_inline_arg_with_annotation(param, arg, env, hooks)) {
      expect(param.annotation, "Missing inline parameter annotation");
      prefix.push({
        tag: "bind",
        kind: "let",
        name: param.name,
        is_linear: false,
        annotation: param.annotation,
        value: capture_expr(arg, env),
      });
      continue;
    }

    replacements.set(
      param.name,
      inline_call_arg_value(param, arg, env, hooks),
    );
  }

  const body = substitute_front_expr(target.expr.body, replacements);

  if (prefix.length > 0) {
    return {
      expr: {
        tag: "block",
        statements: [
          ...prefix,
          { tag: "expr", expr: body },
        ],
      },
      env: target.env,
    };
  }

  return {
    expr: body,
    env: target.env,
  };
}

function inline_const_call_expr(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ResolvedFrontExpr | undefined {
  const target = resolve_const_call_target(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  return inline_resolved_call_target(target, expr.args, env, hooks);
}

function inline_call_arg_value(
  param: Param,
  arg: FrontExpr,
  env: Env,
  hooks: CallSpecializeHooks,
): FrontExpr {
  if (param.is_const) {
    validate_const_expr(
      arg,
      env,
      new Set(),
      "Const parameter " + param.name + " requires compile-time argument",
    );
    const value = capture_const_ref(arg, env);

    if (param.annotation) {
      hooks.check_const_annotation(param.annotation, value, env);
    }

    return value;
  }

  let value = arg;

  if (param.annotation) {
    const annotation_type = hooks.resolve_annotation_type(
      param.annotation,
      env,
    );
    const arg_type = hooks.infer_expr(arg, env);

    if (arg_type.tag !== "unknown" || !annotation_type) {
      hooks.check_binding_annotation(param.annotation, value, env);
    }

    value = hooks.apply_annotation_context(param.annotation, value, env);
    value = unwrap_ownership_wrapper_context_expr(value);
  }

  return capture_expr(value, env);
}

function should_bind_inline_arg_with_annotation(
  param: Param,
  arg: FrontExpr,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  if (!param.annotation) {
    return false;
  }

  if (param.is_const) {
    return false;
  }

  const annotation_type = hooks.resolve_annotation_type(param.annotation, env);

  if (!annotation_type || annotation_type.tag !== "union_value") {
    return false;
  }

  const arg_type = hooks.infer_expr(arg, env);
  return arg_type.tag === "unknown";
}
