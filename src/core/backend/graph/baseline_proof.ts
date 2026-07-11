import { expect } from "../../../expect.ts";
import type { Core as CoreNode, CoreExpr, CoreStmt } from "../../ast.ts";
import {
  core_allocation_plan,
  link_drop_allocations,
} from "../../allocation.ts";
import { core_borrow_plan, core_validate_borrow_plan } from "../../borrow.ts";
import { core_cleanup_plan } from "../../cleanup.ts";
import { core_closure_ownership_plan } from "../../closure_ownership.ts";
import { core_drop_plan } from "../../drop.ts";
import { core_escape_analysis } from "../../escape.ts";
import {
  core_host_boundary_plan,
  type CoreHostBoundaryPlan,
} from "../../host_boundary.ts";
import { core_host_import_for_app } from "../../host_import.ts";
import { core_lifetime_plan } from "../../lifetime_scope.ts";
import type { CoreCtx } from "../../local_collect.ts";
import {
  core_baseline_proof,
  core_freeze_proof_edges,
  core_unsupported_codegen_issues,
  type CoreBaselineProof,
} from "../../proof.ts";
import {
  core_transfer_validation,
  plan_conditional_transfer_cleanup,
  resolve_conditional_transfer_cleanup,
} from "../../transfer.ts";
import { create_child_core_ctx } from "./context.ts";
import {
  collect_core_borrow_ctx as graph_collect_core_borrow_ctx,
  collect_core_drop_ctx as graph_collect_core_drop_ctx,
  collect_stmt_locals_for_proof as graph_collect_stmt_locals_for_proof,
  drop_analysis_static_expr_value as graph_drop_analysis_static_expr_value,
} from "./drop_context.ts";
import {
  core_unsupported_codegen_issue_exists,
  core_unsupported_codegen_issue_from_analysis_error,
  core_unsupported_codegen_proof,
} from "./proof_unsupported.ts";
import {
  core_collection_loop_supported,
  core_if_let_target_supported,
  core_index_assign_supported,
  core_index_expr_supported,
  core_type_value_expr,
  core_unsupported_final_expr_issue,
} from "./proof_support.ts";
import {
  core_allocation_hooks as graph_core_allocation_hooks,
  core_borrow_closure_body_ctx as graph_core_borrow_closure_body_ctx,
  core_closure_ownership_hooks as graph_core_closure_ownership_hooks,
  core_drop_closure_body_ctx as graph_core_drop_closure_body_ctx,
  core_drop_collection_loop_body_ctx
    as graph_core_drop_collection_loop_body_ctx,
  core_drop_if_let_branch_ctx as graph_core_drop_if_let_branch_ctx,
  core_final_expr_ownership,
  core_host_boundary_closure_body_ctx
    as graph_core_host_boundary_closure_body_ctx,
  core_ownership_hooks as graph_core_ownership_hooks,
  core_static_call_proof_hooks as graph_core_static_call_proof_hooks,
  core_static_value as graph_core_static_value,
} from "./proof_hooks.ts";
import type { CoreBackendGraph } from "./types.ts";
import { core_runtime_slice_facts } from "../../runtime_slice.ts";

export function core_backend_host_boundaries(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreHostBoundaryPlan {
  const ctx = collect_core_borrow_ctx(backend, core);
  return core_host_boundary_plan(core, ctx, {
    ...graph_core_ownership_hooks(backend),
    closure_body_ctx: (expr, ctx) =>
      graph_core_host_boundary_closure_body_ctx(backend, expr, ctx),
    static_core_call_target: backend.static_call.static_core_call_target,
    static_core_call_value: backend.static_call.static_core_call_value,
    static_core_rec_target: backend.static_call.static_core_rec_target,
  });
}

export function core_backend_proof(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreBaselineProof {
  let ctx: CoreCtx;

  try {
    ctx = collect_core_drop_ctx(backend, core);
  } catch (error) {
    const unsupported = core_unsupported_codegen_issue_from_analysis_error(
      error,
    );

    if (unsupported) {
      return core_unsupported_codegen_proof(core, [unsupported]);
    }

    throw error;
  }

  const drop_ctx = ctx;
  // The unsupported scan walks into block bodies whose local facts are
  // not part of the top-level ctx, so it maintains its own scoped fact
  // ctx: statement lists push a child ctx and every scanned statement
  // contributes its facts for the statements after it.
  const scan_ctx_stack: CoreCtx[] = [];
  let scan_ctx = create_child_core_ctx(ctx);
  const unsupported_codegen = core_unsupported_codegen_issues(core, {
    collection_loop_supported: (stmt) =>
      core_collection_loop_supported(backend, stmt, scan_ctx),
    index_assign_supported: (stmt) =>
      core_index_assign_supported(backend, stmt, scan_ctx),
    type_value_expr: (expr) => core_type_value_expr(expr, scan_ctx),
    if_let_expr_supported: (expr) =>
      core_if_let_target_supported(backend, expr.target, scan_ctx),
    if_let_stmt_supported: (stmt) =>
      core_if_let_target_supported(backend, stmt.target, scan_ctx),
    index_expr_supported: (expr) =>
      core_index_expr_supported(backend, expr, scan_ctx),
    enter_scope: () => {
      scan_ctx_stack.push(scan_ctx);
      scan_ctx = create_child_core_ctx(scan_ctx);
    },
    exit_scope: () => {
      const previous = scan_ctx_stack.pop();
      expect(previous, "Unsupported-codegen scan scope underflow");
      scan_ctx = previous;
    },
    observe_stmt: (stmt) => {
      // Only annotated binds contribute facts; unannotated binds are
      // skipped so the scan does not re-collect large inlined block
      // values at every nesting level.
      if (stmt.tag !== "bind" || !stmt.annotation) {
        return;
      }

      try {
        backend.local_collect.collect_stmt_locals(stmt, scan_ctx);
      } catch (_error) {
        // A statement whose facts cannot be collected leaves them
        // unknown for later support probes; the statement itself is
        // still validated by the ordinary analysis passes.
      }
    },
  });

  if (unsupported_codegen.length > 0) {
    return core_unsupported_codegen_proof(core, unsupported_codegen);
  }

  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  const expr = final_stmt_expr(final_stmt);
  const final_unsupported = core_unsupported_final_expr_issue(
    backend,
    expr,
    ctx,
  );

  if (
    final_unsupported &&
    !core_unsupported_codegen_issue_exists(
      unsupported_codegen,
      final_unsupported,
    )
  ) {
    unsupported_codegen.unshift(final_unsupported);
  }

  if (unsupported_codegen.length > 0) {
    return core_unsupported_codegen_proof(core, unsupported_codegen);
  }

  try {
    const borrow_ctx = collect_core_borrow_ctx(backend, core);
    const closure_ctx = collect_core_drop_ctx(backend, core);
    const final_result = core_escape_analysis(
      "final_result",
      core_final_expr_ownership(backend, expr, ctx),
    );
    const borrow_plan = core_borrow_plan(core, borrow_ctx, {
      ...graph_core_ownership_hooks(backend),
      closure_body_ctx: graph_core_borrow_closure_body_ctx,
      host_import_for_app: core_host_import_for_app,
      static_core_call_value: backend.static_call.static_core_call_value,
      static_value: graph_core_static_value,
    });
    const cleanup = core_cleanup_plan(
      core,
      ctx,
      graph_core_static_call_proof_hooks(backend),
    );
    const closure_ownership = core_closure_ownership_plan(
      core,
      closure_ctx,
      graph_core_closure_ownership_hooks(backend),
    );
    const allocations = core_allocation_plan(
      core,
      ctx,
      graph_core_allocation_hooks(backend),
    );
    const drops = core_drop_plan(core, drop_ctx, {
      ...graph_core_ownership_hooks(backend),
      block_ctx: create_child_core_ctx,
      closure_body_ctx: (expr, ctx) =>
        graph_core_drop_closure_body_ctx(backend, expr, ctx),
      collect_stmt_locals: (stmt, ctx) =>
        collect_stmt_locals_for_proof(backend, stmt, ctx),
      collection_loop_body_ctx: (stmt, ctx) =>
        graph_core_drop_collection_loop_body_ctx(backend, stmt, ctx),
      if_let_branch_ctx: (case_name, value_name, target, ctx) =>
        graph_core_drop_if_let_branch_ctx(
          backend,
          case_name,
          value_name,
          target,
          ctx,
        ),
      static_core_call_requires_scope:
        backend.static_call.static_core_call_requires_scope,
      static_core_call_target: backend.static_call.static_core_call_target,
      static_value: (expr, ctx) =>
        drop_analysis_static_expr_value(backend, expr, ctx),
    });
    const freeze_edges = core_freeze_proof_edges(
      core,
      ctx,
      graph_core_static_call_proof_hooks(backend),
    );
    const host_boundaries = core_backend_host_boundaries(backend, core);
    const transfer_hooks = {
      ...graph_core_ownership_hooks(backend),
      closure_body_ctx: (
        expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
        ctx: CoreCtx,
      ) => graph_core_drop_closure_body_ctx(backend, expr, ctx),
    };
    const raw_transfers = core_transfer_validation(
      core,
      ctx,
      transfer_hooks,
    );
    const conditional_drops = plan_conditional_transfer_cleanup(
      core,
      raw_transfers,
      drops,
      ctx,
      transfer_hooks,
    );
    const linked_drops = link_drop_allocations(
      conditional_drops,
      allocations,
    );
    const transfers = resolve_conditional_transfer_cleanup(
      raw_transfers,
      linked_drops,
    );

    return core_baseline_proof({
      final_result,
      borrow_plan,
      borrows: core_validate_borrow_plan(borrow_plan),
      freeze_edges,
      cleanup,
      closure_ownership,
      drops: linked_drops,
      allocations,
      host_boundaries,
      capability_method_rows: core.capability_methods || [],
      runtime_slice_rows: core_runtime_slice_facts(core),
      transfers,
      lifetimes: core_lifetime_plan(core),
      unsupported_codegen,
    });
  } catch (error) {
    const unsupported = core_unsupported_codegen_issue_from_analysis_error(
      error,
    );

    if (unsupported) {
      return core_unsupported_codegen_proof(core, [unsupported]);
    }

    throw error;
  }
}

function collect_core_drop_ctx(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreCtx {
  return graph_collect_core_drop_ctx(backend, core);
}

function collect_core_borrow_ctx(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreCtx {
  return graph_collect_core_borrow_ctx(backend, core);
}

function collect_stmt_locals_for_proof(
  backend: CoreBackendGraph,
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  graph_collect_stmt_locals_for_proof(backend, stmt, ctx);
}

function drop_analysis_static_expr_value(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  return graph_drop_analysis_static_expr_value(
    backend,
    expr,
    ctx,
  );
}

function final_stmt_expr(stmt: CoreStmt): CoreExpr {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  throw new Error("Core program has no result expression");
}
