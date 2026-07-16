import type { CoreExpr } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import { record_core_expr_provenance } from "../subject_provenance.ts";
import { static_block_result } from "../type_static.ts";
import type {
  StaticValueCtx,
  StaticValueHooks,
  StaticValuePlan,
} from "./types.ts";

export function plan_static_capture_expr<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  prefix: string,
  value: CoreExpr,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
  frozen = false,
): StaticValuePlan {
  if (hooks.is_stable_static_expr(value)) {
    return { value, setup: "" };
  }

  const type = hooks.expr_type(value, ctx);
  const name = fresh_temp_local(ctx, prefix);
  set_local(ctx.locals, name, type);

  if (hooks.core_expr_is_text(value, ctx)) {
    ctx.text_locals.add(name);
  } else {
    ctx.text_locals.delete(name);
  }

  if (ctx.frozen_locals) {
    if (frozen || static_capture_is_frozen(value, ctx, hooks)) {
      ctx.frozen_locals.add(name);
    } else {
      ctx.frozen_locals.delete(name);
    }
  }

  const struct_type = hooks.runtime_aggregate_type_expr(value, ctx);

  if (struct_type) {
    ctx.struct_locals.set(name, struct_type);
  } else {
    ctx.struct_locals.delete(name);
  }

  const union_type = hooks.runtime_union_type_expr(value, ctx);

  if (union_type) {
    ctx.union_locals.set(name, union_type);
  } else {
    ctx.union_locals.delete(name);
  }

  const planned_value: CoreExpr = record_core_expr_provenance(
    { tag: "var", name },
    value,
  );
  const setup: string[] = [];

  if (emit_ctx) {
    setup.push(hooks.emit_expr(value, emit_ctx));
    setup.push("local.set $" + name);
  } else {
    hooks.collect_expr_locals(value, ctx);
    if (ctx.static_capture_values) {
      ctx.static_capture_values.set(name, value);
    }
  }

  return { value: planned_value, setup: setup.join("\n") };
}

function static_capture_is_frozen<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): boolean {
  if (value.tag === "freeze") {
    return true;
  }

  if (!hooks.frozen_local) {
    return false;
  }

  if (value.tag === "var") {
    return hooks.frozen_local(value.name, ctx);
  }

  if (value.tag === "field") {
    return static_field_source_is_frozen(value.object, ctx, hooks);
  }

  return false;
}

function static_field_source_is_frozen<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): boolean {
  if (value.tag === "freeze") {
    return true;
  }

  if (value.tag === "field") {
    return static_field_source_is_frozen(value.object, ctx, hooks);
  }

  if (value.tag === "borrow") {
    return static_field_source_is_frozen(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return static_field_source_is_frozen(value.body, ctx, hooks);
  }

  const block_value = static_block_result(value);

  if (block_value) {
    return static_field_source_is_frozen(block_value, ctx, hooks);
  }

  if (value.tag !== "var") {
    return false;
  }

  if (hooks.frozen_local && hooks.frozen_local(value.name, ctx)) {
    return true;
  }

  const static_value = ctx.statics.get(value.name);

  if (!static_value) {
    return false;
  }

  if (static_value.tag === "freeze") {
    return true;
  }

  return static_field_source_is_frozen(static_value, ctx, hooks);
}

export function static_value_source_is_frozen<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): boolean {
  if (value.tag === "freeze") {
    return true;
  }

  if (value.tag === "borrow" || value.tag === "scratch") {
    return static_capture_is_frozen(value, ctx, hooks);
  }

  if (value.tag === "field") {
    return static_field_source_is_frozen(value.object, ctx, hooks);
  }

  if (value.tag !== "var") {
    return false;
  }

  if (hooks.frozen_local && hooks.frozen_local(value.name, ctx)) {
    return true;
  }

  const static_value = ctx.statics.get(value.name);

  if (!static_value) {
    return false;
  }

  return static_value_source_is_frozen(static_value, ctx, hooks);
}
