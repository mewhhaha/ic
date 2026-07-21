import { expect } from "../expect.ts";
import type { CoreStmt } from "./ast.ts";
import { clone_core_host_imports } from "./host_import.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./local_collect/types.ts";
import type { CoreLocalCollectorCallbacks } from "./local_collect_closure.ts";

export function collect_block_expr_locals(
  statements: CoreStmt[],
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  const block_ctx: CoreCtx = {
    locals: ctx.locals,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: ctx.materialized_bindings,
    mutable_bindings: ctx.mutable_bindings,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
  };

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    expect(stmt, "Missing core block statement " + index.toString());
    const is_final = index + 1 >= statements.length;

    if (is_final) {
      collect_final_stmt_expr_locals(stmt, block_ctx, hooks, callbacks);
      continue;
    }

    callbacks.collect_stmt_locals(stmt, block_ctx, hooks);
  }

  ctx.next_loop = block_ctx.next_loop;
  ctx.next_temp = block_ctx.next_temp;
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function collect_final_stmt_expr_locals(
  stmt: CoreStmt,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: Pick<CoreLocalCollectorCallbacks, "collect_expr_locals">,
): void {
  if (stmt.tag === "expr") {
    callbacks.collect_expr_locals(stmt.expr, ctx, hooks);
    return;
  }

  if (stmt.tag === "return") {
    callbacks.collect_expr_locals(stmt.value, ctx, hooks);
  }
}
