import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, ResolvedFrontExpr, Stmt } from "./ast.ts";
import { capture_expr } from "./capture.ts";
import { validate_const_expr } from "./constness.ts";
import {
  dynamic_if_let_ic_route,
  structured_core_route,
  unresolved_import_route,
} from "./diagnostic.ts";
import { clone_env } from "./env.ts";
import {
  lower_assign_statement,
  lower_bind_statement,
  lower_index_assign_statement,
} from "./stmt/binding.ts";
import type { StatementDone, StatementLowerHooks } from "./stmt/types.ts";

export type { StatementLowerHooks };

export function lower_statements(
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
): IcNode {
  return lower_statements_with_done(
    stmts,
    index,
    env,
    hooks,
    undefined,
  );
}

function lower_statements_with_done(
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: (() => IcNode) | undefined,
): IcNode {
  if (index >= stmts.length) {
    if (on_done) {
      return on_done();
    }

    throw new Error("Program has no result expression");
  }

  const stmt = stmts[index];
  expect(stmt, "Missing statement " + index);

  if (stmt.tag === "import") {
    throw new Error(
      "Cannot lower unresolved import; " + unresolved_import_route,
    );
  }

  if (stmt.tag === "host_import") {
    throw new Error(
      "Cannot lower host import through pure Ic" + structured_core_route,
    );
  }

  if (stmt.tag === "bind") {
    return lower_bind_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "assign") {
    return lower_assign_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "index_assign") {
    return lower_index_assign_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "for_range") {
    const expanded = hooks.expand_for_range(stmt, env);
    const rest = stmts.slice(index + 1);
    return lower_statements_with_done(
      [...expanded, ...rest],
      0,
      env,
      hooks,
      on_done,
    );
  }

  if (stmt.tag === "for_collection") {
    const expanded = hooks.expand_for_collection(stmt, env);
    const rest = stmts.slice(index + 1);
    return lower_statements_with_done(
      [...expanded, ...rest],
      0,
      env,
      hooks,
      on_done,
    );
  }

  if (stmt.tag === "if_stmt") {
    return lower_if_statement(stmt, stmts, index, env, hooks, on_done);
  }

  if (stmt.tag === "if_let_stmt") {
    return lower_if_let_statement(stmt, stmts, index, env, hooks, on_done);
  }

  if (stmt.tag === "type_check") {
    hooks.check_type_pattern(stmt, env);
    return lower_statements_with_done(
      stmts,
      index + 1,
      env,
      hooks,
      on_done,
    );
  }

  if (stmt.tag === "break") {
    throw new Error("Cannot lower break outside static range loop");
  }

  if (stmt.tag === "continue") {
    throw new Error("Cannot lower continue outside static range loop");
  }

  if (stmt.tag === "return") {
    return hooks.lower_expr(stmt.value, env);
  }

  if (stmt.tag === "expr") {
    if (
      index + 1 < stmts.length &&
      is_compile_time_only_expr(stmt.expr, env, hooks)
    ) {
      validate_const_expr(
        stmt.expr,
        env,
        new Set(),
        "Compile-time-only expression captures runtime value",
      );
      return lower_statements_with_done(
        stmts,
        index + 1,
        env,
        hooks,
        on_done,
      );
    }

    if (stmt.expr.tag === "block" && index + 1 < stmts.length) {
      return lower_block_statement(
        stmt.expr,
        stmts,
        index,
        env,
        hooks,
        on_done,
      );
    }

    const expr = hooks.lower_expr(stmt.expr, env);

    if (index + 1 >= stmts.length) {
      if (on_done) {
        return {
          tag: "era",
          expr,
          body: on_done(),
        };
      }

      return expr;
    }

    return {
      tag: "era",
      expr,
      body: lower_statements_with_done(
        stmts,
        index + 1,
        env,
        hooks,
        on_done,
      ),
    };
  }

  throw new Error(
    "Cannot lower " + stmt.feature + " to Ic frontend yet" +
      structured_core_route,
  );
}

function lower_if_statement(
  stmt: Extract<Stmt, { tag: "if_stmt" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: (() => IcNode) | undefined,
): IcNode {
  const rest = stmts.slice(index + 1);
  const cond = hooks.resolve_static_i32_expr(stmt.cond, env);

  if (cond === undefined) {
    let implicit_else: boolean | undefined;

    if (rest.length === 0) {
      implicit_else = true;
    }

    return hooks.lower_expr(
      {
        tag: "if",
        cond: stmt.cond,
        then_branch: { tag: "block", statements: [...stmt.body, ...rest] },
        else_branch: { tag: "block", statements: rest },
        implicit_else,
      },
      env,
    );
  }

  if (cond === 0) {
    return lower_statements_with_done(rest, 0, env, hooks, on_done);
  }

  return lower_statements_with_done(
    [...stmt.body, ...rest],
    0,
    clone_env(env),
    hooks,
    on_done,
  );
}

function lower_if_let_statement(
  stmt: Extract<Stmt, { tag: "if_let_stmt" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: (() => IcNode) | undefined,
): IcNode {
  const target = hooks.resolve_union_value(stmt.target, env);
  const rest = stmts.slice(index + 1);

  if (!target) {
    const target_type = hooks.infer_expr(stmt.target, env);

    if (
      target_type.tag === "union_value" ||
      hooks.infer_dynamic_if_let_cases(stmt.target, env)
    ) {
      let implicit_else: boolean | undefined;

      if (rest.length === 0) {
        implicit_else = true;
      }

      return hooks.lower_expr(
        {
          tag: "if_let",
          case_name: stmt.case_name,
          value_name: stmt.value_name,
          target: stmt.target,
          then_branch: { tag: "block", statements: [...stmt.body, ...rest] },
          else_branch: { tag: "block", statements: rest },
          implicit_else,
        },
        env,
      );
    }

    throw new Error(dynamic_if_let_ic_route);
  }

  if (target.expr.name !== stmt.case_name) {
    return lower_statements_with_done(rest, 0, env, hooks, on_done);
  }

  let body = stmt.body;

  if (stmt.value_name) {
    const value = target.expr.value;

    if (!value) {
      throw new Error("Union case has no payload: " + stmt.case_name);
    }

    body = [
      {
        tag: "bind",
        kind: "let",
        name: stmt.value_name,
        is_linear: false,
        annotation: undefined,
        value: capture_expr(value, target.env),
      },
      ...stmt.body,
    ];
  }

  return lower_statements_with_done(
    [...body, ...rest],
    0,
    clone_env(env),
    hooks,
    on_done,
  );
}

function lower_block_statement(
  expr: Extract<FrontExpr, { tag: "block" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: (() => IcNode) | undefined,
): IcNode {
  const rest = stmts.slice(index + 1);
  const local = clone_env(env);

  if (!on_done && rest.length > 0) {
    return lower_statements_with_done(
      [
        ...expr.statements,
        {
          tag: "expr",
          expr: {
            tag: "captured",
            expr: { tag: "block", statements: rest },
            env,
          },
        },
      ],
      0,
      local,
      hooks,
      undefined,
    );
  }

  const continuation = () =>
    lower_statements_with_done(rest, 0, env, hooks, on_done);
  return lower_statements_with_done(
    expr.statements,
    0,
    local,
    hooks,
    continuation,
  );
}

function is_compile_time_only_expr(
  expr: FrontExpr,
  env: Env,
  hooks: StatementLowerHooks,
): boolean {
  if (expr.tag === "with") {
    return true;
  }

  const expr_type = hooks.infer_expr(expr, env);
  return expr_type.tag === "type";
}
