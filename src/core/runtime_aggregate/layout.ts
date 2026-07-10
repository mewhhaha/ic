import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";
import { align_to, val_type_align, val_type_size } from "../memory.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
  static_type_value,
  type TypeStaticCtx,
} from "../type_static.ts";

export type RuntimeAggregateField =
  | {
    tag: "value";
    name: string;
    offset: number;
    type: ValType;
    text: boolean;
    union_type_expr: CoreExpr | undefined;
  }
  | {
    tag: "struct";
    name: string;
    type_expr: CoreExpr;
    fields: RuntimeAggregateField[];
  }
  | {
    tag: "unit";
    name: string;
  };

export type RuntimeAggregateLayout = {
  type_expr: CoreExpr;
  size: number;
  align: number;
  fields: RuntimeAggregateField[];
};

type RuntimeAggregateLayoutInfo = {
  size: number;
  align: number;
};

export function runtime_aggregate_layout<ctx extends TypeStaticCtx>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
): RuntimeAggregateLayout {
  const type_value = static_type_value(value.type_expr, ctx);
  expect(
    type_value && type_value.tag === "struct_type",
    "Core runtime aggregate requires a static struct type",
  );

  return runtime_aggregate_struct_layout(value.type_expr, type_value, ctx);
}

export function runtime_aggregate_layout_for_type<ctx extends TypeStaticCtx>(
  type_expr: CoreExpr,
  ctx: ctx,
): RuntimeAggregateLayout {
  const type_value = static_type_value(type_expr, ctx);
  expect(
    type_value && type_value.tag === "struct_type",
    "Core runtime aggregate requires a static struct type",
  );

  return runtime_aggregate_struct_layout(type_expr, type_value, ctx);
}

export function same_runtime_aggregate_type_expr<ctx extends TypeStaticCtx>(
  left: CoreExpr | undefined,
  right: CoreExpr | undefined,
  ctx?: ctx,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (ctx) {
    const left_type = static_type_value(left, ctx);
    const right_type = static_type_value(right, ctx);

    if (
      left_type && left_type.tag === "struct_type" &&
      right_type && right_type.tag === "struct_type"
    ) {
      return same_runtime_aggregate_type_value(left_type, right_type, ctx);
    }
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

export function runtime_aggregate_field_base_offset(
  field: RuntimeAggregateField,
): number {
  if (field.tag === "value") {
    return field.offset;
  }

  if (field.tag === "struct") {
    let offset: number | undefined;

    for (const nested of field.fields) {
      const nested_offset = runtime_aggregate_field_base_offset(nested);

      if (offset === undefined || nested_offset < offset) {
        offset = nested_offset;
      }
    }

    if (offset !== undefined) {
      return offset;
    }
  }

  return 0;
}

export function find_runtime_aggregate_field(
  fields: RuntimeAggregateField[],
  name: string,
): RuntimeAggregateField | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

function runtime_aggregate_struct_layout<ctx extends TypeStaticCtx>(
  type_expr: CoreExpr,
  type_value: Extract<CoreExpr, { tag: "struct_type" }>,
  ctx: ctx,
): RuntimeAggregateLayout {
  let offset = 0;
  let max_align = 1;
  const fields: RuntimeAggregateField[] = [];

  for (const field of type_value.fields) {
    const field_type_name = resolve_core_type_name(field.type_name, ctx);
    const field_layout = runtime_aggregate_type_layout(field_type_name, ctx);
    offset = align_to(offset, field_layout.align);
    const field_info = runtime_aggregate_field(
      field.name,
      field_type_name,
      offset,
      ctx,
    );
    fields.push(field_info);
    offset += field_layout.size;

    if (field_layout.align > max_align) {
      max_align = field_layout.align;
    }
  }

  return {
    type_expr,
    size: align_to(offset, max_align),
    align: max_align,
    fields,
  };
}

function runtime_aggregate_field<ctx extends TypeStaticCtx>(
  name: string,
  field_type_name: string,
  offset: number,
  ctx: ctx,
): RuntimeAggregateField {
  if (field_type_name === "Unit") {
    return { tag: "unit", name };
  }

  const field_type = runtime_aggregate_value_type(field_type_name);

  if (field_type) {
    return {
      tag: "value",
      name,
      offset,
      type: field_type,
      text: field_type_name === "Text",
      union_type_expr: undefined,
    };
  }

  const type_expr: CoreExpr = { tag: "var", name: field_type_name };
  const type_value = static_type_value(type_expr, ctx);

  if (type_value && type_value.tag === "union_type") {
    return {
      tag: "value",
      name,
      offset,
      type: "i32",
      text: false,
      union_type_expr: type_expr,
    };
  }

  if (!type_value || type_value.tag !== "struct_type") {
    throw new Error(
      "Core runtime aggregate field " + name +
        " must be Int, I32, U32, I64, Text, Unit, Resume, a union type, " +
        "or a static-shaped struct type",
    );
  }

  return {
    tag: "struct",
    name,
    type_expr,
    fields: runtime_aggregate_struct_layout(type_expr, type_value, ctx).fields
      .map((field) => shift_runtime_aggregate_field(field, offset)),
  };
}

function runtime_aggregate_type_layout<ctx extends TypeStaticCtx>(
  type_name: string,
  ctx: ctx,
): RuntimeAggregateLayoutInfo {
  if (type_name === "Unit") {
    return { size: 0, align: 1 };
  }

  const value_type = runtime_aggregate_value_type(type_name);

  if (value_type) {
    return {
      size: val_type_size(value_type),
      align: val_type_align(value_type),
    };
  }

  const type_expr: CoreExpr = { tag: "var", name: type_name };
  const type_value = static_type_value(type_expr, ctx);

  if (type_value && type_value.tag === "union_type") {
    return {
      size: val_type_size("i32"),
      align: val_type_align("i32"),
    };
  }

  if (!type_value || type_value.tag !== "struct_type") {
    throw new Error("Missing runtime aggregate layout for type: " + type_name);
  }

  const layout = runtime_aggregate_struct_layout(type_expr, type_value, ctx);
  return { size: layout.size, align: layout.align };
}

function runtime_aggregate_value_type(type_name: string): ValType | undefined {
  if (type_name === "Text") {
    return "i32";
  }

  return core_val_type_from_type_name(type_name);
}

function shift_runtime_aggregate_field(
  field: RuntimeAggregateField,
  base_offset: number,
): RuntimeAggregateField {
  if (field.tag === "value") {
    return {
      ...field,
      offset: field.offset + base_offset,
    };
  }

  if (field.tag === "struct") {
    return {
      ...field,
      fields: field.fields.map((nested) =>
        shift_runtime_aggregate_field(nested, base_offset)
      ),
    };
  }

  return field;
}

function same_runtime_aggregate_type_value<ctx extends TypeStaticCtx>(
  left: Extract<CoreExpr, { tag: "struct_type" }>,
  right: Extract<CoreExpr, { tag: "struct_type" }>,
  ctx: ctx,
): boolean {
  if (left.fields.length !== right.fields.length) {
    return false;
  }

  for (let index = 0; index < left.fields.length; index += 1) {
    const left_field = left.fields[index];
    const right_field = right.fields[index];
    expect(left_field, "Missing left core struct field " + index);
    expect(right_field, "Missing right core struct field " + index);

    if (left_field.name !== right_field.name) {
      return false;
    }

    const left_type = resolve_core_type_name(left_field.type_name, ctx);
    const right_type = resolve_core_type_name(right_field.type_name, ctx);

    if (left_type !== right_type) {
      return false;
    }
  }

  return true;
}
