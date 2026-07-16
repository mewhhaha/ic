import { expect } from "../../expect.ts";
import type { CoreExpr } from "../ast.ts";

export function maybe_static_i32(expr: CoreExpr): number | undefined {
  if (expr.tag !== "num") {
    return undefined;
  }

  if (expr.type !== "i32") {
    return undefined;
  }

  const value = expr.value;
  expect(typeof value === "number", "Expected i32 static value");
  return value;
}

export function static_i32(expr: CoreExpr, label: string): number {
  if (expr.tag !== "num" || expr.type !== "i32") {
    throw new Error("Core " + label + " must be a static i32");
  }

  const value = expr.value;
  expect(typeof value === "number", "Expected i32 " + label);
  return value;
}
