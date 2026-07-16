import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType } from "./ast.ts";
import { set_local } from "./emit/local.ts";

export type CoreIfLetPayloadCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type CoreIfLetPayloadFactHooks<
  ctx extends CoreIfLetPayloadCtx,
> = {
  clear_core_local_facts: (name: string, ctx: ctx) => void;
  core_expr_is_text: (value: CoreExpr, ctx: ctx) => boolean;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type CoreIfLetPayloadEmitHooks<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
> = CoreIfLetPayloadFactHooks<ctx> & {
  branch_payload_ctx: (ctx: emit_ctx) => emit_ctx;
  emit_expr: (expr: CoreExpr, ctx: emit_ctx) => Wat;
};

export function bind_core_if_let_payload<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
>(
  value_name: string | undefined,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: emit_ctx,
  hooks: CoreIfLetPayloadEmitHooks<ctx, emit_ctx>,
): { setup: Wat; ctx: emit_ctx } {
  if (!value_name) {
    return { setup: "", ctx };
  }

  const value = union_case.value;
  expect(value, "Core if let payload binding requires a payload");

  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    const branch_ctx = branch_static_payload_ctx(
      value_name,
      struct_value,
      ctx,
      hooks,
    );
    return { setup: "", ctx: branch_ctx };
  }

  const aggregate_type = hooks.runtime_aggregate_type_expr(value, ctx);

  if (aggregate_type) {
    const branch_ctx = branch_aggregate_payload_ctx(
      value_name,
      aggregate_type,
      ctx,
      hooks,
    );
    return {
      setup: hooks.emit_expr(value, ctx) + "\nlocal.set $" + value_name,
      ctx: branch_ctx,
    };
  }

  const union_type = hooks.runtime_union_type_expr(value, ctx);

  if (union_type) {
    const branch_ctx = branch_union_payload_ctx(
      value_name,
      union_type,
      ctx,
      hooks,
    );
    return {
      setup: hooks.emit_expr(value, ctx) + "\nlocal.set $" + value_name,
      ctx: branch_ctx,
    };
  }

  if (hooks.core_expr_is_text(value, ctx)) {
    const branch_ctx = branch_text_payload_ctx(value_name, ctx, hooks);
    return {
      setup: hooks.emit_expr(value, ctx) + "\nlocal.set $" + value_name,
      ctx: branch_ctx,
    };
  }

  const branch_ctx = hooks.branch_payload_ctx(ctx);
  branch_ctx.statics.delete(value_name);
  hooks.clear_core_local_facts(value_name, branch_ctx);

  return {
    setup: hooks.emit_expr(value, ctx) + "\nlocal.set $" + value_name,
    ctx: branch_ctx,
  };
}

export function bind_core_if_let_payload_fact<
  ctx extends CoreIfLetPayloadCtx,
>(
  value_name: string | undefined,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreIfLetPayloadFactHooks<ctx>,
): void {
  if (!value_name) {
    return;
  }

  const value = union_case.value;
  expect(value, "Core if let payload binding requires a payload");

  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    ctx.locals.delete(value_name);
    ctx.statics.set(value_name, struct_value);
    hooks.clear_core_local_facts(value_name, ctx);
    return;
  }

  const aggregate_type = hooks.runtime_aggregate_type_expr(value, ctx);

  if (aggregate_type) {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.set(value_name, aggregate_type);
    ctx.union_locals.delete(value_name);
    return;
  }

  const union_type = hooks.runtime_union_type_expr(value, ctx);

  if (union_type) {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.delete(value_name);
    ctx.union_locals.set(value_name, union_type);
    return;
  }

  ctx.statics.delete(value_name);
  ctx.fn_types.delete(value_name);
  ctx.struct_locals.delete(value_name);
  ctx.union_locals.delete(value_name);
  set_local(ctx.locals, value_name, hooks.expr_type(value, ctx));

  if (hooks.core_expr_is_text(value, ctx)) {
    ctx.text_locals.add(value_name);
  } else {
    ctx.text_locals.delete(value_name);
  }
}

function branch_static_payload_ctx<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
>(
  value_name: string,
  value: CoreExpr,
  ctx: emit_ctx,
  hooks: CoreIfLetPayloadEmitHooks<ctx, emit_ctx>,
): emit_ctx {
  const branch_ctx = hooks.branch_payload_ctx(ctx);
  branch_ctx.statics.set(value_name, value);
  hooks.clear_core_local_facts(value_name, branch_ctx);
  return branch_ctx;
}

function branch_aggregate_payload_ctx<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
>(
  value_name: string,
  aggregate_type: CoreExpr,
  ctx: emit_ctx,
  hooks: CoreIfLetPayloadEmitHooks<ctx, emit_ctx>,
): emit_ctx {
  const branch_ctx = hooks.branch_payload_ctx(ctx);
  branch_ctx.statics.delete(value_name);
  branch_ctx.fn_types.delete(value_name);
  branch_ctx.text_locals.delete(value_name);
  branch_ctx.struct_locals.set(value_name, aggregate_type);
  branch_ctx.union_locals.delete(value_name);
  return branch_ctx;
}

function branch_union_payload_ctx<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
>(
  value_name: string,
  union_type: CoreExpr,
  ctx: emit_ctx,
  hooks: CoreIfLetPayloadEmitHooks<ctx, emit_ctx>,
): emit_ctx {
  const branch_ctx = hooks.branch_payload_ctx(ctx);
  branch_ctx.statics.delete(value_name);
  branch_ctx.fn_types.delete(value_name);
  branch_ctx.text_locals.delete(value_name);
  branch_ctx.struct_locals.delete(value_name);
  branch_ctx.union_locals.set(value_name, union_type);
  return branch_ctx;
}

function branch_text_payload_ctx<
  ctx extends CoreIfLetPayloadCtx,
  emit_ctx extends ctx,
>(
  value_name: string,
  ctx: emit_ctx,
  hooks: CoreIfLetPayloadEmitHooks<ctx, emit_ctx>,
): emit_ctx {
  const branch_ctx = hooks.branch_payload_ctx(ctx);
  branch_ctx.statics.delete(value_name);
  branch_ctx.fn_types.delete(value_name);
  branch_ctx.struct_locals.delete(value_name);
  branch_ctx.union_locals.delete(value_name);
  branch_ctx.text_locals.add(value_name);
  return branch_ctx;
}
