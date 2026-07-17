import { expect } from "../expect.ts";
import type {
  ArrayLengthExpr,
  FrontExpr,
  TypeExpr,
  TypeProductEntry,
} from "./ast.ts";

export type FixedArrayLengthResolver = (
  name: string,
) => number | undefined;

export function fixed_array_length(
  length: ArrayLengthExpr,
  resolve_name?: FixedArrayLengthResolver,
): number {
  return type_repetition_length(length, resolve_name, "Fixed array");
}

export function value_pack_length(
  length: ArrayLengthExpr,
  resolve_name?: FixedArrayLengthResolver,
): number {
  return type_repetition_length(length, resolve_name, "Value-pack");
}

function type_repetition_length(
  length: ArrayLengthExpr,
  resolve_name: FixedArrayLengthResolver | undefined,
  subject: string,
): number {
  const value = evaluate_fixed_array_length(length, resolve_name, subject);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      subject + " length must be a non-negative safe integer, got " +
        value.toString(),
    );
  }

  return value;
}

export function expanded_type_product_entries(
  type: Extract<TypeExpr, { tag: "product" }>,
  resolve_name: FixedArrayLengthResolver,
): TypeProductEntry[] {
  if (type.repeat === undefined) {
    return type.entries;
  }

  expect(
    type.value_pack === true && type.entries.length === 1,
    "Repeated value pack must have exactly one element type",
  );
  const entry = type.entries[0];
  expect(entry !== undefined, "Repeated value pack has no element type");
  const length = value_pack_length(type.repeat, resolve_name);
  return Array.from({ length }, () => ({ ...entry }));
}

export function const_i32_value(
  expr: FrontExpr,
  resolve_name: FixedArrayLengthResolver,
): number | undefined {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    typeof expr.value === "number"
  ) {
    return expr.value;
  }

  if (expr.tag === "var") {
    return resolve_name(expr.name);
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return const_i32_value(expr.expr, resolve_name);
  }

  if (expr.tag !== "prim") {
    return undefined;
  }

  const left = const_i32_value(expr.left, resolve_name);
  const right = const_i32_value(expr.right, resolve_name);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (expr.prim === "i32.add") {
    return (left + right) | 0;
  }

  if (expr.prim === "i32.sub") {
    return (left - right) | 0;
  }

  if (expr.prim === "i32.mul") {
    return Math.imul(left, right);
  }

  if (expr.prim === "i32.div_s") {
    if (right === 0) {
      return undefined;
    }

    return Math.trunc(left / right) | 0;
  }

  if (expr.prim === "i32.rem_s") {
    if (right === 0) {
      return undefined;
    }

    return left % right;
  }

  return undefined;
}

export function normalize_fixed_array_type_lengths(
  type: TypeExpr,
  resolve_name: FixedArrayLengthResolver,
): TypeExpr {
  switch (type.tag) {
    case "forall":
      return {
        ...type,
        body: normalize_fixed_array_type_lengths(type.body, resolve_name),
      };

    case "name":
    case "atom":
    case "top":
    case "never":
      return type;

    case "frozen":
    case "borrow":
      return {
        ...type,
        value: normalize_fixed_array_type_lengths(type.value, resolve_name),
      };

    case "union":
    case "intersection":
    case "difference":
      return {
        ...type,
        left: normalize_fixed_array_type_lengths(type.left, resolve_name),
        right: normalize_fixed_array_type_lengths(type.right, resolve_name),
      };

    case "apply":
      return {
        ...type,
        func: normalize_fixed_array_type_lengths(type.func, resolve_name),
        arg: normalize_fixed_array_type_lengths(type.arg, resolve_name),
      };

    case "tuple":
      return {
        ...type,
        items: type.items.map((item) =>
          normalize_fixed_array_type_lengths(item, resolve_name)
        ),
      };

    case "product":
      if (type.repeat !== undefined) {
        return {
          tag: "product",
          entries: expanded_type_product_entries(type, resolve_name).map(
            (entry) => ({
              ...entry,
              type_expr: normalize_fixed_array_type_lengths(
                entry.type_expr,
                resolve_name,
              ),
            }),
          ),
          value_pack: true,
        };
      }
      return {
        ...type,
        entries: type.entries.map((entry) => ({
          ...entry,
          type_expr: normalize_fixed_array_type_lengths(
            entry.type_expr,
            resolve_name,
          ),
        })),
      };

    case "array":
      return {
        ...type,
        element: normalize_fixed_array_type_lengths(
          type.element,
          resolve_name,
        ),
        length: {
          tag: "number",
          value: fixed_array_length(type.length, resolve_name),
        },
      };

    case "arrow":
      return {
        ...type,
        param: normalize_fixed_array_type_lengths(type.param, resolve_name),
        result: normalize_fixed_array_type_lengths(type.result, resolve_name),
      };
  }
}

function evaluate_fixed_array_length(
  length: ArrayLengthExpr,
  resolve_name: FixedArrayLengthResolver | undefined,
  subject: string,
): number {
  if (length.tag === "number") {
    return length.value;
  }

  if (length.tag === "name") {
    let value: number | undefined;

    if (resolve_name !== undefined) {
      value = resolve_name(length.name);
    }

    if (value === undefined) {
      throw new Error(
        subject + " length requires a compile-time natural: " + length.name,
      );
    }

    return value;
  }

  const left = evaluate_fixed_array_length(length.left, resolve_name, subject);
  const right = evaluate_fixed_array_length(
    length.right,
    resolve_name,
    subject,
  );
  let value: number;

  if (length.op === "+") {
    value = left + right;
  } else if (length.op === "-") {
    value = left - right;
  } else if (length.op === "*") {
    value = left * right;
  } else if (length.op === "/") {
    if (right === 0) {
      throw new Error(subject + " length divides by zero");
    }

    value = Math.trunc(left / right);
  } else {
    if (right === 0) {
      throw new Error(subject + " length divides by zero");
    }

    value = left % right;
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error(
      "Fixed array length arithmetic overflowed a safe integer",
    );
  }

  return value;
}
