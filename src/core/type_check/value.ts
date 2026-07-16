import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField } from "../ast.ts";
import { find_core_field } from "../analysis/field.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
} from "../type_static.ts";
import { find_core_type_field } from "../union_static.ts";
import {
  core_binding_value_type_name,
  core_direct_annotation_actual_name,
} from "./name.ts";
import type {
  CoreTypeCheckCtx,
  CoreTypeCheckHooks,
  CoreTypeValue,
} from "./types.ts";

export function check_core_value_type_name<
  ctx extends CoreTypeCheckCtx,
>(
  label: string,
  expected_type_name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): void {
  const resolved_expected_type_name = resolve_core_type_name(
    expected_type_name,
    ctx,
  );

  if (resolved_expected_type_name === "Unit") {
    throw new Error(label + " cannot use Unit as a value payload");
  }

  const expected = core_val_type_from_type_name(resolved_expected_type_name);

  if (!expected) {
    const type_value = hooks.static_type_value(
      { tag: "var", name: resolved_expected_type_name },
      ctx,
    );

    if (!type_value) {
      throw new Error(
        "Cannot type " + label + ": " + resolved_expected_type_name,
      );
    }

    if (type_value.tag === "struct_type") {
      const struct_value = hooks.static_struct_value(value, ctx);

      if (!struct_value) {
        const expected_type_expr: CoreExpr = {
          tag: "var",
          name: resolved_expected_type_name,
        };
        const runtime_aggregate_type = hooks.runtime_aggregate_type_expr(
          value,
          ctx,
        );

        if (
          runtime_aggregate_type &&
          hooks.same_runtime_aggregate_type_expr(
            expected_type_expr,
            runtime_aggregate_type,
            ctx,
          )
        ) {
          return;
        }

        throw new Error(
          label + " expects " + resolved_expected_type_name + ", got " +
            core_direct_annotation_actual_name(value, ctx, hooks),
        );
      }

      check_core_struct_fields(type_value, struct_value.fields, ctx, hooks);
      return;
    }

    const union_case = hooks.static_union_case(value, ctx);

    if (!union_case) {
      const runtime_union_type = hooks.runtime_union_type_expr(value, ctx);

      if (runtime_union_type) {
        const runtime_type_value = hooks.static_type_value(
          runtime_union_type,
          ctx,
        );

        if (
          runtime_type_value && runtime_type_value.tag === "union_type" &&
          core_union_type_values_match(type_value, runtime_type_value, ctx)
        ) {
          return;
        }
      }

      throw new Error(
        label + " expects " + resolved_expected_type_name + ", got " +
          core_direct_annotation_actual_name(value, ctx, hooks),
      );
    }

    check_core_union_case_value(type_value, union_case, ctx, hooks);
    return;
  }

  const actual_name = core_binding_value_type_name(value, ctx, hooks);

  if (
    resolved_expected_type_name === "Text" ||
    resolved_expected_type_name === "Bytes"
  ) {
    if (actual_name !== "Text") {
      throw new Error(
        label + " expects " + resolved_expected_type_name + ", got " +
          actual_name,
      );
    }

    return;
  }

  if (actual_name === "Text") {
    throw new Error(
      label + " expects " + resolved_expected_type_name + ", got Text",
    );
  }

  const actual = hooks.expr_type(value, ctx);

  if (actual !== expected) {
    throw new Error(
      label + " expects " + resolved_expected_type_name + ", got " +
        actual_name,
    );
  }
}

export function core_union_type_values_match<ctx extends CoreTypeCheckCtx>(
  expected: Extract<CoreExpr, { tag: "union_type" }>,
  actual: Extract<CoreExpr, { tag: "union_type" }>,
  ctx: ctx,
): boolean {
  if (expected.cases.length !== actual.cases.length) {
    return false;
  }

  for (let index = 0; index < expected.cases.length; index += 1) {
    const expected_case = expected.cases[index];
    const actual_case = actual.cases[index];
    expect(expected_case, "Missing expected core union case " + index);
    expect(actual_case, "Missing actual core union case " + index);

    if (expected_case.name !== actual_case.name) {
      return false;
    }

    const expected_type = resolve_core_type_name(expected_case.type_name, ctx);
    const actual_type = resolve_core_type_name(actual_case.type_name, ctx);

    if (expected_type !== actual_type) {
      return false;
    }
  }

  return true;
}

export function check_core_struct_fields<ctx extends CoreTypeCheckCtx>(
  type_value: Extract<CoreTypeValue, { tag: "struct_type" }>,
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): void {
  for (const declared of type_value.fields) {
    const field = find_core_field(fields, declared.name);

    if (!field) {
      throw new Error("Missing core struct field: " + declared.name);
    }

    check_core_value_type_name(
      "Core struct field " + declared.name,
      declared.type_name,
      field.value,
      ctx,
      hooks,
    );
  }

  for (const field of fields) {
    const declared = find_core_type_field(type_value.fields, field.name);

    if (!declared) {
      throw new Error("Unknown core struct field: " + field.name);
    }
  }
}

export function check_core_union_case_value<ctx extends CoreTypeCheckCtx>(
  type_value: Extract<CoreTypeValue, { tag: "union_type" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): void {
  const declared = find_core_type_field(type_value.cases, union_case.name);

  if (!declared) {
    throw new Error("Missing union case: " + union_case.name);
  }

  if (declared.type_name === "Unit") {
    if (union_case.value) {
      throw new Error("Core union case " + union_case.name + " expects Unit");
    }

    return;
  }

  const value = union_case.value;
  expect(value, "Missing core union case payload: " + union_case.name);
  check_core_value_type_name(
    "Core union case " + union_case.name,
    declared.type_name,
    value,
    ctx,
    hooks,
  );
}
