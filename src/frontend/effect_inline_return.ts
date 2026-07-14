import type { FrontExpr, Stmt } from "./ast.ts";

// Effect elaboration inlines effectful helper calls by splicing the helper
// body in as a block expression. A `return` inside that body must exit the
// helper, not the function the block was inlined into, so early returns are
// rewritten into structured branches before substitution: a bare `return`
// truncates the statement list, and a branch statement containing a return
// turns the remaining statements into the implicit other branch.
export function scope_inlined_returns(body: FrontExpr): FrontExpr {
  if (body.tag !== "block") {
    return body;
  }

  if (!stmts_contain_return(body.statements)) {
    return body;
  }

  return { tag: "block", statements: scope_return_stmts(body.statements) };
}

function scope_return_stmts(statements: Stmt[]): Stmt[] {
  const scoped: Stmt[] = [];

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      continue;
    }

    if (stmt.tag === "return") {
      scoped.push({ tag: "expr", expr: stmt.value });
      return scoped;
    }

    if (stmt.tag === "if_stmt" && stmts_contain_return(stmt.body)) {
      const rest = statements.slice(index + 1);
      scoped.push({
        tag: "expr",
        expr: {
          tag: "if",
          cond: stmt.cond,
          then_branch: {
            tag: "block",
            statements: scope_return_stmts([...stmt.body, ...rest]),
          },
          else_branch: {
            tag: "block",
            statements: scope_return_stmts(rest),
          },
        },
      });
      return scoped;
    }

    if (stmt.tag === "if_let_stmt" && stmts_contain_return(stmt.body)) {
      const rest = statements.slice(index + 1);
      scoped.push({
        tag: "expr",
        expr: {
          tag: "if_let",
          case_name: stmt.case_name,
          value_name: stmt.value_name,
          target: stmt.target,
          then_branch: {
            tag: "block",
            statements: scope_return_stmts([...stmt.body, ...rest]),
          },
          else_branch: {
            tag: "block",
            statements: scope_return_stmts(rest),
          },
        },
      });
      return scoped;
    }

    if (stmt_contains_return(stmt)) {
      throw new Error(
        "Effectful helper return inside a " + stmt.tag +
          " statement is not supported yet",
      );
    }

    scoped.push(stmt);
  }

  return scoped;
}

function stmts_contain_return(statements: Stmt[]): boolean {
  return statements.some((stmt) => stmt_contains_return(stmt));
}

function stmt_contains_return(stmt: Stmt): boolean {
  switch (stmt.tag) {
    case "return":
      return true;

    case "if_stmt":
    case "if_let_stmt":
    case "for_range":
    case "for_collection":
      return stmts_contain_return(stmt.body);

    case "bind":
    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
    case "assign":
      return expr_contains_return(stmt.value);

    case "index_assign":
      return expr_contains_return(stmt.index) ||
        expr_contains_return(stmt.value);

    case "type_check":
      return expr_contains_return(stmt.target);

    case "break":
      if (stmt.value === undefined) {
        return false;
      }

      return expr_contains_return(stmt.value);

    case "expr":
      return expr_contains_return(stmt.expr);

    default:
      return false;
  }
}

function expr_contains_return(expr: FrontExpr): boolean {
  switch (expr.tag) {
    case "block":
    case "loop":
      if (expr.tag === "loop") {
        return stmts_contain_return(expr.body);
      }

      return stmts_contain_return(expr.statements);

    case "if":
      return expr_contains_return(expr.cond) ||
        expr_contains_return(expr.then_branch) ||
        expr_contains_return(expr.else_branch);

    case "if_let":
      return expr_contains_return(expr.target) ||
        expr_contains_return(expr.then_branch) ||
        expr_contains_return(expr.else_branch);

    case "app":
      if (expr_contains_return(expr.func)) {
        return true;
      }

      return expr.args.some((arg) => expr_contains_return(arg));

    case "prim":
      return expr_contains_return(expr.left) ||
        expr_contains_return(expr.right);

    case "product":
      return expr.entries.some((entry) => expr_contains_return(entry.value));

    case "array":
      if (expr.items.some(expr_contains_return)) {
        return true;
      }

      if (expr.rest !== undefined) {
        return expr_contains_return(expr.rest);
      }

      return false;

    case "array_repeat":
      return expr_contains_return(expr.value) ||
        expr_contains_return(expr.length);

    case "match":
      if (expr_contains_return(expr.target)) {
        return true;
      }

      for (const arm of expr.arms) {
        if (arm.guard !== undefined && expr_contains_return(arm.guard)) {
          return true;
        }

        if (expr_contains_return(arm.body)) {
          return true;
        }
      }

      return false;

    case "comptime":
    case "borrow":
    case "freeze":
      if (expr.tag === "comptime") {
        return expr_contains_return(expr.expr);
      }

      return expr_contains_return(expr.value);

    case "scratch":
      return expr_contains_return(expr.body);

    case "captured":
      return expr_contains_return(expr.expr);

    case "try_with":
      return expr_contains_return(expr.body) ||
        expr_contains_return(expr.handler);

    case "with":
    case "struct_update":
      if (expr_contains_return(expr.base)) {
        return true;
      }

      return expr.fields.some((field) => expr_contains_return(field.value));

    case "struct_value":
      if (expr_contains_return(expr.type_expr)) {
        return true;
      }

      return expr.fields.some((field) => expr_contains_return(field.value));

    case "field":
      return expr_contains_return(expr.object);

    case "index":
      return expr_contains_return(expr.object) ||
        expr_contains_return(expr.index);

    case "is":
    case "as":
      return expr_contains_return(expr.value);

    case "union_case":
      if (
        expr.type_expr !== undefined && expr_contains_return(expr.type_expr)
      ) {
        return true;
      }

      if (expr.value !== undefined) {
        return expr_contains_return(expr.value);
      }

      return false;

    default:
      // Nested lam/rec/handler bodies own their returns; other leaves
      // cannot carry statements.
      return false;
  }
}
