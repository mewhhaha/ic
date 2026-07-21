import type { Core, CoreExpr, CoreStmt } from "./ast.ts";
import {
  record_host_boundary_scratch_local,
  record_host_boundary_stmt_alias,
} from "./host_boundary/alias.ts";
import { scan_host_boundary_app } from "./host_boundary/app.ts";
import { scan_host_boundary_closure } from "./host_boundary/closure.ts";
import type {
  CoreHostBoundaryHooks,
  CoreHostBoundaryPlan,
  CoreHostBoundaryState,
} from "./host_boundary/types.ts";
import {
  bind_host_boundary_stmt_function,
  scan_static_host_boundary_wrapper_definition,
} from "./host_boundary/static_call.ts";
import type { CoreHostImportCtx } from "./host_import.ts";
import type { StaticCoreCallCtx } from "./static_call.ts";

export type {
  CoreHostBoundaryArg,
  CoreHostBoundaryClosureCtx,
  CoreHostBoundaryDecision,
  CoreHostBoundaryEdge,
  CoreHostBoundaryHooks,
  CoreHostBoundaryPlan,
} from "./host_boundary/types.ts";

export function core_host_boundary_plan<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  core: Core,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
): CoreHostBoundaryPlan {
  const state: CoreHostBoundaryState = {
    next_host: 0,
    edges: [],
    scratch_depth: 0,
    scratch_locals: new Map(),
    aliases: new Map(),
    functions: new Map(),
    active_static_calls: new Set(),
    static_wrapper_depth: 0,
  };

  scan_host_boundary_stmts(core.statements, ctx, hooks, state);

  return {
    edges: state.edges,
  };
}

function scan_host_boundary_stmts<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  for (const stmt of statements) {
    scan_host_boundary_stmt(stmt, ctx, hooks, state);
    collect_host_boundary_stmt_locals(stmt, ctx, hooks, state);
  }
}

function scan_host_boundary_stmt<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      if (
        scan_static_host_boundary_wrapper_definition(
          stmt.value,
          ctx,
          hooks,
          state,
          scan_host_boundary_expr,
        )
      ) {
        return;
      }

      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "index_assign":
      scan_host_boundary_expr(stmt.index, ctx, hooks, state);
      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "range_loop":
      scan_host_boundary_expr(stmt.start, ctx, hooks, state);
      scan_host_boundary_expr(stmt.end, ctx, hooks, state);
      scan_host_boundary_expr(stmt.step, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_host_boundary_expr(stmt.collection, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_stmt":
      scan_host_boundary_expr(stmt.cond, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_else_stmt":
      scan_host_boundary_expr(stmt.cond, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.then_body, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.else_body, ctx, hooks, state);
      return;

    case "if_let_stmt":
      scan_host_boundary_expr(stmt.target, ctx, hooks, state);
      {
        const branch = hooks.if_let_stmt_branch_ctx(
          stmt.case_name,
          stmt.value_name,
          stmt.target,
          ctx,
        );
        if (branch.tag === "scan") {
          scan_host_boundary_stmts(stmt.body, branch.ctx, hooks, state);
        } else if (branch.tag === "unknown") {
          scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
        }
      }
      return;

    case "type_check":
      scan_host_boundary_expr(stmt.target, ctx, hooks, state);
      return;

    case "return":
      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "expr":
      scan_host_boundary_expr(stmt.expr, ctx, hooks, state);
      return;

    case "break":
      if (stmt.value) {
        scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      }
      return;
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_host_boundary_expr<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
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

    case "prim":
      for (const arg of expr.args) {
        scan_host_boundary_expr(arg, ctx, hooks, state);
      }
      return;

    case "lam":
    case "rec": {
      scan_host_boundary_closure(
        expr,
        ctx,
        hooks,
        state,
        scan_host_boundary_expr,
      );
      return;
    }

    case "app":
      scan_host_boundary_app(
        expr,
        ctx,
        hooks,
        state,
        scan_host_boundary_expr,
      );
      return;

    case "block":
      scan_host_boundary_stmts(expr.statements, ctx, hooks, state);
      return;

    case "loop":
      scan_host_boundary_stmts(expr.body, ctx, hooks, state);
      return;

    case "comptime":
      scan_host_boundary_expr(expr.expr, ctx, hooks, state);
      return;

    case "borrow":
    case "freeze":
      scan_host_boundary_expr(expr.value, ctx, hooks, state);
      return;

    case "scratch": {
      const scratch_locals = state.scratch_locals;
      state.scratch_locals = new Map(scratch_locals);
      state.scratch_depth += 1;
      scan_host_boundary_expr(expr.body, ctx, hooks, state);
      state.scratch_depth -= 1;
      state.scratch_locals = scratch_locals;
      return;
    }

    case "with":
      scan_host_boundary_expr(expr.base, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "struct_value":
      scan_host_boundary_expr(expr.type_expr, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "struct_update":
      scan_host_boundary_expr(expr.base, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "if":
      scan_host_boundary_expr(expr.cond, ctx, hooks, state);
      scan_host_boundary_expr(expr.then_branch, ctx, hooks, state);
      scan_host_boundary_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "if_let":
      scan_host_boundary_expr(expr.target, ctx, hooks, state);
      {
        const branch = hooks.if_let_stmt_branch_ctx(
          expr.case_name,
          expr.value_name,
          expr.target,
          ctx,
        );
        if (branch.tag === "scan") {
          scan_host_boundary_expr(
            expr.then_branch,
            branch.ctx,
            hooks,
            state,
          );
        } else if (branch.tag === "unknown") {
          scan_host_boundary_expr(expr.then_branch, ctx, hooks, state);
        }
        scan_host_boundary_expr(expr.else_branch, ctx, hooks, state);
      }
      return;

    case "field":
      scan_host_boundary_expr(expr.object, ctx, hooks, state);
      return;

    case "index":
      scan_host_boundary_expr(expr.object, ctx, hooks, state);
      scan_host_boundary_expr(expr.index, ctx, hooks, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_host_boundary_expr(expr.value, ctx, hooks, state);
      }
      if (expr.type_expr) {
        scan_host_boundary_expr(expr.type_expr, ctx, hooks, state);
      }
      return;
  }
}

function collect_host_boundary_stmt_locals<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  record_host_boundary_stmt_alias(stmt, state);
  bind_host_boundary_stmt_function(stmt, state);

  if (!hooks.collect_stmt_locals) {
    return;
  }

  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return;
  }
  if (stmt.tag === "bind" && stmt.kind === "const") {
    return;
  }
  try {
    hooks.collect_stmt_locals(stmt, ctx);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Cannot type core lam expression yet" ||
        error.message === "Cannot type core rec expression yet" ||
        error.message.startsWith("Unbound core local: "))
    ) {
      return;
    }
    throw new Error(
      "Host-boundary scan could not collect statement " + stmt.tag,
      {
        cause: error,
      },
    );
  }

  if (state.scratch_depth === 0) {
    return;
  }

  record_host_boundary_scratch_local(stmt.name, stmt.value, ctx, hooks, state);
}
