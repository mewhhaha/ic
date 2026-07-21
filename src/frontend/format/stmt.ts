import type { FrontExpr, Stmt } from "../ast.ts";
import { expect } from "../../expect.ts";
import { format_binding_name, is_no_demand_name } from "../names.ts";
import { format_type_expr } from "../type_expr.ts";
import {
  format_attribute_groups,
  format_pattern,
  format_type_pattern,
} from "./common.ts";
import { format_host_import } from "./host_import.ts";

export function format_stmt_with_expr(
  stmt: Stmt,
  format_expr: (expr: FrontExpr) => string,
): string {
  let attributes = "";

  if (stmt.tag === "bind") {
    attributes = format_attribute_groups(stmt.attribute_groups, format_expr);
  }

  return attributes + format_stmt_without_attributes(stmt, format_expr);
}

function format_stmt_without_attributes(
  stmt: Stmt,
  format_expr: (expr: FrontExpr) => string,
): string {
  if (stmt.tag === "import") {
    return "const " + stmt.name + " = import " + Deno.inspect(stmt.path);
  }

  if (stmt.tag === "host_import") {
    return format_host_import(stmt.value);
  }

  if (stmt.tag === "bind") {
    if (stmt.effectful) {
      return format_binding_name(stmt.name) + " <- " + format_expr(stmt.value);
    }

    let text = stmt.kind + " ";

    if (stmt.is_recursive) {
      text += "rec ";
    }

    if (stmt.opens_import === true) {
      text += "open ";
    }

    if (stmt.pattern) {
      text += format_pattern(stmt.pattern) + " = " + format_expr(stmt.value);

      if (stmt.mutual !== undefined) {
        for (const member of stmt.mutual) {
          text += "\nand " + format_pattern(member.pattern) + " = " +
            format_expr(member.value);
        }
      }

      return text;
    }

    if (stmt.is_linear) {
      text += "!";
    }

    text += format_binding_name(stmt.name);

    if (stmt.type_annotation) {
      text += ": " + format_type_expr(stmt.type_annotation);
    } else if (stmt.annotation) {
      text += ": " + stmt.annotation;
    }

    return text + " = " + format_expr(stmt.value);
  }

  if (stmt.tag === "state_bind") {
    let value_name = "_";

    if (stmt.value_name) {
      value_name = format_binding_name(stmt.value_name);
    }

    return value_name + " <- " + format_expr(stmt.value);
  }

  if (stmt.tag === "bind_pattern") {
    const items = stmt.items.map((item) => {
      if (item.is_linear) {
        return "!" + format_binding_name(item.name);
      }

      return format_binding_name(item.name);
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

        return "." + field.name + " = " + format_expr(field.value);
      });
      return "return { " + fields.join(", ") + " }";
    }

    return "return " + format_expr(stmt.value);
  }

  if (stmt.tag === "for_range") {
    let head = "for ";

    if (!is_no_demand_name(stmt.index)) {
      head += format_binding_name(stmt.index) + " in ";
    }

    return head + format_expr(stmt.start) + ".." +
      format_expr(stmt.end) + " by " + format_expr(stmt.step) + " " +
      "{ " + stmt.body.map((item) => format_stmt_with_expr(item, format_expr))
      .join("; ") + " }";
  }

  if (stmt.tag === "for_collection") {
    let head = "for ";

    if (stmt.index) {
      head += format_binding_name(stmt.index) + ", ";
    }

    if (stmt.pattern !== undefined) {
      head += format_pattern(stmt.pattern);
    } else {
      head += format_binding_name(stmt.item);
    }

    head += " in " +
      format_expr(stmt.collection) + " ";
    let body = stmt.body;

    if (stmt.pattern !== undefined) {
      const wrapper = stmt.body[0];
      expect(
        stmt.body.length === 1 && wrapper?.tag === "expr" &&
          wrapper.expr.tag === "match",
        "Pattern collection loop is missing its match wrapper",
      );
      const matching = wrapper.expr.arms[0];
      expect(
        matching !== undefined && matching.body.tag === "block",
        "Pattern collection loop is missing its matching body",
      );
      body = matching.body.statements.slice(0, -1);
    }

    return head + "{ " +
      body.map((item) => format_stmt_with_expr(item, format_expr)).join(
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
    let pattern = "`" + stmt.case_name;

    if (stmt.value_name) {
      pattern += " " + format_binding_name(stmt.value_name);
    } else {
      pattern += " _";
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
    if (stmt.value) {
      return "break " + format_expr(stmt.value);
    }

    return "break";
  }

  if (stmt.tag === "continue") {
    return "continue";
  }

  if (stmt.tag === "expr") {
    if (stmt.effectful) {
      return "_ <- " + format_expr(stmt.expr);
    }

    return format_expr(stmt.expr);
  }

  if (stmt.tag === "unsupported") {
    return "<unsupported " + stmt.feature + ">";
  }

  stmt satisfies never;
  throw new Error("Cannot format statement");
}
