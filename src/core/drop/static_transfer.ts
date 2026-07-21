import { merge_if_else_branch_owners } from "./branch.ts";
import { drop_if_let_branch_ctx } from "./conditional_expr.ts";
import { consume_host_transfer_args } from "./ownership.ts";
import { moved_expr_owner } from "./ownership.ts";
import { canonical_core_expr } from "../subject_provenance.ts";
import {
  static_drop_call_bindings,
  static_drop_call_function_aliases,
  static_drop_call_transfer_body,
  static_drop_call_transfer_body_returns_closure,
} from "./static_call.ts";
import { bind_static_drop_function } from "./static_function.ts";
import { clone_drop_owners, empty_exit_owners } from "./state.ts";
import type {
  CoreDropExitOwners,
  CoreDropHooks,
  CoreDropOwner,
  CoreDropState,
  CoreExpr,
  CoreStmt,
  StaticDropFunction,
} from "./types.ts";

export function consume_static_host_transfer_call<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  _exit_owners: CoreDropExitOwners,
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
      state.temporary_aliases.set(entry[0], {
        ownership: entry[1].ownership,
        subject: entry[1].subject,
      });
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
      hooks.collect_stmt_locals(stmt, ctx);
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
      hooks.collect_stmt_locals(stmt, ctx);
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
      {
        const branch_ctx = drop_if_let_branch_ctx(
          stmt.case_name,
          stmt.value_name,
          stmt.target,
          ctx,
          hooks,
        );
        if (branch_ctx.tag === "skip") {
          return;
        }

        scan_static_drop_transfer_stmts(
          stmt.body,
          scope,
          owners,
          branch_ctx.ctx,
          hooks,
          state,
        );
      }
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
      if (stmt.value) {
        scan_static_drop_transfer_expr(
          stmt.value,
          scope,
          owners,
          ctx,
          hooks,
          state,
        );
      }
      return;
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

    case "loop":
      scan_static_drop_transfer_stmts(
        expr.body,
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
        consume_static_composite_child(field.value, owners, state);
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
      {
        const branch_ctx = drop_if_let_branch_ctx(
          expr.case_name,
          expr.value_name,
          expr.target,
          ctx,
          hooks,
        );
        if (branch_ctx.tag === "scan") {
          scan_static_drop_transfer_expr(
            expr.then_branch,
            scope,
            owners,
            branch_ctx.ctx,
            hooks,
            state,
          );
        }
      }
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
        consume_static_composite_child(expr.value, owners, state);
      }
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

function consume_static_composite_child(
  value: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): void {
  const owner = moved_expr_owner(value, owners, state);
  if (!owner) {
    return;
  }
  if (owner.name !== "") {
    owners.delete(owner.name);
  }
  if (owner.subject) {
    state.consumed_temporary_subjects.add(owner.subject);
    state.consumed_temporary_subjects.add(
      canonical_core_expr(owner.subject),
    );
  }
}
