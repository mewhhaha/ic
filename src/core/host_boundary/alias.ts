import type { CoreExpr, CoreParam, CoreStmt } from "../ast.ts";
import {
  core_host_import_for_app,
  type CoreHostImportCtx,
} from "../host_import.ts";
import { core_expr_ownership, type CoreOwnership } from "../ownership.ts";
import type { StaticCoreCallCtx } from "../static_call.ts";
import type { CoreHostBoundaryHooks, CoreHostBoundaryState } from "./types.ts";
import { core_runtime_buffer_builtin } from "../runtime_buffer.ts";

export function record_host_boundary_stmt_alias(
  stmt: CoreStmt,
  state: CoreHostBoundaryState,
): void {
  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return;
  }

  if (stmt.value.tag === "var") {
    state.aliases.set(stmt.name, stmt.value);
    return;
  }

  if (stmt.value.tag === "borrow" && stmt.value.value.tag === "var") {
    state.aliases.set(stmt.name, stmt.value);
    return;
  }

  state.aliases.delete(stmt.name);
}

export function scan_host_boundary_with_shadowed_aliases(
  params: CoreParam[],
  state: CoreHostBoundaryState,
  scan: () => void,
): void {
  const previous_aliases = state.aliases;
  state.aliases = new Map(previous_aliases);

  for (const param of params) {
    state.aliases.delete(param.name);
  }

  try {
    scan();
  } finally {
    state.aliases = previous_aliases;
  }
}

export function host_boundary_arg_alias(
  arg: Extract<CoreExpr, { tag: "var" }>,
  state: CoreHostBoundaryState,
): CoreExpr | undefined {
  const seen = new Set<string>();
  let current = arg.name;
  let resolved = false;

  while (true) {
    if (seen.has(current)) {
      return undefined;
    }

    seen.add(current);
    const alias = state.aliases.get(current);

    if (!alias) {
      if (resolved) {
        return { tag: "var", name: current };
      }

      return undefined;
    }

    if (alias.tag !== "var") {
      return alias;
    }

    resolved = true;
    current = alias.name;
  }
}

export function host_boundary_arg_ownership<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  arg: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): CoreOwnership {
  if (arg.tag === "var") {
    const alias = host_boundary_arg_alias(arg, state);

    if (alias) {
      return host_boundary_arg_ownership(alias, ctx, hooks, state);
    }

    const scratch_local = state.scratch_locals.get(arg.name);

    if (scratch_local) {
      return scratch_local;
    }
  }

  if (arg.tag === "borrow" && arg.value.tag === "var") {
    const alias = host_boundary_arg_alias(arg.value, state);

    if (alias) {
      return host_boundary_arg_ownership(
        {
          tag: "borrow",
          value: alias,
        },
        ctx,
        hooks,
        state,
      );
    }

    const scratch_local = state.scratch_locals.get(arg.value.name);

    if (scratch_local) {
      return {
        tag: "borrow_view",
        source: scratch_local,
      };
    }
  }

  const ownership = core_expr_ownership(arg, ctx, hooks);

  if (ownership.tag === "scratch_backed") {
    return ownership;
  }

  if (state.scratch_depth === 0) {
    return ownership;
  }

  if (ownership.tag !== "unique_heap") {
    return ownership;
  }

  if (!host_boundary_expr_allocates_in_scratch(arg, ctx, hooks)) {
    return ownership;
  }

  return {
    tag: "scratch_backed",
    source: ownership,
  };
}

export function record_host_boundary_scratch_local<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  if (!host_boundary_expr_allocates_in_scratch(value, ctx, hooks)) {
    state.scratch_locals.delete(name);
    return;
  }

  const ownership = core_expr_ownership(value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    state.scratch_locals.delete(name);
    return;
  }

  state.scratch_locals.set(name, {
    tag: "scratch_backed",
    source: ownership,
  });
}

function host_boundary_expr_allocates_in_scratch<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
): boolean {
  if (core_runtime_buffer_builtin(expr)) {
    return true;
  }

  if (expr.tag === "app") {
    if (core_host_import_for_app(expr, ctx)) {
      return false;
    }

    if (expr.func.tag === "var" && expr.func.name === "@append") {
      if (!hooks.closure_fn_type(expr.func, ctx)) {
        return true;
      }
    }

    if (expr.func.tag === "var" && expr.func.name === "@Bytes.generate") {
      return true;
    }

    if (expr.func.tag === "var" && expr.func.name === "@slice") {
      return true;
    }

    return false;
  }

  if (expr.tag === "struct_value") {
    return true;
  }

  if (expr.tag === "union_case") {
    return true;
  }

  if (expr.tag === "lam") {
    return hooks.closure_fn_type(expr, ctx) !== undefined;
  }

  if (expr.tag === "block") {
    const last = expr.statements[expr.statements.length - 1];

    if (!last) {
      return false;
    }

    if (last.tag === "expr") {
      return host_boundary_expr_allocates_in_scratch(last.expr, ctx, hooks);
    }

    if (last.tag === "return") {
      return host_boundary_expr_allocates_in_scratch(last.value, ctx, hooks);
    }

    return false;
  }

  return false;
}
