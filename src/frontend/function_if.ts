import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType, Param, Stmt } from "./ast.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import { common_front_type, same_type } from "./types.ts";

export function resolve_direct_lambda(
  expr: FrontExpr,
  env: Env,
): { expr: Extract<FrontExpr, { tag: "lam" }>; env: Env } | undefined {
  return resolve_direct_lambda_seen(expr, env, new Set());
}

function resolve_direct_lambda_seen(
  expr: FrontExpr,
  env: Env,
  seen: Set<string>,
): { expr: Extract<FrontExpr, { tag: "lam" }>; env: Env } | undefined {
  if (expr.tag === "captured") {
    return resolve_direct_lambda_seen(expr.expr, expr.env, seen);
  }

  const block_alias = direct_lambda_alias_block(expr, env, seen);

  if (block_alias) {
    return block_alias;
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing function-if block statement");

    if (stmt.tag === "expr") {
      return resolve_direct_lambda_seen(stmt.expr, clone_env(env), seen);
    }

    if (stmt.tag === "return") {
      return resolve_direct_lambda_seen(stmt.value, clone_env(env), seen);
    }
  }

  if (expr.tag === "var") {
    if (seen.has(expr.name)) {
      return undefined;
    }

    const binding = lookup(env, expr.name);

    if (!binding || !binding.value) {
      return undefined;
    }

    let value_env = env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    const next_seen = new Set(seen);
    next_seen.add(expr.name);
    return resolve_direct_lambda_seen(binding.value, value_env, next_seen);
  }

  if (expr.tag !== "lam") {
    return undefined;
  }

  return { expr, env };
}

function direct_lambda_alias_block(
  expr: FrontExpr,
  env: Env,
  seen: Set<string>,
): { expr: Extract<FrontExpr, { tag: "lam" }>; env: Env } | undefined {
  if (expr.tag !== "block" || expr.statements.length <= 1) {
    return undefined;
  }

  const result = expr.statements[expr.statements.length - 1];
  expect(result, "Missing function alias block result");

  const result_expr = direct_lambda_block_result(result);

  if (!result_expr) {
    return undefined;
  }

  const local = clone_inline_value_env(env);

  for (let index = 0; index < expr.statements.length - 1; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing function alias block binding " + index);

    if (stmt.tag !== "bind") {
      return undefined;
    }

    if (stmt.is_linear) {
      return undefined;
    }

    const ic_name = fresh(local, stmt.name);
    const value_env = clone_inline_value_env(local);

    // Block-local bindings are inlined through the captured environment so
    // aliases keep the same captured values as the enclosing function.
    push_binding(local, {
      name: stmt.name,
      ic_name,
      type: { tag: "unknown" },
      is_const: true,
      is_linear: false,
      value: stmt.value,
      value_env,
    });
  }

  return resolve_direct_lambda_seen(result_expr, local, seen);
}

function clone_inline_value_env(env: Env): Env {
  const cloned = clone_env(env);

  for (const scope of cloned.scopes) {
    for (const [name, binding] of scope) {
      if (!binding.value || binding.is_linear) {
        continue;
      }

      scope.set(name, {
        ...binding,
        is_const: true,
      });
    }
  }

  return cloned;
}

function direct_lambda_block_result(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

export function function_if_param_types(
  left: Param[],
  left_env: Env,
  right: Param[],
  right_env: Env,
  hooks: {
    resolve_annotation_type: (
      annotation: string,
      env: Env,
    ) => FrontType | undefined;
  },
): FrontType[] | undefined {
  if (left.length !== right.length) {
    return undefined;
  }

  const types: FrontType[] = [];

  for (let index = 0; index < left.length; index += 1) {
    const left_param = left[index];
    const right_param = right[index];
    expect(left_param, "Missing left function-if parameter " + index);
    expect(right_param, "Missing right function-if parameter " + index);

    if (left_param.is_const || right_param.is_const) {
      return undefined;
    }

    if (left_param.is_linear !== right_param.is_linear) {
      return undefined;
    }

    let type: FrontType = { tag: "unknown" };
    const left_type = resolve_param_annotation_type(
      left_param.annotation,
      left_env,
      hooks,
    );
    const right_type = resolve_param_annotation_type(
      right_param.annotation,
      right_env,
      hooks,
    );

    if (left_param.annotation && !left_type) {
      return undefined;
    }

    if (right_param.annotation && !right_type) {
      return undefined;
    }

    if (left_type && right_type) {
      if (!same_type(left_type, right_type)) {
        return undefined;
      }

      const common = common_front_type(left_type, right_type);
      expect(common, "Missing common function-if parameter type");
      type = common;
    } else if (left_type) {
      type = left_type;
    } else if (right_type) {
      type = right_type;
    }

    types.push(type);
  }

  return types;
}

function resolve_param_annotation_type(
  annotation: string | undefined,
  env: Env,
  hooks: {
    resolve_annotation_type: (
      annotation: string,
      env: Env,
    ) => FrontType | undefined;
  },
): FrontType | undefined {
  if (!annotation) {
    return undefined;
  }

  return hooks.resolve_annotation_type(annotation, env);
}

export function bind_function_if_params(
  left: Param[],
  left_env: Env,
  right: Param[],
  right_env: Env,
  types: FrontType[],
): string[] | undefined {
  const names: string[] = [];
  const fresh_env = clone_env(left_env);

  for (let index = 0; index < left.length; index += 1) {
    const left_param = left[index];
    const right_param = right[index];
    const type = types[index];
    expect(left_param, "Missing left function-if parameter " + index);
    expect(right_param, "Missing right function-if parameter " + index);
    expect(type, "Missing function-if parameter type " + index);
    const ic_name = fresh(fresh_env, left_param.name);
    names.push(ic_name);

    push_binding(left_env, {
      name: left_param.name,
      ic_name,
      type,
      is_const: false,
      is_linear: left_param.is_linear,
      value: undefined,
      value_env: undefined,
    });
    push_binding(right_env, {
      name: right_param.name,
      ic_name,
      type,
      is_const: false,
      is_linear: right_param.is_linear,
      value: undefined,
      value_env: undefined,
    });
  }

  return names;
}
