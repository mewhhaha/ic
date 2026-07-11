import type { CoreExpr, CoreHostImport, CoreStmt } from "../ast.ts";
import {
  child_scope,
  clone_transfer_state,
  merge_conditional_transfer_states,
} from "./state.ts";
import type { CoreTransferState } from "./types.ts";

type ScanTransferExpr<ctx> = (
  expr: CoreExpr,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
) => void;

type ScanTransferStmts<ctx> = (
  statements: CoreStmt[],
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
) => void;

export function scan_transfer_range_loop_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "range_loop" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
  scan_transfer_stmts: ScanTransferStmts<ctx>,
): void {
  scan_transfer_expr(stmt.start, scope, host_imports, state);
  scan_transfer_expr(stmt.end, scope, host_imports, state);
  scan_transfer_expr(stmt.step, scope, host_imports, state);
  const body = clone_transfer_state(state);
  scan_transfer_stmts(
    stmt.body,
    child_scope(scope, "loop"),
    host_imports,
    body,
  );
  merge_conditional_transfer_states(state, [body], 2);
}

export function scan_transfer_collection_loop_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
  scan_transfer_stmts: ScanTransferStmts<ctx>,
): void {
  scan_transfer_expr(stmt.collection, scope, host_imports, state);
  const body = clone_transfer_state(state);
  scan_transfer_stmts(
    stmt.body,
    child_scope(scope, "loop"),
    host_imports,
    body,
  );
  merge_conditional_transfer_states(state, [body], 2);
}

export function scan_transfer_if_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
  scan_transfer_stmts: ScanTransferStmts<ctx>,
): void {
  scan_transfer_expr(stmt.cond, scope, host_imports, state);
  const branch = clone_transfer_state(state);
  scan_transfer_stmts(
    stmt.body,
    child_scope(scope, "if"),
    host_imports,
    branch,
  );
  merge_conditional_transfer_states(state, [branch], 2);
}

export function scan_transfer_if_else_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
  scan_transfer_stmts: ScanTransferStmts<ctx>,
): void {
  scan_transfer_expr(stmt.cond, scope, host_imports, state);
  const then_branch = clone_transfer_state(state);
  scan_transfer_stmts(
    stmt.then_body,
    child_scope(scope, "if_then"),
    host_imports,
    then_branch,
  );
  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_transfer_stmts(
    stmt.else_body,
    child_scope(scope, "if_else"),
    host_imports,
    else_branch,
  );
  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

export function scan_transfer_if_let_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
  scan_transfer_stmts: ScanTransferStmts<ctx>,
): void {
  scan_transfer_expr(stmt.target, scope, host_imports, state);
  const branch_context = transfer_if_let_stmt_branch_ctx(stmt, state);

  if (branch_context.tag === "skip") {
    return;
  }

  const branch = clone_transfer_state(state);

  if (branch_context.tag === "scan") {
    branch.ctx = branch_context.ctx;
  }

  scan_transfer_stmts(
    stmt.body,
    child_scope(scope, "if_let"),
    host_imports,
    branch,
  );
  merge_conditional_transfer_states(state, [branch], 2);
}

export function scan_transfer_if_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
): void {
  const then_branch = clone_transfer_state(state);
  scan_transfer_expr(
    expr.then_branch,
    child_scope(scope, "if_then"),
    host_imports,
    then_branch,
  );
  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_transfer_expr(
    expr.else_branch,
    child_scope(scope, "if_else"),
    host_imports,
    else_branch,
  );
  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

export function scan_transfer_if_let_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
): void {
  const branch_context = transfer_if_let_branch_ctx(
    expr.target,
    expr.case_name,
    expr.value_name,
    state,
  );
  const then_branch = clone_transfer_state(state);

  if (branch_context.tag === "scan") {
    then_branch.ctx = branch_context.ctx;
  }

  if (branch_context.tag !== "skip") {
    scan_transfer_expr(
      expr.then_branch,
      child_scope(scope, "if_let_then"),
      host_imports,
      then_branch,
    );
  }

  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_transfer_expr(
    expr.else_branch,
    child_scope(scope, "if_let_else"),
    host_imports,
    else_branch,
  );
  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

function transfer_if_let_stmt_branch_ctx<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  state: CoreTransferState<ctx>,
): { tag: "scan"; ctx: ctx } | { tag: "skip" } | { tag: "unknown" } {
  return transfer_if_let_branch_ctx(
    stmt.target,
    stmt.case_name,
    stmt.value_name,
    state,
  );
}

function transfer_if_let_branch_ctx<ctx>(
  target: CoreExpr,
  case_name: string,
  value_name: string | undefined,
  state: CoreTransferState<ctx>,
): { tag: "scan"; ctx: ctx } | { tag: "skip" } | { tag: "unknown" } {
  const hooks = state.hooks;

  if (
    hooks.static_union_case &&
    hooks.if_let_branch_ctx &&
    hooks.bind_core_if_let_payload_fact
  ) {
    const union_case = hooks.static_union_case(target, state.ctx);

    if (union_case) {
      if (union_case.name !== case_name) {
        return { tag: "skip" };
      }

      const branch_ctx = hooks.if_let_branch_ctx(state.ctx);
      hooks.bind_core_if_let_payload_fact(
        value_name,
        union_case,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  if (
    hooks.dynamic_union_if &&
    hooks.if_let_branch_ctx &&
    hooks.bind_dynamic_if_let_payload
  ) {
    const dynamic_target = hooks.dynamic_union_if(target, state.ctx);

    if (dynamic_target) {
      if (
        dynamic_target.then_case.name !== case_name &&
        dynamic_target.else_case.name !== case_name
      ) {
        return { tag: "skip" };
      }

      const branch_ctx = hooks.if_let_branch_ctx(state.ctx);
      hooks.bind_dynamic_if_let_payload(
        case_name,
        value_name,
        dynamic_target,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  if (
    hooks.runtime_union_target &&
    hooks.runtime_union_match_info &&
    hooks.static_runtime_union_match_branch_ctx
  ) {
    const runtime_target = hooks.runtime_union_target(
      target,
      state.ctx,
    );

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        case_name,
        runtime_target,
        state.ctx,
      );
      const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
        value_name,
        info,
        state.ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  return { tag: "unknown" };
}
