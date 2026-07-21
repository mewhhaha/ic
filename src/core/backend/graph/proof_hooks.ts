import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type { CoreCtx } from "../../local_collect.ts";
import { core_host_import_result_ownership } from "../../host_import.ts";
import { core_expr_ownership } from "../../ownership.ts";
import type { CoreOwnershipHooks } from "../../ownership.ts";
import { runtime_aggregate_type_expr } from "../../runtime_aggregate.ts";
import { create_child_core_ctx, create_scratch_core_ctx } from "./context.ts";
import { collect_stmt_locals_for_proof } from "./drop_context.ts";
import {
  core_borrow_closure_body_ctx as graph_core_borrow_closure_body_ctx,
  core_drop_closure_body_ctx as graph_core_drop_closure_body_ctx,
  core_drop_collection_loop_body_ctx
    as graph_core_drop_collection_loop_body_ctx,
  core_drop_if_let_branch_ctx as graph_core_drop_if_let_branch_ctx,
  core_host_boundary_closure_body_ctx
    as graph_core_host_boundary_closure_body_ctx,
  create_core_runtime_union_match_child_ctx,
} from "./proof_context.ts";
import type { CoreBackendGraph } from "./types.ts";
import { static_core_call_branch_app } from "../../static_call.ts";

export function core_ownership_hooks(
  backend: CoreBackendGraph,
): CoreOwnershipHooks<CoreCtx> {
  return {
    bind_core_if_let_payload_fact:
      backend.control_flow.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: backend.union.bind_dynamic_if_let_payload,
    block_ctx: create_child_core_ctx,
    closure_fn_type: backend.closure.closure_fn_type,
    collect_stmt_locals: (stmt: CoreStmt, ctx: CoreCtx) =>
      collect_stmt_locals_for_proof(backend, stmt, ctx),
    core_expr_is_text: backend.text.core_expr_is_text,
    dynamic_union_if: backend.union.dynamic_union_if,
    expr_type: backend.expr_type.expr_type,
    borrowed_local: core_borrowed_local,
    frozen_local: core_frozen_local,
    host_import_result_ownership: core_host_import_result_ownership,
    if_let_branch_ctx: create_child_core_ctx,
    runtime_union_match_info: backend.union.runtime_union_match_info,
    runtime_union_target: backend.union.runtime_union_target,
    runtime_aggregate_type_expr: (value, ctx) =>
      core_runtime_aggregate_type_for_ownership(backend, value, ctx),
    runtime_union_value: backend.union.core_runtime_union_value,
    scratch_return_ctx: create_scratch_core_ctx,
    static_runtime_union_match_branch_ctx:
      create_core_runtime_union_match_child_ctx,
    static_struct_value: backend.struct.static_struct_value,
    static_core_call_requires_scope:
      backend.static_call.static_core_call_requires_scope,
    scoped_static_core_call_value:
      backend.static_call.scoped_static_core_call_value,
    static_core_call_target: backend.static_call.static_core_call_target,
    static_core_call_value: backend.static_call.static_core_call_value,
    static_capture_value: (name, ctx) => ctx.static_capture_values?.get(name),
    static_text_value: backend.text.static_text_value,
    static_union_case: backend.union.static_union_case,
  };
}

export function core_static_call_proof_hooks(
  backend: CoreBackendGraph,
) {
  return {
    ...core_ownership_hooks(backend),
    closure_body_ctx: (
      expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
      ctx: CoreCtx,
    ) => core_cleanup_closure_body_ctx(backend, expr, ctx),
    scoped_static_core_call_value:
      backend.static_call.scoped_static_core_call_value,
    static_core_call_requires_scope:
      backend.static_call.static_core_call_requires_scope,
    static_core_call_target: backend.static_call.static_core_call_target,
  };
}

export function core_allocation_hooks(
  backend: CoreBackendGraph,
) {
  return {
    ...core_ownership_hooks(backend),
    core_assignment_value: backend.type_check.core_assignment_value,
    core_binding_value: backend.type_check.core_binding_value,
    closure_body_ctx: (
      expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
      ctx: CoreCtx,
    ) => core_drop_closure_body_ctx(backend, expr, ctx),
    closure_fn_type: (expr: CoreExpr, ctx: CoreCtx) =>
      core_allocation_closure_fn_type(backend, expr, ctx),
    is_runtime_text_concat: (
      expr: Extract<CoreExpr, { tag: "prim" }>,
      ctx: CoreCtx,
    ) => {
      if (backend.text.core_runtime_text_concat_operands(expr, ctx)) {
        return true;
      }

      return false;
    },
    local_value_exists: (name: string, ctx: CoreCtx) => {
      if (ctx.locals.has(name)) {
        return true;
      }
      if (ctx.text_locals.has(name)) {
        return true;
      }
      if (ctx.struct_locals.has(name)) {
        return true;
      }
      return ctx.union_locals.has(name);
    },
    materialized_binding: (name: string, ctx: CoreCtx) => {
      return ctx.materialized_bindings?.has(name) === true;
    },
    mutable_binding: (name: string, ctx: CoreCtx) => {
      return ctx.mutable_bindings?.has(name) === true;
    },
    is_static_value_expr: backend.static_value.is_static_value_expr,
    static_collection_fields: backend.struct.static_collection_fields,
    scoped_static_core_call_value:
      backend.static_call.scoped_static_core_call_value,
    static_core_call_branch_app: (
      expr: Extract<CoreExpr, { tag: "app" }>,
      ctx: CoreCtx,
    ) => {
      return static_core_call_branch_app(expr, ctx, {
        static_core_call_target: backend.static_call.static_core_call_target,
      });
    },
    static_core_call_requires_scope:
      backend.static_call.static_core_call_requires_scope,
    static_core_call_target: backend.static_call.static_core_call_target,
    static_core_call_value: backend.static_call.static_core_call_value,
  };
}

export function core_closure_ownership_hooks(
  backend: CoreBackendGraph,
) {
  return {
    ...core_ownership_hooks(backend),
    block_ctx: create_child_core_ctx,
    collect_stmt_locals: (stmt: CoreStmt, ctx: CoreCtx) =>
      collect_stmt_locals_for_proof(backend, stmt, ctx),
    core_lam_capture_info: backend.closure.core_lam_capture_info,
  };
}

export function core_borrow_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
) {
  return graph_core_borrow_closure_body_ctx(expr, ctx);
}

export function core_host_boundary_closure_body_ctx(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
) {
  return graph_core_host_boundary_closure_body_ctx(backend, expr, ctx);
}

export function core_drop_closure_body_ctx(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreCtx | undefined {
  return graph_core_drop_closure_body_ctx(backend, expr, ctx);
}

export function core_drop_collection_loop_body_ctx(
  backend: CoreBackendGraph,
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
): { tag: "scan"; ctx: CoreCtx } | { tag: "skip" } {
  return graph_core_drop_collection_loop_body_ctx(backend, stmt, ctx);
}

export function core_drop_if_let_branch_ctx(
  backend: CoreBackendGraph,
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: CoreCtx,
):
  | { tag: "scan"; ctx: CoreCtx }
  | { tag: "skip" }
  | { tag: "unknown" } {
  return graph_core_drop_if_let_branch_ctx(
    backend,
    case_name,
    value_name,
    target,
    ctx,
  );
}

export function core_static_value(
  name: string,
  ctx: CoreCtx,
): CoreExpr | undefined {
  return ctx.statics.get(name);
}

export function core_runtime_aggregate_type_for_ownership(
  backend: CoreBackendGraph,
  value: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return runtime_aggregate_type_expr(value, ctx, {
      check_closure_call_args: backend.closure.check_closure_call_args,
      closure_fn_type: backend.closure.closure_fn_type,
    });
  } catch (error) {
    if (core_runtime_aggregate_ownership_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

export function core_final_expr_ownership(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
) {
  return core_expr_ownership(expr, ctx, core_static_call_proof_hooks(backend));
}

function core_frozen_local(name: string, ctx: CoreCtx): boolean {
  if (!ctx.frozen_locals) {
    return false;
  }

  return ctx.frozen_locals.has(name);
}

function core_borrowed_local(name: string, ctx: CoreCtx): boolean {
  if (!ctx.borrowed_locals) {
    return false;
  }

  return ctx.borrowed_locals.has(name);
}

function core_cleanup_closure_body_ctx(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreCtx | undefined {
  for (const param of expr.params) {
    if (param.is_const) {
      return undefined;
    }
  }

  return core_drop_closure_body_ctx(backend, expr, ctx);
}

function core_allocation_closure_fn_type(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
) {
  try {
    return backend.closure.closure_fn_type(expr, ctx);
  } catch (error) {
    if (core_runtime_aggregate_ownership_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function core_runtime_aggregate_ownership_probe_error(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Core first-class closure parameter must use a scalar annotation:",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "First-class closure ownership-qualified parameter annotations are " +
        "not supported yet:",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "Core runtime aggregate requires a static struct type",
    )
  ) {
    return true;
  }

  return false;
}
