import { Ic } from "../ic.ts";
import { specialize_prim_for_operands, type ValType } from "../op.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import type { AnnotationHooks } from "./annotation_types.ts";
import { numeric_expr_type, prim_result_type } from "./numeric.ts";
import { resolve_extended_type_value } from "./type_patterns.ts";
import { front_type_name } from "./types.ts";

export function resolve_annotation_type(
  annotation: string,
  env: Env,
  hooks: AnnotationHooks,
): FrontType | undefined {
  if (
    annotation === "Int" || annotation === "I32" || annotation === "U32" ||
    annotation === "Resume"
  ) {
    return { tag: "int", type: "i32" };
  }

  if (annotation === "I64") {
    return { tag: "int", type: "i64" };
  }

  if (annotation === "Text") {
    return { tag: "text" };
  }

  if (annotation === "Type") {
    return { tag: "type" };
  }

  const value = resolve_annotation_type_value(annotation, env, hooks);

  if (!value) {
    return undefined;
  }

  if (value.tag === "struct_type") {
    return {
      tag: "struct",
      fields: value.fields.map((field) => field.name),
      field_types: value.fields,
    };
  }

  if (value.tag === "union_type") {
    return { tag: "union_value", cases: value.cases };
  }

  return undefined;
}

export function resolve_numeric_expr_type(
  expr: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): ValType | undefined {
  if (hooks.visible_text_value(expr, env, new Set())) {
    return undefined;
  }

  if (expr.tag === "prim") {
    const left_type = resolve_numeric_expr_type(expr.left, env, hooks);
    const right_type = resolve_numeric_expr_type(expr.right, env, hooks);
    const prim = specialize_prim_for_operands(
      expr.prim,
      left_type,
      right_type,
    );
    return prim_result_type(prim);
  }

  const direct = numeric_expr_type(expr);

  if (direct) {
    return direct;
  }

  const inferred = hooks.infer_expr(expr, env);

  if (inferred.tag === "int" && inferred.type) {
    return inferred.type;
  }

  const lowered = hooks.lower_static_expr(expr, env, new Set());

  if (!lowered) {
    return undefined;
  }

  const reduced = Ic.reduce(lowered);

  if (reduced.tag !== "num") {
    return undefined;
  }

  return reduced.type;
}

export function resolve_annotation_type_value(
  annotation: string,
  env: Env,
  hooks: AnnotationHooks,
): Extract<FrontExpr, { tag: "struct_type" | "union_type" }> | undefined {
  if (!is_simple_annotation_name(annotation)) {
    return undefined;
  }

  const value = hooks.resolve_const_expr({ tag: "var", name: annotation }, env);

  if (!value) {
    return undefined;
  }

  const type_value = resolve_extended_type_value(
    value,
    env,
    { resolve_const_expr: hooks.resolve_const_expr },
  );

  if (type_value.tag === "struct_type") {
    return type_value;
  }

  if (type_value.tag === "union_type") {
    return type_value;
  }

  return undefined;
}

export function binding_value_type_name(
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): string {
  const numeric_type = resolve_numeric_expr_type(value, env, hooks);

  if (numeric_type === "i32") {
    return "I32";
  }

  if (numeric_type === "i64") {
    return "I64";
  }

  return front_type_name(hooks.infer_expr(value, env));
}

function is_simple_annotation_name(annotation: string): boolean {
  for (let index = 0; index < annotation.length; index += 1) {
    const char = annotation[index];

    if (!char) {
      throw new Error("Missing annotation character");
    }

    if (
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      (char >= "0" && char <= "9") ||
      char === "_"
    ) {
      continue;
    }

    return false;
  }

  return annotation.length > 0;
}
