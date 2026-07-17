import type { TypeExpr } from "../../type_syntax.ts";
import {
  fixed_array_length,
  format_type_expr,
  front_type_value_for_semantic_type,
  parse_type_expr,
  sem_type_from_expr,
  tokenize,
} from "../from_source/type_contract.ts";
import { expect } from "../../expect.ts";
import { integer_type_from_name, integer_val_type } from "../../integer.ts";
import type { CoreExpr, CoreParam, CoreStmt, CoreTypeField } from "../ast.ts";
import { record_core_expr_provenance } from "../subject_provenance.ts";
import { is_type_level_expr, static_block_result } from "../type_static.ts";
import { find_core_type_field } from "../union_static.ts";
import {
  core_binding_value_type_name,
  core_direct_annotation_actual_name,
  ordinary_static_call_probe_error,
  resolved_type_name,
  static_annotation_type_value,
} from "./name.ts";
import type {
  CoreTypeCheckCtx,
  CoreTypeCheckHooks,
  CoreTypeValue,
} from "./types.ts";
import {
  check_core_struct_fields,
  check_core_union_case_value,
  core_union_type_values_match,
} from "./value.ts";

export function core_binding_value<ctx extends CoreTypeCheckCtx>(
  stmt: Extract<CoreStmt, { tag: "bind" }>,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  if (!stmt.annotation) {
    return stmt.value;
  }

  return apply_core_binding_annotation(
    stmt.annotation,
    stmt.value,
    ctx,
    hooks,
  );
}

export function core_assignment_value<ctx extends CoreTypeCheckCtx>(
  stmt: Extract<CoreStmt, { tag: "assign" }>,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  if (stmt.mode !== "same") {
    return stmt.value;
  }

  const expected_type_expr = ctx.union_locals.get(stmt.name);
  if (!expected_type_expr) {
    return stmt.value;
  }

  const expected_type = hooks.static_type_value(expected_type_expr, ctx);
  if (!expected_type || expected_type.tag !== "union_type") {
    throw new Error(
      "Core union assignment requires a declared union type: " + stmt.name,
    );
  }

  let expected_name = "union";
  if (expected_type_expr.tag === "var") {
    expected_name = expected_type_expr.name;
  }

  return apply_core_direct_type_annotation(
    expected_name,
    expected_type,
    stmt.value,
    ctx,
    hooks,
    expected_type_expr,
  );
}

export function core_type_const_value<ctx extends CoreTypeCheckCtx>(
  stmt: Extract<CoreStmt, { tag: "bind" }>,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr | undefined {
  if (stmt.kind !== "const") {
    return undefined;
  }

  if (is_type_level_expr(value)) {
    return value;
  }

  try {
    const type_name = hooks.static_type_name(value, ctx);

    if (type_name) {
      return type_name;
    }

    return hooks.static_type_value(value, ctx);
  } catch (error) {
    if (!ordinary_static_call_probe_error(error)) {
      throw error;
    }
  }

  return undefined;
}

export function apply_core_binding_annotation<
  ctx extends CoreTypeCheckCtx,
>(
  annotation: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  return apply_core_value_annotation(
    "binding",
    annotation,
    value,
    ctx,
    hooks,
  );
}

export function apply_core_parameter_annotation<
  ctx extends CoreTypeCheckCtx,
>(
  param: CoreParam,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  const annotation = param.annotation;

  if (!annotation) {
    return value;
  }

  return apply_core_value_annotation(
    "parameter",
    annotation,
    value,
    ctx,
    hooks,
  );
}

export function apply_core_direct_type_annotation<
  ctx extends CoreTypeCheckCtx,
>(
  annotation: string,
  type_value: CoreTypeValue,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
  explicit_type_expr?: CoreExpr,
): CoreExpr {
  let annotation_type_expr: CoreExpr = { tag: "var", name: annotation };

  if (explicit_type_expr) {
    annotation_type_expr = explicit_type_expr;
  }

  if (type_value.tag === "struct_type") {
    const scratch_result = core_scratch_annotation_result(value);

    if (scratch_result) {
      const scratch_struct_value = hooks.static_struct_value(
        scratch_result,
        ctx,
      );

      if (scratch_struct_value) {
        check_core_struct_fields(
          type_value,
          scratch_struct_value.fields,
          ctx,
          hooks,
        );
        return value;
      }
    }

    let frozen_struct_value:
      | Extract<CoreExpr, { tag: "struct_value" }>
      | undefined;

    if (value.tag === "freeze") {
      frozen_struct_value = hooks.static_struct_value(value.value, ctx);
    }

    const struct_value = hooks.static_struct_value(value, ctx);

    if (!struct_value) {
      const actual_struct_type = hooks.runtime_aggregate_type_expr(value, ctx);
      const expected_struct_type = annotation_type_expr;

      if (
        actual_struct_type &&
        hooks.same_runtime_aggregate_type_expr(
          expected_struct_type,
          actual_struct_type,
          ctx,
        )
      ) {
        return value;
      }

      throw new Error(
        "Core binding annotation expects " + annotation + ", got " +
          core_direct_annotation_actual_name(value, ctx, hooks),
      );
    }

    check_core_struct_fields(type_value, struct_value.fields, ctx, hooks);
    const annotated_struct: CoreExpr = record_core_expr_provenance({
      tag: "struct_value",
      type_expr: annotation_type_expr,
      fields: struct_value.fields,
    }, value);

    if (frozen_struct_value) {
      return record_core_expr_provenance({
        tag: "freeze",
        value: annotated_struct,
      }, value);
    }

    return annotated_struct;
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    return apply_core_union_case_annotation(
      type_value,
      union_case,
      annotation_type_expr,
      ctx,
      hooks,
    );
  }

  const union_if = hooks.dynamic_union_if(value, ctx);

  if (union_if) {
    const then_branch = apply_core_union_case_annotation(
      type_value,
      union_if.then_case,
      annotation_type_expr,
      ctx,
      hooks,
    );
    const else_branch = apply_core_union_case_annotation(
      type_value,
      union_if.else_case,
      annotation_type_expr,
      ctx,
      hooks,
    );
    return record_core_expr_provenance({
      tag: "if",
      cond: union_if.cond,
      then_branch,
      else_branch,
    }, value);
  }

  const runtime_union_type = hooks.runtime_union_type_expr(value, ctx);

  if (runtime_union_type) {
    const runtime_type_value = hooks.static_type_value(runtime_union_type, ctx);

    if (
      runtime_type_value && runtime_type_value.tag === "union_type" &&
      core_union_type_values_match(type_value, runtime_type_value, ctx)
    ) {
      return value;
    }
  }

  const set_case = matching_core_type_set_case(
    type_value.cases,
    value,
    ctx,
    hooks,
  );

  if (set_case) {
    return record_core_expr_provenance({
      tag: "union_case",
      name: set_case.name,
      value,
      type_expr: annotation_type_expr,
    }, value);
  }

  throw new Error(
    "Core binding annotation expects " + annotation + ", got " +
      core_direct_annotation_actual_name(value, ctx, hooks),
  );
}

function apply_core_union_case_annotation<ctx extends CoreTypeCheckCtx>(
  type_value: Extract<CoreTypeValue, { tag: "union_type" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  annotation_type_expr: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> {
  check_core_union_case_value(type_value, union_case, ctx, hooks);
  const declared = find_core_type_field(type_value.cases, union_case.name);
  expect(declared, "Missing union case: " + union_case.name);

  let value = union_case.value;
  if (value) {
    value = apply_core_value_annotation(
      "binding",
      declared.type_name,
      value,
      ctx,
      hooks,
    );
  }

  return record_core_expr_provenance({
    ...union_case,
    value,
    type_expr: annotation_type_expr,
  }, union_case);
}

function core_scratch_annotation_result(
  value: CoreExpr,
): CoreExpr | undefined {
  if (value.tag !== "scratch") {
    return undefined;
  }

  return static_block_result(value.body);
}

function apply_core_value_annotation<ctx extends CoreTypeCheckCtx>(
  label: "binding" | "parameter",
  annotation: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  const resolved_annotation = resolved_type_name(annotation, ctx);

  if (resolved_annotation !== annotation) {
    return apply_core_value_annotation(
      label,
      resolved_annotation,
      value,
      ctx,
      hooks,
    );
  }

  const parsed = parse_type_expr(tokenize(annotation));
  const semantic = apply_core_semantic_annotation(
    label,
    parsed,
    value,
    ctx,
    hooks,
  );

  if (semantic) {
    return semantic;
  }

  const integer = integer_type_from_name(annotation);

  if (integer) {
    const expected = integer_val_type(integer);

    if (!expected) {
      const type_value = static_annotation_type_value(annotation, ctx, hooks);
      expect(
        type_value,
        "Missing Core wide-integer representation for " + annotation,
      );
      return apply_core_direct_type_annotation(
        annotation,
        type_value,
        value,
        ctx,
        hooks,
      );
    }

    const actual = hooks.expr_type(value, ctx);

    if (actual !== expected) {
      throw new Error(
        "Core " + label + " annotation expects " + annotation + ", got " +
          actual,
      );
    }

    return value;
  }

  if (annotation === "Resume") {
    const actual = hooks.expr_type(value, ctx);

    if (actual !== "i32") {
      throw new Error(
        "Core " + label + " annotation expects Resume, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "Bool") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "I32") {
      throw new Error(
        "Core " + label + " annotation expects Bool, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "Int" || annotation === "I32" || annotation === "U32") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "I32") {
      throw new Error(
        "Core " + label + " annotation expects " + annotation + ", got " +
          actual,
      );
    }

    return value;
  }

  if (annotation === "I64") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "I64") {
      throw new Error(
        "Core " + label + " annotation expects I64, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "F32") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "F32") {
      throw new Error(
        "Core " + label + " annotation expects F32, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "F64") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "F64") {
      throw new Error(
        "Core " + label + " annotation expects F64, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "F32x4") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "F32x4") {
      throw new Error(
        "Core " + label + " annotation expects F32x4, got " + actual,
      );
    }

    return value;
  }

  if (annotation === "Text" || annotation === "Bytes") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "Text") {
      throw new Error(
        "Core " + label + " annotation expects " + annotation + ", got " +
          actual,
      );
    }

    return value;
  }

  if (annotation === "Type") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "Type") {
      throw new Error(
        "Core " + label + " annotation expects Type, got " + actual,
      );
    }

    return value;
  }

  const type_value = static_annotation_type_value(annotation, ctx, hooks);

  if (type_value) {
    return apply_core_direct_type_annotation(
      annotation,
      type_value,
      value,
      ctx,
      hooks,
    );
  }

  throw new Error("Cannot check core " + label + " annotation: " + annotation);
}

function apply_core_semantic_annotation<ctx extends CoreTypeCheckCtx>(
  label: "binding" | "parameter",
  type: TypeExpr,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr | undefined {
  if (type.tag === "forall" || type.tag === "arrow") {
    return value;
  }

  if (type.tag === "top") {
    return value;
  }

  if (type.tag === "never") {
    throw new Error("Core " + label + " annotation Never has no values");
  }

  if (type.tag === "atom") {
    const atom = static_core_atom(value, ctx);

    if (atom === type.name) {
      return value;
    }

    throw new Error(
      "Core " + label + " annotation expects #" + type.name + ", got " +
        core_binding_value_type_name(value, ctx, hooks),
    );
  }

  if (type.tag === "frozen") {
    if (value.tag === "freeze") {
      const annotation = core_semantic_member_annotation(type.value);

      if (annotation) {
        apply_core_value_annotation(label, annotation, value.value, ctx, hooks);
      }

      return value;
    }

    if (type.value.tag === "name" && type.value.name === "Text") {
      if (hooks.static_text_value(value, ctx)) {
        return value;
      }
    }

    throw new Error("Core " + label + " annotation expects frozen value");
  }

  if (type.tag === "borrow") {
    if (value.tag !== "borrow") {
      throw new Error("Core " + label + " annotation expects borrowed value");
    }

    const annotation = core_semantic_member_annotation(type.value);

    if (annotation) {
      apply_core_value_annotation(label, annotation, value.value, ctx, hooks);
    }

    return value;
  }

  if (type.tag === "array") {
    return apply_core_fixed_array_annotation(label, type, value, ctx, hooks);
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    const semantic = sem_type_from_expr(type);

    if (semantic.tag === "top") {
      return value;
    }

    if (semantic.tag === "never") {
      throw new Error("Core " + label + " annotation has no values");
    }

    if (semantic.tag === "scalar") {
      return apply_core_value_annotation(
        label,
        semantic.name,
        value,
        ctx,
        hooks,
      );
    }

    if (semantic.tag === "atom") {
      return apply_core_value_annotation(
        label,
        "#" + semantic.name,
        value,
        ctx,
        hooks,
      );
    }

    const front_type = front_type_value_for_semantic_type(
      "<inline annotation>",
      type,
      semantic,
    );

    if (front_type.tag === "union_type") {
      const inline_type: Extract<CoreExpr, { tag: "union_type" }> = {
        tag: "union_type",
        cases: front_type.cases.map((union_case) => ({ ...union_case })),
      };
      return apply_core_direct_type_annotation(
        format_type_expr(type),
        inline_type,
        value,
        ctx,
        hooks,
        inline_type,
      );
    }

    throw new Error(
      "Core " + label + " annotation has no runtime representation: " +
        format_type_expr(type),
    );
  }

  return undefined;
}

function apply_core_fixed_array_annotation<ctx extends CoreTypeCheckCtx>(
  label: "binding" | "parameter",
  type: Extract<TypeExpr, { tag: "array" }>,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr {
  const annotation = format_type_expr(type);
  const length = fixed_array_length(type.length);
  let frozen = false;
  let annotated_value = value;

  if (value.tag === "freeze") {
    frozen = true;
    annotated_value = value.value;
  }

  const struct_value = hooks.static_struct_value(annotated_value, ctx);

  if (!struct_value) {
    throw new Error(
      "Core " + label + " annotation expects " + annotation + ", got " +
        core_direct_annotation_actual_name(value, ctx, hooks),
    );
  }

  if (struct_value.fields.length !== length) {
    throw new Error(
      "Core " + label + " annotation expects " + annotation + " with " +
        length.toString() + " items, got " +
        struct_value.fields.length.toString(),
    );
  }

  const fields: Extract<CoreExpr, { tag: "struct_value" }>["fields"] = [];

  for (let index = 0; index < length; index += 1) {
    const field = struct_value.fields[index];
    const expected_name = "item_" + index.toString();
    expect(field, "Missing fixed array field " + index.toString());

    if (field.name !== expected_name) {
      throw new Error(
        "Core " + label + " annotation expects " + annotation + " item " +
          index.toString() + ", got field " + field.name,
      );
    }

    let item: CoreExpr;

    try {
      item = apply_core_value_annotation(
        label,
        format_type_expr(type.element),
        field.value,
        ctx,
        hooks,
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          "Core " + label + " annotation " + annotation + " item " +
            index.toString() + ": " + error.message,
        );
      }

      throw error;
    }

    fields.push({ ...field, value: item });
  }

  const annotated: CoreExpr = record_core_expr_provenance({
    ...struct_value,
    fields,
  }, value);

  if (!frozen) {
    return annotated;
  }

  return record_core_expr_provenance(
    { tag: "freeze", value: annotated },
    value,
  );
}

function core_semantic_member_annotation(type: TypeExpr): string | undefined {
  if (type.tag === "name") {
    return type.name;
  }

  if (type.tag === "atom") {
    return "#" + type.name;
  }

  return undefined;
}

function matching_core_type_set_case<ctx extends CoreTypeCheckCtx>(
  cases: CoreTypeField[],
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreTypeField | undefined {
  for (const union_case of cases) {
    if (!union_case.set_member) {
      continue;
    }

    if (
      core_value_matches_set_member(value, union_case.set_member, ctx, hooks)
    ) {
      return union_case;
    }
  }

  return undefined;
}

function core_value_matches_set_member<ctx extends CoreTypeCheckCtx>(
  value: CoreExpr,
  type: TypeExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): boolean {
  if (type.tag === "atom") {
    return static_core_atom(value, ctx) === type.name;
  }

  if (type.tag === "frozen") {
    if (value.tag !== "freeze") {
      return false;
    }

    return core_value_matches_set_member(value.value, type.value, ctx, hooks);
  }

  if (type.tag === "borrow") {
    if (value.tag !== "borrow") {
      return false;
    }

    return core_value_matches_set_member(value.value, type.value, ctx, hooks);
  }

  if (type.tag !== "name") {
    return false;
  }

  const actual = core_binding_value_type_name(value, ctx, hooks);
  const integer = integer_type_from_name(type.name);

  if (integer) {
    const expected = integer_val_type(integer);

    if (!expected) {
      return false;
    }

    return hooks.expr_type(value, ctx) === expected;
  }

  if (
    type.name === "Bool" || type.name === "Int" || type.name === "I32" ||
    type.name === "U32"
  ) {
    return actual === "I32" && static_core_atom(value, ctx) === undefined;
  }

  if (type.name === "I64") {
    return actual === "I64";
  }

  if (type.name === "F32") {
    return actual === "F32";
  }

  if (type.name === "F64") {
    return actual === "F64";
  }

  if (type.name === "Text" || type.name === "Bytes") {
    return actual === "Text";
  }

  return false;
}

function static_core_atom<ctx extends CoreTypeCheckCtx>(
  value: CoreExpr,
  ctx: ctx,
): string | undefined {
  if (value.tag === "num" && value.atom_name) {
    return value.atom_name;
  }

  if (value.tag !== "var") {
    return undefined;
  }

  const static_value = ctx.statics.get(value.name);

  if (!static_value || static_value === value) {
    return undefined;
  }

  return static_core_atom(static_value, ctx);
}
