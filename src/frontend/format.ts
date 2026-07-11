import type {
  Declaration,
  EffectParam,
  EffectResult,
  FrontExpr,
  Source as SourceNode,
  Stmt,
  TypeDeclaration,
} from "./ast.ts";
import { format_params } from "./format/common.ts";
import { format_expr_with_stmt } from "./format/expr.ts";
import { format_stmt_with_expr } from "./format/stmt.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

export function format_source(source: SourceNode): string {
  const parts: string[] = [];

  if (source.module) {
    parts.push("module (" + format_params(source.module.params) + ") where");
  }

  if (source.declarations) {
    for (const declaration of source.declarations) {
      parts.push(format_declaration(declaration));
    }
  }

  parts.push(...source.statements.map(format_stmt));
  return parts.join("\n");
}

function format_declaration(declaration: Declaration): string {
  if (declaration.tag === "record") {
    return "declare " + declaration.name + " { " +
      declaration.fields.map((field) => field.name + ": " + field.type_name)
        .join(", ") +
      " }";
  }

  if (declaration.tag === "type") {
    return format_type_declaration(declaration);
  }

  const operations = declaration.operations.map((operation) => {
    const params = operation.params.map(format_effect_param).join(", ");
    return operation.name + ": (" + params + ") => " +
      format_effect_result(operation.result);
  });
  let prefix = "effect ";

  if (declaration.implementation === "host") {
    prefix = "declare effect ";
  }

  return prefix + declaration.name + " { " +
    operations.join(", ") + " }";
}

function format_type_declaration(declaration: TypeDeclaration): string {
  let head = "type " + declaration.name;

  if (declaration.params.length > 0) {
    head += " " + declaration.params.join(" ");
  }

  if (declaration.body.tag === "product") {
    const entries: string[] = [];

    for (const field of declaration.body.fields) {
      if (declaration.body.positional) {
        entries.push(format_type_text(field.type_name));
      } else {
        entries.push(
          "." + field.name + " = " +
            format_type_text(field.type_name),
        );
      }
    }

    return head + " = [" + entries.join(", ") + "]";
  }

  if (declaration.body.tag === "alias") {
    return head + " = " + format_type_text(declaration.body.type_name);
  }

  const cases = declaration.body.cases.map((item) => {
    let text = "  | ." + item.name;

    if (item.type_name !== "Unit") {
      text += " = " + format_type_text(item.type_name);
    }

    return text;
  });
  return head + " =\n" + cases.join("\n");
}

function format_type_text(text: string): string {
  return format_type_expr(parse_type_expr(tokenize(text)));
}

function format_effect_param(param: EffectParam): string {
  if (param.ownership === "scalar") {
    return param.type_name;
  }

  if (param.ownership === "ownership_transfer") {
    return param.type_name;
  }

  if (param.ownership === "bounded_borrow") {
    return "&" + param.type_name;
  }

  return "#" + param.type_name;
}

function format_effect_result(result: EffectResult): string {
  if (result.ownership === "scalar") {
    return result.type_name;
  }

  if (result.ownership === "unique_heap") {
    return result.type_name;
  }

  return "#" + result.type_name;
}

function format_stmt(stmt: Stmt): string {
  return format_stmt_with_expr(stmt, format_expr);
}

export function format_expr(expr: FrontExpr): string {
  return format_expr_with_stmt(expr, format_stmt);
}
