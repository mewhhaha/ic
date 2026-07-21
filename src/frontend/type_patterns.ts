import { expect } from "../expect.ts";
import type {
  Env,
  FrontExpr,
  TypeExpr,
  TypeField,
  TypePattern,
} from "./ast.ts";
import { lookup } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import { is_builtin_type_name } from "./types.ts";

type TypePatternHooks = {
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
};

export function check_type_pattern(
  pattern: TypePattern,
  target: FrontExpr,
  env: Env,
  hooks: TypePatternHooks,
): void {
  const value = hooks.resolve_const_expr(target, env);
  expect(value, "Type pattern requires compile-time value");
  const type_value = resolve_extended_type_value(value, env, hooks);
  const expected_fields = substitute_type_fields(pattern.fields, env, hooks);
  let fields: TypeField[];
  let label: string;

  if (pattern.kind === "struct") {
    if (type_value.tag !== "struct_type") {
      throw new Error("Expected struct type value");
    }

    fields = type_value.fields;
    label = "Struct field";
  } else {
    if (type_value.tag !== "union_type") {
      throw new Error("Expected union type value");
    }

    fields = type_value.cases;
    label = "Union case";
  }

  for (const expected of expected_fields) {
    const actual = lookup_type_field(fields, expected.name);

    if (!actual) {
      if (pattern.kind === "struct") {
        throw new Error("Missing struct field: " + expected.name);
      }

      throw new Error("Missing union case: " + expected.name);
    }

    if (actual.type_name !== expected.type_name) {
      throw new Error(
        label + " " + expected.name + " expects " + expected.type_name +
          ", got " + actual.type_name,
      );
    }
  }

  if (!pattern.open && fields.length !== expected_fields.length) {
    if (pattern.kind === "struct") {
      throw new Error("Struct pattern does not allow extra fields");
    }

    throw new Error("Union pattern does not allow extra cases");
  }
}

export function resolve_extended_type_value(
  value: FrontExpr,
  env: Env,
  hooks: TypePatternHooks,
): FrontExpr {
  if (value.tag === "captured") {
    const resolved = hooks.resolve_const_expr(value.expr, value.env);
    expect(resolved, "Captured type value must be compile-time");
    return resolve_extended_type_value(resolved, value.env, hooks);
  }

  if (value.tag === "struct_type") {
    return {
      tag: "struct_type",
      fields: substitute_type_fields(value.fields, env, hooks),
    };
  }

  if (value.tag === "union_type") {
    return {
      tag: "union_type",
      cases: substitute_type_fields(value.cases, env, hooks),
    };
  }

  if (value.tag !== "with") {
    return value;
  }

  const base = hooks.resolve_const_expr(value.base, env);
  expect(base, "Extended type pattern base must be compile-time");
  return resolve_extended_type_value(base, env, hooks);
}

export function substitute_type_fields(
  fields: TypeField[],
  env: Env,
  hooks: TypePatternHooks,
): TypeField[] {
  return fields.map((field) => {
    const result: TypeField = {
      name: field.name,
      type_name: resolve_type_name(field.type_name, env, hooks),
    };

    if (field.set_member) {
      result.set_member = substitute_type_set_member(
        field.set_member,
        env,
        hooks,
      );
    }

    return result;
  });
}

function substitute_type_set_member(
  type: TypeExpr,
  env: Env,
  hooks: TypePatternHooks,
): TypeExpr {
  switch (type.tag) {
    case "forall":
      return {
        ...type,
        body: substitute_type_set_member(type.body, env, hooks),
      };

    case "name":
      return { tag: "name", name: resolve_type_name(type.name, env, hooks) };

    case "atom":
    case "literal":
    case "top":
    case "never":
      return type;

    case "frozen":
    case "borrow":
      return {
        ...type,
        value: substitute_type_set_member(type.value, env, hooks),
      };

    case "union":
    case "intersection":
    case "difference":
      return {
        ...type,
        left: substitute_type_set_member(type.left, env, hooks),
        right: substitute_type_set_member(type.right, env, hooks),
      };

    case "apply":
      return {
        tag: "apply",
        func: substitute_type_set_member(type.func, env, hooks),
        arg: substitute_type_set_member(type.arg, env, hooks),
      };

    case "tuple":
      return {
        tag: "tuple",
        items: type.items.map((item) =>
          substitute_type_set_member(item, env, hooks)
        ),
      };

    case "product":
      return {
        tag: "product",
        entries: type.entries.map((entry) => ({
          ...entry,
          type_expr: substitute_type_set_member(entry.type_expr, env, hooks),
        })),
      };

    case "array":
      return {
        ...type,
        element: substitute_type_set_member(type.element, env, hooks),
      };

    case "arrow":
      return {
        ...type,
        param: substitute_type_set_member(type.param, env, hooks),
        result: substitute_type_set_member(type.result, env, hooks),
      };
  }
}

function resolve_type_name(
  name: string,
  env: Env,
  hooks: TypePatternHooks,
): string {
  const parsed = parse_type_expr(tokenize(name));

  if (parsed.tag !== "name") {
    return format_type_expr(
      substitute_type_set_member(parsed, env, hooks),
    );
  }

  if (is_builtin_type_name(name)) {
    return name;
  }

  const binding = lookup(env, name);

  if (!binding || !binding.is_const || !binding.value) {
    return name;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const value = hooks.resolve_const_expr(binding.value, value_env);

  if (!value) {
    return name;
  }

  if (value.tag === "type_name") {
    return value.name;
  }

  if (value.tag === "var" && is_builtin_type_name(value.name)) {
    return value.name;
  }

  return name;
}
