import { expect } from "../expect.ts";
import type { CoreExpr, CoreFnType } from "./ast.ts";
import { find_core_field } from "./analysis/field.ts";
import { core_host_import_result_ownership } from "./host_import.ts";
import { runtime_aggregate_field_info } from "./runtime_aggregate.ts";
import { core_text_block_fact } from "./text_facts/block.ts";
import {
  core_collection_index_text_fact,
  core_get_app_text_fact,
} from "./text_facts/collection.ts";
import { core_if_let_text_fact } from "./text_facts/if_let.ts";
import {
  core_append_app_args_with_check,
  core_runtime_text_concat_operands_with_check,
  core_runtime_text_eq_operands_with_check,
  core_runtime_text_slice_args_with_check,
} from "./text_facts/runtime_ops.ts";
import type {
  CoreTextFactCtx,
  CoreTextFactHooks,
  RuntimeTextEq,
} from "./text_facts/types.ts";
import { core_bytes_generate_args } from "./runtime_bytes/generate.ts";
import { core_runtime_buffer_builtin } from "./runtime_buffer.ts";
import { core_expr_definitely_exits } from "./expr_type/control.ts";

export type { CoreTextFactCtx, CoreTextFactHooks, RuntimeTextEq };

export function core_expr_is_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (hooks.static_text_value(value, ctx)) {
    return true;
  }

  if (value.tag === "var") {
    return ctx.text_locals.has(value.name);
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return core_expr_is_text(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return core_expr_is_text(value.body, ctx, hooks);
  }

  const block_text = core_text_block_fact(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );

  if (block_text !== undefined) {
    return block_text;
  }

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core text if condition must be i32");

    if (value.implicit_else) {
      return core_expr_is_text(value.then_branch, ctx, hooks);
    }

    if (core_expr_definitely_exits(value.then_branch)) {
      return core_expr_is_text(value.else_branch, ctx, hooks);
    }

    if (core_expr_definitely_exits(value.else_branch)) {
      return core_expr_is_text(value.then_branch, ctx, hooks);
    }

    return core_expr_is_text(value.then_branch, ctx, hooks) &&
      core_expr_is_text(value.else_branch, ctx, hooks);
  }

  if (value.tag === "if_let") {
    const if_let_text = core_if_let_text_fact(
      value,
      ctx,
      hooks,
      core_expr_is_text,
    );

    if (if_let_text !== undefined) {
      return if_let_text;
    }
  }

  if (value.tag === "field") {
    const struct_value = hooks.static_struct_value(value.object, ctx);

    if (!struct_value) {
      let field_info;

      try {
        field_info = runtime_aggregate_field_info(
          value.object,
          value.name,
          ctx,
          hooks,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith(
            "Core runtime aggregate requires a static struct type",
          )
        ) {
          return false;
        }

        throw error;
      }

      if (field_info && field_info.tag === "value") {
        return field_info.text;
      }

      return false;
    }

    const field = find_core_field(struct_value.fields, value.name);
    expect(field, "Missing static core field: " + value.name);
    return core_expr_is_text(field.value, ctx, hooks);
  }

  if (value.tag === "index") {
    return core_collection_index_text_fact(
      value.object,
      value.index,
      ctx,
      hooks,
      core_expr_is_text,
    );
  }

  if (core_runtime_text_concat_operands(value, ctx, hooks)) {
    return true;
  }

  if (core_runtime_text_slice_args(value, ctx, hooks)) {
    return true;
  }

  if (core_append_app_args(value, ctx, hooks)) {
    return true;
  }

  if (core_bytes_generate_args(value)) {
    return true;
  }

  if (core_runtime_buffer_builtin(value)) {
    return true;
  }

  if (core_get_app_text_fact(value, ctx, hooks, core_expr_is_text)) {
    return true;
  }

  if (core_host_import_result_is_text(value, ctx)) {
    return true;
  }

  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return core_expr_is_text(inlined, ctx, hooks);
  }

  if (value.tag === "app") {
    const fn_type = core_text_app_fn_type(value, ctx, hooks);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_text;
    }
  }

  return false;
}

export function core_expr_has_runtime_text_fact<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (value.tag === "var") {
    return ctx.text_locals.has(value.name);
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return core_expr_has_runtime_text_fact(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return core_expr_has_runtime_text_fact(value.body, ctx, hooks);
  }

  const block_text = core_text_block_fact(
    value,
    ctx,
    hooks,
    core_expr_has_runtime_text_fact,
  );

  if (block_text !== undefined) {
    return block_text;
  }

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core text if condition must be i32");

    if (value.implicit_else) {
      return core_expr_has_runtime_text_fact(value.then_branch, ctx, hooks);
    }

    if (core_expr_definitely_exits(value.then_branch)) {
      return core_expr_has_runtime_text_fact(value.else_branch, ctx, hooks);
    }

    if (core_expr_definitely_exits(value.else_branch)) {
      return core_expr_has_runtime_text_fact(value.then_branch, ctx, hooks);
    }

    return core_expr_has_runtime_text_fact(value.then_branch, ctx, hooks) &&
      core_expr_has_runtime_text_fact(value.else_branch, ctx, hooks);
  }

  if (value.tag === "if_let") {
    const if_let_text = core_if_let_text_fact(
      value,
      ctx,
      hooks,
      core_expr_has_runtime_text_fact,
    );

    if (if_let_text !== undefined) {
      return if_let_text;
    }
  }

  if (value.tag === "field") {
    const struct_value = hooks.static_struct_value(value.object, ctx);

    if (!struct_value) {
      const field_info = runtime_aggregate_field_info(
        value.object,
        value.name,
        ctx,
        hooks,
      );

      if (field_info && field_info.tag === "value") {
        return field_info.text;
      }

      return false;
    }

    const field = find_core_field(struct_value.fields, value.name);
    expect(field, "Missing static core field: " + value.name);
    return core_expr_has_runtime_text_fact(field.value, ctx, hooks);
  }

  if (value.tag === "index") {
    return core_collection_index_text_fact(
      value.object,
      value.index,
      ctx,
      hooks,
      core_expr_has_runtime_text_fact,
    );
  }

  if (core_runtime_text_concat_operands(value, ctx, hooks)) {
    return true;
  }

  if (core_runtime_text_slice_args(value, ctx, hooks)) {
    return true;
  }

  if (core_append_app_args(value, ctx, hooks)) {
    return true;
  }

  if (core_bytes_generate_args(value)) {
    return true;
  }

  if (core_runtime_buffer_builtin(value)) {
    return true;
  }

  if (
    core_get_app_text_fact(
      value,
      ctx,
      hooks,
      core_expr_has_runtime_text_fact,
    )
  ) {
    return true;
  }

  if (core_host_import_result_is_unique_text(value, ctx)) {
    return true;
  }

  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return core_expr_has_runtime_text_fact(inlined, ctx, hooks);
  }

  if (value.tag === "app") {
    const fn_type = core_text_app_fn_type(value, ctx, hooks);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_text;
    }
  }

  return false;
}

function core_host_import_result_is_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
): boolean {
  const ownership = core_host_import_result_ownership(value, ctx);

  if (!ownership) {
    return false;
  }

  if (
    ownership.tag === "unique_heap" &&
    (ownership.reason === "text" || ownership.reason === "bytes")
  ) {
    return true;
  }

  if (
    ownership.tag === "frozen_shareable" &&
    (ownership.reason === "text" || ownership.reason === "bytes")
  ) {
    return true;
  }

  return false;
}

function core_host_import_result_is_unique_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
): boolean {
  const ownership = core_host_import_result_ownership(value, ctx);

  if (!ownership) {
    return false;
  }

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  return ownership.reason === "text" || ownership.reason === "bytes";
}

function core_text_app_fn_type<ctx extends CoreTextFactCtx>(
  value: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): CoreFnType | undefined {
  if (value.func.tag === "var") {
    const fn_type = ctx.fn_types.get(value.func.name);

    if (fn_type) {
      return fn_type;
    }
  }

  try {
    return hooks.closure_fn_type(value.func, ctx);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "Core first-class closure parameter must use a scalar annotation:",
      )
    ) {
      return undefined;
    }

    throw error;
  }
}

function core_append_app_args<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  return core_append_app_args_with_check(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );
}

export function core_runtime_text_concat_operands<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  return core_runtime_text_concat_operands_with_check(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );
}

export function core_runtime_text_eq_operands<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): RuntimeTextEq | undefined {
  return core_runtime_text_eq_operands_with_check(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );
}

function core_runtime_text_slice_args<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr, CoreExpr] | undefined {
  return core_runtime_text_slice_args_with_check(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );
}
