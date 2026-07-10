import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr } from "./ast.ts";
import { find_core_field } from "./backend/util.ts";
import { align_to, val_type_size } from "./memory.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
  static_type_value,
  type TypeStaticCtx,
} from "./type_static.ts";

export type RuntimeUnionPayload =
  | { tag: "none" }
  | {
    tag: "value";
    type: ValType;
    text: boolean;
    union_type_expr?: CoreExpr;
  }
  | {
    tag: "aggregate";
    type_expr: CoreExpr;
  }
  | {
    tag: "struct";
    type_expr: CoreExpr;
    fields: RuntimeUnionPayloadField[];
  };

export type RuntimeUnionPayloadField =
  | {
    tag: "value";
    name: string;
    offset: number;
    type: ValType;
    text: boolean;
    union_type_expr?: CoreExpr;
  }
  | {
    tag: "struct";
    name: string;
    type_expr: CoreExpr;
    fields: RuntimeUnionPayloadField[];
  };

export type RuntimeUnionPayloadHooks<ctx extends TypeStaticCtx> = {
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  same_runtime_union_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export function runtime_union_payload<ctx extends TypeStaticCtx>(
  type_name: string,
  ctx: ctx,
): RuntimeUnionPayload {
  const resolved_type_name = resolve_core_type_name(type_name, ctx);

  if (resolved_type_name === "Unit") {
    return { tag: "none" };
  }

  const payload_type = runtime_union_payload_type(resolved_type_name);

  if (payload_type) {
    return {
      tag: "value",
      type: payload_type,
      text: resolved_type_name === "Text",
    };
  }

  const type_expr: CoreExpr = { tag: "var", name: resolved_type_name };
  const type_value = static_type_value(type_expr, ctx);

  if (type_value && type_value.tag === "union_type") {
    return {
      tag: "value",
      type: "i32",
      text: false,
      union_type_expr: type_expr,
    };
  }

  if (type_value && type_value.tag === "struct_type") {
    return { tag: "aggregate", type_expr };
  }

  throw new Error(
    "Core runtime union payloads must be Int, I32, U32, I64, Text, Unit, " +
      "Resume, a union type, or a struct type",
  );
}

export function runtime_union_payload_size(
  payload: RuntimeUnionPayload,
): number {
  if (payload.tag === "none") {
    return 0;
  }

  if (payload.tag === "value") {
    return val_type_size(payload.type);
  }

  if (payload.tag === "aggregate") {
    return val_type_size("i32");
  }

  let size = 0;

  for (const field of runtime_union_payload_leaf_fields(payload.fields)) {
    const end = field.offset - 4 + val_type_size(field.type);

    if (end > size) {
      size = end;
    }
  }

  return size;
}

export function check_runtime_union_struct_payload<
  ctx extends TypeStaticCtx,
>(
  case_name: string,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  payload: Extract<RuntimeUnionPayload, { tag: "struct" }>,
  ctx: ctx,
  hooks: RuntimeUnionPayloadHooks<ctx>,
): void {
  check_runtime_union_struct_payload_fields(
    case_name,
    value,
    payload.fields,
    ctx,
    hooks,
  );
}

export function check_runtime_union_value_payload<
  ctx extends TypeStaticCtx,
>(
  label: string,
  value: CoreExpr,
  payload: Extract<RuntimeUnionPayload, { tag: "value" }>,
  ctx: ctx,
  hooks: RuntimeUnionPayloadHooks<ctx>,
): void {
  if (payload.union_type_expr) {
    const actual = hooks.runtime_union_type_expr(value, ctx);
    expect(
      actual &&
        hooks.same_runtime_union_type_expr(
          payload.union_type_expr,
          actual,
          ctx,
        ),
      label + " expects a matching union value",
    );
    return;
  }

  if (payload.text) {
    expect(hooks.core_expr_is_text(value, ctx), label + " expects Text");
    return;
  }

  const actual = hooks.expr_type(value, ctx);
  expect(
    actual === payload.type,
    label + " expects " + payload.type + ", got " + actual,
  );
}

export function check_runtime_union_aggregate_payload<
  ctx extends TypeStaticCtx,
>(
  label: string,
  value: CoreExpr,
  payload: Extract<RuntimeUnionPayload, { tag: "aggregate" }>,
  ctx: ctx,
  hooks: RuntimeUnionPayloadHooks<ctx>,
): void {
  const actual = hooks.runtime_aggregate_type_expr(value, ctx);
  expect(
    actual &&
      hooks.same_runtime_aggregate_type_expr(
        payload.type_expr,
        actual,
        ctx,
      ),
    label + " expects a matching aggregate value",
  );
}

function runtime_union_payload_type(
  type_name: string,
): ValType | undefined {
  if (type_name === "Text") {
    return "i32";
  }

  return core_val_type_from_type_name(type_name);
}

function runtime_union_struct_payload_fields<ctx extends TypeStaticCtx>(
  type_value: Extract<CoreExpr, { tag: "struct_type" }>,
  ctx: ctx,
  offset: { value: number },
): RuntimeUnionPayloadField[] {
  const fields: RuntimeUnionPayloadField[] = [];

  for (const field of type_value.fields) {
    const field_type_name = resolve_core_type_name(field.type_name, ctx);
    const field_type = runtime_union_payload_type(field_type_name);

    if (field_type) {
      offset.value = align_to(offset.value, val_type_size(field_type));
      fields.push({
        tag: "value",
        name: field.name,
        offset: offset.value,
        type: field_type,
        text: field_type_name === "Text",
      });
      offset.value += val_type_size(field_type);
      continue;
    }

    const type_expr: CoreExpr = { tag: "var", name: field_type_name };
    const type_value = static_type_value(type_expr, ctx);

    if (type_value && type_value.tag === "union_type") {
      offset.value = align_to(offset.value, val_type_size("i32"));
      fields.push({
        tag: "value",
        name: field.name,
        offset: offset.value,
        type: "i32",
        text: false,
        union_type_expr: type_expr,
      });
      offset.value += val_type_size("i32");
      continue;
    }

    if (!type_value || type_value.tag !== "struct_type") {
      throw new Error(
        "Core runtime union struct payload field " + field.name +
          " must be Int, I32, U32, I64, Text, Resume, a union type, " +
          "or a static-shaped struct type",
      );
    }

    fields.push({
      tag: "struct",
      name: field.name,
      type_expr,
      fields: runtime_union_struct_payload_fields(type_value, ctx, offset),
    });
  }

  return fields;
}

function runtime_union_payload_leaf_fields(
  fields: RuntimeUnionPayloadField[],
): Extract<RuntimeUnionPayloadField, { tag: "value" }>[] {
  const leaves: Extract<RuntimeUnionPayloadField, { tag: "value" }>[] = [];

  for (const field of fields) {
    if (field.tag === "value") {
      leaves.push(field);
      continue;
    }

    leaves.push(...runtime_union_payload_leaf_fields(field.fields));
  }

  return leaves;
}

function check_runtime_union_struct_payload_fields<
  ctx extends TypeStaticCtx,
>(
  case_name: string,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  payload_fields: RuntimeUnionPayloadField[],
  ctx: ctx,
  hooks: RuntimeUnionPayloadHooks<ctx>,
): void {
  for (const payload_field of payload_fields) {
    const field = find_core_field(value.fields, payload_field.name);
    expect(
      field,
      "Core runtime union case " + case_name + " missing struct field " +
        payload_field.name,
    );

    if (payload_field.tag === "struct") {
      const struct_value = hooks.static_struct_value(field.value, ctx);
      expect(
        struct_value,
        "Core runtime union case " + case_name + " struct field " +
          payload_field.name + " expects a static-shaped struct",
      );
      check_runtime_union_struct_payload_fields(
        case_name,
        struct_value,
        payload_field.fields,
        ctx,
        hooks,
      );
      continue;
    }

    check_runtime_union_value_payload(
      "Core runtime union case " + case_name + " struct field " +
        payload_field.name,
      field.value,
      payload_field,
      ctx,
      hooks,
    );
  }
}
