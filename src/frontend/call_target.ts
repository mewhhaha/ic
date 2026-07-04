import { expect } from "../expect.ts";
import type { Binding, Env, FrontExpr, ResolvedCallTarget } from "./ast.ts";
import { clone_env, lookup } from "./env.ts";

export type CallTargetHooks = {
  resolve_const_call_target: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedCallTarget | undefined;
  resolve_static_if_branch: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => FrontExpr | undefined;
};

export function resolve_call_target(
  expr: FrontExpr,
  env: Env,
  hooks: CallTargetHooks,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  const target = resolve_call_target_with_env(expr, env, hooks);

  if (!target) {
    return undefined;
  }

  return target.expr;
}

export function resolve_call_target_with_env(
  expr: FrontExpr,
  env: Env,
  hooks: CallTargetHooks,
): ResolvedCallTarget | undefined {
  return resolve_call_target_with_env_seen(expr, env, new Set(), hooks);
}

export function resolve_dynamic_function_if_target(
  expr: FrontExpr,
  env: Env,
  hooks: CallTargetHooks,
):
  | { expr: Extract<FrontExpr, { tag: "if" }>; env: Env }
  | undefined {
  return resolve_dynamic_function_if_target_seen(expr, env, new Set(), hooks);
}

function resolve_call_target_with_env_seen(
  expr: FrontExpr,
  env: Env,
  seen: Set<Binding>,
  hooks: CallTargetHooks,
): ResolvedCallTarget | undefined {
  if (expr.tag === "captured") {
    return resolve_call_target_with_env_seen(expr.expr, expr.env, seen, hooks);
  }

  const const_target = hooks.resolve_const_call_target(expr, env);

  if (const_target) {
    return const_target;
  }

  if (expr.tag === "if") {
    const branch = hooks.resolve_static_if_branch(expr, env);

    if (!branch) {
      return undefined;
    }

    return resolve_call_target_with_env_seen(branch, env, seen, hooks);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing call target block statement");

    if (stmt.tag === "expr") {
      return resolve_call_target_with_env_seen(
        stmt.expr,
        clone_env(env),
        seen,
        hooks,
      );
    }

    if (stmt.tag === "return") {
      return resolve_call_target_with_env_seen(
        stmt.value,
        clone_env(env),
        seen,
        hooks,
      );
    }
  }

  if (expr.tag === "block" && expr.statements.length === 2) {
    const bind = expr.statements[0];
    const result = expr.statements[1];
    expect(bind, "Missing call target alias binding");
    expect(result, "Missing call target alias result");

    if (bind.tag === "bind" && bind.kind === "let" && !bind.is_linear) {
      const result_expr = call_target_block_result_expr(result);

      if (
        result_expr && result_expr.tag === "var" &&
        result_expr.name === bind.name
      ) {
        return resolve_call_target_with_env_seen(
          bind.value,
          clone_env(env),
          seen,
          hooks,
        );
      }
    }
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.value || binding.value.tag !== "lam") {
    if (!binding || !binding.value) {
      return undefined;
    }

    if (seen.has(binding)) {
      throw new Error("Recursive call target: " + expr.name);
    }

    let alias_env = env;

    if (binding.value_env) {
      alias_env = binding.value_env;
    }

    seen.add(binding);
    const target = resolve_call_target_with_env_seen(
      binding.value,
      alias_env,
      seen,
      hooks,
    );
    seen.delete(binding);
    return target;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  return { expr: binding.value, env: value_env };
}

function call_target_block_result_expr(
  stmt: Extract<FrontExpr, { tag: "block" }>["statements"][number],
): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function resolve_dynamic_function_if_target_seen(
  expr: FrontExpr,
  env: Env,
  seen: Set<Binding>,
  hooks: CallTargetHooks,
):
  | { expr: Extract<FrontExpr, { tag: "if" }>; env: Env }
  | undefined {
  if (expr.tag === "captured") {
    return resolve_dynamic_function_if_target_seen(
      expr.expr,
      expr.env,
      seen,
      hooks,
    );
  }

  if (expr.tag === "if") {
    return { expr, env };
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing dynamic function-if target block statement");

    if (stmt.tag === "expr") {
      return resolve_dynamic_function_if_target_seen(
        stmt.expr,
        clone_env(env),
        seen,
        hooks,
      );
    }

    if (stmt.tag === "return") {
      return resolve_dynamic_function_if_target_seen(
        stmt.value,
        clone_env(env),
        seen,
        hooks,
      );
    }
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.value) {
    return undefined;
  }

  if (seen.has(binding)) {
    throw new Error("Recursive dynamic function-if target: " + expr.name);
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  seen.add(binding);
  const target = resolve_dynamic_function_if_target_seen(
    binding.value,
    value_env,
    seen,
    hooks,
  );
  seen.delete(binding);
  return target;
}
