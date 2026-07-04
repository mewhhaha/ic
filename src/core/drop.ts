import type {
  Core,
  CoreExpr,
  CoreField,
  CoreFnType,
  CoreHostImport,
  CoreParam,
  CoreStmt,
} from "./ast.ts";
import { core_storage_class, type CoreStorageClass } from "./escape.ts";
import {
  core_host_import_for_app,
  type CoreHostImportCtx,
} from "./host_import.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";

export type CoreDropEdge =
  | "scope_exit"
  | "return_exit"
  | "break_exit"
  | "continue_exit"
  | "assignment_replace"
  | "discarded_expr";

export type CoreDropRuntime = "no_op_bump_allocator";

export type CoreUniqueHeapOwnership = Extract<
  CoreOwnership,
  { tag: "unique_heap" }
>;

export type CoreDropStep =
  | {
    tag: "heap_drop";
    id: string;
    edge: CoreDropEdge;
    scope: string;
    owner: string | undefined;
    ownership: CoreUniqueHeapOwnership;
    storage: CoreStorageClass;
    runtime: CoreDropRuntime;
    reason: string;
  }
  | {
    tag: "host_transfer";
    id: string;
    edge: "host_transfer";
    scope: string;
    callee: string;
    argument: number;
    owner: string | undefined;
    ownership: CoreUniqueHeapOwnership;
    storage: CoreStorageClass;
    runtime: "host_owned";
    reason: string;
  };

export type CoreDropPlan = {
  steps: CoreDropStep[];
};

type CoreDropOwner = {
  name: string;
  ownership: CoreUniqueHeapOwnership;
};

type CoreDropHooks<ctx> = Omit<CoreOwnershipHooks<ctx>, "if_let_branch_ctx"> & {
  block_ctx: (ctx: ctx) => ctx;
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
  collection_loop_body_ctx?: (
    stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
    ctx: ctx,
  ) => CoreDropLoopBodyCtx<ctx>;
  if_let_branch_ctx?: (
    case_name: string,
    value_name: string | undefined,
    target: CoreExpr,
    ctx: ctx,
  ) => CoreDropIfLetBranchCtx<ctx>;
  collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
};

type CoreDropIfLetBranchCtx<ctx> =
  | { tag: "scan"; ctx: ctx }
  | { tag: "skip" }
  | { tag: "unknown" };

type CoreDropLoopBodyCtx<ctx> =
  | { tag: "scan"; ctx: ctx }
  | { tag: "skip" };

type CoreDropState = {
  next_drop: number;
  next_transfer: number;
  next_block: number;
  next_closure: number;
  next_loop: number;
  final_escape: CoreDropFinalEscape;
  steps: CoreDropStep[];
  expr_results: Map<CoreExpr, CoreDropExprResult>;
  functions: Map<string, StaticDropFunction>;
  aliases: Map<string, string>;
  temporary_aliases: Map<string, CoreUniqueHeapOwnership>;
  active_functions: Set<string>;
};

type CoreDropFinalEscape = "typed" | "named_only";

type CoreDropExitOwners = {
  return_owners: CoreDropOwner[];
  break_owners: CoreDropOwner[];
  continue_owners: CoreDropOwner[];
};

type CoreDropBranchResult = {
  continues: boolean;
  owners: Map<string, CoreDropOwner>;
};

type CoreDropExprResult =
  | { tag: "none" }
  | { tag: "owner"; owner: CoreDropOwner }
  | { tag: "branch"; branches: CoreDropExprBranchResult[] };

type CoreDropExprBranchResult = {
  scope: string;
  continues: boolean;
  owners: Map<string, CoreDropOwner>;
  result: CoreDropExprResult | undefined;
};

type StaticDropCallTransferBody =
  | { tag: "expr"; expr: CoreExpr; scope_suffix: string }
  | { tag: "block"; statements: CoreStmt[]; scope_suffix: string };

type StaticDropFunction =
  | { tag: "lam"; value: Extract<CoreExpr, { tag: "lam" }> }
  | { tag: "rec"; value: Extract<CoreExpr, { tag: "rec" }> }
  | {
    tag: "branch";
    kind: "if" | "if_let";
    then_target: StaticDropFunction;
    else_target: StaticDropFunction;
  };

type StaticDropCallBinding =
  | { tag: "owner"; owner: string }
  | { tag: "temporary"; ownership: CoreUniqueHeapOwnership };

export function core_drop_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreDropPlan {
  const state: CoreDropState = {
    next_drop: 0,
    next_transfer: 0,
    next_block: 0,
    next_closure: 0,
    next_loop: 0,
    final_escape: "typed",
    steps: [],
    expr_results: new Map(),
    functions: top_level_drop_functions(core),
    aliases: new Map(),
    temporary_aliases: new Map(),
    active_functions: new Set(),
  };
  const owners = new Map<string, CoreDropOwner>();

  scan_drop_stmts(
    core.statements,
    "program#0",
    owners,
    empty_exit_owners(),
    ctx,
    hooks,
    state,
  );

  return { steps: state.steps };
}

function scan_drop_stmts<ctx>(
  statements: CoreStmt[],
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  drop_fallthrough_owners = true,
): boolean {
  const previous_functions = state.functions;
  state.functions = new Map(previous_functions);

  try {
    for (let index = 0; index < statements.length; index += 1) {
      const stmt = statements[index];

      if (index + 1 >= statements.length) {
        return scan_final_drop_stmt(
          stmt,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
          drop_fallthrough_owners,
        );
      }

      const continues = scan_drop_stmt(
        stmt,
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

      try {
        hooks.collect_stmt_locals(stmt, ctx);
      } catch (error) {
        if (!drop_unknown_host_boundary_probe_error(error)) {
          throw error;
        }
      }
    }

    if (drop_fallthrough_owners) {
      drop_scope_owners(scope, owners, state);
    }

    return true;
  } finally {
    state.functions = previous_functions;
  }
}

function scan_final_drop_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  drop_fallthrough_owners: boolean,
): boolean {
  if (stmt.tag === "expr") {
    const continues = scan_drop_expr_children(
      stmt.expr,
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

    mark_final_expr_escape(stmt.expr, owners, ctx, hooks, state);
    if (drop_fallthrough_owners) {
      drop_scope_owners(scope, owners, state);
    }

    return true;
  }

  if (stmt.tag === "return") {
    const continues = scan_drop_expr_children(
      stmt.value,
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

    mark_final_expr_escape(stmt.value, owners, ctx, hooks, state);
    drop_exit_owners(
      "return_exit",
      scope,
      owners,
      exit_owners.return_owners,
      returned_owner_name(stmt.value),
      state,
    );
    return false;
  }

  const continues = scan_drop_stmt(
    stmt,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );

  if (continues) {
    if (drop_fallthrough_owners) {
      drop_scope_owners(scope, owners, state);
    }
  }

  return continues;
}

function scan_drop_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  switch (stmt.tag) {
    case "bind": {
      scan_drop_expr_children(
        stmt.value,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

      const previous = owners.get(stmt.name);
      if (previous) {
        emit_drop("assignment_replace", scope, previous.name, previous, state);
        owners.delete(stmt.name);
      }

      if (
        should_skip_drop_owner_bind(
          stmt.kind,
          stmt.name,
          stmt.value,
          ctx,
          hooks,
        )
      ) {
        owners.delete(stmt.name);
        bind_static_drop_function(stmt.name, stmt.value, state);
        return true;
      }

      bind_drop_owner(stmt.name, stmt.value, owners, ctx, hooks, state);
      bind_static_drop_function(stmt.name, stmt.value, state);
      return true;
    }

    case "assign": {
      const previous = owners.get(stmt.name);
      if (
        previous &&
        !expr_consumes_owner_name(stmt.value, stmt.name, owners, state)
      ) {
        emit_drop("assignment_replace", scope, previous.name, previous, state);
        owners.delete(stmt.name);
      }

      scan_drop_expr_children(
        stmt.value,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      if (should_skip_drop_owner_assign(stmt.name, stmt.value, ctx, hooks)) {
        owners.delete(stmt.name);
        bind_static_drop_function(stmt.name, stmt.value, state);
        return true;
      }

      bind_drop_owner(stmt.name, stmt.value, owners, ctx, hooks, state);
      bind_static_drop_function(stmt.name, stmt.value, state);
      return true;
    }

    case "index_assign":
      scan_drop_expr_children(
        stmt.index,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      scan_drop_expr_children(
        stmt.value,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      return true;

    case "range_loop": {
      scan_drop_expr_children(
        stmt.start,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      scan_drop_expr_children(
        stmt.end,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      scan_drop_expr_children(
        stmt.step,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      const loop_scope = next_loop_scope(state);
      const loop_owners = new Map<string, CoreDropOwner>();
      scan_drop_stmts(
        stmt.body,
        loop_scope,
        loop_owners,
        loop_exit_owners(owners, exit_owners),
        ctx,
        hooks,
        state,
      );
      return true;
    }

    case "collection_loop": {
      scan_drop_expr_children(
        stmt.collection,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      const body_ctx = drop_collection_loop_body_ctx(stmt, ctx, hooks);
      if (body_ctx.tag === "skip") {
        return true;
      }

      const loop_scope = next_loop_scope(state);
      const loop_owners = new Map<string, CoreDropOwner>();
      scan_drop_stmts(
        stmt.body,
        loop_scope,
        loop_owners,
        loop_exit_owners(owners, exit_owners),
        body_ctx.ctx,
        hooks,
        state,
      );
      return true;
    }

    case "if_stmt": {
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
      );
      merge_if_stmt_branch_owners(owners, branch);
      return true;
    }

    case "if_else_stmt": {
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
      );

      if (then_branch.continues || else_branch.continues) {
        merge_if_else_branch_owners(owners, [then_branch, else_branch]);
        return true;
      }

      owners.clear();
      return false;
    }

    case "if_let_stmt": {
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

      const branch_ctx = drop_if_let_branch_ctx(
        stmt.case_name,
        stmt.value_name,
        stmt.target,
        ctx,
        hooks,
      );
      if (branch_ctx.tag === "skip") {
        return true;
      }

      const block_scope = next_block_scope(state);
      const branch = scan_drop_branch_stmts(
        stmt.body,
        block_scope,
        owners,
        exit_owners,
        branch_ctx.ctx,
        hooks,
        state,
      );
      merge_if_stmt_branch_owners(owners, branch);
      return true;
    }

    case "type_check": {
      const continues = scan_drop_expr_children(
        stmt.target,
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

      return true;
    }

    case "return": {
      const continues = scan_drop_expr_children(
        stmt.value,
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

      mark_final_expr_escape(stmt.value, owners, ctx, hooks, state);
      drop_exit_owners(
        "return_exit",
        scope,
        owners,
        exit_owners.return_owners,
        returned_owner_name(stmt.value),
        state,
      );
      return false;
    }

    case "expr":
      return scan_drop_expr(
        stmt.expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "break":
      drop_exit_owners(
        "break_exit",
        scope,
        owners,
        exit_owners.break_owners,
        undefined,
        state,
      );
      return false;

    case "continue":
      drop_exit_owners(
        "continue_exit",
        scope,
        owners,
        exit_owners.continue_owners,
        undefined,
        state,
      );
      return false;

    case "unsupported":
      return true;
  }
}

function scan_drop_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
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
      { name: "", ownership },
      state,
    );
  }

  return true;
}

function scan_drop_expr_children<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return true;

    case "lam":
    case "rec":
      return scan_drop_closure_body(
        expr,
        ctx,
        hooks,
        state,
      );

    case "prim":
      for (const arg of expr.args) {
        const continues = scan_drop_expr_children(
          arg,
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
      }
      return true;

    case "app":
      {
        const continues = scan_drop_expr_children(
          expr.func,
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
      }
      for (const arg of expr.args) {
        const continues = scan_drop_expr_children(
          arg,
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
      }
      consume_host_transfer_args(expr, scope, owners, ctx, hooks, state);
      consume_static_host_transfer_call(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
      consume_runtime_union_payload_owner(expr, owners, ctx, hooks, state);
      return true;

    case "block": {
      return scan_drop_block_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
    }

    case "comptime":
      return scan_drop_expr_children(
        expr.expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "borrow":
    case "freeze":
      return scan_drop_expr_children(
        expr.value,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "scratch":
      return scan_drop_expr_children(
        expr.body,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "with":
      if (
        !scan_drop_expr_children(
          expr.base,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_fields(
        expr.fields,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "struct_value":
      if (
        !scan_drop_expr_children(
          expr.type_expr,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_fields(
        expr.fields,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "struct_update":
      if (
        !scan_drop_expr_children(
          expr.base,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_fields(
        expr.fields,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "if": {
      return scan_drop_if_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
    }

    case "if_let": {
      return scan_drop_if_let_expr(
        expr,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );
    }

    case "field":
      return scan_drop_expr_children(
        expr.object,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "index":
      if (
        !scan_drop_expr_children(
          expr.object,
          scope,
          owners,
          exit_owners,
          ctx,
          hooks,
          state,
        )
      ) {
        return false;
      }
      return scan_drop_expr_children(
        expr.index,
        scope,
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      );

    case "union_case":
      if (expr.value) {
        const continues = scan_drop_expr_children(
          expr.value,
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
      }

      if (expr.type_expr) {
        const continues = scan_drop_expr_children(
          expr.type_expr,
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
      }

      consume_runtime_union_payload_owner(expr, owners, ctx, hooks, state);
      return true;
  }
}

function scan_drop_fields<ctx>(
  fields: CoreField[],
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  for (const field of fields) {
    const continues = scan_drop_expr_children(
      field.value,
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
  }

  return true;
}

function scan_drop_if_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  const cond_continues = scan_drop_expr_children(
    expr.cond,
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

  const then_branch = scan_drop_expr_branch_result(
    expr.then_branch,
    next_block_scope(state),
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  const else_branch = scan_drop_expr_branch_result(
    expr.else_branch,
    next_block_scope(state),
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );

  return merge_expr_branches(
    expr,
    owners,
    [then_branch, else_branch],
    state,
  );
}

function scan_drop_if_let_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  const target_continues = scan_drop_expr_children(
    expr.target,
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

  const branch_ctx = drop_if_let_branch_ctx(
    expr.case_name,
    expr.value_name,
    expr.target,
    ctx,
    hooks,
  );
  let branches: CoreDropExprBranchResult[];

  if (branch_ctx.tag === "skip") {
    branches = [
      scan_drop_expr_branch_result(
        expr.else_branch,
        next_block_scope(state),
        owners,
        exit_owners,
        ctx,
        hooks,
        state,
      ),
    ];
  } else {
    const then_branch = scan_drop_expr_branch_result(
      expr.then_branch,
      next_block_scope(state),
      owners,
      exit_owners,
      branch_ctx.ctx,
      hooks,
      state,
    );
    const else_branch = scan_drop_expr_branch_result(
      expr.else_branch,
      next_block_scope(state),
      owners,
      exit_owners,
      ctx,
      hooks,
      state,
    );
    branches = [then_branch, else_branch];
  }

  return merge_expr_branches(
    expr,
    owners,
    branches,
    state,
  );
}

function drop_if_let_branch_ctx<ctx>(
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): { tag: "scan"; ctx: ctx } | { tag: "skip" } {
  if (!hooks.if_let_branch_ctx) {
    return { tag: "scan", ctx };
  }

  const branch_ctx = hooks.if_let_branch_ctx(
    case_name,
    value_name,
    target,
    ctx,
  );

  if (branch_ctx.tag === "skip") {
    return branch_ctx;
  }

  if (branch_ctx.tag === "scan") {
    return branch_ctx;
  }

  return { tag: "scan", ctx };
}

function scan_drop_expr_branch_result<ctx>(
  expr: CoreExpr,
  scope: string,
  parent_owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): CoreDropExprBranchResult {
  const owners = clone_drop_owners(parent_owners);
  const result = scan_drop_result_expr(
    expr,
    scope,
    owners,
    child_exit_owners(parent_owners, exit_owners),
    ctx,
    hooks,
    state,
  );

  return {
    scope,
    continues: result.continues,
    owners,
    result: result.result,
  };
}

function scan_drop_result_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
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
        },
      },
    };
  }

  return {
    continues: true,
    result: undefined,
  };
}

function merge_expr_branches(
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

function merge_expr_branch_parent_owners(
  owners: Map<string, CoreDropOwner>,
  parent_names: Set<string>,
  branches: CoreDropExprBranchResult[],
): Set<string> {
  const kept_names = new Set<string>();

  for (const name of parent_names) {
    let merged: CoreDropOwner | undefined;
    let present_in_all_branches = true;

    for (const branch of branches) {
      const owner = branch.owners.get(name);
      if (owner) {
        merged = owner;
      } else {
        present_in_all_branches = false;
      }
    }

    if (present_in_all_branches && merged) {
      owners.set(name, merged);
      kept_names.add(name);
    } else {
      owners.delete(name);
    }
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

function emit_branch_result_drops(
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

function scan_drop_block_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "block" }>,
  _scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  const block_scope = next_block_scope(state);
  const parent_names = new Set(owners.keys());
  const block_owners = clone_drop_owners(owners);
  const block_ctx = hooks.block_ctx(ctx);
  const statements = expr.statements;
  let result: CoreDropExprResult | undefined;

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core drop block statement " + index.toString());
    }

    const is_final = index + 1 >= statements.length;

    if (!is_final) {
      const continues = scan_drop_stmt(
        stmt,
        block_scope,
        block_owners,
        child_exit_owners(block_owners, exit_owners),
        block_ctx,
        hooks,
        state,
      );

      if (!continues) {
        return false;
      }

      hooks.collect_stmt_locals(stmt, block_ctx);
      continue;
    }

    const final = scan_drop_block_final_stmt(
      stmt,
      block_scope,
      block_owners,
      child_exit_owners(block_owners, exit_owners),
      block_ctx,
      hooks,
      state,
    );

    if (!final.continues) {
      return false;
    }

    result = final.result;
  }

  drop_block_local_owners(block_scope, block_owners, parent_names, state);
  merge_block_parent_owners(
    owners,
    block_owners,
    parent_names,
    simple_expr_result_owner(result),
  );

  if (result) {
    state.expr_results.set(expr, result);
  } else {
    state.expr_results.set(expr, { tag: "none" });
  }

  return true;
}

function scan_drop_block_final_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): {
  continues: boolean;
  result: CoreDropExprResult | undefined;
} {
  if (stmt.tag === "expr") {
    return scan_drop_result_expr(
      stmt.expr,
      scope,
      owners,
      exit_owners,
      ctx,
      hooks,
      state,
    );
  }

  if (stmt.tag === "return") {
    const continues = scan_drop_stmt(
      stmt,
      scope,
      owners,
      exit_owners,
      ctx,
      hooks,
      state,
    );
    return {
      continues,
      result: undefined,
    };
  }

  const continues = scan_drop_stmt(
    stmt,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  return {
    continues,
    result: undefined,
  };
}

function drop_block_local_owners(
  scope: string,
  block_owners: Map<string, CoreDropOwner>,
  parent_names: Set<string>,
  state: CoreDropState,
): void {
  for (const [name, owner] of Array.from(block_owners.entries())) {
    if (parent_names.has(name)) {
      continue;
    }

    emit_drop("scope_exit", scope, owner.name, owner, state);
    block_owners.delete(name);
  }
}

function merge_block_parent_owners(
  owners: Map<string, CoreDropOwner>,
  block_owners: Map<string, CoreDropOwner>,
  parent_names: Set<string>,
  result_owner: CoreDropOwner | undefined,
): void {
  for (const name of parent_names) {
    if (result_owner && result_owner.name === name) {
      continue;
    }

    const owner = block_owners.get(name);

    if (owner) {
      owners.set(name, owner);
    } else {
      owners.delete(name);
    }
  }
}

function scan_drop_closure_body<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  for (const param of expr.params) {
    if (param.is_const) {
      return true;
    }
  }

  let body_ctx = ctx;

  if (hooks.closure_body_ctx) {
    const scoped_ctx = hooks.closure_body_ctx(expr, ctx);

    if (!scoped_ctx) {
      return true;
    }

    body_ctx = scoped_ctx;
  }

  const scope = next_closure_scope(state);
  const owners = new Map<string, CoreDropOwner>();
  const previous_final_escape = state.final_escape;
  state.final_escape = "named_only";

  try {
    return scan_drop_closure_body_expr(
      expr.body,
      scope,
      owners,
      body_ctx,
      hooks,
      state,
    );
  } finally {
    state.final_escape = previous_final_escape;
  }
}

function scan_drop_closure_body_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  if (expr.tag === "block") {
    return scan_drop_stmts(
      expr.statements,
      scope,
      owners,
      empty_exit_owners(),
      ctx,
      hooks,
      state,
    );
  }

  const continues = scan_drop_expr_children(
    expr,
    scope,
    owners,
    empty_exit_owners(),
    ctx,
    hooks,
    state,
  );

  if (!continues) {
    return false;
  }

  mark_final_expr_escape(expr, owners, ctx, hooks, state);
  drop_scope_owners(scope, owners, state);
  return true;
}

function drop_collection_loop_body_ctx<ctx>(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreDropLoopBodyCtx<ctx> {
  if (!hooks.collection_loop_body_ctx) {
    return { tag: "scan", ctx };
  }

  return hooks.collection_loop_body_ctx(stmt, ctx);
}

function scan_drop_branch_stmts<ctx>(
  statements: CoreStmt[],
  scope: string,
  parent_owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): CoreDropBranchResult {
  const branch_owners = clone_drop_owners(parent_owners);
  const continues = scan_drop_stmts(
    statements,
    scope,
    branch_owners,
    child_exit_owners(parent_owners, exit_owners),
    ctx,
    hooks,
    state,
    false,
  );

  if (continues) {
    drop_branch_local_owners(scope, branch_owners, parent_owners, state);
  }

  return {
    continues,
    owners: branch_owners,
  };
}

function merge_if_stmt_branch_owners(
  owners: Map<string, CoreDropOwner>,
  branch: CoreDropBranchResult,
): void {
  if (!branch.continues) {
    return;
  }

  for (const name of Array.from(owners.keys())) {
    const owner = branch.owners.get(name);

    if (owner) {
      owners.set(name, owner);
    }
  }
}

function merge_if_else_branch_owners(
  owners: Map<string, CoreDropOwner>,
  branches: CoreDropBranchResult[],
): void {
  for (const name of Array.from(owners.keys())) {
    let merged: CoreDropOwner | undefined;

    for (const branch of branches) {
      if (!branch.continues) {
        continue;
      }

      const owner = branch.owners.get(name);
      if (owner) {
        merged = owner;
      }
    }

    if (merged) {
      owners.set(name, merged);
    } else {
      owners.delete(name);
    }
  }
}

function drop_branch_local_owners(
  scope: string,
  branch_owners: Map<string, CoreDropOwner>,
  parent_owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): void {
  for (const [name, owner] of Array.from(branch_owners.entries())) {
    if (parent_owners.has(name)) {
      continue;
    }

    emit_drop("scope_exit", scope, owner.name, owner, state);
    branch_owners.delete(name);
  }
}

function clone_drop_owners(
  owners: Map<string, CoreDropOwner>,
): Map<string, CoreDropOwner> {
  const cloned = new Map<string, CoreDropOwner>();

  for (const [name, owner] of owners) {
    cloned.set(name, {
      name: owner.name,
      ownership: owner.ownership,
    });
  }

  return cloned;
}

function bind_drop_owner<ctx>(
  name: string,
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const expr_result = state.expr_results.get(expr);
  if (expr_result && expr_result.tag === "branch") {
    const ownership = unique_heap_ownership(expr, ctx, hooks);
    if (ownership) {
      owners.set(name, { name, ownership });
      return;
    }

    owners.delete(name);
    return;
  }

  if (expr_result && expr_result.tag === "none") {
    owners.delete(name);
    return;
  }

  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);

  if (frozen_owner) {
    owners.delete(frozen_owner.name);
    owners.delete(name);
    return;
  }

  if (expr.tag === "freeze") {
    owners.delete(name);
    return;
  }

  const moved_owner = moved_expr_owner(expr, owners, state);

  if (moved_owner) {
    owners.delete(moved_owner.name);
    owners.set(name, {
      name,
      ownership: moved_owner.ownership,
    });
    return;
  }

  const ownership = unique_heap_ownership(expr, ctx, hooks);

  if (ownership) {
    owners.set(name, { name, ownership });
    return;
  }

  owners.delete(name);
}

function should_skip_drop_owner_bind<ctx>(
  kind: "let" | "const",
  name: string,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  const static_value = drop_static_value(expr, ctx, hooks);

  if (!static_value) {
    return false;
  }

  if (kind === "const") {
    return true;
  }

  if (is_drop_static_ownerless_value(static_value)) {
    return true;
  }

  if (is_scoped_static_drop_helper(name, static_value, ctx, hooks)) {
    return true;
  }

  return is_drop_static_non_runtime_closure(static_value, ctx, hooks);
}

function should_skip_drop_owner_assign<ctx>(
  name: string,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  const static_value = drop_static_value(expr, ctx, hooks);

  if (!static_value) {
    return false;
  }

  if (is_drop_static_ownerless_value(static_value)) {
    return true;
  }

  if (is_scoped_static_drop_helper(name, static_value, ctx, hooks)) {
    return true;
  }

  return is_drop_static_non_runtime_closure(static_value, ctx, hooks);
}

function drop_static_value<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreExpr | undefined {
  if (!hooks.static_value) {
    return undefined;
  }

  return hooks.static_value(expr, ctx);
}

function is_drop_static_type_value(expr: CoreExpr): boolean {
  if (expr.tag === "type_name") {
    return true;
  }

  if (expr.tag === "struct_type") {
    return true;
  }

  if (expr.tag === "union_type") {
    return true;
  }

  return false;
}

function is_drop_static_ownerless_value(expr: CoreExpr): boolean {
  if (is_drop_static_type_value(expr)) {
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

function is_scoped_static_drop_helper<ctx>(
  name: string,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  if (!hooks.static_core_call_target) {
    return false;
  }

  if (!hooks.static_core_call_requires_scope) {
    return false;
  }

  if (expr.tag !== "lam") {
    return false;
  }

  const target = hooks.static_core_call_target(
    { tag: "var", name },
    ctx,
  );

  if (!target) {
    return false;
  }

  if (target !== expr) {
    return false;
  }

  return hooks.static_core_call_requires_scope(target);
}

function is_drop_static_non_runtime_closure<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  if (expr.tag === "rec") {
    return true;
  }

  if (expr.tag !== "lam") {
    return false;
  }

  let fn_type: CoreFnType | undefined;

  try {
    fn_type = hooks.closure_fn_type(expr, ctx);
  } catch (error) {
    if (drop_closure_probe_error(error)) {
      return true;
    }

    throw error;
  }

  if (fn_type) {
    return false;
  }

  return true;
}

function drop_closure_probe_error(error: unknown): boolean {
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

function moved_named_owner(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): CoreDropOwner | undefined {
  if (expr.tag !== "var") {
    return undefined;
  }

  const temporary = state.temporary_aliases.get(expr.name);

  if (temporary) {
    return { name: "", ownership: temporary };
  }

  return owners.get(resolve_drop_owner(expr.name, state));
}

function simple_expr_result_owner(
  result: CoreDropExprResult | undefined,
): CoreDropOwner | undefined {
  if (!result) {
    return undefined;
  }

  if (result.tag !== "owner") {
    return undefined;
  }

  return result.owner;
}

function moved_expr_owner(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): CoreDropOwner | undefined {
  const direct = moved_named_owner(expr, owners, state);

  if (direct) {
    return direct;
  }

  return simple_expr_result_owner(state.expr_results.get(expr));
}

function consume_runtime_union_payload_owner<ctx>(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const runtime_value = hooks.runtime_union_value(expr, ctx);
  if (!runtime_value) {
    return;
  }

  if (runtime_value.tag !== "union_case") {
    return;
  }

  if (!runtime_value.value) {
    return;
  }

  const union_ownership = unique_heap_ownership(expr, ctx, hooks);
  if (!union_ownership) {
    return;
  }

  if (union_ownership.reason !== "runtime_union") {
    return;
  }

  const moved_owner = moved_expr_owner(runtime_value.value, owners, state);
  if (!moved_owner) {
    return;
  }

  if (
    moved_owner.ownership.reason !== "runtime_aggregate" &&
    moved_owner.ownership.reason !== "runtime_union"
  ) {
    return;
  }

  owners.delete(moved_owner.name);
}

function expr_consumes_owner_name(
  expr: CoreExpr,
  name: string,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): boolean {
  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);

  if (frozen_owner && frozen_owner.name === name) {
    return true;
  }

  const moved_owner = moved_expr_owner(expr, owners, state);

  if (moved_owner && moved_owner.name === name) {
    return true;
  }

  return false;
}

function frozen_expr_consumed_owner(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): CoreDropOwner | undefined {
  if (expr.tag !== "freeze") {
    return undefined;
  }

  return moved_expr_owner(expr.value, owners, state);
}

function mark_final_expr_escape<ctx>(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const expr_result = state.expr_results.get(expr);
  if (expr_result && expr_result.tag === "branch") {
    return;
  }

  if (expr_result && expr_result.tag === "none") {
    return;
  }

  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);

  if (frozen_owner) {
    owners.delete(frozen_owner.name);
    return;
  }

  if (expr.tag === "freeze") {
    return;
  }

  const moved_owner = moved_expr_owner(expr, owners, state);

  if (moved_owner) {
    owners.delete(moved_owner.name);
    return;
  }

  if (mark_named_final_owner_escape(expr, owners)) {
    return;
  }

  if (state.final_escape === "named_only") {
    return;
  }

  unique_heap_ownership(expr, ctx, hooks);
}

function mark_named_final_owner_escape(
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
): boolean {
  if (expr.tag !== "var") {
    return false;
  }

  if (!owners.has(expr.name)) {
    return false;
  }

  owners.delete(expr.name);
  return true;
}

function consume_host_transfer_args<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const host_import = drop_host_import_for_app(expr, ctx);

  if (!host_import) {
    return;
  }

  for (let index = 0; index < expr.args.length; index += 1) {
    const contract = host_import.args[index];

    if (!contract) {
      continue;
    }

    if (contract.tag !== "ownership_transfer") {
      continue;
    }

    const arg = expr.args[index];
    if (!arg) {
      throw new Error("Missing host transfer argument " + index.toString());
    }

    const owner = moved_expr_owner(arg, owners, state);

    if (owner) {
      let owner_name: string | undefined;

      if (owner.name.length > 0) {
        owner_name = owner.name;
        owners.delete(owner.name);
      }

      emit_host_transfer(
        scope,
        host_import.name,
        index,
        owner_name,
        owner.ownership,
        state,
      );
      continue;
    }

    if (arg.tag === "var") {
      continue;
    }

    const ownership = unique_heap_ownership(arg, ctx, hooks);

    if (!ownership) {
      continue;
    }

    emit_host_transfer(
      scope,
      host_import.name,
      index,
      undefined,
      ownership,
      state,
    );
  }
}

function consume_static_host_transfer_call<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  if (expr.func.tag !== "var") {
    return;
  }

  const name = expr.func.name;
  const target = state.functions.get(name);

  if (!target) {
    return;
  }

  if (state.active_functions.has(name)) {
    return;
  }

  const bindings = static_drop_call_bindings(
    target,
    expr.args,
    ctx,
    hooks,
    state,
  );

  if (!bindings) {
    return;
  }

  const function_aliases = static_drop_call_function_aliases(
    target,
    expr.args,
    state,
  );
  const previous_aliases = state.aliases;
  const previous_temporary_aliases = state.temporary_aliases;
  const previous_functions = state.functions;
  state.aliases = new Map(previous_aliases);
  state.temporary_aliases = new Map(previous_temporary_aliases);
  state.functions = new Map(previous_functions);

  for (const entry of bindings.entries()) {
    if (entry[1].tag === "owner") {
      state.aliases.set(entry[0], entry[1].owner);
    } else {
      state.temporary_aliases.set(entry[0], entry[1].ownership);
    }
  }

  for (const entry of function_aliases.entries()) {
    state.functions.set(entry[0], entry[1]);
  }

  state.active_functions.add(name);

  try {
    scan_static_drop_transfer_target(
      target,
      scope + "/static_call/" + name,
      owners,
      ctx,
      hooks,
      state,
    );
  } finally {
    state.active_functions.delete(name);
    state.aliases = previous_aliases;
    state.temporary_aliases = previous_temporary_aliases;
    state.functions = previous_functions;
  }
}

function scan_static_drop_transfer_target<ctx>(
  target: StaticDropFunction,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  if (target.tag === "lam" || target.tag === "rec") {
    const body = static_drop_call_transfer_body(target.value.body);

    if (!body) {
      return;
    }

    if (static_drop_call_transfer_body_returns_closure(body)) {
      return;
    }

    const body_scope = scope + body.scope_suffix;
    let body_ctx = ctx;

    if (hooks.closure_body_ctx) {
      const scoped_ctx = hooks.closure_body_ctx(target.value, ctx);

      if (scoped_ctx) {
        body_ctx = scoped_ctx;
      }
    }

    if (body.tag === "expr") {
      scan_static_drop_transfer_expr(
        body.expr,
        body_scope,
        owners,
        body_ctx,
        hooks,
        state,
      );
    } else {
      scan_static_drop_transfer_stmts(
        body.statements,
        body_scope,
        owners,
        body_ctx,
        hooks,
        state,
      );
    }
    return;
  }

  const then_owners = clone_drop_owners(owners);
  scan_static_drop_transfer_target(
    target.then_target,
    scope + "/" + target.kind + "_then",
    then_owners,
    ctx,
    hooks,
    state,
  );

  const else_owners = clone_drop_owners(owners);
  scan_static_drop_transfer_target(
    target.else_target,
    scope + "/" + target.kind + "_else",
    else_owners,
    ctx,
    hooks,
    state,
  );

  merge_if_else_branch_owners(owners, [
    {
      continues: true,
      owners: then_owners,
    },
    {
      continues: true,
      owners: else_owners,
    },
  ]);
}

function static_drop_call_transfer_body(
  body: CoreExpr,
): StaticDropCallTransferBody | undefined {
  if (body.tag !== "block") {
    return { tag: "expr", expr: body, scope_suffix: "" };
  }

  return { tag: "block", statements: body.statements, scope_suffix: "/block" };
}

function scan_static_drop_transfer_stmts<ctx>(
  statements: CoreStmt[],
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  for (const stmt of statements) {
    scan_static_drop_transfer_stmt(stmt, scope, owners, ctx, hooks, state);
  }
}

function scan_static_drop_transfer_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  switch (stmt.tag) {
    case "bind":
      scan_static_drop_transfer_expr(
        stmt.value,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      bind_static_drop_function(stmt.name, stmt.value, state);
      return;

    case "assign":
      scan_static_drop_transfer_expr(
        stmt.value,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      bind_static_drop_function(stmt.name, stmt.value, state);
      return;

    case "index_assign":
      scan_static_drop_transfer_expr(
        stmt.index,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        stmt.value,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "range_loop":
      scan_static_drop_transfer_expr(
        stmt.start,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        stmt.end,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        stmt.step,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "collection_loop":
      scan_static_drop_transfer_expr(
        stmt.collection,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "if_stmt":
      scan_static_drop_transfer_expr(
        stmt.cond,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "if_else_stmt":
      scan_static_drop_transfer_expr(
        stmt.cond,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.then_body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.else_body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "if_let_stmt":
      scan_static_drop_transfer_expr(
        stmt.target,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_stmts(
        stmt.body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "type_check":
      scan_static_drop_transfer_expr(
        stmt.target,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "return":
      scan_static_drop_transfer_expr(
        stmt.value,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "expr":
      scan_static_drop_transfer_expr(
        stmt.expr,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_static_drop_transfer_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "lam":
    case "rec":
    case "unsupported":
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_static_drop_transfer_expr(arg, scope, owners, ctx, hooks, state);
      }
      return;

    case "app":
      scan_static_drop_transfer_expr(
        expr.func,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      for (const arg of expr.args) {
        scan_static_drop_transfer_expr(arg, scope, owners, ctx, hooks, state);
      }
      consume_host_transfer_args(expr, scope, owners, ctx, hooks, state);
      consume_static_host_transfer_call(
        expr,
        scope,
        owners,
        empty_exit_owners(),
        ctx,
        hooks,
        state,
      );
      return;

    case "block":
      scan_static_drop_transfer_stmts(
        expr.statements,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "comptime":
      scan_static_drop_transfer_expr(
        expr.expr,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "borrow":
    case "freeze":
      scan_static_drop_transfer_expr(
        expr.value,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "scratch":
      scan_static_drop_transfer_expr(
        expr.body,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "with":
      scan_static_drop_transfer_expr(
        expr.base,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      for (const field of expr.fields) {
        scan_static_drop_transfer_expr(
          field.value,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      return;

    case "struct_value":
      scan_static_drop_transfer_expr(
        expr.type_expr,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      for (const field of expr.fields) {
        scan_static_drop_transfer_expr(
          field.value,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      return;

    case "struct_update":
      scan_static_drop_transfer_expr(
        expr.base,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      for (const field of expr.fields) {
        scan_static_drop_transfer_expr(
          field.value,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      return;

    case "if":
      scan_static_drop_transfer_expr(
        expr.cond,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        expr.then_branch,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        expr.else_branch,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "if_let":
      scan_static_drop_transfer_expr(
        expr.target,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        expr.then_branch,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        expr.else_branch,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "field":
      scan_static_drop_transfer_expr(
        expr.object,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "index":
      scan_static_drop_transfer_expr(
        expr.object,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      scan_static_drop_transfer_expr(
        expr.index,
        scope,
        owners,
        ctx,
        hooks,
        state,
      );
      return;

    case "union_case":
      if (expr.value) {
        scan_static_drop_transfer_expr(
          expr.value,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      if (expr.type_expr) {
        scan_static_drop_transfer_expr(
          expr.type_expr,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      return;
  }
}

function static_drop_call_transfer_body_returns_closure(
  body: StaticDropCallTransferBody,
): boolean {
  if (body.tag === "expr") {
    return static_drop_transfer_body_returns_closure(body.expr);
  }

  if (body.statements.length === 0) {
    return false;
  }

  const stmt = body.statements[body.statements.length - 1];

  if (!stmt) {
    throw new Error("Missing static drop call closure block result");
  }

  if (stmt.tag === "expr") {
    return static_drop_transfer_body_returns_closure(stmt.expr);
  }

  if (stmt.tag === "return") {
    return static_drop_transfer_body_returns_closure(stmt.value);
  }

  return false;
}

function static_drop_transfer_body_returns_closure(expr: CoreExpr): boolean {
  if (expr.tag === "lam") {
    return true;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return static_drop_transfer_body_returns_closure(expr.value);
  }

  if (expr.tag === "block") {
    if (expr.statements.length === 0) {
      return false;
    }

    const stmt = expr.statements[expr.statements.length - 1];

    if (!stmt) {
      throw new Error("Missing static drop call closure block result");
    }

    if (stmt.tag === "expr") {
      return static_drop_transfer_body_returns_closure(stmt.expr);
    }

    if (stmt.tag === "return") {
      return static_drop_transfer_body_returns_closure(stmt.value);
    }

    return false;
  }

  if (expr.tag === "if") {
    return static_drop_transfer_body_returns_closure(expr.then_branch) &&
      static_drop_transfer_body_returns_closure(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return static_drop_transfer_body_returns_closure(expr.then_branch) &&
      static_drop_transfer_body_returns_closure(expr.else_branch);
  }

  return false;
}

function static_drop_call_bindings<ctx>(
  target: StaticDropFunction,
  args: CoreExpr[],
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): Map<string, StaticDropCallBinding> | undefined {
  const params = static_drop_function_params(target);

  if (!params) {
    return undefined;
  }

  if (params.length !== args.length) {
    return undefined;
  }

  const bindings = new Map<string, StaticDropCallBinding>();

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static drop call parameter");
    }

    if (!arg) {
      throw new Error("Missing static drop call argument");
    }

    if (arg.tag === "borrow") {
      return undefined;
    }

    if (arg.tag !== "var") {
      const ownership = unique_heap_ownership(arg, ctx, hooks);

      if (!ownership) {
        return undefined;
      }

      bindings.set(param.name, { tag: "temporary", ownership });
      continue;
    }

    bindings.set(param.name, {
      tag: "owner",
      owner: resolve_drop_owner(arg.name, state),
    });
  }

  return bindings;
}

function static_drop_call_function_aliases(
  target: StaticDropFunction,
  args: CoreExpr[],
  state: CoreDropState,
): Map<string, StaticDropFunction> {
  const params = static_drop_function_params(target);
  const aliases = new Map<string, StaticDropFunction>();

  if (!params) {
    return aliases;
  }

  if (params.length !== args.length) {
    return aliases;
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static drop call parameter");
    }

    if (!arg) {
      throw new Error("Missing static drop call argument");
    }

    if (!param.is_const) {
      continue;
    }

    if (arg.tag !== "var") {
      continue;
    }

    const target_fn = state.functions.get(arg.name);

    if (!target_fn) {
      continue;
    }

    aliases.set(param.name, target_fn);
  }

  return aliases;
}

function static_drop_function_params(
  target: StaticDropFunction,
): CoreParam[] | undefined {
  if (target.tag === "lam" || target.tag === "rec") {
    return target.value.params;
  }

  const then_params = static_drop_function_params(target.then_target);
  const else_params = static_drop_function_params(target.else_target);

  if (!then_params) {
    return undefined;
  }

  if (!else_params) {
    return undefined;
  }

  if (then_params.length !== else_params.length) {
    return undefined;
  }

  return then_params;
}

function drop_host_import_for_app(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: unknown,
): CoreHostImport | undefined {
  if (!drop_ctx_has_host_imports(ctx)) {
    return undefined;
  }

  return core_host_import_for_app(expr, ctx);
}

function drop_ctx_has_host_imports(ctx: unknown): ctx is CoreHostImportCtx {
  if (typeof ctx !== "object") {
    return false;
  }

  if (ctx === null) {
    return false;
  }

  return "host_imports" in ctx;
}

function drop_scope_owners(
  scope: string,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): void {
  const remaining = Array.from(owners.values());

  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    const owner = remaining[index];
    emit_drop("scope_exit", scope, owner.name, owner, state);
  }

  owners.clear();
}

function drop_exit_owners(
  edge: Extract<
    CoreDropEdge,
    "return_exit" | "break_exit" | "continue_exit"
  >,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  inherited: CoreDropOwner[],
  escaped_owner: string | undefined,
  state: CoreDropState,
): void {
  const all_owners = inherited.concat(Array.from(owners.values()));
  const seen = new Set<string>();

  for (let index = all_owners.length - 1; index >= 0; index -= 1) {
    const owner = all_owners[index];

    if (owner.name === escaped_owner) {
      continue;
    }

    if (seen.has(owner.name)) {
      continue;
    }

    seen.add(owner.name);
    emit_drop(edge, scope, owner.name, owner, state);
  }

  owners.clear();
}

function emit_drop(
  edge: CoreDropEdge,
  scope: string,
  owner_name: string | undefined,
  owner: CoreDropOwner,
  state: CoreDropState,
): void {
  const storage = core_storage_class(owner.ownership);
  state.steps.push({
    tag: "heap_drop",
    id: "drop#" + state.next_drop.toString(),
    edge,
    scope,
    owner: owner_name,
    ownership: owner.ownership,
    storage,
    runtime: "no_op_bump_allocator",
    reason: core_ownership_result_text(owner.ownership) + " " +
      drop_edge_text(edge) + " lowers to no-op with bump allocator",
  });
  state.next_drop += 1;
}

function emit_host_transfer(
  scope: string,
  callee: string,
  argument: number,
  owner: string | undefined,
  ownership: CoreUniqueHeapOwnership,
  state: CoreDropState,
): void {
  const storage = core_storage_class(ownership);
  state.steps.push({
    tag: "host_transfer",
    id: "transfer#" + state.next_transfer.toString(),
    edge: "host_transfer",
    scope,
    callee,
    argument,
    owner,
    ownership,
    storage,
    runtime: "host_owned",
    reason: core_ownership_result_text(ownership) +
      " transfers ownership to host/import " + callee,
  });
  state.next_transfer += 1;
}

function unique_heap_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreUniqueHeapOwnership | undefined {
  const static_value = drop_static_value(expr, ctx, hooks);

  if (static_value && is_drop_static_ownerless_value(static_value)) {
    const materialized_static_aggregate =
      unique_heap_static_aggregate_ownership(expr, ctx, hooks);

    if (materialized_static_aggregate) {
      return materialized_static_aggregate;
    }

    return undefined;
  }

  if (
    static_value &&
    is_drop_static_non_runtime_closure(static_value, ctx, hooks)
  ) {
    return undefined;
  }

  let ownership: CoreOwnership;

  try {
    ownership = core_drop_expr_ownership(expr, ctx, hooks);
  } catch (error) {
    if (drop_unknown_host_boundary_probe_error(error)) {
      return undefined;
    }

    throw error;
  }

  if (ownership.tag === "unique_heap") {
    return ownership;
  }

  return undefined;
}

function unique_heap_static_aggregate_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreUniqueHeapOwnership | undefined {
  let ownership: CoreOwnership;

  try {
    ownership = core_drop_expr_ownership(expr, ctx, hooks);
  } catch (error) {
    if (drop_unknown_host_boundary_probe_error(error)) {
      return undefined;
    }

    throw error;
  }

  if (ownership.tag !== "unique_heap") {
    return undefined;
  }

  if (ownership.reason !== "runtime_aggregate") {
    return undefined;
  }

  return ownership;
}

function core_drop_expr_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreOwnership {
  return core_expr_ownership(expr, ctx, {
    bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
    block_ctx: hooks.block_ctx,
    closure_fn_type: hooks.closure_fn_type,
    collect_stmt_locals: hooks.collect_stmt_locals,
    core_expr_is_text: hooks.core_expr_is_text,
    dynamic_union_if: hooks.dynamic_union_if,
    expr_type: hooks.expr_type,
    frozen_local: hooks.frozen_local,
    if_let_branch_ctx: hooks.block_ctx,
    runtime_union_match_info: hooks.runtime_union_match_info,
    runtime_union_target: hooks.runtime_union_target,
    runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
    runtime_union_value: hooks.runtime_union_value,
    static_runtime_union_match_branch_ctx:
      hooks.static_runtime_union_match_branch_ctx,
    static_struct_value: hooks.static_struct_value,
    static_text_value: hooks.static_text_value,
    static_union_case: hooks.static_union_case,
  });
}

function drop_unknown_host_boundary_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message === "Cannot type core app expression yet") {
    return true;
  }

  return false;
}

function empty_exit_owners(): CoreDropExitOwners {
  return {
    return_owners: [],
    break_owners: [],
    continue_owners: [],
  };
}

function child_exit_owners(
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
): CoreDropExitOwners {
  const local_owners = Array.from(owners.values());

  return {
    return_owners: exit_owners.return_owners.concat(local_owners),
    break_owners: exit_owners.break_owners.concat(local_owners),
    continue_owners: exit_owners.continue_owners.concat(local_owners),
  };
}

function loop_exit_owners(
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
): CoreDropExitOwners {
  return {
    return_owners: exit_owners.return_owners.concat(
      Array.from(owners.values()),
    ),
    break_owners: [],
    continue_owners: [],
  };
}

function returned_owner_name(expr: CoreExpr): string | undefined {
  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

function next_block_scope(state: CoreDropState): string {
  const scope = "block#" + state.next_block.toString();
  state.next_block += 1;
  return scope;
}

function next_loop_scope(state: CoreDropState): string {
  const scope = "loop#" + state.next_loop.toString();
  state.next_loop += 1;
  return scope;
}

function next_closure_scope(state: CoreDropState): string {
  const scope = "closure#" + state.next_closure.toString();
  state.next_closure += 1;
  return scope;
}

function top_level_drop_functions(
  core: Core,
): Map<string, StaticDropFunction> {
  const functions = new Map<string, StaticDropFunction>();

  for (const stmt of core.statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    const fn = static_drop_function(stmt.value);

    if (!fn) {
      continue;
    }

    functions.set(stmt.name, fn);
  }

  return functions;
}

function bind_static_drop_function(
  name: string,
  value: CoreExpr,
  state: CoreDropState,
): void {
  const fn = static_drop_function_value(value, state);

  if (fn) {
    state.functions.set(name, fn);
    return;
  }

  state.functions.delete(name);
}

function static_drop_function_value(
  expr: CoreExpr,
  state: CoreDropState,
): StaticDropFunction | undefined {
  const direct = static_drop_function(expr);

  if (direct) {
    return direct;
  }

  if (expr.tag === "var") {
    return state.functions.get(expr.name);
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return static_drop_function_value(final_stmt.expr, state);
    }

    if (final_stmt.tag === "return") {
      return static_drop_function_value(final_stmt.value, state);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_drop_function_value(expr.then_branch, state);
    const else_target = static_drop_function_value(expr.else_branch, state);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if",
      then_target,
      else_target,
    };
  }

  if (expr.tag === "if_let") {
    const then_target = static_drop_function_value(expr.then_branch, state);
    const else_target = static_drop_function_value(expr.else_branch, state);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if_let",
      then_target,
      else_target,
    };
  }

  return undefined;
}

function static_drop_function(expr: CoreExpr): StaticDropFunction | undefined {
  if (expr.tag === "lam") {
    return { tag: "lam", value: expr };
  }

  if (expr.tag === "rec") {
    return { tag: "rec", value: expr };
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return static_drop_function(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return static_drop_function(final_stmt.value);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_drop_function(expr.then_branch);
    const else_target = static_drop_function(expr.else_branch);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if",
      then_target,
      else_target,
    };
  }

  if (expr.tag === "if_let") {
    const then_target = static_drop_function(expr.then_branch);
    const else_target = static_drop_function(expr.else_branch);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if_let",
      then_target,
      else_target,
    };
  }

  return undefined;
}

function resolve_drop_owner(
  owner: string,
  state: CoreDropState,
): string {
  const seen = new Set<string>();
  let current = owner;

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const next = state.aliases.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

function drop_edge_text(edge: CoreDropEdge): string {
  switch (edge) {
    case "scope_exit":
      return "scope exit";

    case "return_exit":
      return "return exit";

    case "break_exit":
      return "break exit";

    case "continue_exit":
      return "continue exit";

    case "assignment_replace":
      return "assignment replacement";

    case "discarded_expr":
      return "discarded expression";
  }
}
