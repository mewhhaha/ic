import { expect } from "./expect.ts";
import { Callable, type CallableType, Emit, Format } from "./trait.ts";

export type NumType = "i32" | "i64" | "f32";
export type ValType = NumType | "v128";

type IntegerPrimOp =
  | "add"
  | "sub"
  | "mul"
  | "div_s"
  | "rem_s"
  | "eq"
  | "ne"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr_u"
  | "select"
  | "load"
  | "load8_u"
  | "trap";

type I32PrimOp = IntegerPrimOp | "trunc_f32_s" | "wrap_i64" | "reinterpret_f32";

type I64PrimOp = IntegerPrimOp | "extend_i32_s" | "extend_i32_u";

type FloatPrimOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "select"
  | "load"
  | "trap"
  | "sqrt"
  | "convert_i32_s"
  | "reinterpret_i32";

type NumericOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "rem"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr_u";

export type Prim =
  | `i32.${I32PrimOp}`
  | `i64.${I64PrimOp}`
  | `f32.${FloatPrimOp}`
  | "f32x4.make"
  | "f32x4.splat"
  | "f32x4.add"
  | "f32x4.sub"
  | "f32x4.mul"
  | "f32x4.div"
  | "f32x4.extract_lane"
  | "f32x4.replace_lane";

export type NumericBuiltinName =
  | "@bit_and"
  | "@bit_or"
  | "@bit_xor"
  | "@shift_left"
  | "@shift_right_u"
  | "@f32_sqrt"
  | "@f32_from_i32"
  | "@i32_from_f32"
  | "@unsafe_i32_wrap_i64"
  | "@unsafe_i64_extend_i32_signed"
  | "@unsafe_i64_extend_i32_unsigned"
  | "@unsafe_i32_reinterpret_f32"
  | "@unsafe_f32_reinterpret_i32";

export type F32x4BuiltinName =
  | "@f32x4"
  | "@f32x4_splat"
  | "@f32x4_add"
  | "@f32x4_sub"
  | "@f32x4_mul"
  | "@f32x4_div"
  | "@f32x4_extract_lane"
  | "@f32x4_replace_lane";

export type PrimOperandEmission = {
  wat: string;
  i32_literal: number | undefined;
};

export function Prim() {}

export function numeric_builtin_prim(name: string): Prim | undefined {
  switch (name) {
    case "@bit_and":
      return "i32.and";
    case "@bit_or":
      return "i32.or";
    case "@bit_xor":
      return "i32.xor";
    case "@shift_left":
      return "i32.shl";
    case "@shift_right_u":
      return "i32.shr_u";
    case "@f32_sqrt":
      return "f32.sqrt";
    case "@f32_from_i32":
      return "f32.convert_i32_s";
    case "@i32_from_f32":
      return "i32.trunc_f32_s";
    case "@unsafe_i32_wrap_i64":
      return "i32.wrap_i64";
    case "@unsafe_i64_extend_i32_signed":
      return "i64.extend_i32_s";
    case "@unsafe_i64_extend_i32_unsigned":
      return "i64.extend_i32_u";
    case "@unsafe_i32_reinterpret_f32":
      return "i32.reinterpret_f32";
    case "@unsafe_f32_reinterpret_i32":
      return "f32.reinterpret_i32";
    default:
      return undefined;
  }
}

export function wasm_intrinsic_prim(name: string): Prim | undefined {
  const separator = name.lastIndexOf("_");

  if (separator < 1 || separator === name.length - 1) {
    return undefined;
  }

  const operation = name.slice(0, separator);
  const type = name.slice(separator + 1);

  if (type !== "i32" && type !== "i64" && type !== "f32") {
    return undefined;
  }

  if (
    operation === "add" || operation === "sub" || operation === "mul" ||
    operation === "eq" || operation === "ne"
  ) {
    return type + "." + operation as Prim;
  }

  if (operation === "div") {
    if (type === "f32") {
      return "f32.div";
    }

    return type + ".div_s" as Prim;
  }

  if (
    operation === "lt" || operation === "le" || operation === "gt" ||
    operation === "ge"
  ) {
    if (type === "f32") {
      return "f32." + operation as Prim;
    }

    return type + "." + operation + "_s" as Prim;
  }

  if (
    type !== "f32" &&
    (operation === "rem" || operation === "and" || operation === "or" ||
      operation === "xor" || operation === "shl" || operation === "shr_u")
  ) {
    let wasm_operation = operation;

    if (operation === "rem") {
      wasm_operation = "rem_s";
    }

    return type + "." + wasm_operation as Prim;
  }

  return undefined;
}

export function f32x4_builtin_prim(name: string): Prim | undefined {
  switch (name) {
    case "@f32x4":
      return "f32x4.make";
    case "@f32x4_splat":
      return "f32x4.splat";
    case "@f32x4_add":
      return "f32x4.add";
    case "@f32x4_sub":
      return "f32x4.sub";
    case "@f32x4_mul":
      return "f32x4.mul";
    case "@f32x4_div":
      return "f32x4.div";
    case "@f32x4_extract_lane":
      return "f32x4.extract_lane";
    case "@f32x4_replace_lane":
      return "f32x4.replace_lane";
    default:
      return undefined;
  }
}

export function f32x4_builtin_name(
  prim: Prim,
): F32x4BuiltinName | undefined {
  switch (prim) {
    case "f32x4.make":
      return "@f32x4";
    case "f32x4.splat":
      return "@f32x4_splat";
    case "f32x4.add":
      return "@f32x4_add";
    case "f32x4.sub":
      return "@f32x4_sub";
    case "f32x4.mul":
      return "@f32x4_mul";
    case "f32x4.div":
      return "@f32x4_div";
    case "f32x4.extract_lane":
      return "@f32x4_extract_lane";
    case "f32x4.replace_lane":
      return "@f32x4_replace_lane";
    default:
      return undefined;
  }
}

export function numeric_builtin_name(
  prim: Prim,
): NumericBuiltinName | undefined {
  switch (prim) {
    case "i32.and":
    case "i64.and":
      return "@bit_and";
    case "i32.or":
    case "i64.or":
      return "@bit_or";
    case "i32.xor":
    case "i64.xor":
      return "@bit_xor";
    case "i32.shl":
    case "i64.shl":
      return "@shift_left";
    case "i32.shr_u":
    case "i64.shr_u":
      return "@shift_right_u";
    case "f32.sqrt":
      return "@f32_sqrt";
    case "f32.convert_i32_s":
      return "@f32_from_i32";
    case "i32.trunc_f32_s":
      return "@i32_from_f32";
    case "i32.wrap_i64":
      return "@unsafe_i32_wrap_i64";
    case "i64.extend_i32_s":
      return "@unsafe_i64_extend_i32_signed";
    case "i64.extend_i32_u":
      return "@unsafe_i64_extend_i32_unsigned";
    case "i32.reinterpret_f32":
      return "@unsafe_i32_reinterpret_f32";
    case "f32.reinterpret_i32":
      return "@unsafe_f32_reinterpret_i32";
    default:
      return undefined;
  }
}

export function specialize_prim_for_operands(
  prim: Prim,
  left_type: ValType | undefined,
  right_type: ValType | undefined,
): Prim {
  const op = binary_numeric_op(prim);

  if (!op) {
    return prim;
  }

  if (left_type === "f32" || right_type === "f32") {
    if (left_type !== undefined && left_type !== "f32") {
      throw mixed_numeric_types(op, left_type, "f32");
    }

    if (right_type !== undefined && right_type !== "f32") {
      throw mixed_numeric_types(op, "f32", right_type);
    }

    if (left_type === "f32" && right_type === "f32") {
      return prim_for_type("f32", op);
    }

    return prim;
  }

  if (left_type === "i64" || right_type === "i64") {
    if (left_type === "i32" || right_type === "i32") {
      throw mixed_numeric_types(op, "i32", "i64");
    }

    return prim_for_type("i64", op);
  }

  if (left_type === "i32" && right_type === "i32") {
    return prim_for_type("i32", op);
  }

  return prim;
}

function mixed_numeric_types(
  op: NumericOp,
  left: ValType,
  right: ValType,
): Error {
  return new Error(
    "Mixed " + left + " and " + right + " operands for operator " +
      numeric_op_text(op),
  );
}

function binary_numeric_op(prim: Prim): NumericOp | undefined {
  switch (prim) {
    case "i32.add":
    case "i64.add":
    case "f32.add":
      return "add";
    case "i32.sub":
    case "i64.sub":
    case "f32.sub":
      return "sub";
    case "i32.mul":
    case "i64.mul":
    case "f32.mul":
      return "mul";
    case "i32.div_s":
    case "i64.div_s":
    case "f32.div":
      return "div";
    case "i32.rem_s":
    case "i64.rem_s":
      return "rem";
    case "i32.eq":
    case "i64.eq":
    case "f32.eq":
      return "eq";
    case "i32.ne":
    case "i64.ne":
    case "f32.ne":
      return "ne";
    case "i32.lt_s":
    case "i64.lt_s":
    case "f32.lt":
      return "lt";
    case "i32.le_s":
    case "i64.le_s":
    case "f32.le":
      return "le";
    case "i32.gt_s":
    case "i64.gt_s":
    case "f32.gt":
      return "gt";
    case "i32.ge_s":
    case "i64.ge_s":
    case "f32.ge":
      return "ge";
    case "i32.and":
    case "i64.and":
      return "and";
    case "i32.or":
    case "i64.or":
      return "or";
    case "i32.xor":
    case "i64.xor":
      return "xor";
    case "i32.shl":
    case "i64.shl":
      return "shl";
    case "i32.shr_u":
    case "i64.shr_u":
      return "shr_u";
    case "i32.select":
    case "i64.select":
    case "f32.select":
    case "i32.load":
    case "i64.load":
    case "f32.load":
    case "i32.load8_u":
    case "i64.load8_u":
    case "i32.trap":
    case "i64.trap":
    case "f32.trap":
    case "f32.sqrt":
    case "f32.convert_i32_s":
    case "i32.trunc_f32_s":
    case "i32.wrap_i64":
    case "i64.extend_i32_s":
    case "i64.extend_i32_u":
    case "i32.reinterpret_f32":
    case "f32.reinterpret_i32":
    case "f32x4.make":
    case "f32x4.splat":
    case "f32x4.add":
    case "f32x4.sub":
    case "f32x4.mul":
    case "f32x4.div":
    case "f32x4.extract_lane":
    case "f32x4.replace_lane":
      return undefined;
  }
}

function numeric_op_text(op: NumericOp): string {
  switch (op) {
    case "add":
      return "+";
    case "sub":
      return "-";
    case "mul":
      return "*";
    case "div":
      return "/";
    case "rem":
      return "%";
    case "eq":
      return "==";
    case "ne":
      return "!=";
    case "lt":
      return "<";
    case "le":
      return "<=";
    case "gt":
      return ">";
    case "ge":
      return ">=";
    case "and":
      return "@bit_and";
    case "or":
      return "@bit_or";
    case "xor":
      return "@bit_xor";
    case "shl":
      return "@shift_left";
    case "shr_u":
      return "@shift_right_u";
  }
}

function prim_for_type(type: NumType, op: NumericOp): Prim {
  if (type === "f32") {
    switch (op) {
      case "add":
        return "f32.add";
      case "sub":
        return "f32.sub";
      case "mul":
        return "f32.mul";
      case "div":
        return "f32.div";
      case "eq":
        return "f32.eq";
      case "ne":
        return "f32.ne";
      case "lt":
        return "f32.lt";
      case "le":
        return "f32.le";
      case "gt":
        return "f32.gt";
      case "ge":
        return "f32.ge";
      case "rem":
      case "and":
      case "or":
      case "xor":
      case "shl":
      case "shr_u":
        throw new Error(
          "Operator " + numeric_op_text(op) + " does not support f32 operands",
        );
    }
  }

  const prefix = type + ".";

  switch (op) {
    case "add":
      return prefix + "add" as Prim;
    case "sub":
      return prefix + "sub" as Prim;
    case "mul":
      return prefix + "mul" as Prim;
    case "div":
      return prefix + "div_s" as Prim;
    case "rem":
      return prefix + "rem_s" as Prim;
    case "eq":
      return prefix + "eq" as Prim;
    case "ne":
      return prefix + "ne" as Prim;
    case "lt":
      return prefix + "lt_s" as Prim;
    case "le":
      return prefix + "le_s" as Prim;
    case "gt":
      return prefix + "gt_s" as Prim;
    case "ge":
      return prefix + "ge_s" as Prim;
    case "and":
      return prefix + "and" as Prim;
    case "or":
      return prefix + "or" as Prim;
    case "xor":
      return prefix + "xor" as Prim;
    case "shl":
      return prefix + "shl" as Prim;
    case "shr_u":
      return prefix + "shr_u" as Prim;
  }
}

Prim.fmt = function fmt(prim: Prim): string {
  const f32x4_builtin = f32x4_builtin_name(prim);

  if (f32x4_builtin) {
    return f32x4_builtin;
  }

  const builtin = numeric_builtin_name(prim);

  if (builtin) {
    return builtin;
  }

  const op = binary_numeric_op(prim);

  if (op) {
    return numeric_op_text(op);
  }

  switch (prim) {
    case "i32.select":
    case "i64.select":
    case "f32.select":
      return "select";
    case "i32.load":
    case "i64.load":
    case "f32.load":
      return "load";
    case "i32.load8_u":
    case "i64.load8_u":
      return "load8_u";
    case "i32.trap":
    case "i64.trap":
    case "f32.trap":
      return "trap";
    case "f32.sqrt":
    case "f32.convert_i32_s":
    case "i32.trunc_f32_s":
    case "i32.wrap_i64":
    case "i64.extend_i32_s":
    case "i64.extend_i32_u":
    case "i32.reinterpret_f32":
    case "f32.reinterpret_i32":
      throw new Error("Missing named primitive format: " + prim);

    case "f32x4.make":
    case "f32x4.splat":
    case "f32x4.add":
    case "f32x4.sub":
    case "f32x4.mul":
    case "f32x4.div":
    case "f32x4.extract_lane":
    case "f32x4.replace_lane":
      throw new Error("Missing f32x4 primitive format: " + prim);
  }

  throw new Error("Unknown primitive format: " + prim);
};

Prim.type = function type(prim: Prim): CallableType<ValType> {
  switch (prim) {
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i32.div_s":
    case "i32.rem_s":
    case "i32.and":
    case "i32.or":
    case "i32.xor":
    case "i32.shl":
    case "i32.shr_u":
      return { args: ["i32", "i32"], result: "i32" };
    case "i32.eq":
    case "i32.ne":
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
      return { args: ["i32", "i32"], result: "i32" };
    case "i32.select":
      return { args: ["i32", "i32", "i32"], result: "i32" };
    case "i32.load":
    case "i32.load8_u":
      return { args: ["i32"], result: "i32" };
    case "i32.trap":
      return { args: [], result: "i32" };
    case "i32.trunc_f32_s":
      return { args: ["f32"], result: "i32" };
    case "i32.wrap_i64":
      return { args: ["i64"], result: "i32" };
    case "i32.reinterpret_f32":
      return { args: ["f32"], result: "i32" };

    case "i64.add":
    case "i64.sub":
    case "i64.mul":
    case "i64.div_s":
    case "i64.rem_s":
    case "i64.and":
    case "i64.or":
    case "i64.xor":
    case "i64.shl":
    case "i64.shr_u":
      return { args: ["i64", "i64"], result: "i64" };
    case "i64.eq":
    case "i64.ne":
    case "i64.lt_s":
    case "i64.le_s":
    case "i64.gt_s":
    case "i64.ge_s":
      return { args: ["i64", "i64"], result: "i32" };
    case "i64.select":
      return { args: ["i64", "i64", "i32"], result: "i64" };
    case "i64.load":
    case "i64.load8_u":
      return { args: ["i32"], result: "i64" };
    case "i64.trap":
      return { args: [], result: "i64" };
    case "i64.extend_i32_s":
    case "i64.extend_i32_u":
      return { args: ["i32"], result: "i64" };

    case "f32.add":
    case "f32.sub":
    case "f32.mul":
    case "f32.div":
      return { args: ["f32", "f32"], result: "f32" };
    case "f32.eq":
    case "f32.ne":
    case "f32.lt":
    case "f32.le":
    case "f32.gt":
    case "f32.ge":
      return { args: ["f32", "f32"], result: "i32" };
    case "f32.select":
      return { args: ["f32", "f32", "i32"], result: "f32" };
    case "f32.load":
      return { args: ["i32"], result: "f32" };
    case "f32.trap":
      return { args: [], result: "f32" };
    case "f32.sqrt":
      return { args: ["f32"], result: "f32" };
    case "f32.convert_i32_s":
      return { args: ["i32"], result: "f32" };
    case "f32.reinterpret_i32":
      return { args: ["i32"], result: "f32" };

    case "f32x4.make":
      return { args: ["f32", "f32", "f32", "f32"], result: "v128" };
    case "f32x4.splat":
      return { args: ["f32"], result: "v128" };
    case "f32x4.add":
    case "f32x4.sub":
    case "f32x4.mul":
    case "f32x4.div":
      return { args: ["v128", "v128"], result: "v128" };
    case "f32x4.extract_lane":
      return { args: ["v128", "i32"], result: "f32" };
    case "f32x4.replace_lane":
      return { args: ["v128", "i32", "f32"], result: "v128" };
  }
};

Prim.arity = function arity(prim: Prim): number {
  return Prim.type(prim).args.length;
};

Prim.emit = function emit(prim: Prim): string {
  if (prim.endsWith(".trap")) {
    return "unreachable";
  }

  if (prim.endsWith(".select")) {
    return "select";
  }

  return prim;
};

export function emit_prim_call(
  prim: Prim,
  operands: PrimOperandEmission[],
): string {
  const expected = Prim.type(prim).args.length;
  expect(
    operands.length === expected,
    "Primitive " + prim + " expects " + expected + " arguments",
  );

  if (prim === "f32x4.make") {
    const first = operands[0];
    const second = operands[1];
    const third = operands[2];
    const fourth = operands[3];
    expect(first, "Missing f32x4 argument 0");
    expect(second, "Missing f32x4 argument 1");
    expect(third, "Missing f32x4 argument 2");
    expect(fourth, "Missing f32x4 argument 3");
    return [
      first.wat,
      "f32x4.splat",
      second.wat,
      "f32x4.replace_lane 1",
      third.wat,
      "f32x4.replace_lane 2",
      fourth.wat,
      "f32x4.replace_lane 3",
    ].join("\n");
  }

  if (prim === "f32x4.extract_lane") {
    const vector = operands[0];
    const lane = operands[1];
    expect(vector, "Missing f32x4_extract_lane vector");
    expect(lane, "Missing f32x4_extract_lane lane");
    const lane_index = f32x4_lane_index(prim, lane.i32_literal);
    return vector.wat + "\nf32x4.extract_lane " + lane_index;
  }

  if (prim === "f32x4.replace_lane") {
    const vector = operands[0];
    const lane = operands[1];
    const value = operands[2];
    expect(vector, "Missing f32x4_replace_lane vector");
    expect(lane, "Missing f32x4_replace_lane lane");
    expect(value, "Missing f32x4_replace_lane value");
    const lane_index = f32x4_lane_index(prim, lane.i32_literal);
    return vector.wat + "\n" + value.wat + "\nf32x4.replace_lane " +
      lane_index;
  }

  const lines = operands.map((operand) => operand.wat);
  lines.push(Prim.emit(prim));
  return lines.join("\n");
}

export function f32x4_lane_index(
  prim: "f32x4.extract_lane" | "f32x4.replace_lane",
  value: number | undefined,
): number {
  const builtin = f32x4_builtin_name(prim);
  expect(builtin, "Missing f32x4 lane builtin name");
  expect(value !== undefined, builtin + " lane must be an i32 literal");
  expect(Number.isInteger(value), builtin + " lane must be an i32 literal");
  expect(
    value >= 0 && value <= 3,
    builtin + " lane must be between 0 and 3, got " + value,
  );
  return value;
}

Format.register<Prim>(Prim);
Callable.register<Prim, ValType>(Prim);
Emit.register<Prim, string>(Prim);
