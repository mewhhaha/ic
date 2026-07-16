import type { FrontExpr, Source, Stmt } from "./ast.ts";
import { parse_source_with_diagnostics } from "./parser.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
} from "./semantic_diagnostic.ts";
import { bundled_source_text } from "./prelude.ts";

export type SourceImportResolver = (uri: string) => string | undefined;

type ImportValidation = {
  cache: Map<string, ReturnType<typeof parse_source_with_diagnostics>>;
  visited: Set<string>;
  resolve_import: SourceImportResolver;
};

export function validate_source_imports(
  source: Source,
  uri: string,
  resolve_import: SourceImportResolver,
): SourceDiagnostic[] {
  const validation: ImportValidation = {
    cache: new Map(),
    visited: new Set([uri]),
    resolve_import,
  };
  const diagnostics: SourceDiagnostic[] = [];

  for (const imported of source_import_expressions(source)) {
    const diagnostic = validate_source_import(
      imported,
      uri,
      imported,
      [uri],
      validation,
    );

    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  if (diagnostics.length === 0) {
    diagnostics.push(...validate_module_exports(source, uri, validation));
  }

  return diagnostics;
}

function validate_module_exports(
  source: Source,
  uri: string,
  validation: ImportValidation,
): SourceDiagnostic[] {
  const modules = new Map<string, {
    imported: Extract<FrontExpr, { tag: "import" }>;
    exports: Set<string>;
  }>();

  for (const statement of source.statements) {
    if (statement.tag !== "bind" || statement.value.tag !== "import") {
      continue;
    }

    const dependency_uri = new URL(statement.value.path, uri).href;
    const dependency = validation.cache.get(dependency_uri);
    const returned = dependency?.source.statements.at(-1);

    if (
      returned?.tag !== "return" || returned.value.tag !== "struct_value"
    ) {
      continue;
    }

    modules.set(statement.name, {
      imported: statement.value,
      exports: new Set(returned.value.fields.map((field) => field.name)),
    });
  }

  const diagnostics: SourceDiagnostic[] = [];

  for (const statement of source.statements) {
    if (
      statement.tag !== "bind" || statement.pattern === undefined ||
      statement.value.tag !== "app" || statement.value.func.tag !== "var"
    ) {
      continue;
    }

    const module = modules.get(statement.value.func.name);

    if (module === undefined) {
      continue;
    }

    const selected: Array<{ name: string; subject: object }> = [];

    if (statement.pattern.tag === "record") {
      for (const field of statement.pattern.fields) {
        selected.push({ name: field.name, subject: field.pattern });
      }
    } else if (statement.pattern.tag === "product") {
      for (const entry of statement.pattern.entries) {
        if (entry.label === undefined) {
          selected.length = 0;
          break;
        }

        selected.push({ name: entry.label, subject: entry.pattern });
      }
    }

    for (const field of selected) {
      if (module.exports.has(field.name)) {
        continue;
      }

      diagnostics.push(source_diagnostic(
        "DUCK2501",
        "Import " + module.imported.path + " does not export " + field.name,
        field.subject,
      ));
    }
  }

  return diagnostics;
}

export function source_import_expressions(
  source: Source,
): Extract<FrontExpr, { tag: "import" }>[] {
  const imports: Extract<FrontExpr, { tag: "import" }>[] = [];

  visit_statements(source.statements, (expr) => imports.push(expr));
  return imports;
}

export function validate_source_import_context(
  source: Source,
): SourceDiagnostic[] {
  const imported = source_import_expressions(source).find((candidate) =>
    bundled_source_text(candidate.path) === undefined
  );

  if (imported === undefined) {
    return [];
  }

  return [source_diagnostic(
    "DUCK2500",
    "Cannot resolve import without a source URI and import resolver",
    imported,
  )];
}

function validate_source_import(
  imported: Extract<FrontExpr, { tag: "import" }>,
  uri: string,
  root_subject: Extract<FrontExpr, { tag: "import" }>,
  stack: string[],
  validation: ImportValidation,
): SourceDiagnostic | undefined {
  let dependency_uri: string;

  try {
    dependency_uri = new URL(imported.path, uri).href;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return source_diagnostic(
      "DUCK2505",
      "Invalid import URI: " + imported.path,
      root_subject,
    );
  }

  if (stack.includes(dependency_uri)) {
    return source_diagnostic(
      "DUCK2504",
      "Circular import: " + [...stack, dependency_uri].join(" -> "),
      root_subject,
    );
  }

  let dependency = validation.cache.get(dependency_uri);

  if (dependency === undefined) {
    let text = bundled_source_text(dependency_uri);

    if (text === undefined) {
      text = validation.resolve_import(dependency_uri);
    }

    if (text === undefined) {
      return source_diagnostic(
        "DUCK2502",
        "Import dependency does not exist: " + imported.path,
        root_subject,
      );
    }

    dependency = parse_source_with_diagnostics(text);
    validation.cache.set(dependency_uri, dependency);
  }

  if (dependency.diagnostics.length > 0) {
    return source_diagnostic(
      "DUCK2503",
      "Imported source contains syntax errors: " + imported.path,
      root_subject,
    );
  }

  if (dependency.source.module === undefined) {
    return source_diagnostic(
      "DUCK2501",
      "Import file must be a module: " + imported.path,
      root_subject,
    );
  }

  if (validation.visited.has(dependency_uri)) {
    return undefined;
  }

  validation.visited.add(dependency_uri);
  const dependency_stack = [...stack, dependency_uri];

  for (const nested of source_import_expressions(dependency.source)) {
    const diagnostic = validate_source_import(
      nested,
      dependency_uri,
      root_subject,
      dependency_stack,
      validation,
    );

    if (diagnostic !== undefined) {
      return diagnostic;
    }
  }

  return undefined;
}

function visit_statements(
  statements: Stmt[],
  visit_import: (expr: Extract<FrontExpr, { tag: "import" }>) => void,
): void {
  for (const stmt of statements) {
    visit_statement(stmt, visit_import);
  }
}

function visit_statement(
  stmt: Stmt,
  visit_import: (expr: Extract<FrontExpr, { tag: "import" }>) => void,
): void {
  switch (stmt.tag) {
    case "import":
      return;

    case "host_import":
    case "continue":
    case "unsupported":
      return;

    case "bind":
    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
    case "assign":
      visit_expression(stmt.value, visit_import);
      return;

    case "index_assign":
      visit_expression(stmt.index, visit_import);
      visit_expression(stmt.value, visit_import);
      return;

    case "for_range":
      visit_expression(stmt.start, visit_import);
      visit_expression(stmt.end, visit_import);
      visit_expression(stmt.step, visit_import);
      visit_statements(stmt.body, visit_import);
      return;

    case "for_collection":
      visit_expression(stmt.collection, visit_import);
      visit_statements(stmt.body, visit_import);
      return;

    case "if_stmt":
      visit_expression(stmt.cond, visit_import);

      if (stmt.cond.tag !== "bool" || stmt.cond.value) {
        visit_statements(stmt.body, visit_import);
      }
      return;

    case "if_let_stmt":
      visit_expression(stmt.target, visit_import);

      if (
        stmt.target.tag !== "union_case" ||
        stmt.target.name === stmt.case_name
      ) {
        visit_statements(stmt.body, visit_import);
      }
      return;

    case "type_check":
      visit_expression(stmt.target, visit_import);
      return;

    case "break":
      if (stmt.value !== undefined) {
        visit_expression(stmt.value, visit_import);
      }
      return;

    case "return":
      visit_expression(stmt.value, visit_import);
      return;

    case "expr":
      visit_expression(stmt.expr, visit_import);
      return;
  }

  stmt satisfies never;
  throw new Error("panic");
}

function visit_expression(
  expr: FrontExpr,
  visit_import: (expr: Extract<FrontExpr, { tag: "import" }>) => void,
): void {
  switch (expr.tag) {
    case "import":
      visit_import(expr);
      return;

    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "var":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "linear":
    case "unsupported":
      return;

    case "prim":
      visit_expression(expr.left, visit_import);
      visit_expression(expr.right, visit_import);
      return;

    case "lam":
    case "rec":
      visit_expression(expr.body, visit_import);
      return;

    case "app":
      visit_expression(expr.func, visit_import);

      for (const arg of expr.args) {
        visit_expression(arg, visit_import);
      }

      if (expr.arg !== undefined) {
        visit_expression(expr.arg, visit_import);
      }
      return;

    case "product":
    case "shape":
      for (const entry of expr.entries) {
        visit_expression(entry.value, visit_import);
      }
      return;

    case "array":
      for (const item of expr.items) {
        visit_expression(item, visit_import);
      }

      if (expr.rest !== undefined) {
        visit_expression(expr.rest, visit_import);
      }
      return;

    case "array_repeat":
      visit_expression(expr.value, visit_import);
      visit_expression(expr.length, visit_import);
      return;

    case "block":
      visit_statements(expr.statements, visit_import);
      return;

    case "comptime":
      visit_expression(expr.expr, visit_import);
      return;

    case "borrow":
    case "freeze":
      visit_expression(expr.value, visit_import);
      return;

    case "scratch":
      visit_expression(expr.body, visit_import);
      return;

    case "loop":
      visit_statements(expr.body, visit_import);
      return;

    case "captured":
      visit_expression(expr.expr, visit_import);
      return;

    case "handler":
      for (const state of expr.state) {
        visit_expression(state.value, visit_import);
      }

      for (const clause of expr.clauses) {
        visit_expression(clause.body, visit_import);
      }

      visit_expression(expr.return_clause.body, visit_import);
      return;

    case "try_with":
      visit_expression(expr.body, visit_import);
      visit_expression(expr.handler, visit_import);
      return;

    case "with":
      visit_expression(expr.base, visit_import);
      visit_fields(expr.fields, visit_import);
      return;

    case "struct_value":
      visit_expression(expr.type_expr, visit_import);
      visit_fields(expr.fields, visit_import);
      return;

    case "struct_update":
      visit_expression(expr.base, visit_import);
      visit_fields(expr.fields, visit_import);
      return;

    case "type_with":
      visit_expression(expr.base, visit_import);

      for (const member of expr.members) {
        visit_expression(member.name, visit_import);
        visit_expression(member.value, visit_import);
      }
      return;

    case "if":
      visit_expression(expr.cond, visit_import);

      if (expr.cond.tag === "bool") {
        if (expr.cond.value) {
          visit_expression(expr.then_branch, visit_import);
        } else {
          visit_expression(expr.else_branch, visit_import);
        }
        return;
      }

      visit_expression(expr.then_branch, visit_import);
      visit_expression(expr.else_branch, visit_import);
      return;

    case "if_let":
      visit_expression(expr.target, visit_import);

      if (expr.target.tag === "union_case") {
        if (expr.target.name === expr.case_name) {
          visit_expression(expr.then_branch, visit_import);
        } else {
          visit_expression(expr.else_branch, visit_import);
        }
        return;
      }

      visit_expression(expr.then_branch, visit_import);
      visit_expression(expr.else_branch, visit_import);
      return;

    case "field":
      visit_expression(expr.object, visit_import);
      return;

    case "index":
      visit_expression(expr.object, visit_import);
      visit_expression(expr.index, visit_import);
      return;

    case "is":
    case "as":
      visit_expression(expr.value, visit_import);
      return;

    case "match":
      visit_expression(expr.target, visit_import);

      for (const arm of expr.arms) {
        if (arm.guard !== undefined) {
          visit_expression(arm.guard, visit_import);
        }

        visit_expression(arm.body, visit_import);
      }
      return;

    case "union_case":
      if (expr.value !== undefined) {
        visit_expression(expr.value, visit_import);
      }

      if (expr.type_expr !== undefined) {
        visit_expression(expr.type_expr, visit_import);
      }
      return;
  }

  expr satisfies never;
  throw new Error("panic");
}

function visit_fields(
  fields: import("./ast.ts").Field[],
  visit_import: (expr: Extract<FrontExpr, { tag: "import" }>) => void,
): void {
  for (const field of fields) {
    visit_expression(field.value, visit_import);
  }
}
