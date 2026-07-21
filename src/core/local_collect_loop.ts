import { expect } from "../expect.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import { set_local } from "./emit/local.ts";
import { static_i32 } from "./analysis/static_i32.ts";
import {
  text_collection_end_local,
  text_collection_index_local,
  text_collection_value_local,
} from "./collection_loop.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./local_collect/types.ts";
import type { CoreLocalCollectorCallbacks } from "./local_collect_closure.ts";
import { range_end_local, range_step_local } from "./range_loop.ts";
import {
  core_runtime_slice_fact,
  runtime_slice_end_local,
  runtime_slice_index_local,
  runtime_slice_value_local,
} from "./runtime_slice.ts";

export function collect_range_loop_stmt_locals(
  stmt: Extract<CoreStmt, { tag: "range_loop" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: Pick<CoreLocalCollectorCallbacks, "collect_stmt_locals">,
): void {
  reject_static_carried_loop_values(stmt.carried, ctx, "range");
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const start_type = hooks.expr_type(stmt.start, ctx);
  const end_type = hooks.expr_type(stmt.end, ctx);
  const step_type = hooks.expr_type(stmt.step, ctx);
  expect(start_type === "i32", "Core range loop start must be i32");
  expect(end_type === "i32", "Core range loop end must be i32");
  expect(step_type === "i32", "Core range loop step must be i32");

  if (stmt.step.tag === "num") {
    const step = static_i32(stmt.step, "range loop step");
    expect(step !== 0, "Core range loop step must be nonzero");
  }

  set_local(ctx.locals, range_end_local(id), "i32");
  set_local(ctx.locals, range_step_local(id), "i32");
  clear_loop_binding(stmt.index, ctx);
  set_local(ctx.locals, stmt.index, "i32");

  for (const item of stmt.body) {
    callbacks.collect_stmt_locals(item, ctx, hooks);
  }

  reject_static_carried_loop_values(stmt.carried, ctx, "range");
}

export function collect_collection_loop_stmt_locals(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const fields = hooks.static_collection_fields(stmt.collection, ctx);

  const slice = core_runtime_slice_fact(stmt.collection);
  if (slice) {
    callbacks.collect_expr_locals(stmt.collection, ctx, hooks);
    if (stmt.index) {
      clear_loop_binding(stmt.index, ctx);
      set_local(ctx.locals, stmt.index, "i32");
    } else {
      set_local(ctx.locals, runtime_slice_index_local(id), "i32");
    }
    clear_loop_binding(stmt.item, ctx);
    set_local(ctx.locals, stmt.item, "i32");
    if (slice.element_type === "Text") {
      ctx.text_locals.add(stmt.item);
      if (ctx.frozen_locals) {
        ctx.frozen_locals.add(stmt.item);
      }
    }
    set_local(ctx.locals, runtime_slice_value_local(id), "i32");
    set_local(ctx.locals, runtime_slice_end_local(id), "i32");
    for (const item of stmt.body) {
      callbacks.collect_stmt_locals(item, ctx, hooks);
    }
    return;
  }

  if (fields) {
    collect_static_collection_loop_stmt_locals(
      stmt,
      fields,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  const text = hooks.static_text_value(stmt.collection, ctx);

  if (!text && !hooks.core_expr_is_text(stmt.collection, ctx)) {
    return;
  }

  reject_static_carried_loop_values(stmt.carried, ctx, "collection");
  callbacks.collect_expr_locals(stmt.collection, ctx, hooks);

  if (stmt.index) {
    clear_loop_binding(stmt.index, ctx);
    set_local(ctx.locals, stmt.index, "i32");
  } else {
    set_local(ctx.locals, text_collection_index_local(id), "i32");
  }

  clear_loop_binding(stmt.item, ctx);
  set_local(ctx.locals, stmt.item, "i32");
  set_local(ctx.locals, text_collection_value_local(id), "i32");
  set_local(ctx.locals, text_collection_end_local(id), "i32");

  for (const item of stmt.body) {
    callbacks.collect_stmt_locals(item, ctx, hooks);
  }

  reject_static_carried_loop_values(stmt.carried, ctx, "collection");
}

function collect_static_collection_loop_stmt_locals(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  fields: NonNullable<
    ReturnType<CoreLocalCollectHooks["static_collection_fields"]>
  >,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: Pick<CoreLocalCollectorCallbacks, "collect_stmt_locals">,
): void {
  if (stmt.index) {
    clear_loop_binding(stmt.index, ctx);
    set_local(ctx.locals, stmt.index, "i32");
  }

  const item_type = hooks.static_collection_item_type(fields, ctx);

  if (item_type) {
    clear_loop_binding(stmt.item, ctx);
    set_local(ctx.locals, stmt.item, item_type);
    const first = fields[0];

    if (first !== undefined) {
      hooks.bind_core_struct_type(stmt.item, first.value, undefined, ctx);
      hooks.bind_core_union_type(stmt.item, first.value, undefined, ctx);
    }

    bind_static_collection_item_text_fact(stmt.item, fields, ctx, hooks);
  }

  for (const _field of fields) {
    for (const item of stmt.body) {
      callbacks.collect_stmt_locals(item, ctx, hooks);
    }
  }
}

function bind_static_collection_item_text_fact(
  name: string,
  fields: NonNullable<
    ReturnType<CoreLocalCollectHooks["static_collection_fields"]>
  >,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  let result: boolean | undefined;

  for (const field of fields) {
    const is_text = hooks.core_expr_is_text(field.value, ctx);

    if (result === undefined) {
      result = is_text;
    } else {
      expect(
        result === is_text,
        "Core collection item text fact mismatch",
      );
    }
  }

  if (result) {
    ctx.text_locals.add(name);
  } else {
    ctx.text_locals.delete(name);
  }
}

function clear_loop_binding(name: string, ctx: CoreCtx): void {
  ctx.statics.delete(name);
  ctx.fn_types.delete(name);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
}

function reject_static_carried_loop_values(
  carried: string[],
  ctx: CoreCtx,
  kind: "range" | "collection",
): void {
  for (const name of carried) {
    const value = ctx.statics.get(name);

    if (
      value &&
      static_aggregate_or_union_value(value, ctx, new Set<string>())
    ) {
      throw new Error(
        "Cannot carry static aggregate/union core value through dynamic " +
          kind +
          " loop yet: " + name,
      );
    }
  }
}

function static_aggregate_or_union_value(
  value: CoreExpr,
  ctx: CoreCtx,
  seen: Set<string>,
): boolean {
  if (value.tag === "struct_value" || value.tag === "struct_update") {
    return true;
  }

  if (value.tag === "union_case") {
    return true;
  }

  if (value.tag === "if") {
    if (static_aggregate_or_union_value(value.then_branch, ctx, seen)) {
      return true;
    }

    if (static_aggregate_or_union_value(value.else_branch, ctx, seen)) {
      return true;
    }
  }

  if (value.tag === "var") {
    if (seen.has(value.name)) {
      return false;
    }

    seen.add(value.name);
    const aliased = ctx.statics.get(value.name);

    if (aliased) {
      return static_aggregate_or_union_value(aliased, ctx, seen);
    }
  }

  return false;
}
