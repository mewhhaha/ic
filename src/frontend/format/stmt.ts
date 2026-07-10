import type { FrontExpr, Stmt } from "../ast.ts";
import { format_type_pattern } from "./common.ts";
import { format_host_import } from "./host_import.ts";

export function format_stmt_with_expr(
  stmt: Stmt,
  format_expr: (expr: FrontExpr) => string,
): string {
  if (stmt.tag === "import") {
    return "import " + stmt.name + " from " + Deno.inspect(stmt.path);
  }

  if (stmt.tag === "host_import") {
    return format_host_import(stmt.value);
  }

  if (stmt.tag === "bind") {
    let text = stmt.kind + " ";

    if (stmt.is_recursive) {
      text += "rec ";
    }

    if (stmt.effect_context) {
      if (stmt.effect_context.operations) {
        const operations = stmt.effect_context.operations.map((operation) =>
          operation.effect + "." + operation.operation
        ).join(", ");
        text += "(" + stmt.effect_context.name + " :: { " + operations +
          " }) ";
      } else {
        text += stmt.effect_context.name + " ";
      }
    }

    if (stmt.is_linear) {
      text += "!";
    }

    text += stmt.name;

    if (stmt.annotation) {
      text += ": " + stmt.annotation;
    }

    return text + " = " + format_expr(stmt.value);
  }

  if (stmt.tag === "state_bind") {
    let value_name = "()";

    if (stmt.value_name) {
      value_name = stmt.value_name;
    }

    return "let (!" + stmt.context + ", " + value_name + ") = " +
      format_expr(stmt.value);
  }

  if (stmt.tag === "bind_pattern") {
    const items = stmt.items.map((item) => {
      if (item.is_linear) {
        return "!" + item.name;
      }

      return item.name;
    });
    return stmt.kind + " { " + items.join(", ") + " } = " +
      format_expr(stmt.value);
  }

  if (stmt.tag === "resume_dup") {
    return "let (!" + stmt.left + ", !" + stmt.right + ") = dup " +
      format_expr(stmt.value);
  }

  if (stmt.tag === "assign") {
    if (stmt.mode === "same") {
      return stmt.name + " = " + format_expr(stmt.value);
    }

    return stmt.name + " := " + format_expr(stmt.value);
  }

  if (stmt.tag === "index_assign") {
    return stmt.name + "[" + format_expr(stmt.index) + "] = " +
      format_expr(stmt.value);
  }

  if (stmt.tag === "return") {
    if (
      stmt.value.tag === "struct_value" &&
      stmt.value.type_expr.tag === "var" &&
      stmt.value.type_expr.name === "object_type"
    ) {
      const fields = stmt.value.fields.map((field) => {
        if (field.value.tag === "var" && field.value.name === field.name) {
          return field.name;
        }

        return field.name + ": " + format_expr(field.value);
      });
      return "return { " + fields.join(", ") + " }";
    }

    return "return " + format_expr(stmt.value);
  }

  if (stmt.tag === "for_range") {
    return "for " + stmt.index + " in " + format_expr(stmt.start) + ".." +
      format_expr(stmt.end) + " by " + format_expr(stmt.step) + " " +
      "{ " + stmt.body.map((item) => format_stmt_with_expr(item, format_expr))
      .join("; ") + " }";
  }

  if (stmt.tag === "for_collection") {
    let head = "for ";

    if (stmt.index) {
      head += stmt.index + ", ";
    }

    head += stmt.item + " in " + format_expr(stmt.collection) + " ";
    return head + "{ " +
      stmt.body.map((item) => format_stmt_with_expr(item, format_expr)).join(
        "; ",
      ) + " }";
  }

  if (stmt.tag === "if_stmt") {
    return "if " + format_expr(stmt.cond) + " { " +
      stmt.body.map((item) => format_stmt_with_expr(item, format_expr)).join(
        "; ",
      ) + " }";
  }

  if (stmt.tag === "if_let_stmt") {
    let pattern = "." + stmt.case_name;

    if (stmt.value_name) {
      pattern += "(" + stmt.value_name + ")";
    }

    return "if let " + pattern + " = " + format_expr(stmt.target) + " { " +
      stmt.body.map((item) => format_stmt_with_expr(item, format_expr)).join(
        "; ",
      ) + " }";
  }

  if (stmt.tag === "type_check") {
    return "let " + format_type_pattern(stmt.pattern) + " = " +
      format_expr(stmt.target);
  }

  if (stmt.tag === "break") {
    return "break";
  }

  if (stmt.tag === "continue") {
    return "continue";
  }

  if (stmt.tag === "expr") {
    return format_expr(stmt.expr);
  }

  if (stmt.tag === "unsupported") {
    return "<unsupported " + stmt.feature + ">";
  }

  stmt satisfies never;
  throw new Error("Cannot format statement");
}
