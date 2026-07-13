import { expect } from "../../expect.ts";
import type { FrontExpr, Stmt } from "../ast.ts";

export type DynamicLoopState = {
  active_name: string;
  step_name: string;
};

export function guard_loop_step(
  state: DynamicLoopState,
  body: Stmt[],
): Extract<Stmt, { tag: "if_stmt" }> {
  return {
    tag: "if_stmt",
    cond: { tag: "var", name: state.step_name },
    body,
  };
}

export function loop_break_statements(state: DynamicLoopState): Stmt[] {
  return [
    {
      tag: "assign",
      name: state.active_name,
      mode: "same",
      value: { tag: "num", type: "i32", value: 0 },
    },
    {
      tag: "assign",
      name: state.step_name,
      mode: "same",
      value: { tag: "num", type: "i32", value: 0 },
    },
  ];
}

export function loop_continue_statements(
  state: DynamicLoopState,
): Stmt[] {
  return [
    {
      tag: "assign",
      name: state.step_name,
      mode: "same",
      value: { tag: "num", type: "i32", value: 0 },
    },
  ];
}

export function dynamic_conditional_loop_control_body(
  stmts: Stmt[],
  state: DynamicLoopState,
): Stmt[] | undefined {
  if (stmts.length === 0) {
    return undefined;
  }

  const last_index = stmts.length - 1;
  const stmt = stmts[last_index];
  expect(stmt, "Missing loop control statement");
  const prefix = stmts.slice(0, last_index);

  if (!can_lower_dynamic_control_prefix(prefix)) {
    return undefined;
  }

  const terminal = dynamic_loop_control_terminal(stmt, state);

  if (!terminal) {
    return undefined;
  }

  return [...prefix, ...terminal];
}

function dynamic_loop_control_terminal(
  stmt: Stmt,
  state: DynamicLoopState,
): Stmt[] | undefined {
  if (stmt.tag === "break") {
    if (stmt.value) {
      return undefined;
    }

    return loop_break_statements(state);
  }

  if (stmt.tag === "continue") {
    return loop_continue_statements(state);
  }

  if (stmt.tag === "if_stmt") {
    const body = dynamic_conditional_loop_control_body(stmt.body, state);

    if (!body) {
      return undefined;
    }

    return [{
      tag: "if_stmt",
      cond: stmt.cond,
      body,
    }];
  }

  if (stmt.tag === "if_let_stmt") {
    const body = dynamic_conditional_loop_control_body(stmt.body, state);

    if (!body) {
      return undefined;
    }

    return [{
      tag: "if_let_stmt",
      case_name: stmt.case_name,
      value_name: stmt.value_name,
      target: stmt.target,
      body,
    }];
  }

  return undefined;
}

function can_lower_dynamic_control_prefix(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (contains_loop_control([stmt])) {
      return false;
    }

    if (
      stmt.tag === "bind" ||
      stmt.tag === "assign" ||
      stmt.tag === "index_assign" ||
      stmt.tag === "expr"
    ) {
      if (stmt_value_contains_loop_control(stmt)) {
        return false;
      }

      continue;
    }

    return false;
  }

  return true;
}

export function stmt_value_contains_loop_control(stmt: Stmt): boolean {
  if (stmt.tag === "bind" || stmt.tag === "assign") {
    return expr_contains_loop_control(stmt.value);
  }

  if (stmt.tag === "resume_dup") {
    return expr_contains_loop_control(stmt.value);
  }

  if (stmt.tag === "index_assign") {
    return expr_contains_loop_control(stmt.index) ||
      expr_contains_loop_control(stmt.value);
  }

  if (stmt.tag === "expr") {
    return expr_contains_loop_control(stmt.expr);
  }

  return false;
}

function expr_contains_loop_control(expr: FrontExpr): boolean {
  switch (expr.tag) {
    case "block":
      return contains_loop_control(expr.statements);

    case "prim":
      return expr_contains_loop_control(expr.left) ||
        expr_contains_loop_control(expr.right);

    case "app":
      if (expr_contains_loop_control(expr.func)) {
        return true;
      }

      for (const arg of expr.args) {
        if (expr_contains_loop_control(arg)) {
          return true;
        }
      }

      return false;

    case "field":
      return expr_contains_loop_control(expr.object);

    case "index":
      return expr_contains_loop_control(expr.object) ||
        expr_contains_loop_control(expr.index);

    case "struct_value":
      if (expr_contains_loop_control(expr.type_expr)) {
        return true;
      }

      for (const field of expr.fields) {
        if (expr_contains_loop_control(field.value)) {
          return true;
        }
      }

      return false;

    case "struct_update":
      if (expr_contains_loop_control(expr.base)) {
        return true;
      }

      for (const field of expr.fields) {
        if (expr_contains_loop_control(field.value)) {
          return true;
        }
      }

      return false;

    case "union_case":
      if (expr.type_expr && expr_contains_loop_control(expr.type_expr)) {
        return true;
      }

      if (expr.value) {
        return expr_contains_loop_control(expr.value);
      }

      return false;

    case "if":
      return expr_contains_loop_control(expr.cond) ||
        expr_contains_loop_control(expr.then_branch) ||
        expr_contains_loop_control(expr.else_branch);

    case "if_let":
      return expr_contains_loop_control(expr.target) ||
        expr_contains_loop_control(expr.then_branch) ||
        expr_contains_loop_control(expr.else_branch);

    case "with":
      return expr_contains_loop_control(expr.base);

    case "comptime":
      return expr_contains_loop_control(expr.expr);

    case "borrow":
      return expr_contains_loop_control(expr.value);

    case "freeze":
      return expr_contains_loop_control(expr.value);

    case "scratch":
      return expr_contains_loop_control(expr.body);

    case "loop":
      return false;

    case "lam":
      return expr_contains_loop_control(expr.body);

    case "rec":
      return expr_contains_loop_control(expr.body);

    case "handler":
      for (const state of expr.state) {
        if (expr_contains_loop_control(state.value)) {
          return true;
        }
      }

      for (const clause of expr.clauses) {
        if (expr_contains_loop_control(clause.body)) {
          return true;
        }
      }

      return expr_contains_loop_control(expr.return_clause.body);

    case "try_with":
      return expr_contains_loop_control(expr.body) ||
        expr_contains_loop_control(expr.handler);

    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "var":
    case "linear":
    case "type_name":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "captured":
    case "unsupported":
      return false;

    case "is":
      return expr_contains_loop_control(expr.value);
  }
}

export function contains_loop_control(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmt.tag === "break" || stmt.tag === "continue") {
      return true;
    }

    if (stmt.tag === "if_stmt") {
      if (contains_loop_control(stmt.body)) {
        return true;
      }
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      if (contains_loop_control(stmt.body)) {
        return true;
      }
      continue;
    }

    if (stmt.tag === "expr" && stmt.expr.tag === "block") {
      if (contains_loop_control(stmt.expr.statements)) {
        return true;
      }
      continue;
    }

    if (stmt.tag === "return" && stmt.value.tag === "block") {
      if (contains_loop_control(stmt.value.statements)) {
        return true;
      }
    }

    if (stmt.tag === "resume_dup") {
      if (expr_contains_loop_control(stmt.value)) {
        return true;
      }
    }
  }

  return false;
}
