import type { Core, CoreExpr } from "./ast.ts";
import { core_storage_class } from "./escape.ts";
import type { CoreDropPlan } from "./drop.ts";
import { core_host_import_map } from "./host_import.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
} from "./ownership.ts";
import { scan_transfer_stmts } from "./transfer/scan.ts";
import { top_level_transfer_functions } from "./transfer/static_function.ts";
export type {
  CoreTransferEdge,
  CoreTransferFunction,
  CoreTransferHooks,
  CoreTransferState,
  CoreTransferValidation,
  CoreTransferValidationIssue,
} from "./transfer/types.ts";
import type {
  CoreTransferHooks,
  CoreTransferState,
  CoreTransferValidation,
} from "./transfer/types.ts";

export function core_transfer_validation<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreTransferHooks<ctx>,
): CoreTransferValidation {
  const state: CoreTransferState<ctx> = {
    collect_local_facts: true,
    next_transfer: 0,
    next_temporary: 0,
    transfers: [],
    issues: [],
    transferred: new Map(),
    functions: top_level_transfer_functions(core),
    aliases: new Map(),
    declared_owners: new Set(),
    alias_subjects: new Map(),
    alias_ownership: new Map(),
    alias_rejection_reasons: new Map(),
    active_functions: new Set(),
    ctx,
    hooks,
  };
  const host_imports = core_host_import_map(core);

  scan_transfer_stmts(core.statements, "program#0", host_imports, state);

  return {
    transfers: state.transfers,
    issues: state.issues,
  };
}

export function resolve_conditional_transfer_cleanup(
  validation: CoreTransferValidation,
  drops: CoreDropPlan,
): CoreTransferValidation {
  const cleaned = new Set<string>();

  for (const step of drops.steps) {
    if (step.tag !== "heap_drop") {
      continue;
    }

    if (step.edge !== "conditional_cleanup") {
      if (step.edge !== "loop_zero_iteration_cleanup") {
        continue;
      }
    }

    if (step.owner) {
      cleaned.add(step.owner);
    }
  }

  return {
    transfers: validation.transfers,
    issues: validation.issues.filter((issue) => {
      if (issue.tag !== "conditional_transfer_requires_cleanup") {
        return true;
      }

      if (!issue.transfer.callee.startsWith("union_case.")) {
        return true;
      }

      return !cleaned.has(issue.owner);
    }),
  };
}

export function plan_conditional_transfer_cleanup<ctx>(
  core: Core,
  validation: CoreTransferValidation,
  drops: CoreDropPlan,
  ctx: ctx,
  hooks: CoreTransferHooks<ctx>,
): CoreDropPlan {
  const steps = drops.steps.slice();
  let next_drop = 0;

  for (const step of steps) {
    if (step.tag === "heap_drop") {
      next_drop += 1;
    }
  }

  for (const issue of validation.issues) {
    if (issue.tag !== "conditional_transfer_requires_cleanup") {
      continue;
    }

    if (!issue.transfer.callee.startsWith("union_case.")) {
      continue;
    }

    let cleanup_edge:
      | "conditional_cleanup"
      | "loop_zero_iteration_cleanup" = "conditional_cleanup";
    let retained_scope = retained_branch_scope(issue.transfer.scope);

    if (
      !retained_scope &&
      issue.transfer.scope.endsWith("/loop") &&
      core_has_single_exit_payload_loop(
        core,
        issue.owner,
        issue.transfer.callee,
      )
    ) {
      cleanup_edge = "loop_zero_iteration_cleanup";
      retained_scope = issue.transfer.scope + "_zero_iteration";
    }

    if (!retained_scope) {
      continue;
    }

    const ownership = core_expr_ownership(
      { tag: "var", name: issue.owner },
      ctx,
      hooks,
    );

    if (ownership.tag !== "unique_heap") {
      continue;
    }

    if (
      ownership.reason !== "runtime_aggregate" &&
      ownership.reason !== "runtime_union"
    ) {
      continue;
    }

    for (let step_index = steps.length - 1; step_index >= 0; step_index -= 1) {
      const step = steps[step_index];
      if (!step || step.tag !== "heap_drop") {
        continue;
      }

      if (
        step.edge === "scope_exit" && step.owner === issue.owner &&
        step.ownership.reason === ownership.reason
      ) {
        steps.splice(step_index, 1);
      }
    }

    steps.push({
      tag: "heap_drop",
      id: "drop#" + next_drop.toString(),
      edge: cleanup_edge,
      scope: retained_scope,
      owner: issue.owner,
      ownership,
      storage: core_storage_class(ownership),
      runtime: "reusable_free_list_allocator",
      reason: core_ownership_result_text(ownership) + " " +
        cleanup_edge_text(cleanup_edge) +
        " lowers to __free with reusable allocator",
    });
    next_drop += 1;
  }

  return { steps };
}

function core_has_single_exit_payload_loop(
  core: Core,
  owner: string,
  callee: string,
): boolean {
  const matching: Extract<Core["statements"][number], { tag: "range_loop" }>[] =
    [];

  for (const stmt of core.statements) {
    if (stmt.tag !== "range_loop") {
      continue;
    }

    if (loop_payload_move_count(stmt.body, owner, callee) > 0) {
      matching.push(stmt);
    }
  }

  if (matching.length !== 1) {
    return false;
  }

  const loop = matching[0];
  if (!loop) {
    return false;
  }

  if (loop_payload_move_count(loop.body, owner, callee) !== 1) {
    return false;
  }

  const final_stmt = loop.body[loop.body.length - 1];
  return Boolean(final_stmt && final_stmt.tag === "break");
}

function loop_payload_move_count(
  statements: Core["statements"],
  owner: string,
  callee: string,
): number {
  let count = 0;

  for (const stmt of statements) {
    if (stmt.tag === "expr" && expr_is_payload_move(stmt.expr, owner, callee)) {
      count += 1;
    }

    if (
      stmt.tag === "assign" && expr_is_payload_move(stmt.value, owner, callee)
    ) {
      count += 1;
    }
  }

  return count;
}

function expr_is_payload_move(
  expr: CoreExpr,
  owner: string,
  callee: string,
): boolean {
  if (expr.tag === "union_case") {
    return callee === "union_case." + expr.name &&
      Boolean(
        expr.value && expr.value.tag === "var" && expr.value.name === owner,
      );
  }

  if (expr.tag !== "app" || expr.func.tag !== "field") {
    return false;
  }

  const payload = expr.args[0];
  return callee === "union_case." + expr.func.name &&
    Boolean(payload && payload.tag === "var" && payload.name === owner);
}

function cleanup_edge_text(
  edge: "conditional_cleanup" | "loop_zero_iteration_cleanup",
): string {
  if (edge === "conditional_cleanup") {
    return "conditional retained-path cleanup";
  }

  return "loop zero-iteration cleanup";
}

function retained_branch_scope(scope: string): string | undefined {
  if (scope.endsWith("/if_then")) {
    return scope.slice(0, -"if_then".length) + "if_else";
  }

  if (scope.endsWith("/if_else")) {
    return scope.slice(0, -"if_else".length) + "if_then";
  }

  if (scope.endsWith("/if_let")) {
    return scope + "_fallthrough";
  }

  if (scope.endsWith("/if")) {
    return scope + "_fallthrough";
  }

  return undefined;
}
