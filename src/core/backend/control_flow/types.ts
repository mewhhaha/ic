import type { ValType } from "../../../op.ts";
import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreField, CoreStmt } from "../../ast.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import type { DynamicUnionIf } from "../../if_let.ts";
import type { StaticCtx, TempCtx } from "../../local_collect.ts";
import type { RuntimeUnionTarget } from "../../runtime_union.ts";
import type { StaticValuePlan } from "../../static_values.ts";

export type CoreBackendControlFlowApi = {
  branch_payload_ctx: (ctx: CoreEmitCtx) => CoreEmitCtx;
  clear_core_local_facts: (name: string, ctx: StaticCtx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_runtime_union_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_union_if_let_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: CoreEmitCtx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  plan_static_capture_expr: (
    prefix: string,
    value: CoreExpr,
    ctx: CoreEmitCtx,
    emit_ctx: CoreEmitCtx,
  ) => StaticValuePlan;
  plan_static_struct_value: (
    value: Extract<CoreExpr, { tag: "struct_value" }>,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => StaticValuePlan;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => RuntimeUnionTarget | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreField[] | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type CoreBackendControlFlow = {
  bind_core_if_let_payload_fact: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticCtx,
  ) => void;
  emit_collection_loop: (
    stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_if_else_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_if_let_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_if_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_range_loop: (
    stmt: Extract<CoreStmt, { tag: "range_loop" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ) => Wat;
};
