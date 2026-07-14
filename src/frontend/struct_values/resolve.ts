import { expect } from "../../expect.ts";
import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { elaborate_product_expr } from "../aggregate.ts";
import { clone_env, lookup, push_binding } from "../env.ts";
import { apply_struct_update_with_resolver } from "./update.ts";
import type { StructValueHooks, StructValueTarget } from "./types.ts";

export function resolve_struct_value(
  expr: FrontExpr,
  env: Env,
  hooks: StructValueHooks,
): StructValueTarget | undefined {
  if (expr.tag === "captured") {
    return resolve_struct_value(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "struct_value") {
    return { expr, env };
  }

  if (expr.tag === "product") {
    return { expr: elaborate_product_expr(expr), env };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resolve_struct_value(expr.value, env, hooks);
  }

  if (expr.tag === "scratch") {
    return resolve_struct_value(expr.body, env, hooks);
  }

  if (is_non_struct_const_builtin(expr)) {
    return undefined;
  }

  const const_value = hooks.resolve_const_expr(expr, env);

  if (const_value && const_value.tag === "struct_value") {
    return { expr: const_value, env };
  }

  if (expr.tag === "struct_update") {
    const value = apply_struct_update_with_resolver(
      expr,
      env,
      hooks,
      resolve_struct_value,
    );
    if (value.tag === "struct_value") {
      return { expr: value, env };
    }

    return resolve_struct_value(value, env, hooks);
  }

  if (expr.tag === "if") {
    return hooks.resolve_dynamic_struct_if_value(expr, env);
  }

  if (expr.tag === "if_let") {
    return hooks.resolve_dynamic_if_let_struct_value(expr, env);
  }

  if (expr.tag === "app") {
    const inlined = hooks.inline_deferred_const_call(expr, env);

    if (inlined) {
      return resolve_struct_value(inlined.expr, inlined.env, hooks);
    }

    const specialized = hooks.inline_specialized_call_expr(expr, env);

    if (specialized) {
      return resolve_struct_value(specialized.expr, specialized.env, hooks);
    }

    const runtime = hooks.inline_runtime_call_expr(expr, env);

    if (runtime) {
      return resolve_struct_value(runtime.expr, runtime.env, hooks);
    }
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    return resolve_single_statement_struct_block(expr.statements, env, hooks);
  }

  if (expr.tag === "block") {
    const block = resolve_struct_block_value(expr, env, hooks);

    if (block) {
      return block;
    }

    const value = hooks.eval_simple_front_block(expr, env);

    if (value) {
      return resolve_struct_value(value, env, hooks);
    }
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return resolve_struct_value(field.expr, field.env, hooks);
  }

  if (expr.tag === "index") {
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index === undefined) {
      return undefined;
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (!item) {
      return undefined;
    }

    return resolve_struct_value(item.expr, item.env, hooks);
  }

  if (expr.tag !== "var" && expr.tag !== "linear") {
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

  const resolved = resolve_struct_value(binding.value, value_env, hooks);

  if (resolved) {
    return resolved;
  }

  return undefined;
}

function resolve_single_statement_struct_block(
  stmts: Stmt[],
  env: Env,
  hooks: StructValueHooks,
): StructValueTarget | undefined {
  const stmt = stmts[0];
  expect(stmt, "Missing block statement");

  if (stmt.tag === "expr") {
    return resolve_struct_value(stmt.expr, clone_env(env), hooks);
  }

  if (stmt.tag === "return") {
    return resolve_struct_value(stmt.value, clone_env(env), hooks);
  }

  return undefined;
}

function resolve_struct_block_value(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  hooks: StructValueHooks,
): StructValueTarget | undefined {
  if (expr.statements.length <= 1) {
    return undefined;
  }

  const local = clone_env(env);

  for (const stmt of expr.statements) {
    if (stmt.tag === "bind") {
      if (stmt.kind !== "let" || stmt.is_linear) {
        return undefined;
      }

      const value_env = clone_env(local);
      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: hooks.infer_expr(stmt.value, value_env),
        is_const: false,
        is_linear: false,
        value: stmt.value,
        value_env,
      });
      continue;
    }

    if (stmt.tag === "expr") {
      return resolve_struct_value(stmt.expr, local, hooks);
    }

    if (stmt.tag === "return") {
      return resolve_struct_value(stmt.value, local, hooks);
    }

    return undefined;
  }

  return undefined;
}

function is_non_struct_const_builtin(expr: FrontExpr): boolean {
  if (expr.tag === "captured") {
    return is_non_struct_const_builtin(expr.expr);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing block statement");

    if (stmt.tag === "expr") {
      return is_non_struct_const_builtin(stmt.expr);
    }

    if (stmt.tag === "return") {
      return is_non_struct_const_builtin(stmt.value);
    }
  }

  if (expr.tag !== "app") {
    return false;
  }

  if (expr.func.tag !== "var") {
    return false;
  }

  return expr.func.name === "len" || expr.func.name === "size_of" ||
    expr.func.name === "align_of" || expr.func.name === "is_struct" ||
    expr.func.name === "is_union" || expr.func.name === "has";
}
