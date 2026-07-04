import type { Core, CoreExpr, CoreField, CoreStmt } from "./ast.ts";
import type { CoreAllocationPlan } from "./allocation.ts";
import type {
  CoreBorrowValidation,
  CoreBorrowValidationIssue,
} from "./borrow.ts";
import type { CoreCleanupPlan, CoreCleanupStep } from "./cleanup.ts";
import type {
  CoreClosureOwnershipEdge,
  CoreClosureOwnershipPlan,
} from "./closure_ownership.ts";
import type { CoreDropPlan } from "./drop.ts";
import { core_escape_analysis, type CoreEscapeAnalysis } from "./escape.ts";
import type {
  CoreHostBoundaryEdge,
  CoreHostBoundaryPlan,
} from "./host_boundary.ts";
import type { CoreLifetimePlan } from "./lifetime_scope.ts";
import {
  core_expr_ownership,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";
import type {
  CoreTransferValidation,
  CoreTransferValidationIssue,
} from "./transfer.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";

export type CoreBaselineTarget = "core-3-nonweb";

export type CoreFreezeProofEdge = {
  id: string;
  analysis: CoreEscapeAnalysis;
};

export type CoreUnsupportedCodegenIssue = {
  tag: "unsupported_codegen";
  node: "stmt" | "expr";
  feature: string;
  message: string;
};

export type CoreUnsupportedCodegenHooks = {
  collection_loop_supported: (
    stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ) => boolean;
  index_assign_supported: (
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ) => boolean;
  type_value_expr: (expr: CoreExpr) => boolean;
  if_let_expr_supported: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
  ) => boolean;
  if_let_stmt_supported: (
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  ) => boolean;
  index_expr_supported: (
    expr: Extract<CoreExpr, { tag: "index" }>,
  ) => boolean;
};

export type CoreProofIssue =
  | {
    tag: "borrow";
    issue: CoreBorrowValidationIssue;
    message: string;
  }
  | {
    tag: "freeze";
    edge: CoreFreezeProofEdge;
    message: string;
  }
  | {
    tag: "scratch_return";
    step: CoreCleanupStep;
    message: string;
  }
  | {
    tag: "final_result";
    analysis: CoreEscapeAnalysis;
    message: string;
  }
  | {
    tag: "host_boundary";
    edge: CoreHostBoundaryEdge;
    message: string;
  }
  | {
    tag: "closure_capture";
    edge: CoreClosureOwnershipEdge;
    message: string;
  }
  | {
    tag: "transfer";
    issue: CoreTransferValidationIssue;
    message: string;
  }
  | {
    tag: "unsupported_codegen";
    issue: CoreUnsupportedCodegenIssue;
    message: string;
  };

export type CoreBaselineProof = {
  target: CoreBaselineTarget;
  managed_storage: "disabled";
  ok: boolean;
  final_result: CoreEscapeAnalysis;
  borrows: CoreBorrowValidation;
  freeze_edges: CoreFreezeProofEdge[];
  cleanup: CoreCleanupPlan;
  closure_ownership: CoreClosureOwnershipPlan;
  drops: CoreDropPlan;
  allocations: CoreAllocationPlan;
  host_boundaries: CoreHostBoundaryPlan;
  transfers: CoreTransferValidation;
  lifetimes: CoreLifetimePlan;
  issues: CoreProofIssue[];
};

export type CoreBaselineProofInput = {
  final_result: CoreEscapeAnalysis;
  borrows: CoreBorrowValidation;
  freeze_edges: CoreFreezeProofEdge[];
  cleanup: CoreCleanupPlan;
  closure_ownership: CoreClosureOwnershipPlan;
  drops: CoreDropPlan;
  allocations: CoreAllocationPlan;
  host_boundaries: CoreHostBoundaryPlan;
  transfers: CoreTransferValidation;
  lifetimes: CoreLifetimePlan;
  unsupported_codegen: CoreUnsupportedCodegenIssue[];
};

type CoreFreezeProofState = {
  next_freeze: number;
  edges: CoreFreezeProofEdge[];
};

type CoreFreezeProofHooks<ctx> = CoreOwnershipHooks<ctx> & {
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
  scoped_static_core_call_value?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
};

export function core_baseline_proof(
  input: CoreBaselineProofInput,
): CoreBaselineProof {
  const issues: CoreProofIssue[] = [];

  for (const issue of input.borrows.issues) {
    issues.push({
      tag: "borrow",
      issue,
      message: issue.message,
    });
  }

  for (const edge of input.freeze_edges) {
    if (edge.analysis.decision.tag === "allowed") {
      continue;
    }

    issues.push({
      tag: "freeze",
      edge,
      message: "Rejected baseline proof " + edge.id + ": " +
        edge.analysis.decision.reason,
    });
  }

  for (const step of input.cleanup.steps) {
    if (step.return_value.decision.tag === "allowed") {
      continue;
    }

    issues.push({
      tag: "scratch_return",
      step,
      message: scratch_return_issue_message(step),
    });
  }

  if (input.final_result.decision.tag === "rejected") {
    issues.push({
      tag: "final_result",
      analysis: input.final_result,
      message: "Rejected baseline proof final_result: " +
        input.final_result.decision.reason,
    });
  }

  for (const edge of input.host_boundaries.edges) {
    if (edge.decision.tag === "allowed") {
      continue;
    }

    issues.push({
      tag: "host_boundary",
      edge,
      message: "Rejected host/import boundary " + edge.id + " " +
        edge.callee + ": " + edge.decision.reason,
    });
  }

  for (const edge of input.closure_ownership.edges) {
    const reason = closure_capture_rejection_reason(edge);

    if (!reason) {
      continue;
    }

    issues.push({
      tag: "closure_capture",
      edge,
      message: "Rejected baseline proof " + edge.id + ": " + reason,
    });
  }

  for (const issue of input.transfers.issues) {
    issues.push({
      tag: "transfer",
      issue,
      message: issue.message,
    });
  }

  for (const issue of input.unsupported_codegen) {
    issues.push({
      tag: "unsupported_codegen",
      issue,
      message: issue.message,
    });
  }

  return {
    target: "core-3-nonweb",
    managed_storage: "disabled",
    ok: issues.length === 0,
    final_result: input.final_result,
    borrows: input.borrows,
    freeze_edges: input.freeze_edges,
    cleanup: input.cleanup,
    closure_ownership: input.closure_ownership,
    drops: input.drops,
    allocations: input.allocations,
    host_boundaries: input.host_boundaries,
    transfers: input.transfers,
    lifetimes: input.lifetimes,
    issues,
  };
}

export function core_unsupported_codegen_issues(
  core: Core,
  hooks: CoreUnsupportedCodegenHooks,
): CoreUnsupportedCodegenIssue[] {
  const issues: CoreUnsupportedCodegenIssue[] = [];

  for (const stmt of core.statements) {
    scan_unsupported_codegen_stmt(stmt, issues, hooks, 0);
  }

  return issues;
}

function scratch_return_issue_message(step: CoreCleanupStep): string {
  const prefix = "Rejected baseline proof " + step.scope + " scratch_return: ";

  if (step.return_detail) {
    return prefix + "unsafe scratch return " + step.return_detail + " and " +
      step.return_value.decision.reason;
  }

  return prefix + step.return_value.decision.reason;
}

function scan_unsupported_codegen_stmts(
  statements: CoreStmt[],
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  loop_depth: number,
): void {
  for (const stmt of statements) {
    scan_unsupported_codegen_stmt(stmt, issues, hooks, loop_depth);
  }
}

function scan_unsupported_codegen_stmt(
  stmt: CoreStmt,
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  loop_depth: number,
): void {
  switch (stmt.tag) {
    case "bind":
      if (stmt.kind === "let" && hooks.type_value_expr(stmt.value)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "type_value",
          message: "Cannot emit core type value expression yet",
        });
        return;
      }
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "assign":
      if (hooks.type_value_expr(stmt.value)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "type_value",
          message: "Cannot emit core type value expression yet",
        });
        return;
      }
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "index_assign":
      if (!hooks.index_assign_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "index_assign",
          message: "Cannot emit core index_assign statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.index,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "range_loop":
      scan_unsupported_codegen_expr(
        stmt.start,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.end,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.step,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.body,
        issues,
        hooks,
        loop_depth + 1,
      );
      return;

    case "collection_loop":
      if (!hooks.collection_loop_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "collection_loop",
          message: "Cannot emit core collection_loop statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.collection,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.body,
        issues,
        hooks,
        loop_depth + 1,
      );
      return;

    case "if_stmt":
      scan_unsupported_codegen_expr(
        stmt.cond,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(stmt.body, issues, hooks, loop_depth);
      return;

    case "if_else_stmt":
      scan_unsupported_codegen_expr(
        stmt.cond,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.then_body,
        issues,
        hooks,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.else_body,
        issues,
        hooks,
        loop_depth,
      );
      return;

    case "if_let_stmt":
      if (!hooks.if_let_stmt_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "if_let_stmt",
          message: "Cannot emit core if_let_stmt statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.target,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "type_check":
      scan_unsupported_codegen_expr(
        stmt.target,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "return":
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "expr":
      scan_unsupported_codegen_expr(
        stmt.expr,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "break":
      if (loop_depth === 0) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "break",
          message: "Cannot emit core break outside loop",
        });
      }
      return;

    case "continue":
      if (loop_depth === 0) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "continue",
          message: "Cannot emit core continue outside loop",
        });
      }
      return;

    case "unsupported":
      issues.push({
        tag: "unsupported_codegen",
        node: "stmt",
        feature: stmt.feature,
        message: "Cannot emit core " + stmt.feature + " statement yet",
      });
      return;
  }
}

function scan_unsupported_codegen_expr(
  expr: CoreExpr,
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  runtime_position: boolean,
  loop_depth = 0,
): void {
  if (runtime_position && hooks.type_value_expr(expr)) {
    issues.push({
      tag: "unsupported_codegen",
      node: "expr",
      feature: "type_value",
      message: "Cannot emit core type value expression yet",
    });
    return;
  }

  if (runtime_position) {
    const direct_issue = direct_unsupported_codegen_expr_issue(expr);

    if (direct_issue) {
      issues.push(direct_issue);
      return;
    }
  }

  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "lam":
    case "rec":
    case "struct_type":
    case "union_type":
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_unsupported_codegen_expr(
          arg,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }
      return;

    case "app":
      scan_unsupported_codegen_expr(
        expr.func,
        issues,
        hooks,
        false,
        loop_depth,
      );
      for (const arg of expr.args) {
        scan_unsupported_codegen_expr(
          arg,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }
      return;

    case "block":
      scan_unsupported_codegen_stmts(
        expr.statements,
        issues,
        hooks,
        loop_depth,
      );
      return;

    case "comptime":
      scan_unsupported_codegen_expr(
        expr.expr,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "borrow":
    case "freeze":
      scan_unsupported_codegen_expr(
        expr.value,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "scratch":
      scan_unsupported_codegen_expr(
        expr.body,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "with":
      scan_unsupported_codegen_expr(
        expr.base,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "struct_value":
      scan_unsupported_codegen_expr(
        expr.type_expr,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "struct_update":
      scan_unsupported_codegen_expr(
        expr.base,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "if":
      scan_unsupported_codegen_expr(
        expr.cond,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.then_branch,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.else_branch,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "if_let":
      if (!hooks.if_let_expr_supported(expr)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "if_let",
          message: "Cannot emit core if_let expression yet",
        });
      }
      scan_unsupported_codegen_expr(
        expr.target,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "field":
      scan_unsupported_codegen_expr(
        expr.object,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "index":
      if (!hooks.index_expr_supported(expr)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "index",
          message: "Cannot emit core index expression yet",
        });
      }
      scan_unsupported_codegen_expr(
        expr.object,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.index,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "union_case":
      if (expr.value) {
        scan_unsupported_codegen_expr(
          expr.value,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }

      if (expr.type_expr) {
        scan_unsupported_codegen_expr(
          expr.type_expr,
          issues,
          hooks,
          false,
          loop_depth,
        );
      }
      return;

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: expr.feature,
          message: "Missing host capability method: " + expr.text,
        });
        return;
      }

      issues.push({
        tag: "unsupported_codegen",
        node: "expr",
        feature: expr.feature,
        message: "Cannot emit core " + expr.feature + " expression yet",
      });
      return;
  }
}

function direct_unsupported_codegen_expr_issue(
  expr: CoreExpr,
): CoreUnsupportedCodegenIssue | undefined {
  switch (expr.tag) {
    case "rec":
    case "comptime":
    case "with":
    case "struct_update":
      return {
        tag: "unsupported_codegen",
        node: "expr",
        feature: expr.tag,
        message: "Cannot emit core " + expr.tag + " expression yet",
      };

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "prim":
    case "lam":
    case "app":
    case "block":
    case "borrow":
    case "freeze":
    case "scratch":
    case "struct_type":
    case "struct_value":
    case "union_type":
    case "if":
    case "if_let":
    case "field":
    case "index":
    case "union_case":
      return undefined;

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        return {
          tag: "unsupported_codegen",
          node: "expr",
          feature: expr.feature,
          message: "Missing host capability method: " + expr.text,
        };
      }

      return undefined;
  }
}

function scan_unsupported_codegen_fields(
  fields: CoreField[],
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  runtime_position: boolean,
  loop_depth: number,
): void {
  for (const field of fields) {
    scan_unsupported_codegen_expr(
      field.value,
      issues,
      hooks,
      runtime_position,
      loop_depth,
    );
  }
}

function closure_capture_rejection_reason(
  edge: CoreClosureOwnershipEdge,
): string | undefined {
  for (const capture of edge.captures) {
    if (capture.decision.tag === "reserved") {
      return capture.name + ": " + capture.decision.reason;
    }
  }

  return undefined;
}

export function core_check_baseline_proof(
  proof: CoreBaselineProof,
): void {
  const issue = proof.issues[0];
  if (!issue) {
    return;
  }

  throw new Error(issue.message);
}

export function core_freeze_proof_edges<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
): CoreFreezeProofEdge[] {
  const state: CoreFreezeProofState = {
    next_freeze: 0,
    edges: [],
  };

  for (const stmt of core.statements) {
    scan_freeze_stmt(stmt, ctx, hooks, state);
  }

  return state.edges;
}

function scan_freeze_stmt<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      if (freeze_stmt_value_is_direct_static_call_target(stmt, ctx, hooks)) {
        return;
      }

      scan_freeze_expr(stmt.value, ctx, hooks, state);
      return;

    case "index_assign":
      scan_freeze_expr(stmt.index, ctx, hooks, state);
      scan_freeze_expr(stmt.value, ctx, hooks, state);
      return;

    case "range_loop":
      scan_freeze_expr(stmt.start, ctx, hooks, state);
      scan_freeze_expr(stmt.end, ctx, hooks, state);
      scan_freeze_expr(stmt.step, ctx, hooks, state);
      scan_freeze_stmts(stmt.body, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_freeze_expr(stmt.collection, ctx, hooks, state);
      scan_freeze_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_stmt":
      scan_freeze_expr(stmt.cond, ctx, hooks, state);
      scan_freeze_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_else_stmt":
      scan_freeze_expr(stmt.cond, ctx, hooks, state);
      scan_freeze_stmts(stmt.then_body, ctx, hooks, state);
      scan_freeze_stmts(stmt.else_body, ctx, hooks, state);
      return;

    case "if_let_stmt":
      scan_freeze_if_let_stmt(stmt, ctx, hooks, state);
      return;

    case "type_check":
      scan_freeze_expr(stmt.target, ctx, hooks, state);
      return;

    case "return":
      scan_freeze_expr(stmt.value, ctx, hooks, state);
      return;

    case "expr":
      scan_freeze_expr(stmt.expr, ctx, hooks, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function freeze_stmt_value_is_direct_static_call_target<ctx>(
  stmt: Extract<CoreStmt, { tag: "bind" | "assign" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
): boolean {
  if (!hooks.static_core_call_target) {
    return false;
  }

  if (!hooks.static_core_call_requires_scope) {
    return false;
  }

  if (stmt.value.tag !== "lam") {
    return false;
  }

  const target = hooks.static_core_call_target(
    { tag: "var", name: stmt.name },
    ctx,
  );

  if (!target) {
    return false;
  }

  if (target !== stmt.value) {
    return false;
  }

  return hooks.static_core_call_requires_scope(target);
}

function scoped_static_freeze_call_value<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
): { value: CoreExpr; ctx: ctx } | undefined {
  if (
    !hooks.static_core_call_target ||
    !hooks.scoped_static_core_call_value ||
    !hooks.static_core_call_requires_scope
  ) {
    return undefined;
  }

  const target = hooks.static_core_call_target(expr.func, ctx);

  if (!target) {
    return undefined;
  }

  if (!hooks.static_core_call_requires_scope(target)) {
    return undefined;
  }

  return hooks.scoped_static_core_call_value(expr, target, ctx);
}

function scan_freeze_stmts<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  for (const stmt of statements) {
    scan_freeze_stmt(stmt, ctx, hooks, state);
  }
}

function scan_freeze_expr<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "lam":
    case "rec":
      scan_freeze_closure_body(expr, ctx, hooks, state);
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_freeze_expr(arg, ctx, hooks, state);
      }
      return;

    case "app": {
      scan_freeze_expr(expr.func, ctx, hooks, state);
      for (const arg of expr.args) {
        scan_freeze_expr(arg, ctx, hooks, state);
      }

      const scoped = scoped_static_freeze_call_value(expr, ctx, hooks);

      if (scoped) {
        scan_freeze_expr(scoped.value, scoped.ctx, hooks, state);
      }
      return;
    }

    case "block":
      scan_freeze_block(expr, ctx, hooks, state);
      return;

    case "comptime":
      scan_freeze_expr(expr.expr, ctx, hooks, state);
      return;

    case "borrow":
      scan_freeze_expr(expr.value, ctx, hooks, state);
      return;

    case "freeze": {
      const ownership = freeze_operand_ownership(expr.value, ctx, hooks);
      const id = "freeze#" + state.next_freeze.toString();
      state.next_freeze += 1;
      state.edges.push({
        id,
        analysis: core_escape_analysis("freeze", ownership),
      });
      scan_freeze_expr(expr.value, ctx, hooks, state);
      return;
    }

    case "scratch":
      scan_freeze_expr(expr.body, ctx, hooks, state);
      return;

    case "with":
      scan_freeze_expr(expr.base, ctx, hooks, state);
      scan_freeze_fields(expr.fields, ctx, hooks, state);
      return;

    case "struct_value":
      scan_freeze_expr(expr.type_expr, ctx, hooks, state);
      scan_freeze_fields(expr.fields, ctx, hooks, state);
      return;

    case "struct_update":
      scan_freeze_expr(expr.base, ctx, hooks, state);
      scan_freeze_fields(expr.fields, ctx, hooks, state);
      return;

    case "if":
      scan_freeze_expr(expr.cond, ctx, hooks, state);
      scan_freeze_expr(expr.then_branch, ctx, hooks, state);
      scan_freeze_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "if_let":
      scan_freeze_if_let_expr(expr, ctx, hooks, state);
      return;

    case "field":
      scan_freeze_expr(expr.object, ctx, hooks, state);
      return;

    case "index":
      scan_freeze_expr(expr.object, ctx, hooks, state);
      scan_freeze_expr(expr.index, ctx, hooks, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_freeze_expr(expr.value, ctx, hooks, state);
      }

      if (expr.type_expr) {
        scan_freeze_expr(expr.type_expr, ctx, hooks, state);
      }
      return;
  }
}

function scan_freeze_closure_body<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  if (!hooks.closure_body_ctx) {
    return;
  }

  const body_ctx = hooks.closure_body_ctx(expr, ctx);

  if (!body_ctx) {
    return;
  }

  scan_freeze_expr(expr.body, body_ctx, hooks, state);
}

function scan_freeze_if_let_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  scan_freeze_expr(stmt.target, ctx, hooks, state);

  if (
    !hooks.if_let_branch_ctx ||
    !hooks.static_union_case ||
    !hooks.dynamic_union_if ||
    !hooks.bind_core_if_let_payload_fact ||
    !hooks.bind_dynamic_if_let_payload
  ) {
    scan_freeze_stmts(stmt.body, ctx, hooks, state);
    return;
  }

  const union_case = hooks.static_union_case(stmt.target, ctx);

  if (union_case) {
    if (union_case.name !== stmt.case_name) {
      return;
    }

    const branch_ctx = hooks.if_let_branch_ctx(ctx);
    hooks.bind_core_if_let_payload_fact(
      stmt.value_name,
      union_case,
      branch_ctx,
    );
    scan_freeze_stmts(stmt.body, branch_ctx, hooks, state);
    return;
  }

  const dynamic_target = hooks.dynamic_union_if(stmt.target, ctx);

  if (dynamic_target) {
    if (!dynamic_if_let_can_match(stmt.case_name, dynamic_target)) {
      return;
    }

    const branch_ctx = hooks.if_let_branch_ctx(ctx);
    hooks.bind_dynamic_if_let_payload(
      stmt.case_name,
      stmt.value_name,
      dynamic_target,
      branch_ctx,
    );
    scan_freeze_stmts(stmt.body, branch_ctx, hooks, state);
    return;
  }

  scan_freeze_stmts(stmt.body, ctx, hooks, state);
}

function scan_freeze_if_let_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  scan_freeze_expr(expr.target, ctx, hooks, state);

  if (
    !hooks.if_let_branch_ctx ||
    !hooks.static_union_case ||
    !hooks.dynamic_union_if ||
    !hooks.bind_core_if_let_payload_fact ||
    !hooks.bind_dynamic_if_let_payload
  ) {
    scan_freeze_expr(expr.then_branch, ctx, hooks, state);
    scan_freeze_expr(expr.else_branch, ctx, hooks, state);
    return;
  }

  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name === expr.case_name) {
      const branch_ctx = hooks.if_let_branch_ctx(ctx);
      hooks.bind_core_if_let_payload_fact(
        expr.value_name,
        union_case,
        branch_ctx,
      );
      scan_freeze_expr(expr.then_branch, branch_ctx, hooks, state);
      return;
    }

    scan_freeze_expr(expr.else_branch, ctx, hooks, state);
    return;
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    if (dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      const branch_ctx = hooks.if_let_branch_ctx(ctx);
      hooks.bind_dynamic_if_let_payload(
        expr.case_name,
        expr.value_name,
        dynamic_target,
        branch_ctx,
      );
      scan_freeze_expr(expr.then_branch, branch_ctx, hooks, state);
    }

    scan_freeze_expr(expr.else_branch, ctx, hooks, state);
    return;
  }

  scan_freeze_expr(expr.then_branch, ctx, hooks, state);
  scan_freeze_expr(expr.else_branch, ctx, hooks, state);
}

function scan_freeze_block<ctx>(
  expr: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    scan_freeze_stmts(expr.statements, ctx, hooks, state);
    return;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (!stmt) {
      throw new Error("Missing freeze-proof block statement");
    }

    const is_final = index + 1 >= expr.statements.length;
    scan_freeze_stmt(stmt, block_ctx, hooks, state);

    if (!is_final) {
      hooks.collect_stmt_locals(stmt, block_ctx);
    }
  }
}

function freeze_operand_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership {
  if (expr.tag === "var" && hooks.runtime_aggregate_type_expr) {
    const type_expr = hooks.runtime_aggregate_type_expr(expr, ctx);

    if (type_expr) {
      return core_expr_ownership(expr, ctx, hooks);
    }
  }

  if (freeze_operand_static_aggregate_is_ownerless(expr, ctx, hooks)) {
    return { tag: "frozen_shareable", reason: "freeze" };
  }

  return core_expr_ownership(expr, ctx, hooks);
}

function freeze_operand_static_aggregate_is_ownerless<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  const struct_value = hooks.static_struct_value(expr, ctx);

  if (!struct_value) {
    return false;
  }

  for (const field of struct_value.fields) {
    if (!freeze_operand_static_field_is_ownerless(field.value, ctx, hooks)) {
      return false;
    }
  }

  return true;
}

function freeze_operand_static_field_is_ownerless<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  if (freeze_operand_static_aggregate_is_ownerless(expr, ctx, hooks)) {
    return true;
  }

  if (hooks.static_text_value(expr, ctx)) {
    return true;
  }

  if (hooks.static_union_case) {
    const union_case = hooks.static_union_case(expr, ctx);

    if (union_case) {
      if (!union_case.value) {
        return true;
      }

      return freeze_operand_static_field_is_ownerless(
        union_case.value,
        ctx,
        hooks,
      );
    }
  }

  const ownership = core_expr_ownership(expr, ctx, hooks);

  if (
    ownership.tag === "scalar_local" ||
    ownership.tag === "frozen_shareable"
  ) {
    return true;
  }

  return false;
}

function scan_freeze_fields<ctx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreFreezeProofHooks<ctx>,
  state: CoreFreezeProofState,
): void {
  for (const field of fields) {
    scan_freeze_expr(field.value, ctx, hooks, state);
  }
}
