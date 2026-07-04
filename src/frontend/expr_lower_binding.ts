import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Binding, Env, FrontExpr, FrontType } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import type { ExprLowerHooks, LowerExprFn } from "./expr_lower_types.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import {
  contains_reserved_linear_effect,
  linear_param_names,
  validate_linear_lam,
} from "./linear.ts";
import { expect_snake_case } from "./names.ts";
import { is_builtin_type_name } from "./types.ts";

export function lower_var_expr(
  expr: Extract<FrontExpr, { tag: "var" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const binding = lookup(env, expr.name);

  if (!binding) {
    if (is_builtin_type_name(expr.name)) {
      throw new Error(
        "Compile-time type name cannot be emitted as an Ic result: " +
          expr.name,
      );
    }

    expect_snake_case(expr.name, "Free runtime name");
    return { tag: "var", name: expr.name };
  }

  return lower_binding_expr(expr.name, binding, env, hooks, lower_expr);
}

export function lower_lam_expr(
  expr: Extract<FrontExpr, { tag: "lam" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const linear_names = linear_param_names(expr);

  if (linear_names.size > 0) {
    validate_linear_lam(expr);

    if (contains_reserved_linear_effect(expr.body, linear_names)) {
      throw new Error(
        "Cannot lower linear function to Ic frontend yet" +
          structured_core_route,
      );
    }
  }

  const body_env = clone_env(env);

  for (const param of expr.params) {
    if (param.is_const) {
      throw new Error(
        "Cannot lower const parameter without specialization",
      );
    }

    let param_type: FrontType = { tag: "unknown" };

    if (param.annotation) {
      const annotation_type = hooks.resolve_annotation_type(
        param.annotation,
        env,
      );

      if (annotation_type) {
        param_type = annotation_type;
      }
    }

    const ic_name = fresh(body_env, param.name);
    push_binding(body_env, {
      name: param.name,
      ic_name,
      type: param_type,
      is_const: false,
      is_linear: param.is_linear,
      value: undefined,
      value_env: undefined,
    });
  }

  let body = lower_expr(expr.body, body_env, hooks);

  for (let index = expr.params.length - 1; index >= 0; index -= 1) {
    const param = expr.params[index];
    expect(param, "Missing parameter " + index);
    const binding = lookup(body_env, param.name);
    expect(binding, "Missing parameter binding: " + param.name);
    body = lower_lambda_binding(binding.ic_name, body);
  }

  return body;
}

export function lower_linear_expr(
  expr: Extract<FrontExpr, { tag: "linear" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const binding = lookup(env, expr.name);

  if (!binding) {
    throw new Error("Unbound linear value: " + expr.name);
  }

  if (binding.is_const) {
    expect(binding.value, "Missing linear const value: " + expr.name);
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return lower_expr(binding.value, value_env, hooks);
  }

  return { tag: "var", name: binding.ic_name };
}

function lower_binding_expr(
  name: string,
  binding: Binding,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  if (binding.is_deferred) {
    expect(binding.value, "Missing deferred value: " + name);
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return lower_expr(binding.value, value_env, hooks);
  }

  if (binding.is_const) {
    expect(binding.value, "Missing const value: " + name);
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return lower_expr(binding.value, value_env, hooks);
  }

  if (binding.value && binding.value.tag === "lam") {
    if (hooks.requires_specialized_call(binding.value, env)) {
      if (linear_param_names(binding.value).size > 0) {
        validate_linear_lam(binding.value);
        throw new Error(
          "Cannot lower linear function to Ic frontend yet" +
            structured_core_route,
        );
      }

      throw new Error(
        "Cannot lower specialized function as runtime value without call-site specialization: " +
          name,
      );
    }
  }

  if (binding.value && binding.value.tag === "rec") {
    throw new Error(
      "Cannot lower rec function value to Ic frontend yet" +
        structured_core_route,
    );
  }

  if (binding.value && binding.value.tag === "struct_value") {
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return hooks.lower_struct_value(binding.value, value_env);
  }

  if (binding.value && binding.value.tag === "union_case") {
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return hooks.lower_union_case_value(binding.value, value_env);
  }

  if (
    binding.value && binding.value.tag === "if" &&
    binding.type.tag === "union_value"
  ) {
    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    if (!hooks.can_lower_dynamic_union_if_as_value(binding.value, value_env)) {
      const union_value = hooks.lower_dynamic_union_if(
        binding.value,
        value_env,
      );

      if (union_value) {
        return union_value;
      }

      throw new Error(
        "Cannot lower dynamic union-if binding to Ic frontend" +
          structured_core_route,
      );
    }
  }

  return { tag: "var", name: binding.ic_name };
}
