import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import { fresh_temp_local } from "./emit/name.ts";
import { set_local } from "./emit/local.ts";

export const scratch_heap_global = "__scratch_heap";

export type CoreScratchHeap = {
  needed: boolean;
};

type CoreScratchTempCtx = {
  next_temp: number;
};

type CoreScratchLocalCtx = CoreScratchTempCtx & {
  locals: Map<string, ValType>;
};

type CoreScratchEmitCtx = CoreScratchLocalCtx & {
  scratch: CoreScratchHeap;
};

export type CoreScratchPlan = {
  base: string;
  result: string;
};

export function core_scratch_plan(
  ctx: CoreScratchTempCtx,
): CoreScratchPlan {
  return {
    base: fresh_temp_local(ctx, "scratch_base"),
    result: fresh_temp_local(ctx, "scratch_result"),
  };
}

export function declare_core_scratch_locals(
  plan: CoreScratchPlan,
  result_type: ValType,
  ctx: CoreScratchLocalCtx,
): void {
  set_local(ctx.locals, plan.base, "i32");
  set_local(ctx.locals, plan.result, result_type);
}

export function emit_core_scratch_expr<ctx extends CoreScratchEmitCtx>(
  body_wat: Wat,
  plan: CoreScratchPlan,
  result_type: ValType,
  ctx: ctx,
): Wat {
  declare_core_scratch_locals(plan, result_type, ctx);
  ctx.scratch.needed = true;

  return [
    "global.get $" + scratch_heap_global,
    "local.set $" + plan.base,
    body_wat,
    "local.set $" + plan.result,
    "local.get $" + plan.base,
    "global.set $" + scratch_heap_global,
    "local.get $" + plan.result,
  ].join("\n");
}

export function emit_core_scratch_resets(
  names: string[],
): Wat {
  const lines: string[] = [];

  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index];

    if (name !== undefined) {
      lines.push("local.get $" + name);
      lines.push("global.set $" + scratch_heap_global);
    }
  }

  return lines.join("\n");
}
