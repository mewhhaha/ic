import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { clone_env, push_binding } from "../env.ts";

export function record_static_loop_statements(stmts: Stmt[], env: Env): void {
  for (const stmt of stmts) {
    record_static_loop_statement(stmt, env);
  }
}

export function record_static_loop_statement(stmt: Stmt, env: Env): void {
  if (stmt.tag === "bind") {
    bind_loop_static_value(env, stmt.name, stmt.value);
    return;
  }

  if (stmt.tag === "assign") {
    bind_loop_static_value(env, stmt.name, stmt.value);
  }
}

export function bind_loop_static_value(
  env: Env,
  name: string,
  value: FrontExpr,
): void {
  push_binding(env, {
    name,
    ic_name: name,
    type: { tag: "unknown" },
    is_const: false,
    is_linear: false,
    value,
    value_env: clone_env(env),
  });
}

export function continues_range(
  current: number,
  end: number,
  step: number,
  end_bound: "exclusive" | "inclusive",
): boolean {
  if (step > 0) {
    if (end_bound === "inclusive") {
      return current <= end;
    }

    return current < end;
  }

  if (end_bound === "inclusive") {
    return current >= end;
  }

  return current > end;
}

export function validate_loop_binding_readonly(
  name: string,
  label: string,
  stmts: Stmt[],
): void {
  for (const stmt of stmts) {
    if (stmt.tag === "assign" && stmt.name === name) {
      throw new Error("Loop " + label + " is read-only: " + name);
    }

    if (stmt.tag === "index_assign" && stmt.name === name) {
      throw new Error("Loop " + label + " is read-only: " + name);
    }

    if (stmt.tag === "for_range") {
      validate_loop_binding_readonly(name, label, stmt.body);
      continue;
    }

    if (stmt.tag === "for_collection") {
      validate_loop_binding_readonly(name, label, stmt.body);
      continue;
    }

    if (stmt.tag === "if_stmt") {
      validate_loop_binding_readonly(name, label, stmt.body);
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      validate_loop_binding_readonly(name, label, stmt.body);
      continue;
    }
  }
}
