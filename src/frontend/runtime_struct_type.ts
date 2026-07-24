import type { NumType, ValType } from "../op.ts";
import type { FrontType, TypeField } from "./ast.ts";
import { val_type_from_type_name } from "./types.ts";

export function indexed_result_type_from_fields(
  fields: TypeField[],
): NumType {
  if (indexed_type_fields_are_text(fields)) {
    return "i32";
  }

  if (indexed_type_fields_are_bool(fields)) {
    return "i32";
  }

  if (indexed_type_fields_are_char(fields)) {
    return "i32";
  }

  let result_type: ValType | undefined;

  for (const field of fields) {
    if (field.type_name === "Bool") {
      throw new Error("Mixed Bool and numeric indexed values");
    }

    if (field.type_name === "Char") {
      throw new Error("Mixed Char and numeric indexed values");
    }

    const field_type = val_type_from_type_name(field.type_name);

    if (!field_type) {
      throw new Error(
        "Cannot lower dynamic index for non-numeric field: " + field.name,
      );
    }

    if (field_type === "v128") {
      throw new Error(
        "Dynamic indexing of F32x4 fields requires 16-byte aggregate layout",
      );
    }

    if (result_type && result_type !== field_type) {
      throw new Error("Mixed i32 and i64 indexed values");
    }

    result_type = field_type;
  }

  if (
    result_type === "i64" || result_type === "f32" || result_type === "f64"
  ) {
    return result_type;
  }

  return "i32";
}

export function dynamic_index_type_from_fields(fields: TypeField[]): FrontType {
  if (indexed_type_fields_are_text(fields)) {
    return { tag: "text" };
  }

  if (indexed_type_fields_are_bool(fields)) {
    return { tag: "bool" };
  }

  if (indexed_type_fields_are_char(fields)) {
    return { tag: "char" };
  }

  return {
    tag: "int",
    type: indexed_result_type_from_fields(fields),
  };
}

export function indexed_type_fields_are_text(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Text") {
      return false;
    }
  }

  return true;
}

export function indexed_type_fields_are_bool(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Bool") {
      return false;
    }
  }

  return true;
}

export function indexed_type_fields_are_char(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Char") {
      return false;
    }
  }

  return true;
}
