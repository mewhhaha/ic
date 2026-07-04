import type {
  Field,
  FrontExpr,
  FrontHostImportArgContract,
  FrontHostImportResultContract,
  Param,
  Source as SourceNode,
  Stmt,
  TypeField,
  TypePattern,
} from "./ast.ts";
import type { Prim } from "../op.ts";

export function format_source(source: SourceNode): string {
  return source.statements.map(format_stmt).join("\n");
}

function format_stmt(stmt: Stmt): string {
  if (stmt.tag === "import") {
    return "import " + stmt.name + " from " + Deno.inspect(stmt.path);
  }

  if (stmt.tag === "host_import") {
    let text = "host_import " + stmt.value.name + " from " +
      Deno.inspect(stmt.value.module + "." + stmt.value.field);
    text += " (";
    text += stmt.value.args.map((arg, index) => {
      const param = stmt.value.params[index];

      if (!param) {
        throw new Error("Missing host import parameter type");
      }

      return format_host_import_arg(arg, param);
    }).join(", ");
    text += ") => ";
    text += format_host_import_result(
      stmt.value.result,
      stmt.value.result_owner,
    );
    return text;
  }

  if (stmt.tag === "bind") {
    let text = stmt.kind + " ";

    if (stmt.is_recursive) {
      text += "rec ";
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
    return "return " + format_expr(stmt.value);
  }

  if (stmt.tag === "for_range") {
    return "for " + stmt.index + " in " + format_expr(stmt.start) + ".." +
      format_expr(stmt.end) + " by " + format_expr(stmt.step) + " " +
      "{ " + stmt.body.map(format_stmt).join("; ") + " }";
  }

  if (stmt.tag === "for_collection") {
    let head = "for ";

    if (stmt.index) {
      head += stmt.index + ", ";
    }

    head += stmt.item + " in " + format_expr(stmt.collection) + " ";
    return head + "{ " + stmt.body.map(format_stmt).join("; ") + " }";
  }

  if (stmt.tag === "if_stmt") {
    return "if " + format_expr(stmt.cond) + " { " +
      stmt.body.map(format_stmt).join("; ") + " }";
  }

  if (stmt.tag === "if_let_stmt") {
    let pattern = "." + stmt.case_name;

    if (stmt.value_name) {
      pattern += "(" + stmt.value_name + ")";
    }

    return "if let " + pattern + " = " + format_expr(stmt.target) + " { " +
      stmt.body.map(format_stmt).join("; ") + " }";
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

  return "<unsupported " + stmt.feature + ">";
}

export function format_expr(expr: FrontExpr): string {
  switch (expr.tag) {
    case "num":
      return expr.value.toString();

    case "text":
      return Deno.inspect(expr.value);

    case "type_name":
      return expr.name;

    case "var":
      return expr.name;

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
      return "borrow " + format_expr(expr.value);

    case "freeze":
      return "freeze " + format_expr(expr.value);

    case "scratch":
      return "scratch " + format_expr(expr.body);

    case "captured":
      return format_expr(expr.expr);

    case "with":
      return format_expr(expr.base) + " with { " +
        expr.fields.map(format_field).join(", ") + " }";

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
      return "union { " + expr.cases.map(format_type_field).join(", ") +
        " }";

    case "if":
      return "if " + format_expr(expr.cond) + " " +
        format_expr(expr.then_branch) + " else " +
        format_expr(expr.else_branch);

    case "if_let": {
      let pattern = "." + expr.case_name;

      if (expr.value_name) {
        pattern += "(" + expr.value_name + ")";
      }

      return "if let " + pattern + " = " + format_expr(expr.target) + " " +
        format_expr(expr.then_branch) + " else " +
        format_expr(expr.else_branch);
    }

    case "field":
      return format_expr(expr.object) + "." + expr.name;

    case "index":
      return format_expr(expr.object) + "[" + format_expr(expr.index) + "]";

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

function format_field(field: Field): string {
  return field.name + ": " + format_expr(field.value);
}

function format_type_field(field: TypeField): string {
  return field.name + ": " + field.type_name;
}

function format_host_import_arg(
  arg: FrontHostImportArgContract,
  param: string,
): string {
  if (arg.tag === "scalar") {
    return format_host_import_val_type(param);
  }

  return arg.tag + " " + format_host_import_owner_reason(arg.reason);
}

function format_host_import_result(
  result: string,
  owner: FrontHostImportResultContract | undefined,
): string {
  if (!owner) {
    return format_host_import_val_type(result);
  }

  if (owner.tag === "scalar") {
    return "scalar " + format_host_import_val_type(result);
  }

  return owner.tag + " " + format_host_import_owner_reason(owner.reason);
}

function format_host_import_val_type(type: string): string {
  if (type === "i32") {
    return "I32";
  }

  if (type === "i64") {
    return "I64";
  }

  throw new Error("Cannot format host import ABI type: " + type);
}

function format_host_import_owner_reason(
  reason: string | { tag: "type_ref"; name: string } | undefined,
): string {
  if (reason && typeof reason !== "string") {
    return reason.name;
  }

  if (reason === "text") {
    return "Text";
  }

  if (reason === "closure") {
    return "closure";
  }

  if (reason === "runtime_union") {
    return "runtime_union";
  }

  if (reason === "runtime_aggregate") {
    return "runtime_aggregate";
  }

  if (reason === "freeze") {
    return "freeze";
  }

  throw new Error("Cannot format host import owner reason");
}

function format_type_pattern(pattern: TypePattern): string {
  const fields = pattern.fields.map(format_type_field);

  if (pattern.open) {
    fields.push("..");
  }

  return pattern.kind + " { " + fields.join(", ") + " }";
}

function format_params(params: Param[]): string {
  return params.map((param) => {
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
  }).join(", ");
}

function prim_symbol(prim: Prim): string {
  switch (prim) {
    case "i32.add":
    case "i64.add":
      return "+";

    case "i32.sub":
    case "i64.sub":
      return "-";

    case "i32.mul":
    case "i64.mul":
      return "*";

    case "i32.div_s":
    case "i64.div_s":
      return "/";

    case "i32.rem_s":
    case "i64.rem_s":
      return "%";

    case "i32.eq":
    case "i64.eq":
      return "==";

    case "i32.ne":
    case "i64.ne":
      return "!=";

    case "i32.lt_s":
    case "i64.lt_s":
      return "<";

    case "i32.le_s":
    case "i64.le_s":
      return "<=";

    case "i32.gt_s":
    case "i64.gt_s":
      return ">";

    case "i32.ge_s":
    case "i64.ge_s":
      return ">=";

    case "i32.select":
    case "i64.select":
      return "select";

    case "i32.load":
    case "i64.load":
      return "load";

    case "i32.load8_u":
    case "i64.load8_u":
      return "load8_u";

    case "i32.trap":
    case "i64.trap":
      return "trap";
  }
}
