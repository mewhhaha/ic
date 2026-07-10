import type { FrontExpr, Source as SourceNode, Stmt } from "./ast.ts";
import { parse_source } from "./parser.ts";

export function load_source(path: string): SourceNode {
  const url = source_file_url(path);
  return load_source_url(url, [], true);
}

export function load_source_fragment_file(path: string): SourceNode {
  const url = source_file_url(path);
  return load_source_url(url, [], false);
}

function source_file_url(path: string): URL {
  try {
    const url = new URL(path);

    if (url.protocol === "file:") {
      return url;
    }

    throw new Error("Source path must be a file URL: " + path);
  } catch (_error) {
    let cwd = Deno.cwd();

    if (!cwd.endsWith("/")) {
      cwd += "/";
    }

    return new URL(path, "file://" + cwd);
  }
}

function load_source_url(
  url: URL,
  stack: string[],
  require_module: boolean,
): SourceNode {
  if (stack.includes(url.href)) {
    throw new Error("Circular import: " + url.pathname);
  }

  const text = Deno.readTextFileSync(url);
  const source = parse_source(text);
  if (require_module) {
    validate_file_module(source, url);
  }

  return resolve_imports(
    source,
    url,
    [...stack, url.href],
    require_module,
  );
}

function validate_file_module(source: SourceNode, url: URL): void {
  if (!url.pathname.endsWith(".ix")) {
    return;
  }

  if (!source.module) {
    throw new Error(
      "File module must begin with `module (...) where`: " + url.pathname,
    );
  }

  const last = source.statements[source.statements.length - 1];

  if (!last || last.tag !== "return" || !is_module_record(last.value)) {
    throw new Error(
      "File module must end with `return { ... }`: " + url.pathname,
    );
  }
}

function is_module_record(value: FrontExpr): boolean {
  return value.tag === "struct_value" && value.type_expr.tag === "var" &&
    value.type_expr.name === "object_type";
}

function resolve_imports(
  source: SourceNode,
  base: URL,
  stack: string[],
  require_module: boolean,
): SourceNode {
  const statements: Stmt[] = [];
  const declarations = [...(source.declarations || [])];

  for (const stmt of source.statements) {
    if (stmt.tag !== "import") {
      statements.push(stmt);
      continue;
    }

    const imported = load_source_url(
      new URL(stmt.path, base),
      stack,
      require_module,
    );

    if (imported.module) {
      declarations.push(...(imported.declarations || []));
      statements.push({
        tag: "bind",
        kind: "const",
        name: stmt.name,
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "lam",
          params: imported.module.params,
          body: { tag: "block", statements: imported.statements },
        },
      });
      continue;
    }

    let found = false;

    for (const imported_stmt of imported.statements) {
      if (
        imported_stmt.tag !== "bind" && imported_stmt.tag !== "type_check" &&
        imported_stmt.tag !== "host_import"
      ) {
        throw new Error(
          "Import file can only expose top-level bindings: " + stmt.path,
        );
      }

      if (imported_stmt.tag === "bind" && imported_stmt.name === stmt.name) {
        found = true;
      }

      statements.push(imported_stmt);
    }

    if (!found) {
      throw new Error(
        "Import " + stmt.path + " does not export " + stmt.name,
      );
    }
  }

  return {
    tag: "program",
    module: source.module,
    declarations,
    statements,
  };
}
