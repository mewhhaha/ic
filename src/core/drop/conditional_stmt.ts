import {
  type CoreDropStmtsScanner,
  merge_if_else_branch_owners,
  merge_if_stmt_branch_owners,
  scan_drop_branch_stmts,
} from "./branch.ts";
import { drop_if_let_branch_ctx } from "./conditional_expr.ts";
import { emit_drop } from "./emit.ts";
import { unique_heap_ownership } from "./ownership.ts";
import { next_block_scope } from "./state.ts";
import type {
  CoreDropExitOwners,
  CoreDropHooks,
  CoreDropOwner,
  CoreDropState,
  CoreExpr,
  CoreStmt,
} from "./types.ts";

type CoreDropExprChildrenScanner<ctx> = (
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
) => boolean;

export function scan_drop_if_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
  scan_drop_stmts: CoreDropStmtsScanner<ctx>,
): boolean {
  const cond_continues = scan_drop_expr_children(
    stmt.cond,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  if (!cond_continues) {
    return false;
  }

  const block_scope = next_block_scope(state);
  const branch = scan_drop_branch_stmts(
    stmt.body,
    block_scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
    scan_drop_stmts,
  );
  merge_if_stmt_branch_owners(owners, branch);
  return true;
}

export function scan_drop_if_else_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
  scan_drop_stmts: CoreDropStmtsScanner<ctx>,
): boolean {
  const cond_continues = scan_drop_expr_children(
    stmt.cond,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  if (!cond_continues) {
    return false;
  }

  const then_scope = next_block_scope(state);
  const then_branch = scan_drop_branch_stmts(
    stmt.then_body,
    then_scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
    scan_drop_stmts,
  );
  const else_scope = next_block_scope(state);
  const else_branch = scan_drop_branch_stmts(
    stmt.else_body,
    else_scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
    scan_drop_stmts,
  );

  if (then_branch.continues || else_branch.continues) {
    merge_if_else_branch_owners(owners, [then_branch, else_branch]);
    return true;
  }

  owners.clear();
  return false;
}

export function scan_drop_if_let_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
  scan_drop_stmts: CoreDropStmtsScanner<ctx>,
): boolean {
  const target_continues = scan_drop_expr_children(
    stmt.target,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  if (!target_continues) {
    return false;
  }

  let temporary_target_owner: CoreDropOwner | undefined;
  if (stmt.target.tag === "app") {
    const ownership = unique_heap_ownership(stmt.target, ctx, hooks);
    if (ownership && ownership.reason === "runtime_union") {
      temporary_target_owner = {
        name: "_if_let_target#" + state.next_block.toString(),
        ownership,
        pointer: "temporary",
        subject: stmt.target,
      };
      owners.set(temporary_target_owner.name, temporary_target_owner);
    }
  }

  const branch_ctx = drop_if_let_branch_ctx(
    stmt.case_name,
    stmt.value_name,
    stmt.target,
    ctx,
    hooks,
  );
  if (branch_ctx.tag !== "skip") {
    const block_scope = next_block_scope(state);
    const branch = scan_drop_branch_stmts(
      stmt.body,
      block_scope,
      owners,
      exit_owners,
      branch_ctx.ctx,
      hooks,
      state,
      scan_drop_stmts,
    );
    merge_if_stmt_branch_owners(owners, branch);
  }

  if (temporary_target_owner) {
    owners.delete(temporary_target_owner.name);
    emit_drop(
      "conditional_cleanup",
      scope,
      undefined,
      temporary_target_owner,
      state,
      stmt.target,
    );
  }

  return true;
}
