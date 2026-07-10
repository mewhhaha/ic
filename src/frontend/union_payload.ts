import { expect } from "../expect.ts";
import type { Env, FrontExpr, TypeField } from "./ast.ts";
import { is_object_type_expr, lookup_type_field } from "./fields.ts";
import { front_type_name, type_name_from_front_type } from "./types.ts";
import type { UnionValueHooks } from "./union_value_types.ts";

export function infer_untyped_union_case(
  expr: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  hooks: UnionValueHooks,
): TypeField {
  if (!expr.value) {
    return { name: expr.name, type_name: "Unit" };
  }

  const explicit_type_name = explicit_payload_type_name(expr.value);

  if (explicit_type_name) {
    return { name: expr.name, type_name: explicit_type_name };
  }

  const type_name = type_name_from_front_type(
    hooks.infer_expr(expr.value, env),
  );

  if (!type_name) {
    return { name: expr.name, type_name: "unknown" };
  }

  return { name: expr.name, type_name };
}

function explicit_payload_type_name(expr: FrontExpr): string | undefined {
  if (expr.tag === "captured") {
    return explicit_payload_type_name(expr.expr);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing union payload block statement");

    if (stmt.tag === "expr") {
      return explicit_payload_type_name(stmt.expr);
    }

    if (stmt.tag === "return") {
      return explicit_payload_type_name(stmt.value);
    }
  }

  if (expr.tag === "struct_value") {
    if (is_object_type_expr(expr.type_expr)) {
      return undefined;
    }

    if (expr.type_expr.tag === "var") {
      return expr.type_expr.name;
    }
  }

  if (expr.tag === "union_case") {
    if (expr.type_expr && expr.type_expr.tag === "var") {
      return expr.type_expr.name;
    }
  }

  return undefined;
}

export function validate_union_payload_type(
  name: string,
  expected: string,
  value: FrontExpr,
  env: Env,
  hooks: UnionValueHooks,
): void {
  const actual = hooks.infer_expr(value, env);

  if (actual.tag === "unknown") {
    return;
  }

  if (expected === "Resume") {
    if (
      actual.tag !== "fn" &&
      (actual.tag !== "int" || actual.type !== "i32")
    ) {
      throw new Error(
        "Union case " + name + " expects Resume, got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "Int" || expected === "I32" || expected === "U32") {
    if (actual.tag !== "int" || actual.type === "i64") {
      throw new Error(
        "Union case " + name + " expects " + expected + ", got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "I64") {
    if (actual.tag !== "int" || actual.type !== "i64") {
      throw new Error(
        "Union case " + name + " expects I64, got " + front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "Text") {
    if (actual.tag !== "text") {
      throw new Error(
        "Union case " + name + " expects Text, got " + front_type_name(actual),
      );
    }
  }
}

export function check_union_case_value(
  union_type: Extract<FrontExpr, { tag: "union_type" }>,
  value: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  hooks: UnionValueHooks,
): void {
  const declared = lookup_type_field(union_type.cases, value.name);

  if (!declared) {
    throw new Error("Missing union case: " + value.name);
  }

  if (declared.type_name === "Unit") {
    if (value.value) {
      throw new Error("Union case " + value.name + " expects no payload");
    }

    return;
  }

  const payload = value.value;

  if (!payload) {
    throw new Error("Union case " + value.name + " expects 1 payload");
  }

  validate_union_payload_type(
    value.name,
    declared.type_name,
    payload,
    env,
    hooks,
  );
}
