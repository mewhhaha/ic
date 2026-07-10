import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import {
  bind_linear_closure,
  clone_linear_closures,
  type LinearClosureEnv,
  merge_used_linear_closures,
} from "./linear_closure.ts";
import type { LinearUseMode } from "./linear_expr.ts";
import {
  expect_same_linear_state,
  linear_block_exits,
} from "./linear_state.ts";

export type LinearStmtLoopOps = {
  consume_condition: (
    expr: FrontExpr,
    available: Set<string>,
    closures: LinearClosureEnv,
    active_calls: Set<string>,
  ) => void;
  consume_expr: (
    expr: FrontExpr,
    available: Set<string>,
    mode: LinearUseMode,
    closures: LinearClosureEnv,
    active_calls: Set<string>,
  ) => string[];
  validate_linear_assignment: (
    stmt: Extract<Stmt, { tag: "assign" }>,
    available: Set<string>,
    closures: LinearClosureEnv,
    active_calls: Set<string>,
  ) => void;
};

export function validate_linear_loop_body(
  stmts: Stmt[],
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  ops: LinearStmtLoopOps,
): void {
  const before = new Set(available);
  const local = new Set(available);
  const local_closures = clone_linear_closures(closures);

  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing loop statement " + index);

    if (stmt.tag === "break" || stmt.tag === "continue") {
      expect_same_linear_state(before, local, stmt.tag);
      expect_same_linear_closure_state(closures, local_closures, stmt.tag);
      return;
    }

    if (stmt.tag === "return") {
      ops.consume_expr(
        stmt.value,
        local,
        "final",
        local_closures,
        active_calls,
      );
      return;
    }

    if (stmt.tag === "assign") {
      ops.validate_linear_assignment(
        stmt,
        local,
        local_closures,
        active_calls,
      );
      bind_linear_closure(local_closures, stmt.name, stmt.value, local);
    } else if (stmt.tag === "index_assign") {
      ops.consume_expr(
        stmt.index,
        local,
        "discard",
        local_closures,
        active_calls,
      );
      ops.validate_linear_assignment(
        { tag: "assign", name: stmt.name, mode: "same", value: stmt.value },
        local,
        local_closures,
        active_calls,
      );
      local_closures.delete(stmt.name);
    } else if (stmt.tag === "expr") {
      ops.consume_expr(
        stmt.expr,
        local,
        "discard",
        local_closures,
        active_calls,
      );
    } else if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        ops.consume_expr(
          stmt.value,
          local,
          "bind",
          local_closures,
          active_calls,
        );
        local.add(stmt.name);
        local_closures.delete(stmt.name);
      } else {
        ops.consume_expr(
          stmt.value,
          local,
          "discard",
          local_closures,
          active_calls,
        );
        bind_linear_closure(local_closures, stmt.name, stmt.value, local);
      }
    } else if (stmt.tag === "for_range") {
      ops.consume_expr(
        stmt.start,
        local,
        "discard",
        local_closures,
        active_calls,
      );
      ops.consume_expr(
        stmt.end,
        local,
        "discard",
        local_closures,
        active_calls,
      );
      ops.consume_expr(
        stmt.step,
        local,
        "discard",
        local_closures,
        active_calls,
      );
      validate_linear_loop_body(
        stmt.body,
        local,
        local_closures,
        active_calls,
        ops,
      );
    } else if (stmt.tag === "for_collection") {
      ops.consume_expr(
        stmt.collection,
        local,
        "discard",
        local_closures,
        active_calls,
      );
      validate_linear_loop_body(
        stmt.body,
        local,
        local_closures,
        active_calls,
        ops,
      );
    } else if (stmt.tag === "if_stmt") {
      ops.consume_condition(stmt.cond, local, local_closures, active_calls);
      validate_linear_no_else_loop_branch(
        stmt.body,
        local,
        local_closures,
        active_calls,
        "if fallthrough",
        ops,
      );
    } else if (stmt.tag === "if_let_stmt") {
      ops.consume_condition(
        stmt.target,
        local,
        local_closures,
        active_calls,
      );
      validate_linear_no_else_loop_branch(
        stmt.body,
        local,
        local_closures,
        active_calls,
        "if let fallthrough",
        ops,
      );
    } else if (stmt.tag === "type_check") {
      ops.consume_expr(
        stmt.target,
        local,
        "discard",
        local_closures,
        active_calls,
      );
    } else if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
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

  expect_same_linear_state(before, local, "fallthrough");
  expect_same_linear_closure_state(closures, local_closures, "fallthrough");
  merge_used_linear_closures(closures, local_closures);
}

export function expect_same_linear_closure_state(
  before: LinearClosureEnv,
  after: LinearClosureEnv,
  edge: string,
): void {
  if (same_linear_closure_used_state(before, after)) {
    return;
  }

  throw new Error(
    "Linear closures must be consumed on every " + edge + " path",
  );
}

function validate_linear_no_else_loop_branch(
  stmts: Stmt[],
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  edge: string,
  ops: LinearStmtLoopOps,
): void {
  const before = new Set(available);
  const branch = new Set(available);
  const branch_closures = clone_linear_closures(closures);
  validate_linear_loop_body(
    stmts,
    branch,
    branch_closures,
    new Set(active_calls),
    ops,
  );

  if (linear_block_exits(stmts)) {
    return;
  }

  expect_same_linear_state(before, branch, edge);
  expect_same_linear_closure_state(closures, branch_closures, edge);
  merge_used_linear_closures(closures, branch_closures);
}

function same_linear_closure_used_state(
  before: LinearClosureEnv,
  after: LinearClosureEnv,
): boolean {
  if (before.used.size !== after.used.size) {
    return false;
  }

  for (const binding of before.used) {
    if (!after.used.has(binding)) {
      return false;
    }
  }

  return true;
}
