import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreParam } from "./ast.ts";
import { maybe_static_i32, static_indexed_field } from "./backend/util.ts";
import {
  core_host_import_result_type,
  type CoreHostImportCtx,
} from "./host_import.ts";
import { static_collection_item_type } from "./index_expr.ts";
import {
  static_core_call_branch_app,
  type StaticCoreCallCtx,
} from "./static_call.ts";
import { core_val_type_from_type_name } from "./type_static.ts";

export type CoreAppTypeHooks<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
> = {
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  rec_call_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: ctx,
  ) => ValType;
  scoped_static_core_call_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => ValType;
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

export function app_type<ctx extends CoreHostImportCtx & StaticCoreCallCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreAppTypeHooks<ctx>,
): ValType {
  if (expr.func.tag === "rec_ref") {
    expect(
      expr.args.length === expr.func.params.length,
      "Core named recursive call " + expr.func.name + " expects " +
        expr.func.params.length.toString() + " arguments",
    );

    for (let index = 0; index < expr.func.params.length; index += 1) {
      const param = expr.func.params[index];
      const arg = expr.args[index];
      expect(param, "Missing named recursive parameter " + index.toString());
      expect(arg, "Missing named recursive argument " + index.toString());
      const param_type = named_rec_param_type(param);
      expect(
        param_type === "i32",
        "Named recursive Core calls only support i32 params for now: " +
          param.name,
      );
      const arg_type = hooks.expr_type(arg, ctx);
      expect(
        arg_type === param_type,
        "Core named recursive call " + expr.func.name + " argument " +
          index.toString() + " must be " + param_type,
      );
    }

    return "i32";
  }

  let name: string | undefined;

  if (expr.func.tag === "var") {
    name = expr.func.name;
  }

  if (name === "len") {
    expect(expr.args.length === 1, "Core len expects 1 argument");
    const collection = expr.args[0];
    expect(collection, "Missing core len collection");
    const fields = hooks.static_collection_fields(collection, ctx);

    if (fields) {
      return "i32";
    }

    const text_length = hooks.static_text_length_expr(collection, ctx);

    if (text_length) {
      return "i32";
    }

    if (hooks.core_expr_is_text(collection, ctx)) {
      return "i32";
    }

    throw new Error("Cannot type core len over unknown collection or text");
  }

  if (name === "get") {
    expect(expr.args.length === 2, "Core get expects 2 arguments");
    const collection = expr.args[0];
    expect(collection, "Missing core get collection");
    const index_expr = expr.args[1];
    expect(index_expr, "Missing core get index");
    const fields = hooks.static_collection_fields(collection, ctx);

    if (!fields) {
      const text = hooks.static_text_value(collection, ctx);

      if (text) {
        const index_type = hooks.expr_type(index_expr, ctx);
        expect(index_type === "i32", "Core get index must be i32");
        return hooks.expr_type(
          hooks.text_byte_index_expr(text, index_expr),
          ctx,
        );
      }

      if (hooks.core_expr_is_text(collection, ctx)) {
        const index_type = hooks.expr_type(index_expr, ctx);
        expect(index_type === "i32", "Core get index must be i32");
        return "i32";
      }

      throw new Error("Cannot type core get over unknown collection");
    }

    const index_type = hooks.expr_type(index_expr, ctx);
    expect(index_type === "i32", "Core get index must be i32");
    const index = maybe_static_i32(index_expr);

    if (index !== undefined) {
      const field = static_indexed_field(fields, index);
      return hooks.expr_type(field.value, ctx);
    }

    const item_type = static_collection_item_type(fields, ctx, hooks);
    expect(item_type, "Core get requires non-empty collection");
    return item_type;
  }

  if (name === "slice") {
    expect(expr.args.length === 3, "Core slice expects 3 arguments");
    const text = expr.args[0];
    const start = expr.args[1];
    const end = expr.args[2];
    expect(text, "Missing core slice text argument");
    expect(start, "Missing core slice start argument");
    expect(end, "Missing core slice end argument");
    expect(hooks.core_expr_is_text(text, ctx), "Core slice text must be Text");
    const start_type = hooks.expr_type(start, ctx);
    const end_type = hooks.expr_type(end, ctx);
    expect(start_type === "i32", "Core slice start must be i32");
    expect(end_type === "i32", "Core slice end must be i32");
    return "i32";
  }

  if (name === "panic") {
    expect(expr.args.length === 1, "Core panic expects 1 argument");
    const message = expr.args[0];
    expect(message, "Missing core panic message");
    expect(message.tag === "text", "Core panic message must be text");
    return "i32";
  }

  const rec_target = hooks.static_core_rec_target(expr.func, ctx);

  if (rec_target) {
    return hooks.rec_call_type(expr, rec_target, ctx);
  }

  const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

  if (branch_static_call) {
    return hooks.expr_type(branch_static_call, ctx);
  }

  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return hooks.expr_type(inlined, ctx);
  }

  const target = hooks.static_core_call_target(expr.func, ctx);

  if (target && hooks.static_core_call_requires_scope(target)) {
    return hooks.scoped_static_core_call_type(expr, target, ctx);
  }

  const fn_type = hooks.closure_fn_type(expr.func, ctx);

  if (fn_type) {
    hooks.check_closure_call_args(expr, fn_type, ctx);
    return fn_type.result;
  }

  if (name === "append") {
    expect(expr.args.length === 2, "Core append expects 2 arguments");
    const left = expr.args[0];
    const right = expr.args[1];
    expect(left, "Missing core append left argument");
    expect(right, "Missing core append right argument");
    expect(hooks.core_expr_is_text(left, ctx), "Core append left must be Text");
    expect(
      hooks.core_expr_is_text(right, ctx),
      "Core append right must be Text",
    );
    return "i32";
  }

  const host_import_type = core_host_import_result_type(
    expr,
    ctx,
    hooks.expr_type,
  );

  if (host_import_type) {
    return host_import_type;
  }

  throw new Error("Cannot type core app expression yet");
}

function named_rec_param_type(param: CoreParam): ValType {
  if (!param.annotation) {
    return "i32";
  }

  const type = core_val_type_from_type_name(param.annotation);
  expect(type, "Cannot type named recursive parameter annotation: " + param.annotation);
  return type;
}
