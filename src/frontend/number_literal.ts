import type { FrontExpr } from "./ast.ts";
import {
  integer_literal_fits,
  integer_type_from_name,
  integer_val_type,
} from "../integer.ts";

export function parse_number_expr(text: string): FrontExpr {
  if (text.endsWith("f64")) {
    const literal = text.slice(0, text.length - 3);
    const value = Number(literal);

    if (!Number.isFinite(value)) {
      throw new Error("f64 literal is out of range: " + literal);
    }

    return { tag: "num", type: "f64", value };
  }

  if (text.endsWith("f32")) {
    const literal = text.slice(0, text.length - 3);
    const value = Math.fround(Number(literal));

    if (!Number.isFinite(value)) {
      throw new Error("f32 literal is out of range: " + literal);
    }

    return { tag: "num", type: "f32", value };
  }

  const integer_suffix = /([iu])([1-9][0-9]*)$/.exec(text);

  if (integer_suffix) {
    const suffix = integer_suffix[0];
    const integer = integer_type_from_name(suffix.toUpperCase());

    if (!integer) {
      throw new Error("Invalid fixed-width integer suffix: " + suffix);
    }

    const literal = text.slice(0, text.length - suffix.length);
    const value = BigInt(literal);
    let fits = integer_literal_fits(integer, value);

    if (integer.signed) {
      const minimum_magnitude = 1n << BigInt(integer.width - 1);

      if (value === minimum_magnitude) {
        fits = true;
      }
    }

    if (!fits) {
      throw new Error(
        "Integer literal " + literal + " is out of range for " +
          suffix.toUpperCase(),
      );
    }

    const carrier = integer_val_type(integer);
    let type: "i32" | "i64" = "i64";

    if (carrier) {
      type = carrier;
    }

    if (type === "i32") {
      if (suffix === "i32") {
        return { tag: "num", type, value: Number(value) };
      }

      return { tag: "num", type, value: Number(value), integer };
    }

    if (suffix === "i64") {
      return { tag: "num", type, value };
    }

    return { tag: "num", type, value, integer };
  }

  return { tag: "num", type: "i32", value: Number(text) };
}
