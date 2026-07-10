import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import {
  bind_linear_closure,
  clone_linear_closures,
  create_linear_closures,
  type LinearClosureEnv,
  merge_used_linear_closures,
} from "./linear_closure.ts";
import {
  consume_linear_condition as consume_linear_condition_with_hooks,
  consume_linear_expr as consume_linear_expr_with_hooks,
  type LinearExprHooks,
  type LinearUseMode,
} from "./linear_expr.ts";
import {
  expect_same_linear_state,
  linear_block_exits,
} from "./linear_state.ts";
import {
  expect_same_linear_closure_state,
  type LinearStmtLoopOps,
  validate_linear_loop_body as validate_linear_loop_body_with_ops,
} from "./linear_stmt_loop.ts";

const linear_expr_hooks = {
  validate_linear_block,
} satisfies LinearExprHooks;

const linear_stmt_loop_ops = {
  consume_condition,
  consume_expr,
  validate_linear_assignment,
} satisfies LinearStmtLoopOps;

function consume_expr(
  expr: FrontExpr,
  available: Set<string>,
  mode: LinearUseMode,
  closures: LinearClosureEnv,
  active_calls: Set<string> = new Set(),
): string[] {
  return consume_linear_expr_with_hooks(
    expr,
    available,
    mode,
    closures,
    active_calls,
    linear_expr_hooks,
  );
}

function consume_condition(
  expr: FrontExpr,
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
): void {
  consume_linear_condition_with_hooks(
    expr,
    available,
    closures,
    active_calls,
    linear_expr_hooks,
  );
}

export function validate_linear_lam(
  expr: Extract<FrontExpr, { tag: "lam" }>,
): void {
  validate_linear_callable(expr);
}

export function validate_linear_rec(
  expr: Extract<FrontExpr, { tag: "rec" }>,
): void {
  validate_linear_callable(expr);
}

function validate_linear_callable(
  expr:
    | Extract<FrontExpr, { tag: "lam" }>
    | Extract<FrontExpr, { tag: "rec" }>,
): void {
  const available = new Set<string>();
  const closures = create_linear_closures();

  for (const param of expr.params) {
    if (param.is_linear) {
      available.add(param.name);
    }
  }

  if (expr.body.tag === "block") {
    validate_linear_block(expr.body.statements, available, closures);
  } else {
    consume_expr(expr.body, available, "final", closures);
  }

  for (const name of available) {
    throw new Error("Linear value " + name + " was not consumed");
  }
}

export function validate_linear_rest(name: string, stmts: Stmt[]): void {
  const available = new Set<string>([name]);
  const closures = create_linear_closures();
  validate_linear_block(stmts, available, closures);

  for (const item of available) {
    throw new Error("Linear value " + item + " was not consumed");
  }
}

function validate_linear_block(
  stmts: Stmt[],
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string> = new Set(),
): void {
  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing statement " + index);
    const is_final = index + 1 >= stmts.length;

    if (stmt.tag === "assign") {
      validate_linear_assignment(stmt, available, closures, active_calls);
      bind_linear_closure(closures, stmt.name, stmt.value, available);
    } else if (stmt.tag === "index_assign") {
      consume_expr(
        stmt.index,
        available,
        "discard",
        closures,
        active_calls,
      );
      validate_linear_assignment(
        { tag: "assign", name: stmt.name, mode: "same", value: stmt.value },
        available,
        closures,
        active_calls,
      );
      closures.delete(stmt.name);
    } else if (stmt.tag === "expr") {
      if (is_final) {
        consume_expr(
          stmt.expr,
          available,
          "final",
          closures,
          active_calls,
        );
      } else {
        consume_expr(
          stmt.expr,
          available,
          "discard",
          closures,
          active_calls,
        );
      }
    } else if (stmt.tag === "return") {
      consume_expr(
        stmt.value,
        available,
        "final",
        closures,
        active_calls,
      );
      return;
    } else if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        consume_expr(
          stmt.value,
          available,
          "bind",
          closures,
          active_calls,
        );
        available.add(stmt.name);
        closures.delete(stmt.name);
      } else {
        consume_expr(
          stmt.value,
          available,
          "discard",
          closures,
          active_calls,
        );
        bind_linear_closure(closures, stmt.name, stmt.value, available);
      }
    } else if (stmt.tag === "for_range") {
      consume_expr(
        stmt.start,
        available,
        "discard",
        closures,
        active_calls,
      );
      consume_expr(
        stmt.end,
        available,
        "discard",
        closures,
        active_calls,
      );
      consume_expr(
        stmt.step,
        available,
        "discard",
        closures,
        active_calls,
      );
      validate_linear_loop_body_with_ops(
        stmt.body,
        available,
        closures,
        active_calls,
        linear_stmt_loop_ops,
      );
    } else if (stmt.tag === "for_collection") {
      consume_expr(
        stmt.collection,
        available,
        "discard",
        closures,
        active_calls,
      );
      validate_linear_loop_body_with_ops(
        stmt.body,
        available,
        closures,
        active_calls,
        linear_stmt_loop_ops,
      );
    } else if (stmt.tag === "if_stmt") {
      consume_condition(stmt.cond, available, closures, active_calls);
      validate_linear_no_else_branch(
        stmt.body,
        available,
        closures,
        active_calls,
        "if fallthrough",
      );
    } else if (stmt.tag === "if_let_stmt") {
      consume_condition(stmt.target, available, closures, active_calls);
      validate_linear_no_else_branch(
        stmt.body,
        available,
        closures,
        active_calls,
        "if let fallthrough",
      );
    } else if (stmt.tag === "type_check") {
      consume_expr(
        stmt.target,
        available,
        "discard",
        closures,
        active_calls,
      );
    } else if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
    } else if (stmt.tag === "break") {
      throw new Error("Cannot lower break outside static range loop");
    } else if (stmt.tag === "continue") {
      throw new Error("Cannot lower continue outside static range loop");
    } else if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
      throw new Error("Cannot validate linear " + stmt.tag + " yet");
    } else if (stmt.tag === "resume_dup") {
      throw new Error(
        "Resumption duplication must be elaborated before linear validation",
      );
    } else {
      throw new Error("Cannot validate linear " + stmt.feature + " yet");
    }
  }
}

function validate_linear_no_else_branch(
  stmts: Stmt[],
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  edge: string,
): void {
  const before = new Set(available);
  const branch = new Set(available);
  const branch_closures = clone_linear_closures(closures);
  validate_linear_block(
    stmts,
    branch,
    branch_closures,
    new Set(active_calls),
  );

  if (linear_block_exits(stmts)) {
    return;
  }

  expect_same_linear_state(before, branch, edge);
  expect_same_linear_closure_state(closures, branch_closures, edge);
  merge_used_linear_closures(closures, branch_closures);
}

function validate_linear_assignment(
  stmt: Extract<Stmt, { tag: "assign" }>,
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
): void {
  const was_available = available.has(stmt.name);
  const consumed = consume_expr(
    stmt.value,
    available,
    "assignment",
    closures,
    active_calls,
  );

  if (consumed.length > 0) {
    expect(
      consumed.length === 1,
      "Linear assignment must consume exactly one value",
    );
    const name = consumed[0];
    expect(name, "Missing consumed linear value");

    if (name !== stmt.name) {
      throw new Error(
        "Linear value " + name + " must be rebound as " + name,
      );
    }

    available.add(stmt.name);
  } else if (was_available) {
    throw new Error(
      "Linear value " + stmt.name + " was rebound without being consumed",
    );
  }
}
