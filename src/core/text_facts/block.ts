import { expect } from "../../expect.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { set_local } from "../emit/local.ts";
import { core_val_type_from_type_name } from "../type_static.ts";
import type { CoreTextFactCtx, CoreTextFactHooks } from "./types.ts";

export function core_text_block_fact<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): boolean | undefined {
  if (value.tag !== "block") {
    return undefined;
  }

  const final_stmt = value.statements[value.statements.length - 1];

  if (!final_stmt) {
    return false;
  }

  const block_ctx = clone_core_text_fact_ctx(ctx);

  for (let index = 0; index + 1 < value.statements.length; index += 1) {
    const stmt = value.statements[index];
    expect(stmt, "Missing core text block statement " + index.toString());
    bind_core_text_block_stmt(stmt, block_ctx, hooks, check_text);
  }

  if (final_stmt.tag === "expr") {
    return check_text(final_stmt.expr, block_ctx, hooks);
  }

  if (final_stmt.tag === "return") {
    return check_text(final_stmt.value, block_ctx, hooks);
  }

  return false;
}

function bind_core_text_block_stmt<ctx extends CoreTextFactCtx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): void {
  if (stmt.tag === "bind") {
    const value = hooks.core_binding_value(stmt, ctx);
    bind_core_text_block_value(
      stmt.name,
      value,
      stmt.annotation,
      ctx,
      hooks,
      check_text,
    );
    hooks.bind_core_fn_type(stmt.name, value, ctx);
    hooks.bind_core_struct_type(
      stmt.name,
      value,
      stmt.annotation,
      ctx,
    );
    hooks.bind_core_union_type(
      stmt.name,
      value,
      stmt.annotation,
      ctx,
    );
    return;
  }

  if (stmt.tag === "assign") {
    const value = hooks.core_assignment_value(stmt, ctx);
    bind_core_text_block_value(
      stmt.name,
      value,
      undefined,
      ctx,
      hooks,
      check_text,
    );
    hooks.bind_core_fn_type(stmt.name, value, ctx);
    hooks.bind_core_assignment_struct_type(
      stmt.name,
      value,
      stmt.mode,
      ctx,
    );
    hooks.bind_core_assignment_union_type(
      stmt.name,
      value,
      stmt.mode,
      ctx,
    );
  }
}

function bind_core_text_block_value<ctx extends CoreTextFactCtx>(
  name: string,
  value: CoreExpr,
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): void {
  const text_value = hooks.static_text_value(value, ctx);

  if (text_value) {
    ctx.locals.delete(name);
    ctx.statics.set(name, text_value);
    ctx.text_locals.delete(name);
    return;
  }

  ctx.statics.delete(name);

  if (annotation) {
    const type = core_val_type_from_type_name(annotation);

    if (type) {
      set_local(ctx.locals, name, type);
    }
  }

  if (check_text(value, ctx, hooks)) {
    set_local(ctx.locals, name, "i32");
    ctx.text_locals.add(name);
    return;
  }

  if (value.tag === "num") {
    set_local(ctx.locals, name, value.type);
  }

  if (value.tag === "var" || value.tag === "linear") {
    const type = ctx.locals.get(value.name);

    if (type) {
      set_local(ctx.locals, name, type);
    }
  }

  if (value.tag === "prim" || value.tag === "index") {
    set_local(ctx.locals, name, hooks.expr_type(value, ctx));
  }

  ctx.text_locals.delete(name);
}

function clone_core_text_fact_ctx<ctx extends CoreTextFactCtx>(ctx: ctx): ctx {
  return {
    ...ctx,
    locals: new Map(ctx.locals),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
  };
}
