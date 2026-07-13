import type { Env, Field, FrontExpr, FrontType } from "./ast.ts";
import { front_type_from_type_name } from "./types.ts";

export type ImplicitFallbackHooks = {
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export function can_implicit_fallback_type(type: FrontType): boolean {
  if (type.tag === "bool" || type.tag === "int" || type.tag === "text") {
    return true;
  }

  if (type.tag === "struct" && type.field_types) {
    return true;
  }

  return type.tag === "union_value";
}

export function implicit_fallback_expr(
  type: FrontType,
  env: Env,
  hooks: ImplicitFallbackHooks,
): FrontExpr | undefined {
  if (type.tag === "bool") {
    return { tag: "bool", value: false };
  }

  if (type.tag === "int") {
    if (type.type === "i64") {
      return { tag: "num", type: "i64", value: 0n };
    }

    return { tag: "num", type: "i32", value: 0 };
  }

  if (type.tag === "text") {
    return { tag: "text", value: "" };
  }

  if (type.tag === "struct") {
    if (!type.field_types) {
      return undefined;
    }

    const fields: Field[] = [];

    for (const field of type.field_types) {
      const value = implicit_fallback_type_name_expr(
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

  if (type.tag === "union_value") {
    for (const union_case of type.cases) {
      if (union_case.type_name === "Unit") {
        return {
          tag: "union_case",
          name: union_case.name,
          value: undefined,
          type_expr: { tag: "union_type", cases: type.cases },
        };
      }

      const value = implicit_fallback_type_name_expr(
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
  }

  return undefined;
}

function implicit_fallback_type_name_expr(
  type_name: string,
  env: Env,
  hooks: ImplicitFallbackHooks,
): FrontExpr | undefined {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return implicit_fallback_expr(resolved, env, hooks);
  }

  return implicit_fallback_expr(
    front_type_from_type_name(type_name),
    env,
    hooks,
  );
}
