import type { CoreExpr } from "../ast.ts";
import { is_type_level_expr, resolve_core_type_name } from "../type_static.ts";
import type { CoreTypeCheckCtx, CoreTypeCheckHooks } from "./types.ts";

export function core_binding_value_type_name<ctx extends CoreTypeCheckCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): string {
  if (value.tag === "num" && value.character !== undefined) {
    return "Char";
  }

  if (is_type_level_expr(value)) {
    return "Type";
  }

  if (static_type_level_value_or_runtime_call(value, ctx, hooks)) {
    return "Type";
  }

  if (hooks.core_expr_is_text(value, ctx)) {
    return "Text";
  }

  if (hooks.static_text_value(value, ctx)) {
    return "Text";
  }

  if (hooks.core_expr_has_runtime_text_fact(value, ctx)) {
    return "Text";
  }

  if (hooks.core_runtime_text_concat_operands(value, ctx)) {
    return "Text";
  }

  if (value.tag === "var" && ctx.text_locals.has(value.name)) {
    return "Text";
  }

  if (value.tag === "if") {
    const then_type = core_binding_value_type_name(
      value.then_branch,
      ctx,
      hooks,
    );
    const else_type = core_binding_value_type_name(
      value.else_branch,
      ctx,
      hooks,
    );

    if (then_type === "Text" && else_type === "Text") {
      return "Text";
    }
  }

  const value_type = hooks.expr_type(value, ctx);

  if (value_type === "i32") {
    return "I32";
  }

  if (value_type === "i64") {
    return "I64";
  }

  if (value_type === "f32") {
    return "F32";
  }

  if (value_type === "f64") {
    return "F64";
  }

  if (value_type === "v128") {
    return "F32x4";
  }

  value_type satisfies never;
  throw new Error("@panic");
}

function static_type_level_value_or_runtime_call<
  ctx extends CoreTypeCheckCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): CoreExpr | undefined {
  try {
    return hooks.static_type_level_value(value, ctx);
  } catch (error) {
    if (ordinary_static_call_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

export function ordinary_static_call_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Core type constructor expects ")) {
    return true;
  }

  if (error.message.startsWith("Core type constructor argument ")) {
    if (error.message.endsWith(" must resolve to a type name")) {
      return true;
    }
  }

  return false;
}

export function static_annotation_type_value<
  ctx extends CoreTypeCheckCtx,
>(
  annotation: string,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
) {
  return hooks.static_type_value({ tag: "var", name: annotation }, ctx);
}

export function core_direct_annotation_actual_name<
  ctx extends CoreTypeCheckCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTypeCheckHooks<ctx>,
): string {
  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    return "struct";
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    return "union";
  }

  const union_if = hooks.dynamic_union_if(value, ctx);

  if (union_if) {
    return "union";
  }

  return core_binding_value_type_name(value, ctx, hooks);
}

export function resolved_type_name<ctx extends CoreTypeCheckCtx>(
  type_name: string,
  ctx: ctx,
): string {
  return resolve_core_type_name(type_name, ctx);
}
