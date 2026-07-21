import { emit_drop } from "./emit.ts";
import {
  frozen_expr_consumed_owner,
  moved_expr_owner,
  simple_expr_result_owner,
  unique_heap_ownership,
} from "./ownership.ts";
import type {
  CoreDropEdge,
  CoreDropExitOwners,
  CoreDropExprBranchResult,
  CoreDropExprResult,
  CoreDropHooks,
  CoreDropOwner,
  CoreDropState,
  CoreExpr,
} from "./types.ts";

export type CoreDropExprChildrenScanner<ctx> = (
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
) => boolean;

export type CoreDropResultExprScanner<ctx> = (
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
) => {
  continues: boolean;
  result: CoreDropExprResult | undefined;
};

export function merge_expr_branches(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  branches: CoreDropExprBranchResult[],
  state: CoreDropState,
): boolean {
  const continuing_branches = branches.filter((branch) => branch.continues);

  if (continuing_branches.length === 0) {
    owners.clear();
    return false;
  }

  const parent_names = new Set(owners.keys());
  const kept_names = merge_expr_branch_parent_owners(
    owners,
    parent_names,
    continuing_branches,
  );
  drop_expr_branch_unmerged_owners(continuing_branches, kept_names, state);

  const result_branches = continuing_branches.filter((branch) => {
    return branch.result !== undefined;
  });

  if (result_branches.length > 0) {
    state.expr_results.set(expr, {
      tag: "branch",
      branches: result_branches,
    });
  } else {
    state.expr_results.set(expr, { tag: "none" });
  }

  return true;
}

export function emit_branch_result_drops(
  edge: CoreDropEdge,
  result: Extract<CoreDropExprResult, { tag: "branch" }>,
  state: CoreDropState,
): void {
  for (const branch of result.branches) {
    if (!branch.result) {
      continue;
    }

    emit_expr_result_drop(edge, branch.scope, branch.result, state);
  }
}

export function scan_drop_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
): boolean {
  const continues = scan_drop_expr_children(
    expr,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  if (!continues) {
    return false;
  }

  const expr_result = state.expr_results.get(expr);
  if (expr_result && expr_result.tag === "branch") {
    emit_branch_result_drops("discarded_expr", expr_result, state);
    return true;
  }

  if (expr_result && expr_result.tag === "none") {
    return true;
  }

  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);
  if (frozen_owner) {
    owners.delete(frozen_owner.name);
    return true;
  }

  if (expr.tag === "freeze") {
    return true;
  }

  const moved_owner = moved_expr_owner(expr, owners, state);
  if (moved_owner) {
    let owner_name: string | undefined;

    if (owners.has(moved_owner.name)) {
      owner_name = moved_owner.name;
    }

    emit_drop(
      "discarded_expr",
      scope,
      owner_name,
      moved_owner,
      state,
    );
    owners.delete(moved_owner.name);
    return true;
  }

  const ownership = unique_heap_ownership(expr, ctx, hooks);
  if (ownership) {
    emit_drop(
      "discarded_expr",
      scope,
      undefined,
      { name: "", ownership, pointer: "temporary" },
      state,
      expr,
    );
  }

  return true;
}

export function scan_drop_result_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
): {
  continues: boolean;
  result: CoreDropExprResult | undefined;
} {
  const continues = scan_drop_expr_children(
    expr,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );

  if (!continues) {
    return {
      continues: false,
      result: undefined,
    };
  }

  const expr_result = state.expr_results.get(expr);
  if (expr_result) {
    if (expr_result.tag === "none") {
      return {
        continues: true,
        result: undefined,
      };
    }

    const owner = simple_expr_result_owner(expr_result);
    if (owner) {
      owners.delete(owner.name);
    }

    return {
      continues: true,
      result: expr_result,
    };
  }

  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);

  if (frozen_owner) {
    owners.delete(frozen_owner.name);
    return {
      continues: true,
      result: undefined,
    };
  }

  if (expr.tag === "freeze") {
    return {
      continues: true,
      result: undefined,
    };
  }

  const moved_owner = moved_expr_owner(expr, owners, state);

  if (moved_owner) {
    owners.delete(moved_owner.name);
    return {
      continues: true,
      result: {
        tag: "owner",
        owner: moved_owner,
      },
    };
  }

  const ownership = unique_heap_ownership(expr, ctx, hooks);

  if (ownership) {
    return {
      continues: true,
      result: {
        tag: "owner",
        owner: {
          name: "",
          ownership,
          pointer: "temporary",
        },
      },
    };
  }

  return {
    continues: true,
    result: undefined,
  };
}

function merge_expr_branch_parent_owners(
  owners: Map<string, CoreDropOwner>,
  parent_names: Set<string>,
  branches: CoreDropExprBranchResult[],
): Set<string> {
  const kept_names = new Set<string>();

  for (const name of parent_names) {
    const branch_owners: CoreDropOwner[] = [];

    for (const branch of branches) {
      const owner = branch.owners.get(name);
      if (owner) {
        branch_owners.push(owner);
      }
    }

    if (branch_owners.length !== branches.length) {
      owners.delete(name);
      continue;
    }

    const last = branch_owners[branch_owners.length - 1];
    if (!last) {
      owners.delete(name);
      continue;
    }

    const merged: CoreDropOwner = {
      name: last.name,
      ownership: last.ownership,
      pointer: last.pointer,
    };
    for (const owner of branch_owners) {
      if (owner.pointer === "temporary") {
        merged.pointer = "temporary";
      }
    }
    const common_subject = branch_owners[0]?.subject;
    if (
      common_subject && branch_owners.every((owner) => {
        return owner.subject === common_subject;
      })
    ) {
      merged.subject = common_subject;
    }
    owners.set(name, merged);
    kept_names.add(name);
  }

  return kept_names;
}

function drop_expr_branch_unmerged_owners(
  branches: CoreDropExprBranchResult[],
  kept_names: Set<string>,
  state: CoreDropState,
): void {
  for (const branch of branches) {
    for (const [name, owner] of Array.from(branch.owners.entries())) {
      if (kept_names.has(name)) {
        continue;
      }

      emit_drop("scope_exit", branch.scope, owner.name, owner, state);
      branch.owners.delete(name);
    }
  }
}

function emit_expr_result_drop(
  edge: CoreDropEdge,
  scope: string,
  result: CoreDropExprResult,
  state: CoreDropState,
): void {
  if (result.tag === "branch") {
    emit_branch_result_drops(edge, result, state);
    return;
  }

  if (result.tag === "none") {
    return;
  }

  let owner_name: string | undefined;
  if (result.owner.name !== "") {
    owner_name = result.owner.name;
  }

  emit_drop(edge, scope, owner_name, result.owner, state);
}
