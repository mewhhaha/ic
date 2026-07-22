import type { FrontExpr } from "./ast.ts";

export function compiler_builtin_args(
  expr: Extract<FrontExpr, { tag: "app" }>,
): FrontExpr[] {
  const packed = expr.args[0];

  if (
    expr.args.length === 1 && packed !== undefined &&
    packed.tag === "product"
  ) {
    return packed.entries.map((entry) => entry.value);
  }

  return expr.args;
}
