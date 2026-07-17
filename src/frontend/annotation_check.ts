import type { Env, FrontExpr, ResolvedFrontExpr } from "./ast.ts";
import {
  binding_value_type_name,
  resolve_annotation_set_type_value,
  resolve_annotation_type_value,
  resolve_numeric_expr_type,
} from "./annotation_resolve.ts";
import type { AnnotationHooks } from "./annotation_types.ts";
import { lookup_type_field } from "./fields.ts";
import { matching_type_set_case } from "./type_set_member.ts";
import { is_builtin_type_name } from "./types.ts";
import {
  sem_type_from_expr,
  sem_type_from_front_type,
  sem_type_subtype,
} from "./semantic_type.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import { contextual_struct_fields } from "./struct_value_type.ts";
import {
  integer_literal_fits,
  integer_type_from_name,
  integer_type_name,
} from "../integer.ts";

export function check_binding_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): void {
  if (check_semantic_annotation(annotation, value, env, hooks)) {
    return;
  }

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

function check_semantic_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): boolean {
  let type_expr = parse_type_expr(tokenize(annotation));
  let semantic_surface = type_expr.tag !== "name" &&
    type_expr.tag !== "apply" && type_expr.tag !== "tuple" &&
    type_expr.tag !== "arrow";

  if (!semantic_surface) {
    const set_value = resolve_annotation_set_type_value(annotation, env, hooks);

    if (!set_value) {
      return false;
    }

    type_expr = set_value.type_expr;
    semantic_surface = true;
  }

  if (!semantic_surface) {
    return false;
  }

  if (type_expr.tag === "top") {
    return true;
  }

  if (type_expr.tag === "never") {
    throw new Error("Binding annotation Never has no values");
  }

  let checked_value = value;

  if (type_expr.tag === "frozen") {
    if (value.tag === "freeze") {
      checked_value = value.value;
    } else if (value.tag !== "text") {
      throw new Error(
        "Binding annotation expects frozen " + annotation,
      );
    }

    type_expr = type_expr.value;
  } else if (type_expr.tag === "borrow") {
    if (value.tag !== "borrow") {
      throw new Error(
        "Binding annotation expects borrowed " + annotation,
      );
    }

    checked_value = value.value;
    type_expr = type_expr.value;
  }

  const actual = sem_type_from_front_type(hooks.infer_expr(checked_value, env));
  const expected = sem_type_from_expr(type_expr);

  if (sem_type_subtype(actual, expected)) {
    return true;
  }

  throw new Error(
    "Binding annotation expects " + annotation + ", got " +
      binding_value_type_name(value, env, hooks),
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

    hooks.check_struct_fields(
      type_value,
      contextual_struct_fields(type_value, struct.expr),
      struct.env,
    );
    return true;
  }

  if (type_value.tag === "union_type") {
    const set_case = matching_type_set_case(
      type_value.cases,
      value,
      env,
      hooks.infer_expr,
    );

    if (set_case) {
      return true;
    }

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
  const expected_integer = integer_type_from_name(annotation);

  if (
    expected_integer && annotation !== "I32" && annotation !== "U32" &&
    annotation !== "I64"
  ) {
    const actual = hooks.infer_expr(value, env);

    if (actual.tag === "int" && actual.integer) {
      if (integer_type_name(actual.integer) === annotation) {
        return;
      }
    } else if (actual.tag === "wide_int") {
      if (integer_type_name(actual.integer) === annotation) {
        return;
      }
    } else if (value.tag === "num") {
      let literal: bigint;

      if (typeof value.value === "bigint") {
        literal = value.value;
      } else {
        literal = BigInt(value.value);
      }

      if (integer_literal_fits(expected_integer, literal)) {
        return;
      }
    }

    throw new Error(
      "Binding annotation expects " + annotation + ", got " +
        binding_value_type_name(value, env, hooks),
    );
  }

  if (annotation === "Bool") {
    const actual = hooks.infer_expr(value, env);

    if (actual.tag !== "bool") {
      throw new Error(
        "Binding annotation expects Bool, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

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

  if (annotation === "F32") {
    const numeric_type = resolve_numeric_expr_type(value, env, hooks);

    if (numeric_type !== "f32") {
      throw new Error(
        "Binding annotation expects F32, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "F64") {
    const numeric_type = resolve_numeric_expr_type(value, env, hooks);

    if (numeric_type !== "f64") {
      throw new Error(
        "Binding annotation expects F64, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "F32x4") {
    const actual = hooks.infer_expr(value, env);

    if (actual.tag !== "f32x4") {
      throw new Error(
        "Binding annotation expects F32x4, got " +
          binding_value_type_name(value, env, hooks),
      );
    }

    return;
  }

  if (annotation === "Text" || annotation === "Bytes") {
    const actual = hooks.infer_expr(value, env);
    const expects_bytes = annotation === "Bytes";

    if (
      actual.tag !== "text" ||
      (actual.encoding === "bytes") !== expects_bytes
    ) {
      throw new Error(
        "Binding annotation expects " + annotation + ", got " +
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
