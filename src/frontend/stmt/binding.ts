import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import type { Binding, Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { validate_const_expr } from "../constness.ts";
import { structured_core_route } from "../diagnostic.ts";
import { clone_env, fresh, lookup, push_binding } from "../env.ts";
import { lower_bound_value } from "../ic_share.ts";
import {
  linear_param_names,
  validate_linear_lam,
  validate_linear_rest,
} from "../linear.ts";
import { unwrap_ownership_wrapper_context_expr } from "../ownership.ts";
import { validate_rec_tail } from "../rec.ts";
import { lower_expr_as_front_type } from "../typed_lower.ts";
import { same_type } from "../types.ts";
import type {
  LowerStatementsWithDone,
  StatementDone,
  StatementLowerHooks,
} from "./types.ts";
import { can_defer_call_only_runtime_lam_binding } from "./call_only_defer.ts";

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

function lower_recursive_runtime_binding(
  name: string,
  stmt_value: FrontExpr,
  value_type: FrontType,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
  is_linear: boolean,
): IcNode {
  if (is_linear) {
    throw new Error("Recursive binding cannot be linear: " + name);
  }

  if (stmt_value.tag !== "lam") {
    throw new Error("Recursive binding requires a lambda: " + name);
  }

  if (hooks.requires_specialized_call(stmt_value, env)) {
    throw new Error(
      "Cannot lower specialized recursive function to Ic frontend: " + name,
    );
  }

  const ic_name = fresh(env, name);
  const binding: Binding = {
    name,
    ic_name,
    type: value_type,
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  };
  push_binding(env, binding);

  const value = lower_expr_as_front_type(stmt_value, value_type, env, hooks);
  const body = lower_binding_body(
    stmts,
    index,
    env,
    ic_name,
    hooks,
    on_done,
    lower_statements_with_done,
  );

  return { tag: "fix", name: ic_name, expr: value, body };
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
    hooks.check_binding_annotation(stmt.annotation, stmt_value, env);
    stmt_value = hooks.apply_annotation_context(
      stmt.annotation,
      stmt_value,
      env,
    );
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

function lower_runtime_binding(
  name: string,
  stmt_value: FrontExpr,
  value_type: FrontType,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
  is_linear = false,
): IcNode {
  if (stmt_value.tag === "rec") {
    validate_rec_tail(stmt_value.body);
    const ic_name = fresh(env, name);
    const binding: Binding = {
      name,
      ic_name,
      type: value_type,
      is_const: false,
      is_linear,
      value: stmt_value,
      value_env: clone_env(env),
    };
    push_binding(env, binding);

    if (index + 1 >= stmts.length) {
      throw new Error(
        "Cannot lower rec function value to Ic frontend yet" +
          structured_core_route,
      );
    }

    return lower_statements_with_done(
      stmts,
      index + 1,
      env,
      hooks,
      on_done,
    );
  }

  if (
    stmt_value.tag === "lam" && hooks.requires_specialized_call(stmt_value, env)
  ) {
    const ic_name = fresh(env, name);
    const binding: Binding = {
      name,
      ic_name,
      type: value_type,
      is_const: false,
      is_linear,
      value: stmt_value,
      value_env: clone_env(env),
    };
    push_binding(env, binding);

    if (index + 1 >= stmts.length) {
      if (linear_param_names(stmt_value).size > 0) {
        validate_linear_lam(stmt_value);
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

    return lower_statements_with_done(
      stmts,
      index + 1,
      env,
      hooks,
      on_done,
    );
  }

  const bind_typed_value = should_bind_typed_runtime_value(
    stmt_value,
    value_type,
    env,
    hooks,
  );

  if (hooks.is_deferred_frontend_value(stmt_value, env) && !bind_typed_value) {
    const ic_name = fresh(env, name);
    const binding: Binding = {
      name,
      ic_name,
      type: value_type,
      is_const: false,
      is_linear,
      value: stmt_value,
      value_env: clone_env(env),
      is_deferred: true,
    };
    push_binding(env, binding);

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

  let value: IcNode;

  try {
    value = lower_expr_as_front_type(stmt_value, value_type, env, hooks);
  } catch (error) {
    if (
      can_defer_call_only_runtime_lam_binding(
        name,
        stmt_value,
        stmts,
        index,
        is_linear,
        error,
      )
    ) {
      const ic_name = fresh(env, name);
      const binding: Binding = {
        name,
        ic_name,
        type: value_type,
        is_const: false,
        is_linear,
        value: stmt_value,
        value_env: clone_env(env),
      };
      push_binding(env, binding);

      return lower_statements_with_done(
        stmts,
        index + 1,
        env,
        hooks,
        on_done,
      );
    }

    throw error;
  }

  const ic_name = fresh(env, name);
  const binding: Binding = {
    name,
    ic_name,
    type: value_type,
    is_const: false,
    is_linear,
    value: runtime_binding_value(stmt_value, bind_typed_value),
    value_env: clone_env(env),
  };
  push_binding(env, binding);
  const body = lower_binding_body(
    stmts,
    index,
    env,
    ic_name,
    hooks,
    on_done,
    lower_statements_with_done,
  );
  return lower_bound_value(value, body, ic_name);
}

function should_bind_typed_runtime_value(
  value: FrontExpr,
  type: FrontType,
  env: Env,
  hooks: StatementLowerHooks,
): boolean {
  if (value.tag !== "if" || type.tag !== "union_value") {
    return false;
  }

  return hooks.lower_dynamic_union_if(value, env) === undefined;
}

function runtime_binding_value(
  value: FrontExpr,
  bind_typed_value: boolean,
): FrontExpr | undefined {
  if (bind_typed_value) {
    return undefined;
  }

  return value;
}

function lower_binding_body(
  stmts: Stmt[],
  index: number,
  env: Env,
  ic_name: string,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
  if (index + 1 >= stmts.length) {
    if (on_done) {
      return on_done();
    }

    return { tag: "var", name: ic_name };
  }

  return lower_statements_with_done(
    stmts,
    index + 1,
    env,
    hooks,
    on_done,
  );
}
