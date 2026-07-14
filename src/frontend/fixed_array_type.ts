import type { ArrayLengthExpr } from "./ast.ts";

export function fixed_array_length(length: ArrayLengthExpr): number {
  if (length.tag !== "number") {
    throw new Error(
      "Fixed array length must be a non-negative integer literal",
    );
  }

  if (!Number.isSafeInteger(length.value) || length.value < 0) {
    throw new Error(
      "Fixed array length must be a non-negative safe integer, got " +
        length.value.toString(),
    );
  }

  return length.value;
}
