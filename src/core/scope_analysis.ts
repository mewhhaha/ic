import { expect } from "../expect.ts";
import type { CoreExpr, CoreField, CoreStmt } from "./ast.ts";

export function core_expr_has_static_call_statement_scope(
  expr: CoreExpr,
): boolean {
  if (!expr) return false;
  switch (expr.tag) {
    case "block":
      return core_block_has_static_call_statement_scope(expr.statements);

    case "prim":
      for (const arg of expr.args) {
        if (core_expr_has_static_call_statement_scope(arg)) {
          return true;
        }
      }

      return false;

    case "lam":
    case "rec":
      return core_expr_has_static_call_statement_scope(expr.body);

    case "rec_ref":
      return false;

    case "app":
      if (core_expr_has_static_call_statement_scope(expr.func)) {
        return true;
      }

      for (const arg of expr.args) {
        if (core_expr_has_static_call_statement_scope(arg)) {
          return true;
        }
      }

      return false;

    case "comptime":
      return core_expr_has_static_call_statement_scope(expr.expr);

    case "borrow":
      return core_expr_has_static_call_statement_scope(expr.value);

    case "freeze":
      return core_expr_has_static_call_statement_scope(expr.value);

    case "scratch":
      return core_expr_has_static_call_statement_scope(expr.body);

    case "with":
      if (core_expr_has_static_call_statement_scope(expr.base)) {
        return true;
      }

      return core_fields_have_static_call_statement_scope(expr.fields);

    case "struct_value":
      if (core_expr_has_static_call_statement_scope(expr.type_expr)) {
        return true;
      }

      return core_fields_have_static_call_statement_scope(expr.fields);

    case "struct_update":
      if (core_expr_has_static_call_statement_scope(expr.base)) {
        return true;
      }

      return core_fields_have_static_call_statement_scope(expr.fields);

    case "if":
      return core_expr_has_static_call_statement_scope(expr.cond) ||
        core_expr_has_static_call_statement_scope(expr.then_branch) ||
        core_expr_has_static_call_statement_scope(expr.else_branch);

    case "if_let":
      return core_expr_has_static_call_statement_scope(expr.target) ||
        core_expr_has_static_call_statement_scope(expr.then_branch) ||
        core_expr_has_static_call_statement_scope(expr.else_branch);

    case "field":
      return core_expr_has_static_call_statement_scope(expr.object);

    case "index":
      return core_expr_has_static_call_statement_scope(expr.object) ||
        core_expr_has_static_call_statement_scope(expr.index);

    case "union_case":
      if (expr.value) {
        if (core_expr_has_static_call_statement_scope(expr.value)) {
          return true;
        }
      }

      if (expr.type_expr) {
        return core_expr_has_static_call_statement_scope(expr.type_expr);
      }

      return false;

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;
  }
}

export function core_expr_assigns_name(
  expr: CoreExpr,
  name: string,
): boolean {
  switch (expr.tag) {
    case "block":
      return core_block_assigns_name(expr.statements, name);

    case "prim":
      for (const arg of expr.args) {
        if (core_expr_assigns_name(arg, name)) {
          return true;
        }
      }

      return false;

    case "lam":
    case "rec":
    case "rec_ref":
      for (const param of expr.params) {
        if (param.name === name) {
          return false;
        }
      }

      return core_expr_assigns_name(expr.body, name);

    case "app":
      if (core_expr_assigns_name(expr.func, name)) {
        return true;
      }

      for (const arg of expr.args) {
        if (core_expr_assigns_name(arg, name)) {
          return true;
        }
      }

      return false;

    case "comptime":
      return core_expr_assigns_name(expr.expr, name);

    case "borrow":
      return core_expr_assigns_name(expr.value, name);

    case "freeze":
      return core_expr_assigns_name(expr.value, name);

    case "scratch":
      return core_expr_assigns_name(expr.body, name);

    case "with":
      if (core_expr_assigns_name(expr.base, name)) {
        return true;
      }

      return core_fields_assign_name(expr.fields, name);

    case "struct_value":
      if (core_expr_assigns_name(expr.type_expr, name)) {
        return true;
      }

      return core_fields_assign_name(expr.fields, name);

    case "struct_update":
      if (core_expr_assigns_name(expr.base, name)) {
        return true;
      }

      return core_fields_assign_name(expr.fields, name);

    case "if":
      return core_expr_assigns_name(expr.cond, name) ||
        core_expr_assigns_name(expr.then_branch, name) ||
        core_expr_assigns_name(expr.else_branch, name);

    case "if_let":
      if (core_expr_assigns_name(expr.target, name)) {
        return true;
      }

      if (core_expr_assigns_name(expr.else_branch, name)) {
        return true;
      }

      if (expr.value_name === name) {
        return false;
      }

      return core_expr_assigns_name(expr.then_branch, name);

    case "field":
      return core_expr_assigns_name(expr.object, name);

    case "index":
      return core_expr_assigns_name(expr.object, name) ||
        core_expr_assigns_name(expr.index, name);

    case "union_case":
      if (expr.value) {
        if (core_expr_assigns_name(expr.value, name)) {
          return true;
        }
      }

      if (expr.type_expr) {
        return core_expr_assigns_name(expr.type_expr, name);
      }

      return false;

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;
  }
}

function core_block_has_static_call_statement_scope(
  statements: CoreStmt[],
): boolean {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    expect(stmt, "Missing core static call statement " + index.toString());
    const is_final = index + 1 >= statements.length;

    if (!is_final) {
      return true;
    }

    if (stmt.tag === "expr") {
      return core_expr_has_static_call_statement_scope(stmt.expr);
    }

    if (stmt.tag === "return") {
      return core_expr_has_static_call_statement_scope(stmt.value);
    }
  }

  return false;
}

function core_fields_have_static_call_statement_scope(
  fields: CoreField[],
): boolean {
  for (const field of fields) {
    if (core_expr_has_static_call_statement_scope(field.value)) {
      return true;
    }
  }

  return false;
}

function core_block_assigns_name(stmts: CoreStmt[], name: string): boolean {
  for (const stmt of stmts) {
    if (core_stmt_assigns_name(stmt, name)) {
      return true;
    }

    if (stmt.tag === "bind" && stmt.name === name) {
      return false;
    }
  }

  return false;
}

function core_stmt_assigns_name(stmt: CoreStmt, name: string): boolean {
  switch (stmt.tag) {
    case "bind":
      return core_expr_assigns_name(stmt.value, name);

    case "assign":
      if (stmt.name === name) {
        return true;
      }

      return core_expr_assigns_name(stmt.value, name);

    case "index_assign":
      if (stmt.name === name) {
        return true;
      }

      return core_expr_assigns_name(stmt.index, name) ||
        core_expr_assigns_name(stmt.value, name);

    case "range_loop":
      if (core_expr_assigns_name(stmt.start, name)) {
        return true;
      }

      if (core_expr_assigns_name(stmt.end, name)) {
        return true;
      }

      if (core_expr_assigns_name(stmt.step, name)) {
        return true;
      }

      if (stmt.index === name) {
        return false;
      }

      return core_block_assigns_name(stmt.body, name);

    case "collection_loop":
      if (core_expr_assigns_name(stmt.collection, name)) {
        return true;
      }

      if (stmt.item === name || stmt.index === name) {
        return false;
      }

      return core_block_assigns_name(stmt.body, name);

    case "if_stmt":
      return core_expr_assigns_name(stmt.cond, name) ||
        core_block_assigns_name(stmt.body, name);

    case "if_else_stmt":
      return core_expr_assigns_name(stmt.cond, name) ||
        core_block_assigns_name(stmt.then_body, name) ||
        core_block_assigns_name(stmt.else_body, name);

    case "if_let_stmt":
      if (core_expr_assigns_name(stmt.target, name)) {
        return true;
      }

      if (stmt.value_name === name) {
        return false;
      }

      return core_block_assigns_name(stmt.body, name);

    case "type_check":
      return core_expr_assigns_name(stmt.target, name);

    case "return":
      return core_expr_assigns_name(stmt.value, name);

    case "expr":
      return core_expr_assigns_name(stmt.expr, name);

    case "break":
    case "continue":
    case "unsupported":
      return false;
  }
}

function core_fields_assign_name(fields: CoreField[], name: string): boolean {
  for (const field of fields) {
    if (core_expr_assigns_name(field.value, name)) {
      return true;
    }
  }

  return false;
}
