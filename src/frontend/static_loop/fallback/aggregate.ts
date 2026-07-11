import type { Field, FrontExpr } from "../../ast.ts";
import { capture_expr } from "../../capture.ts";
import type { StaticLoopHooks } from "../types.ts";
import { dynamic_loop_control_struct_field_type } from "./field.ts";
import type {
  DynamicLoopBindingFallback,
  DynamicLoopStructTarget,
  DynamicLoopUnionTarget,
} from "./types.ts";

export type { DynamicLoopBindingFallback } from "./types.ts";
export { dynamic_loop_control_guarded_binding_value } from "./guarded.ts";
export { dynamic_loop_control_type_fallback } from "./type_fallback.ts";

export function dynamic_loop_control_struct_fallback(
  name: string,
  target: DynamicLoopStructTarget,
  hooks: StaticLoopHooks,
  binding_fallback: DynamicLoopBindingFallback,
): Extract<FrontExpr, { tag: "struct_value" }> {
  const fields: Field[] = [];

  for (const field of target.expr.fields) {
    const field_type = dynamic_loop_control_struct_field_type(
      field,
      target,
      hooks,
    );
    fields.push({
      name: field.name,
      value: binding_fallback(
        name + "." + field.name,
        field_type,
        field.value,
        target.env,
        hooks,
      ),
    });
  }

  return {
    tag: "struct_value",
    type_expr: capture_expr(target.expr.type_expr, target.env),
    fields,
    bracketed: target.expr.bracketed,
  };
}

export function dynamic_loop_control_union_fallback(
  name: string,
  target: DynamicLoopUnionTarget,
  hooks: StaticLoopHooks,
  binding_fallback: DynamicLoopBindingFallback,
): Extract<FrontExpr, { tag: "union_case" }> {
  let value: FrontExpr | undefined;

  if (target.expr.value) {
    const payload_type = hooks.infer_expr(target.expr.value, target.env);
    value = binding_fallback(
      name + "." + target.expr.name,
      payload_type,
      target.expr.value,
      target.env,
      hooks,
    );
  }

  return {
    tag: "union_case",
    name: target.expr.name,
    value,
    type_expr: target.expr.type_expr
      ? capture_expr(target.expr.type_expr, target.env)
      : undefined,
  };
}
