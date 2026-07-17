import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";

export function store_instr(value_type: ValType, offset: number): Wat {
  return value_type + ".store offset=" + offset.toString();
}

export function load_instr(value_type: ValType, offset: number): Wat {
  return value_type + ".load offset=" + offset.toString();
}

export function val_type_size(value_type: ValType): number {
  if (value_type === "i32" || value_type === "f32") {
    return 4;
  }

  if (value_type === "i64" || value_type === "f64") {
    return 8;
  }

  if (value_type === "v128") {
    return 16;
  }

  value_type satisfies never;
  throw new Error("@panic");
}

export function val_type_align(value_type: ValType): number {
  return val_type_size(value_type);
}

export function align_to(value: number, alignment: number): number {
  const remainder = value % alignment;

  if (remainder === 0) {
    return value;
  }

  return value + alignment - remainder;
}

export function align_pointer_instr(alignment: number): Wat {
  return [
    "i32.const " + (alignment - 1).toString(),
    "i32.add",
    "i32.const " + (-alignment).toString(),
    "i32.and",
  ].join("\n");
}
