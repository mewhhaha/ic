import { expect } from "../expect.ts";
import type {
  ArrayLengthExpr,
  EffectRowExpr,
  FrontType,
  TypeExpr,
} from "./ast.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

export type SemType =
  | { tag: "top" }
  | { tag: "never" }
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

    case "int":
      if (type.type === "i64") {
        return { tag: "scalar", name: "I64" };
      }

      return { tag: "scalar", name: "I32" };

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
  const source = normalize_sem_type(left);
  const target = normalize_sem_type(right);

  if (source.tag === "never" || target.tag === "top") {
    return true;
  }

  if (sem_type_key(source) === sem_type_key(target)) {
    return true;
  }

  if (source.tag === "union") {
    for (const member of source.members) {
      if (!sem_type_subtype(member, target)) {
        return false;
      }
    }

    return true;
  }

  if (target.tag === "union") {
    for (const member of target.members) {
      if (sem_type_subtype(source, member)) {
        return true;
      }
    }

    return false;
  }

  if (target.tag === "intersection") {
    for (const member of target.members) {
      if (!sem_type_subtype(source, member)) {
        return false;
      }
    }

    return true;
  }

  if (source.tag === "intersection") {
    for (const member of source.members) {
      if (sem_type_subtype(member, target)) {
        return true;
      }
    }

    return false;
  }

  if (source.tag === "difference") {
    return sem_type_subtype(source.base, target);
  }

  if (target.tag === "difference") {
    return sem_type_subtype(source, target.base) &&
      sem_types_are_disjoint(source, target.removed);
  }

  if (source.tag === "record" && target.tag === "record") {
    for (const expected of target.fields) {
      const actual = source.fields.find((field) =>
        field.name === expected.name
      );

      if (!actual || !sem_type_subtype(actual.type, expected.type)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

export function sem_types_are_disjoint(left: SemType, right: SemType): boolean {
  const a = normalize_sem_type(left);
  const b = normalize_sem_type(right);

  if (a.tag === "never" || b.tag === "never") {
    return true;
  }

  if (a.tag === "top" || b.tag === "top") {
    return false;
  }

  if (a.tag === "union") {
    for (const member of a.members) {
      if (!sem_types_are_disjoint(member, b)) {
        return false;
      }
    }

    return true;
  }

  if (b.tag === "union") {
    return sem_types_are_disjoint(b, a);
  }

  if (a.tag === "atom" && b.tag === "atom") {
    return a.name !== b.name;
  }

  if (a.tag === "scalar" && b.tag === "scalar") {
    return canonical_scalar_name(a.name) !== canonical_scalar_name(b.name);
  }

  if (
    (a.tag === "atom" && b.tag === "scalar") ||
    (a.tag === "scalar" && b.tag === "atom")
  ) {
    return true;
  }

  if (a.tag === "record" && b.tag === "record") {
    for (const field of a.fields) {
      const other = b.fields.find((item) => item.name === field.name);

      if (other && sem_types_are_disjoint(field.type, other.type)) {
        return true;
      }
    }

    return false;
  }

  if (a.tag === "frozen" && b.tag === "frozen") {
    return sem_types_are_disjoint(a.value, b.value);
  }

  if (a.tag === "borrow" && b.tag === "borrow") {
    return sem_types_are_disjoint(a.value, b.value);
  }

  return false;
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
    type.name === "U32" || type.name === "I64" || type.name === "Resume" ||
    type.name === "Bool";
}

export function sem_type_key(type: SemType): string {
  switch (type.tag) {
    case "top":
      return "top";

    case "never":
      return "never";

    case "scalar":
      return "scalar(" + canonical_scalar_name(type.name) + ")";

    case "named":
      return "named(" + type.name + ")";

    case "atom":
      return "atom(" + type.name + ")";

    case "frozen":
      return "frozen(" + sem_type_key(type.value) + ")";

    case "borrow":
      return "borrow(" + sem_type_key(type.value) + ")";

    case "apply":
      return "apply(" + sem_type_key(type.func) + "," +
        sem_type_key(type.arg) + ")";

    case "tuple":
      return "tuple(" + type.items.map(sem_type_key).join(",") + ")";

    case "product":
      return "product(" + type.entries.map((entry) => {
        const label = entry.label === undefined ? "" : entry.label + "=";
        return label + sem_type_key(entry.type);
      }).join(",") + ")";

    case "array":
      return "array(" + sem_type_key(type.element) + "," +
        array_length_key(type.length) + ")";

    case "record":
      return "record(" + type.fields.map((field) => {
        return field.name + ":" + sem_type_key(field.type);
      }).join(",") + ")";

    case "variant":
      return "variant(" + type.name + ")";

    case "union":
      return "union(" + type.members.map(sem_type_key).join(",") + ")";

    case "intersection":
      return "intersection(" + type.members.map(sem_type_key).join(",") +
        ")";

    case "difference":
      return "difference(" + sem_type_key(type.base) + "," +
        sem_type_key(type.removed) + ")";

    case "arrow":
      return "arrow(" + sem_type_key(type.param) + "," +
        sem_type_key(type.result) + ")";
  }
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
