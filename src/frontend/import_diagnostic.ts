import type { FrontExpr, Source, Stmt } from "./ast.ts";
import { parse_source_with_diagnostics } from "./parser.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
} from "./semantic_diagnostic.ts";
import { bundled_source_text } from "./prelude.ts";

export type SourceImportResolver = (uri: string) => string | undefined;

type SourceIncludeExpression = {
  expr: Extract<FrontExpr, { tag: "app" }>;
  path: string;
};

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

  for (const included of source_include_expressions(source)) {
    const diagnostic = validate_source_include(
      included,
      uri,
      included.expr,
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

  visit_statements(source.statements, (expr) => {
    if (expr.tag === "import") {
      imports.push(expr);
    }
  });
  return imports;
}

function source_include_expressions(source: Source): SourceIncludeExpression[] {
  const includes: SourceIncludeExpression[] = [];

  visit_statements(source.statements, (expr) => {
    const included = source_include_expression(expr);

    if (included !== undefined) {
      includes.push(included);
    }
  });
  return includes;
}

export function validate_source_import_context(
  source: Source,
): SourceDiagnostic[] {
  const imported = source_import_expressions(source).find((candidate) =>
    bundled_source_text(candidate.path) === undefined
  );

  if (imported !== undefined) {
    return [source_diagnostic(
      "DUCK2500",
      "Cannot resolve import without a source URI and import resolver",
      imported,
    )];
  }

  const included = source_include_expressions(source).find((candidate) =>
    bundled_source_text(new URL(candidate.path, "file:///").href) === undefined
  );

  if (included === undefined) {
    return [];
  }

  return [source_diagnostic(
    "DUCK2500",
    "Cannot resolve include without a source URI and import resolver",
    included.expr,
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

  for (const included of source_include_expressions(dependency.source)) {
    const diagnostic = validate_source_include(
      included,
      dependency_uri,
      root_subject,
      validation,
    );

    if (diagnostic !== undefined) {
      return diagnostic;
    }
  }

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

function validate_source_include(
  included: SourceIncludeExpression,
  uri: string,
  root_subject: FrontExpr,
  validation: ImportValidation,
): SourceDiagnostic | undefined {
  let dependency_uri: string;

  try {
    dependency_uri = new URL(included.path, uri).href;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return source_diagnostic(
      "DUCK2505",
      "Invalid include URI: " + included.path,
      root_subject,
    );
  }

  const bundled = bundled_source_text(dependency_uri);

  if (
    bundled !== undefined ||
    validation.resolve_import(dependency_uri) !== undefined
  ) {
    return undefined;
  }

  return source_diagnostic(
    "DUCK2502",
    "Include dependency does not exist: " + included.path,
    root_subject,
  );
}

function source_include_expression(
  expr: FrontExpr,
): SourceIncludeExpression | undefined {
  if (
    expr.tag !== "app" || expr.func.tag !== "var" ||
    expr.func.name !== "@include" || expr.args.length !== 1
  ) {
    return undefined;
  }

  const path = expr.args[0];

  if (
    path === undefined || path.tag !== "text" || path.encoding !== undefined
  ) {
    return undefined;
  }

  return { expr, path: path.value };
}

function visit_statements(
  statements: Stmt[],
  visit_expr: (expr: FrontExpr) => void,
): void {
  for (const stmt of statements) {
    visit_statement(stmt, visit_expr);
  }
}

function visit_statement(
  stmt: Stmt,
  visit_expr: (expr: FrontExpr) => void,
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
      visit_expression(stmt.value, visit_expr);
      return;

    case "index_assign":
      visit_expression(stmt.index, visit_expr);
      visit_expression(stmt.value, visit_expr);
      return;

    case "for_range":
      visit_expression(stmt.start, visit_expr);
      visit_expression(stmt.end, visit_expr);
      visit_expression(stmt.step, visit_expr);
      visit_statements(stmt.body, visit_expr);
      return;

    case "for_collection":
      visit_expression(stmt.collection, visit_expr);
      visit_statements(stmt.body, visit_expr);
      return;

    case "if_stmt":
      visit_expression(stmt.cond, visit_expr);

      if (stmt.cond.tag !== "bool" || stmt.cond.value) {
        visit_statements(stmt.body, visit_expr);
      }
      return;

    case "if_let_stmt":
      visit_expression(stmt.target, visit_expr);

      if (
        stmt.target.tag !== "union_case" ||
        stmt.target.name === stmt.case_name
      ) {
        visit_statements(stmt.body, visit_expr);
      }
      return;

    case "type_check":
      visit_expression(stmt.target, visit_expr);
      return;

    case "break":
      if (stmt.value !== undefined) {
        visit_expression(stmt.value, visit_expr);
      }
      return;

    case "return":
      visit_expression(stmt.value, visit_expr);
      return;

    case "expr":
      visit_expression(stmt.expr, visit_expr);
      return;
  }

  stmt satisfies never;
  throw new Error("@panic");
}

function visit_expression(
  expr: FrontExpr,
  visit_expr: (expr: FrontExpr) => void,
): void {
  visit_expr(expr);

  switch (expr.tag) {
    case "import":
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
      visit_expression(expr.left, visit_expr);
      visit_expression(expr.right, visit_expr);
      return;

    case "lam":
    case "rec":
      visit_expression(expr.body, visit_expr);
      return;

    case "app":
      visit_expression(expr.func, visit_expr);

      for (const arg of expr.args) {
        visit_expression(arg, visit_expr);
      }

      if (expr.arg !== undefined) {
        visit_expression(expr.arg, visit_expr);
      }
      return;

    case "product":
    case "shape":
      for (const entry of expr.entries) {
        visit_expression(entry.value, visit_expr);
      }
      return;

    case "array":
      for (const item of expr.items) {
        visit_expression(item, visit_expr);
      }

      if (expr.rest !== undefined) {
        visit_expression(expr.rest, visit_expr);
      }
      return;

    case "array_repeat":
      visit_expression(expr.value, visit_expr);
      visit_expression(expr.length, visit_expr);
      return;

    case "block":
      visit_statements(expr.statements, visit_expr);
      return;

    case "comptime":
      visit_expression(expr.expr, visit_expr);
      return;

    case "borrow":
    case "freeze":
      visit_expression(expr.value, visit_expr);
      return;

    case "scratch":
      visit_expression(expr.body, visit_expr);
      return;

    case "loop":
      visit_statements(expr.body, visit_expr);
      return;

    case "captured":
      visit_expression(expr.expr, visit_expr);
      return;

    case "handler":
      for (const state of expr.state) {
        visit_expression(state.value, visit_expr);
      }

      for (const clause of expr.clauses) {
        visit_expression(clause.body, visit_expr);
      }

      visit_expression(expr.return_clause.body, visit_expr);
      return;

    case "try_with":
      visit_expression(expr.body, visit_expr);
      visit_expression(expr.handler, visit_expr);
      return;

    case "with":
      visit_expression(expr.base, visit_expr);
      visit_fields(expr.fields, visit_expr);
      return;

    case "struct_value":
      visit_expression(expr.type_expr, visit_expr);
      visit_fields(expr.fields, visit_expr);
      return;

    case "struct_update":
      visit_expression(expr.base, visit_expr);
      visit_fields(expr.fields, visit_expr);
      return;

    case "type_with":
      visit_expression(expr.base, visit_expr);

      for (const member of expr.members) {
        visit_expression(member.name, visit_expr);
        visit_expression(member.value, visit_expr);
      }
      return;

    case "if":
      visit_expression(expr.cond, visit_expr);

      if (expr.cond.tag === "bool") {
        if (expr.cond.value) {
          visit_expression(expr.then_branch, visit_expr);
        } else {
          visit_expression(expr.else_branch, visit_expr);
        }
        return;
      }

      visit_expression(expr.then_branch, visit_expr);
      visit_expression(expr.else_branch, visit_expr);
      return;

    case "if_let":
      visit_expression(expr.target, visit_expr);

      if (expr.target.tag === "union_case") {
        if (expr.target.name === expr.case_name) {
          visit_expression(expr.then_branch, visit_expr);
        } else {
          visit_expression(expr.else_branch, visit_expr);
        }
        return;
      }

      visit_expression(expr.then_branch, visit_expr);
      visit_expression(expr.else_branch, visit_expr);
      return;

    case "field":
      visit_expression(expr.object, visit_expr);
      return;

    case "index":
      visit_expression(expr.object, visit_expr);
      visit_expression(expr.index, visit_expr);
      return;

    case "is":
    case "as":
      visit_expression(expr.value, visit_expr);
      return;

    case "match":
      visit_expression(expr.target, visit_expr);

      for (const arm of expr.arms) {
        if (arm.guard !== undefined) {
          visit_expression(arm.guard, visit_expr);
        }

        visit_expression(arm.body, visit_expr);
      }
      return;

    case "union_case":
      if (expr.value !== undefined) {
        visit_expression(expr.value, visit_expr);
      }

      if (expr.type_expr !== undefined) {
        visit_expression(expr.type_expr, visit_expr);
      }
      return;
  }

  expr satisfies never;
  throw new Error("@panic");
}

function visit_fields(
  fields: import("./ast.ts").Field[],
  visit_expr: (expr: FrontExpr) => void,
): void {
  for (const field of fields) {
    visit_expression(field.value, visit_expr);
  }
}
