import type { CoreExpr } from "./ast.ts";
import { static_block_result } from "./type_static.ts";

type StaticOwnerFactCtx = {
  statics: Map<string, CoreExpr>;
  static_capture_values?: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  scratch_depth?: number;
  materialized_bindings?: Set<string>;
};

export function materialized_static_owner_binding(
  name: string,
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
): boolean {
  if (ctx.scratch_depth && ctx.scratch_depth > 0) {
    return false;
  }

  if (!ctx.materialized_bindings?.has(name)) {
    return false;
  }

  return mutable_static_owner_value_materializes(value);
}

export function static_owner_value_materializes(
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
): boolean {
  return static_owner_value_materializes_inner(value, ctx, new Set());
}

function static_owner_value_materializes_inner(
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
  visiting: Set<string>,
): boolean {
  if (ctx.scratch_depth && ctx.scratch_depth > 0) {
    return false;
  }

  if (value.tag === "if") {
    return static_owner_conditional_branch_materializes(
      value.then_branch,
      ctx,
      new Set(visiting),
    ) || static_owner_conditional_branch_materializes(
      value.else_branch,
      ctx,
      new Set(visiting),
    );
  }

  if (value.tag !== "struct_value") {
    return false;
  }

  if (
    value.type_expr.tag === "var" &&
    value.type_expr.name === "object_type"
  ) {
    return false;
  }

  for (const field of value.fields) {
    if (static_owner_child_materializes(field.value, ctx, visiting)) {
      return true;
    }
  }

  return false;
}

function static_owner_conditional_branch_materializes(
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
  visiting: Set<string>,
): boolean {
  const block_value = static_block_result(value);
  if (block_value) {
    return static_owner_conditional_branch_materializes(
      block_value,
      ctx,
      visiting,
    );
  }

  if (value.tag === "struct_value") {
    return true;
  }

  if (value.tag === "union_case") {
    return value.type_expr !== undefined;
  }

  return static_owner_value_materializes_inner(value, ctx, visiting);
}

function static_owner_child_materializes(
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
  visiting: Set<string>,
): boolean {
  if (value.tag === "lam" || value.tag === "rec") {
    return true;
  }

  if (value.tag === "struct_value") {
    return static_owner_value_materializes_inner(value, ctx, visiting);
  }

  if (value.tag === "union_case") {
    return value.type_expr !== undefined;
  }

  if (value.tag === "if") {
    return static_owner_child_materializes(value.then_branch, ctx, visiting) ||
      static_owner_child_materializes(value.else_branch, ctx, visiting);
  }

  if (value.tag !== "var" && value.tag !== "linear") {
    return false;
  }

  if (ctx.frozen_locals && ctx.frozen_locals.has(value.name)) {
    return false;
  }

  if (visiting.has(value.name)) {
    return true;
  }

  visiting.add(value.name);

  const captured_value = ctx.static_capture_values?.get(value.name);

  if (captured_value) {
    const captured_materializes = static_owner_captured_value_materializes(
      captured_value,
      ctx,
      visiting,
    );
    if (captured_materializes !== undefined) {
      visiting.delete(value.name);
      return captured_materializes;
    }
  }

  const static_value = ctx.statics.get(value.name);

  if (static_value) {
    const materializes = static_owner_child_materializes(
      static_value,
      ctx,
      visiting,
    );
    visiting.delete(value.name);
    return materializes;
  }

  const materializes = ctx.text_locals.has(value.name) ||
    ctx.struct_locals.has(value.name) ||
    ctx.union_locals.has(value.name);
  visiting.delete(value.name);
  return materializes;
}

function static_owner_captured_value_materializes(
  value: CoreExpr,
  ctx: StaticOwnerFactCtx,
  visiting: Set<string>,
): boolean | undefined {
  if (value.tag === "lam" || value.tag === "rec") {
    return true;
  }

  if (
    value.tag === "struct_value" ||
    value.tag === "union_case" ||
    value.tag === "if" ||
    value.tag === "var" ||
    value.tag === "linear"
  ) {
    return static_owner_child_materializes(value, ctx, visiting);
  }

  if (
    value.tag === "num" ||
    value.tag === "text" ||
    value.tag === "type_name" ||
    value.tag === "struct_type" ||
    value.tag === "union_type"
  ) {
    return false;
  }

  return undefined;
}

export function mutable_static_owner_value_materializes(
  value: CoreExpr,
): boolean {
  if (value.tag === "struct_value") {
    if (
      value.type_expr.tag === "var" &&
      value.type_expr.name === "object_type"
    ) {
      return false;
    }

    return true;
  }

  if (value.tag === "union_case") {
    return value.type_expr !== undefined;
  }

  if (value.tag !== "if") {
    return false;
  }

  return mutable_static_owner_value_materializes(value.then_branch) &&
    mutable_static_owner_value_materializes(value.else_branch);
}
