import type { FrontExpr, Stmt } from "../ast.ts";

export function expr_contains_linear(expr: FrontExpr): boolean {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "var":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "is":
      return expr_contains_linear(expr.value);

    case "linear":
      return true;

    case "prim":
      return expr_contains_linear(expr.left) ||
        expr_contains_linear(expr.right);

    case "lam":
    case "rec":
      return expr_contains_linear(expr.body);

    case "app":
      if (expr_contains_linear(expr.func)) {
        return true;
      }

      for (const arg of expr.args) {
        if (expr_contains_linear(arg)) {
          return true;
        }
      }

      return false;

    case "block":
      return stmts_contain_linear(expr.statements);

    case "comptime":
      return expr_contains_linear(expr.expr);

    case "borrow":
    case "freeze":
      return expr_contains_linear(expr.value);

    case "scratch":
      return expr_contains_linear(expr.body);

    case "loop":
      return stmts_contain_linear(expr.body);

    case "captured":
      return expr_contains_linear(expr.expr);

    case "handler":
      for (const state of expr.state) {
        if (expr_contains_linear(state.value)) {
          return true;
        }
      }

      for (const clause of expr.clauses) {
        if (expr_contains_linear(clause.body)) {
          return true;
        }
      }

      return expr_contains_linear(expr.return_clause.body);

    case "try_with":
      return expr_contains_linear(expr.body) ||
        expr_contains_linear(expr.handler);

    case "with":
      if (expr_contains_linear(expr.base)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "struct_value":
      if (expr_contains_linear(expr.type_expr)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "struct_update":
      if (expr_contains_linear(expr.base)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "if":
      return expr_contains_linear(expr.cond) ||
        expr_contains_linear(expr.then_branch) ||
        expr_contains_linear(expr.else_branch);

    case "if_let":
      return expr_contains_linear(expr.target) ||
        expr_contains_linear(expr.then_branch) ||
        expr_contains_linear(expr.else_branch);

    case "field":
      return expr_contains_linear(expr.object);

    case "index":
      return expr_contains_linear(expr.object) ||
        expr_contains_linear(expr.index);

    case "union_case":
      if (expr.type_expr && expr_contains_linear(expr.type_expr)) {
        return true;
      }

      if (expr.value && expr_contains_linear(expr.value)) {
        return true;
      }

      return false;
  }
}

function fields_contain_linear(
  fields: Extract<
    FrontExpr,
    { tag: "with" | "struct_value" | "struct_update" }
  >[
    "fields"
  ],
): boolean {
  for (const field of fields) {
    if (expr_contains_linear(field.value)) {
      return true;
    }
  }

  return false;
}

function stmts_contain_linear(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmt_contains_linear(stmt)) {
      return true;
    }
  }

  return false;
}

function stmt_contains_linear(stmt: Stmt): boolean {
  switch (stmt.tag) {
    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return false;

    case "break":
      if (stmt.value) {
        return expr_contains_linear(stmt.value);
      }

      return false;

    case "bind":
    case "assign":
      return expr_contains_linear(stmt.value);

    case "state_bind":
    case "bind_pattern":
      return expr_contains_linear(stmt.value);

    case "resume_dup":
      return expr_contains_linear(stmt.value);

    case "index_assign":
      return expr_contains_linear(stmt.index) ||
        expr_contains_linear(stmt.value);

    case "for_range":
      return expr_contains_linear(stmt.start) ||
        expr_contains_linear(stmt.end) ||
        expr_contains_linear(stmt.step) ||
        stmts_contain_linear(stmt.body);

    case "for_collection":
      return expr_contains_linear(stmt.collection) ||
        stmts_contain_linear(stmt.body);

    case "if_stmt":
      return expr_contains_linear(stmt.cond) ||
        stmts_contain_linear(stmt.body);

    case "if_let_stmt":
      return expr_contains_linear(stmt.target) ||
        stmts_contain_linear(stmt.body);

    case "type_check":
      return expr_contains_linear(stmt.target);

    case "return":
      return expr_contains_linear(stmt.value);

    case "expr":
      return expr_contains_linear(stmt.expr);
  }
}
