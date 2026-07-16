import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import { closure_heap_global } from "../closure_runtime.ts";
import { emit_runtime_text_slice_copy } from "./copy.ts";
import {
  declare_runtime_text_slice_locals,
  runtime_text_slice_plan,
} from "./plan.ts";
import { runtime_text_alloc_heap } from "./alloc.ts";
import {
  consume_scratch_alloc,
  emit_persistent_alloc,
} from "../runtime_allocator.ts";
import type { RuntimeTextEmitCtx, RuntimeTextHooks } from "./types.ts";

export function emit_runtime_text_slice<ctx extends RuntimeTextEmitCtx>(
  subject: CoreExpr,
  text: CoreExpr,
  start: CoreExpr,
  end: CoreExpr,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr" | "expr_type">,
): Wat {
  const start_type = hooks.expr_type(start, ctx);
  const end_type = hooks.expr_type(end, ctx);
  expect(start_type === "i32", "Core text slice start must be i32");
  expect(end_type === "i32", "Core text slice end must be i32");
  const locals = runtime_text_slice_plan(ctx);
  declare_runtime_text_slice_locals(locals, ctx);
  const heap_name = runtime_text_alloc_heap(ctx);
  const exit_label = "text_slice_exit_" + locals.id.toString();
  const loop_label = "text_slice_loop_" + locals.id.toString();
  const allocation: string[] = [];
  if (heap_name === closure_heap_global) {
    allocation.push(emit_persistent_alloc(
      ctx,
      subject,
      "local.get $" + locals.slice_len + "\ni32.const 4\ni32.add",
      8,
      "runtime_text",
      "runtime_text.length_prefixed_utf8",
      "runtime_text.slice",
    ));
    allocation.push("local.set $" + locals.result);
  } else {
    consume_scratch_alloc(
      ctx,
      subject,
      "runtime_text",
      "runtime_text.length_prefixed_utf8",
      "runtime_text.slice",
    );
    allocation.push("global.get $" + heap_name);
    allocation.push("local.set $" + locals.result);
    allocation.push("global.get $" + heap_name);
    allocation.push("local.get $" + locals.slice_len);
    allocation.push("i32.const 4");
    allocation.push("i32.add");
    allocation.push("i32.const 7");
    allocation.push("i32.add");
    allocation.push("i32.const -8");
    allocation.push("i32.and");
    allocation.push("i32.add");
    allocation.push("global.set $" + heap_name);
  }

  return [
    hooks.emit_expr(text, ctx),
    "local.set $" + locals.text,
    hooks.emit_expr(start, ctx),
    "local.set $" + locals.start,
    hooks.emit_expr(end, ctx),
    "local.set $" + locals.end,
    "local.get $" + locals.text,
    "i32.load",
    "local.set $" + locals.source_len,
    "local.get $" + locals.start,
    "i32.const 0",
    "i32.lt_s",
    "if",
    "  unreachable",
    "else",
    indent_lines(
      [
        "local.get $" + locals.end,
        "local.get $" + locals.start,
        "i32.lt_s",
        "if",
        "  unreachable",
        "else",
        indent_lines(
          [
            "local.get $" + locals.end,
            "local.get $" + locals.source_len,
            "i32.gt_s",
            "if",
            "  unreachable",
            "else",
            indent_lines(
              [
                "local.get $" + locals.end,
                "local.get $" + locals.start,
                "i32.sub",
                "local.set $" + locals.slice_len,
                ...allocation,
                "local.get $" + locals.result,
                "local.get $" + locals.slice_len,
                "i32.store",
                emit_runtime_text_slice_copy(locals, exit_label, loop_label),
              ].join("\n"),
              2,
            ),
            "end",
          ].join("\n"),
          2,
        ),
        "end",
      ].join("\n"),
      2,
    ),
    "end",
    "local.get $" + locals.result,
  ].join("\n");
}

export function emit_runtime_text_freeze_copy<ctx extends RuntimeTextEmitCtx>(
  subject: CoreExpr,
  text: CoreExpr,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr">,
  allocation?: RuntimeTextFreezeAllocation,
): Wat {
  const text_wat = hooks.emit_expr(text, ctx);
  return emit_runtime_text_freeze_copy_from_wat(
    subject,
    text_wat,
    ctx,
    allocation,
  );
}

export type RuntimeTextFreezeAllocation = {
  reason: "runtime_bytes" | "runtime_text";
  layout:
    | "runtime_bytes.length_prefixed_u8"
    | "runtime_text.length_prefixed_utf8";
  emission_site: "runtime_bytes.freeze_copy" | "runtime_text.freeze_copy";
};

export function emit_runtime_text_freeze_copy_from_wat<
  ctx extends RuntimeTextEmitCtx,
>(
  subject: CoreExpr,
  text_wat: Wat,
  ctx: ctx,
  allocation?: RuntimeTextFreezeAllocation,
): Wat {
  const locals = runtime_text_slice_plan(ctx);
  declare_runtime_text_slice_locals(locals, ctx);
  const exit_label = "text_freeze_exit_" + locals.id.toString();
  const loop_label = "text_freeze_loop_" + locals.id.toString();
  ctx.heap.needed = true;
  let reason: "runtime_bytes" | "runtime_text" = "runtime_text";
  let layout:
    | "runtime_bytes.length_prefixed_u8"
    | "runtime_text.length_prefixed_utf8" = "runtime_text.length_prefixed_utf8";
  let emission_site:
    | "runtime_bytes.freeze_copy"
    | "runtime_text.freeze_copy" = "runtime_text.freeze_copy";

  if (allocation) {
    reason = allocation.reason;
    layout = allocation.layout;
    emission_site = allocation.emission_site;
  }

  return [
    text_wat,
    "local.set $" + locals.text,
    "i32.const 0",
    "local.set $" + locals.start,
    "local.get $" + locals.text,
    "i32.load",
    "local.set $" + locals.source_len,
    "local.get $" + locals.source_len,
    "local.set $" + locals.slice_len,
    emit_persistent_alloc(
      ctx,
      subject,
      "local.get $" + locals.slice_len + "\ni32.const 4\ni32.add",
      8,
      reason,
      layout,
      emission_site,
    ),
    "local.set $" + locals.result,
    "local.get $" + locals.result,
    "local.get $" + locals.slice_len,
    "i32.store",
    emit_runtime_text_slice_copy(locals, exit_label, loop_label),
    "local.get $" + locals.result,
  ].join("\n");
}
