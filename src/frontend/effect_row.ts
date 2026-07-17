import { expect } from "../expect.ts";
import type { EffectDeclaration, EffectRef, EffectRowExpr } from "./ast.ts";

export function resolve_effect_row(
  row: EffectRowExpr,
  effects: Map<string, EffectDeclaration>,
): EffectRef[] {
  const resolved = resolve(row, effects);
  return Array.from(resolved.values()).sort((left, right) => {
    return key(left).localeCompare(key(right));
  });
}

export function format_effect_row(row: EffectRowExpr): string {
  return format(row, 0);
}

function resolve(
  row: EffectRowExpr,
  effects: Map<string, EffectDeclaration>,
): Map<string, EffectRef> {
  if (row.tag === "family") {
    const declaration = effects.get(row.name);
    expect(declaration, "Unknown declared effect: " + row.name);
    const result = new Map<string, EffectRef>();

    for (const operation of declaration.operations) {
      const ref = { effect: declaration.name, operation: operation.name };
      result.set(key(ref), ref);
    }

    return result;
  }

  if (row.tag === "operation") {
    const declaration = effects.get(row.effect);
    expect(declaration, "Unknown declared effect: " + row.effect);
    expect(
      declaration.operations.some((operation) => {
        return operation.name === row.operation;
      }),
      "Unknown effect operation: " + row.effect + "." + row.operation,
    );
    const ref = { effect: row.effect, operation: row.operation };
    return new Map([[key(ref), ref]]);
  }

  if (row.tag === "variable") {
    throw new Error(
      "Cannot resolve effect row variable in closed context: " + row.name,
    );
  }

  if (row.tag === "group") {
    return resolve(row.value, effects);
  }

  const left = resolve(row.left, effects);
  const right = resolve(row.right, effects);

  if (row.tag === "union") {
    merge(left, right);
    return left;
  }

  if (row.tag === "intersection") {
    const result = new Map<string, EffectRef>();

    for (const [operation, ref] of left) {
      if (right.has(operation)) {
        result.set(operation, ref);
      }
    }

    return result;
  }

  if (row.tag === "difference") {
    for (const operation of right.keys()) {
      left.delete(operation);
    }

    return left;
  }

  row satisfies never;
  throw new Error("Unknown effect row expression");
}

function merge(
  target: Map<string, EffectRef>,
  source: Map<string, EffectRef>,
): void {
  for (const [operation, ref] of source) {
    target.set(operation, ref);
  }
}

function key(ref: EffectRef): string {
  return ref.effect + "." + ref.operation;
}

function format(row: EffectRowExpr, parent_precedence: number): string {
  if (row.tag === "family") {
    return row.name;
  }

  if (row.tag === "operation") {
    return row.effect + "." + row.operation;
  }

  if (row.tag === "variable") {
    return row.name;
  }

  if (row.tag === "group") {
    return "(" + format(row.value, 0) + ")";
  }

  let operator: string;
  let precedence: number;

  if (row.tag === "union") {
    operator = ":|";
    precedence = 1;
  } else if (row.tag === "intersection") {
    operator = ":&";
    precedence = 2;
  } else if (row.tag === "difference") {
    operator = ":-";
    precedence = 3;
  } else {
    row satisfies never;
    throw new Error("Unknown effect row expression");
  }

  const text = format(row.left, precedence) + " " + operator + " " +
    format(row.right, precedence + 1);

  if (precedence < parent_precedence) {
    return "(" + text + ")";
  }

  return text;
}
