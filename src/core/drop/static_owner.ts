import type { CoreDropHooks, CoreExpr, CoreFnType } from "./types.ts";
import { static_core_call_binding_target } from "../static_call.ts";

export function should_skip_drop_owner_bind<ctx>(
  kind: "let" | "const",
  name: string,
  _annotation: string | undefined,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  if (hooks.mutable_binding && hooks.mutable_binding(name, ctx)) {
    return false;
  }
  const static_value = drop_static_value(expr, ctx, hooks);

  if (!static_value) {
    return false;
  }

  if (static_value.tag === "union_case" && static_value.resume_payload) {
    return false;
  }

  if (
    hooks.materialized_static_owner &&
    (hooks.materialized_static_owner(static_value, ctx) ||
      hooks.materialized_static_owner(expr, ctx))
  ) {
    return false;
  }

  if (
    kind === "let" && drop_owner_ctx_materializes(name, ctx) &&
    expr.tag !== "scratch" &&
    !drop_owner_ctx_is_scratch(ctx) &&
    materialized_static_owner_value(static_value)
  ) {
    return false;
  }

  if (kind === "const") {
    return true;
  }

  if (is_drop_static_ownerless_value(static_value)) {
    return true;
  }

  if (is_static_drop_helper(name, static_value, ctx, hooks)) {
    return true;
  }

  return is_drop_static_non_runtime_closure(static_value, ctx, hooks);
}

function materialized_static_owner_value(value: CoreExpr): boolean {
  if (value.tag === "union_case") {
    return value.type_expr !== undefined;
  }

  if (value.tag !== "struct_value") {
    return false;
  }

  return !(value.type_expr.tag === "var" &&
    value.type_expr.name === "object_type");
}

export function drop_owner_ctx_is_scratch(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null) {
    return false;
  }
  if (!("scratch_depth" in ctx)) {
    return false;
  }
  const depth = ctx.scratch_depth;
  return typeof depth === "number" && depth > 0;
}

function drop_owner_ctx_materializes(name: string, ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null) {
    return false;
  }
  if (!("materialized_bindings" in ctx)) {
    return false;
  }
  const bindings = ctx.materialized_bindings;
  return bindings instanceof Set && bindings.has(name);
}

export function should_skip_drop_owner_assign<ctx>(
  name: string,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  if (hooks.mutable_binding && hooks.mutable_binding(name, ctx)) {
    return false;
  }
  const static_value = drop_static_value(expr, ctx, hooks);

  if (!static_value) {
    return false;
  }

  if (static_value.tag === "union_case" && static_value.resume_payload) {
    return false;
  }

  if (
    hooks.materialized_static_owner &&
    (hooks.materialized_static_owner(static_value, ctx) ||
      hooks.materialized_static_owner(expr, ctx))
  ) {
    return false;
  }

  if (is_drop_static_ownerless_value(static_value)) {
    return true;
  }

  if (is_static_drop_helper(name, static_value, ctx, hooks)) {
    return true;
  }

  return is_drop_static_non_runtime_closure(static_value, ctx, hooks);
}

export function drop_static_value<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): CoreExpr | undefined {
  if (!hooks.static_value) {
    return undefined;
  }

  return hooks.static_value(expr, ctx);
}

export function is_drop_static_ownerless_value(expr: CoreExpr): boolean {
  if (is_drop_static_type_value(expr)) {
    return true;
  }

  if (expr.tag === "text") {
    return true;
  }

  if (expr.tag === "struct_value") {
    return true;
  }

  if (expr.tag === "struct_update") {
    return true;
  }

  if (expr.tag === "union_case") {
    return true;
  }

  if (expr.tag === "with") {
    return true;
  }

  if (expr.tag === "if") {
    return true;
  }

  return false;
}

export function is_drop_static_non_runtime_closure<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  if (expr.tag === "rec") {
    return true;
  }

  if (expr.tag !== "lam") {
    return false;
  }

  let fn_type: CoreFnType | undefined;

  try {
    fn_type = hooks.closure_fn_type(expr, ctx);
  } catch (error) {
    if (drop_closure_probe_error(error)) {
      return true;
    }

    throw error;
  }

  if (fn_type) {
    return false;
  }

  return true;
}

function is_drop_static_type_value(expr: CoreExpr): boolean {
  if (expr.tag === "type_name") {
    return true;
  }

  if (expr.tag === "struct_type") {
    return true;
  }

  if (expr.tag === "union_type") {
    return true;
  }

  return false;
}

function is_static_drop_helper<ctx>(
  name: string,
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
): boolean {
  return static_core_call_binding_target(name, expr, ctx, hooks);
}

function drop_closure_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Core first-class closure parameter must use a scalar annotation:",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "Core runtime aggregate requires a static struct type",
    )
  ) {
    return true;
  }

  return false;
}
