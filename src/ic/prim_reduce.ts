import { expect } from "../expect.ts";
import { Prim } from "../op.ts";
import { Callable } from "../trait.ts";
import type { Ic } from "./ast.ts";

type Num = Extract<Ic, { tag: "num" }>;
type BinaryPrim = Exclude<
  Prim,
  | "i32.select"
  | "i64.select"
  | "f32.select"
  | "i32.load"
  | "i64.load"
  | "f32.load"
  | "i32.load8_u"
  | "i64.load8_u"
  | "i32.trap"
  | "i64.trap"
  | "f32.trap"
  | "f32.sqrt"
  | "f32.convert_i32_s"
  | "i32.trunc_f32_s"
  | "i32.wrap_i64"
  | "i64.extend_i32_s"
  | "i64.extend_i32_u"
  | "i32.reinterpret_f32"
  | "f32.reinterpret_i32"
>;
type UnaryPrim =
  | "f32.sqrt"
  | "f32.convert_i32_s"
  | "i32.trunc_f32_s"
  | "i32.wrap_i64"
  | "i64.extend_i32_s"
  | "i64.extend_i32_u"
  | "i32.reinterpret_f32"
  | "f32.reinterpret_i32";
type I32Prim = Extract<BinaryPrim, `i32.${string}`>;
type I64Prim = Extract<BinaryPrim, `i64.${string}`>;
type F32Prim = Extract<BinaryPrim, `f32.${string}`>;

function arg(args: Ic[], index: number): Ic {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

export function is_binary_prim(prim: Prim): prim is BinaryPrim {
  if (
    prim.endsWith(".select") || prim.endsWith(".load") ||
    prim.endsWith(".load8_u") || prim.endsWith(".trap") ||
    is_unary_prim(prim)
  ) {
    return false;
  }

  return true;
}

export function is_unary_prim(prim: Prim): prim is UnaryPrim {
  return prim === "f32.sqrt" || prim === "f32.convert_i32_s" ||
    prim === "i32.trunc_f32_s" || prim === "i32.wrap_i64" ||
    prim === "i64.extend_i32_s" || prim === "i64.extend_i32_u" ||
    prim === "i32.reinterpret_f32" || prim === "f32.reinterpret_i32";
}

export function fold_unary_prim(prim: UnaryPrim, value: Num): Ic {
  if (prim === "i32.wrap_i64") {
    expect(value.type === "i64", prim + " expects an i64 operand");
    expect(typeof value.value === "bigint", "Expected i64 bigint");
    return i32(Number(BigInt.asIntN(32, value.value)));
  }

  if (prim === "i64.extend_i32_s" || prim === "i64.extend_i32_u") {
    expect(value.type === "i32", prim + " expects an i32 operand");
    expect(typeof value.value === "number", "Expected i32 number");

    if (prim === "i64.extend_i32_s") {
      return i64(BigInt(value.value | 0));
    }

    return i64(BigInt(value.value >>> 0));
  }

  if (prim === "f32.reinterpret_i32") {
    expect(value.type === "i32", prim + " expects an i32 operand");
    expect(typeof value.value === "number", "Expected i32 number");
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setInt32(0, value.value, true);
    return f32(view.getFloat32(0, true));
  }

  if (prim === "i32.reinterpret_f32") {
    expect(value.type === "f32", prim + " expects an f32 operand");
    expect(typeof value.value === "number", "Expected f32 number");
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setFloat32(0, value.value, true);
    return i32(view.getInt32(0, true));
  }

  if (prim === "f32.convert_i32_s") {
    expect(value.type === "i32", "f32_from_i32 expects an i32 operand");
    expect(typeof value.value === "number", "Expected i32 number");
    return f32(value.value);
  }

  expect(value.type === "f32", prim + " expects an f32 operand");
  expect(typeof value.value === "number", "Expected f32 number");
  const float_value = Math.fround(value.value);

  if (prim === "f32.sqrt") {
    return f32(Math.sqrt(float_value));
  }

  if (
    !Number.isFinite(float_value) || float_value < -2147483648 ||
    float_value >= 2147483648
  ) {
    throw new Error("i32_from_f32 traps for value " + float_value.toString());
  }

  return i32(Math.trunc(float_value));
}

export function fold_select(prim: Prim, args: Ic[]): Ic {
  const then_branch = arg(args, 0);
  const else_branch = arg(args, 1);
  const cond = arg(args, 2);

  if (cond.tag !== "num") {
    return {
      tag: "prim",
      prim: select_prim(prim, then_branch, else_branch),
      args,
    };
  }

  expect(cond.type === "i32", "Select condition must be i32");
  const value = cond.value;
  expect(typeof value === "number", "Expected i32 select condition");

  if (value !== 0) {
    return then_branch;
  }

  return else_branch;
}

function select_prim(prim: Prim, then_branch: Ic, else_branch: Ic): Prim {
  if (then_branch.tag !== "num" || else_branch.tag !== "num") {
    return prim;
  }

  if (then_branch.type !== else_branch.type) {
    return prim;
  }

  if (then_branch.type === "i32") {
    return "i32.select";
  }

  if (then_branch.type === "i64") {
    return "i64.select";
  }

  return "f32.select";
}

export function fold_prim(
  prim: BinaryPrim,
  left: Num,
  right: Num,
): Ic {
  expect(left.type === right.type, "Primitive numbers must have the same type");

  const prim_type = Callable.type(Prim, prim);
  const left_expected = prim_type.args[0];
  const right_expected = prim_type.args[1];
  expect(left_expected, "Missing primitive argument type 0");
  expect(right_expected, "Missing primitive argument type 1");
  expect(
    left.type === left_expected,
    "Primitive " + prim + " argument 0 expects " + left_expected + ", got " +
      left.type,
  );
  expect(
    right.type === right_expected,
    "Primitive " + prim + " argument 1 expects " + right_expected + ", got " +
      right.type,
  );

  if (prim.startsWith("i32.")) {
    return fold_i32(prim as I32Prim, left, right);
  }

  if (prim.startsWith("i64.")) {
    return fold_i64(prim as I64Prim, left, right);
  }

  return fold_f32(prim as F32Prim, left, right);
}

function fold_i32(
  prim: I32Prim,
  left: Num,
  right: Num,
): Ic {
  const left_value = left.value;
  const right_value = right.value;
  expect(typeof left_value === "number", "Expected i32 number");
  expect(typeof right_value === "number", "Expected i32 number");

  switch (prim) {
    case "i32.add":
      return i32((left_value + right_value) | 0);
    case "i32.sub":
      return i32((left_value - right_value) | 0);
    case "i32.mul":
      return i32(Math.imul(left_value, right_value));
    case "i32.div_s":
      if (right_value === 0) {
        throw new Error("i32.div_s by zero");
      }
      return i32(Math.trunc(left_value / right_value) | 0);
    case "i32.rem_s":
      if (right_value === 0) {
        throw new Error("i32.rem_s by zero");
      }
      return i32((left_value % right_value) | 0);
    case "i32.and":
      return i32(left_value & right_value);
    case "i32.or":
      return i32(left_value | right_value);
    case "i32.xor":
      return i32(left_value ^ right_value);
    case "i32.shl":
      return i32(left_value << (right_value & 31));
    case "i32.shr_u":
      return i32((left_value >>> (right_value & 31)) | 0);
    case "i32.eq":
      return bool_num(left_value === right_value);
    case "i32.ne":
      return bool_num(left_value !== right_value);
    case "i32.lt_s":
      return bool_num(left_value < right_value);
    case "i32.le_s":
      return bool_num(left_value <= right_value);
    case "i32.gt_s":
      return bool_num(left_value > right_value);
    case "i32.ge_s":
      return bool_num(left_value >= right_value);
  }
}

function fold_i64(
  prim: I64Prim,
  left: Num,
  right: Num,
): Ic {
  const left_value = left.value;
  const right_value = right.value;
  expect(typeof left_value === "bigint", "Expected i64 bigint");
  expect(typeof right_value === "bigint", "Expected i64 bigint");

  switch (prim) {
    case "i64.add":
      return i64(left_value + right_value);
    case "i64.sub":
      return i64(left_value - right_value);
    case "i64.mul":
      return i64(left_value * right_value);
    case "i64.div_s":
      if (right_value === 0n) {
        throw new Error("i64.div_s by zero");
      }
      return i64(left_value / right_value);
    case "i64.rem_s":
      if (right_value === 0n) {
        throw new Error("i64.rem_s by zero");
      }
      return i64(left_value % right_value);
    case "i64.and":
      return i64(left_value & right_value);
    case "i64.or":
      return i64(left_value | right_value);
    case "i64.xor":
      return i64(left_value ^ right_value);
    case "i64.shl": {
      const shift = BigInt.asUintN(64, right_value) & 63n;
      return i64(left_value << shift);
    }
    case "i64.shr_u": {
      const shift = BigInt.asUintN(64, right_value) & 63n;
      return i64(BigInt.asUintN(64, left_value) >> shift);
    }
    case "i64.eq":
      return bool_num(left_value === right_value);
    case "i64.ne":
      return bool_num(left_value !== right_value);
    case "i64.lt_s":
      return bool_num(left_value < right_value);
    case "i64.le_s":
      return bool_num(left_value <= right_value);
    case "i64.gt_s":
      return bool_num(left_value > right_value);
    case "i64.ge_s":
      return bool_num(left_value >= right_value);
  }
}

function fold_f32(
  prim: F32Prim,
  left: Num,
  right: Num,
): Ic {
  const left_value = left.value;
  const right_value = right.value;
  expect(typeof left_value === "number", "Expected f32 number");
  expect(typeof right_value === "number", "Expected f32 number");
  const left_f32 = Math.fround(left_value);
  const right_f32 = Math.fround(right_value);

  switch (prim) {
    case "f32.add":
      return f32(left_f32 + right_f32);
    case "f32.sub":
      return f32(left_f32 - right_f32);
    case "f32.mul":
      return f32(left_f32 * right_f32);
    case "f32.div":
      return f32(left_f32 / right_f32);
    case "f32.eq":
      return bool_num(left_f32 === right_f32);
    case "f32.ne":
      return bool_num(left_f32 !== right_f32);
    case "f32.lt":
      return bool_num(left_f32 < right_f32);
    case "f32.le":
      return bool_num(left_f32 <= right_f32);
    case "f32.gt":
      return bool_num(left_f32 > right_f32);
    case "f32.ge":
      return bool_num(left_f32 >= right_f32);
  }
}

function i32(value: number): Ic {
  return { tag: "num", type: "i32", value };
}

function i64(value: bigint): Ic {
  return { tag: "num", type: "i64", value: BigInt.asIntN(64, value) };
}

function f32(value: number): Ic {
  return { tag: "num", type: "f32", value: Math.fround(value) };
}

function bool_num(value: boolean): Ic {
  if (value) {
    return i32(1);
  }

  return i32(0);
}
