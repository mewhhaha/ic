import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreField, CoreFnType } from "./ast.ts";
import { maybe_static_i32, static_indexed_field } from "./backend/util.ts";
import {
  type CoreHostImportCtx,
  emit_core_host_import_call,
} from "./host_import.ts";
import {
  static_core_call_branch_app,
  type StaticCoreCallCtx,
} from "./static_call.ts";

export type CoreAppEmitHooks<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
> = {
  app_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    ctx: ctx,
  ) => ValType;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  emit_core_rec_call: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: ctx,
  ) => Wat;
  emit_dynamic_closure_call: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => Wat;
  emit_dynamic_index_expr: (
    fields: CoreField[],
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_runtime_text_byte_index: (
    collection: CoreExpr,
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_append: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_len: (
    collection: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_slice: (
    text: CoreExpr,
    start: CoreExpr,
    end: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_scoped_static_core_call: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreField[] | undefined;
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_core_rec_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "rec" }> | undefined;
  static_text_length_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_text_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  text_byte_index_expr: (
    text: CoreExpr,
    index: CoreExpr,
  ) => CoreExpr;
};

export function emit_core_app<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreAppEmitHooks<ctx>,
): Wat {
  let name: string | undefined;

  if (expr.func.tag === "var") {
    name = expr.func.name;
  }

  if (name === "len") {
    hooks.app_type(expr, ctx);
    const collection = expr.args[0];
    expect(collection, "Missing core len collection");
    const fields = hooks.static_collection_fields(collection, ctx);

    if (fields) {
      return "i32.const " + fields.length.toString();
    }

    const text_length = hooks.static_text_length_expr(collection, ctx);

    if (text_length) {
      return hooks.emit_expr(text_length, ctx);
    }

    expect(
      hooks.core_expr_is_text(collection, ctx),
      "Cannot emit core len over unknown collection or text",
    );
    return hooks.emit_runtime_text_len(collection, ctx);
  }

  if (name === "get") {
    hooks.app_type(expr, ctx);
    const collection = expr.args[0];
    expect(collection, "Missing core get collection");
    const index_expr = expr.args[1];
    expect(index_expr, "Missing core get index");
    const fields = hooks.static_collection_fields(collection, ctx);

    if (!fields) {
      const text = hooks.static_text_value(collection, ctx);

      if (text) {
        return hooks.emit_expr(
          hooks.text_byte_index_expr(text, index_expr),
          ctx,
        );
      }

      expect(
        hooks.core_expr_is_text(collection, ctx),
        "Cannot emit core get over unknown collection",
      );
      return hooks.emit_runtime_text_byte_index(collection, index_expr, ctx);
    }

    const index = maybe_static_i32(index_expr);

    if (index !== undefined) {
      const field = static_indexed_field(fields, index);
      return hooks.emit_expr(field.value, ctx);
    }

    return hooks.emit_dynamic_index_expr(fields, index_expr, ctx);
  }

  if (name === "slice") {
    hooks.app_type(expr, ctx);
    const text = expr.args[0];
    const start = expr.args[1];
    const end = expr.args[2];
    expect(text, "Missing core slice text argument");
    expect(start, "Missing core slice start argument");
    expect(end, "Missing core slice end argument");
    return hooks.emit_runtime_text_slice(text, start, end, ctx);
  }

  if (name === "panic") {
    hooks.app_type(expr, ctx);
    return "unreachable";
  }

  const rec_target = hooks.static_core_rec_target(expr.func, ctx);

  if (rec_target) {
    return hooks.emit_core_rec_call(expr, rec_target, ctx);
  }

  const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

  if (branch_static_call) {
    return hooks.emit_expr(branch_static_call, ctx);
  }

  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return hooks.emit_expr(inlined, ctx);
  }

  const target = hooks.static_core_call_target(expr.func, ctx);

  if (target && hooks.static_core_call_requires_scope(target)) {
    return hooks.emit_scoped_static_core_call(expr, target, ctx);
  }

  const fn_type = hooks.closure_fn_type(expr.func, ctx);

  if (fn_type) {
    return hooks.emit_dynamic_closure_call(expr, fn_type, ctx);
  }

  if (name === "append") {
    hooks.app_type(expr, ctx);
    const left = expr.args[0];
    const right = expr.args[1];
    expect(left, "Missing core append left argument");
    expect(right, "Missing core append right argument");
    return hooks.emit_runtime_text_append(left, right, ctx);
  }

  const host_import_call = emit_core_host_import_call(
    expr,
    ctx,
    hooks.emit_expr,
    hooks.expr_type,
  );

  if (host_import_call) {
    return host_import_call;
  }

  throw new Error("Cannot emit core app expression yet");
}
