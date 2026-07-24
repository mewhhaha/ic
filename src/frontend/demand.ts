import type { Source, Stmt } from "./ast.ts";

export function erase_undemanded_front_bindings(source: Source): Source {
  const statements: Stmt[] = [];

  for (let index = source.statements.length - 1; index >= 0; index -= 1) {
    const statement = source.statements[index];

    if (statement === undefined) {
      throw new Error("Missing source statement " + index.toString());
    }

    if (
      statement.tag === "bind" && statement.kind === "let" &&
      !statement.is_linear && statement.host_export !== true &&
      statement.annotation === undefined &&
      statement.type_annotation === undefined &&
      can_erase_before_core_lowering(statement.value) &&
      !later_statements_demand(statement.name, statements)
    ) {
      continue;
    }

    statements.unshift(statement);
  }

  return { ...source, statements };
}

function can_erase_before_core_lowering(
  value: Extract<Stmt, { tag: "bind" }>["value"],
): boolean {
  if (
    value.tag === "bool" || value.tag === "num" || value.tag === "atom" ||
    value.tag === "unit" || value.tag === "text" ||
    value.tag === "array_repeat"
  ) {
    return true;
  }

  if (value.tag === "product" || value.tag === "shape") {
    return value.entries.every((entry) => {
      return can_erase_before_core_lowering(entry.value);
    });
  }

  return false;
}

function later_statements_demand(name: string, statements: Stmt[]): boolean {
  if (contains_value_reference(statements, name, new WeakSet())) {
    return true;
  }

  return statements.some((statement) => {
    return (statement.tag === "assign" || statement.tag === "index_assign") &&
      statement.name === name;
  });
}

function contains_value_reference(
  value: unknown,
  name: string,
  visited: WeakSet<object>,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (visited.has(value)) {
    return false;
  }

  visited.add(value);

  if (
    "tag" in value && (value.tag === "var" || value.tag === "linear") &&
    "name" in value && value.name === name
  ) {
    return true;
  }

  for (const child of Object.values(value)) {
    if (contains_value_reference(child, name, visited)) {
      return true;
    }
  }

  return false;
}
