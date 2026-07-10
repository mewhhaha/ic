import type { Env, FrontExpr, ResolvedFrontExpr } from "./ast.ts";
import {
  binding_value_type_name,
  resolve_annotation_type_value,
  resolve_numeric_expr_type,
} from "./annotation_resolve.ts";
import type { AnnotationHooks } from "./annotation_types.ts";
import { lookup_type_field } from "./fields.ts";
import { is_builtin_type_name } from "./types.ts";

export function check_binding_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): void {
  if (is_builtin_type_name(annotation)) {
    check_builtin_binding_annotation(annotation, value, env, hooks);
    return;
  }

  if (check_direct_type_annotation(annotation, value, env, hooks)) {
    return;
  }

  const deferred = hooks.resolve_deferred_frontend_value(value, env);

  if (deferred) {
    check_runtime_deferred_annotation(annotation, deferred, env, hooks);
    return;
  }

  hooks.check_const_annotation(
    annotation,
    hooks.capture_const_ref(value, env),
    env,
  );
}

function check_runtime_deferred_annotation(
  annotation: string,
  value: ResolvedFrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): void {
  if (value.expr.tag === "struct_value") {
    hooks.check_const_annotation(
      annotation,
      hooks.capture_expr(value.expr.type_expr, value.env),
      env,
    );
    return;
  }

  if (value.expr.tag === "union_case") {
    if (!value.expr.type_expr) {
      throw new Error(
        "Runtime annotation requires typed union constructor: " + annotation,
      );
    }

    hooks.check_const_annotation(
      annotation,
      hooks.capture_expr(value.expr.type_expr, value.env),
      env,
    );
    return;
  }

  throw new Error(
    "Cannot check runtime annotation for deferred value: " + annotation,
  );
}

function check_direct_type_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): boolean {
  const type_value = resolve_annotation_type_value(annotation, env, hooks);

  if (!type_value) {
    return false;
  }

  if (type_value.tag === "struct_type") {
    const struct = hooks.resolve_struct_value(value, env);

    if (!struct) {
      const actual = hooks.infer_expr(value, env);

      if (actual.tag === "struct") {
        return true;
      }

      throw new Error(
        "Binding annotation expects " + annotation + ", got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    hooks.check_struct_fields(type_value, struct.expr.fields, struct.env);
    return true;
  }

  if (type_value.tag === "union_type") {
    const union_value = hooks.resolve_union_value(value, env);

    if (!union_value) {
      const actual = hooks.infer_expr(value, env);

      if (actual.tag === "union_value") {
        if (union_cases_match_annotation(actual.cases, type_value.cases)) {
          return true;
        }
      }

      throw new Error(
        "Binding annotation expects " + annotation + ", got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    hooks.check_union_case_value(type_value, union_value.expr, union_value.env);
    return true;
  }

  return false;
}

function union_cases_match_annotation(
  actual: Array<{ name: string; type_name: string }>,
  expected: Array<{ name: string; type_name: string }>,
): boolean {
  for (const actual_case of actual) {
    const expected_case = lookup_type_field(expected, actual_case.name);

    if (!expected_case) {
      return false;
    }

    if (actual_case.type_name === "unknown") {
      continue;
    }

    if (expected_case.type_name === "unknown") {
      continue;
    }

    if (actual_case.type_name !== expected_case.type_name) {
      return false;
    }
  }

  return true;
}

function check_builtin_binding_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): void {
  if (annotation === "Resume") {
    const actual = hooks.infer_expr(value, env);

    if (
      actual.tag !== "fn" &&
      (actual.tag !== "int" || actual.type !== "i32")
    ) {
      throw new Error(
        "Binding annotation expects Resume, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "Int" || annotation === "I32" || annotation === "U32") {
    const numeric_type = resolve_numeric_expr_type(value, env, hooks);

    if (numeric_type !== "i32") {
      throw new Error(
        "Binding annotation expects " + annotation + ", got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "I64") {
    const numeric_type = resolve_numeric_expr_type(value, env, hooks);

    if (numeric_type !== "i64") {
      throw new Error(
        "Binding annotation expects I64, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "Text") {
    const actual = hooks.infer_expr(value, env);

    if (actual.tag !== "text") {
      throw new Error(
        "Binding annotation expects Text, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "Type") {
    const actual = hooks.infer_expr(value, env);

    if (actual.tag !== "type") {
      throw new Error(
        "Binding annotation expects Type, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  throw new Error("Cannot check binding annotation: " + annotation);
}
