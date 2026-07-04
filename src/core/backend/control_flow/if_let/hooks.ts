import type { Wat } from "../../../../wat.ts";
import type { CoreExpr } from "../../../ast.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import {
  type CoreIfLetHooks,
  emit_core_if_let_expr,
  emit_core_if_let_stmt,
} from "../../../if_let.ts";
import type { CoreIfLetDispatchHooks } from "../../../if_let_dispatch.ts";
import type { CoreIfLetPayloadEmitHooks } from "../../../if_let_payload.ts";
import type { StaticCtx } from "../../../local_collect.ts";
import type {
  CoreBackendControlFlow,
  CoreBackendControlFlowApi,
} from "../types.ts";

export type CoreBackendBindIfLetPayload = (
  value_name: string | undefined,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: CoreEmitCtx,
) => { setup: Wat; ctx: CoreEmitCtx };

export function create_core_backend_if_let_payload_hooks(
  api: CoreBackendControlFlowApi,
): CoreIfLetPayloadEmitHooks<StaticCtx, CoreEmitCtx> {
  return {
    branch_payload_ctx: api.branch_payload_ctx,
    clear_core_local_facts: api.clear_core_local_facts,
    core_expr_is_text: api.core_expr_is_text,
    emit_expr: api.emit_expr,
    expr_type: api.expr_type,
    runtime_aggregate_type_expr: api.runtime_aggregate_type_expr,
    runtime_union_type_expr: api.runtime_union_type_expr,
    static_struct_value: api.static_struct_value,
  };
}

export function create_core_backend_if_let_hooks(
  api: CoreBackendControlFlowApi,
  bind_payload: CoreBackendBindIfLetPayload,
  merge_if_else_static_assignments: CoreBackendControlFlow[
    "merge_if_else_static_assignments"
  ],
): CoreIfLetHooks<CoreEmitCtx> {
  return {
    bind_payload,
    core_expr_is_text: api.core_expr_is_text,
    dynamic_union_if: api.dynamic_union_if,
    emit_expr: api.emit_expr,
    emit_stmt: api.emit_stmt,
    expr_type: api.expr_type,
    merge_if_else_static_assignments,
    static_union_case: api.static_union_case,
  };
}

export function create_core_backend_if_let_dispatch_hooks(
  api: CoreBackendControlFlowApi,
): CoreIfLetDispatchHooks<CoreEmitCtx> {
  return {
    dynamic_union_if: api.dynamic_union_if,
    emit_core_if_let_expr,
    emit_core_if_let_stmt,
    emit_runtime_union_if_let_expr: api.emit_runtime_union_if_let_expr,
    emit_runtime_union_if_let_stmt: api.emit_runtime_union_if_let_stmt,
    runtime_union_target: api.runtime_union_target,
    static_union_case: api.static_union_case,
  };
}
