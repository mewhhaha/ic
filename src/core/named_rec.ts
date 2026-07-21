import type { Core, CoreExpr, CoreRecFunction, CoreStmt } from "./ast.ts";
import { core_name_use_count } from "./name_use_count.ts";

export function named_rec_function_core(
  core: Core,
  definition: CoreRecFunction,
): Core {
  if (definition.body_stmt === undefined) {
    definition.body_stmt = { tag: "expr", expr: definition.body };
  }

  const function_core: Core = {
    tag: "program",
    function_params: definition.params,
    statements: [
      ...named_rec_function_statements(core, definition),
      definition.body_stmt,
    ],
  };

  if (core.host_imports !== undefined) {
    function_core.host_imports = core.host_imports;
  }

  return function_core;
}

function named_rec_function_statements(
  core: Core,
  definition: CoreRecFunction,
): CoreStmt[] {
  const bindings = new Map<
    string,
    Extract<CoreStmt, { tag: "bind" }>
  >();

  for (const stmt of core.statements) {
    if (stmt.tag === "bind") {
      bindings.set(stmt.name, stmt);
    }
  }

  const dependencies = new Set<string>();
  const parameter_names = new Set(
    definition.params.map((parameter) => parameter.name),
  );
  const pending = [definition.body];

  while (pending.length > 0) {
    const value = pending.pop();

    if (value === undefined) {
      throw new Error("Named recursive dependency scan lost an expression");
    }

    for (const [name, stmt] of bindings) {
      if (parameter_names.has(name)) {
        continue;
      }

      if (dependencies.has(name)) {
        continue;
      }

      if (core_name_use_count(value, name) === 0) {
        continue;
      }

      dependencies.add(name);
      pending.push(stmt.value);
    }
  }

  return core.statements.filter((stmt) => {
    if (stmt.tag !== "bind") {
      return false;
    }

    if (dependencies.has(stmt.name)) {
      return true;
    }

    if (stmt.kind !== "const" || stmt.value.tag !== "var") {
      return stmt.kind === "const";
    }

    const target = bindings.get(stmt.value.name);

    if (target === undefined) {
      return true;
    }

    return target.kind === "const";
  });
}

export function named_rec_type_values(core: Core): Map<string, CoreExpr> {
  const values = new Map<string, CoreExpr>();

  for (const stmt of core.statements) {
    if (named_rec_type_statement(stmt)) {
      values.set(stmt.name, stmt.value);
    }
  }

  return values;
}

function named_rec_type_statement(
  stmt: CoreStmt,
): stmt is Extract<CoreStmt, { tag: "bind" }> {
  return stmt.tag === "bind" && stmt.kind === "const";
}
