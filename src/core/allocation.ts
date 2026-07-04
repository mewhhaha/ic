import type { Core, CoreExpr, CoreField, CoreStmt } from "./ast.ts";
import { expect } from "../expect.ts";
import { core_storage_class, type CoreStorageClass } from "./escape.ts";
import type { CoreFnType } from "./ast.ts";
import {
  core_expr_ownership,
  type CoreOwnership,
  type CoreOwnershipHooks,
  type CoreOwnershipPointerReason,
} from "./ownership.ts";
import {
  runtime_aggregate_freeze_copy_supported,
  runtime_aggregate_layout_for_type,
  type RuntimeAggregateField,
} from "./runtime_aggregate.ts";
import { runtime_union_freeze_copy_supported } from "./runtime_union_emit.ts";
import {
  runtime_union_payload,
  type RuntimeUnionPayload,
  type RuntimeUnionPayloadField,
} from "./runtime_union_payload.ts";
import { static_type_value, type TypeStaticCtx } from "./type_static.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";

export type CoreAllocationReason =
  | "closure"
  | "runtime_aggregate"
  | "runtime_text"
  | "runtime_union";

export type CoreAllocationFact = {
  id: string;
  scope: string;
  storage: CoreStorageClass;
  ownership: CoreOwnership;
  reason: CoreAllocationReason;
  expression: CoreExpr["tag"];
};

export type CoreAllocationPlan = {
  facts: CoreAllocationFact[];
};

export type CoreAllocationHooks<ctx> = CoreOwnershipHooks<ctx> & {
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
  closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
  is_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => boolean;
  is_static_value_expr: (expr: CoreExpr, ctx: ctx) => boolean;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  scoped_static_core_call_value?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
};

type CoreAllocationState = {
  next_allocation: number;
  next_block: number;
  next_closure: number;
  next_scratch: number;
  facts: CoreAllocationFact[];
  recorded: WeakMap<CoreExpr, Set<string>>;
};

type CoreAllocationScope = {
  name: string;
  scratch: string | undefined;
};

export function core_allocation_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): CoreAllocationPlan {
  const state: CoreAllocationState = {
    next_allocation: 0,
    next_block: 0,
    next_closure: 0,
    next_scratch: 0,
    facts: [],
    recorded: new WeakMap(),
  };

  scan_allocation_stmts(
    core.statements,
    { name: "program#0", scratch: undefined },
    ctx,
    hooks,
    state,
  );

  return { facts: state.facts };
}

function scan_allocation_stmts<ctx>(
  statements: CoreStmt[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  for (const stmt of statements) {
    scan_allocation_stmt(stmt, scope, ctx, hooks, state);
  }
}

function scan_static_value_allocation_expr<ctx>(
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  record_runtime_union_owner: boolean,
): void {
  const struct_value = hooks.static_struct_value(expr, ctx);

  if (struct_value) {
    scan_allocation_fields(struct_value.fields, scope, ctx, hooks, state);
    return;
  }

  const union_value = hooks.runtime_union_value(expr, ctx);

  if (union_value) {
    if (record_runtime_union_owner) {
      record_static_runtime_union_owner_allocations(
        union_value,
        scope,
        ctx,
        hooks,
        state,
      );
      return;
    }

    scan_static_value_union_allocations(union_value, scope, ctx, hooks, state);
  }
}

function record_static_runtime_union_owner_allocations<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (value.tag === "if") {
    record_static_runtime_union_owner_allocations(
      value.then_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    record_static_runtime_union_owner_allocations(
      value.else_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    return;
  }

  if (value.tag !== "union_case") {
    record_allocation(value, "runtime_union", scope, state);
    return;
  }

  if (value.type_expr) {
    scan_allocation_expr(value.type_expr, scope, ctx, hooks, state);
  }

  if (value.value) {
    scan_allocation_expr(value.value, scope, ctx, hooks, state);
  }

  record_allocation(value, "runtime_union", scope, state);
}

function scan_static_value_union_allocations<ctx>(
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (expr.tag === "if") {
    scan_static_value_union_allocations(
      expr.then_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    scan_static_value_union_allocations(
      expr.else_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    return;
  }

  if (expr.tag !== "union_case") {
    return;
  }

  if (expr.value) {
    scan_allocation_expr(expr.value, scope, ctx, hooks, state);
  }
}

function static_value_materializes_runtime_union_owner<ctx>(
  expr: CoreExpr,
  has_annotation: boolean,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  if (ownership.reason !== "runtime_union") {
    return false;
  }

  if (has_annotation) {
    return true;
  }

  if (expr.tag === "union_case") {
    if (expr.type_expr) {
      return true;
    }

    return false;
  }

  return true;
}

function scan_allocation_stmt<ctx>(
  stmt: CoreStmt,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  switch (stmt.tag) {
    case "bind":
      if (
        allocation_stmt_value_is_scoped_static_call_target(stmt, ctx, hooks)
      ) {
        return;
      }

      if (hooks.is_static_value_expr(stmt.value, ctx)) {
        scan_static_value_allocation_expr(
          stmt.value,
          scope,
          ctx,
          hooks,
          state,
          static_value_materializes_runtime_union_owner(
            stmt.value,
            !!stmt.annotation,
            ctx,
            hooks,
          ),
        );
        return;
      }

      scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      return;

    case "assign":
      if (
        allocation_stmt_value_is_scoped_static_call_target(stmt, ctx, hooks)
      ) {
        return;
      }

      if (hooks.is_static_value_expr(stmt.value, ctx)) {
        scan_static_value_allocation_expr(
          stmt.value,
          scope,
          ctx,
          hooks,
          state,
          static_value_materializes_runtime_union_owner(
            stmt.value,
            false,
            ctx,
            hooks,
          ),
        );
        return;
      }

      scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      return;

    case "index_assign":
      scan_allocation_expr(stmt.index, scope, ctx, hooks, state);
      scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      return;

    case "range_loop":
      scan_allocation_expr(stmt.start, scope, ctx, hooks, state);
      scan_allocation_expr(stmt.end, scope, ctx, hooks, state);
      scan_allocation_expr(stmt.step, scope, ctx, hooks, state);
      scan_allocation_stmts(stmt.body, scope, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_allocation_expr(stmt.collection, scope, ctx, hooks, state);
      scan_allocation_stmts(stmt.body, scope, ctx, hooks, state);
      return;

    case "if_stmt":
      scan_allocation_expr(stmt.cond, scope, ctx, hooks, state);
      scan_allocation_stmts(stmt.body, scope, ctx, hooks, state);
      return;

    case "if_else_stmt":
      scan_allocation_expr(stmt.cond, scope, ctx, hooks, state);
      scan_allocation_stmts(stmt.then_body, scope, ctx, hooks, state);
      scan_allocation_stmts(stmt.else_body, scope, ctx, hooks, state);
      return;

    case "if_let_stmt":
      scan_allocation_if_let_stmt(stmt, scope, ctx, hooks, state);
      return;

    case "type_check":
      scan_allocation_expr(stmt.target, scope, ctx, hooks, state);
      return;

    case "return":
      scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      return;

    case "expr":
      scan_allocation_expr(stmt.expr, scope, ctx, hooks, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_allocation_expr<ctx>(
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
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
      if (hooks.static_text_value(expr, ctx)) {
        return;
      }

      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value) {
        record_runtime_union_allocations(union_value, scope, ctx, hooks, state);
        return;
      }

      if (hooks.static_struct_value(expr, ctx)) {
        record_allocation(expr, "runtime_aggregate", scope, state);
      }

      return;
    }

    case "lam":
    case "rec": {
      if (hooks.closure_fn_type(expr, ctx)) {
        record_allocation(expr, "closure", scope, state);
        scan_closure_body_allocations(expr, scope, ctx, hooks, state);
      }

      return;
    }

    case "prim":
      for (const arg of expr.args) {
        scan_allocation_expr(arg, scope, ctx, hooks, state);
      }

      if (hooks.is_runtime_text_concat(expr, ctx)) {
        record_allocation(expr, "runtime_text", scope, state);
      }

      return;

    case "app": {
      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value) {
        record_runtime_union_allocations(union_value, scope, ctx, hooks, state);
        return;
      }

      const inlined = hooks.static_core_call_value(expr, ctx);
      if (inlined) {
        scan_allocation_expr(inlined, scope, ctx, hooks, state);
        return;
      }

      const scoped = scoped_static_allocation_call_value(expr, ctx, hooks);

      if (scoped) {
        scan_allocation_expr(expr.func, scope, ctx, hooks, state);

        for (const arg of expr.args) {
          scan_allocation_expr(arg, scope, ctx, hooks, state);
        }

        scan_allocation_expr(scoped.value, scope, scoped.ctx, hooks, state);
        return;
      }

      scan_allocation_expr(expr.func, scope, ctx, hooks, state);
      for (const arg of expr.args) {
        scan_allocation_expr(arg, scope, ctx, hooks, state);
      }

      if (expr.func.tag === "var" && expr.func.name === "slice") {
        record_allocation(expr, "runtime_text", scope, state);
      }

      if (
        expr.func.tag === "var" && expr.func.name === "append" &&
        !hooks.closure_fn_type(expr.func, ctx)
      ) {
        record_allocation(expr, "runtime_text", scope, state);
      }

      return;
    }

    case "block": {
      const block = "block#" + state.next_block.toString();
      state.next_block += 1;
      scan_allocation_block(
        expr,
        { name: block, scratch: scope.scratch },
        ctx,
        hooks,
        state,
      );
      return;
    }

    case "comptime":
      scan_allocation_expr(expr.expr, scope, ctx, hooks, state);
      return;

    case "borrow":
      scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      return;

    case "freeze": {
      if (freeze_promotes_runtime_text(expr, ctx, hooks)) {
        scan_allocation_expr(expr.value, scope, ctx, hooks, state);

        if (scope.scratch) {
          record_allocation(
            expr,
            "runtime_text",
            { name: scope.name, scratch: undefined },
            state,
          );
        }

        return;
      }

      if (freeze_promotes_runtime_closure(expr, ctx, hooks)) {
        scan_allocation_expr(
          expr.value,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        return;
      }

      if (freeze_promotes_runtime_aggregate(expr, ctx, hooks)) {
        scan_allocation_expr(
          expr.value,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        return;
      }

      if (freeze_copies_runtime_aggregate(expr, ctx, hooks)) {
        record_runtime_aggregate_freeze_copy_allocations(
          expr,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        return;
      }

      if (freeze_promotes_runtime_union(expr, ctx, hooks)) {
        scan_allocation_expr(
          expr.value,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        return;
      }

      if (freeze_copies_runtime_union(expr, ctx, hooks)) {
        if (expr.value.tag !== "var") {
          scan_allocation_expr(expr.value, scope, ctx, hooks, state);
        }

        record_runtime_union_freeze_copy_allocations(
          expr,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        return;
      }

      scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      return;
    }

    case "scratch": {
      const scratch = "scratch#" + state.next_scratch.toString();
      state.next_scratch += 1;
      scan_allocation_expr(
        expr.body,
        { name: scratch, scratch },
        ctx,
        hooks,
        state,
      );
      return;
    }

    case "with":
      scan_allocation_expr(expr.base, scope, ctx, hooks, state);
      scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
      return;

    case "struct_value":
      record_allocation(expr, "runtime_aggregate", scope, state);
      scan_allocation_expr(expr.type_expr, scope, ctx, hooks, state);
      scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
      return;

    case "struct_update":
      scan_allocation_expr(expr.base, scope, ctx, hooks, state);
      scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
      return;

    case "if": {
      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value) {
        record_runtime_union_allocations(union_value, scope, ctx, hooks, state);
        return;
      }

      scan_allocation_expr(expr.cond, scope, ctx, hooks, state);
      scan_allocation_expr(expr.then_branch, scope, ctx, hooks, state);
      scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
      return;
    }

    case "if_let":
      scan_allocation_if_let_expr(expr, scope, ctx, hooks, state);
      return;

    case "field":
      scan_allocation_expr(expr.object, scope, ctx, hooks, state);
      return;

    case "index":
      scan_allocation_expr(expr.object, scope, ctx, hooks, state);
      scan_allocation_expr(expr.index, scope, ctx, hooks, state);
      return;

    case "union_case":
      record_allocation(expr, "runtime_union", scope, state);
      if (expr.type_expr) {
        scan_allocation_expr(expr.type_expr, scope, ctx, hooks, state);
      }
      if (expr.value) {
        scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      }
      return;
  }
}

function allocation_stmt_value_is_scoped_static_call_target<ctx>(
  stmt: Extract<CoreStmt, { tag: "bind" | "assign" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
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

function scoped_static_allocation_call_value<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
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

function scan_allocation_if_let_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  scan_allocation_expr(stmt.target, scope, ctx, hooks, state);

  if (
    !hooks.if_let_branch_ctx ||
    !hooks.static_union_case ||
    !hooks.dynamic_union_if ||
    !hooks.bind_core_if_let_payload_fact ||
    !hooks.bind_dynamic_if_let_payload
  ) {
    scan_allocation_stmts(stmt.body, scope, ctx, hooks, state);
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
    scan_allocation_stmts(stmt.body, scope, branch_ctx, hooks, state);
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
    scan_allocation_stmts(stmt.body, scope, branch_ctx, hooks, state);
    return;
  }

  if (
    hooks.runtime_union_target &&
    hooks.runtime_union_match_info &&
    hooks.static_runtime_union_match_branch_ctx
  ) {
    const runtime_target = hooks.runtime_union_target(stmt.target, ctx);

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        stmt.case_name,
        runtime_target,
        ctx,
      );
      const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
        stmt.value_name,
        info,
        ctx,
      );
      scan_allocation_stmts(stmt.body, scope, branch_ctx, hooks, state);
      return;
    }
  }

  scan_allocation_stmts(stmt.body, scope, ctx, hooks, state);
}

function scan_allocation_if_let_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  scan_allocation_expr(expr.target, scope, ctx, hooks, state);

  if (
    !hooks.if_let_branch_ctx ||
    !hooks.static_union_case ||
    !hooks.dynamic_union_if ||
    !hooks.bind_core_if_let_payload_fact ||
    !hooks.bind_dynamic_if_let_payload
  ) {
    scan_allocation_expr(expr.then_branch, scope, ctx, hooks, state);
    scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
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
      scan_allocation_expr(expr.then_branch, scope, branch_ctx, hooks, state);
      return;
    }

    scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
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
      scan_allocation_expr(expr.then_branch, scope, branch_ctx, hooks, state);
    }

    scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
    return;
  }

  if (
    hooks.runtime_union_target &&
    hooks.runtime_union_match_info &&
    hooks.static_runtime_union_match_branch_ctx
  ) {
    const runtime_target = hooks.runtime_union_target(expr.target, ctx);

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        expr.case_name,
        runtime_target,
        ctx,
      );
      const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
        expr.value_name,
        info,
        ctx,
      );
      scan_allocation_expr(expr.then_branch, scope, branch_ctx, hooks, state);
      scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
      return;
    }
  }

  scan_allocation_expr(expr.then_branch, scope, ctx, hooks, state);
  scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
}

function scan_allocation_block<ctx>(
  expr: Extract<CoreExpr, { tag: "block" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    scan_allocation_stmts(expr.statements, scope, ctx, hooks, state);
    return;
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (!stmt) {
      throw new Error("Missing allocation block statement");
    }

    const is_final = index + 1 >= expr.statements.length;
    scan_allocation_stmt(stmt, scope, block_ctx, hooks, state);

    if (!is_final) {
      hooks.collect_stmt_locals(stmt, block_ctx);
    }
  }
}

function scan_closure_body_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (!hooks.closure_body_ctx) {
    return;
  }

  const body_ctx = hooks.closure_body_ctx(expr, ctx);

  if (!body_ctx) {
    return;
  }

  const closure_scope = "closure#" + state.next_closure.toString();
  state.next_closure += 1;
  scan_allocation_expr(
    expr.body,
    { name: closure_scope, scratch: scope.scratch },
    body_ctx,
    hooks,
    state,
  );
}

function scan_allocation_fields<ctx>(
  fields: CoreField[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  for (const field of fields) {
    scan_allocation_expr(field.value, scope, ctx, hooks, state);
  }
}

function record_runtime_union_allocations<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (value.tag === "if") {
    record_runtime_union_allocations(
      value.then_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    record_runtime_union_allocations(
      value.else_branch,
      scope,
      ctx,
      hooks,
      state,
    );
    return;
  }

  record_allocation(value, "runtime_union", scope, state);

  if (value.tag !== "union_case") {
    return;
  }

  if (value.type_expr) {
    scan_allocation_expr(value.type_expr, scope, ctx, hooks, state);
  }

  if (value.value) {
    scan_allocation_expr(value.value, scope, ctx, hooks, state);
  }
}

function freeze_promotes_runtime_text<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  return ownership.reason === "text";
}

function freeze_promotes_runtime_closure<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  return ownership.reason === "closure";
}

function freeze_promotes_runtime_aggregate<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  if (ownership.reason !== "runtime_aggregate") {
    return false;
  }

  return expr.value.tag === "struct_value" &&
    !!hooks.static_struct_value(expr.value, ctx);
}

function freeze_copies_runtime_aggregate<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  if (ownership.reason !== "runtime_aggregate") {
    return false;
  }

  if (freeze_promotes_runtime_aggregate(expr, ctx, hooks)) {
    return false;
  }

  if (!hooks.runtime_aggregate_type_expr) {
    return false;
  }

  const type_expr = hooks.runtime_aggregate_type_expr(expr.value, ctx);

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

function record_runtime_aggregate_freeze_copy_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  expect_runtime_aggregate_type_expr(expr, ctx, hooks);
  record_allocation(expr, "runtime_aggregate", scope, state);
  record_runtime_aggregate_freeze_field_allocations(
    expr,
    scope,
    ctx,
    hooks,
    state,
  );
}

function record_runtime_aggregate_freeze_field_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  const type_expr = expect_runtime_aggregate_type_expr(expr, ctx, hooks);
  const layout = runtime_aggregate_layout_for_type(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  record_runtime_aggregate_freeze_text_allocations(
    expr,
    layout.fields,
    scope,
    ctx,
    state,
  );
}

function expect_runtime_aggregate_type_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): CoreExpr {
  expect(
    hooks.runtime_aggregate_type_expr,
    "Missing runtime aggregate allocation type hook",
  );
  const type_expr = hooks.runtime_aggregate_type_expr(expr.value, ctx);
  expect(type_expr, "Missing runtime aggregate freeze-copy type");
  return type_expr;
}

function record_runtime_aggregate_freeze_text_allocations(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  fields: RuntimeAggregateField[],
  scope: CoreAllocationScope,
  ctx: unknown,
  state: CoreAllocationState,
): void {
  for (const field of fields) {
    if (field.tag === "unit") {
      continue;
    }

    if (field.tag === "struct") {
      record_runtime_aggregate_freeze_text_allocations(
        expr,
        field.fields,
        scope,
        ctx,
        state,
      );
      continue;
    }

    if (field.union_type_expr) {
      record_allocation(expr, "runtime_union", scope, state);
      record_runtime_union_freeze_text_allocations(
        expr,
        field.union_type_expr,
        scope,
        ctx,
        state,
      );
      continue;
    }

    if (field.text) {
      record_allocation(
        expr,
        "runtime_text",
        scope,
        state,
      );
    }
  }
}

function freeze_promotes_runtime_union<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  if (ownership.reason !== "runtime_union") {
    return false;
  }

  const value = hooks.runtime_union_value(expr.value, ctx);

  if (!value) {
    return false;
  }

  return expr.value.tag !== "var" && value.tag === "union_case";
}

function freeze_copies_runtime_union<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  const ownership = core_expr_ownership(expr.value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  if (ownership.reason !== "runtime_union") {
    return false;
  }

  if (freeze_promotes_runtime_union(expr, ctx, hooks)) {
    return false;
  }

  const type_expr = runtime_union_freeze_copy_type_expr(expr.value, ctx, hooks);

  if (!type_expr) {
    return false;
  }

  return runtime_union_freeze_copy_supported(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
}

function record_runtime_union_freeze_copy_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  const type_expr = runtime_union_freeze_copy_type_expr(expr.value, ctx, hooks);
  expect(type_expr, "Missing runtime union freeze-copy type");
  record_allocation(expr, "runtime_union", scope, state);
  record_runtime_union_freeze_text_allocations(
    expr,
    type_expr,
    scope,
    ctx,
    state,
  );
}

function runtime_union_freeze_copy_type_expr<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): CoreExpr | undefined {
  const value = hooks.runtime_union_value(expr, ctx);

  if (value) {
    if (value.tag === "union_case") {
      return value.type_expr;
    }

    if (value.tag === "if") {
      return runtime_union_freeze_copy_type_expr(
        value.then_branch,
        ctx,
        hooks,
      );
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

function record_runtime_union_freeze_text_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  type_expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  state: CoreAllocationState,
): void {
  const type_value = static_type_value(type_expr, ctx as ctx & TypeStaticCtx);
  expect(
    type_value && type_value.tag === "union_type",
    "Core runtime union freeze-copy allocations require a union type",
  );

  for (const union_case of type_value.cases) {
    const payload = runtime_union_payload(
      union_case.type_name,
      ctx as ctx & TypeStaticCtx,
    );
    record_runtime_union_payload_text_allocations(
      expr,
      payload,
      scope,
      ctx,
      state,
    );
  }
}

function record_runtime_union_payload_text_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  payload: RuntimeUnionPayload,
  scope: CoreAllocationScope,
  ctx: ctx,
  state: CoreAllocationState,
): void {
  if (payload.tag === "aggregate") {
    record_runtime_aggregate_type_freeze_copy_allocations(
      expr,
      payload.type_expr,
      scope,
      ctx,
      state,
    );
    return;
  }

  if (payload.tag === "value") {
    if (payload.union_type_expr) {
      record_allocation(expr, "runtime_union", scope, state);
      record_runtime_union_freeze_text_allocations(
        expr,
        payload.union_type_expr,
        scope,
        ctx,
        state,
      );
      return;
    }

    if (payload.text) {
      record_allocation(expr, "runtime_text", scope, state);
    }

    return;
  }

  if (payload.tag !== "struct") {
    return;
  }

  record_runtime_union_payload_field_text_allocations(
    expr,
    payload.fields,
    scope,
    ctx,
    state,
  );
}

function record_runtime_aggregate_type_freeze_copy_allocations<ctx>(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  type_expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  state: CoreAllocationState,
): void {
  const layout = runtime_aggregate_layout_for_type(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  record_allocation(expr, "runtime_aggregate", scope, state);
  record_runtime_aggregate_freeze_text_allocations(
    expr,
    layout.fields,
    scope,
    ctx,
    state,
  );
}

function record_runtime_union_payload_field_text_allocations(
  expr: Extract<CoreExpr, { tag: "freeze" }>,
  fields: RuntimeUnionPayloadField[],
  scope: CoreAllocationScope,
  ctx: unknown,
  state: CoreAllocationState,
): void {
  for (const field of fields) {
    if (field.tag === "struct") {
      record_runtime_union_payload_field_text_allocations(
        expr,
        field.fields,
        scope,
        ctx,
        state,
      );
      continue;
    }

    if (field.union_type_expr) {
      record_allocation(expr, "runtime_union", scope, state);
      record_runtime_union_freeze_text_allocations(
        expr,
        field.union_type_expr,
        scope,
        ctx,
        state,
      );
      continue;
    }

    if (field.text) {
      record_allocation(expr, "runtime_text", scope, state);
    }
  }
}

function record_allocation(
  expr: CoreExpr,
  reason: CoreAllocationReason,
  scope: CoreAllocationScope,
  state: CoreAllocationState,
): void {
  const key = allocation_record_key(reason, scope);
  const recorded = state.recorded.get(expr);

  if (recorded) {
    if (recorded.has(key)) {
      return;
    }

    recorded.add(key);
  } else {
    state.recorded.set(expr, new Set([key]));
  }

  const base: CoreOwnership = {
    tag: "unique_heap",
    reason: ownership_reason(reason),
  };
  let ownership: CoreOwnership = base;

  if (scope.scratch && reason !== "closure") {
    ownership = { tag: "scratch_backed", source: base };
  }

  const fact: CoreAllocationFact = {
    id: "allocation#" + state.next_allocation.toString(),
    scope: scope.name,
    storage: core_storage_class(ownership),
    ownership,
    reason,
    expression: expr.tag,
  };
  state.next_allocation += 1;
  state.facts.push(fact);
}

function allocation_record_key(
  reason: CoreAllocationReason,
  scope: CoreAllocationScope,
): string {
  let scratch = "";

  if (scope.scratch) {
    scratch = scope.scratch;
  }

  return scope.name + "|" + scratch + "|" + reason;
}

function ownership_reason(
  reason: CoreAllocationReason,
): CoreOwnershipPointerReason {
  switch (reason) {
    case "closure":
      return "closure";

    case "runtime_aggregate":
      return "runtime_aggregate";

    case "runtime_text":
      return "text";

    case "runtime_union":
      return "runtime_union";
  }
}
