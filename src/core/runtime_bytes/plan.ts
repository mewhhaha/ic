import type { ValType } from "../../op.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import type { RuntimeTextLoopCtx } from "../runtime_text/types.ts";

export type RuntimeBytesGeneratePlan = {
  id: number;
  result: string;
  length: string;
  index: string;
};

export function runtime_bytes_generate_plan(
  ctx: RuntimeTextLoopCtx,
): RuntimeBytesGeneratePlan {
  const id = ctx.next_loop;
  ctx.next_loop += 1;

  return {
    id,
    result: fresh_temp_local(ctx, "bytes_generate_result"),
    length: fresh_temp_local(ctx, "bytes_generate_length"),
    index: fresh_temp_local(ctx, "bytes_generate_index"),
  };
}

export function declare_runtime_bytes_generate_locals(
  locals: RuntimeBytesGeneratePlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, locals.result, "i32");
  set_local(ctx.locals, locals.length, "i32");
  set_local(ctx.locals, locals.index, "i32");
}
