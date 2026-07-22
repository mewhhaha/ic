import type { FrontExpr } from "./ast.ts";
import { format_expr } from "./format.ts";

export function call_message(args: FrontExpr[]): string {
  const first = args[0];

  if (!first) {
    return "";
  }

  if (first.tag === "text") {
    return first.value;
  }

  return format_expr(first);
}
