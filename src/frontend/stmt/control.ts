import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { capture_expr } from "../capture.ts";
import { validate_const_expr } from "../constness.ts";
import { is_const_expr_known } from "../const_known.ts";
import { dynamic_if_let_ic_route } from "../diagnostic.ts";
import { clone_env } from "../env.ts";
import type {
  LowerStatementsWithDone,
  StatementDone,
  StatementLowerHooks,
} from "./types.ts";

export function lower_for_range_statement(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
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

export function lower_for_collection_statement(
  stmt: Extract<Stmt, { tag: "for_collection" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
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

export function lower_if_statement(
  stmt: Extract<Stmt, { tag: "if_stmt" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
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

export function lower_if_let_statement(
  stmt: Extract<Stmt, { tag: "if_let_stmt" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
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

export function lower_expr_statement(
  stmt: Extract<Stmt, { tag: "expr" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
): IcNode {
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
      lower_statements_with_done,
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

function lower_block_statement(
  expr: Extract<FrontExpr, { tag: "block" }>,
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: StatementDone,
  lower_statements_with_done: LowerStatementsWithDone,
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

  if (
    expr.tag === "struct_update" &&
    is_const_expr_known(expr.base, env, new Set())
  ) {
    return true;
  }

  const expr_type = hooks.infer_expr(expr, env);
  return expr_type.tag === "type";
}
