import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType, ResolvedCallTarget } from "./ast.ts";
import { capture_const_ref } from "./capture.ts";
import { is_const_expr_known } from "./const_known.ts";
import { validate_const_expr } from "./constness.ts";
import { clone_env, lookup, push_binding } from "./env.ts";
import { format_expr } from "./format.ts";
import { is_rec_call } from "./rec_validate.ts";
import { parameter_arguments } from "./call_args.ts";

type ResolvedConstEvalTarget = {
  expr: Extract<FrontExpr, { tag: "lam" | "rec" }>;
  env: Env;
};

type ConstRecursionState = {
  active: Set<string>;
  memo: Map<string, FrontExpr>;
  steps: number;
};

export type CallConstHooks = {
  check_const_annotation: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => void;
  eval_const_builtin: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
  eval_front_value: (expr: FrontExpr, env: Env) => FrontExpr;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_const_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => FrontExpr | undefined;
  resolve_const_expr_with_env: (
    expr: FrontExpr,
    env: Env,
  ) => import("./ast.ts").ResolvedFrontExpr | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_static_if_branch: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => FrontExpr | undefined;
};

export function try_eval_all_const_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallConstHooks,
): FrontExpr | undefined {
  if (!can_eval_const_call(expr, env, true, hooks)) {
    return undefined;
  }

  return eval_const_call(expr, env, true, hooks);
}

export function can_eval_const_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  allow_unmarked_params: boolean,
  hooks: CallConstHooks,
): boolean {
  const target = resolve_const_eval_target(expr.func, env, hooks);

  if (!target) {
    return false;
  }

  const bindings = parameter_arguments(target.expr.params, expr.args);

  if (bindings === undefined) {
    return false;
  }

  for (const param of target.expr.params) {
    if (param.is_linear) {
      return false;
    }

    if (!param.is_const && !allow_unmarked_params) {
      return false;
    }
  }

  for (const binding of bindings) {
    if (!is_const_expr_known(binding.arg, env, new Set())) {
      return false;
    }
  }

  return true;
}

export function eval_const_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  allow_unmarked_params: boolean,
  hooks: CallConstHooks,
): FrontExpr | undefined {
  const target = resolve_const_eval_target(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  if (parameter_arguments(target.expr.params, expr.args) === undefined) {
    return undefined;
  }

  for (const param of target.expr.params) {
    if (!param.is_const && !allow_unmarked_params) {
      return undefined;
    }
  }

  if (target.expr.tag === "rec") {
    return eval_const_rec_call(target, expr.args, env, hooks);
  }

  const call_env = clone_env(target.env);

  bind_const_call_args(target.expr, expr.args, env, call_env, hooks);
  return hooks.eval_front_value(target.expr.body, call_env);
}

function bind_const_call_args(
  target: Extract<FrontExpr, { tag: "lam" | "rec" }>,
  args: FrontExpr[],
  env: Env,
  call_env: Env,
  hooks: CallConstHooks,
): void {
  const bindings = parameter_arguments(target.params, args);
  expect(bindings, "Const call arguments do not match parameters");

  for (const { param, arg } of bindings) {
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

    push_binding(call_env, {
      name: param.name,
      ic_name: param.name,
      type: hooks.infer_expr(value, env),
      is_const: true,
      is_linear: false,
      value,
      value_env: env,
    });
  }
}

function eval_const_rec_call(
  target: ResolvedConstEvalTarget,
  initial_args: FrontExpr[],
  caller_env: Env,
  hooks: CallConstHooks,
): FrontExpr {
  expect(target.expr.tag === "rec", "Expected recursive comptime target");
  return eval_const_rec_invocation(
    target,
    initial_args,
    caller_env,
    hooks,
    { active: new Set(), memo: new Map(), steps: 0 },
  );
}

function eval_const_rec_invocation(
  target: ResolvedConstEvalTarget,
  args: FrontExpr[],
  caller_env: Env,
  hooks: CallConstHooks,
  state: ConstRecursionState,
): FrontExpr {
  expect(target.expr.tag === "rec", "Expected recursive comptime target");
  const values = args.map((arg) =>
    materialize_const_rec_arg(arg, caller_env, hooks)
  );
  const key = values.map(format_expr).join(", ");
  state.steps += 1;

  if (state.steps > 10000) {
    throw new Error("Compile-time recursion exceeded 10000 steps");
  }

  const memoized = state.memo.get(key);

  if (memoized !== undefined) {
    return memoized;
  }

  if (state.active.has(key)) {
    throw new Error(
      "Compile-time recursion cycle detected at step " +
        state.steps.toString() + ": " + key,
    );
  }

  state.active.add(key);

  try {
    const call_env = clone_env(target.env);
    bind_const_call_args(target.expr, values, caller_env, call_env, hooks);
    const result = eval_const_rec_expr(
      target.expr.body,
      call_env,
      target,
      hooks,
      state,
    );
    const value = materialize_const_rec_arg(result, call_env, hooks);
    state.memo.set(key, value);
    return value;
  } finally {
    state.active.delete(key);
  }
}

function eval_const_rec_expr(
  expr: FrontExpr,
  env: Env,
  target: ResolvedConstEvalTarget,
  hooks: CallConstHooks,
  state: ConstRecursionState,
): FrontExpr {
  if (expr.tag === "captured") {
    return eval_const_rec_expr(expr.expr, expr.env, target, hooks, state);
  }

  if (expr.tag === "block") {
    const value = hooks.eval_front_value(expr, env);
    return eval_const_rec_expr(value, env, target, hooks, state);
  }

  if (expr.tag === "if") {
    let branch = hooks.resolve_static_if_branch(expr, env);

    if (branch === undefined) {
      const cond = eval_const_rec_expr(expr.cond, env, target, hooks, state);
      const value = hooks.resolve_static_i32_expr(cond, env);

      if (value !== undefined) {
        if (value === 0) {
          branch = expr.else_branch;
        } else {
          branch = expr.then_branch;
        }
      }
    }

    if (branch === undefined) {
      throw new Error(
        "Compile-time recursion requires a compile-time branch condition",
      );
    }

    return eval_const_rec_expr(branch, env, target, hooks, state);
  }

  if (is_rec_call(expr)) {
    expect(expr.tag === "app", "Expected recursive comptime call");
    return eval_const_rec_invocation(
      target,
      expr.args,
      env,
      hooks,
      state,
    );
  }

  if (expr.tag === "prim") {
    return materialize_const_rec_arg(
      {
        ...expr,
        left: eval_const_rec_expr(expr.left, env, target, hooks, state),
        right: eval_const_rec_expr(expr.right, env, target, hooks, state),
      },
      env,
      hooks,
    );
  }

  if (expr.tag === "app") {
    return materialize_const_rec_arg(
      {
        ...expr,
        func: eval_const_rec_expr(expr.func, env, target, hooks, state),
        args: expr.args.map((arg) =>
          eval_const_rec_expr(arg, env, target, hooks, state)
        ),
      },
      env,
      hooks,
    );
  }

  if (expr.tag === "product") {
    return {
      ...expr,
      entries: expr.entries.map((entry) => ({
        ...entry,
        value: eval_const_rec_expr(entry.value, env, target, hooks, state),
      })),
    };
  }

  if (expr.tag === "array") {
    const items = expr.items.map((item) =>
      eval_const_rec_expr(item, env, target, hooks, state)
    );

    if (expr.rest === undefined) {
      return { ...expr, items };
    }

    const rest = eval_const_rec_expr(expr.rest, env, target, hooks, state);

    if (rest.tag !== "array" || rest.rest !== undefined) {
      throw new Error(
        "Compile-time array spread requires a fixed array value",
      );
    }

    if (expr.leading_rest === true) {
      return { ...expr, items: [...rest.items, ...items], rest: undefined };
    }

    return { ...expr, items: [...items, ...rest.items], rest: undefined };
  }

  if (expr.tag === "struct_value") {
    return {
      ...expr,
      fields: expr.fields.map((field) => ({
        ...field,
        value: eval_const_rec_expr(field.value, env, target, hooks, state),
      })),
    };
  }

  if (expr.tag === "union_case" && expr.value !== undefined) {
    return {
      ...expr,
      value: eval_const_rec_expr(expr.value, env, target, hooks, state),
    };
  }

  return materialize_const_rec_arg(expr, env, hooks);
}

function materialize_const_rec_arg(
  expr: FrontExpr,
  env: Env,
  hooks: CallConstHooks,
): FrontExpr {
  const number = hooks.resolve_static_i32_expr(expr, env);

  if (number !== undefined) {
    return { tag: "num", type: "i32", value: number };
  }

  if (expr.tag === "captured") {
    return materialize_const_rec_arg(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "app") {
    const call: Extract<FrontExpr, { tag: "app" }> = {
      ...expr,
      args: expr.args.map((arg) => materialize_const_rec_arg(arg, env, hooks)),
    };
    const resolved_call = hooks.resolve_const_expr_with_env(call, env);

    if (
      resolved_call !== undefined &&
      (resolved_call.expr !== call || resolved_call.env !== env)
    ) {
      return materialize_const_rec_arg(
        resolved_call.expr,
        resolved_call.env,
        hooks,
      );
    }

    const builtin = hooks.eval_const_builtin(call, env);

    if (builtin !== undefined) {
      return materialize_const_rec_arg(builtin, env, hooks);
    }

    const value = hooks.eval_front_value(call, env);

    if (
      value.tag === "captured" && value.expr === call && value.env === env
    ) {
      return value;
    }

    if (value !== call) {
      return materialize_const_rec_arg(value, env, hooks);
    }

    return call;
  }

  if (expr.tag === "index") {
    const object = materialize_const_rec_arg(expr.object, env, hooks);
    const index = materialize_const_rec_arg(expr.index, env, hooks);
    const static_index = hooks.resolve_static_i32_expr(index, env);

    if (
      object.tag === "array" && object.rest === undefined &&
      static_index !== undefined
    ) {
      const item = object.items[static_index];
      expect(item, "Compile-time fold index out of bounds: " + static_index);
      return materialize_const_rec_arg(item, env, hooks);
    }

    return { ...expr, object, index };
  }

  const resolved = hooks.resolve_const_expr_with_env(expr, env);

  if (
    resolved !== undefined &&
    (resolved.expr !== expr || resolved.env !== env)
  ) {
    return materialize_const_rec_arg(resolved.expr, resolved.env, hooks);
  }

  if (expr.tag === "prim") {
    const value: FrontExpr = {
      ...expr,
      left: materialize_const_rec_arg(expr.left, env, hooks),
      right: materialize_const_rec_arg(expr.right, env, hooks),
    };
    const folded = hooks.resolve_static_i32_expr(value, env);

    if (folded !== undefined) {
      return { tag: "num", type: "i32", value: folded };
    }

    return value;
  }

  if (expr.tag === "product") {
    return {
      ...expr,
      entries: expr.entries.map((entry) => ({
        ...entry,
        value: materialize_const_rec_arg(entry.value, env, hooks),
      })),
    };
  }

  if (expr.tag === "array") {
    const items = expr.items.map((item) =>
      materialize_const_rec_arg(item, env, hooks)
    );

    if (expr.rest === undefined) {
      return { ...expr, items };
    }

    const rest = materialize_const_rec_arg(expr.rest, env, hooks);

    if (rest.tag !== "array" || rest.rest !== undefined) {
      throw new Error(
        "Compile-time array spread requires a fixed array value",
      );
    }

    if (expr.leading_rest === true) {
      return { ...expr, items: [...rest.items, ...items], rest: undefined };
    }

    return { ...expr, items: [...items, ...rest.items], rest: undefined };
  }

  if (expr.tag === "struct_value") {
    return {
      ...expr,
      fields: expr.fields.map((field) => ({
        ...field,
        value: materialize_const_rec_arg(field.value, env, hooks),
      })),
    };
  }

  return capture_const_ref(expr, env);
}

function resolve_const_eval_target(
  expr: FrontExpr,
  env: Env,
  hooks: CallConstHooks,
): ResolvedConstEvalTarget | undefined {
  if (expr.tag === "captured") {
    return resolve_const_eval_target(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return { expr, env };
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_const_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return resolve_const_eval_target(field, env, hooks);
  }

  if (expr.tag === "app") {
    const value = try_eval_all_const_call(expr, env, hooks);

    if (!value) {
      return undefined;
    }

    return resolve_const_eval_target(value, env, hooks);
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.is_const || !binding.value) {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  return resolve_const_eval_target(binding.value, value_env, hooks);
}

export function resolve_const_call_target(
  expr: FrontExpr,
  env: Env,
  hooks: CallConstHooks,
): ResolvedCallTarget | undefined {
  const target = resolve_const_eval_target(expr, env, hooks);

  if (!target || target.expr.tag !== "lam") {
    return undefined;
  }

  return { expr: target.expr, env: target.env };
}
