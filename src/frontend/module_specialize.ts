import { expect } from "../expect.ts";
import type { FrontExpr, Pattern, Source, Stmt, TypeExpr } from "./ast.ts";
import { is_projected_const_module_import } from "./load.ts";
import { substitute_front_expr, substitute_front_stmt } from "./substitute.ts";

type ModuleExport = {
  annotation: string | undefined;
  type_annotation: TypeExpr | undefined;
  value: FrontExpr;
};

export function specialize_const_module_imports(source: Source): Source {
  return { ...source, statements: specialize_statements(source.statements) };
}

function specialize_statements(statements: Stmt[]): Stmt[] {
  const specialized: Stmt[] = [];
  const imported_values = new Map<string, FrontExpr>();

  for (const original of statements) {
    let statement = original;

    if (
      imported_values.size > 0 &&
      !(original.tag === "bind" &&
        is_projected_const_module_import(original.value))
    ) {
      statement = substitute_imports_in_statement(original, imported_values);
    }
    const imports = specialize_import_binding(statement);

    if (imports === undefined) {
      specialized.push(statement);

      if (statement.tag === "bind") {
        imported_values.delete(statement.name);
      } else if (
        statement.tag === "assign" || statement.tag === "index_assign"
      ) {
        imported_values.delete(statement.name);
      }

      continue;
    }

    for (const imported of imports) {
      expect(imported.tag === "bind", "Expected specialized import binding");

      if (should_inline_imported_value(imported.value)) {
        imported_values.set(imported.name, imported.value);
        continue;
      }

      specialized.push(imported);
    }
  }

  return specialized;
}

function should_inline_imported_value(value: FrontExpr): boolean {
  return value.tag === "lam" && value.body.tag === "app" &&
    value.body.func.tag === "var" && value.body.func.name.startsWith("@") &&
    value.params.every((param) => !param.is_const && !param.is_linear);
}

function substitute_imports_in_statement(
  statement: Stmt,
  replacements: Map<string, FrontExpr>,
): Stmt {
  return substitute_front_stmt(statement, replacements);
}

function specialize_import_binding(statement: Stmt): Stmt[] | undefined {
  if (
    statement.tag !== "bind" || statement.kind !== "const" ||
    statement.pattern?.tag !== "product" ||
    !is_projected_const_module_import(statement.value)
  ) {
    return undefined;
  }

  const exports = module_exports(statement.value);

  if (exports === undefined) {
    return undefined;
  }

  for (const entry of statement.pattern.entries) {
    if (entry.label === undefined) {
      return undefined;
    }

    const exported = exports.get(entry.label);
    expect(exported, "Missing specialized module export: " + entry.label);

    if (
      exported.annotation === undefined &&
      exported.type_annotation === undefined &&
      !is_handler_factory(exported.value) &&
      !should_inline_imported_value(exported.value)
    ) {
      return undefined;
    }
  }

  const bindings: Stmt[] = [];

  for (const entry of statement.pattern.entries) {
    if (entry.label === undefined || entry.pattern.tag !== "binding") {
      return undefined;
    }

    const exported = exports.get(entry.label);
    expect(exported, "Missing specialized module export: " + entry.label);
    let annotation = exported.annotation;
    let type_annotation = exported.type_annotation;

    if (entry.pattern.annotation !== undefined) {
      annotation = entry.pattern.annotation;
    }

    if (entry.pattern.type_annotation !== undefined) {
      type_annotation = entry.pattern.type_annotation;
    }

    const pattern: Extract<Pattern, { tag: "binding" }> = {
      ...entry.pattern,
      annotation,
      type_annotation,
    };
    bindings.push({
      tag: "bind",
      kind: "const",
      pattern,
      name: pattern.name,
      is_recursive: false,
      is_linear: false,
      annotation,
      type_annotation,
      value: exported.value,
    });
  }

  return bindings;
}

function is_handler_factory(value: FrontExpr): boolean {
  if (value.tag !== "lam") {
    return false;
  }

  function contains_handler(candidate: unknown): boolean {
    if (candidate === null || typeof candidate !== "object") {
      return false;
    }

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (contains_handler(entry)) {
          return true;
        }
      }

      return false;
    }

    const node = candidate as Record<string, unknown>;

    if (node.tag === "handler") {
      return true;
    }

    for (const child of Object.values(node)) {
      if (contains_handler(child)) {
        return true;
      }
    }

    return false;
  }

  return contains_handler(value.body);
}

function module_exports(
  value: FrontExpr,
): Map<string, ModuleExport> | undefined {
  if (value.tag === "comptime") {
    return module_exports(value.expr);
  }

  if (
    value.tag !== "app" || value.func.tag !== "lam" ||
    value.func.body.tag !== "block"
  ) {
    return undefined;
  }

  const statements = specialize_statements(value.func.body.statements);
  const final = statements[statements.length - 1];

  if (final?.tag !== "return" || final.value.tag !== "struct_value") {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();
  const annotations = new Map<
    string,
    { annotation: string | undefined; type_annotation: TypeExpr | undefined }
  >();

  for (const statement of statements.slice(0, -1)) {
    if (
      statement.tag !== "bind" || statement.kind !== "const" ||
      statement.pattern !== undefined && statement.pattern.tag !== "binding"
    ) {
      continue;
    }

    const substituted = substitute_front_expr(statement.value, replacements);
    replacements.set(statement.name, substituted);
    annotations.set(statement.name, {
      annotation: statement.annotation,
      type_annotation: statement.type_annotation,
    });
  }

  const exports = new Map<string, ModuleExport>();

  for (const field of final.value.fields) {
    let annotation: string | undefined;
    let type_annotation: TypeExpr | undefined;

    if (field.value.tag === "var") {
      const evidence = annotations.get(field.value.name);

      if (evidence !== undefined) {
        annotation = evidence.annotation;
        type_annotation = evidence.type_annotation;
      }
    }

    exports.set(field.name, {
      annotation,
      type_annotation,
      value: substitute_front_expr(field.value, replacements),
    });
  }

  return exports;
}
