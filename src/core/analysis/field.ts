import { expect } from "../../expect.ts";
import type { CoreField } from "../ast.ts";

export function find_core_field(
  fields: CoreField[],
  name: string,
): CoreField | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

export function static_indexed_field(
  fields: CoreField[],
  index: number,
): CoreField {
  if (index < 0 || index >= fields.length) {
    throw new Error("Index out of bounds: " + index.toString());
  }

  const field = fields[index];
  expect(field, "Missing static collection field " + index.toString());
  return field;
}
