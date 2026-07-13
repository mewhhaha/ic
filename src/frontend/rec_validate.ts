import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";

export function validate_rec_tail(expr: FrontExpr): void {
  validate_rec_expr(expr, true);
}

function validate_rec_expr(expr: FrontExpr, tail: boolean): void {
  if (is_rec_call(expr)) {
    if (!tail) {
      throw new Error("rec(...) is only valid in tail position");
    }

    return;
  }

  switch (expr.tag) {
    case "bool":
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "prim":
      validate_rec_expr(expr.left, false);
      validate_rec_expr(expr.right, false);
      return;

    case "lam":
    case "rec":
      return;

    case "app":
      validate_rec_expr(expr.func, false);

      for (const arg of expr.args) {
        validate_rec_expr(arg, false);
      }

      return;

    case "block":
      validate_rec_block(expr.statements);
      return;

    case "comptime":
      validate_rec_expr(expr.expr, false);
      return;

    case "borrow":
      validate_rec_expr(expr.value, false);
      return;

    case "freeze":
      validate_rec_expr(expr.value, false);
      return;

    case "scratch":
      validate_rec_expr(expr.body, false);
      return;

    case "loop":
      validate_rec_block(expr.body);
      return;

    case "captured":
      validate_rec_expr(expr.expr, tail);
      return;

    case "with":
      validate_rec_expr(expr.base, false);

      for (const field of expr.fields) {
        validate_rec_expr(field.value, false);
      }

      return;

    case "struct_value":
      validate_rec_expr(expr.type_expr, false);

      for (const field of expr.fields) {
        validate_rec_expr(field.value, false);
      }

      return;

    case "struct_update":
      validate_rec_expr(expr.base, false);

      for (const field of expr.fields) {
        validate_rec_expr(field.value, false);
      }

      return;

    case "if":
      validate_rec_expr(expr.cond, false);
      validate_rec_expr(expr.then_branch, tail);
      validate_rec_expr(expr.else_branch, tail);
      return;

    case "if_let":
      validate_rec_expr(expr.target, false);
      validate_rec_expr(expr.then_branch, tail);
      validate_rec_expr(expr.else_branch, tail);
      return;

    case "field":
      validate_rec_expr(expr.object, false);
      return;

    case "index":
      validate_rec_expr(expr.object, false);
      validate_rec_expr(expr.index, false);
      return;

    case "union_case":
      if (expr.value) {
        validate_rec_expr(expr.value, false);
      }

      return;
  }
}

function validate_rec_block(stmts: Stmt[]): void {
  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing recursive statement " + index);
    const tail = index + 1 >= stmts.length;

    if (stmt.tag === "expr") {
      validate_rec_expr(stmt.expr, tail);
    } else if (stmt.tag === "return") {
      validate_rec_expr(stmt.value, true);
      return;
    } else if (stmt.tag === "bind") {
      validate_rec_expr(stmt.value, false);
    } else if (stmt.tag === "assign") {
      validate_rec_expr(stmt.value, false);
    } else if (stmt.tag === "index_assign") {
      validate_rec_expr(stmt.index, false);
      validate_rec_expr(stmt.value, false);
    } else if (stmt.tag === "for_range") {
      validate_rec_expr(stmt.start, false);
      validate_rec_expr(stmt.end, false);
      validate_rec_expr(stmt.step, false);
      validate_rec_block(stmt.body);
    } else if (stmt.tag === "for_collection") {
      validate_rec_expr(stmt.collection, false);
      validate_rec_block(stmt.body);
    } else if (stmt.tag === "if_stmt") {
      validate_rec_expr(stmt.cond, false);
      validate_rec_block(stmt.body);
    } else if (stmt.tag === "if_let_stmt") {
      validate_rec_expr(stmt.target, false);
      validate_rec_block(stmt.body);
    } else if (stmt.tag === "type_check") {
      validate_rec_expr(stmt.target, false);
    } else if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
    } else if (stmt.tag === "break") {
      if (stmt.value) {
        validate_rec_expr(stmt.value, false);
      }
      return;
    } else if (stmt.tag === "continue") {
      return;
    }
  }
}

export function is_rec_call(expr: FrontExpr): boolean {
  return expr.tag === "app" && expr.func.tag === "var" &&
    expr.func.name === "rec";
}
