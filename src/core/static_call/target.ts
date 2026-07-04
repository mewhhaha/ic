import { expect } from "../../expect.ts";
import type { CoreExpr } from "../ast.ts";
import { core_expr_has_static_call_statement_scope } from "../scope_analysis.ts";
import { substitute_core_call_expr } from "../substitute.ts";
import { static_block_result } from "../type_static.ts";
import { static_type_value } from "../type_static.ts";
import { check_static_core_call_arity } from "./arity.ts";
import type {
  StaticCoreCallBlockCtx,
  StaticCoreCallCtx,
  StaticCoreCallHooks,
  StaticCoreCallTempCtx,
} from "./types.ts";

type StaticCoreCallBranchHooks<ctx extends StaticCoreCallCtx> = {
  static_core_call_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
};

export function static_core_call_requires_scope(
  target: Extract<CoreExpr, { tag: "lam" }>,
): boolean {
  return core_expr_has_static_call_statement_scope(target.body);
}

export function static_core_call_branch_value<
  ctx extends StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: StaticCoreCallBranchHooks<ctx>,
): Extract<CoreExpr, { tag: "if" }> | undefined {
  if (expr.tag === "block") {
    const value = static_block_result(expr);

    if (!value) {
      return undefined;
    }

    return static_core_call_branch_value(value, ctx, hooks);
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (!value) {
      return undefined;
    }

    return static_core_call_branch_value(value, ctx, hooks);
  }

  if (expr.tag !== "if") {
    return undefined;
  }

  const then_target = hooks.static_core_call_target(expr.then_branch, ctx);

  if (!then_target) {
    return undefined;
  }

  const else_target = hooks.static_core_call_target(expr.else_branch, ctx);

  if (!else_target) {
    return undefined;
  }

  if (
    !static_core_call_target_is_static_branch(then_target, ctx) &&
    !static_core_call_target_is_static_branch(else_target, ctx)
  ) {
    return undefined;
  }

  return expr;
}

function static_core_call_target_has_const_param(
  target: Extract<CoreExpr, { tag: "lam" }>,
): boolean {
  for (const param of target.params) {
    if (param.is_const) {
      return true;
    }
  }

  return false;
}

function static_core_call_target_is_static_branch<
  ctx extends StaticCoreCallCtx,
>(
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
): boolean {
  if (static_core_call_target_has_const_param(target)) {
    return true;
  }

  for (const param of target.params) {
    if (!param.annotation) {
      continue;
    }

    const type_value = static_type_value({
      tag: "var",
      name: param.annotation,
    }, ctx);

    if (type_value) {
      return true;
    }
  }

  return false;
}

export function static_core_call_branch_app<
  ctx extends StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: StaticCoreCallBranchHooks<ctx>,
): Extract<CoreExpr, { tag: "if" }> | undefined {
  const branch = static_core_call_branch_value(expr.func, ctx, hooks);

  if (!branch) {
    return undefined;
  }

  const then_target = hooks.static_core_call_target(branch.then_branch, ctx);
  expect(then_target, "Missing static branch then call target");
  const else_target = hooks.static_core_call_target(branch.else_branch, ctx);
  expect(else_target, "Missing static branch else call target");

  return {
    tag: "if",
    cond: branch.cond,
    then_branch: {
      tag: "app",
      func: then_target,
      args: expr.args,
    },
    else_branch: {
      tag: "app",
      func: else_target,
      args: expr.args,
    },
    implicit_else: branch.implicit_else,
  };
}

export function static_core_call_value<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: CoreExpr,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): CoreExpr | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  const target = static_core_call_target(expr.func, ctx, hooks);

  if (!target) {
    return undefined;
  }

  if (static_core_call_requires_scope(target)) {
    return undefined;
  }

  check_static_core_call_arity(expr, target);
  const replacements = new Map<string, CoreExpr>();

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core static call parameter " + index.toString());
    expect(arg, "Missing core static call argument " + index.toString());
    replacements.set(
      param.name,
      hooks.apply_core_parameter_annotation(param, arg, ctx),
    );
  }

  return substitute_core_call_expr(target.body, replacements);
}

export function static_core_call_target<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: CoreExpr,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): Extract<CoreExpr, { tag: "lam" }> | undefined {
  if (expr.tag === "lam") {
    return expr;
  }

  if (expr.tag === "block") {
    const value = static_block_result(expr);

    if (!value) {
      return undefined;
    }

    return static_core_call_target(value, ctx, hooks);
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (!value) {
      return undefined;
    }

    return static_core_call_target(value, ctx, hooks);
  }

  if (expr.tag === "app") {
    const value = static_core_call_value(expr, ctx, hooks);

    if (!value) {
      return undefined;
    }

    return static_core_call_target(value, ctx, hooks);
  }

  return undefined;
}

export function static_core_rec_target<
  ctx extends { statics: Map<string, CoreExpr> },
>(
  expr: CoreExpr,
  ctx: ctx,
): Extract<CoreExpr, { tag: "rec" }> | undefined {
  if (expr.tag === "rec") {
    return expr;
  }

  if (expr.tag === "block") {
    const value = static_block_result(expr);

    if (!value) {
      return undefined;
    }

    return static_core_rec_target(value, ctx);
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (!value) {
      return undefined;
    }

    return static_core_rec_target(value, ctx);
  }

  return undefined;
}
