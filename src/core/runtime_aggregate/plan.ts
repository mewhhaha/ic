import type { ValType } from "../../op.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import type { RuntimeAggregatePlan, RuntimeAggregateTempCtx } from "./types.ts";

export function runtime_aggregate_plan(
  ctx: RuntimeAggregateTempCtx,
): RuntimeAggregatePlan {
  return {
    local: fresh_temp_local(ctx, "aggregate"),
  };
}

export function declare_runtime_aggregate_locals(
  plan: RuntimeAggregatePlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, plan.local, "i32");
}
