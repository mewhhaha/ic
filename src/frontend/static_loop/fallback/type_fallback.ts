import type { Env, Field, FrontExpr, FrontType } from "../../ast.ts";
import { front_type_from_type_name } from "../../types.ts";
import type { StaticLoopHooks } from "../types.ts";

export function dynamic_loop_control_type_fallback(
  name: string,
  type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  if (type.tag === "bool") {
    return { tag: "bool", value: false };
  }

  if (type.tag === "int") {
    if (type.type === "i64") {
      return { tag: "num", type: "i64", value: 0n };
    }

    if (type.type === "i32") {
      return { tag: "num", type: "i32", value: 0 };
    }

    return undefined;
  }

  if (type.tag === "text") {
    return { tag: "text", value: "" };
  }

  if (type.tag === "struct") {
    return dynamic_loop_control_struct_type_fallback(name, type, env, hooks);
  }

  if (type.tag === "union_value") {
    return dynamic_loop_control_union_type_fallback(name, type, env, hooks);
  }

  return undefined;
}

export function dynamic_loop_control_type_name_fallback(
  name: string,
  type_name: string,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return dynamic_loop_control_type_fallback(name, resolved, env, hooks);
  }

  return dynamic_loop_control_type_fallback(
    name,
    front_type_from_type_name(type_name),
    env,
    hooks,
  );
}

function dynamic_loop_control_struct_type_fallback(
  name: string,
  type: Extract<FrontType, { tag: "struct" }>,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "struct_value" }> | undefined {
  if (!type.field_types) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const field of type.field_types) {
    const value = dynamic_loop_control_type_name_fallback(
      name + "." + field.name,
      field.type_name,
      env,
      hooks,
    );

    if (!value) {
      return undefined;
    }

    fields.push({ name: field.name, value });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "struct_type", fields: type.field_types },
    fields,
  };
}

function dynamic_loop_control_union_type_fallback(
  name: string,
  type: Extract<FrontType, { tag: "union_value" }>,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "union_case" }> | undefined {
  for (const union_case of type.cases) {
    if (union_case.type_name === "Unit") {
      return {
        tag: "union_case",
        name: union_case.name,
        value: undefined,
        type_expr: { tag: "union_type", cases: type.cases },
      };
    }

    const value = dynamic_loop_control_type_name_fallback(
      name + "." + union_case.name,
      union_case.type_name,
      env,
      hooks,
    );

    if (value) {
      return {
        tag: "union_case",
        name: union_case.name,
        value,
        type_expr: { tag: "union_type", cases: type.cases },
      };
    }
  }

  return undefined;
}
