import type { Env, FrontExpr, FrontType } from "../ast.ts";
import { dynamic_index_type_from_fields } from "../runtime_struct.ts";
import {
  infer_runtime_struct_field_type,
  runtime_struct_index_type,
} from "./runtime_struct.ts";
import type { InferExprFn, InferHooks } from "./types.ts";

export function infer_field_type(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): FrontType {
  const field = hooks.resolve_struct_field_expr(expr, env);

  if (field) {
    const field_type = infer_expr(field.expr, field.env, hooks);

    if (field_type.tag !== "unknown") {
      return field_type;
    }
  }

  const runtime_field_type = infer_runtime_struct_field_type(
    expr,
    env,
    hooks,
  );

  if (runtime_field_type) {
    return runtime_field_type;
  }

  return { tag: "unknown" };
}

export function infer_index_type(
  expr: Extract<FrontExpr, { tag: "index" }>,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): FrontType {
  const static_index = hooks.resolve_static_i32_expr(expr.index, env);

  if (static_index !== undefined) {
    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      const item_type = infer_expr(item.expr, item.env, hooks);

      if (item_type.tag !== "unknown") {
        return item_type;
      }

      const runtime_target = hooks.resolve_runtime_struct_type(
        expr.object,
        env,
      );

      if (runtime_target) {
        return runtime_struct_index_type(
          runtime_target.fields,
          static_index,
          env,
          hooks,
        );
      }

      return item_type;
    }
  }

  const runtime_target = hooks.resolve_runtime_struct_type(
    expr.object,
    env,
  );

  if (runtime_target) {
    if (static_index !== undefined) {
      return runtime_struct_index_type(
        runtime_target.fields,
        static_index,
        env,
        hooks,
      );
    }

    return dynamic_index_type_from_fields(runtime_target.fields);
  }

  const text = hooks.visible_text_value(expr.object, env, new Set());

  if (text) {
    return { tag: "int", type: "i32" };
  }

  const object_type = infer_expr(expr.object, env, hooks);

  if (object_type.tag === "text") {
    return { tag: "int", type: "i32" };
  }

  return { tag: "unknown" };
}
