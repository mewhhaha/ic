import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type {
  Env,
  Field,
  FrontExpr,
  FrontType,
  Stmt,
  TypeField,
} from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { is_object_type_expr } from "./fields.ts";
import type { StructValueTarget } from "./struct_values.ts";
import {
  indexed_result_type_from_fields,
  indexed_type_fields_are_bool,
} from "./runtime_struct.ts";
import { val_type_from_type_name } from "./types.ts";

export type IndexAssignmentHooks = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  indexed_result_type: (target: StructValueTarget) => ValType;
  indexed_values_are_text: (target: StructValueTarget) => boolean;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  prepare_runtime_value: (expr: FrontExpr, env: Env) => FrontExpr;
  resolve_numeric_expr_type: (
    expr: FrontExpr,
    env: Env,
  ) => ValType | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) => StructValueTarget | undefined;
  resolve_struct_value_type_fields: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => TypeField[] | undefined;
  validate_struct_value: (
    value: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => void;
};

export function apply_index_assignment(
  stmt: Extract<Stmt, { tag: "index_assign" }>,
  env: Env,
  hooks: IndexAssignmentHooks,
): FrontExpr {
  const target = hooks.resolve_struct_value(
    { tag: "var", name: stmt.name },
    env,
  );

  if (!target) {
    const runtime_value = apply_runtime_struct_index_assignment(
      stmt,
      env,
      hooks,
    );

    if (runtime_value) {
      return runtime_value;
    }

    throw new Error(
      "Cannot lower index update to Ic frontend yet: " + stmt.name +
        structured_core_route,
    );
  }

  const fields: Field[] = [];
  const index = hooks.resolve_static_i32_expr(stmt.index, env);
  const value = hooks.prepare_runtime_value(stmt.value, env);

  if (index !== undefined) {
    if (index < 0 || index >= target.expr.fields.length) {
      throw new Error("Index out of bounds: " + index.toString());
    }

    for (let pos = 0; pos < target.expr.fields.length; pos += 1) {
      const field = target.expr.fields[pos];
      expect(field, "Missing indexed update field " + pos);

      if (pos === index) {
        fields.push({ name: field.name, value });
      } else {
        fields.push({
          name: field.name,
          value: hooks.capture_expr(field.value, target.env),
        });
      }
    }

    return checked_index_assignment_value(
      {
        tag: "struct_value",
        type_expr: hooks.capture_expr(target.expr.type_expr, target.env),
        fields,
        bracketed: target.expr.bracketed,
      },
      env,
      hooks,
    );
  }

  const result_type = hooks.indexed_result_type(target);
  const field_types = hooks.resolve_struct_value_type_fields(
    target.expr,
    target.env,
  );
  let text_update = hooks.indexed_values_are_text(target);
  let bool_update = false;

  if (field_types && indexed_type_fields_are_text(field_types)) {
    text_update = true;
  }

  if (field_types && indexed_type_fields_are_bool(field_types)) {
    bool_update = true;
  }

  const value_type = hooks.infer_expr(value, env);

  if (bool_update && value_type.tag !== "bool") {
    throw new Error("Bool index update requires Bool value");
  }

  if (
    text_update && value_type.tag !== "text" && value_type.tag !== "unknown"
  ) {
    throw new Error("Text index update requires Text value");
  }

  for (let pos = 0; pos < target.expr.fields.length; pos += 1) {
    const field = target.expr.fields[pos];
    expect(field, "Missing indexed update field " + pos);
    const cond: FrontExpr = {
      tag: "prim",
      prim: "i32.eq",
      left: stmt.index,
      right: { tag: "num", type: "i32", value: pos },
    };
    const old_value = hooks.capture_expr(field.value, target.env);
    const old_type = hooks.resolve_numeric_expr_type(old_value, env);
    const next_type = hooks.resolve_numeric_expr_type(value, env);

    if (!text_update && !bool_update) {
      if (value_type.tag === "text") {
        throw new Error("Index update value must be numeric");
      }

      if (
        result_type === "i64" || old_type === "i64" ||
        next_type === "i64"
      ) {
        if (old_type !== "i64" || next_type !== "i64") {
          throw new Error("Mixed i32 and i64 index update values");
        }
      }
    }

    fields.push({
      name: field.name,
      value: {
        tag: "if",
        cond,
        then_branch: value,
        else_branch: old_value,
      },
    });
  }

  return checked_index_assignment_value(
    {
      tag: "struct_value",
      type_expr: hooks.capture_expr(target.expr.type_expr, target.env),
      fields,
      bracketed: target.expr.bracketed,
    },
    env,
    hooks,
  );
}

function checked_index_assignment_value(
  value: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: IndexAssignmentHooks,
): FrontExpr {
  if (is_object_type_expr(value.type_expr)) {
    return value;
  }

  hooks.validate_struct_value(value, env);
  return value;
}

function apply_runtime_struct_index_assignment(
  stmt: Extract<Stmt, { tag: "index_assign" }>,
  env: Env,
  hooks: IndexAssignmentHooks,
): FrontExpr | undefined {
  const runtime_target = hooks.resolve_runtime_struct_type({
    tag: "var",
    name: stmt.name,
  }, env);

  if (!runtime_target) {
    return undefined;
  }

  const fields: Field[] = [];
  const index = hooks.resolve_static_i32_expr(stmt.index, env);
  const value = hooks.prepare_runtime_value(stmt.value, env);
  const type_expr: FrontExpr = {
    tag: "struct_type",
    fields: runtime_target.fields,
  };

  if (index !== undefined) {
    if (index < 0 || index >= runtime_target.fields.length) {
      throw new Error("Index out of bounds: " + index.toString());
    }

    for (let pos = 0; pos < runtime_target.fields.length; pos += 1) {
      const field = runtime_target.fields[pos];
      expect(field, "Missing runtime indexed update field " + pos);

      if (pos === index) {
        fields.push({ name: field.name, value });
      } else {
        fields.push({
          name: field.name,
          value: runtime_struct_field_expr(stmt.name, field.name),
        });
      }
    }

    const result: FrontExpr = { tag: "struct_value", type_expr, fields };
    expect(result.tag === "struct_value", "Expected runtime index update");
    hooks.validate_struct_value(result, env);
    return result;
  }

  const result_type = indexed_result_type_from_fields(runtime_target.fields);
  const next_type = hooks.resolve_numeric_expr_type(value, env);
  const text_update = indexed_type_fields_are_text(runtime_target.fields);
  const bool_update = indexed_type_fields_are_bool(runtime_target.fields);
  const value_type = hooks.infer_expr(value, env);

  if (bool_update && value_type.tag !== "bool") {
    throw new Error("Bool index update requires Bool value");
  }

  if (text_update && value_type.tag !== "text") {
    throw new Error("Text index update requires Text value");
  }

  if (!text_update && !bool_update && value_type.tag === "text") {
    throw new Error("Index update value must be numeric");
  }

  if (!text_update && !bool_update && next_type && result_type !== next_type) {
    throw new Error("Mixed i32 and i64 index update values");
  }

  for (let pos = 0; pos < runtime_target.fields.length; pos += 1) {
    const field = runtime_target.fields[pos];
    expect(field, "Missing runtime indexed update field " + pos);

    if (!text_update && !bool_update) {
      const field_type = val_type_from_type_name(field.type_name);
      expect(
        field_type,
        "Cannot lower dynamic index update for non-numeric field: " +
          field.name,
      );

      if (next_type && field_type !== next_type) {
        throw new Error("Mixed i32 and i64 index update values");
      }
    }

    fields.push({
      name: field.name,
      value: {
        tag: "if",
        cond: {
          tag: "prim",
          prim: "i32.eq",
          left: stmt.index,
          right: { tag: "num", type: "i32", value: pos },
        },
        then_branch: value,
        else_branch: runtime_struct_field_expr(stmt.name, field.name),
      },
    });
  }

  const result: FrontExpr = { tag: "struct_value", type_expr, fields };
  expect(result.tag === "struct_value", "Expected runtime index update");
  hooks.validate_struct_value(result, env);
  return result;
}

function runtime_struct_field_expr(name: string, field: string): FrontExpr {
  return {
    tag: "field",
    object: { tag: "var", name },
    name: field,
  };
}

function indexed_type_fields_are_text(fields: TypeField[]): boolean {
  if (fields.length === 0) {
    return false;
  }

  for (const field of fields) {
    if (field.type_name !== "Text") {
      return false;
    }
  }

  return true;
}
