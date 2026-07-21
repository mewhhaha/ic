import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreFnType, CoreParam } from "../ast.ts";
import type { CoreCaptureInfo } from "../closure_capture.ts";
import type { StaticValuePlan } from "../static_values.ts";

export type StaticCoreCallCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  borrowed_locals?: Set<string>;
  materialized_bindings?: Set<string>;
};

export type StaticCoreCallTempCtx = StaticCoreCallCtx & {
  next_temp: number;
};

export type StaticCoreCallBlockCtx = StaticCoreCallTempCtx & {
  next_loop: number;
};

export type StaticCoreCallHooks<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
> = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    arg: CoreExpr,
    ctx: static_ctx,
  ) => CoreExpr;
  bind_core_union_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: static_ctx,
  ) => void;
  bind_core_struct_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: static_ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: static_ctx,
  ) => CoreFnType | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: block_ctx) => void;
  core_lam_capture_info: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: temp_ctx,
  ) => CoreCaptureInfo;
  create_scoped_static_core_call_ctx: (ctx: static_ctx) => block_ctx;
  emit_expr: (expr: CoreExpr, ctx: emit_ctx) => Wat;
  expr_type: (expr: CoreExpr, ctx: static_ctx) => ValType;
  is_static_value_expr: (expr: CoreExpr, ctx: static_ctx) => boolean;
  plan_static_value_expr: (
    value: CoreExpr,
    ctx: temp_ctx,
    emit_ctx: emit_ctx | undefined,
  ) => StaticValuePlan;
  static_struct_binding: (name: string, ctx: temp_ctx) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: static_ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};
