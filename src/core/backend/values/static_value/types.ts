import type { ValType } from "../../../../op.ts";
import type { Wat } from "../../../../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../../../ast.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { DynamicUnionIf } from "../../../if_let.ts";
import type { CoreCtx, StaticCtx, TempCtx } from "../../../local_collect.ts";
import type { StaticValuePlan } from "../../../static_values.ts";
import type { StaticStructIfBranches } from "../../../struct_static.ts";
import type { StaticTextIfBranches } from "../../../text_static.ts";

export type CoreBackendStaticValueApi = {
  block_ctx: (ctx: StaticCtx) => StaticCtx;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: TempCtx) => void;
  collect_stmt_locals: (stmt: CoreStmt, ctx: CoreCtx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_stmt: (
    stmt: CoreStmt,
    ctx: CoreEmitCtx,
    is_final: boolean,
  ) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_struct_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: TempCtx,
  ) => StaticStructIfBranches | undefined;
  static_struct_update_value: (
    expr: Extract<CoreExpr, { tag: "struct_update" }>,
    ctx: TempCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: TempCtx,
  ) => StaticTextIfBranches | undefined;
  static_text_value: (expr: CoreExpr, ctx: StaticCtx) => CoreExpr | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type CoreBackendStaticValue = {
  is_static_value_expr: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  plan_static_capture_expr: (
    prefix: string,
    value: CoreExpr,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => StaticValuePlan;
  plan_static_struct_value: (
    value: Extract<CoreExpr, { tag: "struct_value" }>,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => StaticValuePlan;
  plan_static_value_expr: (
    value: CoreExpr,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => StaticValuePlan;
};
