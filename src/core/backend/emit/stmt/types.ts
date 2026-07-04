import type { Wat } from "../../../../wat.ts";
import type { CoreExpr, CoreStmt } from "../../../ast.ts";
import type { CoreLamCapturePlan } from "../../../closure_capture.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { StaticValuePlan } from "../../../static_values.ts";

export type CoreBackendStmtEmitApi = {
  bind_core_assignment_union_type: (
    name: string,
    value: CoreExpr,
    mode: "same" | "change",
    ctx: CoreEmitCtx,
  ) => void;
  bind_core_assignment_struct_type: (
    name: string,
    value: CoreExpr,
    mode: "same" | "change",
    ctx: CoreEmitCtx,
  ) => void;
  bind_core_fn_type: (name: string, value: CoreExpr, ctx: CoreEmitCtx) => void;
  bind_core_struct_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: CoreEmitCtx,
  ) => void;
  bind_core_union_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: CoreEmitCtx,
  ) => void;
  clear_core_local_facts: (name: string, ctx: CoreEmitCtx) => void;
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: CoreEmitCtx,
  ) => CoreExpr;
  core_type_const_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: CoreEmitCtx,
  ) => CoreExpr | undefined;
  core_expr_has_runtime_text_fact: (
    value: CoreExpr,
    ctx: CoreEmitCtx,
  ) => boolean;
  emit_collection_loop: (
    stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_if_else_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
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
  emit_runtime_text_index_assign: (
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_aggregate_index_assign: (
    type_expr: CoreExpr,
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_static_index_assign: (
    target: Extract<CoreExpr, { tag: "struct_value" }>,
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  is_static_value_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => boolean;
  plan_core_lam_capture: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreEmitCtx,
    emit_setup: boolean,
  ) => CoreLamCapturePlan | undefined;
  plan_static_value_expr: (
    value: CoreExpr,
    ctx: CoreEmitCtx,
    emit_ctx: CoreEmitCtx,
  ) => StaticValuePlan;
  static_struct_binding: (
    name: string,
    ctx: CoreEmitCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: CoreEmitCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
};

export type CoreBackendStmtEmit = {
  emit_stmt: (stmt: CoreStmt, ctx: CoreEmitCtx, is_final: boolean) => Wat;
};
