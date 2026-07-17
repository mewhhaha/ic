import { expect } from "../expect.ts";
import type {
  ArrayLengthExpr,
  EffectRowExpr,
  FrontType,
  TypeExpr,
} from "./ast.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import { type Type, type_key, TypeEngine } from "./type_engine.ts";

export type SemType =
  | { tag: "top" }
  | { tag: "never" }
  | { tag: "forall"; params: string[]; body: SemType }
  | { tag: "scalar"; name: string }
  | { tag: "named"; name: string }
  | { tag: "atom"; name: string }
  | { tag: "frozen"; value: SemType }
  | { tag: "borrow"; value: SemType }
  | { tag: "apply"; func: SemType; arg: SemType }
  | { tag: "tuple"; items: SemType[] }
  | { tag: "product"; entries: SemProductEntry[] }
  | { tag: "array"; element: SemType; length: ArrayLengthExpr }
  | { tag: "record"; name?: string; fields: SemField[] }
  | { tag: "variant"; name: string }
  | { tag: "union"; members: SemType[] }
  | { tag: "intersection"; members: SemType[] }
  | { tag: "difference"; base: SemType; removed: SemType }
  | {
    tag: "arrow";
    param: SemType;
    effects: EffectRowExpr | undefined;
    result: SemType;
  };

export type SemField = {
  name: string;
  type: SemType;
};

export type SemProductEntry = {
  label?: string;
  type: SemType;
};

export type SemTypeNameResolver = (name: string) => SemType | undefined;

const scalar_names = new Set([
  "Bool",
  "Unit",
  "Int",
  "I32",
  "U32",
  "I64",
  "F32",
  "F64",
  "F32x4",
  "Text",
  "Bytes",
  "Resume",
  "Type",
]);

export function sem_type_from_expr(
  expr: TypeExpr,
  resolve_name?: SemTypeNameResolver,
): SemType {
  switch (expr.tag) {
    case "forall": {
      const params = new Set(expr.params);
      const resolve_bound_name: SemTypeNameResolver = (name) => {
        if (params.has(name)) {
          return { tag: "named", name };
        }

        if (resolve_name) {
          return resolve_name(name);
        }

        return undefined;
      };

      return {
        tag: "forall",
        params: expr.params,
        body: sem_type_from_expr(expr.body, resolve_bound_name),
      };
    }

    case "top":
      return { tag: "top" };

    case "never":
      return { tag: "never" };

    case "atom":
      return { tag: "atom", name: expr.name };

    case "name": {
      if (scalar_names.has(expr.name)) {
        return { tag: "scalar", name: expr.name };
      }

      if (resolve_name) {
        const resolved = resolve_name(expr.name);

        if (resolved) {
          return resolved;
        }
      }

      return { tag: "named", name: expr.name };
    }

    case "frozen": {
      const value = sem_type_from_expr(expr.value, resolve_name);

      if (sem_type_is_scalar(value)) {
        return value;
      }

      return normalize_sem_type({ tag: "frozen", value });
    }

    case "borrow": {
      const value = sem_type_from_expr(expr.value, resolve_name);

      if (sem_type_is_scalar(value)) {
        return value;
      }

      return normalize_sem_type({ tag: "borrow", value });
    }

    case "apply":
      return {
        tag: "apply",
        func: sem_type_from_expr(expr.func, resolve_name),
        arg: sem_type_from_expr(expr.arg, resolve_name),
      };

    case "tuple":
      return {
        tag: "tuple",
        items: expr.items.map((item) => sem_type_from_expr(item, resolve_name)),
      };

    case "product":
      return {
        tag: "product",
        entries: expr.entries.map((entry) => ({
          label: entry.label,
          type: sem_type_from_expr(entry.type_expr, resolve_name),
        })),
      };

    case "array":
      return {
        tag: "array",
        element: sem_type_from_expr(expr.element, resolve_name),
        length: expr.length,
      };

    case "union":
      return normalize_sem_type({
        tag: "union",
        members: [
          sem_type_from_expr(expr.left, resolve_name),
          sem_type_from_expr(expr.right, resolve_name),
        ],
      });

    case "intersection":
      return intersect_sem_types(
        sem_type_from_expr(expr.left, resolve_name),
        sem_type_from_expr(expr.right, resolve_name),
      );

    case "difference":
      return subtract_sem_type(
        sem_type_from_expr(expr.left, resolve_name),
        sem_type_from_expr(expr.right, resolve_name),
      );

    case "arrow":
      return {
        tag: "arrow",
        param: sem_type_from_expr(expr.param, resolve_name),
        effects: expr.effects,
        result: sem_type_from_expr(expr.result, resolve_name),
      };
  }
}

export function sem_type_from_front_type(type: FrontType): SemType {
  switch (type.tag) {
    case "never":
      return { tag: "never" };

    case "bool":
      return { tag: "scalar", name: "Bool" };

    case "f32x4":
      return { tag: "scalar", name: "F32x4" };

    case "int":
      if (type.integer) {
        return {
          tag: "named",
          name: (type.integer.signed ? "I" : "U") +
            type.integer.width.toString(),
        };
      }

      if (type.type === "f32") {
        return { tag: "scalar", name: "F32" };
      }

      if (type.type === "f64") {
        return { tag: "scalar", name: "F64" };
      }

      if (type.type === "i64") {
        return { tag: "scalar", name: "I64" };
      }

      return { tag: "scalar", name: "I32" };

    case "wide_int":
      return {
        tag: "named",
        name: (type.integer.signed ? "I" : "U") +
          type.integer.width.toString(),
      };

    case "atom":
      return { tag: "atom", name: type.name };

    case "text":
      if (type.encoding === "bytes") {
        return { tag: "scalar", name: "Bytes" };
      }

      return { tag: "scalar", name: "Text" };

    case "type":
      return { tag: "scalar", name: "Type" };

    case "struct":
      return {
        tag: "record",
        fields: type.fields.map((name, index) => {
          const declared = type.field_types?.[index];
          let field_type: SemType = { tag: "top" };

          if (declared) {
            field_type = sem_type_from_expr(
              parse_type_expr(tokenize(declared.type_name)),
            );
          }

          return { name, type: field_type };
        }),
      };

    case "union":
      return { tag: "named", name: "." + type.case_name };

    case "union_value": {
      const members: SemType[] = [];

      for (const union_case of type.cases) {
        if (!union_case.set_member) {
          return { tag: "variant", name: "<runtime_union>" };
        }

        members.push(sem_type_from_expr(union_case.set_member));
      }

      return normalize_sem_type({ tag: "union", members });
    }

    case "set":
      return sem_type_from_expr(type.type_expr);

    case "unknown":
      return { tag: "top" };

    case "fn":
      return { tag: "named", name: "<function>" };
  }
}

export function normalize_sem_type(type: SemType): SemType {
  if (type.tag === "union") {
    return normalize_union(type.members);
  }

  if (type.tag === "intersection") {
    let result: SemType = { tag: "top" };

    for (const member of type.members) {
      result = intersect_sem_types(result, normalize_sem_type(member));
    }

    return result;
  }

  if (type.tag === "difference") {
    return subtract_sem_type(
      normalize_sem_type(type.base),
      normalize_sem_type(type.removed),
    );
  }

  if (type.tag === "frozen") {
    const value = normalize_sem_type(type.value);

    if (sem_type_is_scalar(value)) {
      return value;
    }

    if (value.tag === "frozen") {
      return value;
    }

    return { tag: "frozen", value };
  }

  if (type.tag === "borrow") {
    const value = normalize_sem_type(type.value);

    if (sem_type_is_scalar(value)) {
      return value;
    }

    if (value.tag === "borrow") {
      return value;
    }

    return { tag: "borrow", value };
  }

  return type;
}

function normalize_union(members: SemType[]): SemType {
  const flattened: SemType[] = [];

  for (const raw of members) {
    const member = normalize_sem_type(raw);

    if (member.tag === "top") {
      return member;
    }

    if (member.tag === "never") {
      continue;
    }

    if (member.tag === "union") {
      flattened.push(...member.members);
    } else {
      flattened.push(member);
    }
  }

  const by_key = new Map<string, SemType>();

  for (const member of flattened) {
    by_key.set(sem_type_key(member), member);
  }

  const keys = [...by_key.keys()].sort();

  if (keys.length === 0) {
    return { tag: "never" };
  }

  if (keys.length === 1) {
    const only = by_key.get(keys[0] || "");
    expect(only, "Missing normalized union member");
    return only;
  }

  return {
    tag: "union",
    members: keys.map((key) => {
      const member = by_key.get(key);
      expect(member, "Missing normalized union member " + key);
      return member;
    }),
  };
}

export function intersect_sem_types(left: SemType, right: SemType): SemType {
  const a = normalize_sem_type(left);
  const b = normalize_sem_type(right);

  if (a.tag === "never" || b.tag === "never") {
    return { tag: "never" };
  }

  if (a.tag === "top") {
    return b;
  }

  if (b.tag === "top") {
    return a;
  }

  if (sem_type_key(a) === sem_type_key(b)) {
    return a;
  }

  if (a.tag === "union") {
    return normalize_union(
      a.members.map((member) => intersect_sem_types(member, b)),
    );
  }

  if (b.tag === "union") {
    return normalize_union(
      b.members.map((member) => intersect_sem_types(a, member)),
    );
  }

  if (a.tag === "record" && b.tag === "record") {
    return intersect_records(a, b);
  }

  if (sem_types_are_disjoint(a, b)) {
    return { tag: "never" };
  }

  const members = [a, b].sort((x, y) => {
    return sem_type_key(x).localeCompare(sem_type_key(y));
  });
  return { tag: "intersection", members };
}

function intersect_records(
  left: Extract<SemType, { tag: "record" }>,
  right: Extract<SemType, { tag: "record" }>,
): SemType {
  const fields = new Map<string, SemType>();

  for (const field of left.fields) {
    fields.set(field.name, field.type);
  }

  for (const field of right.fields) {
    const previous = fields.get(field.name);

    if (!previous) {
      fields.set(field.name, field.type);
      continue;
    }

    const type = intersect_sem_types(previous, field.type);

    if (type.tag === "never") {
      return type;
    }

    fields.set(field.name, type);
  }

  const names = [...fields.keys()].sort();
  return {
    tag: "record",
    fields: names.map((name) => {
      const type = fields.get(name);
      expect(type, "Missing intersected record field " + name);
      return { name, type };
    }),
  };
}

export function subtract_sem_type(base: SemType, removed: SemType): SemType {
  const source = normalize_sem_type(base);
  const exclusion = normalize_sem_type(removed);

  if (source.tag === "never" || exclusion.tag === "top") {
    return { tag: "never" };
  }

  if (exclusion.tag === "never") {
    return source;
  }

  if (sem_type_subtype(source, exclusion)) {
    return { tag: "never" };
  }

  if (sem_types_are_disjoint(source, exclusion)) {
    return source;
  }

  if (source.tag === "union") {
    return normalize_union(
      source.members.map((member) => subtract_sem_type(member, exclusion)),
    );
  }

  if (exclusion.tag === "union") {
    let result: SemType = source;

    for (const member of exclusion.members) {
      result = subtract_sem_type(result, member);
    }

    return result;
  }

  return { tag: "difference", base: source, removed: exclusion };
}

export function sem_type_subtype(left: SemType, right: SemType): boolean {
  const engine = new TypeEngine();
  return engine.subtype(
    canonical_type_from_sem_type(left),
    canonical_type_from_sem_type(right),
  );
}

export function sem_types_are_disjoint(left: SemType, right: SemType): boolean {
  const engine = new TypeEngine();
  return engine.disjoint(
    canonical_type_from_sem_type(left),
    canonical_type_from_sem_type(right),
  );
}

function canonical_scalar_name(name: string): string {
  if (name === "Int" || name === "I32" || name === "U32" || name === "Resume") {
    return "I32";
  }

  return name;
}

function sem_type_is_scalar(type: SemType): boolean {
  if (type.tag !== "scalar") {
    return false;
  }

  return type.name === "Unit" || type.name === "Int" || type.name === "I32" ||
    type.name === "U32" || type.name === "I64" || type.name === "F32" ||
    type.name === "F64" || type.name === "Resume" || type.name === "Bool";
}

export function sem_type_key(type: SemType): string {
  const engine = new TypeEngine();
  return type_key(engine.normalize(canonical_type_from_sem_type(type)));
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

export function canonical_type_from_sem_type(type: SemType): Type {
  return canonical_type_from_sem_type_at(
    type,
    new Map(),
    { next_variable: 0 },
  );
}

function canonical_type_from_sem_type_at(
  type: SemType,
  bound_variables: Map<string, Extract<Type, { tag: "variable" }>>,
  variables: { next_variable: number },
): Type {
  switch (type.tag) {
    case "top":
    case "never":
      return { tag: type.tag };

    case "forall": {
      const scoped = new Map(bound_variables);
      const quantified_variables: number[] = [];

      for (const param of type.params) {
        const variable: Extract<Type, { tag: "variable" }> = {
          tag: "variable",
          id: variables.next_variable,
          hint: param,
        };
        variables.next_variable += 1;
        scoped.set(param, variable);
        quantified_variables.push(variable.id);
      }

      return {
        tag: "forall",
        quantified_variables,
        body: canonical_type_from_sem_type_at(type.body, scoped, variables),
      };
    }

    case "scalar": {
      const name = canonical_scalar_name(type.name);

      if (
        name === "Bool" || name === "Unit" || name === "Int" ||
        name === "I32" || name === "U32" || name === "I64" ||
        name === "F32" || name === "F64" || name === "F32x4" ||
        name === "Text" ||
        name === "Bytes" || name === "Resume" || name === "Type"
      ) {
        return { tag: "scalar", name };
      }

      return { tag: "named", name, args: [] };
    }

    case "named": {
      const bound = bound_variables.get(type.name);

      if (bound !== undefined) {
        return bound;
      }

      return { tag: "named", name: type.name, args: [] };
    }

    case "atom":
      return { tag: "named", name: "#" + type.name, args: [] };

    case "frozen":
      return {
        tag: "owned",
        ownership: "frozen_shareable",
        value: canonical_type_from_sem_type_at(
          type.value,
          bound_variables,
          variables,
        ),
      };

    case "borrow":
      return {
        tag: "owned",
        ownership: "bounded_borrow",
        value: canonical_type_from_sem_type_at(
          type.value,
          bound_variables,
          variables,
        ),
      };

    case "apply": {
      const func = canonical_type_from_sem_type_at(
        type.func,
        bound_variables,
        variables,
      );
      const arg = canonical_type_from_sem_type_at(
        type.arg,
        bound_variables,
        variables,
      );

      if (func.tag === "named") {
        return { ...func, args: [...func.args, arg] };
      }

      return {
        tag: "named",
        name: "apply(" + type_key(func) + ")",
        args: [arg],
      };
    }

    case "tuple":
      return {
        tag: "product",
        fields: type.items.map((item) => {
          return {
            label: undefined,
            type: canonical_type_from_sem_type_at(
              item,
              bound_variables,
              variables,
            ),
          };
        }),
      };

    case "product":
      return {
        tag: "product",
        fields: type.entries.map((entry) => {
          return {
            label: entry.label,
            type: canonical_type_from_sem_type_at(
              entry.type,
              bound_variables,
              variables,
            ),
          };
        }),
      };

    case "array":
      return {
        tag: "named",
        name: "Array[" + array_length_key(type.length) + "]",
        args: [
          canonical_type_from_sem_type_at(
            type.element,
            bound_variables,
            variables,
          ),
        ],
      };

    case "record":
      return {
        tag: "record",
        fields: type.fields.map((field) => {
          return {
            label: field.name,
            type: canonical_type_from_sem_type_at(
              field.type,
              bound_variables,
              variables,
            ),
          };
        }),
      };

    case "variant":
      return { tag: "named", name: type.name, args: [] };

    case "union":
    case "intersection":
      return {
        tag: type.tag,
        members: type.members.map((member) => {
          return canonical_type_from_sem_type_at(
            member,
            bound_variables,
            variables,
          );
        }),
      };

    case "difference":
      return {
        tag: "difference",
        base: canonical_type_from_sem_type_at(
          type.base,
          bound_variables,
          variables,
        ),
        removed: canonical_type_from_sem_type_at(
          type.removed,
          bound_variables,
          variables,
        ),
      };

    case "arrow":
      return {
        tag: "function",
        params: [
          canonical_type_from_sem_type_at(
            type.param,
            bound_variables,
            variables,
          ),
        ],
        effects: [],
        result: canonical_type_from_sem_type_at(
          type.result,
          bound_variables,
          variables,
        ),
      };
  }
}

export function sem_type_finite_members(type: SemType): SemType[] | undefined {
  const normalized = normalize_sem_type(type);

  if (
    normalized.tag === "top" || normalized.tag === "never" ||
    normalized.tag === "intersection" || normalized.tag === "difference" ||
    normalized.tag === "arrow"
  ) {
    if (normalized.tag === "never") {
      return [];
    }

    return undefined;
  }

  if (normalized.tag === "union") {
    return normalized.members;
  }

  return [normalized];
}
