import type { ValType } from "../../op.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import type { RuntimeTextLoopCtx } from "../runtime_text/types.ts";

export type RuntimeUtf8Plan = {
  id: number;
  source: string;
  result: string;
  length: string;
  index: string;
  leading_byte: string;
};

export type RuntimeIntegerFormatPlan = {
  id: number;
  value: string;
  remaining: string;
  quotient: string;
  negative: string;
  digit_count: string;
  length: string;
  position: string;
  result: string;
};

export type RuntimeFloatFormatPlan = {
  id: number;
  value: string;
  precision: string;
  factor_f32: string;
  factor_i64: string;
  magnitude: string;
  negative: string;
  scaled: string;
  integer: string;
  fraction: string;
  quotient: string;
  digit_count: string;
  position: string;
  length: string;
  result: string;
};

export function runtime_utf8_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeUtf8Plan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  return {
    id,
    source: fresh_temp_local(ctx, "utf8_source"),
    result: fresh_temp_local(ctx, "utf8_result"),
    length: fresh_temp_local(ctx, "utf8_length"),
    index: fresh_temp_local(ctx, "utf8_index"),
    leading_byte: fresh_temp_local(ctx, "utf8_leading_byte"),
  };
}

export function declare_runtime_utf8_locals(
  locals: RuntimeUtf8Plan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.source, "i32");
  set_local(ctx.locals, locals.result, "i32");
  set_local(ctx.locals, locals.length, "i32");
  set_local(ctx.locals, locals.index, "i32");
  set_local(ctx.locals, locals.leading_byte, "i32");
}

export function runtime_integer_format_plan(
  type: "i32" | "i64",
  ctx: RuntimeTextLoopCtx,
): RuntimeIntegerFormatPlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const prefix = "format_" + type;
  return {
    id,
    value: fresh_temp_local(ctx, prefix + "_value"),
    remaining: fresh_temp_local(ctx, prefix + "_remaining"),
    quotient: fresh_temp_local(ctx, prefix + "_quotient"),
    negative: fresh_temp_local(ctx, prefix + "_negative"),
    digit_count: fresh_temp_local(ctx, prefix + "_digit_count"),
    length: fresh_temp_local(ctx, prefix + "_length"),
    position: fresh_temp_local(ctx, prefix + "_position"),
    result: fresh_temp_local(ctx, prefix + "_result"),
  };
}

export function declare_runtime_integer_format_locals(
  type: "i32" | "i64",
  locals: RuntimeIntegerFormatPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.value, type);
  set_local(ctx.locals, locals.remaining, type);
  set_local(ctx.locals, locals.quotient, type);
  set_local(ctx.locals, locals.negative, "i32");
  set_local(ctx.locals, locals.digit_count, "i32");
  set_local(ctx.locals, locals.length, "i32");
  set_local(ctx.locals, locals.position, "i32");
  set_local(ctx.locals, locals.result, "i32");
}

export function runtime_float_format_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeFloatFormatPlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const prefix = "format_f32";
  return {
    id,
    value: fresh_temp_local(ctx, prefix + "_value"),
    precision: fresh_temp_local(ctx, prefix + "_precision"),
    factor_f32: fresh_temp_local(ctx, prefix + "_factor_f32"),
    factor_i64: fresh_temp_local(ctx, prefix + "_factor_i64"),
    magnitude: fresh_temp_local(ctx, prefix + "_magnitude"),
    negative: fresh_temp_local(ctx, prefix + "_negative"),
    scaled: fresh_temp_local(ctx, prefix + "_scaled"),
    integer: fresh_temp_local(ctx, prefix + "_integer"),
    fraction: fresh_temp_local(ctx, prefix + "_fraction"),
    quotient: fresh_temp_local(ctx, prefix + "_quotient"),
    digit_count: fresh_temp_local(ctx, prefix + "_digit_count"),
    position: fresh_temp_local(ctx, prefix + "_position"),
    length: fresh_temp_local(ctx, prefix + "_length"),
    result: fresh_temp_local(ctx, prefix + "_result"),
  };
}

export function declare_runtime_float_format_locals(
  locals: RuntimeFloatFormatPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.value, "f32");
  set_local(ctx.locals, locals.precision, "i32");
  set_local(ctx.locals, locals.factor_f32, "f32");
  set_local(ctx.locals, locals.factor_i64, "i64");
  set_local(ctx.locals, locals.magnitude, "f32");
  set_local(ctx.locals, locals.negative, "i32");
  set_local(ctx.locals, locals.scaled, "i64");
  set_local(ctx.locals, locals.integer, "i64");
  set_local(ctx.locals, locals.fraction, "i64");
  set_local(ctx.locals, locals.quotient, "i64");
  set_local(ctx.locals, locals.digit_count, "i32");
  set_local(ctx.locals, locals.position, "i32");
  set_local(ctx.locals, locals.length, "i32");
  set_local(ctx.locals, locals.result, "i32");
}
