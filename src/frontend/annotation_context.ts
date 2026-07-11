import type { Env, FrontExpr } from "./ast.ts";
import type { AnnotationHooks } from "./annotation_types.ts";
import { is_object_type_expr, lookup_type_field } from "./fields.ts";
import { resolve_annotation_type_value } from "./annotation_resolve.ts";
import { matching_type_set_case } from "./type_set_member.ts";
import { sem_type_from_expr } from "./semantic_type.ts";
import { front_type_value_for_semantic_type } from "./type_declaration.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

export function apply_annotation_context(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): FrontExpr {
  let type_value = resolve_annotation_type_value(annotation, env, hooks);
  let type_ref: FrontExpr = { tag: "var", name: annotation };

  if (!type_value) {
    const type_expr = parse_type_expr(tokenize(annotation));
    const inline = front_type_value_for_semantic_type(
      "<inline annotation>",
      type_expr,
      sem_type_from_expr(type_expr),
    );

    if (inline.tag !== "union_type") {
      return value;
    }

    type_value = inline;
    type_ref = inline;
  }

  if (type_value.tag === "struct_type") {
    const struct = hooks.resolve_struct_value(value, env);

    if (!struct || !is_object_type_expr(struct.expr.type_expr)) {
      return value;
    }

    hooks.check_struct_fields(type_value, struct.expr.fields, struct.env);

    return {
      tag: "struct_value",
      type_expr: { tag: "var", name: annotation },
      fields: struct.expr.fields.map((field) => ({
        name: field.name,
        value: hooks.capture_expr(field.value, struct.env),
      })),
      bracketed: struct.expr.bracketed,
    };
  }

  return apply_union_annotation_context(
    annotation,
    type_value,
    type_ref,
    value,
    env,
    hooks,
  );
}

function apply_union_annotation_context(
  annotation: string,
  type_value: Extract<FrontExpr, { tag: "union_type" }>,
  type_ref: FrontExpr,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): FrontExpr {
  if (value.tag === "captured") {
    return {
      tag: "captured",
      expr: apply_union_annotation_context(
        annotation,
        type_value,
        type_ref,
        value.expr,
        value.env,
        hooks,
      ),
      env: value.env,
    };
  }

  if (value.tag === "if") {
    return {
      tag: "if",
      cond: value.cond,
      then_branch: apply_union_annotation_context(
        annotation,
        type_value,
        type_ref,
        value.then_branch,
        env,
        hooks,
      ),
      else_branch: apply_union_annotation_context(
        annotation,
        type_value,
        type_ref,
        value.else_branch,
        env,
        hooks,
      ),
      implicit_else: value.implicit_else,
    };
  }

  const set_case = matching_type_set_case(
    type_value.cases,
    value,
    env,
    hooks.infer_expr,
  );

  if (set_case) {
    return {
      tag: "union_case",
      name: set_case.name,
      value: hooks.capture_expr(value, env),
      type_expr: type_ref,
    };
  }

  const union_value = hooks.resolve_union_value(value, env);

  if (!union_value) {
    return value;
  }

  let payload: FrontExpr | undefined;

  if (union_value.expr.value) {
    const declared = lookup_type_field(type_value.cases, union_value.expr.name);
    const payload_value = apply_union_payload_context(
      declared,
      union_value.expr.value,
      union_value.env,
      hooks,
    );
    payload = hooks.capture_expr(payload_value, union_value.env);
  }

  return {
    tag: "union_case",
    name: union_value.expr.name,
    value: payload,
    type_expr: type_ref,
  };
}

function apply_union_payload_context(
  declared: { name: string; type_name: string } | undefined,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): FrontExpr {
  if (!declared || declared.type_name === "Unit") {
    return value;
  }

  const type_value = resolve_annotation_type_value(
    declared.type_name,
    env,
    hooks,
  );

  if (!type_value) {
    return value;
  }

  return apply_annotation_context(declared.type_name, value, env, hooks);
}
