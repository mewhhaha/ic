import type {
  Core,
  CoreExpr,
  CoreField,
  CoreParam,
  CoreStmt,
  CoreTypeField,
} from "./ast.ts";

export function format_core(core: Core): string {
  return core.statements.map((stmt) => format_stmt(stmt, 0)).join("\n");
}

function format_stmt(stmt: CoreStmt, depth: number): string {
  const pad = "  ".repeat(depth);

  switch (stmt.tag) {
    case "bind": {
      let head = stmt.kind + " ";

      if (stmt.is_linear) {
        head += "!";
      }

      head += stmt.name;

      if (stmt.annotation) {
        head += ": " + stmt.annotation;
      }

      return pad + head + " = " + format_expr(stmt.value);
    }

    case "assign": {
      let op = " = ";

      if (stmt.mode === "change") {
        op = " := ";
      }

      return pad + stmt.name + op + format_expr(stmt.value);
    }

    case "index_assign":
      return pad + stmt.name + "[" + format_expr(stmt.index) + "] = " +
        format_expr(stmt.value);

    case "range_loop": {
      const body = stmt.body.map((item) => format_stmt(item, depth + 1)).join(
        "\n",
      );
      const carried = stmt.carried.join(", ");
      return pad + "range_loop " + stmt.index + " in " +
        format_expr(stmt.start) + ".." + format_expr(stmt.end) + " by " +
        format_expr(stmt.step) + " carry [" + carried + "] {\n" + body +
        "\n" + pad + "}";
    }

    case "collection_loop": {
      const body = stmt.body.map((item) => format_stmt(item, depth + 1)).join(
        "\n",
      );
      let head = "collection_loop ";

      if (stmt.index) {
        head += stmt.index + ", ";
      }

      head += stmt.item + " in " + format_expr(stmt.collection);
      head += " carry [" + stmt.carried.join(", ") + "]";
      return pad + head + " {\n" + body + "\n" + pad + "}";
    }

    case "if_stmt": {
      const body = stmt.body.map((item) => format_stmt(item, depth + 1)).join(
        "\n",
      );
      return pad + "if " + format_expr(stmt.cond) + " {\n" + body + "\n" +
        pad + "}";
    }

    case "if_else_stmt": {
      const then_body = stmt.then_body.map((item) =>
        format_stmt(item, depth + 1)
      ).join("\n");
      const else_body = stmt.else_body.map((item) =>
        format_stmt(item, depth + 1)
      ).join("\n");
      return pad + "if " + format_expr(stmt.cond) + " {\n" + then_body +
        "\n" + pad + "} else {\n" + else_body + "\n" + pad + "}";
    }

    case "if_let_stmt": {
      let head = "if let `" + stmt.case_name;

      if (stmt.value_name) {
        head += " " + stmt.value_name;
      } else {
        head += " ()";
      }

      const body = stmt.body.map((item) => format_stmt(item, depth + 1)).join(
        "\n",
      );
      return pad + head + " = " + format_expr(stmt.target) + " {\n" + body +
        "\n" + pad + "}";
    }

    case "type_check":
      return pad + "type_check " + stmt.pattern.kind + " " +
        format_expr(stmt.target);

    case "break":
      if (stmt.value) {
        return pad + "break " + format_expr(stmt.value);
      }
      return pad + "break";

    case "continue":
      return pad + "continue";

    case "return":
      return pad + "return " + format_expr(stmt.value);

    case "expr":
      return pad + format_expr(stmt.expr);

    case "unsupported":
      return pad + "<unsupported " + stmt.feature + ">";
  }
}

function format_expr(expr: CoreExpr): string {
  switch (expr.tag) {
    case "num":
      return expr.value.toString() + ":" + expr.type;

    case "text":
      return Deno.inspect(expr.value);

    case "type_name":
    case "var":
      return expr.name;

    case "linear":
      return "!" + expr.name;

    case "prim":
      return format_expr(expr.args[0]) + " " + expr.prim + " " +
        format_expr(expr.args[1]);

    case "lam":
      return "(" + expr.params.map(format_param).join(", ") + ") => " +
        format_expr(expr.body);

    case "rec":
      return "rec (" + expr.params.map(format_param).join(", ") + ") => " +
        format_expr(expr.body);

    case "rec_ref":
      return expr.name;

    case "app":
      return format_expr(expr.func) + "(" +
        expr.args.map(format_expr).join(", ") + ")";

    case "block":
      return "{ " +
        expr.statements.map((stmt) => format_stmt(stmt, 0)).join("; ") +
        " }";

    case "loop":
      return "loop { " +
        expr.body.map((stmt) => format_stmt(stmt, 0)).join("; ") + " }";

    case "comptime":
      return "comptime " + format_expr(expr.expr);

    case "borrow":
      return "borrow " + format_expr(expr.value);

    case "freeze":
      return "freeze " + format_expr(expr.value);

    case "scratch":
      return "scratch " + format_expr(expr.body);

    case "with":
      return format_expr(expr.base) + " update { ... }";

    case "struct_type":
      return "struct { " + expr.fields.map(format_type_field).join(", ") +
        " }";

    case "struct_value":
      return format_expr(expr.type_expr) + " { " +
        expr.fields.map(format_field).join(", ") + " }";

    case "struct_update":
      return format_expr(expr.base) + " { " +
        expr.fields.map(format_field).join(", ") + " }";

    case "union_type":
      return "union { " + expr.cases.map(format_type_field).join(", ") + " }";

    case "if":
      return "if " + format_expr(expr.cond) + " { " +
        format_expr(expr.then_branch) + " } else { " +
        format_expr(expr.else_branch) + " }";

    case "if_let": {
      let head = "if let `" + expr.case_name;

      if (expr.value_name) {
        head += " " + expr.value_name;
      } else {
        head += " ()";
      }

      return head + " = " + format_expr(expr.target) + " { " +
        format_expr(expr.then_branch) + " } else { " +
        format_expr(expr.else_branch) + " }";
    }

    case "field":
      return format_expr(expr.object) + "." + expr.name;

    case "index":
      return format_expr(expr.object) + "[" + format_expr(expr.index) + "]";

    case "union_case": {
      let value = "";

      if (expr.value) {
        value = " " + format_expr(expr.value);
      } else {
        value = " ()";
      }

      return "`" + expr.name + value;
    }

    case "unsupported":
      return "<unsupported " + expr.feature + ">";
  }
}

function format_param(param: CoreParam): string {
  let text = "";

  if (param.is_const) {
    text += "const ";
  }

  if (param.is_linear) {
    text += "!";
  }

  text += param.name;

  if (param.annotation) {
    text += ": " + param.annotation;
  }

  return text;
}

function format_field(field: CoreField): string {
  return field.name + ": " + format_expr(field.value);
}

function format_type_field(field: CoreTypeField): string {
  return field.name + ": " + field.type_name;
}
