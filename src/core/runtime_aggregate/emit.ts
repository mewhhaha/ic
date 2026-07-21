import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { closure_heap_global } from "../closure_runtime.ts";
import {
  consume_scratch_alloc,
  emit_persistent_alloc,
} from "../runtime_allocator.ts";
import { align_pointer_instr, load_instr, store_instr } from "../memory.ts";
import { scratch_heap_global } from "../scratch.ts";
import type { TypeStaticCtx } from "../type_static.ts";
import {
  runtime_aggregate_field_base_offset,
  runtime_aggregate_layout,
  type RuntimeAggregateField,
} from "./layout.ts";
import {
  runtime_aggregate_field_access,
  type RuntimeAggregateTypeCtx,
  type RuntimeAggregateTypeHooks,
} from "./type_expr.ts";
import {
  declare_runtime_aggregate_locals,
  runtime_aggregate_plan,
} from "./plan.ts";
import type {
  RuntimeAggregateEmitCtx,
  RuntimeAggregateHooks,
  RuntimeAggregateTempCtx,
} from "./types.ts";

export const runtime_aggregate_move_pointer_local =
  "__runtime_aggregate_move_pointer";

export function emit_runtime_aggregate_field_load<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  },
): Wat {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);
  expect(access, "Missing runtime aggregate field: " + name);
  const field = access.field;
  expect(
    field.tag === "value",
    "Core runtime aggregate field " + name +
      " cannot be loaded as a standalone value yet",
  );
  return hooks.emit_expr(access.base, ctx) + "\n" + load_instr(
    field.type,
    field.offset,
  );
}

export function emit_runtime_aggregate_field_move<
  ctx extends RuntimeAggregateTypeCtx & RuntimeAggregateTempCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  },
): Wat {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);
  expect(access, "Missing runtime aggregate field: " + name);
  const field = access.field;

  if (field.tag === "struct") {
    return emit_runtime_aggregate_field_pointer(object, name, ctx, hooks);
  }

  expect(
    field.tag === "value",
    "Core runtime aggregate field " + name +
      " cannot be moved as a standalone value",
  );

  if (!field.text && !field.resume && field.union_type_expr === undefined) {
    return hooks.emit_expr(access.base, ctx) + "\n" + load_instr(
      field.type,
      field.offset,
    );
  }

  expect(
    field.type === "i32",
    "Owned runtime aggregate field " + name + " must use an i32 pointer",
  );
  ctx.locals.set(runtime_aggregate_move_pointer_local, "i32");
  return [
    hooks.emit_expr(access.base, ctx),
    "local.tee $" + runtime_aggregate_move_pointer_local,
    load_instr(field.type, field.offset),
    "local.get $" + runtime_aggregate_move_pointer_local,
    "i32.const 0",
    store_instr(field.type, field.offset),
  ].join("\n");
}

export function emit_runtime_aggregate_field_pointer<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  },
): Wat {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);
  expect(access, "Missing runtime aggregate field: " + name);
  const field = access.field;
  expect(
    field.tag === "struct",
    "Core runtime aggregate field " + name +
      " cannot be emitted as an aggregate pointer",
  );

  if (field.fields.length === 0) {
    return hooks.emit_expr(access.base, ctx);
  }

  const first = field.fields[0];
  expect(first, "Missing first runtime aggregate nested field: " + name);
  const offset = runtime_aggregate_field_base_offset(first);

  if (offset === 0) {
    return hooks.emit_expr(access.base, ctx);
  }

  return [
    hooks.emit_expr(access.base, ctx),
    "i32.const " + offset.toString(),
    "i32.add",
  ].join("\n");
}

export function emit_runtime_aggregate_value<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  subject: CoreExpr,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
): Wat {
  const layout = runtime_aggregate_layout(value, ctx);
  const plan = runtime_aggregate_plan(ctx);
  declare_runtime_aggregate_locals(plan, ctx);
  const heap_name = runtime_aggregate_alloc_heap(ctx);
  const lines: string[] = [];
  if (heap_name === closure_heap_global) {
    lines.push(emit_persistent_alloc(
      ctx,
      subject,
      "i32.const " + layout.size.toString(),
      runtime_aggregate_alloc_alignment(layout.align),
      "runtime_aggregate",
      "runtime_aggregate.aligned_fields",
      "runtime_aggregate.value",
    ));
    lines.push("local.set $" + plan.local);
  } else {
    consume_scratch_alloc(
      ctx,
      subject,
      "runtime_aggregate",
      "runtime_aggregate.aligned_fields",
      "runtime_aggregate.value",
    );
    if (layout.align === 16) {
      lines.push("global.get $" + heap_name);
      lines.push(align_pointer_instr(layout.align));
      lines.push("local.tee $" + plan.local);
    } else {
      lines.push("global.get $" + heap_name);
      lines.push("local.set $" + plan.local);
      lines.push("global.get $" + heap_name);
    }
    lines.push("i32.const " + layout.size.toString());
    lines.push("i32.add");
    lines.push("global.set $" + heap_name);
  }

  emit_runtime_aggregate_field_stores(
    plan.local,
    value,
    layout.fields,
    ctx,
    hooks,
    lines,
  );

  lines.push("local.get $" + plan.local);
  return lines.join("\n");
}

function runtime_aggregate_alloc_alignment(align: number): 4 | 8 | 16 {
  if (align === 16) {
    return 16;
  }

  return 8;
}

function runtime_aggregate_alloc_heap(
  ctx: RuntimeAggregateEmitCtx,
): string {
  if (ctx.scratch_return_resets.length > 0) {
    ctx.scratch.needed = true;
    return scratch_heap_global;
  }

  ctx.heap.needed = true;
  return closure_heap_global;
}

function emit_runtime_aggregate_field_stores<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  for (const field_info of fields) {
    const field = value.fields.find((item) => item.name === field_info.name);
    expect(
      field,
      "Core runtime aggregate missing struct field " + field_info.name,
    );

    if (field_info.tag === "unit") {
      continue;
    }

    if (field_info.tag === "struct") {
      const nested_value = hooks.static_struct_value(field.value, ctx);

      if (nested_value) {
        emit_runtime_aggregate_field_stores(
          local_name,
          nested_value,
          field_info.fields,
          ctx,
          hooks,
          lines,
        );
        continue;
      }

      emit_runtime_aggregate_nested_field_copy_stores(
        local_name,
        field.value,
        field_info,
        ctx,
        hooks,
        lines,
      );
      continue;
    }

    check_runtime_aggregate_value_field(field_info, field.value, ctx, hooks);
    lines.push("local.get $" + local_name);
    lines.push(hooks.emit_expr(field.value, ctx));
    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function emit_runtime_aggregate_nested_field_copy_stores<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  source: CoreExpr,
  field_info: Extract<RuntimeAggregateField, { tag: "struct" }>,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  const source_type = hooks.runtime_aggregate_type_expr(source, ctx);
  expect(
    hooks.same_runtime_aggregate_type_expr(
      field_info.type_expr,
      source_type,
      ctx,
    ),
    "Core runtime aggregate field " + field_info.name +
      " expects a matching aggregate value",
  );

  emit_runtime_aggregate_field_copies(
    local_name,
    source,
    field_info.fields,
    ctx,
    hooks,
    lines,
  );
}

function emit_runtime_aggregate_field_copies<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  source: CoreExpr,
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  for (const field_info of fields) {
    if (field_info.tag === "unit") {
      continue;
    }

    let source_field: CoreExpr = {
      tag: "field",
      object: source,
      name: field_info.name,
    };

    if (source.tag === "field" && source.move) {
      source_field = { ...source_field, move: true };
    }

    if (field_info.tag === "struct") {
      emit_runtime_aggregate_field_copies(
        local_name,
        source_field,
        field_info.fields,
        ctx,
        hooks,
        lines,
      );
      continue;
    }

    lines.push("local.get $" + local_name);
    lines.push(hooks.emit_expr(source_field, ctx));
    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function check_runtime_aggregate_value_field<ctx extends TypeStaticCtx>(
  field_info: Extract<RuntimeAggregateField, { tag: "value" }>,
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
): void {
  if (field_info.union_type_expr) {
    const actual = hooks.runtime_union_type_expr(value, ctx);
    expect(
      actual &&
        hooks.same_runtime_union_type_expr(
          field_info.union_type_expr,
          actual,
          ctx,
        ),
      "Core runtime aggregate field " + field_info.name +
        " expects a matching union value",
    );
    return;
  }

  if (field_info.text) {
    expect(
      hooks.core_expr_is_text(value, ctx),
      "Core runtime aggregate field " + field_info.name + " expects Text",
    );
    return;
  }

  const actual = hooks.expr_type(value, ctx);
  expect(
    actual === field_info.type,
    "Core runtime aggregate field " + field_info.name + " expects " +
      field_info.type + ", got " + actual,
  );
}
