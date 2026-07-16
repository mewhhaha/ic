import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { indent_lines } from "../emit/format.ts";
import { set_local } from "../emit/local.ts";
import { closure_heap_global } from "../closure_emit.ts";
import {
  consume_scratch_alloc,
  emit_persistent_alloc,
} from "../runtime_allocator.ts";
import { align_pointer_instr, store_instr } from "../memory.ts";
import { scratch_heap_global } from "../scratch.ts";
import { emit_runtime_union_struct_payload_stores } from "../runtime_union_payload_emit.ts";
import type {
  RuntimeUnionEmitCtx,
  RuntimeUnionEmitHooks,
  RuntimeUnionLocalCtx,
  RuntimeUnionLocalHooks,
} from "./types.ts";

export function collect_runtime_union_value_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): boolean {
  const value = hooks.core_runtime_union_value(expr, ctx);

  if (!value) {
    return false;
  }

  collect_runtime_union_materialized_value_locals(value, ctx, hooks);
  return true;
}

export function emit_runtime_union_value<ctx extends RuntimeUnionEmitCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionEmitHooks<ctx>,
): Wat {
  const value = hooks.core_runtime_union_value(expr, ctx);
  expect(value, "Core runtime union value requires a union case");

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core runtime union if condition must be i32");
    return [
      hooks.emit_expr(value.cond, ctx),
      "if (result i32)",
      indent_lines(emit_runtime_union_value(value.then_branch, ctx, hooks), 2),
      "else",
      indent_lines(emit_runtime_union_value(value.else_branch, ctx, hooks), 2),
      "end",
    ].join("\n");
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );
  return emit_runtime_union_case(value, ctx, hooks);
}

function collect_runtime_union_materialized_value_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): void {
  if (value.tag === "if") {
    hooks.collect_expr_locals(value.cond, ctx);
    collect_runtime_union_materialized_value_locals(
      value.then_branch,
      ctx,
      hooks,
    );
    collect_runtime_union_materialized_value_locals(
      value.else_branch,
      ctx,
      hooks,
    );
    return;
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );

  const name = fresh_temp_local(ctx, "union");
  set_local(ctx.locals, name, "i32");

  if (value.type_expr) {
    hooks.collect_expr_locals(value.type_expr, ctx);
  }

  const info = hooks.runtime_union_case_info(value, ctx);

  if (value.value) {
    if (info.payload.tag === "struct") {
      const struct_value = hooks.static_struct_value(value.value, ctx);
      expect(
        struct_value,
        "Core runtime union case " + value.name +
          " payload expects a static-shaped struct",
      );
      collect_runtime_union_struct_payload_locals(struct_value, ctx, hooks);
    } else if (info.payload.tag === "aggregate") {
      hooks.collect_expr_locals(value.value, ctx);
    } else {
      hooks.collect_expr_locals(value.value, ctx);
    }
  }
}

function collect_runtime_union_struct_payload_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): void {
  for (const field of value.fields) {
    const nested = hooks.static_struct_value(field.value, ctx);

    if (nested) {
      collect_runtime_union_struct_payload_locals(nested, ctx, hooks);
      continue;
    }

    hooks.collect_expr_locals(field.value, ctx);
  }
}

function emit_runtime_union_case<ctx extends RuntimeUnionEmitCtx>(
  value: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: RuntimeUnionEmitHooks<ctx>,
): Wat {
  const info = hooks.runtime_union_case_info(value, ctx);
  const name = fresh_temp_local(ctx, "union");
  set_local(ctx.locals, name, "i32");
  const heap_name = runtime_union_alloc_heap(ctx);
  const lines: string[] = [];
  if (heap_name === closure_heap_global) {
    lines.push(emit_persistent_alloc(
      ctx,
      value,
      "i32.const " + info.size.toString(),
      info.align,
      "runtime_union",
      "runtime_union.tag_and_aligned_payload",
      "runtime_union.value",
    ));
    lines.push("local.set $" + name);
  } else {
    consume_scratch_alloc(
      ctx,
      value,
      "runtime_union",
      "runtime_union.tag_and_aligned_payload",
      "runtime_union.value",
    );
    if (info.align === 16) {
      lines.push("global.get $" + heap_name);
      lines.push(align_pointer_instr(info.align));
      lines.push("local.tee $" + name);
    } else {
      lines.push("global.get $" + heap_name);
      lines.push("local.set $" + name);
      lines.push("global.get $" + heap_name);
    }
    lines.push("i32.const " + info.size.toString());
    lines.push("i32.add");
    lines.push("global.set $" + heap_name);
  }
  lines.push("local.get $" + name);
  lines.push("i32.const " + info.tag_value.toString());
  lines.push("i32.store");

  if (info.payload.tag === "value") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    lines.push("local.get $" + name);
    lines.push(hooks.emit_expr(value.value, ctx));
    lines.push(store_instr(info.payload.type, info.payload_offset));
  } else if (info.payload.tag === "aggregate") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    lines.push("local.get $" + name);
    lines.push(hooks.emit_expr(value.value, ctx));
    lines.push(store_instr("i32", info.payload_offset));
  } else if (info.payload.tag === "struct") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    const struct_value = hooks.static_struct_value(value.value, ctx);
    expect(
      struct_value,
      "Core runtime union case " + value.name +
        " payload expects a static-shaped struct",
    );

    emit_runtime_union_struct_payload_stores(
      name,
      value.name,
      struct_value,
      info.payload.fields,
      ctx,
      lines,
      hooks,
    );
  }

  lines.push("local.get $" + name);
  return lines.join("\n");
}

function runtime_union_alloc_heap(ctx: RuntimeUnionEmitCtx): string {
  if (ctx.scratch_return_resets.length > 0) {
    ctx.scratch.needed = true;
    return scratch_heap_global;
  }

  ctx.heap.needed = true;
  return closure_heap_global;
}
