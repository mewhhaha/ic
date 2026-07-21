import type { ValType } from "../op.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreFnType,
  CoreStmt,
} from "./ast.ts";
import { collect_core_expr_locals } from "./local_collect/expr.ts";
import { collect_core_stmt_locals } from "./local_collect/stmt.ts";
import type {
  CoreCtx,
  CoreLocalCollectHooks,
  StaticCtx,
} from "./local_collect/types.ts";
import {
  clone_core_host_imports,
  core_host_import_map,
} from "./host_import.ts";
import {
  core_materialized_bindings,
  core_mutable_bindings,
} from "./mutable_bindings.ts";
import { bind_core_function_params } from "./function_params.ts";

export type {
  CoreCtx,
  CoreLocalCollectHooks,
  StaticCtx,
  TempCtx,
} from "./local_collect/types.ts";

export function create_rec_call_ctx(ctx: StaticCtx): StaticCtx {
  return {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
  };
}

export function create_core_block_ctx(ctx: StaticCtx): CoreCtx {
  return {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
    next_loop: 0,
    next_temp: 0,
  };
}

export function collect_core_ctx(
  core: CoreNode,
  hooks: CoreLocalCollectHooks,
): CoreCtx {
  const locals = new Map<string, ValType>();
  const static_capture_values = new Map<string, CoreExpr>();
  const statics = new Map<string, CoreExpr>();
  const fn_types = new Map<string, CoreFnType>();
  const text_locals = new Set<string>();
  const struct_locals = new Map<string, CoreExpr>();
  const union_locals = new Map<string, CoreExpr>();
  const borrowed_locals = new Set<string>();
  const frozen_locals = new Set<string>();
  const ctx: CoreCtx = {
    locals,
    static_capture_values,
    statics,
    fn_types,
    text_locals,
    struct_locals,
    union_locals,
    borrowed_locals,
    frozen_locals,
    host_imports: core_host_import_map(core),
    scratch_depth: 0,
    materialized_bindings: core_materialized_bindings(core),
    mutable_bindings: core_mutable_bindings(core),
    next_loop: 0,
    next_temp: 0,
  };

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];

    if (!stmt) {
      throw new Error("Missing core statement " + index.toString());
    }

    if (
      core.function_params !== undefined &&
      index + 1 === core.statements.length
    ) {
      bind_core_function_params(core.function_params, ctx);
    }

    collect_stmt_locals(stmt, ctx, hooks);
  }

  return ctx;
}

export function collect_stmt_locals(
  stmt: CoreStmt,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  collect_core_stmt_locals(stmt, ctx, hooks, {
    collect_expr_locals,
    collect_stmt_locals,
  });
}

export function collect_expr_locals(
  expr: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  collect_core_expr_locals(expr, ctx, hooks, {
    collect_expr_locals,
    collect_stmt_locals,
  });
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function clone_optional_map<key, value>(
  value: Map<key, value> | undefined,
): Map<key, value> | undefined {
  if (!value) {
    return undefined;
  }

  return new Map(value);
}
