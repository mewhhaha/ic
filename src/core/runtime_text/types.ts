import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import type { CoreScratchHeap } from "../scratch.ts";

export type RuntimeTextEq = {
  left: CoreExpr;
  right: CoreExpr;
  prim: "i32.eq" | "i32.ne";
};

export type RuntimeTextHeap = {
  needed: boolean;
};

export type RuntimeTextTempCtx = {
  locals: Map<string, ValType>;
  next_temp: number;
};

export type RuntimeTextLoopCtx = RuntimeTextTempCtx & {
  next_loop: number;
};

export type RuntimeTextEmitCtx = RuntimeTextLoopCtx & {
  allocation_permits:
    import("../allocation_emission.ts").CoreAllocationPermitState;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  scratch_return_resets: string[];
};

export type RuntimeTextHooks<ctx> = {
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_text_concat_operands: (
    expr: CoreExpr,
    ctx: ctx,
  ) => [CoreExpr, CoreExpr] | undefined;
  runtime_text_eq_operands: (
    expr: CoreExpr,
    ctx: ctx,
  ) => RuntimeTextEq | undefined;
};
