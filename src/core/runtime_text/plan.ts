import type { ValType } from "../../op.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import type { RuntimeTextLoopCtx, RuntimeTextTempCtx } from "./types.ts";

export type RuntimeTextConcatPlan = {
  id: number;
  result: string;
  left: string;
  right: string;
  left_len: string;
  right_len: string;
  total_len: string;
  index: string;
};

export type RuntimeTextIndexAssignPlan = {
  index: string;
  value: string;
};

export type RuntimeTextEqPlan = {
  id: number;
  left: string;
  right: string;
  left_len: string;
  right_len: string;
  index: string;
  result: string;
};

export type RuntimeTextSlicePlan = {
  id: number;
  text: string;
  start: string;
  end: string;
  source_len: string;
  result: string;
  slice_len: string;
  index: string;
};

export function runtime_text_concat_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeTextConcatPlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;

  return {
    id,
    result: fresh_temp_local(ctx, "text_concat_result"),
    left: fresh_temp_local(ctx, "text_concat_left"),
    right: fresh_temp_local(ctx, "text_concat_right"),
    left_len: fresh_temp_local(ctx, "text_concat_left_len"),
    right_len: fresh_temp_local(ctx, "text_concat_right_len"),
    total_len: fresh_temp_local(ctx, "text_concat_total_len"),
    index: fresh_temp_local(ctx, "text_concat_index"),
  };
}

export function runtime_text_eq_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeTextEqPlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;

  return {
    id,
    left: fresh_temp_local(ctx, "text_eq_left"),
    right: fresh_temp_local(ctx, "text_eq_right"),
    left_len: fresh_temp_local(ctx, "text_eq_left_len"),
    right_len: fresh_temp_local(ctx, "text_eq_right_len"),
    index: fresh_temp_local(ctx, "text_eq_index"),
    result: fresh_temp_local(ctx, "text_eq_result"),
  };
}

export function runtime_text_slice_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeTextSlicePlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;

  return {
    id,
    text: fresh_temp_local(ctx, "text_slice_text"),
    start: fresh_temp_local(ctx, "text_slice_start"),
    end: fresh_temp_local(ctx, "text_slice_end"),
    source_len: fresh_temp_local(ctx, "text_slice_source_len"),
    result: fresh_temp_local(ctx, "text_slice_result"),
    slice_len: fresh_temp_local(ctx, "text_slice_len"),
    index: fresh_temp_local(ctx, "text_slice_index"),
  };
}

export function runtime_text_index_assign_plan(
  ctx: RuntimeTextTempCtx,
): RuntimeTextIndexAssignPlan {
  return {
    index: fresh_temp_local(ctx, "text_assign_index"),
    value: fresh_temp_local(ctx, "text_assign_value"),
  };
}

export function declare_runtime_text_concat_locals(
  locals: RuntimeTextConcatPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.result, "i32");
  set_local(ctx.locals, locals.left, "i32");
  set_local(ctx.locals, locals.right, "i32");
  set_local(ctx.locals, locals.left_len, "i32");
  set_local(ctx.locals, locals.right_len, "i32");
  set_local(ctx.locals, locals.total_len, "i32");
  set_local(ctx.locals, locals.index, "i32");
}

export function declare_runtime_text_eq_locals(
  locals: RuntimeTextEqPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.left, "i32");
  set_local(ctx.locals, locals.right, "i32");
  set_local(ctx.locals, locals.left_len, "i32");
  set_local(ctx.locals, locals.right_len, "i32");
  set_local(ctx.locals, locals.index, "i32");
  set_local(ctx.locals, locals.result, "i32");
}

export function declare_runtime_text_slice_locals(
  locals: RuntimeTextSlicePlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.text, "i32");
  set_local(ctx.locals, locals.start, "i32");
  set_local(ctx.locals, locals.end, "i32");
  set_local(ctx.locals, locals.source_len, "i32");
  set_local(ctx.locals, locals.result, "i32");
  set_local(ctx.locals, locals.slice_len, "i32");
  set_local(ctx.locals, locals.index, "i32");
}

export function declare_runtime_text_index_assign_locals(
  locals: RuntimeTextIndexAssignPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.index, "i32");
  set_local(ctx.locals, locals.value, "i32");
}
