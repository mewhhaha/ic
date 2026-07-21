import type {
  ArrayLengthExpr,
  Env,
  FrontExpr,
  ResolvedFrontExpr,
  TypeExpr,
} from "./ast.ts";
import { is_builtin_type_name } from "./types.ts";
import { integer_type_name } from "../integer.ts";

export type ComptimeTypeField = {
  name: string | undefined;
  type: ComptimeType;
  source: FrontExpr;
};

export type ComptimeType =
  | { tag: "top"; source: FrontExpr }
  | { tag: "never"; source: FrontExpr }
  | {
    tag: "forall";
    params: string[];
    body: ComptimeType;
    source: FrontExpr;
  }
  | { tag: "scalar"; name: string; source: FrontExpr }
  | { tag: "named"; name: string; source: FrontExpr }
  | { tag: "atom"; name: string; source: FrontExpr }
  | { tag: "frozen"; value: ComptimeType; source: FrontExpr }
  | { tag: "borrow"; value: ComptimeType; source: FrontExpr }
  | {
    tag: "apply";
    func: ComptimeType;
    arg: ComptimeType;
    source: FrontExpr;
  }
  | { tag: "tuple"; items: ComptimeType[]; source: FrontExpr }
  | { tag: "product"; entries: ComptimeTypeField[]; source: FrontExpr }
  | {
    tag: "array";
    element: ComptimeType;
    length: ArrayLengthExpr;
    source: FrontExpr;
  }
  | { tag: "record"; fields: ComptimeTypeField[]; source: FrontExpr }
  | { tag: "sum"; cases: ComptimeTypeField[]; source: FrontExpr }
  | { tag: "union"; members: ComptimeType[]; source: FrontExpr }
  | { tag: "intersection"; members: ComptimeType[]; source: FrontExpr }
  | {
    tag: "difference";
    base: ComptimeType;
    removed: ComptimeType;
    source: FrontExpr;
  }
  | {
    tag: "function";
    param: ComptimeType;
    result: ComptimeType;
    source: FrontExpr;
  };

export type ComptimeValue =
  | {
    tag: "scalar";
    value: Extract<
      FrontExpr,
      { tag: "bool" | "num" | "atom" | "unit" | "text" }
    >;
  }
  | { tag: "type"; type: ComptimeType }
  | {
    tag: "closure";
    recursive: boolean;
    value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
    env: Env;
  }
  | { tag: "product"; entries: ComptimeValue[] }
  | { tag: "array"; items: ComptimeValue[] }
  | {
    tag: "record";
    fields: { name: string; value: ComptimeValue }[];
  }
  | {
    tag: "case";
    name: string;
    value: ComptimeValue | undefined;
  };

export type ComptimeValueHooks = {
  resolve_const_expr_with_env: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
};

export function resolve_comptime_value(
  expr: FrontExpr,
  env: Env,
  hooks: ComptimeValueHooks,
): ComptimeValue | undefined {
  const resolved = hooks.resolve_const_expr_with_env(expr, env);

  if (!resolved) {
    return undefined;
  }

  return comptime_value_from_resolved(resolved, hooks);
}

export function resolve_comptime_type(
  expr: FrontExpr,
  env: Env,
  hooks: ComptimeValueHooks,
): ComptimeType | undefined {
  const value = resolve_comptime_value(expr, env, hooks);

  if (!value || value.tag !== "type") {
    return undefined;
  }

  return value.type;
}

export function comptime_type_key(type: ComptimeType): string {
  switch (type.tag) {
    case "forall":
      return "forall(" + type.params.join(",") + "," +
        comptime_type_key(type.body) + ")";

    case "top":
    case "never":
      return type.tag;

    case "scalar":
    case "named":
    case "atom":
      return type.tag + ":" + type.name;

    case "frozen":
    case "borrow":
      return type.tag + "(" + comptime_type_key(type.value) + ")";

    case "apply":
      return "apply(" + comptime_type_key(type.func) + "," +
        comptime_type_key(type.arg) + ")";

    case "tuple":
      return "tuple(" + type.items.map(comptime_type_key).join(",") + ")";

    case "product":
      return "product(" + type.entries.map(comptime_type_field_key).join(",") +
        ")";

    case "array":
      return "array(" + comptime_type_key(type.element) + ";" +
        array_length_key(type.length) + ")";

    case "record":
      return "record(" + type.fields.map(comptime_type_field_key).join(",") +
        ")";

    case "sum":
      return "sum(" + type.cases.map(comptime_type_field_key).join(",") +
        ")";

    case "union":
    case "intersection":
      return type.tag + "(" + type.members.map(comptime_type_key).join(",") +
        ")";

    case "difference":
      return "difference(" + comptime_type_key(type.base) + "," +
        comptime_type_key(type.removed) + ")";

    case "function":
      return "function(" + comptime_type_key(type.param) + "," +
        comptime_type_key(type.result) + ")";
  }
}

function comptime_type_field_key(field: ComptimeTypeField): string {
  let name = "_";

  if (field.name !== undefined) {
    name = field.name;
  }

  return name + ":" + comptime_type_key(field.type);
}

function array_length_key(length: ArrayLengthExpr): string {
  if (length.tag === "number") {
    return length.value.toString();
  }

  if (length.tag === "name") {
    return length.name;
  }

  return "(" + array_length_key(length.left) + length.op +
    array_length_key(length.right) + ")";
}

function comptime_value_from_resolved(
  resolved: ResolvedFrontExpr,
  hooks: ComptimeValueHooks,
): ComptimeValue | undefined {
  const expr = resolved.expr;

  if (
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "atom" ||
    expr.tag === "unit" || expr.tag === "text"
  ) {
    return { tag: "scalar", value: expr };
  }

  const type = comptime_type_from_expr(expr, resolved.env, hooks, new Set());

  if (type) {
    return { tag: "type", type };
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return {
      tag: "closure",
      recursive: expr.tag === "rec",
      value: expr,
      env: resolved.env,
    };
  }

  if (expr.tag === "product") {
    const entries: ComptimeValue[] = [];

    for (const entry of expr.entries) {
      const value = resolve_comptime_value(entry.value, resolved.env, hooks);

      if (!value) {
        return undefined;
      }

      entries.push(value);
    }

    return { tag: "product", entries };
  }

  if (expr.tag === "array" && expr.rest === undefined) {
    const items: ComptimeValue[] = [];

    for (const item of expr.items) {
      const value = resolve_comptime_value(item, resolved.env, hooks);

      if (!value) {
        return undefined;
      }

      items.push(value);
    }

    return { tag: "array", items };
  }

  if (expr.tag === "struct_value") {
    const fields: { name: string; value: ComptimeValue }[] = [];

    for (const field of expr.fields) {
      const value = resolve_comptime_value(field.value, resolved.env, hooks);

      if (!value) {
        return undefined;
      }

      fields.push({ name: field.name, value });
    }

    return { tag: "record", fields };
  }

  if (expr.tag === "union_case") {
    let value: ComptimeValue | undefined;

    if (expr.value !== undefined) {
      value = resolve_comptime_value(expr.value, resolved.env, hooks);

      if (!value) {
        return undefined;
      }
    }

    return { tag: "case", name: expr.name, value };
  }

  return undefined;
}

function comptime_type_from_expr(
  expr: FrontExpr,
  env: Env,
  hooks: ComptimeValueHooks,
  resolving: Set<string>,
): ComptimeType | undefined {
  if (expr.tag === "type_name") {
    return { tag: "scalar", name: expr.name, source: expr };
  }

  if (expr.tag === "struct_type") {
    return {
      tag: "record",
      source: expr,
      fields: expr.fields.map((field) => ({
        name: field.name,
        type: comptime_type_from_type_expr(
          { tag: "name", name: field.type_name },
          env,
          hooks,
          resolving,
        ),
        source: { tag: "var", name: field.type_name },
      })),
    };
  }

  if (expr.tag === "union_type") {
    return {
      tag: "sum",
      source: expr,
      cases: expr.cases.map((union_case) => ({
        name: union_case.name,
        type: comptime_type_from_type_expr(
          { tag: "name", name: union_case.type_name },
          env,
          hooks,
          resolving,
        ),
        source: { tag: "var", name: union_case.type_name },
      })),
    };
  }

  if (expr.tag === "set_type") {
    return comptime_type_from_type_expr(
      expr.type_expr,
      env,
      hooks,
      resolving,
      expr,
    );
  }

  if (expr.tag === "with") {
    const base = hooks.resolve_const_expr_with_env(expr.base, env);

    if (!base) {
      return undefined;
    }

    return comptime_type_from_expr(base.expr, base.env, hooks, resolving);
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  if (is_builtin_type_name(expr.name)) {
    return { tag: "scalar", name: expr.name, source: expr };
  }

  if (resolving.has(expr.name)) {
    throw new Error("Recursive compile-time type value: " + expr.name);
  }

  const resolved = hooks.resolve_const_expr_with_env(expr, env);

  if (!resolved || resolved.expr === expr) {
    return { tag: "named", name: expr.name, source: expr };
  }

  const next = new Set(resolving);
  next.add(expr.name);
  const type = comptime_type_from_expr(
    resolved.expr,
    resolved.env,
    hooks,
    next,
  );

  if (type) {
    return type;
  }

  return { tag: "named", name: expr.name, source: expr };
}

function comptime_type_from_type_expr(
  expr: TypeExpr,
  env: Env,
  hooks: ComptimeValueHooks,
  resolving: Set<string>,
  source: FrontExpr = { tag: "set_type", type_expr: expr },
): ComptimeType {
  switch (expr.tag) {
    case "forall":
      return {
        tag: "forall",
        params: expr.params,
        body: comptime_type_from_type_expr(
          expr.body,
          env,
          hooks,
          resolving,
        ),
        source,
      };

    case "top":
      return { tag: "top", source };

    case "never":
      return { tag: "never", source };

    case "atom":
      return { tag: "atom", name: expr.name, source };

    case "literal": {
      let name = "I32";

      if (expr.value.tag === "bool") {
        name = "Bool";
      } else if (expr.value.tag === "text") {
        name = "Text";
      } else if (expr.value.character !== undefined) {
        name = "Char";
      } else if (expr.value.integer !== undefined) {
        name = integer_type_name(expr.value.integer);
      } else if (expr.value.type === "i64") {
        name = "I64";
      }

      return { tag: "scalar", name, source };
    }

    case "name": {
      const resolved = comptime_type_from_expr(
        { tag: "var", name: expr.name },
        env,
        hooks,
        resolving,
      );

      if (resolved) {
        return resolved;
      }

      return { tag: "named", name: expr.name, source };
    }

    case "frozen":
      return {
        tag: "frozen",
        value: comptime_type_from_type_expr(expr.value, env, hooks, resolving),
        source,
      };

    case "borrow":
      return {
        tag: "borrow",
        value: comptime_type_from_type_expr(expr.value, env, hooks, resolving),
        source,
      };

    case "apply":
      return {
        tag: "apply",
        func: comptime_type_from_type_expr(expr.func, env, hooks, resolving),
        arg: comptime_type_from_type_expr(expr.arg, env, hooks, resolving),
        source,
      };

    case "tuple":
      return {
        tag: "tuple",
        items: expr.items.map((item) =>
          comptime_type_from_type_expr(item, env, hooks, resolving)
        ),
        source,
      };

    case "product":
      return {
        tag: "product",
        entries: expr.entries.map((entry) => ({
          name: entry.label,
          type: comptime_type_from_type_expr(
            entry.type_expr,
            env,
            hooks,
            resolving,
          ),
          source: { tag: "set_type", type_expr: entry.type_expr },
        })),
        source,
      };

    case "array":
      return {
        tag: "array",
        element: comptime_type_from_type_expr(
          expr.element,
          env,
          hooks,
          resolving,
        ),
        length: expr.length,
        source,
      };

    case "union":
      return {
        tag: "union",
        members: flatten_type_members("union", expr, env, hooks, resolving),
        source,
      };

    case "intersection":
      return {
        tag: "intersection",
        members: flatten_type_members(
          "intersection",
          expr,
          env,
          hooks,
          resolving,
        ),
        source,
      };

    case "difference":
      return {
        tag: "difference",
        base: comptime_type_from_type_expr(expr.left, env, hooks, resolving),
        removed: comptime_type_from_type_expr(
          expr.right,
          env,
          hooks,
          resolving,
        ),
        source,
      };

    case "arrow":
      return {
        tag: "function",
        param: comptime_type_from_type_expr(expr.param, env, hooks, resolving),
        result: comptime_type_from_type_expr(
          expr.result,
          env,
          hooks,
          resolving,
        ),
        source,
      };
  }
}

function flatten_type_members(
  tag: "union" | "intersection",
  expr: Extract<TypeExpr, { tag: "union" | "intersection" }>,
  env: Env,
  hooks: ComptimeValueHooks,
  resolving: Set<string>,
): ComptimeType[] {
  const members: ComptimeType[] = [];

  function append(value: TypeExpr): void {
    if (value.tag === tag) {
      append(value.left);
      append(value.right);
      return;
    }

    members.push(comptime_type_from_type_expr(value, env, hooks, resolving));
  }

  append(expr);
  return members;
}
