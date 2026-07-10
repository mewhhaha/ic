import type { CoreExpr, CoreParam, CoreStmt } from "../ast.ts";
import { is_type_level_expr, static_block_result } from "../type_static.ts";
import {
  core_binding_value_type_name,
  core_direct_annotation_actual_name,
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

  const type_name = hooks.static_type_name(value, ctx);

  if (type_name) {
    return type_name;
  }

  return hooks.static_type_value(value, ctx);
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
): CoreExpr {
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
      const expected_struct_type: CoreExpr = { tag: "var", name: annotation };

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
    const annotated_struct: CoreExpr = {
      tag: "struct_value",
      type_expr: { tag: "var", name: annotation },
      fields: struct_value.fields,
    };

    if (frozen_struct_value) {
      return {
        tag: "freeze",
        value: annotated_struct,
      };
    }

    return annotated_struct;
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    check_core_union_case_value(type_value, union_case, ctx, hooks);
    return {
      ...union_case,
      type_expr: { tag: "var", name: annotation },
    };
  }

  const union_if = hooks.dynamic_union_if(value, ctx);

  if (union_if) {
    check_core_union_case_value(type_value, union_if.then_case, ctx, hooks);
    check_core_union_case_value(type_value, union_if.else_case, ctx, hooks);
    return {
      tag: "if",
      cond: union_if.cond,
      then_branch: {
        ...union_if.then_case,
        type_expr: { tag: "var", name: annotation },
      },
      else_branch: {
        ...union_if.else_case,
        type_expr: { tag: "var", name: annotation },
      },
    };
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

  throw new Error(
    "Core binding annotation expects " + annotation + ", got " +
      core_direct_annotation_actual_name(value, ctx, hooks),
  );
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
  if (annotation === "Resume") {
    const actual = hooks.expr_type(value, ctx);

    if (actual !== "i32") {
      throw new Error(
        "Core " + label + " annotation expects Resume, got " + actual,
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

  if (annotation === "Text") {
    const actual = core_binding_value_type_name(value, ctx, hooks);

    if (actual !== "Text") {
      throw new Error(
        "Core " + label + " annotation expects Text, got " + actual,
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
