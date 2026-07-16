import { expect } from "../expect.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreField, CoreStmt } from "./ast.ts";
import { indent_lines } from "./emit/format.ts";
import {
  core_runtime_slice_fact,
  runtime_slice_end_local,
  runtime_slice_index_local,
  runtime_slice_value_local,
} from "./runtime_slice.ts";

export type CoreCollectionLoopCtx = {
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  continue_label: string | undefined;
  scratch_loop_resets: string[];
};

export type CoreCollectionLoopHooks<ctx extends CoreCollectionLoopCtx> = {
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreField[] | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
};

export function emit_core_collection_loop<
  ctx extends CoreCollectionLoopCtx,
>(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: ctx,
  hooks: CoreCollectionLoopHooks<ctx>,
): Wat {
  const fields = hooks.static_collection_fields(stmt.collection, ctx);

  if (core_runtime_slice_fact(stmt.collection)) {
    return emit_runtime_slice_loop(stmt, ctx, hooks);
  }

  if (!fields) {
    const text = hooks.static_text_value(stmt.collection, ctx);

    if (text || hooks.core_expr_is_text(stmt.collection, ctx)) {
      return emit_text_collection_loop(stmt, ctx, hooks);
    }

    throw new Error("Cannot emit core collection_loop statement yet");
  }

  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const exit_label = "collection_exit_" + id.toString();
  const lines: string[] = ["block $" + exit_label];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing static collection field " + index.toString());

    const continue_label = "collection_continue_" + id.toString() + "_" +
      index.toString();
    const body_ctx: ctx = {
      ...ctx,
      next_loop: ctx.next_loop,
      next_temp: ctx.next_temp,
      break_label: exit_label,
      continue_label,
      scratch_loop_resets: [],
    };
    const body: string[] = [];

    if (stmt.index) {
      body.push("i32.const " + index.toString());
      body.push("local.set $" + stmt.index);
    }

    body.push(hooks.emit_expr(field.value, ctx));
    body.push("local.set $" + stmt.item);

    for (const item of stmt.body) {
      body.push(hooks.emit_stmt(item, body_ctx, false));
    }

    ctx.next_loop = body_ctx.next_loop;
    ctx.next_temp = body_ctx.next_temp;
    lines.push("  block $" + continue_label);
    lines.push(indent_lines(body.join("\n"), 4));
    lines.push("  end");
  }

  lines.push("end");
  return lines.join("\n");
}

function emit_runtime_slice_loop<ctx extends CoreCollectionLoopCtx>(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: ctx,
  hooks: CoreCollectionLoopHooks<ctx>,
): Wat {
  const fact = core_runtime_slice_fact(stmt.collection);
  expect(fact, "Missing runtime slice facts");
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const index = stmt.index || runtime_slice_index_local(id);
  const value = runtime_slice_value_local(id);
  const end = runtime_slice_end_local(id);
  const exit = "slice_exit_" + id.toString();
  const loop = "slice_loop_" + id.toString();
  const next = "slice_continue_" + id.toString();
  const body_ctx: ctx = {
    ...ctx,
    break_label: exit,
    continue_label: next,
    scratch_loop_resets: [],
  };
  const body = [
    "local.get $" + value,
    "local.get $" + index,
    "i32.const 4",
    "i32.mul",
    "i32.add",
    "i32.load offset=4",
    "local.set $" + stmt.item,
  ];
  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, body_ctx, false));
  }
  return [
    hooks.emit_expr(stmt.collection, ctx),
    "local.set $" + value,
    "local.get $" + value,
    "i32.load",
    "local.set $" + end,
    "local.get $" + end,
    "i32.const " + fact.capacity.toString(),
    "i32.gt_u",
    "if",
    "  unreachable",
    "end",
    "i32.const 0",
    "local.set $" + index,
    "block $" + exit,
    "  loop $" + loop,
    "    local.get $" + index,
    "    local.get $" + end,
    "    i32.ge_u",
    "    br_if $" + exit,
    "    block $" + next,
    indent_lines(body.join("\n"), 6),
    "    end",
    "    local.get $" + index,
    "    i32.const 1",
    "    i32.add",
    "    local.set $" + index,
    "    br $" + loop,
    "  end",
    "end",
  ].join("\n");
}

export function text_collection_index_local(id: number): string {
  return "_text_index#" + id.toString();
}

export function text_collection_value_local(id: number): string {
  return "_text_value#" + id.toString();
}

export function text_collection_end_local(id: number): string {
  return "_text_end#" + id.toString();
}

function emit_text_collection_loop<ctx extends CoreCollectionLoopCtx>(
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: ctx,
  hooks: CoreCollectionLoopHooks<ctx>,
): Wat {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  let index_name = stmt.index;

  if (!index_name) {
    index_name = text_collection_index_local(id);
  }

  const value_name = text_collection_value_local(id);
  const end_name = text_collection_end_local(id);
  const exit_label = "text_collection_exit_" + id.toString();
  const loop_label = "text_collection_loop_" + id.toString();
  const continue_label = "text_collection_continue_" + id.toString();
  const body_ctx: ctx = {
    ...ctx,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
    break_label: exit_label,
    continue_label,
    scratch_loop_resets: [],
  };
  const body: string[] = [
    "local.get $" + value_name,
    "i32.const 4",
    "i32.add",
    "local.get $" + index_name,
    "i32.add",
    "i32.load8_u",
    "local.set $" + stmt.item,
  ];

  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, body_ctx, false));
  }

  ctx.next_loop = body_ctx.next_loop;
  ctx.next_temp = body_ctx.next_temp;

  return [
    hooks.emit_expr(stmt.collection, ctx),
    "local.set $" + value_name,
    "local.get $" + value_name,
    "i32.load",
    "local.set $" + end_name,
    "i32.const 0",
    "local.set $" + index_name,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + index_name,
    "    local.get $" + end_name,
    "    i32.ge_s",
    "    br_if $" + exit_label,
    "    block $" + continue_label,
    indent_lines(body.join("\n"), 6),
    "    end",
    "    local.get $" + index_name,
    "    i32.const 1",
    "    i32.add",
    "    local.set $" + index_name,
    "    br $" + loop_label,
    "  end",
    "end",
  ].join("\n");
}
