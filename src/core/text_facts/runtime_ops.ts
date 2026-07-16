import { expect } from "../../expect.ts";
import { Prim } from "../../op.ts";
import { Callable } from "../../trait.ts";
import type { CoreExpr } from "../ast.ts";
import type {
  CoreTextFactCtx,
  CoreTextFactHooks,
  RuntimeTextEq,
} from "./types.ts";

type CoreTextChecker<ctx extends CoreTextFactCtx> = (
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
) => boolean;

export function core_append_app_args_with_check<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  if (value.func.tag !== "var" || value.func.name !== "@append") {
    return undefined;
  }

  if (ctx.statics.has(value.func.name) || ctx.fn_types.has(value.func.name)) {
    return undefined;
  }

  if (value.args.length !== 2) {
    return undefined;
  }

  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core append left operand");
  expect(right, "Missing core append right operand");

  if (!check_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!check_text(right, ctx, hooks)) {
    return undefined;
  }

  return [left, right];
}

export function core_runtime_text_concat_operands_with_check<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "prim" || value.prim !== "i32.add") {
    return undefined;
  }

  if (hooks.static_text_value(value, ctx)) {
    return undefined;
  }

  const expected = Callable.arity(Prim, value.prim);
  expect(
    value.args.length === expected,
    "Primitive " + value.prim + " expects " + expected + " arguments",
  );
  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core text concat left operand");
  expect(right, "Missing core text concat right operand");

  if (!check_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!check_text(right, ctx, hooks)) {
    return undefined;
  }

  return [left, right];
}

export function core_runtime_text_eq_operands_with_check<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): RuntimeTextEq | undefined {
  if (value.tag !== "prim") {
    return undefined;
  }

  if (value.prim !== "i32.eq" && value.prim !== "i32.ne") {
    return undefined;
  }

  const expected = Callable.arity(Prim, value.prim);
  expect(
    value.args.length === expected,
    "Primitive " + value.prim + " expects " + expected + " arguments",
  );
  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core text equality left operand");
  expect(right, "Missing core text equality right operand");

  if (!check_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!check_text(right, ctx, hooks)) {
    return undefined;
  }

  return { left, right, prim: value.prim };
}

export function core_runtime_text_slice_args_with_check<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): [CoreExpr, CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  if (value.func.tag !== "var" || value.func.name !== "@slice") {
    return undefined;
  }

  expect(value.args.length === 3, "Core slice expects 3 arguments");
  const text = value.args[0];
  const start = value.args[1];
  const end = value.args[2];
  expect(text, "Missing core slice text argument");
  expect(start, "Missing core slice start argument");
  expect(end, "Missing core slice end argument");

  if (!check_text(text, ctx, hooks)) {
    return undefined;
  }

  const start_type = hooks.expr_type(start, ctx);
  const end_type = hooks.expr_type(end, ctx);
  expect(start_type === "i32", "Core slice start must be i32");
  expect(end_type === "i32", "Core slice end must be i32");
  return [text, start, end];
}
