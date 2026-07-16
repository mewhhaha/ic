import { expect } from "../expect.ts";
import type { CoreExpr } from "./ast.ts";
import { maybe_static_i32 } from "./analysis/static_i32.ts";
import { text_content_bytes } from "./text.ts";

export function text_byte_index_expr(
  text: CoreExpr,
  index_expr: CoreExpr,
): CoreExpr {
  if (text.tag === "text") {
    return text_literal_byte_index_expr(text.value, index_expr);
  }

  if (text.tag === "if") {
    return {
      tag: "if",
      cond: text.cond,
      then_branch: text_byte_index_expr(text.then_branch, index_expr),
      else_branch: text_byte_index_expr(text.else_branch, index_expr),
    };
  }

  if (is_i32_trap_core_expr(text)) {
    return text;
  }

  throw new Error("Cannot index non-visible core text value");
}

function text_literal_byte_index_expr(
  value: string,
  index_expr: CoreExpr,
): CoreExpr {
  const bytes = text_content_bytes(value);
  const static_index = maybe_static_i32(index_expr);

  if (static_index !== undefined) {
    if (static_index < 0 || static_index >= bytes.length) {
      throw new Error("Core text index out of bounds: " + static_index);
    }

    const byte = bytes[static_index];
    expect(byte !== undefined, "Missing core text byte " + static_index);
    return { tag: "num", type: "i32", value: byte };
  }

  let result: CoreExpr = { tag: "prim", prim: "i32.trap", args: [] };

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    expect(byte !== undefined, "Missing core text byte " + index);
    result = {
      tag: "if",
      cond: {
        tag: "prim",
        prim: "i32.eq",
        args: [
          index_expr,
          { tag: "num", type: "i32", value: index },
        ],
      },
      then_branch: { tag: "num", type: "i32", value: byte },
      else_branch: result,
    };
  }

  return result;
}

function is_i32_trap_core_expr(expr: CoreExpr): boolean {
  return expr.tag === "prim" && expr.prim === "i32.trap" &&
    expr.args.length === 0;
}
