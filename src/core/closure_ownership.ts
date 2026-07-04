import type { Core, CoreExpr, CoreStmt } from "./ast.ts";
import type { CoreCaptureInfo } from "./closure_capture.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";

export type CoreClosureCaptureDecision =
  | {
    tag: "allowed";
    reason: string;
  }
  | {
    tag: "reserved";
    reason: string;
  };

export type CoreClosureCaptureSlot = {
  name: string;
  ownership: CoreOwnership;
  decision: CoreClosureCaptureDecision;
};

export type CoreClosureOwnershipEdge = {
  id: string;
  scope: string;
  expression: "lam" | "rec";
  captures: CoreClosureCaptureSlot[];
  decision: CoreClosureCaptureDecision;
};

export type CoreClosureOwnershipPlan = {
  edges: CoreClosureOwnershipEdge[];
};

export type CoreClosureOwnershipHooks<ctx> = CoreOwnershipHooks<ctx> & {
  block_ctx: (ctx: ctx) => ctx;
  collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
  core_lam_capture_info: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => CoreCaptureInfo;
};

type CoreClosureOwnershipState = {
  next_block: number;
  edges: CoreClosureOwnershipEdge[];
};

type CoreClosureOwnershipFacts = {
  borrow_views: Map<string, CoreOwnership>;
  scratch_locals: Map<string, CoreOwnership>;
  scratch_depth: number;
  direct_call_depth: number;
};

export function core_closure_ownership_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreClosureOwnershipPlan {
  const state: CoreClosureOwnershipState = {
    next_block: 0,
    edges: [],
  };

  scan_closure_ownership_stmts(
    core.statements,
    "program#0",
    ctx,
    empty_closure_ownership_facts(),
    hooks,
    state,
  );

  return { edges: state.edges };
}

function scan_closure_ownership_stmts<ctx>(
  statements: CoreStmt[],
  scope: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
  state: CoreClosureOwnershipState,
): void {
  for (const stmt of statements) {
    scan_closure_ownership_stmt(stmt, scope, ctx, facts, hooks, state);
  }
}

function scan_closure_ownership_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
  state: CoreClosureOwnershipState,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      scan_closure_ownership_expr(stmt.value, scope, ctx, facts, hooks, state);
      record_closure_local_ownership_fact(
        stmt.name,
        stmt.value,
        ctx,
        facts,
        hooks,
      );
      try_collect_stmt_locals(stmt, ctx, hooks);
      return;

    case "index_assign":
      scan_closure_ownership_expr(stmt.index, scope, ctx, facts, hooks, state);
      scan_closure_ownership_expr(stmt.value, scope, ctx, facts, hooks, state);
      try_collect_stmt_locals(stmt, ctx, hooks);
      return;

    case "range_loop": {
      scan_closure_ownership_expr(stmt.start, scope, ctx, facts, hooks, state);
      scan_closure_ownership_expr(stmt.end, scope, ctx, facts, hooks, state);
      scan_closure_ownership_expr(stmt.step, scope, ctx, facts, hooks, state);
      const body_ctx = hooks.block_ctx(ctx);
      try_collect_stmt_locals(stmt, ctx, hooks);
      scan_closure_ownership_stmts(
        stmt.body,
        scope,
        body_ctx,
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      return;
    }

    case "collection_loop": {
      scan_closure_ownership_expr(
        stmt.collection,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      const body_ctx = hooks.block_ctx(ctx);
      try_collect_stmt_locals(stmt, ctx, hooks);
      scan_closure_ownership_stmts(
        stmt.body,
        scope,
        body_ctx,
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      return;
    }

    case "if_stmt": {
      scan_closure_ownership_expr(stmt.cond, scope, ctx, facts, hooks, state);
      const body_ctx = hooks.block_ctx(ctx);
      scan_closure_ownership_stmts(
        stmt.body,
        scope,
        body_ctx,
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      try_collect_stmt_locals(stmt, ctx, hooks);
      return;
    }

    case "if_else_stmt": {
      scan_closure_ownership_expr(stmt.cond, scope, ctx, facts, hooks, state);
      scan_closure_ownership_stmts(
        stmt.then_body,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      scan_closure_ownership_stmts(
        stmt.else_body,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      try_collect_stmt_locals(stmt, ctx, hooks);
      return;
    }

    case "if_let_stmt": {
      scan_closure_ownership_expr(stmt.target, scope, ctx, facts, hooks, state);
      scan_closure_ownership_stmts(
        stmt.body,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      try_collect_stmt_locals(stmt, ctx, hooks);
      return;
    }

    case "type_check":
      scan_closure_ownership_expr(stmt.target, scope, ctx, facts, hooks, state);
      return;

    case "return":
      scan_closure_ownership_expr(stmt.value, scope, ctx, facts, hooks, state);
      return;

    case "expr":
      scan_closure_ownership_expr(stmt.expr, scope, ctx, facts, hooks, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_closure_ownership_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
  state: CoreClosureOwnershipState,
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
      return;

    case "lam":
    case "rec":
      record_closure_ownership_edge(expr, scope, ctx, facts, hooks, state);
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_closure_ownership_expr(arg, scope, ctx, facts, hooks, state);
      }
      return;

    case "app":
      {
        const func_facts = clone_closure_ownership_facts(facts);

        if (expr.func.tag === "lam" || expr.func.tag === "rec") {
          func_facts.direct_call_depth += 1;
        }

        scan_closure_ownership_expr(
          expr.func,
          scope,
          ctx,
          func_facts,
          hooks,
          state,
        );
      }
      for (const arg of expr.args) {
        scan_closure_ownership_expr(arg, scope, ctx, facts, hooks, state);
      }
      return;

    case "block": {
      const block_ctx = hooks.block_ctx(ctx);
      const block_scope = scope + "/block#" + state.next_block.toString();
      state.next_block += 1;
      scan_closure_ownership_stmts(
        expr.statements,
        block_scope,
        block_ctx,
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      return;
    }

    case "comptime":
      scan_closure_ownership_expr(expr.expr, scope, ctx, facts, hooks, state);
      return;

    case "borrow":
    case "freeze":
      scan_closure_ownership_expr(expr.value, scope, ctx, facts, hooks, state);
      return;

    case "scratch": {
      const scratch_facts = clone_closure_ownership_facts(facts);
      scratch_facts.scratch_depth += 1;
      scan_closure_ownership_expr(
        expr.body,
        scope,
        ctx,
        scratch_facts,
        hooks,
        state,
      );
      return;
    }

    case "with":
      scan_closure_ownership_expr(expr.base, scope, ctx, facts, hooks, state);
      scan_closure_ownership_fields(
        expr.fields,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      return;

    case "struct_value":
      scan_closure_ownership_expr(
        expr.type_expr,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      scan_closure_ownership_fields(
        expr.fields,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      return;

    case "struct_update":
      scan_closure_ownership_expr(expr.base, scope, ctx, facts, hooks, state);
      scan_closure_ownership_fields(
        expr.fields,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      return;

    case "if":
      scan_closure_ownership_expr(expr.cond, scope, ctx, facts, hooks, state);
      scan_closure_ownership_expr(
        expr.then_branch,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      scan_closure_ownership_expr(
        expr.else_branch,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      return;

    case "if_let":
      scan_closure_ownership_expr(expr.target, scope, ctx, facts, hooks, state);
      scan_closure_ownership_expr(
        expr.then_branch,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      scan_closure_ownership_expr(
        expr.else_branch,
        scope,
        hooks.block_ctx(ctx),
        clone_closure_ownership_facts(facts),
        hooks,
        state,
      );
      return;

    case "field":
      scan_closure_ownership_expr(expr.object, scope, ctx, facts, hooks, state);
      return;

    case "index":
      scan_closure_ownership_expr(
        expr.object,
        scope,
        ctx,
        facts,
        hooks,
        state,
      );
      scan_closure_ownership_expr(expr.index, scope, ctx, facts, hooks, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_closure_ownership_expr(
          expr.value,
          scope,
          ctx,
          facts,
          hooks,
          state,
        );
      }
      if (expr.type_expr) {
        scan_closure_ownership_expr(
          expr.type_expr,
          scope,
          ctx,
          facts,
          hooks,
          state,
        );
      }
      return;
  }
}

function record_closure_ownership_edge<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  scope: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
  state: CoreClosureOwnershipState,
): void {
  const capture_expr = lam_capture_expr(expr);
  const info = try_lam_capture_info(capture_expr, ctx, hooks);

  if (!info) {
    return;
  }

  const captures: CoreClosureCaptureSlot[] = [];

  for (const name of info.names) {
    const ownership = try_capture_ownership(name, ctx, facts, hooks);

    if (!ownership) {
      continue;
    }

    captures.push({
      name,
      ownership,
      decision: closure_capture_decision(ownership, expr, facts),
    });
  }

  if (captures.length === 0) {
    return;
  }

  state.edges.push({
    id: "closure_capture#" + state.edges.length.toString(),
    scope,
    expression: expr.tag,
    captures,
    decision: merge_closure_capture_decisions(captures),
  });
}

function lam_capture_expr(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
): Extract<CoreExpr, { tag: "lam" }> {
  if (expr.tag === "lam") {
    return expr;
  }

  return {
    tag: "lam",
    params: expr.params,
    body: expr.body,
  };
}

function closure_capture_decision(
  ownership: CoreOwnership,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  facts: CoreClosureOwnershipFacts,
): CoreClosureCaptureDecision {
  if (ownership.tag === "scalar_local") {
    return {
      tag: "allowed",
      reason: "scalar capture is copyable",
    };
  }

  if (ownership.tag === "frozen_shareable") {
    return {
      tag: "allowed",
      reason: "frozen/shareable capture is reusable",
    };
  }

  if (
    ownership.tag === "unique_heap" &&
    ownership.reason === "runtime_aggregate"
  ) {
    return {
      tag: "allowed",
      reason: "runtime aggregate pointer capture is supported",
    };
  }

  if (
    ownership.tag === "unique_heap" &&
    ownership.reason === "closure"
  ) {
    return {
      tag: "allowed",
      reason: "closure pointer capture is supported",
    };
  }

  if (
    ownership.tag === "unique_heap" &&
    ownership.reason === "runtime_union"
  ) {
    return {
      tag: "allowed",
      reason: "runtime union pointer capture is supported",
    };
  }

  if (
    ownership.tag === "scratch_backed" &&
    facts.scratch_depth > 0 &&
    facts.direct_call_depth > 0 &&
    !closure_body_contains_closure_value(expr.body)
  ) {
    return {
      tag: "allowed",
      reason: "scratch-backed capture is valid for an immediate non-escaping " +
        "closure call inside scratchpad",
    };
  }

  return {
    tag: "reserved",
    reason: core_ownership_result_text(ownership) +
      " capture requires linear closure ownership support",
  };
}

function merge_closure_capture_decisions(
  captures: CoreClosureCaptureSlot[],
): CoreClosureCaptureDecision {
  for (const capture of captures) {
    if (capture.decision.tag === "reserved") {
      return {
        tag: "reserved",
        reason: capture.name + ": " + capture.decision.reason,
      };
    }
  }

  return {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  };
}

function scan_closure_ownership_fields<ctx>(
  fields: { value: CoreExpr }[],
  scope: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
  state: CoreClosureOwnershipState,
): void {
  for (const field of fields) {
    scan_closure_ownership_expr(
      field.value,
      scope,
      ctx,
      facts,
      hooks,
      state,
    );
  }
}

function empty_closure_ownership_facts(): CoreClosureOwnershipFacts {
  return {
    borrow_views: new Map(),
    scratch_locals: new Map(),
    scratch_depth: 0,
    direct_call_depth: 0,
  };
}

function clone_closure_ownership_facts(
  facts: CoreClosureOwnershipFacts,
): CoreClosureOwnershipFacts {
  return {
    borrow_views: new Map(facts.borrow_views),
    scratch_locals: new Map(facts.scratch_locals),
    scratch_depth: facts.scratch_depth,
    direct_call_depth: facts.direct_call_depth,
  };
}

function closure_body_contains_closure_value(expr: CoreExpr): boolean {
  switch (expr.tag) {
    case "lam":
    case "rec":
      return true;

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "prim":
      for (const arg of expr.args) {
        if (closure_body_contains_closure_value(arg)) {
          return true;
        }
      }
      return false;

    case "app":
      if (closure_body_contains_closure_value(expr.func)) {
        return true;
      }

      for (const arg of expr.args) {
        if (closure_body_contains_closure_value(arg)) {
          return true;
        }
      }
      return false;

    case "block":
      for (const stmt of expr.statements) {
        if (closure_stmt_contains_closure_value(stmt)) {
          return true;
        }
      }
      return false;

    case "comptime":
      return closure_body_contains_closure_value(expr.expr);

    case "borrow":
    case "freeze":
      return closure_body_contains_closure_value(expr.value);

    case "scratch":
      return closure_body_contains_closure_value(expr.body);

    case "with":
      if (closure_body_contains_closure_value(expr.base)) {
        return true;
      }
      return closure_fields_contain_closure_value(expr.fields);

    case "struct_value":
      if (closure_body_contains_closure_value(expr.type_expr)) {
        return true;
      }
      return closure_fields_contain_closure_value(expr.fields);

    case "struct_update":
      if (closure_body_contains_closure_value(expr.base)) {
        return true;
      }
      return closure_fields_contain_closure_value(expr.fields);

    case "if":
      return closure_body_contains_closure_value(expr.cond) ||
        closure_body_contains_closure_value(expr.then_branch) ||
        closure_body_contains_closure_value(expr.else_branch);

    case "if_let":
      return closure_body_contains_closure_value(expr.target) ||
        closure_body_contains_closure_value(expr.then_branch) ||
        closure_body_contains_closure_value(expr.else_branch);

    case "field":
      return closure_body_contains_closure_value(expr.object);

    case "index":
      return closure_body_contains_closure_value(expr.object) ||
        closure_body_contains_closure_value(expr.index);

    case "union_case":
      if (expr.value) {
        if (closure_body_contains_closure_value(expr.value)) {
          return true;
        }
      }

      if (expr.type_expr) {
        return closure_body_contains_closure_value(expr.type_expr);
      }

      return false;
  }
}

function closure_stmt_contains_closure_value(stmt: CoreStmt): boolean {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      return closure_body_contains_closure_value(stmt.value);

    case "index_assign":
      return closure_body_contains_closure_value(stmt.index) ||
        closure_body_contains_closure_value(stmt.value);

    case "type_check":
      return closure_body_contains_closure_value(stmt.target);

    case "expr":
      return closure_body_contains_closure_value(stmt.expr);

    case "return":
      return closure_body_contains_closure_value(stmt.value);

    case "range_loop":
      if (closure_body_contains_closure_value(stmt.start)) {
        return true;
      }

      if (closure_body_contains_closure_value(stmt.end)) {
        return true;
      }

      if (closure_body_contains_closure_value(stmt.step)) {
        return true;
      }

      for (const body_stmt of stmt.body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      return false;

    case "collection_loop":
      if (closure_body_contains_closure_value(stmt.collection)) {
        return true;
      }

      for (const body_stmt of stmt.body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      return false;

    case "if_stmt":
      if (closure_body_contains_closure_value(stmt.cond)) {
        return true;
      }

      for (const body_stmt of stmt.body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      return false;

    case "if_else_stmt":
      if (closure_body_contains_closure_value(stmt.cond)) {
        return true;
      }

      for (const body_stmt of stmt.then_body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      for (const body_stmt of stmt.else_body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      return false;

    case "if_let_stmt":
      if (closure_body_contains_closure_value(stmt.target)) {
        return true;
      }

      for (const body_stmt of stmt.body) {
        if (closure_stmt_contains_closure_value(body_stmt)) {
          return true;
        }
      }

      return false;

    case "break":
    case "continue":
    case "unsupported":
      return false;
  }
}

function closure_fields_contain_closure_value(
  fields: { value: CoreExpr }[],
): boolean {
  for (const field of fields) {
    if (closure_body_contains_closure_value(field.value)) {
      return true;
    }
  }

  return false;
}

function record_closure_local_ownership_fact<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): void {
  facts.borrow_views.delete(name);
  facts.scratch_locals.delete(name);

  const borrow_view = closure_borrow_view_ownership(value, ctx, facts, hooks);

  if (borrow_view) {
    facts.borrow_views.set(name, borrow_view);
    return;
  }

  const scratch_local = closure_scratch_local_ownership(
    value,
    ctx,
    facts,
    hooks,
  );

  if (scratch_local) {
    facts.scratch_locals.set(name, scratch_local);
  }
}

function closure_borrow_view_ownership<ctx>(
  value: CoreExpr,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  if (value.tag !== "borrow") {
    return undefined;
  }

  const source = closure_expr_ownership(value.value, ctx, facts, hooks);

  if (!source) {
    return undefined;
  }

  if (
    source.tag === "scalar_local" ||
    source.tag === "frozen_shareable"
  ) {
    return undefined;
  }

  return {
    tag: "borrow_view",
    source,
  };
}

function closure_scratch_local_ownership<ctx>(
  value: CoreExpr,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  if (facts.scratch_depth === 0) {
    return undefined;
  }

  if (!closure_expr_allocates_in_scratch(value)) {
    return undefined;
  }

  const ownership = closure_expr_ownership(value, ctx, facts, hooks);

  if (!ownership) {
    return undefined;
  }

  if (ownership.tag !== "unique_heap") {
    return undefined;
  }

  return {
    tag: "scratch_backed",
    source: ownership,
  };
}

function closure_expr_ownership<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  if (expr.tag === "var") {
    const borrow_view = facts.borrow_views.get(expr.name);

    if (borrow_view) {
      return borrow_view;
    }

    const scratch_local = facts.scratch_locals.get(expr.name);

    if (scratch_local) {
      return scratch_local;
    }
  }

  try {
    return core_expr_ownership(expr, ctx, hooks);
  } catch {
    return undefined;
  }
}

function closure_expr_allocates_in_scratch(expr: CoreExpr): boolean {
  if (expr.tag === "app" && expr.func.tag === "var") {
    if (expr.func.name === "append") {
      return true;
    }

    if (expr.func.name === "slice") {
      return true;
    }
  }

  if (expr.tag === "struct_value") {
    return true;
  }

  if (expr.tag === "union_case") {
    return true;
  }

  return false;
}

function try_collect_stmt_locals<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreClosureOwnershipHooks<ctx>,
): void {
  try {
    hooks.collect_stmt_locals(stmt, ctx);
  } catch {
    return;
  }
}

function try_lam_capture_info<ctx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreCaptureInfo | undefined {
  try {
    return hooks.core_lam_capture_info(expr, ctx);
  } catch {
    return undefined;
  }
}

function try_capture_ownership<ctx>(
  name: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  const borrow_view = facts.borrow_views.get(name);

  if (borrow_view) {
    return borrow_view;
  }

  const scratch_local = facts.scratch_locals.get(name);

  if (scratch_local) {
    return scratch_local;
  }

  try {
    return core_expr_ownership(
      { tag: "var", name },
      ctx,
      hooks,
    );
  } catch {
    return undefined;
  }
}
