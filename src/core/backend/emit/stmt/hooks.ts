import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { CoreStmtEmitHooks } from "../../../stmt_emit.ts";
import type { CoreBackendStmtEmitApi } from "./types.ts";

export function create_core_backend_stmt_emit_hooks(
  api: CoreBackendStmtEmitApi,
): CoreStmtEmitHooks<CoreEmitCtx> {
  return {
    bind_core_assignment_struct_type: api.bind_core_assignment_struct_type,
    bind_core_assignment_union_type: api.bind_core_assignment_union_type,
    bind_core_fn_type: api.bind_core_fn_type,
    bind_core_struct_type: api.bind_core_struct_type,
    bind_core_union_type: api.bind_core_union_type,
    clear_core_local_facts: api.clear_core_local_facts,
    core_binding_value: api.core_binding_value,
    core_type_const_value: api.core_type_const_value,
    core_expr_has_runtime_text_fact: api.core_expr_has_runtime_text_fact,
    emit_collection_loop: api.emit_collection_loop,
    emit_expr: api.emit_expr,
    emit_if_else_stmt: api.emit_if_else_stmt,
    emit_if_let_stmt: api.emit_if_let_stmt,
    emit_if_stmt: api.emit_if_stmt,
    emit_range_loop: api.emit_range_loop,
    emit_runtime_aggregate_index_assign:
      api.emit_runtime_aggregate_index_assign,
    emit_runtime_text_index_assign: api.emit_runtime_text_index_assign,
    emit_static_index_assign: api.emit_static_index_assign,
    is_static_value_expr: api.is_static_value_expr,
    plan_core_lam_capture: api.plan_core_lam_capture,
    plan_static_value_expr: api.plan_static_value_expr,
    static_core_call_target: api.static_core_call_target,
    static_struct_binding: api.static_struct_binding,
  };
}
