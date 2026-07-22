import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { capture_expr } from "../capture.ts";
import { clone_env } from "../env.ts";
import {
  bind_loop_static_value,
  continues_range,
  record_static_loop_statement,
  record_static_loop_statements,
} from "./binding.ts";
import {
  contains_loop_control,
  expr_contains_loop_control,
} from "./dynamic_control.ts";
import { bind_static_if_let_payload } from "./if_let_payload.ts";
import type {
  CollectionLoopItem,
  ExpandedLoopBody,
  ForCollectionStmt,
  StaticLoopHooks,
} from "./types.ts";

export type StaticLoopBodyExpanders = {
  expand_for_range_body: (
    stmt: Extract<Stmt, { tag: "for_range" }>,
    env: Env,
    hooks: StaticLoopHooks,
  ) => ExpandedLoopBody;
  expand_for_collection_body: (
    stmt: ForCollectionStmt,
    env: Env,
    hooks: StaticLoopHooks,
  ) => ExpandedLoopBody;
};

export function expand_static_loop_body(
  stmts: Stmt[],
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): ExpandedLoopBody {
  const statements: Stmt[] = [];

  for (const stmt of stmts) {
    if (stmt.tag === "break") {
      return { statements, control: "break" };
    }

    if (stmt.tag === "continue") {
      return { statements, control: "continue" };
    }

    if (stmt.tag === "return") {
      statements.push(stmt);
      return { statements, control: "return" };
    }

    if (stmt.tag === "if_stmt") {
      const cond = hooks.resolve_static_i32_expr(stmt.cond, env);

      if (cond !== undefined) {
        if (cond !== 0) {
          const body = expand_static_loop_body(
            stmt.body,
            env,
            hooks,
            expanders,
          );
          statements.push(...body.statements);

          if (body.control !== "none") {
            return { statements, control: body.control };
          }
        }

        continue;
      }

      if (contains_loop_control(stmt.body)) {
        throw new Error(
          "Cannot lower dynamic conditional break or continue in static loop yet",
        );
      }
    }

    if (stmt.tag === "if_let_stmt") {
      const target = hooks.resolve_union_value(stmt.target, env);

      if (target) {
        if (target.expr.name !== stmt.case_name) {
          continue;
        }

        const body = expand_static_if_let_body(
          stmt,
          target,
          env,
          hooks,
          expanders,
        );
        statements.push(...body.statements);

        if (body.control !== "none") {
          return { statements, control: body.control };
        }

        continue;
      }

      if (contains_loop_control(stmt.body)) {
        throw new Error(
          "Cannot lower dynamic conditional break or continue in static loop yet",
        );
      }
    }

    if (stmt.tag === "expr" && expr_contains_loop_control(stmt.expr)) {
      const body = expand_static_loop_control_expr(
        stmt.expr,
        env,
        hooks,
        expanders,
      );
      statements.push(...body.statements);

      if (body.control !== "none") {
        return { statements, control: body.control };
      }

      continue;
    }

    if (stmt.tag === "for_range") {
      const body = expanders.expand_for_range_body(stmt, env, hooks);
      statements.push(...body.statements);
      record_static_loop_statements(body.statements, env);

      if (body.control === "return") {
        return { statements, control: "return" };
      }

      continue;
    }

    if (stmt.tag === "for_collection") {
      const body = expanders.expand_for_collection_body(stmt, env, hooks);
      statements.push(...body.statements);
      record_static_loop_statements(body.statements, env);

      if (body.control === "return") {
        return { statements, control: "return" };
      }

      continue;
    }

    statements.push(stmt);
    record_static_loop_statement(stmt, env);
  }

  return { statements, control: "none" };
}

export function range_body_needs_dynamic_loop_control(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  env: Env,
  hooks: StaticLoopHooks,
  start: number,
  end: number,
  step: number,
  expanders: StaticLoopBodyExpanders,
): boolean {
  let current = start;

  while (continues_range(current, end, step, stmt.end_bound)) {
    const loop_env = clone_env(env);
    bind_loop_static_value(
      loop_env,
      stmt.index,
      { tag: "num", type: "i32", value: current },
    );

    if (
      body_needs_dynamic_loop_control(stmt.body, loop_env, hooks, expanders)
    ) {
      return true;
    }

    current += step;
  }

  return false;
}

export function collection_body_needs_dynamic_loop_control(
  stmt: ForCollectionStmt,
  env: Env,
  hooks: StaticLoopHooks,
  items: CollectionLoopItem[],
  bind_collection_loop_item: (
    loop_env: Env,
    stmt: ForCollectionStmt,
    item: CollectionLoopItem,
  ) => void,
  expanders: StaticLoopBodyExpanders,
): boolean {
  for (const item of items) {
    const loop_env = clone_env(env);
    bind_collection_loop_item(loop_env, stmt, item);

    if (
      body_needs_dynamic_loop_control(stmt.body, loop_env, hooks, expanders)
    ) {
      return true;
    }
  }

  return false;
}

function body_needs_dynamic_loop_control(
  stmts: Stmt[],
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): boolean {
  for (const stmt of stmts) {
    if (
      stmt.tag === "break" || stmt.tag === "continue" ||
      stmt.tag === "return"
    ) {
      return false;
    }

    if (stmt.tag === "for_range") {
      const nested = expanders.expand_for_range_body(
        stmt,
        clone_env(env),
        hooks,
      );

      if (nested.control === "return") {
        return false;
      }

      continue;
    }

    if (stmt.tag === "for_collection") {
      const nested = expanders.expand_for_collection_body(
        stmt,
        clone_env(env),
        hooks,
      );

      if (nested.control === "return") {
        return false;
      }

      continue;
    }

    if (stmt.tag === "if_stmt") {
      const cond = hooks.resolve_static_i32_expr(stmt.cond, env);

      if (cond !== undefined) {
        if (
          cond !== 0 && body_needs_dynamic_loop_control(
            stmt.body,
            env,
            hooks,
            expanders,
          )
        ) {
          return true;
        }

        continue;
      }

      if (contains_loop_control(stmt.body)) {
        return true;
      }

      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      const target = hooks.resolve_union_value(stmt.target, env);

      if (target) {
        if (
          target.expr.name === stmt.case_name &&
          static_if_let_body_needs_dynamic_loop_control(
            stmt,
            target,
            env,
            hooks,
            expanders,
          )
        ) {
          return true;
        }

        continue;
      }

      if (contains_loop_control(stmt.body)) {
        return true;
      }

      continue;
    }

    if (stmt.tag === "expr" && expr_contains_loop_control(stmt.expr)) {
      if (
        expr_needs_dynamic_loop_control(stmt.expr, env, hooks, expanders)
      ) {
        return true;
      }

      continue;
    }

    record_static_loop_statement(stmt, env);
  }

  return false;
}

function expr_needs_dynamic_loop_control(
  expr: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): boolean {
  if (expr.tag === "block") {
    return body_needs_dynamic_loop_control(
      expr.statements,
      env,
      hooks,
      expanders,
    );
  }

  if (expr.tag === "if") {
    const cond = hooks.resolve_static_i32_expr(expr.cond, env);

    if (cond === undefined) {
      return expr_contains_loop_control(expr.then_branch) ||
        expr_contains_loop_control(expr.else_branch);
    }

    if (cond !== 0) {
      return expr_needs_dynamic_loop_control(
        expr.then_branch,
        env,
        hooks,
        expanders,
      );
    }

    return expr_needs_dynamic_loop_control(
      expr.else_branch,
      env,
      hooks,
      expanders,
    );
  }

  if (expr.tag === "if_let") {
    const target = hooks.resolve_union_value(expr.target, env);

    if (!target) {
      return expr_contains_loop_control(expr.then_branch) ||
        expr_contains_loop_control(expr.else_branch);
    }

    if (target.expr.name !== expr.case_name) {
      return expr_needs_dynamic_loop_control(
        expr.else_branch,
        env,
        hooks,
        expanders,
      );
    }

    const branch_env = static_if_let_expr_branch_env(expr, target, env, hooks);
    return expr_needs_dynamic_loop_control(
      expr.then_branch,
      branch_env,
      hooks,
      expanders,
    );
  }

  return expr_contains_loop_control(expr);
}

function expand_static_loop_control_expr(
  expr: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): ExpandedLoopBody {
  if (expr.tag === "block") {
    return expand_static_loop_body(expr.statements, env, hooks, expanders);
  }

  if (expr.tag === "if") {
    const cond = hooks.resolve_static_i32_expr(expr.cond, env);

    if (cond === undefined) {
      throw new Error(
        "Cannot lower dynamic conditional break or continue in static loop yet",
      );
    }

    if (cond !== 0) {
      return expand_static_loop_control_expr(
        expr.then_branch,
        env,
        hooks,
        expanders,
      );
    }

    return expand_static_loop_control_expr(
      expr.else_branch,
      env,
      hooks,
      expanders,
    );
  }

  if (expr.tag === "if_let") {
    const target = hooks.resolve_union_value(expr.target, env);

    if (!target) {
      throw new Error(
        "Cannot lower dynamic conditional break or continue in static loop yet",
      );
    }

    if (target.expr.name !== expr.case_name) {
      return expand_static_loop_control_expr(
        expr.else_branch,
        env,
        hooks,
        expanders,
      );
    }

    const branch_env = static_if_let_expr_branch_env(expr, target, env, hooks);
    return expand_static_loop_control_expr(
      expr.then_branch,
      branch_env,
      hooks,
      expanders,
    );
  }

  return {
    statements: [{ tag: "expr", expr }],
    control: "none",
  };
}

function static_if_let_expr_branch_env(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env },
  env: Env,
  hooks: StaticLoopHooks,
): Env {
  if (!expr.value_name) {
    return env;
  }

  const stmt: Extract<Stmt, { tag: "if_let_stmt" }> = {
    tag: "if_let_stmt",
    case_name: expr.case_name,
    value_name: expr.value_name,
    target: expr.target,
    body: [],
  };
  const branch_env = clone_env(env);
  bind_static_if_let_payload(stmt, target, branch_env, hooks);
  return branch_env;
}

function static_if_let_body_needs_dynamic_loop_control(
  stmt: Extract<Stmt, { tag: "if_let_stmt" }>,
  target: { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env },
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): boolean {
  if (!stmt.value_name) {
    return body_needs_dynamic_loop_control(stmt.body, env, hooks, expanders);
  }

  const body_env = clone_env(env);
  bind_static_if_let_payload(stmt, target, body_env, hooks);
  return body_needs_dynamic_loop_control(
    stmt.body,
    body_env,
    hooks,
    expanders,
  );
}

function expand_static_if_let_body(
  stmt: Extract<Stmt, { tag: "if_let_stmt" }>,
  target: { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env },
  env: Env,
  hooks: StaticLoopHooks,
  expanders: StaticLoopBodyExpanders,
): ExpandedLoopBody {
  if (!stmt.value_name) {
    return expand_static_loop_body(stmt.body, env, hooks, expanders);
  }

  const value = target.expr.value;

  if (!value) {
    throw new Error("Union case has no payload: " + stmt.case_name);
  }

  let value_expr = capture_expr(value, target.env);
  const static_i32 = hooks.resolve_static_i32_expr(value, target.env);

  if (static_i32 !== undefined) {
    value_expr = { tag: "num", type: "i32", value: static_i32 };
  }

  return expand_static_loop_body(
    [
      {
        tag: "bind",
        kind: "let",
        name: stmt.value_name,
        is_linear: false,
        annotation: undefined,
        value: value_expr,
      },
      ...stmt.body,
    ],
    env,
    hooks,
    expanders,
  );
}
