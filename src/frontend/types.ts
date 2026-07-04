import { expect } from "../expect.ts";
import type { FrontType, Param, TypeField } from "./ast.ts";
import type { ValType } from "../op.ts";

export function is_builtin_type_name(name: string): boolean {
  return name === "Unit" || name === "Int" || name === "I32" ||
    name === "U32" || name === "I64" || name === "Text";
}

export function front_type_from_type_name(name: string): FrontType {
  if (name === "Int" || name === "I32" || name === "U32") {
    return { tag: "int", type: "i32" };
  }

  if (name === "I64") {
    return { tag: "int", type: "i64" };
  }

  if (name === "Text") {
    return { tag: "text" };
  }

  if (name === "Unit") {
    return { tag: "unknown" };
  }

  return { tag: "unknown" };
}

export function val_type_from_type_name(name: string): ValType | undefined {
  if (name === "I64") {
    return "i64";
  }

  if (name === "Int" || name === "I32" || name === "U32") {
    return "i32";
  }

  return undefined;
}

export function front_type_name(type: FrontType): string {
  switch (type.tag) {
    case "int":
      if (type.type === "i64") {
        return "I64";
      }

      if (type.type === "i32") {
        return "I32";
      }

      return "Int";

    case "text":
      return "Text";

    case "type":
      return "Type";

    case "struct":
      return "struct";

    case "union":
      return "union";

    case "union_value":
      return "union";

    case "unknown":
      return "unknown";

    case "fn":
      return "function";
  }
}

export function type_name_from_front_type(
  type: FrontType,
): string | undefined {
  if (type.tag === "int") {
    if (type.type === "i64") {
      return "I64";
    }

    return "Int";
  }

  if (type.tag === "text") {
    return "Text";
  }

  return undefined;
}

export function numeric_front_type(type: FrontType): ValType | undefined {
  if (type.tag === "int") {
    return type.type;
  }

  return undefined;
}

export function common_front_type(
  left: FrontType,
  right: FrontType,
): FrontType | undefined {
  if (!same_type(left, right)) {
    return undefined;
  }

  if (left.tag === "unknown") {
    return right;
  }

  if (right.tag === "unknown") {
    return left;
  }

  if (left.tag === "int" && right.tag === "int") {
    if (!left.type && right.type) {
      return right;
    }

    if (!right.type && left.type) {
      return left;
    }
  }

  return left;
}

export function same_type(left: FrontType, right: FrontType): boolean {
  if (left.tag === "unknown" || right.tag === "unknown") {
    return true;
  }

  if (left.tag === "int" && right.tag === "int") {
    if (left.type && right.type) {
      return left.type === right.type;
    }

    return true;
  }

  if (left.tag === "struct" && right.tag === "struct") {
    if (left.fields.length !== right.fields.length) {
      return false;
    }

    for (let index = 0; index < left.fields.length; index += 1) {
      const left_field = left.fields[index];
      const right_field = right.fields[index];
      expect(left_field, "Missing left struct field " + index);
      expect(right_field, "Missing right struct field " + index);

      if (left_field !== right_field) {
        return false;
      }
    }

    if (left.field_types && right.field_types) {
      return same_type_fields(left.field_types, right.field_types);
    }

    return true;
  }

  if (left.tag === "union" && right.tag === "union") {
    return left.case_name === right.case_name;
  }

  if (left.tag === "union_value" && right.tag === "union_value") {
    if (left.cases.length !== right.cases.length) {
      return false;
    }

    for (let index = 0; index < left.cases.length; index += 1) {
      const left_case = left.cases[index];
      const right_case = right.cases[index];
      expect(left_case, "Missing left union case " + index);
      expect(right_case, "Missing right union case " + index);

      if (left_case.name !== right_case.name) {
        return false;
      }

      if (!same_type_name(left_case.type_name, right_case.type_name)) {
        return false;
      }
    }

    return true;
  }

  if (left.tag === "fn" && right.tag === "fn") {
    return same_function_params(left.params, right.params);
  }

  return left.tag === right.tag;
}

function same_function_params(left: Param[], right: Param[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_param = left[index];
    const right_param = right[index];
    expect(left_param, "Missing left function parameter " + index);
    expect(right_param, "Missing right function parameter " + index);

    if (left_param.is_const !== right_param.is_const) {
      return false;
    }

    if (left_param.is_linear !== right_param.is_linear) {
      return false;
    }

    if (!same_param_annotation(left_param.annotation, right_param.annotation)) {
      return false;
    }
  }

  return true;
}

export function same_param_annotation(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return same_type_name(left, right);
}

function same_type_fields(left: TypeField[], right: TypeField[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_field = left[index];
    const right_field = right[index];
    expect(left_field, "Missing left type field " + index);
    expect(right_field, "Missing right type field " + index);

    if (left_field.name !== right_field.name) {
      return false;
    }

    if (!same_type_name(left_field.type_name, right_field.type_name)) {
      return false;
    }
  }

  return true;
}

function same_type_name(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const left_value_type = val_type_from_type_name(left);
  const right_value_type = val_type_from_type_name(right);

  if (left_value_type && right_value_type) {
    return left_value_type === right_value_type;
  }

  return false;
}
