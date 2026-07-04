import type { ValType } from "../../../../op.ts";
import type { Wat } from "../../../../wat.ts";
import type { CoreExpr, CoreFnType, CoreParam } from "../../../ast.ts";
import type { CoreCaptureInfo } from "../../../closure_capture.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { CoreCtx, StaticCtx, TempCtx } from "../../../local_collect.ts";
import type { StaticValuePlan } from "../../../static_values.ts";

export type CoreBackendStaticCallApi = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    arg: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr;
  bind_core_union_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: StaticCtx,
  ) => void;
  bind_core_struct_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: StaticCtx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: CoreCtx) => void;
  core_lam_capture_info: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: TempCtx,
  ) => CoreCaptureInfo;
  create_scoped_static_core_call_ctx: (ctx: StaticCtx) => CoreCtx;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  is_static_value_expr: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  plan_static_value_expr: (
    value: CoreExpr,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => StaticValuePlan;
  static_struct_binding: (
    name: string,
    ctx: TempCtx,
  ) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type CoreBackendStaticCall = {
  collect_scoped_static_core_call_locals: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreCtx,
  ) => void;
  emit_scoped_static_core_call: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  scoped_static_core_call_fn_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  scoped_static_core_call_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => ValType;
  scoped_static_core_call_value: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => { value: CoreExpr; ctx: CoreCtx };
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_rec_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "rec" }> | undefined;
};
