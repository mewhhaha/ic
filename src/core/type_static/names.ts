import type { ValType } from "../../op.ts";

export function is_core_builtin_type_name(name: string): boolean {
  return name === "Bool" || name === "Int" || name === "I32" ||
    name === "U32" ||
    name === "I64" || name === "F32" || name === "F64" ||
    name === "F32x4" ||
    name === "Text" || name === "Bytes" ||
    name === "Type" || name === "Unit" || name === "Resume";
}

export function core_val_type_from_type_name(
  name: string,
): ValType | undefined {
  if (
    name === "Bool" || name === "Int" || name === "I32" ||
    name === "U32" || name === "Text" || name === "Bytes" ||
    name === "Resume"
  ) {
    return "i32";
  }

  if (name === "I64") {
    return "i64";
  }

  if (name === "F32") {
    return "f32";
  }

  if (name === "F64") {
    return "f64";
  }

  if (name === "F32x4") {
    return "v128";
  }

  return undefined;
}
