import { expect } from "../../expect.ts";
import type { TypePattern } from "../../type_syntax.ts";
import type { CoreExpr, CoreTypeField } from "../ast.ts";
import { resolve_core_type_name } from "../type_static.ts";
import { find_core_type_field } from "../union_static.ts";
import type { CoreTypeCheckCtx, CoreTypeCheckHooks } from "./types.ts";

export function check_core_type_pattern<ctx extends CoreTypeCheckCtx>(
  pattern: TypePattern,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): void {
  const type_value = hooks.static_type_value(target, ctx);
  expect(type_value, "Core type pattern requires compile-time value");
  let fields: CoreTypeField[];
  let label: string;

  if (pattern.kind === "struct") {
    if (type_value.tag !== "struct_type") {
      throw new Error("Expected struct type value");
    }

    fields = type_value.fields;
    label = "Struct field";
  } else {
    if (type_value.tag !== "union_type") {
      throw new Error("Expected union type value");
    }

    fields = type_value.cases;
    label = "Union case";
  }

  for (const expected of pattern.fields) {
    const actual = find_core_type_field(fields, expected.name);

    if (!actual) {
      if (pattern.kind === "struct") {
        throw new Error("Missing struct field: " + expected.name);
      }

      throw new Error("Missing union case: " + expected.name);
    }

    const actual_type_name = resolve_core_type_name(actual.type_name, ctx);
    const expected_type_name = resolve_core_type_name(expected.type_name, ctx);

    if (actual_type_name !== expected_type_name) {
      throw new Error(
        label + " " + expected.name + " expects " + expected_type_name +
          ", got " + actual_type_name,
      );
    }
  }

  if (!pattern.open && fields.length !== pattern.fields.length) {
    if (pattern.kind === "struct") {
      throw new Error("Struct pattern does not allow extra fields");
    }

    throw new Error("Union pattern does not allow extra cases");
  }
}
