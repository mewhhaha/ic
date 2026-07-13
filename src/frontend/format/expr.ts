import type { FrontExpr, Stmt } from "../ast.ts";
import { format_binding_name } from "../names.ts";
import { format_field, format_params, format_type_field } from "./common.ts";
import { prim_symbol } from "./prim.ts";
import { format_type_expr } from "../type_expr.ts";

export function format_expr_with_stmt(
  expr: FrontExpr,
  format_stmt: (stmt: Stmt) => string,
): string {
  const format_expr = (value: FrontExpr) =>
    format_expr_with_stmt(value, format_stmt);

  switch (expr.tag) {
    case "bool":
      return expr.value.toString();

    case "num":
      return expr.value.toString();

    case "unit":
      return "()";

    case "text":
      return Deno.inspect(expr.value);

    case "type_name":
      return expr.name;

    case "set_type":
      return "set " + format_type_expr(expr.type_expr);

    case "var":
      return expr.name;

    case "atom":
      return "#" + expr.name;

    case "prim":
      return format_expr(expr.left) + " " + prim_symbol(expr.prim) + " " +
        format_expr(expr.right);

    case "lam":
      return "(" + format_params(expr.params) + ") => " +
        format_expr(expr.body);

    case "rec":
      return "rec (" + format_params(expr.params) + ") => " +
        format_expr(expr.body);

    case "app":
      return format_expr(expr.func) + "(" +
        expr.args.map((arg) => format_expr(arg)).join(", ") + ")";

    case "block":
      return "{ " + expr.statements.map(format_stmt).join("; ") + " }";

    case "comptime":
      return "comptime " + format_expr(expr.expr);

    case "borrow":
      return "&" + format_expr(expr.value);

    case "freeze":
      return "freeze " + format_expr(expr.value);

    case "scratch":
      return "scratch " + format_expr(expr.body);

    case "loop":
      return "loop { " + expr.body.map(format_stmt).join("; ") + " }";

    case "captured":
      return format_expr(expr.expr);

    case "handler": {
      const state = expr.state.map((item) => {
        let text = "let " + format_binding_name(item.name);

        if (item.annotation) {
          text += ": " + item.annotation;
        }

        return text + " = " + format_expr(item.value);
      });
      const clauses = expr.clauses.map((clause) => {
        return clause.name + ": (" + format_params(clause.params) + ") => " +
          format_expr(clause.body);
      });
      clauses.push(
        "return: " + format_params([expr.return_clause.param]) + " => " +
          format_expr(expr.return_clause.body),
      );
      const literal = expr.effect + " { " + clauses.join(", ") + " }";

      if (state.length === 0) {
        return literal;
      }

      state.push(literal);
      return "{ " + state.join("; ") + " }";
    }

    case "try_with":
      return "try " + format_expr(expr.body) + " with " +
        format_expr(expr.handler);

    case "with":
      return format_expr(expr.base) + " with { " +
        expr.fields.map((field) => format_field(field, format_expr)).join(
          ", ",
        ) + " }";

    case "struct_type":
      return "struct { " + expr.fields.map(format_type_field).join(", ") +
        " }";

    case "struct_value":
      if (expr.bracketed === "named") {
        return "[" + expr.fields.map((field) => {
          return "." + field.name + " = " + format_expr(field.value);
        }).join(", ") + "]";
      }

      if (expr.bracketed === "positional") {
        return "[" + expr.fields.map((field) => format_expr(field.value)).join(
          ", ",
        ) + "]";
      }

      if (
        expr.type_expr.tag === "var" &&
        expr.type_expr.name === "object_type"
      ) {
        const fields = expr.fields.map((field) => {
          if (field.value.tag === "var" && field.value.name === field.name) {
            return field.name;
          }

          return format_field(field, format_expr);
        });
        return "{ " + fields.join(", ") + " }";
      }

      return format_expr(expr.type_expr) + " { " +
        expr.fields.map((field) => format_field(field, format_expr)).join(
          ", ",
        ) + " }";

    case "struct_update":
      return format_expr(expr.base) + " { " +
        expr.fields.map((field) => format_field(field, format_expr)).join(
          ", ",
        ) + " }";

    case "union_type":
      return "union { " + expr.cases.map(format_type_field).join(", ") +
        " }";

    case "if":
      return "if " + format_expr(expr.cond) + " " +
        format_expr(expr.then_branch) + " else " +
        format_expr(expr.else_branch);

    case "if_let": {
      let pattern = "." + expr.case_name;

      if (expr.value_name) {
        pattern += "(" + format_binding_name(expr.value_name) + ")";
      }

      return "if let " + pattern + " = " + format_expr(expr.target) + " " +
        format_expr(expr.then_branch) + " else " +
        format_expr(expr.else_branch);
    }

    case "field":
      return format_expr(expr.object) + "." + expr.name;

    case "index":
      return format_expr(expr.object) + "[" + format_expr(expr.index) + "]";

    case "is": {
      let value = format_expr(expr.value);

      if (expr.value.tag === "if") {
        value = "(" + value + ")";
      }

      return value + " is " + format_type_expr(expr.type_expr);
    }

    case "union_case":
      if (expr.value) {
        return "." + expr.name + "(" + format_expr(expr.value) + ")";
      }

      return "." + expr.name;

    case "linear":
      return "!" + expr.name;

    case "unsupported":
      return "<unsupported " + expr.feature + ">";
  }
}
