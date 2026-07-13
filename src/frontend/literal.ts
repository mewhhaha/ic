import { expect } from "../expect.ts";
import type { FrontExpr, Token } from "./ast.ts";
import { i32_expr, parse_number_expr } from "./numeric.ts";

export function front_literal_expr(token: Token): FrontExpr | undefined {
  if (token.kind === "number") {
    return parse_number_expr(token.text);
  }

  if (token.kind === "string") {
    return { tag: "text", value: token.text };
  }

  if (token.kind === "character") {
    const code_point = token.text.codePointAt(0);
    expect(code_point !== undefined, "Missing character literal code point");
    return i32_expr(code_point);
  }

  if (token.kind === "name" && token.text === "true") {
    return { tag: "bool", value: true };
  }

  if (token.kind === "name" && token.text === "false") {
    return { tag: "bool", value: false };
  }

  return undefined;
}
