import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import {
  declare_runtime_text_eq_locals,
  runtime_text_eq_plan,
} from "./plan.ts";
import type { RuntimeTextEmitCtx, RuntimeTextHooks } from "./types.ts";

export function emit_runtime_text_eq<ctx extends RuntimeTextEmitCtx>(
  expr: Extract<CoreExpr, { tag: "prim" }>,
  ctx: ctx,
  hooks: RuntimeTextHooks<ctx>,
): Wat {
  const operands = hooks.runtime_text_eq_operands(expr, ctx);
  expect(operands, "Core runtime text equality requires text operands");
  const left_wat = hooks.emit_expr(operands.left, ctx);
  const right_wat = hooks.emit_expr(operands.right, ctx);
  const locals = runtime_text_eq_plan(ctx);
  declare_runtime_text_eq_locals(locals, ctx);
  const exit_label = "text_eq_exit_" + locals.id.toString();
  const loop_label = "text_eq_loop_" + locals.id.toString();
  const lines = [
    left_wat,
    "local.set $" + locals.left,
    right_wat,
    "local.set $" + locals.right,
    "local.get $" + locals.left,
    "i32.load",
    "local.set $" + locals.left_len,
    "local.get $" + locals.right,
    "i32.load",
    "local.set $" + locals.right_len,
    "i32.const 1",
    "local.set $" + locals.result,
    "local.get $" + locals.left_len,
    "local.get $" + locals.right_len,
    "i32.ne",
    "if",
    "  i32.const 0",
    "  local.set $" + locals.result,
    "else",
    indent_lines(
      [
        "i32.const 0",
        "local.set $" + locals.index,
        "block $" + exit_label,
        "  loop $" + loop_label,
        "    local.get $" + locals.index,
        "    local.get $" + locals.left_len,
        "    i32.ge_s",
        "    br_if $" + exit_label,
        indent_lines(
          [
            "local.get $" + locals.left,
            "i32.const 4",
            "i32.add",
            "local.get $" + locals.index,
            "i32.add",
            "i32.load8_u",
            "local.get $" + locals.right,
            "i32.const 4",
            "i32.add",
            "local.get $" + locals.index,
            "i32.add",
            "i32.load8_u",
            "i32.ne",
            "if",
            "  i32.const 0",
            "  local.set $" + locals.result,
            "  br $" + exit_label,
            "end",
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
      ].join("\n"),
      2,
    ),
    "end",
    "local.get $" + locals.result,
  ];

  if (operands.prim === "i32.ne") {
    lines.push("i32.eqz");
  }

  return lines.join("\n");
}
