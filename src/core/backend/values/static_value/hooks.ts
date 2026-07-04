import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { CoreCtx, StaticCtx, TempCtx } from "../../../local_collect.ts";
import { is_stable_static_expr } from "../../../static_stability.ts";
import type {
  StaticValueHooks,
  StaticValueRecognitionHooks,
} from "../../../static_values.ts";
import type { CoreBackendStaticValueApi } from "./types.ts";

export function create_core_backend_static_value_hooks(
  api: CoreBackendStaticValueApi,
): StaticValueHooks<TempCtx, CoreEmitCtx> {
  return {
    block_ctx: (ctx) => api.block_ctx(ctx) as TempCtx,
    closure_fn_type: api.closure_fn_type,
    collect_stmt_locals: (stmt, ctx) =>
      api.collect_stmt_locals(stmt, ctx as CoreCtx),
    collect_expr_locals: api.collect_expr_locals,
    core_expr_is_text: api.core_expr_is_text,
    dynamic_union_if: api.dynamic_union_if,
    emit_expr: api.emit_expr,
    emit_stmt: api.emit_stmt,
    expr_type: api.expr_type,
    frozen_local,
    is_stable_static_expr,
    runtime_aggregate_type_expr: api.runtime_aggregate_type_expr,
    runtime_union_type_expr: api.runtime_union_type_expr,
    static_core_call_value: api.static_core_call_value,
    static_struct_if_branches: api.static_struct_if_branches,
    static_struct_update_value: api.static_struct_update_value,
    static_struct_value: api.static_struct_value,
    static_text_if_branches: api.static_text_if_branches,
    static_text_value: api.static_text_value,
    static_union_case: api.static_union_case,
  };
}

export function create_core_backend_static_value_recognition_hooks(
  api: CoreBackendStaticValueApi,
): StaticValueRecognitionHooks<StaticCtx> {
  return {
    block_ctx: api.block_ctx,
    closure_fn_type: api.closure_fn_type,
    collect_stmt_locals: (stmt, ctx) =>
      api.collect_stmt_locals(stmt, ctx as CoreCtx),
    core_expr_is_text: api.core_expr_is_text,
    dynamic_union_if: api.dynamic_union_if,
    expr_type: api.expr_type,
    frozen_local,
    runtime_aggregate_type_expr: api.runtime_aggregate_type_expr,
    runtime_union_type_expr: api.runtime_union_type_expr,
    static_core_call_value: api.static_core_call_value,
    static_struct_value: api.static_struct_value,
    static_text_value: api.static_text_value,
    static_union_case: api.static_union_case,
  };
}

function frozen_local<ctx extends { frozen_locals?: Set<string> }>(
  name: string,
  ctx: ctx,
): boolean {
  if (!ctx.frozen_locals) {
    return false;
  }

  return ctx.frozen_locals.has(name);
}
