import type { Field, Param, Pattern, TypeField, TypePattern } from "../ast.ts";
import { format_binding_name } from "../names.ts";
import { format_type_expr } from "../type_expr.ts";

export function format_field(
  field: Field,
  format_expr: (expr: Field["value"]) => string,
): string {
  return field.name + ": " + format_expr(field.value);
}

export function format_type_field(field: TypeField): string {
  return field.name + ": " + field.type_name;
}

export function format_type_pattern(pattern: TypePattern): string {
  const fields = pattern.fields.map(format_type_field);

  if (pattern.open) {
    fields.push("..");
  }

  return pattern.kind + " { " + fields.join(", ") + " }";
}

export function format_params(params: Param[]): string {
  return params.map((param) => {
    let text = "";

    if (param.is_const) {
      text += "const ";
    }

    if (param.is_linear) {
      text += "!";
    }

    text += format_binding_name(param.name);

    if (param.type_annotation) {
      text += ": " + format_type_expr(param.type_annotation);
    } else if (param.annotation) {
      text += ": " + param.annotation;
    }

    return text;
  }).join(", ");
}

export function format_pattern(pattern: Pattern): string {
  if (pattern.tag === "binding") {
    let text = "";

    if (pattern.mode === "const") {
      text += "const ";
    } else if (pattern.mode === "linear") {
      text += "!";
    }

    text += format_binding_name(pattern.name);

    if (pattern.type_annotation) {
      text += ": " + format_type_expr(pattern.type_annotation);
    } else if (pattern.annotation) {
      text += ": " + pattern.annotation;
    }

    return text;
  }

  if (pattern.tag === "wildcard") {
    if (pattern.mode === "const") {
      return "const _";
    }

    return "_";
  }

  if (pattern.tag === "unit") {
    return "()";
  }

  if (pattern.tag === "literal") {
    if (pattern.value.tag === "text") {
      return Deno.inspect(pattern.value.value);
    }

    if (pattern.value.tag === "atom") {
      return "#" + pattern.value.name;
    }

    return pattern.value.value.toString();
  }

  if (pattern.tag === "union_case") {
    let text = "." + pattern.name;

    if (pattern.value) {
      text += " " + format_pattern(pattern.value);
    }

    return text;
  }

  if (pattern.tag === "product") {
    const entries = pattern.entries.map((entry) => {
      let text = format_pattern(entry.pattern);

      if (entry.label !== undefined) {
        text = "." + entry.label + " = " + text;
      }

      return text;
    });
    return "(" + entries.join(", ") + ")";
  }

  if (pattern.tag === "record") {
    const fields = pattern.fields.map((field) => {
      if (
        field.pattern.tag === "binding" &&
        field.pattern.name === field.name &&
        field.pattern.mode === "default" &&
        field.pattern.annotation === undefined &&
        field.pattern.type_annotation === undefined
      ) {
        return field.name;
      }

      return field.name + ": " + format_pattern(field.pattern);
    });

    if (pattern.rest) {
      fields.push("..." + format_pattern(pattern.rest));
    }

    return "{ " + fields.join(", ") + " }";
  }

  const items = pattern.items.map(format_pattern);

  if (pattern.rest) {
    items.push("..." + format_pattern(pattern.rest));
  }

  return "[" + items.join(", ") + "]";
}
