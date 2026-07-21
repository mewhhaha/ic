import type {
  AttributeGroup,
  Field,
  FrontExpr,
  Param,
  Pattern,
  TypeField,
  TypePattern,
} from "../ast.ts";
import { format_character_literal } from "../literal.ts";
import { format_binding_name } from "../names.ts";
import { format_type_expr } from "../type_expr.ts";

export function format_attribute_groups(
  groups: AttributeGroup[] | undefined,
  format_expr: (expr: FrontExpr) => string,
): string {
  if (groups === undefined) {
    return "";
  }

  return groups.map((group) => {
    if (group.multiline === true) {
      return "@[\n  " + group.attributes.map(format_expr).join(",\n  ") +
        ",\n]";
    }

    return "@[" + group.attributes.map(format_expr).join(", ") + "]";
  }).join("\n") + "\n";
}

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

    if (param.is_variadic === true) {
      text += "...";
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

    if (pattern.is_variadic === true) {
      text += "...";
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

    if (
      pattern.value.tag === "num" && pattern.value.character !== undefined
    ) {
      return format_character_literal(pattern.value.character);
    }

    if (pattern.value.tag === "num" && pattern.value.type === "i64") {
      return pattern.value.value.toString() + "i64";
    }

    if (pattern.value.tag === "num" && pattern.value.type === "f32") {
      return pattern.value.value.toString() + "f32";
    }

    if (pattern.value.tag === "num" && pattern.value.type === "f64") {
      return pattern.value.value.toString() + "f64";
    }

    return pattern.value.value.toString();
  }

  if (pattern.tag === "text_capture") {
    return Deno.inspect(
      pattern.prefix + "${" + pattern.name + "}" + pattern.suffix,
    );
  }

  if (pattern.tag === "value") {
    return pattern.name;
  }

  if (pattern.tag === "type") {
    return format_type_pattern(pattern.pattern);
  }

  if (pattern.tag === "or") {
    return pattern.alternatives.map(format_pattern).join(" | ");
  }

  if (pattern.tag === "union_case") {
    let text = "`" + pattern.name;

    if (pattern.value) {
      text += " " + format_pattern(pattern.value);
    } else {
      text += " ()";
    }

    return text;
  }

  if (pattern.tag === "product") {
    const entries = pattern.entries.map((entry) => {
      let text = format_pattern(entry.pattern);

      if (entry.label !== undefined) {
        if (
          entry.pattern.tag === "binding" &&
          entry.pattern.name === entry.label &&
          entry.pattern.mode === "default"
        ) {
          text = format_pattern(entry.pattern);
        } else {
          text = "." + entry.label + " = " + text;
        }
      }

      return text;
    });

    if (pattern.rest !== undefined) {
      entries.push("..." + format_pattern(pattern.rest));
    }

    if (
      pattern.entries.length > 0 &&
      pattern.entries.every((entry) => entry.label !== undefined)
    ) {
      return "{ " + entries.join(", ") + " }";
    }

    if (pattern.value_pack === true) {
      return "(" + entries.join(", ") + ")";
    }

    return "[" + entries.join(", ") + "]";
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
