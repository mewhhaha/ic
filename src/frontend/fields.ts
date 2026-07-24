import type { Field, FrontExpr, TypeField } from "./ast.ts";

export function type_fields_expr(fields: TypeField[]): FrontExpr {
  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: "object_type" },
    fields: fields.map((field) => ({
      name: field.name,
      value: { tag: "type_name", name: field.type_name },
    })),
  };
}

export function merge_type_fields(
  left: TypeField[],
  right: TypeField[],
): TypeField[] {
  const fields: TypeField[] = [];

  for (const field of left) {
    fields.push({ name: field.name, type_name: field.type_name });
  }

  for (const field of right) {
    const existing = lookup_type_field(fields, field.name);

    if (!existing) {
      fields.push({ name: field.name, type_name: field.type_name });
    } else if (existing.type_name === "unknown") {
      existing.type_name = field.type_name;
    } else if (field.type_name === "unknown") {
      continue;
    } else if (existing.type_name !== field.type_name) {
      throw new Error(
        "Union case " + field.name + " has inconsistent payload types",
      );
    }
  }

  return fields;
}

export function lookup_field(
  fields: Field[],
  name: string,
): Field | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

export function lookup_type_field(
  fields: TypeField[],
  name: string,
): TypeField | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

export function require_struct_field(
  field: Field | undefined,
  name: string,
): asserts field is Field {
  if (!field) {
    throw new Error("Missing struct field: " + name);
  }
}

export function check_object_fields(fields: Field[]): void {
  const seen = new Set<string>();

  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error("Duplicate struct field: " + field.name);
    }

    seen.add(field.name);
  }
}

export function is_object_type_expr(expr: FrontExpr): boolean {
  if (expr.tag === "captured") {
    return is_object_type_expr(expr.expr);
  }

  return expr.tag === "var" && expr.name === "object_type";
}
