import { expect } from "../../expect.ts";
import type { CoreExpr, CoreFnType } from "../ast.ts";
import { find_core_field } from "../analysis/field.ts";
import { same_runtime_aggregate_type_expr } from "../runtime_aggregate.ts";
import { same_runtime_union_type_expr } from "../runtime_union.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
  static_type_value,
} from "../type_static.ts";
import { find_core_type_field } from "../union_static.ts";
import type { CoreClosureTypeCtx, CoreClosureTypeHooks } from "./types.ts";

export function check_closure_call_args(
  expr: Extract<CoreExpr, { tag: "app" }>,
  fn_type: CoreFnType,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): void {
  if (expr.args.length !== fn_type.params.length) {
    throw new Error(
      "Core closure call expected " + fn_type.params.length.toString() +
        " arguments, got " + expr.args.length.toString(),
    );
  }

  for (let index = 0; index < expr.args.length; index += 1) {
    const arg = expr.args[index];
    const expected = fn_type.params[index];
    const expected_text = fn_type.param_texts[index];
    const expected_constraint = fn_type.param_constraints?.[index];
    const expected_struct = fn_type.param_structs?.[index];
    const expected_union = fn_type.param_unions?.[index];
    expect(arg, "Missing core closure call argument " + index.toString());
    expect(expected, "Missing core closure call parameter " + index.toString());
    expect(
      expected_text !== undefined,
      "Missing core closure call parameter text fact " + index.toString(),
    );

    if (expected_constraint) {
      hooks.apply_core_parameter_annotation(
        {
          name: "__duck_closure_arg_" + index.toString(),
          is_const: false,
          is_linear: false,
          annotation: expected_constraint,
        },
        arg,
        ctx,
      );
    }

    const actual_union = closure_call_arg_union_type(
      arg,
      ctx,
      hooks,
      expected_union,
    );

    if (expected_union) {
      expect(
        same_runtime_union_type_expr(
          actual_union,
          expected_union,
          ctx,
        ),
        "Core closure call argument " + index.toString() +
          " expects union parameter",
      );
    }

    let actual = expected;

    if (!expected_union || !actual_union) {
      actual = hooks.expr_type(arg, ctx);
    }

    expect(
      actual === expected,
      "Core closure call argument " + index.toString() + " expects " +
        expected + ", got " + actual,
    );

    if (expected_text) {
      expect(
        hooks.core_expr_is_text(arg, ctx),
        "Core closure call argument " + index.toString() +
          " expects Text",
      );
    } else if (expected === "i32" && hooks.core_expr_is_text(arg, ctx)) {
      throw new Error(
        "Core closure call argument " + index.toString() +
          " expects i32, got Text",
      );
    }

    if (expected_struct) {
      expect(
        same_runtime_aggregate_type_expr(
          closure_call_arg_struct_type(arg, ctx, hooks, expected_struct),
          expected_struct,
          ctx,
        ),
        "Core closure call argument " + index.toString() +
          " expects aggregate parameter",
      );
    }
  }
}

function closure_call_arg_struct_type(
  expr: CoreExpr,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
  expected: CoreExpr | undefined,
): CoreExpr | undefined {
  if (expr.tag === "struct_value") {
    if (
      expected &&
      expr.type_expr &&
      !same_runtime_aggregate_type_expr(expr.type_expr, expected, ctx) &&
      closure_struct_literal_matches_expected(expr, expected, ctx, hooks)
    ) {
      return expected;
    }

    if (
      expected &&
      !expr.type_expr &&
      closure_struct_literal_matches_expected(expr, expected, ctx, hooks)
    ) {
      return expected;
    }

    return expr.type_expr;
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const local = ctx.struct_locals.get(expr.name);

    if (local) {
      return local;
    }

    const static_value = ctx.statics.get(expr.name);

    if (static_value) {
      return closure_call_arg_struct_type(static_value, ctx, hooks, expected);
    }
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return closure_call_arg_struct_type(expr.value, ctx, hooks, expected);
  }

  if (expr.tag === "scratch") {
    return closure_call_arg_struct_type(expr.body, ctx, hooks, expected);
  }

  return undefined;
}

function closure_struct_literal_matches_expected(
  expr: Extract<CoreExpr, { tag: "struct_value" }>,
  expected: CoreExpr,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): boolean {
  const type_value = static_type_value(expected, ctx);

  if (!type_value || type_value.tag !== "struct_type") {
    return false;
  }

  for (const declared of type_value.fields) {
    const field = find_core_field(expr.fields, declared.name);

    if (!field) {
      return false;
    }

    if (
      !closure_arg_value_matches_type_name(
        field.value,
        declared.type_name,
        ctx,
        hooks,
      )
    ) {
      return false;
    }
  }

  for (const field of expr.fields) {
    const declared = find_core_type_field(type_value.fields, field.name);

    if (!declared) {
      return false;
    }
  }

  return true;
}

function closure_arg_value_matches_type_name(
  value: CoreExpr,
  type_name: string,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): boolean {
  const resolved = resolve_core_type_name(type_name, ctx);

  if (resolved === "Unit") {
    return false;
  }

  if (resolved === "Text") {
    return hooks.core_expr_is_text(value, ctx);
  }

  const val_type = core_val_type_from_type_name(resolved);

  if (val_type) {
    if (hooks.core_expr_is_text(value, ctx)) {
      return false;
    }

    return hooks.expr_type(value, ctx) === val_type;
  }

  const type_value = static_type_value({ tag: "var", name: resolved }, ctx);

  if (!type_value) {
    return false;
  }

  if (type_value.tag === "struct_type") {
    return same_runtime_aggregate_type_expr(
      closure_call_arg_struct_type(value, ctx, hooks, type_value),
      type_value,
      ctx,
    );
  }

  return same_runtime_union_type_expr(
    closure_call_arg_union_type(value, ctx, hooks, type_value),
    type_value,
    ctx,
  );
}

function closure_call_arg_union_type(
  expr: CoreExpr,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
  expected: CoreExpr | undefined,
): CoreExpr | undefined {
  if (expr.tag === "union_case") {
    if (
      expected &&
      expr.type_expr &&
      !same_runtime_union_type_expr(expr.type_expr, expected, ctx) &&
      closure_union_case_matches_expected(expr, expected, ctx, hooks)
    ) {
      return expected;
    }

    if (
      expected &&
      !expr.type_expr &&
      closure_union_case_matches_expected(expr, expected, ctx, hooks)
    ) {
      return expected;
    }

    return expr.type_expr;
  }

  const inferred = hooks.runtime_union_type_expr(expr, ctx);

  if (inferred) {
    return inferred;
  }

  if (expr.tag === "var") {
    const local = ctx.union_locals.get(expr.name);

    if (local) {
      return local;
    }

    const static_value = ctx.statics.get(expr.name);

    if (static_value) {
      return closure_call_arg_union_type(static_value, ctx, hooks, expected);
    }
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return closure_call_arg_union_type(expr.value, ctx, hooks, expected);
  }

  if (expr.tag === "scratch") {
    return closure_call_arg_union_type(expr.body, ctx, hooks, expected);
  }

  return undefined;
}

function closure_union_case_matches_expected(
  expr: Extract<CoreExpr, { tag: "union_case" }>,
  expected: CoreExpr,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): boolean {
  const type_value = static_type_value(expected, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return false;
  }

  const declared = find_core_type_field(type_value.cases, expr.name);

  if (!declared) {
    return false;
  }

  if (declared.type_name === "Unit") {
    if (expr.value) {
      return false;
    }

    return true;
  }

  const value = expr.value;

  if (!value) {
    return false;
  }

  return closure_arg_value_matches_type_name(
    value,
    declared.type_name,
    ctx,
    hooks,
  );
}
