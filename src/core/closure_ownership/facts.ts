import type { CoreExpr } from "../ast.ts";
import { core_expr_ownership, type CoreOwnership } from "../ownership.ts";
import type {
  CoreClosureOwnershipCtx,
  CoreClosureOwnershipFacts,
  CoreClosureOwnershipHooks,
} from "./types.ts";
import { core_runtime_buffer_builtin } from "../runtime_buffer.ts";

export function empty_closure_ownership_facts(): CoreClosureOwnershipFacts {
  return {
    borrow_views: new Map(),
    scratch_locals: new Map(),
    scratch_depth: 0,
    direct_call_depth: 0,
    linear_names: new Set(),
    linear_ownerships: new Map(),
  };
}

export function clone_closure_ownership_facts(
  facts: CoreClosureOwnershipFacts,
): CoreClosureOwnershipFacts {
  return {
    borrow_views: new Map(facts.borrow_views),
    scratch_locals: new Map(facts.scratch_locals),
    scratch_depth: facts.scratch_depth,
    direct_call_depth: facts.direct_call_depth,
    linear_names: new Set(facts.linear_names),
    linear_ownerships: new Map(facts.linear_ownerships),
  };
}

export function record_closure_local_ownership_fact<
  ctx extends CoreClosureOwnershipCtx,
>(
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

function closure_borrow_view_ownership<ctx extends CoreClosureOwnershipCtx>(
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

function closure_scratch_local_ownership<ctx extends CoreClosureOwnershipCtx>(
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

function closure_expr_ownership<ctx extends CoreClosureOwnershipCtx>(
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
  if (core_runtime_buffer_builtin(expr)) {
    return true;
  }

  if (expr.tag === "app" && expr.func.tag === "var") {
    if (expr.func.name === "@Bytes.generate") {
      return true;
    }

    if (expr.func.name === "@append") {
      return true;
    }

    if (expr.func.name === "@slice") {
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

export function try_capture_ownership<ctx extends CoreClosureOwnershipCtx>(
  name: string,
  ctx: ctx,
  facts: CoreClosureOwnershipFacts,
  hooks: CoreClosureOwnershipHooks<ctx>,
): CoreOwnership | undefined {
  const linear_ownership = facts.linear_ownerships.get(name);

  if (linear_ownership) {
    return linear_ownership;
  }

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
