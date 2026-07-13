import { Ic } from "../ic.ts";
import { specialize_prim_for_operands, type ValType } from "../op.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import type { AnnotationHooks } from "./annotation_types.ts";
import { numeric_expr_type, prim_result_type } from "./numeric.ts";
import { resolve_extended_type_value } from "./type_patterns.ts";
import { front_type_from_type_name, front_type_name } from "./types.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import { sem_type_from_expr } from "./semantic_type.ts";
import { front_type_value_for_semantic_type } from "./type_declaration.ts";

export function resolve_annotation_type(
  annotation: string,
  env: Env,
  hooks: AnnotationHooks,
): FrontType | undefined {
  const parsed = parse_type_expr(tokenize(annotation));
  const inline_set = front_type_value_for_semantic_type(
    "<inline annotation>",
    parsed,
    sem_type_from_expr(parsed),
  );

  if (inline_set.tag === "union_type") {
    return { tag: "union_value", cases: inline_set.cases };
  }

  const direct = direct_annotation_front_type(parsed);

  if (direct) {
    return direct;
  }

  if (
    annotation === "Int" || annotation === "I32" || annotation === "U32" ||
    annotation === "Resume"
  ) {
    return { tag: "int", type: "i32" };
  }

  if (annotation === "Bool") {
    return { tag: "bool" };
  }

  if (annotation === "I64") {
    return { tag: "int", type: "i64" };
  }

  if (annotation === "Text") {
    return { tag: "text" };
  }

  if (annotation === "Bytes") {
    return { tag: "text", encoding: "bytes" };
  }

  if (annotation === "Type") {
    return { tag: "type" };
  }

  const set_value = resolve_annotation_set_type_value(annotation, env, hooks);

  if (set_value) {
    return { tag: "set", type_expr: set_value.type_expr };
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

function direct_annotation_front_type(
  type: import("./ast.ts").TypeExpr,
): FrontType | undefined {
  switch (type.tag) {
    case "atom":
      return { tag: "atom", name: type.name };

    case "top":
      return { tag: "unknown" };

    case "never":
      return { tag: "never" };

    case "frozen":
    case "borrow":
      return direct_annotation_front_type(type.value);

    case "union":
    case "intersection":
    case "difference":
      return { tag: "set", type_expr: type };

    case "name":
      if (
        type.name === "Bool" || type.name === "Unit" ||
        type.name === "Int" || type.name === "I32" ||
        type.name === "U32" || type.name === "I64" ||
        type.name === "Text" || type.name === "Bytes" ||
        type.name === "Resume"
      ) {
        return front_type_from_type_name(type.name);
      }

      return undefined;

    case "apply":
    case "tuple":
    case "arrow":
      return undefined;
  }
}

export function resolve_numeric_expr_type(
  expr: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): ValType | undefined {
  if (hooks.visible_text_value(expr, env, new Set())) {
    return undefined;
  }

  const inferred = hooks.infer_expr(expr, env);

  if (inferred.tag === "bool") {
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

export function resolve_annotation_set_type_value(
  annotation: string,
  env: Env,
  hooks: AnnotationHooks,
): Extract<FrontExpr, { tag: "set_type" }> | undefined {
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

  if (type_value.tag === "set_type") {
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
