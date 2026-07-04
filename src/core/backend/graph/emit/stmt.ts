import type { CoreExpr, CoreStmt } from "../../../ast.ts";
import type { CoreLamCapturePlan } from "../../../closure_capture.ts";
import type { CoreEmitCtx as EmitCtx } from "../../../emit_ctx.ts";
import type { StaticValuePlan } from "../../../static_values.ts";
import type { CoreBackendExprEmit } from "../../emit/expr.ts";
import type { CoreBackendStmtEmit } from "../../emit/stmt.ts";
import { create_core_backend_stmt_emit } from "../../emit/stmt.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";

export function create_core_backend_graph_stmt_emit(
  deps: CoreBackendGraphDeps,
  expr_emit: CoreBackendExprEmit,
): CoreBackendStmtEmit {
  return create_core_backend_stmt_emit({
    bind_core_assignment_struct_type:
      deps.local_facts().bind_core_assignment_struct_type,
    bind_core_assignment_union_type:
      deps.local_facts().bind_core_assignment_union_type,
    bind_core_fn_type: deps.local_facts().bind_core_fn_type,
    bind_core_struct_type: deps.local_facts().bind_core_struct_type,
    bind_core_union_type: deps.local_facts().bind_core_union_type,
    clear_core_local_facts: deps.local_facts().clear_core_local_facts,
    core_binding_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      ctx: EmitCtx,
    ) => deps.type_check().core_binding_value(stmt, ctx),
    core_type_const_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      value: CoreExpr,
      ctx: EmitCtx,
    ) => deps.type_check().core_type_const_value(stmt, value, ctx),
    core_expr_has_runtime_text_fact: (value: CoreExpr, ctx: EmitCtx) =>
      deps.text().core_expr_has_runtime_text_fact(value, ctx),
    emit_collection_loop: (
      stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
      ctx: EmitCtx,
    ) => deps.control_flow().emit_collection_loop(stmt, ctx),
    emit_expr: expr_emit.emit_expr,
    emit_if_else_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
      ctx: EmitCtx,
    ) => deps.control_flow().emit_if_else_stmt(stmt, ctx),
    emit_if_let_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
      ctx: EmitCtx,
    ) => deps.control_flow().emit_if_let_stmt(stmt, ctx),
    emit_if_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
      ctx: EmitCtx,
    ) => deps.control_flow().emit_if_stmt(stmt, ctx),
    emit_range_loop: (
      stmt: Extract<CoreStmt, { tag: "range_loop" }>,
      ctx: EmitCtx,
    ) => deps.control_flow().emit_range_loop(stmt, ctx),
    emit_runtime_text_index_assign: (
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: EmitCtx,
    ) => deps.text().emit_runtime_text_index_assign(stmt, ctx),
    emit_runtime_aggregate_index_assign: (
      type_expr: CoreExpr,
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: EmitCtx,
    ) =>
      deps.index().emit_runtime_aggregate_index_assign(
        type_expr,
        stmt,
        ctx,
      ),
    emit_static_index_assign: (
      target: Extract<CoreExpr, { tag: "struct_value" }>,
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: EmitCtx,
    ) => deps.index().emit_static_index_assign(target, stmt, ctx),
    is_static_value_expr: (expr: CoreExpr, ctx: EmitCtx) =>
      deps.static_value().is_static_value_expr(expr, ctx),
    plan_core_lam_capture: (
      expr: Extract<CoreExpr, { tag: "lam" }>,
      ctx: EmitCtx,
      emit_setup: boolean,
    ): CoreLamCapturePlan | undefined =>
      deps.closure().plan_core_lam_capture(expr, ctx, emit_setup),
    plan_static_value_expr: (
      value: CoreExpr,
      ctx: EmitCtx,
      emit_ctx: EmitCtx,
    ): StaticValuePlan =>
      deps.static_value().plan_static_value_expr(value, ctx, emit_ctx),
    static_core_call_target: (expr: CoreExpr, ctx: EmitCtx) =>
      deps.static_call().static_core_call_target(expr, ctx),
    static_struct_binding: (name: string, ctx: EmitCtx) =>
      deps.struct().static_struct_binding(name, ctx),
  });
}
