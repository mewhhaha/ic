import type {
  FrontExpr,
  ModuleHeader,
  Param,
  Pattern,
  PatternMode,
  Source as SourceNode,
  Stmt,
} from "./ast.ts";
import { parse_source } from "./parser.ts";
import { pattern_bindings } from "./pattern.ts";
import { bundled_source_text } from "./prelude.ts";
import { has_source_span, inherit_source_span } from "./syntax.ts";

export type SourceTextResolver = (uri: string) => string | undefined;

type ImportResolution = {
  declarations: NonNullable<SourceNode["declarations"]>;
  merged_uris: Set<string>;
  cache: Map<string, SourceNode>;
  resolve_text: SourceTextResolver;
  require_module: boolean;
  bundled_only: boolean;
};

const projected_const_module_imports = new WeakSet<FrontExpr>();

export function is_projected_const_module_import(value: FrontExpr): boolean {
  return projected_const_module_imports.has(value);
}

export function load_source(path: string): SourceNode {
  const url = source_file_url(path);
  return load_source_url(url, [], true, new Map());
}

export function load_source_fragment_file(path: string): SourceNode {
  const url = source_file_url(path);
  return load_source_url(url, [], false, new Map());
}

export function source_file_url(path: string): URL {
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

export function resolve_source_imports(
  source: SourceNode,
  uri: string,
  resolve_text: SourceTextResolver,
): SourceNode {
  const base = new URL(uri);
  const declarations = [...(source.declarations || [])];
  const resolution: ImportResolution = {
    declarations,
    merged_uris: new Set(),
    cache: new Map(),
    resolve_text,
    require_module: false,
    bundled_only: false,
  };

  const resolved = resolve_imports(source, base, [base.href], resolution);
  return { ...resolved, declarations };
}

export function resolve_bundled_source_imports(source: SourceNode): SourceNode {
  const declarations = [...(source.declarations || [])];
  const resolution: ImportResolution = {
    declarations,
    merged_uris: new Set(),
    cache: new Map(),
    resolve_text: () => undefined,
    require_module: false,
    bundled_only: true,
  };
  const base = new URL("file:///__duck_source__.duck");
  const resolved = resolve_imports(source, base, [base.href], resolution);
  return { ...resolved, declarations };
}

function load_source_url(
  url: URL,
  stack: string[],
  require_module: boolean,
  cache: Map<string, SourceNode>,
): SourceNode {
  const normalized = new URL(url.href);
  const text = Deno.readTextFileSync(normalized);
  const source = parse_source(text);

  if (require_module) {
    validate_file_module(source, normalized);
  }

  const declarations = [...(source.declarations || [])];
  const resolution: ImportResolution = {
    declarations,
    merged_uris: new Set(),
    cache,
    resolve_text: (uri) => Deno.readTextFileSync(new URL(uri)),
    require_module,
    bundled_only: false,
  };

  const resolved = resolve_imports(
    source,
    normalized,
    [...stack, normalized.href],
    resolution,
  );
  return { ...resolved, declarations };
}

function validate_file_module(source: SourceNode, url: URL): void {
  if (!url.pathname.endsWith(".duck")) {
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
  resolution: ImportResolution,
): SourceNode {
  const declarations = [...(source.declarations || [])];
  const statements = source.statements.map((stmt) =>
    resolve_statement_imports(stmt, base, stack, resolution)
  );

  return {
    tag: "program",
    module: source.module,
    declarations,
    statements,
  };
}

function resolve_statement_imports(
  stmt: Stmt,
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): Stmt {
  const resolved = resolve_statement_imports_untracked(
    stmt,
    base,
    stack,
    resolution,
  );

  if (resolved !== stmt && has_source_span(stmt)) {
    return inherit_source_span(resolved, stmt);
  }

  return resolved;
}

function resolve_statement_imports_untracked(
  stmt: Stmt,
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): Stmt {
  switch (stmt.tag) {
    case "import":
      throw new Error(
        'Statement imports are not supported; use `import "path"` as an expression',
      );

    case "host_import":
    case "continue":
    case "unsupported":
      return stmt;

    case "bind": {
      const was_projected = is_projected_const_module_import(stmt.value);
      let value = resolve_expression_imports(
        stmt.value,
        base,
        stack,
        resolution,
      );
      const selected_exports = direct_module_import_exports(stmt);

      if (selected_exports !== undefined) {
        value = project_module_call(value, selected_exports);
        projected_const_module_imports.add(value);
      } else if (was_projected) {
        projected_const_module_imports.add(value);
      }

      return { ...stmt, value };
    }

    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
    case "assign":
      return {
        ...stmt,
        value: resolve_expression_imports(stmt.value, base, stack, resolution),
      };

    case "index_assign":
      return {
        ...stmt,
        index: resolve_expression_imports(stmt.index, base, stack, resolution),
        value: resolve_expression_imports(stmt.value, base, stack, resolution),
      };

    case "for_range":
      return {
        ...stmt,
        start: resolve_expression_imports(stmt.start, base, stack, resolution),
        end: resolve_expression_imports(stmt.end, base, stack, resolution),
        step: resolve_expression_imports(stmt.step, base, stack, resolution),
        body: resolve_statement_list_imports(
          stmt.body,
          base,
          stack,
          resolution,
        ),
      };

    case "for_collection":
      return {
        ...stmt,
        collection: resolve_expression_imports(
          stmt.collection,
          base,
          stack,
          resolution,
        ),
        body: resolve_statement_list_imports(
          stmt.body,
          base,
          stack,
          resolution,
        ),
      };

    case "if_stmt": {
      const cond = resolve_expression_imports(
        stmt.cond,
        base,
        stack,
        resolution,
      );

      if (cond.tag === "bool" && !cond.value) {
        return { ...stmt, cond };
      }

      return {
        ...stmt,
        cond,
        body: resolve_statement_list_imports(
          stmt.body,
          base,
          stack,
          resolution,
        ),
      };
    }

    case "if_let_stmt": {
      const target = resolve_expression_imports(
        stmt.target,
        base,
        stack,
        resolution,
      );

      if (
        target.tag === "union_case" && target.name !== stmt.case_name
      ) {
        return { ...stmt, target };
      }

      return {
        ...stmt,
        target,
        body: resolve_statement_list_imports(
          stmt.body,
          base,
          stack,
          resolution,
        ),
      };
    }

    case "type_check":
      return {
        ...stmt,
        target: resolve_expression_imports(
          stmt.target,
          base,
          stack,
          resolution,
        ),
      };

    case "break":
      if (stmt.value === undefined) {
        return stmt;
      }

      return {
        ...stmt,
        value: resolve_expression_imports(stmt.value, base, stack, resolution),
      };

    case "return":
      return {
        ...stmt,
        value: resolve_expression_imports(stmt.value, base, stack, resolution),
      };

    case "expr":
      return {
        ...stmt,
        expr: resolve_expression_imports(stmt.expr, base, stack, resolution),
      };
  }

  stmt satisfies never;
  throw new Error("@panic");
}

function resolve_statement_list_imports(
  statements: Stmt[],
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): Stmt[] {
  return statements.map((stmt) =>
    resolve_statement_imports(stmt, base, stack, resolution)
  );
}

function resolve_expression_imports(
  expr: FrontExpr,
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): FrontExpr {
  const resolved = resolve_expression_imports_untracked(
    expr,
    base,
    stack,
    resolution,
  );

  if (resolved !== expr && has_source_span(expr)) {
    return inherit_source_span(resolved, expr);
  }

  return resolved;
}

function resolve_expression_imports_untracked(
  expr: FrontExpr,
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): FrontExpr {
  switch (expr.tag) {
    case "import":
      return resolve_import_expression(expr, base, stack, resolution);

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
      return expr;

    case "prim":
      return {
        ...expr,
        left: resolve_expression_imports(expr.left, base, stack, resolution),
        right: resolve_expression_imports(expr.right, base, stack, resolution),
      };

    case "lam":
    case "rec":
      return {
        ...expr,
        body: resolve_expression_imports(expr.body, base, stack, resolution),
      };

    case "app": {
      const args = expr.args.map((arg) =>
        resolve_expression_imports(arg, base, stack, resolution)
      );

      return {
        ...expr,
        func: resolve_expression_imports(expr.func, base, stack, resolution),
        args,
        arg: expr.arg === undefined
          ? undefined
          : resolve_expression_imports(expr.arg, base, stack, resolution),
      };
    }

    case "product":
    case "shape":
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          ...entry,
          value: resolve_expression_imports(
            entry.value,
            base,
            stack,
            resolution,
          ),
        })),
      };

    case "array":
      return {
        ...expr,
        items: expr.items.map((item) =>
          resolve_expression_imports(item, base, stack, resolution)
        ),
        rest: expr.rest === undefined
          ? undefined
          : resolve_expression_imports(expr.rest, base, stack, resolution),
      };

    case "array_repeat":
      return {
        ...expr,
        value: resolve_expression_imports(expr.value, base, stack, resolution),
        length: resolve_expression_imports(
          expr.length,
          base,
          stack,
          resolution,
        ),
      };

    case "block":
      return {
        ...expr,
        statements: resolve_statement_list_imports(
          expr.statements,
          base,
          stack,
          resolution,
        ),
      };

    case "comptime":
      return {
        ...expr,
        expr: resolve_expression_imports(expr.expr, base, stack, resolution),
      };

    case "borrow":
    case "freeze":
      return {
        ...expr,
        value: resolve_expression_imports(expr.value, base, stack, resolution),
      };

    case "scratch":
      return {
        ...expr,
        body: resolve_expression_imports(expr.body, base, stack, resolution),
      };

    case "loop":
      return {
        ...expr,
        body: resolve_statement_list_imports(
          expr.body,
          base,
          stack,
          resolution,
        ),
      };

    case "captured":
      return {
        ...expr,
        expr: resolve_expression_imports(expr.expr, base, stack, resolution),
      };

    case "handler":
      return {
        ...expr,
        state: expr.state.map((state) => ({
          ...state,
          value: resolve_expression_imports(
            state.value,
            base,
            stack,
            resolution,
          ),
        })),
        clauses: expr.clauses.map((clause) => ({
          ...clause,
          body: resolve_expression_imports(
            clause.body,
            base,
            stack,
            resolution,
          ),
        })),
        return_clause: {
          ...expr.return_clause,
          body: resolve_expression_imports(
            expr.return_clause.body,
            base,
            stack,
            resolution,
          ),
        },
      };

    case "try_with":
      return {
        ...expr,
        body: resolve_expression_imports(expr.body, base, stack, resolution),
        handler: resolve_expression_imports(
          expr.handler,
          base,
          stack,
          resolution,
        ),
      };

    case "with":
      return {
        ...expr,
        base: resolve_expression_imports(expr.base, base, stack, resolution),
        fields: resolve_fields(expr.fields, base, stack, resolution),
      };

    case "struct_value":
      return {
        ...expr,
        type_expr: resolve_expression_imports(
          expr.type_expr,
          base,
          stack,
          resolution,
        ),
        fields: resolve_fields(expr.fields, base, stack, resolution),
      };

    case "struct_update":
      return {
        ...expr,
        base: resolve_expression_imports(expr.base, base, stack, resolution),
        fields: resolve_fields(expr.fields, base, stack, resolution),
      };

    case "type_with":
      return {
        ...expr,
        base: resolve_expression_imports(expr.base, base, stack, resolution),
        members: expr.members.map((member) => ({
          name: resolve_expression_imports(
            member.name,
            base,
            stack,
            resolution,
          ),
          value: resolve_expression_imports(
            member.value,
            base,
            stack,
            resolution,
          ),
        })),
      };

    case "if": {
      const cond = resolve_expression_imports(
        expr.cond,
        base,
        stack,
        resolution,
      );

      if (cond.tag === "bool") {
        if (cond.value) {
          return {
            ...expr,
            cond,
            then_branch: resolve_expression_imports(
              expr.then_branch,
              base,
              stack,
              resolution,
            ),
          };
        }

        return {
          ...expr,
          cond,
          else_branch: resolve_expression_imports(
            expr.else_branch,
            base,
            stack,
            resolution,
          ),
        };
      }

      return {
        ...expr,
        cond,
        then_branch: resolve_expression_imports(
          expr.then_branch,
          base,
          stack,
          resolution,
        ),
        else_branch: resolve_expression_imports(
          expr.else_branch,
          base,
          stack,
          resolution,
        ),
      };
    }

    case "if_let": {
      const target = resolve_expression_imports(
        expr.target,
        base,
        stack,
        resolution,
      );

      if (target.tag === "union_case") {
        if (target.name === expr.case_name) {
          return {
            ...expr,
            target,
            then_branch: resolve_expression_imports(
              expr.then_branch,
              base,
              stack,
              resolution,
            ),
          };
        }

        return {
          ...expr,
          target,
          else_branch: resolve_expression_imports(
            expr.else_branch,
            base,
            stack,
            resolution,
          ),
        };
      }

      return {
        ...expr,
        target,
        then_branch: resolve_expression_imports(
          expr.then_branch,
          base,
          stack,
          resolution,
        ),
        else_branch: resolve_expression_imports(
          expr.else_branch,
          base,
          stack,
          resolution,
        ),
      };
    }

    case "field":
      return {
        ...expr,
        object: resolve_expression_imports(
          expr.object,
          base,
          stack,
          resolution,
        ),
      };

    case "index":
      return {
        ...expr,
        object: resolve_expression_imports(
          expr.object,
          base,
          stack,
          resolution,
        ),
        index: resolve_expression_imports(expr.index, base, stack, resolution),
      };

    case "is":
    case "as":
      return {
        ...expr,
        value: resolve_expression_imports(expr.value, base, stack, resolution),
      };

    case "match":
      return {
        ...expr,
        target: resolve_expression_imports(
          expr.target,
          base,
          stack,
          resolution,
        ),
        arms: expr.arms.map((arm) => ({
          ...arm,
          guard: arm.guard === undefined
            ? undefined
            : resolve_expression_imports(arm.guard, base, stack, resolution),
          body: resolve_expression_imports(arm.body, base, stack, resolution),
        })),
      };

    case "union_case":
      return {
        ...expr,
        value: expr.value === undefined
          ? undefined
          : resolve_expression_imports(expr.value, base, stack, resolution),
        type_expr: expr.type_expr === undefined
          ? undefined
          : resolve_expression_imports(expr.type_expr, base, stack, resolution),
      };
  }

  expr satisfies never;
  throw new Error("@panic");
}

function resolve_fields(
  fields: import("./ast.ts").Field[],
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): import("./ast.ts").Field[] {
  return fields.map((field) => ({
    ...field,
    value: resolve_expression_imports(field.value, base, stack, resolution),
  }));
}

function resolve_import_expression(
  expr: Extract<FrontExpr, { tag: "import" }>,
  base: URL,
  stack: string[],
  resolution: ImportResolution,
): FrontExpr {
  const path = expr.path;
  const url = new URL(path, base);
  const href = url.href;

  if (resolution.bundled_only && bundled_source_text(href) === undefined) {
    return expr;
  }

  if (stack.includes(href)) {
    throw new Error("Circular import: " + [...stack, href].join(" -> "));
  }

  let imported = resolution.cache.get(href);

  if (imported === undefined) {
    let text: string | undefined;

    text = bundled_source_text(href);

    if (text === undefined) {
      text = resolution.resolve_text(href);
    }

    if (text === undefined) {
      throw new Error("Import dependency does not exist: " + path);
    }

    const parsed = parse_source(text);

    if (resolution.require_module) {
      validate_file_module(parsed, url);
    }

    if (!resolution.merged_uris.has(href)) {
      resolution.merged_uris.add(href);
      resolution.declarations.push(...(parsed.declarations || []));
    }

    imported = resolve_imports(parsed, url, [...stack, href], resolution);
    resolution.cache.set(href, imported);
  }

  if (imported.module === undefined) {
    throw new Error("Import file must be a module: " + path);
  }

  return module_value(imported.module, imported.statements);
}

function module_value(module: ModuleHeader, statements: Stmt[]): FrontExpr {
  const params = module.params.map((param) => ({
    ...param,
    is_const: true,
  }));

  return {
    tag: "lam",
    pattern: module_pattern(params),
    params,
    body: { tag: "block", statements },
  };
}

function direct_module_import_exports(
  stmt: Extract<Stmt, { tag: "bind" }>,
): Set<string> | undefined {
  if (
    stmt.kind !== "const" || stmt.pattern?.tag !== "product" ||
    stmt.value.tag !== "comptime" || stmt.value.expr.tag !== "app" ||
    stmt.value.expr.func.tag !== "import"
  ) {
    return undefined;
  }

  const exports = new Set<string>();

  for (const entry of stmt.pattern.entries) {
    if (entry.label === undefined) {
      return undefined;
    }

    exports.add(entry.label);
  }

  return exports;
}

function project_module_call(
  value: FrontExpr,
  selected_exports: Set<string>,
): FrontExpr {
  if (value.tag === "comptime") {
    return {
      ...value,
      expr: project_module_call(value.expr, selected_exports),
    };
  }

  if (value.tag !== "app" || value.func.tag !== "lam") {
    return value;
  }

  if (value.func.body.tag !== "block") {
    return value;
  }

  return {
    ...value,
    func: {
      ...value.func,
      body: {
        ...value.func.body,
        statements: project_module_statements(
          value.func.body.statements,
          selected_exports,
        ),
      },
    },
  };
}

function project_module_statements(
  statements: Stmt[],
  selected_exports: Set<string>,
): Stmt[] {
  const final = statements[statements.length - 1];

  if (
    final?.tag !== "return" || final.value.tag !== "struct_value"
  ) {
    return statements;
  }

  const selected_fields = final.value.fields.filter((field) =>
    selected_exports.has(field.name)
  );

  if (selected_fields.length !== selected_exports.size) {
    return statements;
  }

  const bindings = new Map<string, Extract<Stmt, { tag: "bind" }>>();

  for (const statement of statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    if (statement.pattern === undefined) {
      bindings.set(statement.name, statement);
      continue;
    }

    for (const binding of pattern_bindings(statement.pattern)) {
      bindings.set(binding.name, statement);
    }
  }

  const required = new Set<string>();

  for (const field of selected_fields) {
    collect_top_level_references(field.value, bindings, required);
  }

  const retained: Stmt[] = [];

  for (const statement of statements.slice(0, -1)) {
    if (statement.tag !== "bind") {
      retained.push(statement);
      continue;
    }

    const names = statement.pattern === undefined
      ? [statement.name]
      : pattern_bindings(statement.pattern).map((binding) => binding.name);

    if (!names.some((name) => required.has(name))) {
      continue;
    }

    collect_top_level_references(statement.value, bindings, required);
    retained.push(project_required_pattern_binding(statement, required));
  }

  retained.push({
    ...final,
    value: { ...final.value, fields: selected_fields },
  });
  return retained;
}

function collect_top_level_references(
  value: unknown,
  bindings: Map<string, Extract<Stmt, { tag: "bind" }>>,
  required: Set<string>,
): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === null || typeof current !== "object") {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (
      "tag" in current && (current.tag === "var" || current.tag === "linear") &&
      "name" in current && typeof current.name === "string" &&
      bindings.has(current.name) && !required.has(current.name)
    ) {
      required.add(current.name);
      const binding = bindings.get(current.name);

      if (binding !== undefined) {
        pending.push(binding.value);
      }
    }

    pending.push(...Object.values(current));
  }
}

function project_required_pattern_binding(
  statement: Extract<Stmt, { tag: "bind" }>,
  required: Set<string>,
): Extract<Stmt, { tag: "bind" }> {
  if (statement.pattern?.tag !== "product") {
    return statement;
  }

  const entries = statement.pattern.entries.filter((entry) =>
    pattern_bindings(entry.pattern).some((binding) =>
      required.has(binding.name)
    )
  );
  const selected_exports = new Set<string>();

  for (const entry of entries) {
    if (entry.label === undefined) {
      return statement;
    }

    selected_exports.add(entry.label);
  }

  const value = project_module_call(statement.value, selected_exports);

  if (is_projected_const_module_import(statement.value)) {
    projected_const_module_imports.add(value);
  }

  return {
    ...statement,
    pattern: { ...statement.pattern, entries },
    value,
  };
}

function module_pattern(params: Param[]): Pattern {
  if (params.length === 0) {
    return { tag: "unit" };
  }

  if (params.length === 1) {
    const param = params[0];

    if (param === undefined) {
      throw new Error("Missing module parameter");
    }

    return param_pattern(param);
  }

  return {
    tag: "product",
    entries: params.map((param) => ({ pattern: param_pattern(param) })),
  };
}

function param_pattern(param: Param): Pattern {
  let mode: PatternMode = "default";

  if (param.is_const) {
    mode = "const";
  }

  if (param.is_linear) {
    mode = "linear";
  }

  return {
    tag: "binding",
    name: param.name,
    mode,
    annotation: param.annotation,
    type_annotation: param.type_annotation,
  };
}
