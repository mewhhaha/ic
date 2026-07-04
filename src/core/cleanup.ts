import type { Core, CoreExpr, CoreField, CoreStmt } from "./ast.ts";
import { core_escape_analysis, type CoreEscapeAnalysis } from "./escape.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";
import { runtime_aggregate_freeze_copy_supported } from "./runtime_aggregate.ts";
import { runtime_union_freeze_copy_supported } from "./runtime_union_emit.ts";
import type { TypeStaticCtx } from "./type_static.ts";
import { static_block_result } from "./type_static.ts";

export type CoreCleanupExitEdge =
  | "fallthrough"
  | "return"
  | "break"
  | "continue";

export type CoreCleanupStep = {
  tag: "scratch_reset";
  scope: string;
  exit_edges: CoreCleanupExitEdge[];
  return_value: CoreEscapeAnalysis;
  return_detail?: string;
};

export type CoreCleanupPlan = {
  steps: CoreCleanupStep[];
};

type CoreCleanupState = {
  next_closure: number;
  next_scratch: number;
  steps: CoreCleanupStep[];
};

type CoreCleanupHooks<ctx> = CoreOwnershipHooks<ctx> & {
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

export function core_cleanup_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
): CoreCleanupPlan {
  const state: CoreCleanupState = {
    next_closure: 0,
    next_scratch: 0,
    steps: [],
  };

  for (const stmt of core.statements) {
    scan_cleanup_stmt(stmt, ctx, hooks, state);
  }

  return { steps: state.steps };
}

function scan_cleanup_expr<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
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
      scan_cleanup_closure_body(expr, ctx, hooks, state);
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_cleanup_expr(arg, ctx, hooks, state);
      }
      return;

    case "app": {
      scan_cleanup_expr(expr.func, ctx, hooks, state);
      for (const arg of expr.args) {
        scan_cleanup_expr(arg, ctx, hooks, state);
      }

      const scoped = scoped_static_cleanup_call_value(expr, ctx, hooks);

      if (scoped) {
        scan_cleanup_expr(scoped.value, scoped.ctx, hooks, state);
      }
      return;
    }

    case "block":
      scan_cleanup_block(expr, ctx, hooks, state);
      return;

    case "comptime":
      scan_cleanup_expr(expr.expr, ctx, hooks, state);
      return;

    case "borrow":
    case "freeze":
      scan_cleanup_expr(expr.value, ctx, hooks, state);
      return;

    case "scratch": {
      const ownership = core_scratch_return_ownership(expr.body, ctx, hooks);
      const return_detail = core_scratch_return_rejection_detail(
        expr.body,
        ctx,
        hooks,
      );
      const scope = "scratch#" + state.next_scratch.toString();
      state.next_scratch += 1;
      const step: CoreCleanupStep = {
        tag: "scratch_reset",
        scope,
        exit_edges: core_scratch_exit_edges(expr.body),
        return_value: core_escape_analysis("scratch_return", ownership),
      };
      if (return_detail) {
        step.return_detail = return_detail;
      }
      state.steps.push(step);
      scan_cleanup_expr(expr.body, ctx, hooks, state);
      return;
    }

    case "with":
      scan_cleanup_expr(expr.base, ctx, hooks, state);
      scan_cleanup_fields(expr.fields, ctx, hooks, state);
      return;

    case "struct_value":
      scan_cleanup_expr(expr.type_expr, ctx, hooks, state);
      scan_cleanup_fields(expr.fields, ctx, hooks, state);
      return;

    case "struct_update":
      scan_cleanup_expr(expr.base, ctx, hooks, state);
      scan_cleanup_fields(expr.fields, ctx, hooks, state);
      return;

    case "if":
      scan_cleanup_expr(expr.cond, ctx, hooks, state);
      scan_cleanup_expr(expr.then_branch, ctx, hooks, state);
      scan_cleanup_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "if_let":
      scan_cleanup_expr(expr.target, ctx, hooks, state);
      scan_cleanup_expr(expr.then_branch, ctx, hooks, state);
      scan_cleanup_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "field":
      scan_cleanup_expr(expr.object, ctx, hooks, state);
      return;

    case "index":
      scan_cleanup_expr(expr.object, ctx, hooks, state);
      scan_cleanup_expr(expr.index, ctx, hooks, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_cleanup_expr(expr.value, ctx, hooks, state);
      }

      if (expr.type_expr) {
        scan_cleanup_expr(expr.type_expr, ctx, hooks, state);
      }
      return;
  }
}

function scan_cleanup_stmts<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
): void {
  for (const stmt of statements) {
    scan_cleanup_stmt(stmt, ctx, hooks, state);
  }
}

function scan_cleanup_block<ctx>(
  expr: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
): void {
  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    scan_cleanup_stmts(expr.statements, ctx, hooks, state);
    return;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (!stmt) {
      throw new Error("Missing cleanup block statement");
    }

    const is_final = index + 1 >= expr.statements.length;
    scan_cleanup_stmt(stmt, block_ctx, hooks, state);

    if (!is_final) {
      hooks.collect_stmt_locals(stmt, block_ctx);
    }
  }
}

function scan_cleanup_stmt<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      if (cleanup_stmt_value_is_direct_static_call_target(stmt, ctx, hooks)) {
        return;
      }

      scan_cleanup_expr(stmt.value, ctx, hooks, state);
      return;

    case "index_assign":
      scan_cleanup_expr(stmt.index, ctx, hooks, state);
      scan_cleanup_expr(stmt.value, ctx, hooks, state);
      return;

    case "range_loop":
      scan_cleanup_expr(stmt.start, ctx, hooks, state);
      scan_cleanup_expr(stmt.end, ctx, hooks, state);
      scan_cleanup_expr(stmt.step, ctx, hooks, state);
      scan_cleanup_stmts(stmt.body, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_cleanup_expr(stmt.collection, ctx, hooks, state);
      scan_cleanup_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_stmt":
      scan_cleanup_expr(stmt.cond, ctx, hooks, state);
      scan_cleanup_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_else_stmt":
      scan_cleanup_expr(stmt.cond, ctx, hooks, state);
      scan_cleanup_stmts(stmt.then_body, ctx, hooks, state);
      scan_cleanup_stmts(stmt.else_body, ctx, hooks, state);
      return;

    case "if_let_stmt":
      scan_cleanup_expr(stmt.target, ctx, hooks, state);
      scan_cleanup_stmts(stmt.body, ctx, hooks, state);
      return;

    case "type_check":
      scan_cleanup_expr(stmt.target, ctx, hooks, state);
      return;

    case "return":
      scan_cleanup_expr(stmt.value, ctx, hooks, state);
      return;

    case "expr":
      scan_cleanup_expr(stmt.expr, ctx, hooks, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function cleanup_stmt_value_is_direct_static_call_target<ctx>(
  stmt: Extract<CoreStmt, { tag: "bind" | "assign" }>,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
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

function scoped_static_cleanup_call_value<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
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

function scan_cleanup_closure_body<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
): void {
  if (!hooks.closure_body_ctx) {
    return;
  }

  const body_ctx = hooks.closure_body_ctx(expr, ctx);

  if (!body_ctx) {
    return;
  }

  state.next_closure += 1;
  scan_cleanup_expr(expr.body, body_ctx, hooks, state);
}

export function core_scratch_return_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreOwnership {
  const block_value = static_block_result(expr);

  if (block_value) {
    return core_scratch_return_ownership(block_value, ctx, hooks);
  }

  const block_result = scratch_block_result_with_ctx(expr, ctx, hooks);

  if (block_result) {
    return core_scratch_return_ownership(
      block_result.expr,
      block_result.ctx,
      hooks,
    );
  }

  if (expr.tag === "freeze") {
    const source = core_expr_ownership(expr.value, ctx, hooks);

    if (source.tag === "unique_heap") {
      if (source.reason === "text") {
        return { tag: "frozen_shareable", reason: "freeze" };
      }

      if (source.reason === "closure") {
        return { tag: "frozen_shareable", reason: "freeze" };
      }

      if (
        source.reason === "runtime_aggregate" &&
        (
          scratch_freeze_can_emit_runtime_aggregate(expr.value, ctx, hooks) ||
          scratch_freeze_can_copy_runtime_aggregate(expr.value, ctx, hooks)
        )
      ) {
        return { tag: "frozen_shareable", reason: "freeze" };
      }

      if (
        source.reason === "runtime_union" &&
        (
          scratch_freeze_can_emit_runtime_union(expr.value, ctx, hooks) ||
          scratch_freeze_can_copy_runtime_union(expr.value, ctx, hooks)
        )
      ) {
        return { tag: "frozen_shareable", reason: "freeze" };
      }

      if (
        source.reason === "runtime_aggregate" ||
        source.reason === "runtime_union"
      ) {
        return { tag: "scratch_backed", source };
      }
    }

    if (
      source.tag !== "scalar_local" &&
      source.tag !== "frozen_shareable" &&
      !scratch_return_static_aggregate_is_free(expr.value, ctx, hooks) &&
      !scratch_return_static_union_is_free(expr.value, ctx, hooks)
    ) {
      return { tag: "scratch_backed", source };
    }
  }

  if (scratch_return_static_aggregate_is_free(expr, ctx, hooks)) {
    return { tag: "frozen_shareable", reason: "runtime_aggregate" };
  }

  if (scratch_return_static_union_is_free(expr, ctx, hooks)) {
    return { tag: "frozen_shareable", reason: "runtime_union" };
  }

  return core_expr_ownership(expr, ctx, hooks);
}

function scratch_freeze_can_emit_runtime_aggregate<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  return expr.tag === "struct_value" && !!hooks.static_struct_value(expr, ctx);
}

function scratch_freeze_can_copy_runtime_aggregate<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  if (!hooks.runtime_aggregate_type_expr) {
    return false;
  }

  const type_expr = hooks.runtime_aggregate_type_expr(expr, ctx);

  if (!type_expr) {
    return false;
  }

  return runtime_aggregate_freeze_copy_supported(
    type_expr,
    ctx as ctx & TypeStaticCtx,
    {
      runtime_union_freeze_copy_supported,
    },
  );
}

function scratch_freeze_can_emit_runtime_union<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  const value = hooks.runtime_union_value(expr, ctx);

  if (!value) {
    return false;
  }

  return expr.tag !== "var" && value.tag === "union_case";
}

function scratch_freeze_can_copy_runtime_union<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  const type_expr = scratch_runtime_union_type_expr(expr, ctx, hooks);

  if (!type_expr) {
    return false;
  }

  return runtime_union_freeze_copy_supported(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
}

function scratch_runtime_union_type_expr<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): CoreExpr | undefined {
  const value = hooks.runtime_union_value(expr, ctx);

  if (value) {
    if (value.tag === "union_case") {
      return value.type_expr;
    }

    if (value.tag === "if") {
      return scratch_runtime_union_type_expr(value.then_branch, ctx, hooks);
    }
  }

  if (hooks.runtime_union_target) {
    const target = hooks.runtime_union_target(expr, ctx);

    if (target) {
      return target.type_expr;
    }
  }

  return undefined;
}

function scratch_block_result_with_ctx<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): { expr: CoreExpr; ctx: ctx } | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    return undefined;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (!stmt) {
      throw new Error("Missing scratch block statement");
    }

    const is_final = index + 1 >= expr.statements.length;

    if (!is_final) {
      hooks.collect_stmt_locals(stmt, block_ctx);
      continue;
    }

    if (stmt.tag === "expr") {
      return { expr: stmt.expr, ctx: block_ctx };
    }

    if (stmt.tag === "return") {
      return { expr: stmt.value, ctx: block_ctx };
    }

    hooks.collect_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

function scratch_return_static_aggregate_is_free<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  const struct_value = hooks.static_struct_value(expr, ctx);

  if (!struct_value) {
    return false;
  }

  for (const field of struct_value.fields) {
    if (!scratch_return_static_field_is_free(field.value, ctx, hooks)) {
      return false;
    }
  }

  return true;
}

export function core_scratch_return_rejection_detail<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): string | undefined {
  const block_value = static_block_result(expr);

  if (block_value) {
    return core_scratch_return_rejection_detail(block_value, ctx, hooks);
  }

  const block_result = scratch_block_result_with_ctx(expr, ctx, hooks);

  if (block_result) {
    return core_scratch_return_rejection_detail(
      block_result.expr,
      block_result.ctx,
      hooks,
    );
  }

  const aggregate_detail = scratch_return_static_aggregate_rejection_detail(
    expr,
    ctx,
    hooks,
  );

  if (aggregate_detail) {
    return aggregate_detail;
  }

  const union_detail = scratch_return_static_union_rejection_detail(
    expr,
    ctx,
    hooks,
  );

  if (union_detail) {
    return union_detail;
  }

  return undefined;
}

function scratch_return_static_aggregate_rejection_detail<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): string | undefined {
  const struct_value = hooks.static_struct_value(expr, ctx);

  if (!struct_value) {
    return undefined;
  }

  for (const field of struct_value.fields) {
    const detail = scratch_return_static_field_rejection_detail(
      field.value,
      ctx,
      hooks,
    );

    if (detail) {
      return "field " + field.name + " " + detail;
    }
  }

  return undefined;
}

function scratch_return_static_field_is_free<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  if (scratch_return_static_aggregate_is_free(expr, ctx, hooks)) {
    return true;
  }

  if (scratch_return_static_union_is_free(expr, ctx, hooks)) {
    return true;
  }

  if (hooks.static_text_value(expr, ctx)) {
    return true;
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

function scratch_return_static_field_rejection_detail<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): string | undefined {
  const aggregate_detail = scratch_return_static_aggregate_rejection_detail(
    expr,
    ctx,
    hooks,
  );

  if (aggregate_detail) {
    return aggregate_detail;
  }

  const union_detail = scratch_return_static_union_rejection_detail(
    expr,
    ctx,
    hooks,
  );

  if (union_detail) {
    return union_detail;
  }

  if (hooks.static_text_value(expr, ctx)) {
    return undefined;
  }

  const ownership = core_expr_ownership(expr, ctx, hooks);

  if (
    ownership.tag === "scalar_local" ||
    ownership.tag === "frozen_shareable"
  ) {
    return undefined;
  }

  return "may reference " + core_ownership_result_text(ownership);
}

function scratch_return_static_union_is_free<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  const value = hooks.runtime_union_value(expr, ctx);

  if (!value) {
    return false;
  }

  return scratch_return_static_union_value_is_free(value, ctx, hooks);
}

function scratch_return_static_union_value_is_free<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): boolean {
  if (expr.tag === "union_case") {
    if (!expr.value) {
      return true;
    }

    return scratch_return_static_field_is_free(expr.value, ctx, hooks);
  }

  if (expr.tag === "if") {
    return scratch_return_static_field_is_free(expr.cond, ctx, hooks) &&
      scratch_return_static_union_value_is_free(
        expr.then_branch,
        ctx,
        hooks,
      ) &&
      scratch_return_static_union_value_is_free(
        expr.else_branch,
        ctx,
        hooks,
      );
  }

  return false;
}

function scratch_return_static_union_rejection_detail<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): string | undefined {
  const value = hooks.runtime_union_value(expr, ctx);

  if (!value) {
    return undefined;
  }

  return scratch_return_static_union_value_rejection_detail(value, ctx, hooks);
}

function scratch_return_static_union_value_rejection_detail<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreOwnershipHooks<ctx>,
): string | undefined {
  if (expr.tag === "union_case") {
    if (!expr.value) {
      return undefined;
    }

    const detail = scratch_return_static_field_rejection_detail(
      expr.value,
      ctx,
      hooks,
    );

    if (detail) {
      return "payload ." + expr.name + " " + detail;
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const cond_detail = scratch_return_static_field_rejection_detail(
      expr.cond,
      ctx,
      hooks,
    );

    if (cond_detail) {
      return "condition " + cond_detail;
    }

    const then_detail = scratch_return_static_union_value_rejection_detail(
      expr.then_branch,
      ctx,
      hooks,
    );

    if (then_detail) {
      return "then " + then_detail;
    }

    const else_detail = scratch_return_static_union_value_rejection_detail(
      expr.else_branch,
      ctx,
      hooks,
    );

    if (else_detail) {
      return "else " + else_detail;
    }
  }

  return undefined;
}

function scan_cleanup_fields<ctx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreCleanupHooks<ctx>,
  state: CoreCleanupState,
): void {
  for (const field of fields) {
    scan_cleanup_expr(field.value, ctx, hooks, state);
  }
}

export function core_scratch_exit_edges(expr: CoreExpr): CoreCleanupExitEdge[] {
  const edges = new Set<CoreCleanupExitEdge>();
  edges.add("fallthrough");
  collect_expr_exit_edges(expr, edges, 0);
  return ordered_exit_edges(edges);
}

function collect_expr_exit_edges(
  expr: CoreExpr,
  edges: Set<CoreCleanupExitEdge>,
  loop_depth: number,
): void {
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
    case "unsupported":
      return;

    case "prim":
      for (const arg of expr.args) {
        collect_expr_exit_edges(arg, edges, loop_depth);
      }
      return;

    case "app":
      collect_expr_exit_edges(expr.func, edges, loop_depth);
      for (const arg of expr.args) {
        collect_expr_exit_edges(arg, edges, loop_depth);
      }
      return;

    case "block":
      collect_stmt_exit_edges(expr.statements, edges, loop_depth);
      return;

    case "comptime":
      collect_expr_exit_edges(expr.expr, edges, loop_depth);
      return;

    case "borrow":
    case "freeze":
      collect_expr_exit_edges(expr.value, edges, loop_depth);
      return;

    case "scratch":
      collect_expr_exit_edges(expr.body, edges, loop_depth);
      return;

    case "with":
      collect_expr_exit_edges(expr.base, edges, loop_depth);
      collect_field_exit_edges(expr.fields, edges, loop_depth);
      return;

    case "struct_value":
      collect_expr_exit_edges(expr.type_expr, edges, loop_depth);
      collect_field_exit_edges(expr.fields, edges, loop_depth);
      return;

    case "struct_update":
      collect_expr_exit_edges(expr.base, edges, loop_depth);
      collect_field_exit_edges(expr.fields, edges, loop_depth);
      return;

    case "if":
      collect_expr_exit_edges(expr.cond, edges, loop_depth);
      collect_expr_exit_edges(expr.then_branch, edges, loop_depth);
      collect_expr_exit_edges(expr.else_branch, edges, loop_depth);
      return;

    case "if_let":
      collect_expr_exit_edges(expr.target, edges, loop_depth);
      collect_expr_exit_edges(expr.then_branch, edges, loop_depth);
      collect_expr_exit_edges(expr.else_branch, edges, loop_depth);
      return;

    case "field":
      collect_expr_exit_edges(expr.object, edges, loop_depth);
      return;

    case "index":
      collect_expr_exit_edges(expr.object, edges, loop_depth);
      collect_expr_exit_edges(expr.index, edges, loop_depth);
      return;

    case "union_case":
      if (expr.value) {
        collect_expr_exit_edges(expr.value, edges, loop_depth);
      }

      if (expr.type_expr) {
        collect_expr_exit_edges(expr.type_expr, edges, loop_depth);
      }
      return;
  }
}

function collect_stmt_exit_edges(
  statements: CoreStmt[],
  edges: Set<CoreCleanupExitEdge>,
  loop_depth: number,
): void {
  for (const stmt of statements) {
    collect_one_stmt_exit_edges(stmt, edges, loop_depth);
  }
}

function collect_one_stmt_exit_edges(
  stmt: CoreStmt,
  edges: Set<CoreCleanupExitEdge>,
  loop_depth: number,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      collect_expr_exit_edges(stmt.value, edges, loop_depth);
      return;

    case "index_assign":
      collect_expr_exit_edges(stmt.index, edges, loop_depth);
      collect_expr_exit_edges(stmt.value, edges, loop_depth);
      return;

    case "range_loop":
      collect_expr_exit_edges(stmt.start, edges, loop_depth);
      collect_expr_exit_edges(stmt.end, edges, loop_depth);
      collect_expr_exit_edges(stmt.step, edges, loop_depth);
      collect_stmt_exit_edges(stmt.body, edges, loop_depth + 1);
      return;

    case "collection_loop":
      collect_expr_exit_edges(stmt.collection, edges, loop_depth);
      collect_stmt_exit_edges(stmt.body, edges, loop_depth + 1);
      return;

    case "if_stmt":
      collect_expr_exit_edges(stmt.cond, edges, loop_depth);
      collect_stmt_exit_edges(stmt.body, edges, loop_depth);
      return;

    case "if_else_stmt":
      collect_expr_exit_edges(stmt.cond, edges, loop_depth);
      collect_stmt_exit_edges(stmt.then_body, edges, loop_depth);
      collect_stmt_exit_edges(stmt.else_body, edges, loop_depth);
      return;

    case "if_let_stmt":
      collect_expr_exit_edges(stmt.target, edges, loop_depth);
      collect_stmt_exit_edges(stmt.body, edges, loop_depth);
      return;

    case "type_check":
      collect_expr_exit_edges(stmt.target, edges, loop_depth);
      return;

    case "break":
      if (loop_depth === 0) {
        edges.add("break");
      }
      return;

    case "continue":
      if (loop_depth === 0) {
        edges.add("continue");
      }
      return;

    case "return":
      edges.add("return");
      collect_expr_exit_edges(stmt.value, edges, loop_depth);
      return;

    case "expr":
      collect_expr_exit_edges(stmt.expr, edges, loop_depth);
      return;

    case "unsupported":
      return;
  }
}

function collect_field_exit_edges(
  fields: CoreField[],
  edges: Set<CoreCleanupExitEdge>,
  loop_depth: number,
): void {
  for (const field of fields) {
    collect_expr_exit_edges(field.value, edges, loop_depth);
  }
}

function ordered_exit_edges(
  edges: Set<CoreCleanupExitEdge>,
): CoreCleanupExitEdge[] {
  const ordered: CoreCleanupExitEdge[] = [];

  if (edges.has("fallthrough")) {
    ordered.push("fallthrough");
  }

  if (edges.has("return")) {
    ordered.push("return");
  }

  if (edges.has("break")) {
    ordered.push("break");
  }

  if (edges.has("continue")) {
    ordered.push("continue");
  }

  return ordered;
}
