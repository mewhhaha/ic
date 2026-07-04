import { expect } from "../../expect.ts";
import type { DataSegment, Mod } from "../../mod.ts";
import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { Core as CoreNode } from "../ast.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import {
  core_allocation_plan,
  type CoreAllocationPlan,
} from "../allocation.ts";
import {
  core_borrow_plan,
  core_check_borrow_plan,
  core_validate_borrow_plan,
  type CoreBorrowClosureCtx,
  type CoreBorrowPlan,
  type CoreBorrowValidation,
} from "../borrow.ts";
import { core_cleanup_plan, type CoreCleanupPlan } from "../cleanup.ts";
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
import {
  core_host_boundary_plan,
  type CoreHostBoundaryClosureCtx,
  type CoreHostBoundaryPlan,
} from "../host_boundary.ts";
import type { CoreCtx } from "../local_collect.ts";
import { core_host_import_result_ownership } from "../host_import.ts";
import {
  core_expr_ownership,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "../ownership.ts";
import {
  core_baseline_proof,
  core_check_baseline_proof,
  core_freeze_proof_edges,
  core_unsupported_codegen_issues,
  type CoreBaselineProof,
  type CoreUnsupportedCodegenIssue,
} from "../proof.ts";
import { core_transfer_validation } from "../transfer.ts";
import {
  core_val_type_from_type_name,
  static_type_level_value,
  static_type_value,
} from "../type_static.ts";
import { find_core_field, set_local } from "./util.ts";
import {
  create_child_core_ctx,
  create_empty_core_ctx,
} from "./graph/context.ts";
import {
  core_probe_index_assign_error,
  core_unknown_host_boundary_probe_error,
  core_unsupported_codegen_issue_exists,
  core_unsupported_codegen_issue_from_analysis_error,
  core_unsupported_codegen_proof,
} from "./graph/proof_unsupported.ts";
import {
  runtime_aggregate_field_info,
  runtime_aggregate_type_expr,
} from "../runtime_aggregate.ts";
import { runtime_union_match_info } from "../runtime_union.ts";
import { bind_runtime_union_match_payload_temps } from "../runtime_union_match.ts";
import type { RuntimeUnionMatchInfo } from "../runtime_union.ts";
import { static_core_call_branch_value } from "../static_call.ts";
import { create_core_backend_graph } from "./graph/instance.ts";

const core_backend = create_core_backend_graph();

export function core_type(core: CoreNode): ValType {
  core_check_borrows(core);
  const ctx = collect_core_ctx(core);
  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  return core_backend.expr_type.stmt_result_type(final_stmt, ctx);
}

export function emit_core(core: CoreNode): Wat {
  core_check_proof(core);
  return core_backend.artifact.emit_core_artifact(core).body;
}

export function core_mod(core: CoreNode, name = "main"): Mod {
  core_check_proof(core);
  return core_backend.artifact.core_mod(core, name);
}

export function core_data(core: CoreNode): DataSegment[] {
  return core_backend.artifact.core_data_segments(core);
}

export function core_ownership(core: CoreNode): CoreOwnership {
  const ctx = collect_core_ctx(core);
  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  const expr = final_stmt_expr(final_stmt);

  return core_expr_ownership(expr, ctx, core_static_call_proof_hooks());
}

export function core_escape(core: CoreNode): CoreEscapeAnalysis {
  return core_escape_analysis("final_result", core_ownership(core));
}

export function core_cleanup(core: CoreNode): CoreCleanupPlan {
  const ctx = collect_core_ctx(core);
  return core_cleanup_plan(core, ctx, core_static_call_proof_hooks());
}

function core_frozen_local(name: string, ctx: CoreCtx): boolean {
  if (!ctx.frozen_locals) {
    return false;
  }

  return ctx.frozen_locals.has(name);
}

export function core_drops(core: CoreNode): CoreDropPlan {
  const ctx = collect_core_drop_ctx(core);
  return core_drop_plan(core, ctx, {
    bind_core_if_let_payload_fact:
      core_backend.control_flow.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: core_backend.union.bind_dynamic_if_let_payload,
    block_ctx: create_child_core_ctx,
    closure_fn_type: core_backend.closure.closure_fn_type,
    closure_body_ctx: core_drop_closure_body_ctx,
    collect_stmt_locals: core_backend.local_collect.collect_stmt_locals,
    collection_loop_body_ctx: core_drop_collection_loop_body_ctx,
    core_expr_is_text: core_backend.text.core_expr_is_text,
    dynamic_union_if: core_backend.union.dynamic_union_if,
    expr_type: core_backend.expr_type.expr_type,
    if_let_branch_ctx: core_drop_if_let_branch_ctx,
    runtime_union_match_info: core_backend.union.runtime_union_match_info,
    runtime_union_target: core_backend.union.runtime_union_target,
    runtime_aggregate_type_expr: core_runtime_aggregate_type_for_ownership,
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
    closure_body_ctx: core_borrow_closure_body_ctx,
    closure_fn_type: core_backend.closure.closure_fn_type,
    core_expr_is_text: core_backend.text.core_expr_is_text,
    expr_type: core_backend.expr_type.expr_type,
    runtime_aggregate_type_expr: core_runtime_aggregate_type_for_ownership,
    runtime_union_value: core_backend.union.core_runtime_union_value,
    static_core_call_value: core_backend.static_call.static_core_call_value,
    static_struct_value: core_backend.struct.static_struct_value,
    static_text_value: core_backend.text.static_text_value,
    static_value: core_static_value,
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
  return core_allocation_plan(core, ctx, core_allocation_hooks());
}

export function core_closure_ownership(
  core: CoreNode,
): CoreClosureOwnershipPlan {
  const ctx = collect_core_drop_ctx(core);
  return core_closure_ownership_plan(
    core,
    ctx,
    core_closure_ownership_hooks(),
  );
}

export function core_host_boundaries(core: CoreNode): CoreHostBoundaryPlan {
  const ctx = collect_core_borrow_ctx(core);
  return core_host_boundary_plan(core, ctx, {
    ...core_ownership_hooks(),
    closure_body_ctx: core_host_boundary_closure_body_ctx,
    static_core_call_target: core_backend.static_call.static_core_call_target,
    static_core_call_value: core_backend.static_call.static_core_call_value,
    static_core_rec_target: core_backend.static_call.static_core_rec_target,
  });
}

function core_ownership_hooks(): CoreOwnershipHooks<CoreCtx> {
  return {
    bind_core_if_let_payload_fact:
      core_backend.control_flow.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: core_backend.union.bind_dynamic_if_let_payload,
    block_ctx: create_child_core_ctx,
    closure_fn_type: core_backend.closure.closure_fn_type,
    collect_stmt_locals: core_backend.local_collect.collect_stmt_locals,
    core_expr_is_text: core_backend.text.core_expr_is_text,
    dynamic_union_if: core_backend.union.dynamic_union_if,
    expr_type: core_backend.expr_type.expr_type,
    frozen_local: core_frozen_local,
    host_import_result_ownership: core_host_import_result_ownership,
    if_let_branch_ctx: create_child_core_ctx,
    runtime_union_match_info: core_backend.union.runtime_union_match_info,
    runtime_union_target: core_backend.union.runtime_union_target,
    runtime_aggregate_type_expr: core_runtime_aggregate_type_for_ownership,
    runtime_union_value: core_backend.union.core_runtime_union_value,
    static_runtime_union_match_branch_ctx:
      create_core_runtime_union_match_child_ctx,
    static_struct_value: core_backend.struct.static_struct_value,
    static_text_value: core_backend.text.static_text_value,
    static_union_case: core_backend.union.static_union_case,
  };
}

function core_static_call_proof_hooks() {
  return {
    ...core_ownership_hooks(),
    closure_body_ctx: core_cleanup_closure_body_ctx,
    scoped_static_core_call_value:
      core_backend.static_call.scoped_static_core_call_value,
    static_core_call_requires_scope:
      core_backend.static_call.static_core_call_requires_scope,
    static_core_call_target: core_backend.static_call.static_core_call_target,
  };
}

function core_cleanup_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreCtx | undefined {
  for (const param of expr.params) {
    if (param.is_const) {
      return undefined;
    }
  }

  return core_drop_closure_body_ctx(expr, ctx);
}

function core_allocation_hooks() {
  return {
    ...core_ownership_hooks(),
    closure_body_ctx: core_drop_closure_body_ctx,
    closure_fn_type: core_allocation_closure_fn_type,
    is_runtime_text_concat: (
      expr: Extract<CoreExpr, { tag: "prim" }>,
      ctx: CoreCtx,
    ) => {
      if (core_backend.text.core_runtime_text_concat_operands(expr, ctx)) {
        return true;
      }

      return false;
    },
    is_static_value_expr: core_backend.static_value.is_static_value_expr,
    scoped_static_core_call_value:
      core_backend.static_call.scoped_static_core_call_value,
    static_core_call_requires_scope:
      core_backend.static_call.static_core_call_requires_scope,
    static_core_call_target: core_backend.static_call.static_core_call_target,
    static_core_call_value: core_backend.static_call.static_core_call_value,
  };
}

function core_closure_ownership_hooks() {
  return {
    ...core_ownership_hooks(),
    block_ctx: create_child_core_ctx,
    collect_stmt_locals: collect_stmt_locals_for_proof,
    core_lam_capture_info: core_backend.closure.core_lam_capture_info,
  };
}

function core_allocation_closure_fn_type(
  expr: CoreExpr,
  ctx: CoreCtx,
) {
  try {
    return core_backend.closure.closure_fn_type(expr, ctx);
  } catch (error) {
    if (core_runtime_aggregate_ownership_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function drop_analysis_closure_fn_type(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreFnType | undefined {
  if (expr.tag === "var") {
    const local_type = ctx.fn_types.get(expr.name);

    if (local_type) {
      return local_type;
    }

    const static_value = ctx.statics.get(expr.name);

    if (!static_value) {
      return undefined;
    }

    return drop_analysis_closure_fn_type(static_value, ctx);
  }

  if (expr.tag === "block") {
    const block_ctx = create_child_core_ctx(ctx);

    for (let index = 0; index < expr.statements.length; index += 1) {
      const stmt = expr.statements[index];
      expect(
        stmt,
        "Missing core drop-analysis closure block statement " + index,
      );
      const is_final = index + 1 >= expr.statements.length;

      if (!is_final) {
        collect_drop_analysis_stmt_locals(stmt, block_ctx);
        continue;
      }

      if (stmt.tag === "expr") {
        return drop_analysis_closure_fn_type(stmt.expr, block_ctx);
      }

      if (stmt.tag === "return") {
        return drop_analysis_closure_fn_type(stmt.value, block_ctx);
      }

      collect_drop_analysis_stmt_locals(stmt, block_ctx);
      return undefined;
    }

    return undefined;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return drop_analysis_closure_fn_type(expr.value, ctx);
  }

  return core_allocation_closure_fn_type(expr, ctx);
}

function bind_drop_analysis_closure(
  name: string,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  static_value: CoreExpr | undefined,
  frozen: boolean,
): void {
  if (static_value) {
    ctx.statics.set(name, static_value);
  } else {
    ctx.statics.delete(name);
  }

  set_local(ctx.locals, name, "i32");
  ctx.fn_types.set(name, fn_type);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
  if (ctx.frozen_locals) {
    if (frozen) {
      ctx.frozen_locals.add(name);
    } else {
      ctx.frozen_locals.delete(name);
    }
  }
}

function drop_analysis_expr_returns_closure_value(expr: CoreExpr): boolean {
  if (expr.tag === "lam") {
    return true;
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];
    expect(final_stmt, "Core drop-analysis closure-return block has no result");

    if (final_stmt.tag === "expr") {
      return drop_analysis_expr_returns_closure_value(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return drop_analysis_expr_returns_closure_value(final_stmt.value);
    }

    return false;
  }

  if (expr.tag === "if") {
    return drop_analysis_expr_returns_closure_value(expr.then_branch) &&
      drop_analysis_expr_returns_closure_value(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return drop_analysis_expr_returns_closure_value(expr.then_branch) &&
      drop_analysis_expr_returns_closure_value(expr.else_branch);
  }

  return false;
}

function core_runtime_aggregate_type_for_ownership(
  value: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return runtime_aggregate_type_expr(value, ctx, {
      check_closure_call_args: core_backend.closure.check_closure_call_args,
      closure_fn_type: core_backend.closure.closure_fn_type,
    });
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
    error.message === "Core runtime aggregate requires a static struct type"
  ) {
    return true;
  }

  return false;
}

export function core_proof(core: CoreNode): CoreBaselineProof {
  let ctx: CoreCtx;

  try {
    ctx = collect_core_drop_ctx(core);
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
  const unsupported_codegen = core_unsupported_codegen_issues(core, {
    collection_loop_supported: (stmt) =>
      core_collection_loop_supported(stmt, ctx),
    index_assign_supported: (stmt) => core_index_assign_supported(stmt, ctx),
    type_value_expr: (expr) => core_type_value_expr(expr, ctx),
    if_let_expr_supported: (expr) =>
      core_if_let_target_supported(expr.target, ctx),
    if_let_stmt_supported: (stmt) =>
      core_if_let_target_supported(stmt.target, ctx),
    index_expr_supported: (expr) => core_index_expr_supported(expr, ctx),
  });

  if (unsupported_codegen.length > 0) {
    return core_unsupported_codegen_proof(core, unsupported_codegen);
  }

  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  const expr = final_stmt_expr(final_stmt);
  const final_unsupported = core_unsupported_final_expr_issue(expr, ctx);

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
    const borrow_ctx = collect_core_borrow_ctx(core);
    const closure_ctx = collect_core_drop_ctx(core);
    const final_result = core_escape_analysis(
      "final_result",
      core_expr_ownership(expr, ctx, core_static_call_proof_hooks()),
    );
    const borrow_plan = core_borrow_plan(core, borrow_ctx, {
      ...core_ownership_hooks(),
      closure_body_ctx: core_borrow_closure_body_ctx,
      static_core_call_value: core_backend.static_call.static_core_call_value,
      static_value: core_static_value,
    });
    const cleanup = core_cleanup_plan(
      core,
      ctx,
      core_static_call_proof_hooks(),
    );
    const closure_ownership = core_closure_ownership_plan(
      core,
      closure_ctx,
      core_closure_ownership_hooks(),
    );
    const allocations = core_allocation_plan(
      core,
      ctx,
      core_allocation_hooks(),
    );
    const drops = core_drop_plan(core, drop_ctx, {
      ...core_ownership_hooks(),
      block_ctx: create_child_core_ctx,
      closure_body_ctx: core_drop_closure_body_ctx,
      collect_stmt_locals: collect_stmt_locals_for_proof,
      collection_loop_body_ctx: core_drop_collection_loop_body_ctx,
      if_let_branch_ctx: core_drop_if_let_branch_ctx,
      static_core_call_requires_scope:
        core_backend.static_call.static_core_call_requires_scope,
      static_core_call_target: core_backend.static_call.static_core_call_target,
      static_value: drop_analysis_static_expr_value,
    });
    const freeze_edges = core_freeze_proof_edges(
      core,
      ctx,
      core_static_call_proof_hooks(),
    );
    const host_boundaries = core_host_boundaries(core);
    const transfers = core_transfer_validation(
      core,
      ctx,
      {
        ...core_ownership_hooks(),
        closure_body_ctx: core_drop_closure_body_ctx,
      },
    );

    return core_baseline_proof({
      final_result,
      borrows: core_validate_borrow_plan(borrow_plan),
      freeze_edges,
      cleanup,
      closure_ownership,
      drops,
      allocations,
      host_boundaries,
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

export function core_check_proof(core: CoreNode): void {
  core_check_baseline_proof(core_proof(core));
}

function collect_core_drop_ctx(core: CoreNode): CoreCtx {
  const ctx = create_empty_core_ctx(core);

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];
    expect(stmt, "Missing core statement " + index.toString());

    if (
      index + 1 >= core.statements.length &&
      !drop_analysis_stmt_contains_freeze_consumption(stmt)
    ) {
      collect_final_analysis_stmt_locals(stmt, ctx);
      continue;
    }

    collect_drop_analysis_stmt_locals(stmt, ctx);
  }

  return ctx;
}

function collect_core_ctx(core: CoreNode): CoreCtx {
  return core_backend.local_collect.collect_core_ctx(core);
}

function collect_core_borrow_ctx(core: CoreNode): CoreCtx {
  const ctx = create_empty_core_ctx(core);

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];
    expect(stmt, "Missing core statement " + index.toString());

    if (
      index + 1 >= core.statements.length &&
      !drop_analysis_stmt_contains_freeze_consumption(stmt)
    ) {
      collect_final_analysis_stmt_locals(stmt, ctx);
      continue;
    }

    if (drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_drop_analysis_stmt_locals(stmt, ctx);
      continue;
    }

    collect_stmt_locals_for_proof(stmt, ctx);
  }

  return ctx;
}

function collect_final_analysis_stmt_locals(
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  if (stmt.tag === "expr") {
    collect_expr_locals_for_proof(stmt.expr, ctx);
    return;
  }

  if (stmt.tag === "return") {
    collect_expr_locals_for_proof(stmt.value, ctx);
    return;
  }

  collect_stmt_locals_for_proof(stmt, ctx);
}

function collect_drop_analysis_stmt_locals(
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  if (stmt.tag === "bind") {
    const value = core_backend.type_check.core_binding_value(stmt, ctx);
    const static_value = stmt.kind === "const"
      ? drop_analysis_static_expr_value(value, ctx)
      : drop_analysis_runtime_binding_static_expr_value(value, ctx);

    if (static_value) {
      if (
        stmt.kind === "let" && static_value.tag === "lam" &&
        !drop_analysis_expr_returns_closure_value(static_value.body)
      ) {
        const fn_type = drop_analysis_closure_fn_type(static_value, ctx);

        if (fn_type) {
          bind_drop_analysis_closure(
            stmt.name,
            fn_type,
            ctx,
            static_value,
            false,
          );
          return;
        }
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.set(stmt.name, static_value);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    if (is_drop_analysis_freeze_consumption(stmt.value)) {
      const fn_type = drop_analysis_closure_fn_type(stmt.value, ctx);

      if (fn_type) {
        bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, true);
        return;
      }

      if (
        core_backend.text.core_expr_has_runtime_text_fact(stmt.value, ctx) ||
        core_runtime_aggregate_type_for_ownership(stmt.value, ctx) ||
        core_backend.union.runtime_union_type_expr(stmt.value, ctx)
      ) {
        collect_stmt_locals_for_proof(stmt, ctx);
        return;
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.delete(stmt.name);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    const fn_type = drop_analysis_closure_fn_type(stmt.value, ctx);

    if (fn_type) {
      bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, false);
      return;
    }
  }

  if (stmt.tag === "assign") {
    const static_value = drop_analysis_runtime_binding_static_expr_value(
      stmt.value,
      ctx,
    );

    if (static_value) {
      if (
        static_value.tag === "lam" &&
        !drop_analysis_expr_returns_closure_value(static_value.body)
      ) {
        const fn_type = drop_analysis_closure_fn_type(static_value, ctx);

        if (fn_type) {
          bind_drop_analysis_closure(
            stmt.name,
            fn_type,
            ctx,
            static_value,
            false,
          );
          return;
        }
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.set(stmt.name, static_value);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    if (is_drop_analysis_freeze_consumption(stmt.value)) {
      const fn_type = drop_analysis_closure_fn_type(stmt.value, ctx);

      if (fn_type) {
        bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, true);
        return;
      }

      if (
        core_backend.text.core_expr_has_runtime_text_fact(stmt.value, ctx) ||
        core_runtime_aggregate_type_for_ownership(stmt.value, ctx) ||
        core_backend.union.runtime_union_type_expr(stmt.value, ctx)
      ) {
        collect_stmt_locals_for_proof(stmt, ctx);
        return;
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.delete(stmt.name);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    const fn_type = drop_analysis_closure_fn_type(stmt.value, ctx);

    if (fn_type) {
      bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, false);
      return;
    }
  }

  if (stmt.tag === "expr") {
    if (is_drop_analysis_freeze_consumption(stmt.expr)) {
      return;
    }

    collect_expr_locals_for_proof(stmt.expr, ctx);
    return;
  }

  if (stmt.tag === "return") {
    if (is_drop_analysis_freeze_consumption(stmt.value)) {
      return;
    }

    collect_expr_locals_for_proof(stmt.value, ctx);
    return;
  }

  if (stmt.tag === "if_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(stmt.cond, ctx);

    for (const body_stmt of stmt.body) {
      collect_drop_analysis_stmt_locals(body_stmt, ctx);
    }

    return;
  }

  if (stmt.tag === "if_else_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(stmt.cond, ctx);

    for (const body_stmt of stmt.then_body) {
      collect_drop_analysis_stmt_locals(body_stmt, ctx);
    }

    for (const body_stmt of stmt.else_body) {
      collect_drop_analysis_stmt_locals(body_stmt, ctx);
    }

    return;
  }

  if (stmt.tag === "if_let_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(stmt.target, ctx);

    const branch = core_drop_if_let_branch_ctx(
      stmt.case_name,
      stmt.value_name,
      stmt.target,
      ctx,
    );

    if (branch.tag === "skip") {
      return;
    }

    if (branch.tag === "scan") {
      for (const body_stmt of stmt.body) {
        collect_drop_analysis_stmt_locals(body_stmt, branch.ctx);
      }

      ctx.next_loop = branch.ctx.next_loop;
      ctx.next_temp = branch.ctx.next_temp;
      return;
    }

    for (const body_stmt of stmt.body) {
      collect_drop_analysis_stmt_locals(body_stmt, ctx);
    }

    return;
  }

  collect_stmt_locals_for_proof(stmt, ctx);
}

function collect_stmt_locals_for_proof(
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  try {
    core_backend.local_collect.collect_stmt_locals(stmt, ctx);
  } catch (error) {
    if (core_unknown_host_boundary_probe_error(error)) {
      return;
    }

    if (core_unsafe_scratch_return_probe_error(error)) {
      if (bind_unsafe_scratch_return_for_proof(stmt, ctx)) {
        return;
      }
    }

    throw error;
  }
}

function core_unsafe_scratch_return_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith(
    "Cannot type core scratch block with unsafe scratch return ",
  );
}

function bind_unsafe_scratch_return_for_proof(
  stmt: CoreStmt,
  ctx: CoreCtx,
): boolean {
  if (stmt.tag !== "bind") {
    return false;
  }

  const annotation = stmt.annotation;

  if (!annotation) {
    return false;
  }

  ctx.statics.delete(stmt.name);
  core_backend.local_facts.clear_core_local_facts(stmt.name, ctx);

  const scalar_type = core_val_type_from_type_name(annotation);

  if (scalar_type) {
    set_local(ctx.locals, stmt.name, scalar_type);

    if (annotation === "Text") {
      ctx.text_locals.add(stmt.name);
    }

    return true;
  }

  const annotation_expr: CoreExpr = { tag: "var", name: annotation };
  const type_value = static_type_value(annotation_expr, ctx);

  if (!type_value) {
    return false;
  }

  if (type_value.tag === "struct_type") {
    set_local(ctx.locals, stmt.name, "i32");
    ctx.struct_locals.set(stmt.name, annotation_expr);
    return true;
  }

  if (type_value.tag === "union_type") {
    set_local(ctx.locals, stmt.name, "i32");
    ctx.union_locals.set(stmt.name, annotation_expr);
    return true;
  }

  return false;
}

function collect_expr_locals_for_proof(
  expr: CoreExpr,
  ctx: CoreCtx,
): void {
  try {
    core_backend.local_collect.collect_expr_locals(expr, ctx);
  } catch (error) {
    if (core_unknown_host_boundary_probe_error(error)) {
      return;
    }

    throw error;
  }
}

function core_collection_loop_supported(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
): boolean {
  const fields = core_backend.struct.static_collection_fields(
    stmt.collection,
    ctx,
  );

  if (fields) {
    return true;
  }

  const text = core_backend.text.static_text_value(stmt.collection, ctx);

  if (text) {
    return true;
  }

  return core_backend.text.core_expr_is_text(stmt.collection, ctx);
}

function core_index_assign_supported(
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ctx: CoreCtx,
): boolean {
  const static_target = core_backend.struct.static_struct_binding(
    stmt.name,
    ctx,
  );

  if (static_target) {
    return true;
  }

  if (ctx.text_locals.has(stmt.name)) {
    return true;
  }

  return ctx.struct_locals.has(stmt.name);
}

function core_unsupported_final_expr_issue(
  expr: CoreExpr,
  ctx: CoreCtx,
) {
  if (core_type_value_expr(expr, ctx)) {
    return {
      tag: "unsupported_codegen" as const,
      node: "expr" as const,
      feature: "type_value",
      message: "Cannot emit core type value expression yet",
    };
  }

  if (expr.tag === "app") {
    const app_issue = core_app_expr_unsupported_codegen_issue(expr, ctx);

    if (app_issue) {
      return app_issue;
    }
  }

  if (expr.tag === "field" && !core_field_expr_supported(expr, ctx)) {
    return {
      tag: "unsupported_codegen" as const,
      node: "expr" as const,
      feature: "field",
      message: "Cannot emit core field expression yet",
    };
  }

  return undefined;
}

function core_type_value_expr(
  expr: CoreExpr,
  ctx: CoreCtx,
): boolean {
  if (
    expr.tag === "type_name" ||
    expr.tag === "struct_type" ||
    expr.tag === "union_type"
  ) {
    return true;
  }

  if (expr.tag !== "var") {
    const type_value = maybe_core_static_type_level_value(expr, ctx);

    if (!type_value) {
      return false;
    }

    return core_static_value_is_type_value(type_value);
  }

  const type_value = maybe_core_static_type_level_value(expr, ctx);

  if (!type_value) {
    return false;
  }

  return core_static_value_is_type_value(type_value);
}

function core_static_value_is_type_value(expr: CoreExpr): boolean {
  return expr.tag === "type_name" ||
    expr.tag === "struct_type" ||
    expr.tag === "union_type";
}

function maybe_core_static_type_level_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return static_type_level_value(expr, ctx);
  } catch (error) {
    if (core_static_type_value_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function core_static_type_value_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Core type constructor ")) {
    return true;
  }

  if (error.message.startsWith("Missing core type constructor ")) {
    return true;
  }

  return false;
}

function core_app_expr_unsupported_codegen_issue(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: CoreCtx,
): CoreUnsupportedCodegenIssue | undefined {
  const runtime_union_value = core_backend.union.core_runtime_union_value(
    expr,
    ctx,
  );

  if (runtime_union_value) {
    return undefined;
  }

  try {
    core_backend.app.app_type(expr, ctx);
    return undefined;
  } catch (error) {
    if (core_app_type_probe_error(error)) {
      return undefined;
    }

    const builtin_issue = core_unsupported_codegen_issue_from_analysis_error(
      error,
    );

    if (builtin_issue) {
      return builtin_issue;
    }

    if (core_generic_app_unsupported_type_error(error)) {
      return {
        tag: "unsupported_codegen",
        node: "expr",
        feature: "app",
        message: "Cannot emit core app expression yet",
      };
    }

    throw error;
  }
}

function core_app_type_probe_error(error: unknown): boolean {
  return core_probe_index_assign_error(error);
}

function core_generic_app_unsupported_type_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Cannot type core app expression yet";
}

function core_field_expr_supported(
  expr: Extract<CoreExpr, { tag: "field" }>,
  ctx: CoreCtx,
): boolean {
  const struct_value = core_backend.struct.static_struct_value(
    expr.object,
    ctx,
  );

  if (struct_value) {
    return find_core_field(struct_value.fields, expr.name) !== undefined;
  }

  const field_info = runtime_aggregate_field_info(expr.object, expr.name, ctx, {
    check_closure_call_args: core_backend.closure.check_closure_call_args,
    closure_fn_type: core_backend.closure.closure_fn_type,
  });

  return field_info !== undefined;
}

function core_index_expr_supported(
  expr: Extract<CoreExpr, { tag: "index" }>,
  ctx: CoreCtx,
): boolean {
  const fields = core_backend.struct.static_collection_fields(
    expr.object,
    ctx,
  );

  if (fields) {
    return true;
  }

  const text_byte = core_backend.text.static_text_byte_index_expr(expr, ctx);

  if (text_byte) {
    return true;
  }

  return core_backend.text.core_expr_is_text(expr.object, ctx);
}

function core_if_let_target_supported(
  target: CoreExpr,
  ctx: CoreCtx,
): boolean {
  const static_case = core_backend.union.static_union_case(target, ctx);

  if (static_case) {
    return true;
  }

  const dynamic_case = core_backend.union.dynamic_union_if(target, ctx);

  if (dynamic_case) {
    return true;
  }

  const runtime_target = core_backend.union.runtime_union_target(target, ctx);

  if (runtime_target) {
    return true;
  }

  return false;
}

function drop_analysis_static_expr_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  const type_value = drop_analysis_static_type_level_value(expr, ctx);

  if (type_value) {
    return type_value;
  }

  const text_value = core_backend.text.static_text_value(expr, ctx);

  if (text_value) {
    return text_value;
  }

  if (expr.tag === "freeze") {
    const struct_value = core_backend.struct.static_struct_value(
      expr.value,
      ctx,
    );

    if (struct_value) {
      return core_backend.static_value.plan_static_value_expr(
        {
          tag: "freeze",
          value: struct_value,
        },
        ctx,
        undefined,
      ).value;
    }
  }

  if (expr.tag === "var") {
    return ctx.statics.get(expr.name);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return expr;
  }

  if (expr.tag === "struct_update") {
    const updated = core_backend.struct.static_struct_update_value(expr, ctx);

    if (updated) {
      return updated;
    }
  }

  if (
    expr.tag === "struct_value" ||
    expr.tag === "union_case" ||
    expr.tag === "with"
  ) {
    return expr;
  }

  if (expr.tag === "if") {
    const branch_function = static_core_call_branch_value(expr, ctx, {
      static_core_call_target: core_backend.static_call.static_core_call_target,
    });

    if (branch_function) {
      return branch_function;
    }

    const then_value = drop_analysis_static_expr_value(expr.then_branch, ctx);
    const else_value = drop_analysis_static_expr_value(expr.else_branch, ctx);

    if (
      then_value && else_value &&
      drop_analysis_static_ownerless_value(then_value) &&
      drop_analysis_static_ownerless_value(else_value)
    ) {
      return expr;
    }
  }

  if (expr.tag !== "block") {
    return undefined;
  }

  const block_ctx = create_child_core_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing core drop-analysis block statement " + index);
    const is_final = index + 1 >= expr.statements.length;

    if (!is_final) {
      collect_drop_analysis_stmt_locals(stmt, block_ctx);
      continue;
    }

    if (stmt.tag === "expr") {
      return drop_analysis_static_expr_value(stmt.expr, block_ctx);
    }

    if (stmt.tag === "return") {
      return drop_analysis_static_expr_value(stmt.value, block_ctx);
    }

    collect_drop_analysis_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

function drop_analysis_runtime_binding_static_expr_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  const value = drop_analysis_static_expr_value(expr, ctx);

  if (!value) {
    return undefined;
  }

  if (value.tag === "with") {
    return undefined;
  }

  return value;
}

function drop_analysis_static_type_level_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return static_type_level_value(expr, ctx);
  } catch (error) {
    if (drop_analysis_ordinary_static_call_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function drop_analysis_ordinary_static_call_probe_error(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Core type constructor expects ")) {
    return true;
  }

  if (error.message.startsWith("Core type constructor argument ")) {
    if (error.message.endsWith(" must resolve to a type name")) {
      return true;
    }
  }

  return false;
}

function drop_analysis_static_ownerless_value(expr: CoreExpr): boolean {
  if (expr.tag === "type_name") {
    return true;
  }

  if (expr.tag === "struct_type") {
    return true;
  }

  if (expr.tag === "union_type") {
    return true;
  }

  if (expr.tag === "text") {
    return true;
  }

  if (expr.tag === "struct_value") {
    return true;
  }

  if (expr.tag === "struct_update") {
    return true;
  }

  if (expr.tag === "union_case") {
    return true;
  }

  if (expr.tag === "with") {
    return true;
  }

  if (expr.tag === "if") {
    return true;
  }

  return false;
}

function is_drop_analysis_freeze_consumption(expr: CoreExpr): boolean {
  if (expr.tag === "freeze") {
    return true;
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];
    expect(final_stmt, "Core drop-analysis block has no result statement");

    if (final_stmt.tag === "expr") {
      return is_drop_analysis_freeze_consumption(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return is_drop_analysis_freeze_consumption(final_stmt.value);
    }

    return false;
  }

  if (expr.tag === "if") {
    return is_drop_analysis_freeze_consumption(expr.then_branch) &&
      is_drop_analysis_freeze_consumption(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return is_drop_analysis_freeze_consumption(expr.then_branch) &&
      is_drop_analysis_freeze_consumption(expr.else_branch);
  }

  return false;
}

function drop_analysis_stmt_contains_freeze_consumption(
  stmt: CoreStmt,
): boolean {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      return is_drop_analysis_freeze_consumption(stmt.value);

    case "expr":
      return is_drop_analysis_freeze_consumption(stmt.expr);

    case "return":
      return is_drop_analysis_freeze_consumption(stmt.value);

    case "if_stmt":
      for (const body_stmt of stmt.body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }
      return false;

    case "if_else_stmt":
      for (const body_stmt of stmt.then_body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }

      for (const body_stmt of stmt.else_body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }

      return false;

    case "if_let_stmt":
      for (const body_stmt of stmt.body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }
      return false;

    case "range_loop":
      for (const body_stmt of stmt.body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }
      return false;

    case "collection_loop":
      for (const body_stmt of stmt.body) {
        if (drop_analysis_stmt_contains_freeze_consumption(body_stmt)) {
          return true;
        }
      }
      return false;

    case "index_assign":
      return is_drop_analysis_freeze_consumption(stmt.index) ||
        is_drop_analysis_freeze_consumption(stmt.value);

    case "type_check":
      return is_drop_analysis_freeze_consumption(stmt.target);

    case "break":
    case "continue":
    case "unsupported":
      return false;
  }
}

function clear_drop_analysis_local_facts(name: string, ctx: CoreCtx): void {
  ctx.fn_types.delete(name);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
  if (ctx.frozen_locals) {
    ctx.frozen_locals.delete(name);
  }
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

function core_borrow_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreBorrowClosureCtx<CoreCtx> {
  const closure_ctx = create_child_core_ctx(ctx);

  for (const param of expr.params) {
    if (param.is_const) {
      continue;
    }

    const annotation = param.annotation;

    if (!annotation) {
      return {
        tag: "skip",
        reason: "Cannot analyze closure-body borrows without parameter " +
          "annotation: " + param.name,
      };
    }

    const type = core_val_type_from_type_name(annotation);

    if (!type) {
      return {
        tag: "skip",
        reason: "Cannot analyze closure-body borrows for non-scalar " +
          "parameter annotation: " + annotation,
      };
    }

    closure_ctx.locals.set(param.name, type);

    if (annotation === "Text") {
      closure_ctx.text_locals.add(param.name);
    } else {
      closure_ctx.text_locals.delete(param.name);
    }

    if (closure_ctx.frozen_locals) {
      closure_ctx.frozen_locals.delete(param.name);
    }
  }

  return {
    tag: "scan",
    ctx: closure_ctx,
  };
}

function core_host_boundary_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreHostBoundaryClosureCtx<CoreCtx> {
  let closure_ctx: CoreCtx | undefined;

  try {
    closure_ctx = core_drop_closure_body_ctx(expr, ctx);
  } catch (error) {
    if (core_probe_index_assign_error(error)) {
      return { tag: "skip" };
    }

    throw error;
  }

  if (!closure_ctx) {
    return { tag: "skip" };
  }

  return {
    tag: "scan",
    ctx: closure_ctx,
  };
}

function core_drop_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreCtx | undefined {
  const closure_ctx = create_child_core_ctx(ctx);
  let has_const_param = false;

  for (const param of expr.params) {
    if (param.is_const) {
      has_const_param = true;
      continue;
    }

    const annotation = param.annotation;

    if (!annotation) {
      return undefined;
    }

    const type = core_val_type_from_type_name(annotation);

    if (!type) {
      const type_value = static_type_value(
        { tag: "var", name: annotation },
        ctx,
      );

      if (type_value && type_value.tag === "struct_type") {
        closure_ctx.locals.set(param.name, "i32");
        closure_ctx.text_locals.delete(param.name);
        closure_ctx.struct_locals.set(param.name, {
          tag: "var",
          name: annotation,
        });
        closure_ctx.union_locals.delete(param.name);

        if (closure_ctx.frozen_locals) {
          closure_ctx.frozen_locals.delete(param.name);
        }

        continue;
      }

      if (type_value && type_value.tag === "union_type") {
        closure_ctx.locals.set(param.name, "i32");
        closure_ctx.text_locals.delete(param.name);
        closure_ctx.struct_locals.delete(param.name);
        closure_ctx.union_locals.set(param.name, {
          tag: "var",
          name: annotation,
        });

        if (closure_ctx.frozen_locals) {
          closure_ctx.frozen_locals.delete(param.name);
        }

        continue;
      }

      return undefined;
    }

    closure_ctx.locals.set(param.name, type);
    closure_ctx.struct_locals.delete(param.name);
    closure_ctx.union_locals.delete(param.name);

    if (annotation === "Text") {
      closure_ctx.text_locals.add(param.name);
    } else {
      closure_ctx.text_locals.delete(param.name);
    }

    if (closure_ctx.frozen_locals) {
      closure_ctx.frozen_locals.delete(param.name);
    }
  }

  if (has_const_param) {
    return closure_ctx;
  }

  core_backend.local_collect.collect_expr_locals(expr.body, closure_ctx);

  return closure_ctx;
}

function core_drop_collection_loop_body_ctx(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
): { tag: "scan"; ctx: CoreCtx } | { tag: "skip" } {
  const fields = core_backend.struct.static_collection_fields(
    stmt.collection,
    ctx,
  );

  if (!fields) {
    const text = core_backend.text.static_text_value(stmt.collection, ctx);

    if (!text && !core_backend.text.core_expr_is_text(stmt.collection, ctx)) {
      return { tag: "skip" };
    }
  }

  const loop_ctx = create_child_core_ctx(ctx);
  core_backend.local_collect.collect_stmt_locals(stmt, loop_ctx);
  return { tag: "scan", ctx: loop_ctx };
}

function create_core_runtime_union_match_child_ctx(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: CoreCtx,
): CoreCtx {
  const branch_ctx = create_child_core_ctx(ctx);
  bind_runtime_union_match_payload_temps(value_name, info, branch_ctx);
  return branch_ctx;
}

function core_drop_if_let_branch_ctx(
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: CoreCtx,
):
  | { tag: "scan"; ctx: CoreCtx }
  | { tag: "skip" }
  | { tag: "unknown" } {
  const union_case = core_backend.union.static_union_case(target, ctx);

  if (union_case) {
    if (union_case.name !== case_name) {
      return { tag: "skip" };
    }

    const branch_ctx = create_child_core_ctx(ctx);
    core_backend.control_flow.bind_core_if_let_payload_fact(
      value_name,
      union_case,
      branch_ctx,
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  const dynamic_target = core_backend.union.dynamic_union_if(target, ctx);

  if (dynamic_target) {
    if (
      dynamic_target.then_case.name !== case_name &&
      dynamic_target.else_case.name !== case_name
    ) {
      return { tag: "skip" };
    }

    const branch_ctx = create_child_core_ctx(ctx);
    core_backend.union.bind_dynamic_if_let_payload(
      case_name,
      value_name,
      dynamic_target,
      branch_ctx,
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  const runtime_target = core_backend.union.runtime_union_target(target, ctx);

  if (runtime_target) {
    const info = runtime_union_match_info(
      case_name,
      runtime_target,
      ctx,
    );
    const branch_ctx = create_core_runtime_union_match_child_ctx(
      value_name,
      info,
      create_child_core_ctx(ctx),
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  return { tag: "unknown" };
}

function core_static_value(name: string, ctx: CoreCtx): CoreExpr | undefined {
  return ctx.statics.get(name);
}
