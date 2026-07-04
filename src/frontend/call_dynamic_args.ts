import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType, ResolvedCallTarget } from "./ast.ts";
import {
  resolve_call_target_with_env,
  resolve_dynamic_function_if_target,
} from "./call_resolve.ts";
import type { CallSpecializeHooks } from "./call_specialize_types.ts";
import { function_if_param_types } from "./function_if.ts";
import { unwrap_ownership_wrapper_context_expr } from "./ownership.ts";
import type { TypedFrontExpr } from "./typed_lower.ts";

export function check_dynamic_function_if_args(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): TypedFrontExpr[] | undefined {
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

  check_call_target_arg_annotations(then_target, expr.args, env, hooks);
  check_call_target_arg_annotations(else_target, expr.args, env, hooks);

  const param_types = function_if_param_types(
    then_target.expr.params,
    then_target.env,
    else_target.expr.params,
    else_target.env,
    hooks,
  );

  if (!param_types) {
    return undefined;
  }

  return normalize_dynamic_function_if_args(expr.args, param_types);
}

function check_call_target_arg_annotations(
  target: ResolvedCallTarget,
  args: FrontExpr[],
  env: Env,
  hooks: CallSpecializeHooks,
): void {
  for (let index = 0; index < target.expr.params.length; index += 1) {
    const param = target.expr.params[index];
    const arg = args[index];
    expect(param, "Missing annotated call parameter " + index);

    if (!arg) {
      return;
    }

    if (!param.annotation) {
      continue;
    }

    const arg_type = hooks.infer_expr(arg, env);

    if (arg_type.tag === "unknown") {
      continue;
    }

    hooks.check_binding_annotation(param.annotation, arg, env);
  }
}

function normalize_dynamic_function_if_args(
  args: FrontExpr[],
  param_types: FrontType[],
): TypedFrontExpr[] {
  const normalized: TypedFrontExpr[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const param_type = param_types[index];
    expect(arg, "Missing dynamic function-if argument " + index.toString());
    expect(
      param_type,
      "Missing dynamic function-if parameter type " + index.toString(),
    );

    if (can_erase_wrapper_for_param_type(param_type)) {
      normalized.push({
        value: unwrap_ownership_wrapper_context_expr(arg),
        type: param_type,
      });
    } else {
      normalized.push({ value: arg, type: param_type });
    }
  }

  return normalized;
}

function can_erase_wrapper_for_param_type(type: FrontType): boolean {
  if (type.tag === "unknown" || type.tag === "type") {
    return false;
  }

  return true;
}
