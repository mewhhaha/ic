import type { Wat } from "../../wat.ts";
import { indent_lines } from "../emit/format.ts";
import type { RuntimeTextConcatPlan, RuntimeTextSlicePlan } from "./plan.ts";

export function emit_runtime_text_slice_copy(
  locals: RuntimeTextSlicePlan,
  exit_label: string,
  loop_label: string,
): Wat {
  return [
    "i32.const 0",
    "local.set $" + locals.index,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + locals.index,
    "    local.get $" + locals.slice_len,
    "    i32.ge_s",
    "    br_if $" + exit_label,
    indent_lines(
      [
        "local.get $" + locals.result,
        "i32.const 4",
        "i32.add",
        "local.get $" + locals.index,
        "i32.add",
        "local.get $" + locals.text,
        "i32.const 4",
        "i32.add",
        "local.get $" + locals.start,
        "i32.add",
        "local.get $" + locals.index,
        "i32.add",
        "i32.load8_u",
        "i32.store8",
        "local.get $" + locals.index,
        "i32.const 1",
        "i32.add",
        "local.set $" + locals.index,
        "br $" + loop_label,
      ].join("\n"),
      4,
    ),
    "  end",
    "end",
  ].join("\n");
}

export function emit_runtime_text_concat_copy(
  locals: RuntimeTextConcatPlan,
  source: string,
  length: string,
  after_left: boolean,
): Wat {
  let side = "left";

  if (after_left) {
    side = "right";
  }

  const exit_label = "text_concat_" + side + "_exit_" +
    locals.id.toString();
  const loop_label = "text_concat_" + side + "_loop_" +
    locals.id.toString();
  const dest_prefix: string[] = [
    "local.get $" + locals.result,
    "i32.const 4",
    "i32.add",
  ];

  if (after_left) {
    dest_prefix.push("local.get $" + locals.left_len);
    dest_prefix.push("i32.add");
  }

  return [
    "i32.const 0",
    "local.set $" + locals.index,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + locals.index,
    "    local.get $" + length,
    "    i32.ge_s",
    "    br_if $" + exit_label,
    indent_lines(
      [
        ...dest_prefix,
        "local.get $" + locals.index,
        "i32.add",
        "local.get $" + source,
        "i32.const 4",
        "i32.add",
        "local.get $" + locals.index,
        "i32.add",
        "i32.load8_u",
        "i32.store8",
        "local.get $" + locals.index,
        "i32.const 1",
        "i32.add",
        "local.set $" + locals.index,
        "br $" + loop_label,
      ].join("\n"),
      4,
    ),
    "  end",
    "end",
  ].join("\n");
}
