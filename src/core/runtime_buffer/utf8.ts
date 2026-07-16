import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import type { CoreRuntimeBufferBuiltin } from "../runtime_buffer.ts";
import type {
  RuntimeTextEmitCtx,
  RuntimeTextHooks,
} from "../runtime_text/types.ts";
import { emit_runtime_buffer_allocation } from "./allocation.ts";
import {
  declare_runtime_utf8_locals,
  runtime_utf8_plan,
  type RuntimeUtf8Plan,
} from "./plan.ts";

export function emit_runtime_utf8_conversion<
  ctx extends RuntimeTextEmitCtx,
>(
  subject: CoreExpr,
  builtin: CoreRuntimeBufferBuiltin,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr">,
): Wat {
  expect(
    builtin.name === "Utf8.encode" || builtin.name === "Utf8.decode",
    "Runtime UTF-8 conversion requires Utf8.encode or Utf8.decode",
  );
  const locals = runtime_utf8_plan(ctx);
  declare_runtime_utf8_locals(locals, ctx);
  const lines = [
    hooks.emit_expr(builtin.arg, ctx),
    "local.set $" + locals.source,
    "local.get $" + locals.source,
    "i32.load",
    "local.set $" + locals.length,
  ];

  if (builtin.name === "Utf8.decode") {
    lines.push(emit_utf8_validation(locals));
  }

  lines.push(
    ...emit_runtime_buffer_allocation(
      subject,
      builtin,
      locals.length,
      locals.result,
      ctx,
    ),
    "local.get $" + locals.result,
    "local.get $" + locals.length,
    "i32.store",
    emit_utf8_copy(locals),
    "local.get $" + locals.result,
  );
  return lines.join("\n");
}

function emit_utf8_validation(locals: RuntimeUtf8Plan): Wat {
  const exit_label = "utf8_validate_exit_" + locals.id.toString();
  const loop_label = "utf8_validate_loop_" + locals.id.toString();
  const valid_label = "utf8_sequence_valid_" + locals.id.toString();
  const leading = "local.get $" + locals.leading_byte;
  const advance_one = advance_utf8_index(locals, 1, valid_label);
  const advance_two = advance_utf8_index(locals, 2, valid_label);
  const advance_three = advance_utf8_index(locals, 3, valid_label);
  const advance_four = advance_utf8_index(locals, 4, valid_label);

  return [
    "i32.const 0",
    "local.set $" + locals.index,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + locals.index,
    "    local.get $" + locals.length,
    "    i32.ge_u",
    "    br_if $" + exit_label,
    indent_lines(load_utf8_byte(locals, 0), 4),
    "    local.set $" + locals.leading_byte,
    "    block $" + valid_label,
    indent_lines(
      [
        leading,
        "i32.const 128",
        "i32.lt_u",
        "if",
        indent_lines(advance_one, 2),
        "end",
        emit_two_byte_validation(locals, leading, advance_two),
        emit_three_byte_validation(locals, leading, advance_three),
        emit_four_byte_validation(locals, leading, advance_four),
        "unreachable",
      ].join("\n"),
      6,
    ),
    "    end",
    "    br $" + loop_label,
    "  end",
    "end",
  ].join("\n");
}

function emit_two_byte_validation(
  locals: RuntimeUtf8Plan,
  leading: string,
  advance: Wat,
): Wat {
  return [
    leading,
    "i32.const 194",
    "i32.ge_u",
    leading,
    "i32.const 224",
    "i32.lt_u",
    "i32.and",
    "if",
    indent_lines(
      [
        ...trap_unless_bytes_remain(locals, 1),
        ...trap_unless_continuation_byte(locals, 1),
        advance,
      ].join("\n"),
      2,
    ),
    "end",
  ].join("\n");
}

function emit_three_byte_validation(
  locals: RuntimeUtf8Plan,
  leading: string,
  advance: Wat,
): Wat {
  return [
    leading,
    "i32.const 224",
    "i32.ge_u",
    leading,
    "i32.const 240",
    "i32.lt_u",
    "i32.and",
    "if",
    indent_lines(
      [
        ...trap_unless_bytes_remain(locals, 2),
        ...trap_unless_continuation_byte(locals, 1),
        leading,
        "i32.const 224",
        "i32.eq",
        "if",
        indent_lines(
          [
            load_utf8_byte(locals, 1),
            "i32.const 160",
            "i32.lt_u",
            ...trap_if_true(),
          ].join("\n"),
          2,
        ),
        "end",
        leading,
        "i32.const 237",
        "i32.eq",
        "if",
        indent_lines(
          [
            load_utf8_byte(locals, 1),
            "i32.const 160",
            "i32.ge_u",
            ...trap_if_true(),
          ].join("\n"),
          2,
        ),
        "end",
        ...trap_unless_continuation_byte(locals, 2),
        advance,
      ].join("\n"),
      2,
    ),
    "end",
  ].join("\n");
}

function emit_four_byte_validation(
  locals: RuntimeUtf8Plan,
  leading: string,
  advance: Wat,
): Wat {
  return [
    leading,
    "i32.const 240",
    "i32.ge_u",
    leading,
    "i32.const 245",
    "i32.lt_u",
    "i32.and",
    "if",
    indent_lines(
      [
        ...trap_unless_bytes_remain(locals, 3),
        ...trap_unless_continuation_byte(locals, 1),
        leading,
        "i32.const 240",
        "i32.eq",
        "if",
        indent_lines(
          [
            load_utf8_byte(locals, 1),
            "i32.const 144",
            "i32.lt_u",
            ...trap_if_true(),
          ].join("\n"),
          2,
        ),
        "end",
        leading,
        "i32.const 244",
        "i32.eq",
        "if",
        indent_lines(
          [
            load_utf8_byte(locals, 1),
            "i32.const 144",
            "i32.ge_u",
            ...trap_if_true(),
          ].join("\n"),
          2,
        ),
        "end",
        ...trap_unless_continuation_byte(locals, 2),
        ...trap_unless_continuation_byte(locals, 3),
        advance,
      ].join("\n"),
      2,
    ),
    "end",
  ].join("\n");
}

function trap_unless_bytes_remain(
  locals: RuntimeUtf8Plan,
  final_offset: number,
): string[] {
  return [
    "local.get $" + locals.index,
    "i32.const " + final_offset.toString(),
    "i32.add",
    "local.get $" + locals.length,
    "i32.ge_u",
    ...trap_if_true(),
  ];
}

function trap_unless_continuation_byte(
  locals: RuntimeUtf8Plan,
  offset: number,
): string[] {
  return [
    load_utf8_byte(locals, offset),
    "i32.const 192",
    "i32.and",
    "i32.const 128",
    "i32.ne",
    ...trap_if_true(),
  ];
}

function trap_if_true(): string[] {
  return ["if", "  unreachable", "end"];
}

function advance_utf8_index(
  locals: RuntimeUtf8Plan,
  count: number,
  valid_label: string,
): Wat {
  return [
    "local.get $" + locals.index,
    "i32.const " + count.toString(),
    "i32.add",
    "local.set $" + locals.index,
    "br $" + valid_label,
  ].join("\n");
}

function load_utf8_byte(
  locals: RuntimeUtf8Plan,
  offset: number,
): Wat {
  return [
    "local.get $" + locals.source,
    "i32.const 4",
    "i32.add",
    "local.get $" + locals.index,
    "i32.add",
    "i32.load8_u offset=" + offset.toString(),
  ].join("\n");
}

function emit_utf8_copy(locals: RuntimeUtf8Plan): Wat {
  const exit_label = "utf8_copy_exit_" + locals.id.toString();
  const loop_label = "utf8_copy_loop_" + locals.id.toString();
  return [
    "i32.const 0",
    "local.set $" + locals.index,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + locals.index,
    "    local.get $" + locals.length,
    "    i32.ge_u",
    "    br_if $" + exit_label,
    "    local.get $" + locals.result,
    "    i32.const 4",
    "    i32.add",
    "    local.get $" + locals.index,
    "    i32.add",
    indent_lines(load_utf8_byte(locals, 0), 4),
    "    i32.store8",
    "    local.get $" + locals.index,
    "    i32.const 1",
    "    i32.add",
    "    local.set $" + locals.index,
    "    br $" + loop_label,
    "  end",
    "end",
  ].join("\n");
}
