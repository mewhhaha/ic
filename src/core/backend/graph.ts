import { expect } from "../../expect.ts";
import type { DataSegment, Mod } from "../../mod.ts";
import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { Core as CoreNode } from "../ast.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import {
  core_allocation_plan,
  type CoreAllocationPlan,
} from "../allocation.ts";
import {
  core_borrow_plan,
  core_check_borrow_plan,
  core_validate_borrow_plan,
  type CoreBorrowPlan,
  type CoreBorrowValidation,
} from "../borrow.ts";
import { core_cleanup_plan, type CoreCleanupPlan } from "../cleanup.ts";
import { elaborate_core_cleanup_emission } from "../cleanup_emission.ts";
import {
  core_closure_ownership_plan,
  type CoreClosureOwnershipPlan,
} from "../closure_ownership.ts";
import { core_drop_plan, type CoreDropPlan } from "../drop.ts";
import { core_escape_analysis, type CoreEscapeAnalysis } from "../escape.ts";
import {
  core_lifetime_plan,
  type CoreLifetimePlan,
} from "../lifetime_scope.ts";
import type { CoreHostBoundaryPlan } from "../host_boundary.ts";
import { core_host_import_for_app } from "../host_import.ts";
import type { CoreCtx } from "../local_collect.ts";
import type { CoreOwnership } from "../ownership.ts";
import { core_check_baseline_proof, type CoreBaselineProof } from "../proof.ts";
import { create_child_core_ctx } from "./graph/context.ts";
import {
  core_backend_host_boundaries,
  core_backend_proof,
} from "./graph/baseline_proof.ts";
import {
  collect_core_borrow_ctx as graph_collect_core_borrow_ctx,
  collect_core_drop_ctx as graph_collect_core_drop_ctx,
  drop_analysis_static_expr_value as graph_drop_analysis_static_expr_value,
} from "./graph/drop_context.ts";
import {
  core_allocation_hooks as graph_core_allocation_hooks,
  core_borrow_closure_body_ctx as graph_core_borrow_closure_body_ctx,
  core_closure_ownership_hooks as graph_core_closure_ownership_hooks,
  core_drop_closure_body_ctx as graph_core_drop_closure_body_ctx,
  core_drop_collection_loop_body_ctx
    as graph_core_drop_collection_loop_body_ctx,
  core_drop_if_let_branch_ctx as graph_core_drop_if_let_branch_ctx,
  core_final_expr_ownership,
  core_ownership_hooks as graph_core_ownership_hooks,
  core_runtime_aggregate_type_for_ownership
    as graph_core_runtime_aggregate_type_for_ownership,
  core_static_call_proof_hooks as graph_core_static_call_proof_hooks,
  core_static_value as graph_core_static_value,
} from "./graph/proof_hooks.ts";
import { create_core_runtime_union_match_child_ctx } from "./graph/proof_context.ts";
import { static_owner_value_materializes } from "../mutable_static_owner.ts";
import { create_core_backend_graph } from "./graph/instance.ts";
import { named_rec_function_core } from "../named_rec.ts";

const core_backend = create_core_backend_graph();

export function core_type(core: CoreNode): ValType {
  core_check_borrows(core);
  const ctx = collect_core_ctx(core);
  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  return core_backend.expr_type.stmt_result_type(final_stmt, ctx);
}

export function emit_core(core: CoreNode): Wat {
  prepare_cleanup_emission(core);
  return core_backend.artifact.emit_core_artifact(core).body;
}

export function core_mod(core: CoreNode, name = "main"): Mod {
  prepare_cleanup_emission(core);
  return core_backend.artifact.core_mod(core, name);
}

function prepare_cleanup_emission(core: CoreNode): void {
  const proof = core_backend_proof(core_backend, core);
  core_check_baseline_proof(proof);
  let cleanup_emission: ReturnType<typeof elaborate_core_cleanup_emission>;
  try {
    cleanup_emission = elaborate_core_cleanup_emission(
      core,
      proof.drops,
      proof.allocations,
    );
  } catch (error) {
    throw new Error("Core program cleanup elaboration failed", {
      cause: error,
    });
  }
  core.allocation_permit_plan = proof.allocations;

  if (core.recFunctions !== undefined) {
    for (const name in core.recFunctions) {
      const definition = core.recFunctions[name];
      expect(definition, "Missing named recursive function: " + name);
      const function_core = named_rec_function_core(core, definition);
      let function_proof: CoreBaselineProof;
      try {
        function_proof = core_backend_proof(core_backend, function_core);
        core_check_baseline_proof(function_proof);
      } catch (error) {
        throw new Error("Named recursive function proof failed: " + name, {
          cause: error,
        });
      }
      try {
        cleanup_emission.push(...elaborate_core_cleanup_emission(
          function_core,
          function_proof.drops,
          function_proof.allocations,
        ));
      } catch (error) {
        throw new Error(
          "Named recursive function cleanup elaboration failed: " + name,
          { cause: error },
        );
      }
      definition.allocation_permit_plan = function_proof.allocations;
    }
  }

  core.cleanup_emission = cleanup_emission;
}

export function core_data(core: CoreNode): DataSegment[] {
  return core_backend.artifact.core_data_segments(core);
}

export function core_ownership(core: CoreNode): CoreOwnership {
  const ctx = collect_core_ctx(core);
  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  const expr = final_stmt_expr(final_stmt);

  return core_final_expr_ownership(core_backend, expr, ctx);
}

export function core_escape(core: CoreNode): CoreEscapeAnalysis {
  return core_escape_analysis("final_result", core_ownership(core));
}

export function core_cleanup(core: CoreNode): CoreCleanupPlan {
  const ctx = collect_core_ctx(core);
  return core_cleanup_plan(
    core,
    ctx,
    graph_core_static_call_proof_hooks(core_backend),
  );
}

export function core_drops(core: CoreNode): CoreDropPlan {
  const ctx = collect_core_drop_ctx(core);
  return core_drop_plan(core, ctx, {
    bind_core_if_let_payload_fact:
      core_backend.control_flow.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: core_backend.union.bind_dynamic_if_let_payload,
    block_ctx: create_child_core_ctx,
    closure_fn_type: core_backend.closure.closure_fn_type,
    closure_body_ctx: (expr, ctx) =>
      graph_core_drop_closure_body_ctx(core_backend, expr, ctx),
    collect_stmt_locals: core_backend.local_collect.collect_stmt_locals,
    core_assignment_value: core_backend.type_check.core_assignment_value,
    core_binding_value: core_backend.type_check.core_binding_value,
    materialized_static_owner: (value, ctx) =>
      static_owner_value_materializes(value, ctx),
    collection_loop_body_ctx: (stmt, ctx) =>
      graph_core_drop_collection_loop_body_ctx(core_backend, stmt, ctx),
    mutable_binding: (name, ctx) => {
      if (!ctx.mutable_bindings) {
        return false;
      }
      return ctx.mutable_bindings.has(name);
    },
    core_expr_is_text: core_backend.text.core_expr_is_text,
    dynamic_union_if: core_backend.union.dynamic_union_if,
    expr_type: core_backend.expr_type.expr_type,
    if_let_branch_ctx: (case_name, value_name, target, ctx) =>
      graph_core_drop_if_let_branch_ctx(
        core_backend,
        case_name,
        value_name,
        target,
        ctx,
      ),
    runtime_union_match_info: core_backend.union.runtime_union_match_info,
    runtime_union_target: core_backend.union.runtime_union_target,
    runtime_aggregate_type_expr: (value, ctx) =>
      graph_core_runtime_aggregate_type_for_ownership(
        core_backend,
        value,
        ctx,
      ),
    runtime_union_value: core_backend.union.core_runtime_union_value,
    static_runtime_union_match_branch_ctx:
      create_core_runtime_union_match_child_ctx,
    static_struct_value: core_backend.struct.static_struct_value,
    static_union_case: core_backend.union.static_union_case,
    static_core_call_requires_scope:
      core_backend.static_call.static_core_call_requires_scope,
    static_core_call_target: core_backend.static_call.static_core_call_target,
    static_value: drop_analysis_static_expr_value,
    static_text_value: core_backend.text.static_text_value,
  });
}

export function core_borrows(core: CoreNode): CoreBorrowPlan {
  const ctx = collect_core_borrow_ctx(core);
  return core_borrow_plan(core, ctx, {
    ...graph_core_ownership_hooks(core_backend),
    closure_body_ctx: graph_core_borrow_closure_body_ctx,
    host_import_for_app: core_host_import_for_app,
    static_core_call_value: core_backend.static_call.static_core_call_value,
    static_value: graph_core_static_value,
  });
}

export function core_validate_borrows(core: CoreNode): CoreBorrowValidation {
  return core_validate_borrow_plan(core_borrows(core));
}

export function core_check_borrows(core: CoreNode): void {
  core_check_borrow_plan(core_borrows(core));
}

export function core_lifetimes(core: CoreNode): CoreLifetimePlan {
  return core_lifetime_plan(core);
}

export function core_allocations(core: CoreNode): CoreAllocationPlan {
  const ctx = collect_core_drop_ctx(core);
  return core_allocation_plan(
    core,
    ctx,
    graph_core_allocation_hooks(core_backend),
  );
}

export function core_closure_ownership(
  core: CoreNode,
): CoreClosureOwnershipPlan {
  const ctx = collect_core_drop_ctx(core);
  return core_closure_ownership_plan(
    core,
    ctx,
    graph_core_closure_ownership_hooks(core_backend),
  );
}

export function core_host_boundaries(core: CoreNode): CoreHostBoundaryPlan {
  return core_backend_host_boundaries(core_backend, core);
}

export function core_proof(core: CoreNode): CoreBaselineProof {
  return core_backend_proof(core_backend, core);
}

export function core_check_proof(core: CoreNode): void {
  core_check_baseline_proof(core_proof(core));
}

function collect_core_drop_ctx(core: CoreNode): CoreCtx {
  return graph_collect_core_drop_ctx(core_backend, core);
}

function collect_core_ctx(core: CoreNode): CoreCtx {
  return core_backend.local_collect.collect_core_ctx(core);
}

function collect_core_borrow_ctx(core: CoreNode): CoreCtx {
  return graph_collect_core_borrow_ctx(core_backend, core);
}

function drop_analysis_static_expr_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  return graph_drop_analysis_static_expr_value(
    core_backend,
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
