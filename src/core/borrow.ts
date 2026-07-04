import type { Core, CoreExpr, CoreField, CoreStmt } from "./ast.ts";
import {
  core_borrow_lifetime_decision,
  type CoreLifetimeDecision,
} from "./lifetime.ts";
import type { CoreCleanupExitEdge } from "./cleanup.ts";
import { core_scratch_exit_edges } from "./cleanup.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";

export type CoreBorrowEdge = {
  id: string;
  source_scope: string;
  target_scope: string;
  ownership: CoreOwnership;
  decision: CoreLifetimeDecision;
};

export type CoreBorrowBarrierAction = "assign" | "freeze" | "index_assign";

export type CoreBorrowBarrier = {
  scope: string;
  owner: string;
  action: CoreBorrowBarrierAction;
  borrow_id: string;
  message: string;
};

export type CoreBorrowSkippedClosure = {
  scope: string;
  reason: string;
};

export type CoreBorrowPlan = {
  edges: CoreBorrowEdge[];
  barriers: CoreBorrowBarrier[];
  skipped_closures: CoreBorrowSkippedClosure[];
};

export type CoreBorrowValidationIssue =
  | {
    tag: "rejected_borrow";
    edge: CoreBorrowEdge;
    message: string;
  }
  | {
    tag: "skipped_closure";
    scope: string;
    message: string;
  }
  | {
    tag: "borrowed_owner_barrier";
    barrier: CoreBorrowBarrier;
    message: string;
  };

export type CoreBorrowValidation = {
  ok: boolean;
  issues: CoreBorrowValidationIssue[];
};

export type CoreBorrowClosureCtx<ctx> =
  | {
    tag: "scan";
    ctx: ctx;
  }
  | {
    tag: "skip";
    reason: string;
  };

export type CoreBorrowHooks<ctx> = CoreOwnershipHooks<ctx> & {
  closure_body_ctx: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => CoreBorrowClosureCtx<ctx>;
  static_core_call_value: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_value: (name: string, ctx: ctx) => CoreExpr | undefined;
};

type CoreBorrowScope =
  | {
    id: string;
    kind: "program" | "block" | "loop" | "function_call" | "closure";
  }
  | {
    id: string;
    kind: "scratch";
    exit_edges: CoreCleanupExitEdge[];
  };

type CoreBorrowScopeKind = CoreBorrowScope["kind"];

type CoreBorrowState = {
  next_program: number;
  next_block: number;
  next_loop: number;
  next_function_call: number;
  next_closure: number;
  next_scratch: number;
  next_borrow: number;
  edges: CoreBorrowEdge[];
  barriers: CoreBorrowBarrier[];
  skipped_closures: CoreBorrowSkippedClosure[];
  active_borrows: CoreActiveBorrow[];
  scope_parents: Map<string, string | undefined>;
};

type CoreBorrowUse = "bounded" | "escaping";

type CoreActiveBorrow = {
  id: string;
  owner: string;
  scope: string;
};

type CoreStoredBorrowView = {
  owners: string[];
  borrow_id: string;
  scope: string;
  ownership: CoreOwnership;
};

type CoreFieldBorrowOwner = {
  owners: string[];
  ownership: CoreOwnership;
};

type CoreStoredBorrowViewResult = {
  view: CoreStoredBorrowView | undefined;
  scanned: boolean;
};

type CoreBorrowAliases = {
  owners: Map<string, string>;
  field_owners: Map<string, CoreFieldBorrowOwner>;
  views: Map<string, CoreStoredBorrowView>;
  known: Set<string>;
  assigned: Set<string>;
};

type CoreRecordedBorrow = {
  id: string;
  owners: string[];
  scope: string;
  ownership: CoreOwnership;
  decision: CoreLifetimeDecision;
};

export function core_borrow_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
): CoreBorrowPlan {
  const state: CoreBorrowState = {
    next_program: 0,
    next_block: 0,
    next_loop: 0,
    next_function_call: 0,
    next_closure: 0,
    next_scratch: 0,
    next_borrow: 0,
    edges: [],
    barriers: [],
    skipped_closures: [],
    active_borrows: [],
    scope_parents: new Map(),
  };
  const program = add_scope(state, "program", undefined, undefined);

  scan_borrow_stmts(
    core.statements,
    ctx,
    hooks,
    program.id,
    state,
    "escaping",
    empty_borrow_aliases(),
  );

  return {
    edges: state.edges,
    barriers: state.barriers,
    skipped_closures: state.skipped_closures,
  };
}

export function core_validate_borrow_plan(
  plan: CoreBorrowPlan,
): CoreBorrowValidation {
  const issues: CoreBorrowValidationIssue[] = [];

  for (const edge of plan.edges) {
    if (edge.decision.tag === "allowed") {
      continue;
    }

    issues.push({
      tag: "rejected_borrow",
      edge,
      message: "Rejected borrow " + edge.id + " in " + edge.target_scope +
        ": " + edge.decision.reason,
    });
  }

  for (const skipped of plan.skipped_closures) {
    issues.push({
      tag: "skipped_closure",
      scope: skipped.scope,
      message: "Skipped closure borrow analysis in " + skipped.scope + ": " +
        skipped.reason,
    });
  }

  for (const barrier of plan.barriers) {
    issues.push({
      tag: "borrowed_owner_barrier",
      barrier,
      message: barrier.message,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function core_check_borrow_plan(plan: CoreBorrowPlan): void {
  const validation = core_validate_borrow_plan(plan);

  if (validation.ok) {
    return;
  }

  const issue = validation.issues[0];

  if (!issue) {
    throw new Error("Core borrow validation failed without an issue");
  }

  throw new Error(issue.message);
}

function scan_borrow_expr<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  use: CoreBorrowUse,
  aliases: CoreBorrowAliases,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var": {
      const view = aliases.views.get(expr.name);

      if (view) {
        if (use === "escaping") {
          record_stored_borrow_view_escape(
            expr.name,
            view,
            parent,
            state,
            "cannot escape",
          );
        }
        return;
      }

      const static_value = hooks.static_value(expr.name, ctx);

      if (static_value) {
        scan_borrow_expr(static_value, ctx, hooks, parent, state, use, aliases);
      }

      return;
    }

    case "lam":
    case "rec": {
      const scope = add_scope(state, "closure", undefined, parent);
      const closure_ctx = hooks.closure_body_ctx(expr, ctx);

      if (closure_ctx.tag === "skip") {
        if (core_expr_contains_borrow(expr.body, ctx, hooks, new Set())) {
          state.skipped_closures.push({
            scope: scope.id,
            reason: closure_ctx.reason,
          });
        }
        return;
      }

      const closure_aliases = clone_borrow_aliases(aliases);

      for (const param of expr.params) {
        clear_borrow_alias(param.name, closure_aliases);
        closure_aliases.known.add(param.name);
      }

      scan_borrow_expr(
        expr.body,
        closure_ctx.ctx,
        hooks,
        scope.id,
        state,
        "escaping",
        closure_aliases,
      );
      record_captured_borrow_views(expr.body, aliases, scope.id, state);
      return;
    }

    case "prim":
      for (const arg of expr.args) {
        scan_borrow_expr(arg, ctx, hooks, parent, state, "bounded", aliases);
      }
      return;

    case "app": {
      const scope = add_scope(state, "function_call", undefined, parent);
      const inlined = hooks.static_core_call_value(expr, ctx);

      if (inlined) {
        scan_borrow_expr(inlined, ctx, hooks, scope.id, state, use, aliases);
        return;
      }

      scan_borrow_expr(
        expr.func,
        ctx,
        hooks,
        scope.id,
        state,
        "bounded",
        aliases,
      );

      for (const arg of expr.args) {
        scan_borrow_expr(arg, ctx, hooks, scope.id, state, "bounded", aliases);
      }
      return;
    }

    case "block": {
      const scope = add_scope(state, "block", undefined, parent);
      scan_borrow_stmts(
        expr.statements,
        ctx,
        hooks,
        scope.id,
        state,
        use,
        clone_borrow_aliases(aliases),
      );
      return;
    }

    case "comptime":
      scan_borrow_expr(expr.expr, ctx, hooks, parent, state, use, aliases);
      return;

    case "borrow": {
      record_borrow_expr(expr, ctx, hooks, parent, state, use, aliases);
      return;
    }

    case "freeze":
      check_borrowed_owner_barriers(
        borrow_owner_names_with_aliases(expr.value, aliases),
        "freeze",
        parent,
        state,
      );
      scan_borrow_expr(
        expr.value,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      return;

    case "scratch": {
      const scope = add_scope(
        state,
        "scratch",
        core_scratch_exit_edges(expr.body),
        parent,
      );
      scan_borrow_expr(expr.body, ctx, hooks, scope.id, state, use, aliases);
      return;
    }

    case "with":
      scan_borrow_expr(
        expr.base,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_fields(expr.fields, ctx, hooks, parent, state, use, aliases);
      return;

    case "struct_value":
      scan_borrow_expr(
        expr.type_expr,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_fields(expr.fields, ctx, hooks, parent, state, use, aliases);
      return;

    case "struct_update":
      scan_borrow_expr(
        expr.base,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_fields(expr.fields, ctx, hooks, parent, state, use, aliases);
      return;

    case "if":
      scan_borrow_expr(
        expr.cond,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_expr(
        expr.then_branch,
        ctx,
        hooks,
        parent,
        state,
        use,
        aliases,
      );
      scan_borrow_expr(
        expr.else_branch,
        ctx,
        hooks,
        parent,
        state,
        use,
        aliases,
      );
      return;

    case "if_let":
      scan_borrow_expr(
        expr.target,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      {
        const then_aliases = clone_borrow_aliases(aliases);

        if (expr.value_name) {
          clear_borrow_alias(expr.value_name, then_aliases);
        }

        scan_borrow_expr(
          expr.then_branch,
          ctx,
          hooks,
          parent,
          state,
          use,
          then_aliases,
        );
      }
      scan_borrow_expr(
        expr.else_branch,
        ctx,
        hooks,
        parent,
        state,
        use,
        aliases,
      );
      return;

    case "field":
      scan_borrow_expr(
        expr.object,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      return;

    case "index":
      scan_borrow_expr(
        expr.object,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_expr(
        expr.index,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      return;

    case "union_case":
      if (expr.value) {
        scan_borrow_expr(expr.value, ctx, hooks, parent, state, use, aliases);
      }

      if (expr.type_expr) {
        scan_borrow_expr(
          expr.type_expr,
          ctx,
          hooks,
          parent,
          state,
          "bounded",
          aliases,
        );
      }
      return;
  }
}

function scan_borrow_stmts<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  final_use: CoreBorrowUse,
  aliases: CoreBorrowAliases,
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core borrow statement " + index.toString());
    }

    if (index + 1 >= statements.length) {
      scan_borrow_stmt(stmt, ctx, hooks, parent, state, final_use, aliases);
    } else {
      scan_borrow_stmt(stmt, ctx, hooks, parent, state, "bounded", aliases);
    }

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return;
    }
  }
}

function core_stmts_definitely_exit_sequence(statements: CoreStmt[]): boolean {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core control-flow statement " + index);
    }

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return true;
    }
  }

  return false;
}

function core_stmt_definitely_exits_sequence(stmt: CoreStmt): boolean {
  switch (stmt.tag) {
    case "return":
    case "break":
    case "continue":
      return true;

    case "if_else_stmt":
      return core_stmts_definitely_exit_sequence(stmt.then_body) &&
        core_stmts_definitely_exit_sequence(stmt.else_body);

    case "expr":
      if (stmt.expr.tag === "block") {
        return core_stmts_definitely_exit_sequence(stmt.expr.statements);
      }

      return false;

    case "bind":
    case "assign":
    case "index_assign":
    case "range_loop":
    case "collection_loop":
    case "if_stmt":
    case "if_let_stmt":
    case "type_check":
    case "unsupported":
      return false;
  }
}

function scan_borrow_stmt<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  use: CoreBorrowUse,
  aliases: CoreBorrowAliases,
): void {
  switch (stmt.tag) {
    case "bind":
      if (hooks.static_value(stmt.name, ctx)) {
        return;
      }

      aliases.known.add(stmt.name);
      check_borrowed_owner_barriers(
        canonical_owner_names(stmt.name, aliases),
        "assign",
        parent,
        state,
      );
      scan_borrow_binding_value(
        stmt.name,
        stmt.value,
        ctx,
        hooks,
        parent,
        state,
        aliases,
      );
      return;

    case "assign":
      aliases.known.add(stmt.name);
      aliases.assigned.add(stmt.name);
      check_borrowed_owner_barriers(
        canonical_owner_names(stmt.name, aliases),
        "assign",
        parent,
        state,
      );
      scan_borrow_binding_value(
        stmt.name,
        stmt.value,
        ctx,
        hooks,
        parent,
        state,
        aliases,
      );
      return;

    case "index_assign":
      check_borrowed_owner_barriers(
        canonical_owner_names(stmt.name, aliases),
        "index_assign",
        parent,
        state,
      );
      scan_borrow_expr(
        stmt.index,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_expr(
        stmt.value,
        ctx,
        hooks,
        parent,
        state,
        "escaping",
        aliases,
      );
      return;

    case "range_loop": {
      scan_borrow_expr(
        stmt.start,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      scan_borrow_expr(stmt.end, ctx, hooks, parent, state, "bounded", aliases);
      scan_borrow_expr(
        stmt.step,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      const scope = add_scope(state, "loop", undefined, parent);
      const body_aliases = clone_borrow_aliases(aliases);
      clear_borrow_alias(stmt.index, body_aliases);
      scan_borrow_stmts(
        stmt.body,
        ctx,
        hooks,
        scope.id,
        state,
        "bounded",
        body_aliases,
      );
      merge_optional_branch_borrow_aliases(
        aliases,
        body_aliases,
        parent,
        state,
      );
      return;
    }

    case "collection_loop": {
      scan_borrow_expr(
        stmt.collection,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      const scope = add_scope(state, "loop", undefined, parent);
      const body_aliases = clone_borrow_aliases(aliases);
      clear_borrow_alias(stmt.item, body_aliases);
      bind_collection_loop_item_owner_alias(
        stmt.item,
        stmt.collection,
        ctx,
        hooks,
        body_aliases,
      );

      if (stmt.index) {
        clear_borrow_alias(stmt.index, body_aliases);
      }

      scan_borrow_stmts(
        stmt.body,
        ctx,
        hooks,
        scope.id,
        state,
        "bounded",
        body_aliases,
      );
      merge_optional_branch_borrow_aliases(
        aliases,
        body_aliases,
        parent,
        state,
      );
      return;
    }

    case "if_stmt": {
      scan_borrow_expr(
        stmt.cond,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      const scope = add_scope(state, "block", undefined, parent);
      const body_aliases = clone_branch_borrow_aliases(aliases);

      scan_borrow_stmts(
        stmt.body,
        ctx,
        hooks,
        scope.id,
        state,
        "bounded",
        body_aliases,
      );
      merge_optional_branch_borrow_aliases(
        aliases,
        body_aliases,
        parent,
        state,
      );
      return;
    }

    case "if_else_stmt": {
      scan_borrow_expr(
        stmt.cond,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      const then_scope = add_scope(state, "block", undefined, parent);
      const then_aliases = clone_branch_borrow_aliases(aliases);
      scan_borrow_stmts(
        stmt.then_body,
        ctx,
        hooks,
        then_scope.id,
        state,
        use,
        then_aliases,
      );
      const else_scope = add_scope(state, "block", undefined, parent);
      const else_aliases = clone_branch_borrow_aliases(aliases);
      scan_borrow_stmts(
        stmt.else_body,
        ctx,
        hooks,
        else_scope.id,
        state,
        use,
        else_aliases,
      );
      merge_required_branch_borrow_aliases(
        aliases,
        then_aliases,
        else_aliases,
        parent,
        state,
      );
      return;
    }

    case "if_let_stmt": {
      scan_borrow_expr(
        stmt.target,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      const scope = add_scope(state, "block", undefined, parent);
      const body_aliases = clone_borrow_aliases(aliases);

      if (stmt.value_name) {
        clear_borrow_alias(stmt.value_name, body_aliases);
      }

      scan_borrow_stmts(
        stmt.body,
        ctx,
        hooks,
        scope.id,
        state,
        "bounded",
        body_aliases,
      );
      merge_optional_branch_borrow_aliases(
        aliases,
        body_aliases,
        parent,
        state,
      );
      return;
    }

    case "type_check":
      scan_borrow_expr(
        stmt.target,
        ctx,
        hooks,
        parent,
        state,
        "bounded",
        aliases,
      );
      return;

    case "return":
      scan_borrow_expr(
        stmt.value,
        ctx,
        hooks,
        parent,
        state,
        "escaping",
        aliases,
      );
      return;

    case "expr":
      scan_borrow_expr(stmt.expr, ctx, hooks, parent, state, use, aliases);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_borrow_fields<ctx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  use: CoreBorrowUse,
  aliases: CoreBorrowAliases,
): void {
  for (const field of fields) {
    scan_borrow_expr(field.value, ctx, hooks, parent, state, use, aliases);
  }
}

function scan_borrow_binding_value<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
): void {
  if (value.tag === "borrow") {
    const recorded = record_borrow_expr(
      value,
      ctx,
      hooks,
      parent,
      state,
      "bounded",
      aliases,
    );
    update_borrow_alias_from_record(name, recorded, aliases);
    return;
  }

  const view = stored_borrow_view_for_value(value, aliases);

  if (view) {
    scan_borrow_expr(value, ctx, hooks, parent, state, "bounded", aliases);
    bind_stored_borrow_view_alias(name, view, aliases);
    return;
  }

  const view_result = stored_borrow_view_result_for_value(
    value,
    ctx,
    hooks,
    parent,
    state,
    aliases,
  );

  if (view_result.view) {
    bind_stored_borrow_view_alias(name, view_result.view, aliases);
    return;
  }

  const field_owner = field_owner_result_for_value(value, ctx, hooks, aliases);

  if (field_owner) {
    if (!view_result.scanned) {
      scan_borrow_expr(value, ctx, hooks, parent, state, "bounded", aliases);
    }

    bind_field_owner_alias(name, field_owner, aliases);
    return;
  }

  if (view_result.scanned) {
    clear_borrow_alias(name, aliases);
    return;
  }

  scan_borrow_expr(value, ctx, hooks, parent, state, "escaping", aliases);
  update_borrow_alias(name, value, ctx, hooks, aliases);
}

function record_borrow_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "borrow" }>,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  use: CoreBorrowUse,
  aliases: CoreBorrowAliases,
): CoreRecordedBorrow {
  const value = resolve_borrow_alias_expr(expr.value, aliases);
  const field_owner = field_owner_for_borrow_value(expr.value, aliases);
  let ownership: CoreOwnership;

  if (field_owner) {
    ownership = field_owner.ownership;
  } else {
    ownership = core_expr_ownership(value, ctx, hooks);
  }

  const id = "borrow#" + state.next_borrow.toString();
  state.next_borrow += 1;
  const decision = core_borrow_decision(ownership, use, parent);
  state.edges.push({
    id,
    source_scope: parent,
    target_scope: parent,
    ownership,
    decision,
  });
  const owners = borrow_owner_names_with_aliases(expr.value, aliases);
  if (
    owners.length > 0 && ownership.tag === "unique_heap" &&
    decision.tag === "allowed" && use === "bounded"
  ) {
    for (const owner of owners) {
      state.active_borrows.push({
        id,
        owner,
        scope: parent,
      });
    }
  }
  scan_borrow_expr(
    expr.value,
    ctx,
    hooks,
    parent,
    state,
    "bounded",
    aliases,
  );
  return {
    id,
    owners,
    scope: parent,
    ownership,
    decision,
  };
}

function record_stored_borrow_view_escape(
  name: string,
  view: CoreStoredBorrowView,
  target_scope: string,
  state: CoreBorrowState,
  action: string,
): void {
  const id = "borrow#" + state.next_borrow.toString();
  state.next_borrow += 1;
  state.edges.push({
    id,
    source_scope: view.scope,
    target_scope,
    ownership: {
      tag: "borrow_view",
      source: view.ownership,
    },
    decision: {
      tag: "rejected",
      reason: "stored borrow view " + name + " " + action +
        " borrowed owner " + owner_list_text(view.owners) + " from " +
        view.scope,
    },
  });
}

function record_captured_borrow_views(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
  target_scope: string,
  state: CoreBorrowState,
): void {
  const names = new Set<string>();
  collect_captured_borrow_view_names(
    expr,
    aliases,
    new Set(),
    names,
  );

  for (const name of names) {
    const view = aliases.views.get(name);

    if (!view) {
      continue;
    }

    record_stored_borrow_view_escape(
      name,
      view,
      target_scope,
      state,
      "cannot be captured by " + target_scope + " because it references",
    );
  }
}

function collect_captured_borrow_view_names(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
  shadowed: Set<string>,
  names: Set<string>,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var":
      if (!shadowed.has(expr.name) && aliases.views.has(expr.name)) {
        names.add(expr.name);
      }
      return;

    case "lam":
    case "rec": {
      const inner_shadowed = new Set(shadowed);

      for (const param of expr.params) {
        inner_shadowed.add(param.name);
      }

      collect_captured_borrow_view_names(
        expr.body,
        aliases,
        inner_shadowed,
        names,
      );
      return;
    }

    case "prim":
      collect_exprs_captured_borrow_view_names(
        expr.args,
        aliases,
        shadowed,
        names,
      );
      return;

    case "app":
      collect_captured_borrow_view_names(
        expr.func,
        aliases,
        shadowed,
        names,
      );
      collect_exprs_captured_borrow_view_names(
        expr.args,
        aliases,
        shadowed,
        names,
      );
      return;

    case "block":
      collect_stmts_captured_borrow_view_names(
        expr.statements,
        aliases,
        new Set(shadowed),
        names,
      );
      return;

    case "comptime":
      collect_captured_borrow_view_names(
        expr.expr,
        aliases,
        shadowed,
        names,
      );
      return;

    case "borrow":
    case "freeze":
      collect_captured_borrow_view_names(
        expr.value,
        aliases,
        shadowed,
        names,
      );
      return;

    case "scratch":
      collect_captured_borrow_view_names(
        expr.body,
        aliases,
        shadowed,
        names,
      );
      return;

    case "with":
      collect_captured_borrow_view_names(
        expr.base,
        aliases,
        shadowed,
        names,
      );
      collect_fields_captured_borrow_view_names(
        expr.fields,
        aliases,
        shadowed,
        names,
      );
      return;

    case "struct_value":
      collect_captured_borrow_view_names(
        expr.type_expr,
        aliases,
        shadowed,
        names,
      );
      collect_fields_captured_borrow_view_names(
        expr.fields,
        aliases,
        shadowed,
        names,
      );
      return;

    case "struct_update":
      collect_captured_borrow_view_names(
        expr.base,
        aliases,
        shadowed,
        names,
      );
      collect_fields_captured_borrow_view_names(
        expr.fields,
        aliases,
        shadowed,
        names,
      );
      return;

    case "if":
      collect_captured_borrow_view_names(
        expr.cond,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        expr.then_branch,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        expr.else_branch,
        aliases,
        shadowed,
        names,
      );
      return;

    case "if_let": {
      collect_captured_borrow_view_names(
        expr.target,
        aliases,
        shadowed,
        names,
      );
      const then_shadowed = new Set(shadowed);

      if (expr.value_name) {
        then_shadowed.add(expr.value_name);
      }

      collect_captured_borrow_view_names(
        expr.then_branch,
        aliases,
        then_shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        expr.else_branch,
        aliases,
        shadowed,
        names,
      );
      return;
    }

    case "field":
      collect_captured_borrow_view_names(
        expr.object,
        aliases,
        shadowed,
        names,
      );
      return;

    case "index":
      collect_captured_borrow_view_names(
        expr.object,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        expr.index,
        aliases,
        shadowed,
        names,
      );
      return;

    case "union_case":
      if (expr.value) {
        collect_captured_borrow_view_names(
          expr.value,
          aliases,
          shadowed,
          names,
        );
      }

      if (expr.type_expr) {
        collect_captured_borrow_view_names(
          expr.type_expr,
          aliases,
          shadowed,
          names,
        );
      }
      return;
  }
}

function collect_exprs_captured_borrow_view_names(
  exprs: CoreExpr[],
  aliases: CoreBorrowAliases,
  shadowed: Set<string>,
  names: Set<string>,
): void {
  for (const expr of exprs) {
    collect_captured_borrow_view_names(expr, aliases, shadowed, names);
  }
}

function collect_fields_captured_borrow_view_names(
  fields: CoreField[],
  aliases: CoreBorrowAliases,
  shadowed: Set<string>,
  names: Set<string>,
): void {
  for (const field of fields) {
    collect_captured_borrow_view_names(
      field.value,
      aliases,
      shadowed,
      names,
    );
  }
}

function collect_stmts_captured_borrow_view_names(
  statements: CoreStmt[],
  aliases: CoreBorrowAliases,
  shadowed: Set<string>,
  names: Set<string>,
): void {
  for (const stmt of statements) {
    collect_stmt_captured_borrow_view_names(stmt, aliases, shadowed, names);

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return;
    }
  }
}

function collect_stmt_captured_borrow_view_names(
  stmt: CoreStmt,
  aliases: CoreBorrowAliases,
  shadowed: Set<string>,
  names: Set<string>,
): void {
  switch (stmt.tag) {
    case "bind":
      collect_captured_borrow_view_names(
        stmt.value,
        aliases,
        shadowed,
        names,
      );
      shadowed.add(stmt.name);
      return;

    case "assign":
      collect_captured_borrow_view_names(
        stmt.value,
        aliases,
        shadowed,
        names,
      );
      shadowed.add(stmt.name);
      return;

    case "index_assign":
      if (!shadowed.has(stmt.name) && aliases.views.has(stmt.name)) {
        names.add(stmt.name);
      }
      collect_captured_borrow_view_names(
        stmt.index,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        stmt.value,
        aliases,
        shadowed,
        names,
      );
      return;

    case "range_loop": {
      collect_captured_borrow_view_names(
        stmt.start,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        stmt.end,
        aliases,
        shadowed,
        names,
      );
      collect_captured_borrow_view_names(
        stmt.step,
        aliases,
        shadowed,
        names,
      );
      const body_shadowed = new Set(shadowed);
      body_shadowed.add(stmt.index);
      collect_stmts_captured_borrow_view_names(
        stmt.body,
        aliases,
        body_shadowed,
        names,
      );
      return;
    }

    case "collection_loop": {
      collect_captured_borrow_view_names(
        stmt.collection,
        aliases,
        shadowed,
        names,
      );
      const body_shadowed = new Set(shadowed);
      body_shadowed.add(stmt.item);

      if (stmt.index) {
        body_shadowed.add(stmt.index);
      }

      collect_stmts_captured_borrow_view_names(
        stmt.body,
        aliases,
        body_shadowed,
        names,
      );
      return;
    }

    case "if_stmt":
      collect_captured_borrow_view_names(
        stmt.cond,
        aliases,
        shadowed,
        names,
      );
      collect_stmts_captured_borrow_view_names(
        stmt.body,
        aliases,
        new Set(shadowed),
        names,
      );
      return;

    case "if_else_stmt":
      collect_captured_borrow_view_names(
        stmt.cond,
        aliases,
        shadowed,
        names,
      );
      collect_stmts_captured_borrow_view_names(
        stmt.then_body,
        aliases,
        new Set(shadowed),
        names,
      );
      collect_stmts_captured_borrow_view_names(
        stmt.else_body,
        aliases,
        new Set(shadowed),
        names,
      );
      return;

    case "if_let_stmt": {
      collect_captured_borrow_view_names(
        stmt.target,
        aliases,
        shadowed,
        names,
      );
      const body_shadowed = new Set(shadowed);

      if (stmt.value_name) {
        body_shadowed.add(stmt.value_name);
      }

      collect_stmts_captured_borrow_view_names(
        stmt.body,
        aliases,
        body_shadowed,
        names,
      );
      return;
    }

    case "type_check":
      collect_captured_borrow_view_names(
        stmt.target,
        aliases,
        shadowed,
        names,
      );
      return;

    case "return":
      collect_captured_borrow_view_names(
        stmt.value,
        aliases,
        shadowed,
        names,
      );
      return;

    case "expr":
      collect_captured_borrow_view_names(
        stmt.expr,
        aliases,
        shadowed,
        names,
      );
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function core_borrow_decision(
  ownership: CoreOwnership,
  use: CoreBorrowUse,
  scope: string,
): CoreLifetimeDecision {
  const decision = core_borrow_lifetime_decision(ownership);

  if (decision.tag === "allowed") {
    return decision;
  }

  if (ownership.tag === "unique_heap" && use === "bounded") {
    return {
      tag: "allowed",
      reason: "borrow over " + core_ownership_result_text(ownership) +
        " is bounded to " + scope,
    };
  }

  return decision;
}

function borrow_owner_name(expr: CoreExpr): string | undefined {
  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

function borrow_owner_names_with_aliases(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
): string[] {
  if (expr.tag === "var") {
    const view = aliases.views.get(expr.name);

    if (view) {
      return [...view.owners];
    }

    const field_owner = aliases.field_owners.get(expr.name);

    if (field_owner) {
      return [...field_owner.owners];
    }

    return [canonical_value_owner_name(expr.name, aliases)];
  }

  if (expr.tag === "field") {
    return borrow_owner_names_with_aliases(expr.object, aliases);
  }

  if (expr.tag === "index") {
    return borrow_owner_names_with_aliases(expr.object, aliases);
  }

  return [];
}

function resolve_borrow_alias_expr(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreExpr {
  if (expr.tag !== "var") {
    return expr;
  }

  const owner = canonical_value_owner_name(expr.name, aliases);

  if (owner === expr.name) {
    return expr;
  }

  return { tag: "var", name: owner };
}

function canonical_value_owner_name(
  name: string,
  aliases: CoreBorrowAliases,
): string {
  let current = name;
  const seen = new Set<string>();

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const view = aliases.views.get(current);

    if (view) {
      if (view.owners.length !== 1) {
        return current;
      }

      const owner = view.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const next = aliases.owners.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

function canonical_owner_names(
  name: string,
  aliases: CoreBorrowAliases,
): string[] {
  const view = aliases.views.get(name);

  if (view) {
    return [...view.owners];
  }

  const field_owner = aliases.field_owners.get(name);

  if (field_owner) {
    return [...field_owner.owners];
  }

  return [canonical_owner_name(name, aliases)];
}

function canonical_owner_name(
  name: string,
  aliases: CoreBorrowAliases,
): string {
  let current = name;
  const seen = new Set<string>();

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const view = aliases.views.get(current);

    if (view) {
      if (view.owners.length !== 1) {
        return current;
      }

      const owner = view.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const field_owner = aliases.field_owners.get(current);

    if (field_owner) {
      if (field_owner.owners.length !== 1) {
        return current;
      }

      const owner = field_owner.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const next = aliases.owners.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

function empty_borrow_aliases(): CoreBorrowAliases {
  return {
    owners: new Map(),
    field_owners: new Map(),
    views: new Map(),
    known: new Set(),
    assigned: new Set(),
  };
}

function clone_borrow_aliases(aliases: CoreBorrowAliases): CoreBorrowAliases {
  return {
    owners: new Map(aliases.owners),
    field_owners: clone_field_owner_aliases(aliases.field_owners),
    views: new Map(aliases.views),
    known: new Set(aliases.known),
    assigned: new Set(aliases.assigned),
  };
}

function clone_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
): CoreBorrowAliases {
  return {
    owners: new Map(aliases.owners),
    field_owners: clone_field_owner_aliases(aliases.field_owners),
    views: new Map(aliases.views),
    known: new Set(aliases.known),
    assigned: new Set(),
  };
}

function clone_field_owner_aliases(
  aliases: Map<string, CoreFieldBorrowOwner>,
): Map<string, CoreFieldBorrowOwner> {
  const cloned = new Map<string, CoreFieldBorrowOwner>();

  for (const [name, alias] of aliases) {
    cloned.set(name, {
      owners: [...alias.owners],
      ownership: alias.ownership,
    });
  }

  return cloned;
}

function merge_optional_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  parent_scope: string,
  state: CoreBorrowState,
): void {
  for (const name of branch.assigned) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const view = branch.views.get(name);

    if (!view) {
      const field_owner = branch.field_owners.get(name);

      if (!field_owner) {
        continue;
      }

      const existing = aliases.field_owners.get(name);

      if (existing) {
        bind_field_owner_alias(
          name,
          merge_field_owner_aliases([existing, field_owner]),
          aliases,
        );
      } else {
        bind_field_owner_alias(name, field_owner, aliases);
      }

      continue;
    }

    bind_stored_borrow_view_alias(
      name,
      promote_stored_borrow_view(view, parent_scope, state),
      aliases,
    );
  }
}

function merge_required_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
  then_branch: CoreBorrowAliases,
  else_branch: CoreBorrowAliases,
  parent_scope: string,
  state: CoreBorrowState,
): void {
  const names = new Set<string>();

  for (const name of then_branch.assigned) {
    names.add(name);
  }

  for (const name of else_branch.assigned) {
    names.add(name);
  }

  for (const name of names) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const views: CoreStoredBorrowView[] = [];
    collect_branch_view(name, aliases, then_branch, views);
    collect_branch_view(name, aliases, else_branch, views);

    if (views.length === 0) {
      const field_owners: CoreFieldBorrowOwner[] = [];
      collect_branch_field_owner(name, aliases, then_branch, field_owners);
      collect_branch_field_owner(name, aliases, else_branch, field_owners);

      if (field_owners.length === 0) {
        aliases.views.delete(name);
        aliases.field_owners.delete(name);
        continue;
      }

      bind_field_owner_alias(
        name,
        merge_field_owner_aliases(field_owners),
        aliases,
      );
      continue;
    }

    const first = views[0];

    if (!first) {
      throw new Error("Missing merged borrow view for " + name);
    }

    for (const view of views) {
      promote_stored_borrow_view(view, parent_scope, state);
    }

    bind_stored_borrow_view_alias(
      name,
      promote_stored_borrow_view(first, parent_scope, state),
      aliases,
    );
  }
}

function collect_branch_view(
  name: string,
  parent: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  views: CoreStoredBorrowView[],
): void {
  const branch_view = branch.views.get(name);

  if (branch_view) {
    views.push(branch_view);
    return;
  }

  if (branch.assigned.has(name)) {
    return;
  }

  const parent_view = parent.views.get(name);

  if (parent_view) {
    views.push(parent_view);
  }
}

function collect_branch_field_owner(
  name: string,
  parent: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  field_owners: CoreFieldBorrowOwner[],
): void {
  const branch_field_owner = branch.field_owners.get(name);

  if (branch_field_owner) {
    field_owners.push(branch_field_owner);
    return;
  }

  if (branch.assigned.has(name)) {
    return;
  }

  const parent_field_owner = parent.field_owners.get(name);

  if (parent_field_owner) {
    field_owners.push(parent_field_owner);
  }
}

function merge_field_owner_aliases(
  aliases: CoreFieldBorrowOwner[],
): CoreFieldBorrowOwner {
  const first = aliases[0];

  if (!first) {
    throw new Error("Missing field owner alias to merge");
  }

  const owners: string[] = [];
  let ownership = first.ownership;

  for (const alias of aliases) {
    for (const owner of alias.owners) {
      if (owners.includes(owner)) {
        continue;
      }

      owners.push(owner);
    }

    if (alias.ownership.tag === "unique_heap") {
      ownership = alias.ownership;
    }
  }

  return {
    owners,
    ownership,
  };
}

function promote_stored_borrow_view(
  view: CoreStoredBorrowView,
  scope: string,
  state: CoreBorrowState,
): CoreStoredBorrowView {
  for (const owner of view.owners) {
    ensure_active_borrow(view.borrow_id, owner, scope, state);
  }

  return {
    owners: [...view.owners],
    borrow_id: view.borrow_id,
    scope,
    ownership: view.ownership,
  };
}

function ensure_active_borrow(
  id: string,
  owner: string,
  scope: string,
  state: CoreBorrowState,
): void {
  for (const active of state.active_borrows) {
    if (active.id === id && active.owner === owner && active.scope === scope) {
      return;
    }
  }

  state.active_borrows.push({
    id,
    owner,
    scope,
  });
}

function update_borrow_alias<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  aliases.known.add(name);
  const view = stored_borrow_view_for_value(value, aliases);

  if (view) {
    bind_stored_borrow_view_alias(name, view, aliases);
    return;
  }

  const field_owner = field_owner_result_for_value(value, ctx, hooks, aliases);

  if (field_owner) {
    bind_field_owner_alias(name, field_owner, aliases);
    return;
  }

  const owner = borrow_owner_name(value);

  if (!owner) {
    clear_borrow_alias(name, aliases);
    return;
  }

  aliases.views.delete(name);
  aliases.field_owners.delete(name);
  aliases.owners.set(name, canonical_owner_name(owner, aliases));
}

function update_borrow_alias_from_record(
  name: string,
  recorded: CoreRecordedBorrow,
  aliases: CoreBorrowAliases,
): void {
  if (
    recorded.owners.length > 0 && recorded.ownership.tag === "unique_heap" &&
    recorded.decision.tag === "allowed"
  ) {
    bind_stored_borrow_view_alias(name, {
      owners: recorded.owners,
      borrow_id: recorded.id,
      scope: recorded.scope,
      ownership: recorded.ownership,
    }, aliases);
    return;
  }

  clear_borrow_alias(name, aliases);
}

function bind_field_owner_alias(
  name: string,
  field_owner: CoreFieldBorrowOwner,
  aliases: CoreBorrowAliases,
): void {
  aliases.known.add(name);
  aliases.views.delete(name);
  aliases.owners.delete(name);
  aliases.field_owners.set(name, {
    owners: [...field_owner.owners],
    ownership: field_owner.ownership,
  });
}

function bind_collection_loop_item_owner_alias<ctx>(
  item: string,
  collection: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  if (!hooks.runtime_aggregate_type_expr) {
    return;
  }

  const aggregate_type = hooks.runtime_aggregate_type_expr(collection, ctx);

  if (!aggregate_type) {
    return;
  }

  const owners = borrow_owner_names_with_aliases(collection, aliases);

  if (owners.length === 0) {
    return;
  }

  const ownership = core_expr_ownership({ tag: "var", name: item }, ctx, hooks);

  if (ownership.tag === "scalar_local") {
    return;
  }

  bind_field_owner_alias(item, {
    owners,
    ownership,
  }, aliases);
}

function bind_stored_borrow_view_alias(
  name: string,
  view: CoreStoredBorrowView,
  aliases: CoreBorrowAliases,
): void {
  aliases.known.add(name);
  aliases.owners.delete(name);
  aliases.field_owners.delete(name);
  aliases.views.set(name, {
    owners: [...view.owners],
    borrow_id: view.borrow_id,
    scope: view.scope,
    ownership: view.ownership,
  });
}

function stored_borrow_view_result_for_value<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
): CoreStoredBorrowViewResult {
  if (value.tag === "block") {
    return stored_borrow_view_result_for_block(
      value,
      ctx,
      hooks,
      parent,
      state,
      aliases,
    );
  }

  const stored = stored_borrow_view_for_value(value, aliases);

  if (stored) {
    return {
      view: stored,
      scanned: false,
    };
  }

  if (value.tag === "borrow") {
    const recorded = record_borrow_expr(
      value,
      ctx,
      hooks,
      parent,
      state,
      "bounded",
      aliases,
    );

    if (
      recorded.owners.length > 0 && recorded.ownership.tag === "unique_heap" &&
      recorded.decision.tag === "allowed"
    ) {
      return {
        view: {
          owners: recorded.owners,
          borrow_id: recorded.id,
          scope: recorded.scope,
          ownership: recorded.ownership,
        },
        scanned: true,
      };
    }

    return {
      view: undefined,
      scanned: true,
    };
  }

  if (value.tag === "if") {
    scan_borrow_expr(
      value.cond,
      ctx,
      hooks,
      parent,
      state,
      "bounded",
      aliases,
    );
    const views: CoreStoredBorrowView[] = [];
    collect_stored_borrow_view_result(
      value.then_branch,
      ctx,
      hooks,
      parent,
      state,
      aliases,
      views,
    );
    collect_stored_borrow_view_result(
      value.else_branch,
      ctx,
      hooks,
      parent,
      state,
      aliases,
      views,
    );

    if (views.length > 0) {
      return {
        view: merge_stored_borrow_views(views, parent, state),
        scanned: true,
      };
    }

    return {
      view: undefined,
      scanned: true,
    };
  }

  if (value.tag === "if_let") {
    scan_borrow_expr(
      value.target,
      ctx,
      hooks,
      parent,
      state,
      "bounded",
      aliases,
    );
    const views: CoreStoredBorrowView[] = [];
    const then_aliases = clone_borrow_aliases(aliases);

    if (value.value_name) {
      clear_borrow_alias(value.value_name, then_aliases);
    }

    collect_stored_borrow_view_result(
      value.then_branch,
      ctx,
      hooks,
      parent,
      state,
      then_aliases,
      views,
    );
    collect_stored_borrow_view_result(
      value.else_branch,
      ctx,
      hooks,
      parent,
      state,
      aliases,
      views,
    );

    if (views.length > 0) {
      return {
        view: merge_stored_borrow_views(views, parent, state),
        scanned: true,
      };
    }

    return {
      view: undefined,
      scanned: true,
    };
  }

  return {
    view: undefined,
    scanned: false,
  };
}

function stored_borrow_view_result_for_block<ctx>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
): CoreStoredBorrowViewResult {
  const scope = add_scope(state, "block", undefined, parent);
  const block_aliases = clone_borrow_aliases(aliases);
  const result = scan_borrow_block_prefix_for_result(
    value.statements,
    ctx,
    hooks,
    scope.id,
    state,
    block_aliases,
  );

  if (!result) {
    return {
      view: undefined,
      scanned: true,
    };
  }

  const result_view = stored_borrow_view_result_for_value(
    result,
    ctx,
    hooks,
    scope.id,
    state,
    block_aliases,
  );

  if (result_view.view) {
    return {
      view: promote_stored_borrow_view(result_view.view, parent, state),
      scanned: true,
    };
  }

  if (result_view.scanned) {
    return {
      view: undefined,
      scanned: true,
    };
  }

  scan_borrow_expr(
    result,
    ctx,
    hooks,
    scope.id,
    state,
    "bounded",
    block_aliases,
  );
  return {
    view: undefined,
    scanned: true,
  };
}

function scan_borrow_block_prefix_for_result<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
): CoreExpr | undefined {
  if (statements.length === 0) {
    return undefined;
  }

  for (let index = 0; index + 1 < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core borrow block statement " + index);
    }

    scan_borrow_stmt(stmt, ctx, hooks, parent, state, "bounded", aliases);
  }

  const final_stmt = statements[statements.length - 1];

  if (!final_stmt) {
    throw new Error("Missing core borrow block final statement");
  }

  if (final_stmt.tag === "expr") {
    return final_stmt.expr;
  }

  if (final_stmt.tag === "return") {
    return final_stmt.value;
  }

  scan_borrow_stmt(final_stmt, ctx, hooks, parent, state, "bounded", aliases);
  return undefined;
}

function collect_stored_borrow_view_result<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
  views: CoreStoredBorrowView[],
): void {
  const result = stored_borrow_view_result_for_value(
    value,
    ctx,
    hooks,
    parent,
    state,
    aliases,
  );

  if (result.view) {
    views.push(result.view);
    return;
  }

  if (result.scanned) {
    return;
  }

  scan_borrow_expr(value, ctx, hooks, parent, state, "bounded", aliases);
}

function merge_stored_borrow_views(
  views: CoreStoredBorrowView[],
  scope: string,
  state: CoreBorrowState,
): CoreStoredBorrowView {
  const first = views[0];

  if (!first) {
    throw new Error("Missing stored borrow view to merge");
  }

  const owners: string[] = [];
  let ownership = first.ownership;

  for (const view of views) {
    const promoted = promote_stored_borrow_view(view, scope, state);

    for (const owner of promoted.owners) {
      if (owners.includes(owner)) {
        continue;
      }

      owners.push(owner);
    }

    if (promoted.ownership.tag === "unique_heap") {
      ownership = promoted.ownership;
    }
  }

  return {
    owners,
    borrow_id: first.borrow_id,
    scope,
    ownership,
  };
}

function field_owner_result_for_value<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag === "block") {
    return field_owner_result_for_block(value, ctx, hooks, aliases);
  }

  const field_alias = stored_field_owner_for_value(value, aliases);

  if (field_alias) {
    return field_alias;
  }

  const field_owner = direct_field_or_index_owner(value, ctx, hooks, aliases);

  if (field_owner) {
    return field_owner;
  }

  if (value.tag === "if") {
    const owners: CoreFieldBorrowOwner[] = [];
    const then_owner = field_owner_result_for_value(
      value.then_branch,
      ctx,
      hooks,
      aliases,
    );

    if (then_owner) {
      owners.push(then_owner);
    }

    const else_owner = field_owner_result_for_value(
      value.else_branch,
      ctx,
      hooks,
      aliases,
    );

    if (else_owner) {
      owners.push(else_owner);
    }

    if (owners.length > 0) {
      return merge_field_owner_aliases(owners);
    }
  }

  if (value.tag === "if_let") {
    const owners: CoreFieldBorrowOwner[] = [];
    const then_aliases = clone_borrow_aliases(aliases);

    if (value.value_name) {
      clear_borrow_alias(value.value_name, then_aliases);
    }

    const then_owner = field_owner_result_for_value(
      value.then_branch,
      ctx,
      hooks,
      then_aliases,
    );

    if (then_owner) {
      owners.push(then_owner);
    }

    const else_owner = field_owner_result_for_value(
      value.else_branch,
      ctx,
      hooks,
      aliases,
    );

    if (else_owner) {
      owners.push(else_owner);
    }

    if (owners.length > 0) {
      return merge_field_owner_aliases(owners);
    }
  }

  return undefined;
}

function field_owner_result_for_block<ctx>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  const block_aliases = clone_borrow_aliases(aliases);
  const result = update_block_field_aliases_for_result(
    value.statements,
    ctx,
    hooks,
    block_aliases,
  );

  if (!result) {
    return undefined;
  }

  return field_owner_result_for_value(result, ctx, hooks, block_aliases);
}

function update_block_field_aliases_for_result<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreExpr | undefined {
  if (statements.length === 0) {
    return undefined;
  }

  for (let index = 0; index + 1 < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core field-owner block statement " + index);
    }

    update_field_aliases_for_stmt(stmt, ctx, hooks, aliases);
  }

  const final_stmt = statements[statements.length - 1];

  if (!final_stmt) {
    throw new Error("Missing core field-owner block final statement");
  }

  if (final_stmt.tag === "expr") {
    return final_stmt.expr;
  }

  if (final_stmt.tag === "return") {
    return final_stmt.value;
  }

  update_field_aliases_for_stmt(final_stmt, ctx, hooks, aliases);
  return undefined;
}

function update_field_aliases_for_stmt<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  switch (stmt.tag) {
    case "bind":
      aliases.known.add(stmt.name);
      update_borrow_alias(stmt.name, stmt.value, ctx, hooks, aliases);
      return;

    case "assign":
      aliases.assigned.add(stmt.name);
      update_borrow_alias(stmt.name, stmt.value, ctx, hooks, aliases);
      return;

    case "range_loop": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      clear_borrow_alias(stmt.index, body_aliases);
      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "collection_loop": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      clear_borrow_alias(stmt.item, body_aliases);
      bind_collection_loop_item_owner_alias(
        stmt.item,
        stmt.collection,
        ctx,
        hooks,
        body_aliases,
      );

      if (stmt.index) {
        clear_borrow_alias(stmt.index, body_aliases);
      }

      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "if_stmt": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "if_else_stmt": {
      const then_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(
        stmt.then_body,
        ctx,
        hooks,
        then_aliases,
      );
      const else_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(
        stmt.else_body,
        ctx,
        hooks,
        else_aliases,
      );
      merge_required_branch_field_aliases(
        aliases,
        then_aliases,
        else_aliases,
      );
      return;
    }

    case "if_let_stmt": {
      const body_aliases = clone_branch_borrow_aliases(aliases);

      if (stmt.value_name) {
        clear_borrow_alias(stmt.value_name, body_aliases);
      }

      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "expr":
      return;

    case "type_check":
      return;

    case "return":
      return;

    case "index_assign":
    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function update_field_aliases_for_stmts<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core field-owner statement " + index);
    }

    update_field_aliases_for_stmt(stmt, ctx, hooks, aliases);

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return;
    }
  }
}

function merge_optional_branch_field_aliases(
  aliases: CoreBorrowAliases,
  branch: CoreBorrowAliases,
): void {
  for (const name of branch.assigned) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const field_owner = branch.field_owners.get(name);

    if (!field_owner) {
      continue;
    }

    const existing = aliases.field_owners.get(name);

    if (existing) {
      bind_field_owner_alias(
        name,
        merge_field_owner_aliases([existing, field_owner]),
        aliases,
      );
    } else {
      bind_field_owner_alias(name, field_owner, aliases);
    }
  }
}

function merge_required_branch_field_aliases(
  aliases: CoreBorrowAliases,
  then_branch: CoreBorrowAliases,
  else_branch: CoreBorrowAliases,
): void {
  const names = new Set<string>();

  for (const name of then_branch.assigned) {
    names.add(name);
  }

  for (const name of else_branch.assigned) {
    names.add(name);
  }

  for (const name of names) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const field_owners: CoreFieldBorrowOwner[] = [];
    collect_branch_field_owner(name, aliases, then_branch, field_owners);
    collect_branch_field_owner(name, aliases, else_branch, field_owners);

    if (field_owners.length === 0) {
      aliases.field_owners.delete(name);
      continue;
    }

    bind_field_owner_alias(
      name,
      merge_field_owner_aliases(field_owners),
      aliases,
    );
  }
}

function direct_field_or_index_owner<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag === "field") {
    return field_owner_for_expr(value.object, value, ctx, hooks, aliases);
  }

  if (value.tag === "index") {
    return field_owner_for_expr(value.object, value, ctx, hooks, aliases);
  }

  return undefined;
}

function field_owner_for_expr<ctx>(
  object: CoreExpr,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  const owners = borrow_owner_names_with_aliases(object, aliases);

  if (owners.length === 0) {
    return undefined;
  }

  return {
    owners,
    ownership: core_expr_ownership(value, ctx, hooks),
  };
}

function field_owner_for_borrow_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.field_owners.get(value.name);
}

function stored_field_owner_for_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.field_owners.get(value.name);
}

function stored_borrow_view_for_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreStoredBorrowView | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.views.get(value.name);
}

function clear_borrow_alias(
  name: string,
  aliases: CoreBorrowAliases,
): void {
  aliases.owners.delete(name);
  aliases.field_owners.delete(name);
  aliases.views.delete(name);
}

function check_borrowed_owner_barriers(
  owners: string[],
  action: CoreBorrowBarrierAction,
  scope: string,
  state: CoreBorrowState,
): void {
  for (const owner of owners) {
    check_borrowed_owner_barrier(owner, action, scope, state);
  }
}

function check_borrowed_owner_barrier(
  owner: string,
  action: CoreBorrowBarrierAction,
  scope: string,
  state: CoreBorrowState,
): void {
  for (const active of state.active_borrows) {
    if (active.owner !== owner) {
      continue;
    }

    if (!scope_is_within(scope, active.scope, state)) {
      continue;
    }

    state.barriers.push({
      scope,
      owner,
      action,
      borrow_id: active.id,
      message: "Cannot " + borrow_barrier_action_text(action) +
        " borrowed owner " + owner + " in " + scope + " while " +
        active.id + " is active",
    });
  }
}

function scope_is_within(
  scope: string,
  ancestor: string,
  state: CoreBorrowState,
): boolean {
  let current: string | undefined = scope;

  while (current) {
    if (current === ancestor) {
      return true;
    }

    current = state.scope_parents.get(current);
  }

  return false;
}

function borrow_barrier_action_text(action: CoreBorrowBarrierAction): string {
  switch (action) {
    case "assign":
      return "move or replace";

    case "freeze":
      return "freeze";

    case "index_assign":
      return "mutate";
  }
}

function owner_list_text(owners: string[]): string {
  if (owners.length === 0) {
    return "<unknown>";
  }

  return owners.join(", ");
}

function add_scope(
  state: CoreBorrowState,
  kind: CoreBorrowScopeKind,
  exit_edges: CoreCleanupExitEdge[] | undefined,
  parent: string | undefined,
): CoreBorrowScope {
  const id = next_scope_id(state, kind);
  state.scope_parents.set(id, parent);

  if (kind === "scratch") {
    const scratch_edges = exit_edges_for_scratch(exit_edges);
    return {
      id,
      kind,
      exit_edges: scratch_edges,
    };
  }

  return {
    id,
    kind,
  };
}

function next_scope_id(
  state: CoreBorrowState,
  kind: CoreBorrowScopeKind,
): string {
  switch (kind) {
    case "program": {
      const id = "program#" + state.next_program.toString();
      state.next_program += 1;
      return id;
    }

    case "block": {
      const id = "block#" + state.next_block.toString();
      state.next_block += 1;
      return id;
    }

    case "loop": {
      const id = "loop#" + state.next_loop.toString();
      state.next_loop += 1;
      return id;
    }

    case "function_call": {
      const id = "function_call#" + state.next_function_call.toString();
      state.next_function_call += 1;
      return id;
    }

    case "closure": {
      const id = "closure#" + state.next_closure.toString();
      state.next_closure += 1;
      return id;
    }

    case "scratch": {
      const id = "scratch#" + state.next_scratch.toString();
      state.next_scratch += 1;
      return id;
    }
  }
}

function exit_edges_for_scratch(
  exit_edges: CoreCleanupExitEdge[] | undefined,
): CoreCleanupExitEdge[] {
  if (exit_edges) {
    return exit_edges;
  }

  return ["fallthrough"];
}

function core_expr_contains_borrow<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  seen_static_names: Set<string>,
): boolean {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "borrow":
      return true;

    case "var": {
      if (seen_static_names.has(expr.name)) {
        return false;
      }

      const static_value = hooks.static_value(expr.name, ctx);

      if (!static_value) {
        return false;
      }

      seen_static_names.add(expr.name);
      return core_expr_contains_borrow(
        static_value,
        ctx,
        hooks,
        seen_static_names,
      );
    }

    case "lam":
    case "rec":
      return core_expr_contains_borrow(
        expr.body,
        ctx,
        hooks,
        seen_static_names,
      );

    case "prim":
      return core_exprs_contain_borrow(
        expr.args,
        ctx,
        hooks,
        seen_static_names,
      );

    case "app": {
      const inlined = hooks.static_core_call_value(expr, ctx);

      if (inlined) {
        return core_expr_contains_borrow(
          inlined,
          ctx,
          hooks,
          seen_static_names,
        );
      }

      if (
        core_expr_contains_borrow(expr.func, ctx, hooks, seen_static_names)
      ) {
        return true;
      }

      return core_exprs_contain_borrow(
        expr.args,
        ctx,
        hooks,
        seen_static_names,
      );
    }

    case "block":
      return core_stmts_contain_borrow(
        expr.statements,
        ctx,
        hooks,
        seen_static_names,
      );

    case "comptime":
      return core_expr_contains_borrow(
        expr.expr,
        ctx,
        hooks,
        seen_static_names,
      );

    case "freeze":
      return core_expr_contains_borrow(
        expr.value,
        ctx,
        hooks,
        seen_static_names,
      );

    case "scratch":
      return core_expr_contains_borrow(
        expr.body,
        ctx,
        hooks,
        seen_static_names,
      );

    case "with":
      if (core_expr_contains_borrow(expr.base, ctx, hooks, seen_static_names)) {
        return true;
      }

      return core_fields_contain_borrow(
        expr.fields,
        ctx,
        hooks,
        seen_static_names,
      );

    case "struct_value":
      if (
        core_expr_contains_borrow(
          expr.type_expr,
          ctx,
          hooks,
          seen_static_names,
        )
      ) {
        return true;
      }

      return core_fields_contain_borrow(
        expr.fields,
        ctx,
        hooks,
        seen_static_names,
      );

    case "struct_update":
      if (core_expr_contains_borrow(expr.base, ctx, hooks, seen_static_names)) {
        return true;
      }

      return core_fields_contain_borrow(
        expr.fields,
        ctx,
        hooks,
        seen_static_names,
      );

    case "if":
      return core_expr_contains_borrow(
        expr.cond,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_expr_contains_borrow(
          expr.then_branch,
          ctx,
          hooks,
          seen_static_names,
        ) ||
        core_expr_contains_borrow(
          expr.else_branch,
          ctx,
          hooks,
          seen_static_names,
        );

    case "if_let":
      return core_expr_contains_borrow(
        expr.target,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_expr_contains_borrow(
          expr.then_branch,
          ctx,
          hooks,
          seen_static_names,
        ) ||
        core_expr_contains_borrow(
          expr.else_branch,
          ctx,
          hooks,
          seen_static_names,
        );

    case "field":
      return core_expr_contains_borrow(
        expr.object,
        ctx,
        hooks,
        seen_static_names,
      );

    case "index":
      return core_expr_contains_borrow(
        expr.object,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_expr_contains_borrow(
          expr.index,
          ctx,
          hooks,
          seen_static_names,
        );

    case "union_case":
      if (
        expr.value &&
        core_expr_contains_borrow(expr.value, ctx, hooks, seen_static_names)
      ) {
        return true;
      }

      if (
        expr.type_expr &&
        core_expr_contains_borrow(
          expr.type_expr,
          ctx,
          hooks,
          seen_static_names,
        )
      ) {
        return true;
      }

      return false;
  }
}

function core_exprs_contain_borrow<ctx>(
  exprs: CoreExpr[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  seen_static_names: Set<string>,
): boolean {
  for (const expr of exprs) {
    if (core_expr_contains_borrow(expr, ctx, hooks, seen_static_names)) {
      return true;
    }
  }

  return false;
}

function core_fields_contain_borrow<ctx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  seen_static_names: Set<string>,
): boolean {
  for (const field of fields) {
    if (
      core_expr_contains_borrow(field.value, ctx, hooks, seen_static_names)
    ) {
      return true;
    }
  }

  return false;
}

function core_stmts_contain_borrow<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  seen_static_names: Set<string>,
): boolean {
  for (const stmt of statements) {
    if (core_stmt_contains_borrow(stmt, ctx, hooks, seen_static_names)) {
      return true;
    }
  }

  return false;
}

function core_stmt_contains_borrow<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  seen_static_names: Set<string>,
): boolean {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      return core_expr_contains_borrow(
        stmt.value,
        ctx,
        hooks,
        seen_static_names,
      );

    case "index_assign":
      return core_expr_contains_borrow(
        stmt.index,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_expr_contains_borrow(
          stmt.value,
          ctx,
          hooks,
          seen_static_names,
        );

    case "range_loop":
      return core_expr_contains_borrow(
        stmt.start,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_expr_contains_borrow(
          stmt.end,
          ctx,
          hooks,
          seen_static_names,
        ) ||
        core_expr_contains_borrow(
          stmt.step,
          ctx,
          hooks,
          seen_static_names,
        ) ||
        core_stmts_contain_borrow(
          stmt.body,
          ctx,
          hooks,
          seen_static_names,
        );

    case "collection_loop":
      return core_expr_contains_borrow(
        stmt.collection,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_stmts_contain_borrow(
          stmt.body,
          ctx,
          hooks,
          seen_static_names,
        );

    case "if_stmt":
      return core_expr_contains_borrow(
        stmt.cond,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_stmts_contain_borrow(
          stmt.body,
          ctx,
          hooks,
          seen_static_names,
        );

    case "if_else_stmt":
      return core_expr_contains_borrow(
        stmt.cond,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_stmts_contain_borrow(
          stmt.then_body,
          ctx,
          hooks,
          seen_static_names,
        ) ||
        core_stmts_contain_borrow(
          stmt.else_body,
          ctx,
          hooks,
          seen_static_names,
        );

    case "if_let_stmt":
      return core_expr_contains_borrow(
        stmt.target,
        ctx,
        hooks,
        seen_static_names,
      ) ||
        core_stmts_contain_borrow(
          stmt.body,
          ctx,
          hooks,
          seen_static_names,
        );

    case "type_check":
      return core_expr_contains_borrow(
        stmt.target,
        ctx,
        hooks,
        seen_static_names,
      );

    case "return":
      return core_expr_contains_borrow(
        stmt.value,
        ctx,
        hooks,
        seen_static_names,
      );

    case "expr":
      return core_expr_contains_borrow(
        stmt.expr,
        ctx,
        hooks,
        seen_static_names,
      );

    case "break":
    case "continue":
    case "unsupported":
      return false;
  }
}
