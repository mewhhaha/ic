import type { CoreStmt } from "../ast.ts";

export function core_stmts_definitely_exit_sequence(
  statements: CoreStmt[],
): boolean {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core control-flow statement " + index);
    }

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return true;
    }
  }

  return false;
}

export function core_stmt_definitely_exits_sequence(stmt: CoreStmt): boolean {
  switch (stmt.tag) {
    case "return":
    case "break":
    case "continue":
      return true;

    case "if_else_stmt":
      return core_stmts_definitely_exit_sequence(stmt.then_body) &&
        core_stmts_definitely_exit_sequence(stmt.else_body);

    case "expr":
      if (stmt.expr.tag === "block") {
        return core_stmts_definitely_exit_sequence(stmt.expr.statements);
      }

      if (
        stmt.expr.tag === "app" && stmt.expr.func.tag === "var" &&
        stmt.expr.func.name === "@panic"
      ) {
        return true;
      }

      return false;

    case "bind":
    case "assign":
    case "index_assign":
    case "range_loop":
    case "collection_loop":
    case "if_stmt":
    case "if_let_stmt":
    case "type_check":
    case "unsupported":
      return false;
  }
}
