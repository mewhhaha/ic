import { expect } from "../expect.ts";
import type { Field, FrontExpr, TypeField } from "./ast.ts";
import { i32_expr } from "./numeric.ts";
import { integer_type_name } from "../integer.ts";

type LayoutInfo = {
  size: number;
  align: number;
  fields: Field[];
  tag_offset: number | undefined;
  payload_offset: number | undefined;
};

export function layout_expr(layout: LayoutInfo): FrontExpr {
  const fields: Field[] = [
    { name: "size", value: i32_expr(layout.size) },
    { name: "align", value: i32_expr(layout.align) },
    {
      name: "fields",
      value: {
        tag: "struct_value",
        type_expr: { tag: "var", name: "field_offsets_type" },
        fields: layout.fields,
      },
    },
  ];

  if (layout.tag_offset !== undefined) {
    fields.push({ name: "tag_offset", value: i32_expr(layout.tag_offset) });
  }

  if (layout.payload_offset !== undefined) {
    fields.push({
      name: "payload_offset",
      value: i32_expr(layout.payload_offset),
    });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: "layout_type" },
    fields,
  };
}

export function layout_type(value: FrontExpr): LayoutInfo {
  if (value.tag === "type_name") {
    const layout = layout_type_name(value.name);
    return {
      size: layout.size,
      align: layout.align,
      fields: [],
      tag_offset: undefined,
      payload_offset: undefined,
    };
  }

  if (value.tag === "struct_type") {
    return layout_struct(value.fields);
  }

  if (value.tag === "union_type") {
    return layout_union(value.cases);
  }

  if (value.tag === "set_type" && value.type_expr.tag === "literal") {
    const literal = value.type_expr.value;
    let name = "I32";

    if (literal.tag === "bool") {
      name = "Bool";
    } else if (literal.tag === "text") {
      name = "Text";
    } else if (literal.character !== undefined) {
      name = "Char";
    } else if (literal.integer !== undefined) {
      name = integer_type_name(literal.integer);
    } else if (literal.type === "i64") {
      name = "I64";
    } else if (literal.type === "f32") {
      name = "F32";
    } else if (literal.type === "f64") {
      name = "F64";
    }

    return layout_type({ tag: "type_name", name });
  }

  throw new Error("Expected struct or union type value for layout");
}

function layout_struct(fields: TypeField[]): LayoutInfo {
  let offset = 0;
  let max_align = 1;
  const offsets: Field[] = [];

  for (const field of fields) {
    const field_layout = layout_type_name(field.type_name);
    offset = align_to(offset, field_layout.align);
    offsets.push({ name: field.name, value: i32_expr(offset) });
    offset += field_layout.size;

    if (field_layout.align > max_align) {
      max_align = field_layout.align;
    }
  }

  return {
    size: align_to(offset, max_align),
    align: max_align,
    fields: offsets,
    tag_offset: undefined,
    payload_offset: undefined,
  };
}

function layout_union(cases: TypeField[]): LayoutInfo {
  const tag_size = 4;
  let max_payload = 0;
  let max_align = 4;

  for (const union_case of cases) {
    const case_layout = layout_type_name(union_case.type_name);

    if (case_layout.size > max_payload) {
      max_payload = case_layout.size;
    }

    if (case_layout.align > max_align) {
      max_align = case_layout.align;
    }
  }

  let payload_offset = tag_size;

  if (max_align === 16) {
    payload_offset = align_to(tag_size, max_align);
  }

  return {
    size: align_to(payload_offset + max_payload, max_align),
    align: max_align,
    fields: [],
    tag_offset: 0,
    payload_offset,
  };
}

function layout_type_name(name: string): { size: number; align: number } {
  if (name === "Unit") {
    return { size: 0, align: 1 };
  }

  if (
    name === "Bool" || name === "Char" || name === "Int" ||
    name === "I32" || name === "U32" || name === "Resume" || name === "F32"
  ) {
    return { size: 4, align: 4 };
  }

  if (name === "I64") {
    return { size: 8, align: 8 };
  }

  if (name === "F64") {
    return { size: 8, align: 8 };
  }

  if (name === "F32x4") {
    return { size: 16, align: 16 };
  }

  if (name === "Text" || name === "Bytes") {
    return { size: 8, align: 4 };
  }

  throw new Error("Missing layout for type: " + name);
}

function align_to(offset: number, align: number): number {
  expect(align > 0, "Alignment must be positive");
  const remainder = offset % align;

  if (remainder === 0) {
    return offset;
  }

  return offset + align - remainder;
}
