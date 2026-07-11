import { expect } from "../../expect.ts";
import type { Env, Field, FrontExpr } from "../ast.ts";
import { lookup_field } from "../fields.ts";
import {
  maybe_struct_type_value,
  validate_struct_value,
} from "../struct_value_type.ts";
import type { StructValueHooks, StructValueTarget } from "./types.ts";

export type StructValueResolver = (
  expr: FrontExpr,
  env: Env,
  hooks: StructValueHooks,
) => StructValueTarget | undefined;

export function apply_struct_update_with_resolver(
  expr: Extract<FrontExpr, { tag: "struct_update" }>,
  env: Env,
  hooks: StructValueHooks,
  resolve_struct_value: StructValueResolver,
): FrontExpr {
  const struct_type = maybe_struct_type_value(expr.base, env, hooks);

  if (struct_type) {
    const value: FrontExpr = {
      tag: "struct_value",
      type_expr: expr.base,
      fields: expr.fields,
    };
    expect(value.tag === "struct_value", "Expected struct update value");
    validate_struct_value(value, env, hooks);
    return value;
  }

  const target = resolve_struct_value(expr.base, env, hooks);

  if (!target) {
    throw new Error("Cannot update non-struct value");
  }

  const fields: Field[] = [];

  for (const field of target.expr.fields) {
    fields.push({
      name: field.name,
      value: hooks.capture_expr(field.value, target.env),
    });
  }

  for (const update of expr.fields) {
    const existing = lookup_field(fields, update.name);

    if (!existing) {
      throw new Error("Missing struct field: " + update.name);
    }

    existing.value = update.value;
  }

  return {
    tag: "struct_value",
    type_expr: target.expr.type_expr,
    fields,
    bracketed: target.expr.bracketed,
  };
}
