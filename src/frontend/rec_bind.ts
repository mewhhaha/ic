import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { unwrap_ownership_wrapper_value } from "./ownership.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";

export type StaticRecTarget = {
  expr: Extract<FrontExpr, { tag: "rec" }>;
  env: Env;
};

export function resolve_rec_target(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
): StaticRecTarget | undefined {
  if (expr.tag === "rec") {
    return { expr, env };
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = hooks.lookup(env, expr.name);

  if (!binding || !binding.value || binding.value.tag !== "rec") {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  return { expr: binding.value, env: value_env };
}

export function bind_rec_args(
  rec: Extract<FrontExpr, { tag: "rec" }>,
  args: FrontExpr[],
  env: Env,
  hooks: StaticRecHooks,
): void {
  for (let index = 0; index < rec.params.length; index += 1) {
    const param = rec.params[index];
    const arg = args[index];
    expect(param, "Missing rec parameter " + index);
    expect(arg, "Missing rec argument " + index);

    if (param.is_const) {
      hooks.validate_const_expr(
        arg,
        env,
        new Set(),
        "Const parameter " + param.name + " requires compile-time argument",
      );
      const value = hooks.capture_const_ref(arg, env);

      if (param.annotation) {
        hooks.check_const_annotation(param.annotation, value, env);
      }

      hooks.push_binding(env, {
        name: param.name,
        ic_name: param.name,
        type: hooks.infer_expr(value, env),
        is_const: true,
        is_linear: false,
        value,
        value_env: undefined,
      });
      continue;
    }

    let value = arg;
    let value_env = env;
    let value_type: FrontType = hooks.infer_expr(value, value_env);

    if (param.is_linear) {
      const resolved = resolve_linear_rec_arg(value, value_env, hooks);

      if (resolved) {
        value = resolved.value;
        value_env = resolved.env;
        value_type = resolved.type;
      }
    }

    if (param.annotation) {
      const annotated = hooks.apply_runtime_binding_annotation(
        param.annotation,
        value,
        value_env,
      );
      value = annotated.value;
      value_type = annotated.type;
      const unwrapped = unwrap_ownership_wrapper_value(value, value_env);
      value = unwrapped.value;
      value_env = unwrapped.env;
    }

    hooks.push_binding(env, {
      name: param.name,
      ic_name: hooks.fresh(env, param.name),
      type: value_type,
      is_const: false,
      is_linear: param.is_linear,
      value,
      value_env,
    });
  }
}

function resolve_linear_rec_arg(
  arg: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
): { value: FrontExpr; env: Env; type: FrontType } | undefined {
  let target = arg;
  let target_env = env;

  while (target.tag === "captured") {
    target_env = target.env;
    target = target.expr;
  }

  if (target.tag !== "linear") {
    return undefined;
  }

  const binding = hooks.lookup(target_env, target.name);
  expect(binding, "Unbound linear value: " + target.name);

  if (!binding.value) {
    return {
      value: { tag: "var", name: target.name },
      env: target_env,
      type: binding.type,
    };
  }

  let value_env = target_env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  return {
    value: hooks.capture_expr(binding.value, value_env),
    env: target_env,
    type: binding.type,
  };
}
