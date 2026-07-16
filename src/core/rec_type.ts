import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr, CoreFnType, CoreParam, CoreStmt } from "./ast.ts";
import { set_local } from "./emit/local.ts";

export type CoreRecStaticCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type CoreRecBlockCtx = CoreRecStaticCtx & {
  next_loop: number;
  next_temp: number;
};

export type CoreRecTypeHooks<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
> = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    arg: CoreExpr,
    ctx: static_ctx,
  ) => CoreExpr;
  collect_stmt_locals: (stmt: CoreStmt, ctx: block_ctx) => void;
  create_rec_call_ctx: (ctx: static_ctx) => static_ctx;
  create_rec_body_block_ctx: (ctx: static_ctx) => block_ctx;
  expr_type: (expr: CoreExpr, ctx: static_ctx) => ValType;
};

export function rec_call_type<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: static_ctx,
  hooks: CoreRecTypeHooks<static_ctx, block_ctx>,
): ValType {
  const body_ctx = hooks.create_rec_call_ctx(ctx);
  bind_rec_initial_params(expr, target, body_ctx, hooks);
  const result = rec_body_result_type(target.body, target, body_ctx, hooks);
  expect(result, "Core rec body must produce a value");
  return result;
}

export function bind_rec_initial_params<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: static_ctx,
  hooks: CoreRecTypeHooks<static_ctx, block_ctx>,
): void {
  if (expr.args.length !== target.params.length) {
    throw new Error(
      "Core rec expected " + target.params.length.toString() +
        " arguments, got " + expr.args.length.toString(),
    );
  }

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core rec parameter " + index.toString());
    expect(arg, "Missing core rec argument " + index.toString());
    const value = hooks.apply_core_parameter_annotation(param, arg, ctx);
    ctx.fn_types.delete(param.name);
    ctx.struct_locals.delete(param.name);
    ctx.union_locals.delete(param.name);
    set_local(ctx.locals, param.name, hooks.expr_type(value, ctx));

    if (param.annotation === "Text" || param.annotation === "Bytes") {
      ctx.text_locals.add(param.name);
    } else {
      ctx.text_locals.delete(param.name);
    }
  }
}

function rec_body_result_type<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
>(
  expr: CoreExpr,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: static_ctx,
  hooks: CoreRecTypeHooks<static_ctx, block_ctx>,
): ValType | undefined {
  if (is_core_rec_tail_call(expr)) {
    check_rec_tail_call_args(expr, target, ctx, hooks);
    return undefined;
  }

  if (expr.tag === "if") {
    const cond_type = hooks.expr_type(expr.cond, ctx);
    expect(cond_type === "i32", "Core rec condition must be i32");
    const then_type = rec_body_result_type(
      expr.then_branch,
      target,
      ctx,
      hooks,
    );
    const else_type = rec_body_result_type(
      expr.else_branch,
      target,
      ctx,
      hooks,
    );

    if (!then_type) {
      return else_type;
    }

    if (!else_type) {
      return then_type;
    }

    expect(then_type === else_type, "Core rec branch type mismatch");
    return then_type;
  }

  if (expr.tag === "block") {
    return rec_body_block_result_type(expr.statements, target, ctx, hooks);
  }

  return hooks.expr_type(expr, ctx);
}

function rec_body_block_result_type<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
>(
  statements: CoreStmt[],
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: static_ctx,
  hooks: CoreRecTypeHooks<static_ctx, block_ctx>,
): ValType | undefined {
  const block_ctx = hooks.create_rec_body_block_ctx(ctx);

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    expect(stmt, "Missing core rec body statement " + index.toString());
    const is_final = index + 1 >= statements.length;

    if (stmt.tag === "expr" && is_final) {
      return rec_body_result_type(stmt.expr, target, block_ctx, hooks);
    }

    if (stmt.tag === "return") {
      return rec_body_result_type(stmt.value, target, block_ctx, hooks);
    }

    hooks.collect_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

export function check_rec_tail_call_args<
  static_ctx extends CoreRecStaticCtx,
  block_ctx extends static_ctx & CoreRecBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: static_ctx,
  hooks: CoreRecTypeHooks<static_ctx, block_ctx>,
): void {
  if (expr.args.length !== target.params.length) {
    throw new Error(
      "Core rec expected " + target.params.length.toString() +
        " arguments, got " + expr.args.length.toString(),
    );
  }

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core rec parameter " + index.toString());
    expect(arg, "Missing core rec argument " + index.toString());
    const value = hooks.apply_core_parameter_annotation(param, arg, ctx);
    const actual = hooks.expr_type(value, ctx);
    const expected = ctx.locals.get(param.name);
    expect(expected, "Missing core rec parameter local: " + param.name);
    expect(
      actual === expected,
      "Core rec argument " + param.name + " expects " + expected + ", got " +
        actual,
    );
  }
}

export function is_core_rec_tail_call(
  expr: CoreExpr,
): expr is Extract<CoreExpr, { tag: "app" }> {
  return expr.tag === "app" && expr.func.tag === "var" &&
    expr.func.name === "rec";
}
