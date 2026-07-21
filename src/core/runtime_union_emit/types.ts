import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import type { CoreScratchHeap } from "../scratch.ts";
import type {
  RuntimeUnionInfo,
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../runtime_union.ts";
import type { RuntimeUnionBoundPayloadField } from "../runtime_union_match.ts";

export type RuntimeUnionEmitHeap = {
  needed: boolean;
};

export type RuntimeUnionLocalCtx = {
  locals: Map<string, ValType>;
  next_temp: number;
};

export type RuntimeUnionEmitCtx = RuntimeUnionLocalCtx & {
  allocation_permits:
    import("../allocation_emission.ts").CoreAllocationPermitState;
  heap: RuntimeUnionEmitHeap;
  scratch: CoreScratchHeap;
  scratch_return_resets: string[];
};

export type RuntimeUnionIfLetCtx = RuntimeUnionEmitCtx & {
  fn_types: Map<string, CoreFnType>;
  next_loop: number;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  borrowed_locals?: Set<string>;
  frozen_locals?: Set<string>;
};

export type RuntimeUnionPayloadEmitBinding<ctx> = {
  ctx: ctx;
  fields: RuntimeUnionBoundPayloadField[] | undefined;
};

export type RuntimeUnionLocalHooks<ctx extends RuntimeUnionLocalCtx> = {
  collect_expr_locals: (expr: CoreExpr, ctx: ctx) => void;
  core_runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  runtime_union_case_info: (
    value: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => RuntimeUnionInfo;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type RuntimeUnionEmitHooks<ctx extends RuntimeUnionEmitCtx> = {
  core_runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_union_case_info: (
    value: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => RuntimeUnionInfo;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type RuntimeUnionIfLetHooks<ctx extends RuntimeUnionIfLetCtx> = {
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => RuntimeUnionPayloadEmitBinding<ctx>;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: ctx,
    emit_ctx: ctx,
  ) => Wat;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
};
