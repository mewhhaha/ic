import { expect } from "../../expect.ts";
import type { Env, FrontExpr, FrontType } from "../ast.ts";
import type { StaticRecHooks } from "../rec_hooks.ts";
import type { RecExprInfer } from "./types.ts";
import {
  lookup_rec_type_field,
  rec_front_type_for_type_name,
} from "../rec_util.ts";
import { dynamic_index_type_from_fields } from "../runtime_struct.ts";

export function infer_rec_field_expr(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: StaticRecHooks,
  infer_rec_expr: RecExprInfer,
): FrontType | undefined {
  const field = hooks.resolve_struct_field_expr(expr, env);

  if (field) {
    return infer_rec_expr(field.expr, field.env, hooks);
  }

  const object_type = infer_rec_expr(expr.object, env, hooks);

  if (object_type.tag !== "struct" || !object_type.field_types) {
    return undefined;
  }

  const field_type = lookup_rec_type_field(object_type.field_types, expr.name);

  if (!field_type) {
    throw new Error("Missing struct field: " + expr.name);
  }

  return rec_front_type_for_type_name(field_type.type_name, env, hooks);
}

export function infer_rec_index_expr(
  expr: Extract<FrontExpr, { tag: "index" }>,
  env: Env,
  hooks: StaticRecHooks,
  infer_rec_expr: RecExprInfer,
): FrontType | undefined {
  const static_index = hooks.resolve_static_i32_expr(expr.index, env);

  if (static_index !== undefined) {
    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      return infer_rec_expr(item.expr, item.env, hooks);
    }
  }

  const object_type = infer_rec_expr(expr.object, env, hooks);

  if (object_type.tag !== "struct" || !object_type.field_types) {
    return undefined;
  }

  if (static_index !== undefined) {
    if (static_index < 0 || static_index >= object_type.field_types.length) {
      throw new Error("Index out of bounds: " + static_index.toString());
    }

    const field = object_type.field_types[static_index];
    expect(field, "Missing indexed field " + static_index.toString());
    return rec_front_type_for_type_name(field.type_name, env, hooks);
  }

  return dynamic_index_type_from_fields(object_type.field_types);
}
