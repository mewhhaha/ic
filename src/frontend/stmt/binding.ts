import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import type { Binding, Env, FrontExpr, Stmt } from "../ast.ts";
import { validate_const_expr } from "../constness.ts";
import { clone_env, fresh, lookup, push_binding } from "../env.ts";
import { validate_linear_rest } from "../linear.ts";
import { unwrap_ownership_wrapper_context_expr } from "../ownership.ts";
import { same_type } from "../types.ts";
import {
  lower_mutually_recursive_runtime_bindings,
  lower_recursive_runtime_binding,
  lower_runtime_binding,
} from "./runtime_binding.ts";
import type {
  LowerStatementsWithDone,
  StatementDone,
  StatementLowerHooks,
} from "./types.ts";

export function lower_bind_statement(
  stmt: Extract<Stmt, { tag: "bind" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
  let stmt_value = stmt.value;

  if (stmt.mutual !== undefined) {
    return lower_mutually_recursive_runtime_bindings(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.kind === "const") {
    return lower_const_binding(
      stmt,
      stmt_value,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  stmt_value = hooks.prepare_runtime_value(stmt_value, env);

  let value_type = hooks.infer_expr(stmt_value, env);

  if (stmt.annotation) {
    const annotated = hooks.apply_runtime_binding_annotation(
      stmt.annotation,
      stmt_value,
      env,
    );
    stmt_value = annotated.value;
    value_type = annotated.type;
    stmt_value = unwrap_ownership_wrapper_context_expr(stmt_value);
  }

  if (stmt.is_recursive) {
    return lower_recursive_runtime_binding(
      stmt.name,
      stmt_value,
      value_type,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
      stmt.is_linear,
    );
  }

  if (stmt.is_linear) {
    validate_linear_rest(stmt.name, stmts.slice(index + 1));
  }

  return lower_runtime_binding(
    stmt.name,
    stmt_value,
    value_type,
    stmts,
    index,
    env,
    hooks,
    on_done,
    lower_statements_with_done,
    stmt.is_linear,
  );
}

export function lower_assign_statement(
  stmt: Extract<Stmt, { tag: "assign" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
  const previous = lookup(env, stmt.name);
  expect(previous, "Cannot assign unbound name: " + stmt.name);
  let stmt_value = hooks.prepare_runtime_value(stmt.value, env);
  let value_type = hooks.infer_expr(stmt_value, env);

  if (stmt.mode === "same" && !same_type(previous.type, value_type)) {
    throw new Error("Assignment changes type for " + stmt.name);
  }

  value_type = hooks.assignment_type(previous.type, value_type, stmt.mode);

  if (stmt.mode === "same") {
    stmt_value = unwrap_ownership_wrapper_context_expr(stmt_value);
  }

  const is_linear = previous.is_linear === true;

  return lower_runtime_binding(
    stmt.name,
    stmt_value,
    value_type,
    stmts,
    index,
    env,
    hooks,
    on_done,
    lower_statements_with_done,
    is_linear,
  );
}

export function lower_index_assign_statement(
  stmt: Extract<Stmt, { tag: "index_assign" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
  const stmt_value = hooks.apply_index_assignment(stmt, env);
  const previous = lookup(env, stmt.name);
  expect(previous, "Cannot assign unbound name: " + stmt.name);
  const ic_name = fresh(env, stmt.name);
  push_binding(env, {
    name: stmt.name,
    ic_name,
    type: hooks.infer_expr(stmt_value, env),
    is_const: false,
    is_linear: previous.is_linear,
    value: stmt_value,
    value_env: clone_env(env),
  });

  if (index + 1 >= stmts.length) {
    if (on_done) {
      return on_done();
    }

    return hooks.lower_expr(stmt_value, env);
  }

  return lower_statements_with_done(
    stmts,
    index + 1,
    env,
    hooks,
    on_done,
  );
}

function lower_const_binding(
  stmt: Extract<Stmt, { tag: "bind" }>,
  value: FrontExpr,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
  let stmt_value = hooks.prepare_const_value(value, env);
  validate_const_expr(
    stmt_value,
    env,
    new Set(),
    "Const binding captures runtime value",
  );

  if (stmt.annotation) {
    stmt_value = hooks.apply_annotation_context(
      stmt.annotation,
      stmt_value,
      env,
    );
    hooks.check_binding_annotation(stmt.annotation, stmt_value, env);
  }

  if (stmt.is_linear) {
    validate_linear_rest(stmt.name, stmts.slice(index + 1));
  }

  const value_env = clone_env(env);
  const binding: Binding = {
    name: stmt.name,
    ic_name: stmt.name,
    type: hooks.infer_expr(stmt_value, env),
    is_const: true,
    is_linear: stmt.is_linear,
    value: stmt_value,
    value_env,
  };
  push_binding(env, binding);

  if (index + 1 >= stmts.length) {
    if (on_done) {
      return on_done();
    }

    return hooks.lower_expr(stmt_value, value_env);
  }

  return lower_statements_with_done(
    stmts,
    index + 1,
    env,
    hooks,
    on_done,
  );
}
