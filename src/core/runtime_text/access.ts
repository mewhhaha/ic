import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import {
  declare_runtime_text_index_assign_locals,
  runtime_text_index_assign_plan,
} from "./plan.ts";
import type { RuntimeTextHooks, RuntimeTextTempCtx } from "./types.ts";

export function emit_runtime_text_len<ctx>(
  text: CoreExpr,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr">,
): Wat {
  return [
    hooks.emit_expr(text, ctx),
    "i32.load",
  ].join("\n");
}

export function emit_runtime_text_byte_index<ctx>(
  text: CoreExpr,
  index: CoreExpr,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr" | "expr_type">,
): Wat {
  const index_type = hooks.expr_type(index, ctx);
  expect(index_type === "i32", "Core text byte index must be i32");
  return [
    hooks.emit_expr(index, ctx),
    "i32.const 0",
    "i32.lt_s",
    "if (result i32)",
    "  unreachable",
    "else",
    indent_lines(
      [
        hooks.emit_expr(index, ctx),
        emit_runtime_text_len(text, ctx, hooks),
        "i32.ge_s",
        "if (result i32)",
        "  unreachable",
        "else",
        indent_lines(
          [
            hooks.emit_expr(text, ctx),
            "i32.const 4",
            "i32.add",
            hooks.emit_expr(index, ctx),
            "i32.add",
            "i32.load8_u",
          ].join("\n"),
          2,
        ),
        "end",
      ].join("\n"),
      2,
    ),
    "end",
  ].join("\n");
}

export function emit_runtime_text_index_assign<
  ctx extends RuntimeTextTempCtx,
>(
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr" | "expr_type">,
): Wat {
  const index_type = hooks.expr_type(stmt.index, ctx);
  const value_type = hooks.expr_type(stmt.value, ctx);
  expect(index_type === "i32", "Core text index assignment index must be i32");
  expect(value_type === "i32", "Core text index assignment value must be i32");
  const locals = runtime_text_index_assign_plan(ctx);
  declare_runtime_text_index_assign_locals(locals, ctx);

  return [
    hooks.emit_expr(stmt.index, ctx),
    "local.set $" + locals.index,
    hooks.emit_expr(stmt.value, ctx),
    "local.set $" + locals.value,
    "local.get $" + locals.index,
    "i32.const 0",
    "i32.lt_s",
    "if",
    "  unreachable",
    "else",
    indent_lines(
      [
        "local.get $" + locals.index,
        "local.get $" + stmt.name,
        "i32.load",
        "i32.ge_s",
        "if",
        "  unreachable",
        "else",
        indent_lines(
          [
            "local.get $" + stmt.name,
            "i32.const 4",
            "i32.add",
            "local.get $" + locals.index,
            "i32.add",
            "local.get $" + locals.value,
            "i32.store8",
          ].join("\n"),
          2,
        ),
        "end",
      ].join("\n"),
      2,
    ),
    "end",
  ].join("\n");
}
