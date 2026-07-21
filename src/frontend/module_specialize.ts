import { expect } from "../expect.ts";
import type {
  AttributeGroup,
  FrontExpr,
  Pattern,
  Source,
  Stmt,
  TypeExpr,
} from "./ast.ts";
import { is_projected_const_module_import } from "./load.ts";
import { substitute_front_expr, substitute_front_stmt } from "./substitute.ts";
import { is_builtin_type_name } from "./types.ts";

type ModuleExport = {
  annotation: string | undefined;
  type_annotation: TypeExpr | undefined;
  attribute_groups: AttributeGroup[] | undefined;
  value: FrontExpr;
  callable_name?: string;
  callable_bindings?: Extract<Stmt, { tag: "bind" }>[];
};

export function specialize_const_module_imports(source: Source): Source {
  return { ...source, statements: specialize_statements(source.statements) };
}

function specialize_statements(
  statements: Stmt[],
  retain_inline_imports = false,
): Stmt[] {
  const specialized: Stmt[] = [];
  const imported_values = new Map<string, FrontExpr>();
  const nullary_module_aliases = new Map<
    string,
    Extract<FrontExpr, { tag: "lam" }>
  >();

  for (const original of statements) {
    let statement = original;

    if (
      imported_values.size > 0 &&
      !(original.tag === "bind" &&
        is_projected_const_module_import(original.value))
    ) {
      statement = substitute_imports_in_statement(original, imported_values);
    }
    statement = inline_nullary_module_alias(statement, nullary_module_aliases);
    const imports = specialize_import_binding(statement);

    if (imports === undefined) {
      specialized.push(statement);

      if (statement.tag === "bind") {
        imported_values.delete(statement.name);
        const module_alias = nullary_module_alias_value(statement.value);

        if (statement.kind === "const" && module_alias) {
          nullary_module_aliases.set(statement.name, module_alias);
        } else {
          nullary_module_aliases.delete(statement.name);
        }
      } else if (
        statement.tag === "assign" || statement.tag === "index_assign"
      ) {
        imported_values.delete(statement.name);
        nullary_module_aliases.delete(statement.name);
      }

      continue;
    }

    for (const imported of imports) {
      expect(imported.tag === "bind", "Expected specialized import binding");
      let binding = imported;
      nullary_module_aliases.delete(imported.name);

      if (imported_values.size > 0) {
        const substituted = substitute_imports_in_statement(
          imported,
          imported_values,
        );
        expect(
          substituted.tag === "bind",
          "Expected substituted import binding",
        );
        binding = substituted;
      }

      if (should_inline_imported_value(binding.value)) {
        if (retain_inline_imports) {
          specialized.push(binding);
          continue;
        }

        imported_values.set(binding.name, binding.value);
        continue;
      }

      specialized.push(binding);
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
    (!is_projected_const_module_import(statement.value) &&
      !is_nullary_module_invocation(statement.value))
  ) {
    return undefined;
  }

  let module_call = statement.value;

  if (module_call.tag === "comptime") {
    module_call = module_call.expr;
  }

  const open_nullary_module = statement.opens_import === true &&
    module_call.tag === "app" && module_call.func.tag === "lam" &&
    module_call.func.params.length === 0;
  const exports = module_exports(statement.value, open_nullary_module);

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
      !should_inline_imported_value(exported.value) && !open_nullary_module
    ) {
      return undefined;
    }
  }

  const inline_bindings: Stmt[] = [];
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

    if (
      exported.callable_name !== undefined &&
      exported.callable_bindings !== undefined
    ) {
      bindings.push(...specialize_imported_callables(
        exported.callable_name,
        exported.callable_bindings,
        pattern,
      ));
      continue;
    }

    const binding: Extract<Stmt, { tag: "bind" }> = {
      tag: "bind",
      kind: "const",
      pattern,
      name: pattern.name,
      is_recursive: false,
      is_linear: false,
      annotation,
      type_annotation,
      attribute_groups: exported.attribute_groups,
      value: exported.value,
    };

    if (should_inline_imported_value(binding.value)) {
      inline_bindings.push(binding);
    } else {
      bindings.push(binding);
    }
  }

  return [...inline_bindings, ...bindings];
}

function inline_nullary_module_alias(
  statement: Stmt,
  aliases: Map<string, Extract<FrontExpr, { tag: "lam" }>>,
): Stmt {
  if (
    statement.tag !== "bind" || statement.kind !== "const" ||
    statement.pattern?.tag !== "product"
  ) {
    return statement;
  }

  let call = statement.value;
  let comptime = false;

  if (call.tag === "comptime") {
    comptime = true;
    call = call.expr;
  }

  if (
    call.tag !== "app" || call.func.tag !== "var" ||
    call.args.length !== 0
  ) {
    return statement;
  }

  const module_alias = aliases.get(call.func.name);

  if (!module_alias) {
    return statement;
  }

  let value: FrontExpr = { ...call, func: module_alias };

  if (comptime) {
    expect(
      statement.value.tag === "comptime",
      "Missing comptime nullary module alias call",
    );
    value = { ...statement.value, expr: value };
  }

  return { ...statement, value };
}

function nullary_module_alias_value(
  value: FrontExpr,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  if (value.tag !== "lam" || value.params.length !== 0) {
    return undefined;
  }

  if (value.body.tag !== "block") {
    return undefined;
  }

  const final = value.body.statements[value.body.statements.length - 1];

  if (final?.tag !== "return" || final.value.tag !== "struct_value") {
    return undefined;
  }

  return value;
}

function is_nullary_module_invocation(value: FrontExpr): boolean {
  if (value.tag === "comptime") {
    value = value.expr;
  }

  if (
    value.tag !== "app" || value.args.length !== 0 ||
    value.func.tag !== "lam"
  ) {
    return false;
  }

  return nullary_module_alias_value(value.func) !== undefined;
}

function specialize_imported_callables(
  exported_name: string,
  callable_bindings: Extract<Stmt, { tag: "bind" }>[],
  exported_pattern: Extract<Pattern, { tag: "binding" }>,
): Extract<Stmt, { tag: "bind" }>[] {
  const renamed = new Map<string, FrontExpr>();

  for (const binding of callable_bindings) {
    let name = exported_pattern.name + "#module#" + binding.name;
    if (binding.name === exported_name) {
      name = exported_pattern.name;
    }
    renamed.set(binding.name, { tag: "var", name });
  }

  const specialized: Extract<Stmt, { tag: "bind" }>[] = [];

  for (const binding of callable_bindings) {
    const substituted = substitute_front_stmt(binding, renamed);
    expect(substituted.tag === "bind", "Expected imported callable binding");
    const replacement = renamed.get(binding.name);
    expect(
      replacement?.tag === "var",
      "Missing imported callable name: " + binding.name,
    );
    let annotation = substituted.annotation;
    let type_annotation = substituted.type_annotation;

    if (binding.name === exported_name) {
      if (exported_pattern.annotation !== undefined) {
        annotation = exported_pattern.annotation;
      }
      if (exported_pattern.type_annotation !== undefined) {
        type_annotation = exported_pattern.type_annotation;
      }
    }

    const pattern: Extract<Pattern, { tag: "binding" }> = {
      tag: "binding",
      name: replacement.name,
      mode: "default",
      annotation,
      type_annotation,
    };
    specialized.push({
      ...substituted,
      kind: substituted.kind,
      pattern,
      name: replacement.name,
      is_recursive: substituted.is_recursive,
      managed_export: true,
      is_linear: false,
      annotation,
      type_annotation,
    });
  }

  return specialized;
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
  retain_inline_imports = false,
): Map<string, ModuleExport> | undefined {
  if (value.tag === "comptime") {
    return module_exports(value.expr, retain_inline_imports);
  }

  if (
    value.tag !== "app" || value.func.tag !== "lam" ||
    value.func.body.tag !== "block"
  ) {
    return undefined;
  }

  const statements = specialize_statements(
    value.func.body.statements,
    retain_inline_imports,
  );
  const final = statements[statements.length - 1];

  if (final?.tag !== "return" || final.value.tag !== "struct_value") {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();
  const callable_bindings = new Map<
    string,
    Extract<Stmt, { tag: "bind" }>
  >();
  const annotations = new Map<
    string,
    {
      annotation: string | undefined;
      type_annotation: TypeExpr | undefined;
      attribute_groups: AttributeGroup[] | undefined;
    }
  >();

  for (const statement of statements.slice(0, -1)) {
    if (
      statement.tag === "bind" && statement.kind === "const" &&
      statement.pattern?.tag === "product"
    ) {
      const nested_exports = module_exports(statement.value);

      if (nested_exports !== undefined) {
        for (const entry of statement.pattern.entries) {
          if (entry.label === undefined || entry.pattern.tag !== "binding") {
            continue;
          }

          const exported = nested_exports.get(entry.label);
          expect(exported, "Missing nested module export: " + entry.label);
          if (
            exported.callable_name !== undefined &&
            exported.callable_bindings !== undefined
          ) {
            const nested_callables = specialize_imported_callables(
              exported.callable_name,
              exported.callable_bindings,
              entry.pattern,
            );
            for (const callable of nested_callables) {
              callable_bindings.set(callable.name, callable);
            }
            replacements.set(entry.pattern.name, {
              tag: "var",
              name: entry.pattern.name,
            });
          } else {
            replacements.set(entry.pattern.name, exported.value);
          }
          annotations.set(entry.pattern.name, {
            annotation: exported.annotation,
            type_annotation: exported.type_annotation,
            attribute_groups: exported.attribute_groups,
          });
        }
      }

      continue;
    }

    if (
      statement.tag === "bind" &&
      statement.pattern?.tag === "binding" &&
      (statement.value.tag === "lam" || statement.value.tag === "rec") &&
      (statement.kind === "let" ||
        (statement.type_annotation?.tag === "arrow" &&
          !(statement.type_annotation.result.tag === "name" &&
            is_builtin_type_name(statement.type_annotation.result.name)) &&
          statement.value.params.every((param) => !param.is_const)))
    ) {
      const substituted = substitute_front_stmt(statement, replacements);
      expect(substituted.tag === "bind", "Expected recursive module binding");
      const callable = {
        ...substituted,
        value: annotate_callable_parameters(
          substituted.value,
          substituted.type_annotation,
        ),
      };
      callable_bindings.set(statement.name, callable);
      annotations.set(statement.name, {
        annotation: callable.annotation,
        type_annotation: callable.type_annotation,
        attribute_groups: callable.attribute_groups,
      });
      continue;
    }

    if (
      statement.tag !== "bind" || statement.kind !== "const" ||
      statement.pattern !== undefined && statement.pattern.tag !== "binding"
    ) {
      continue;
    }

    const substituted_statement = substitute_front_stmt(
      statement,
      replacements,
    );
    expect(
      substituted_statement.tag === "bind",
      "Expected substituted module binding",
    );
    const substituted = annotate_callable_parameters(
      substituted_statement.value,
      statement.type_annotation,
    );
    replacements.set(statement.name, substituted);
    annotations.set(statement.name, {
      annotation: statement.annotation,
      type_annotation: statement.type_annotation,
      attribute_groups: substituted_statement.attribute_groups,
    });
  }

  const exports = new Map<string, ModuleExport>();

  for (const field of final.value.fields) {
    let annotation: string | undefined;
    let type_annotation: TypeExpr | undefined;
    let attribute_groups: AttributeGroup[] | undefined;

    if (field.value.tag === "var") {
      const evidence = annotations.get(field.value.name);

      if (evidence !== undefined) {
        annotation = evidence.annotation;
        type_annotation = evidence.type_annotation;
        attribute_groups = evidence.attribute_groups;
      }
    }

    const exported_value = substitute_front_expr(field.value, replacements);
    let callable_name: string | undefined;
    let reachable_callables: Extract<Stmt, { tag: "bind" }>[] | undefined;

    if (
      exported_value.tag === "var" &&
      callable_bindings.has(exported_value.name)
    ) {
      callable_name = exported_value.name;
      reachable_callables = collect_reachable_callables(
        callable_name,
        callable_bindings,
      );
    } else if (
      exported_value.tag === "lam" || exported_value.tag === "rec"
    ) {
      const dependencies = referenced_callable_names(
        exported_value,
        callable_bindings,
      );

      if (dependencies.length > 0) {
        callable_name = field.name + "#export";
        const pattern: Extract<Pattern, { tag: "binding" }> = {
          tag: "binding",
          name: callable_name,
          mode: "default",
          annotation,
          type_annotation,
        };
        const root: Extract<Stmt, { tag: "bind" }> = {
          tag: "bind",
          kind: "let",
          pattern,
          name: callable_name,
          is_recursive: false,
          is_linear: false,
          annotation,
          type_annotation,
          value: exported_value,
        };
        const available = new Map(callable_bindings);
        available.set(callable_name, root);
        reachable_callables = collect_reachable_callables(
          callable_name,
          available,
        );
      }
    }

    exports.set(field.name, {
      annotation,
      type_annotation,
      attribute_groups,
      value: exported_value,
      callable_name,
      callable_bindings: reachable_callables,
    });
  }

  return exports;
}

function annotate_callable_parameters(
  value: FrontExpr,
  annotation: TypeExpr | undefined,
): FrontExpr {
  if (
    (value.tag !== "lam" && value.tag !== "rec") ||
    annotation?.tag !== "arrow"
  ) {
    return value;
  }

  let parameter_types: TypeExpr[];
  if (value.params.length === 1) {
    parameter_types = [annotation.param];
  } else if (
    annotation.param.tag === "product" &&
    annotation.param.entries.length === value.params.length
  ) {
    parameter_types = annotation.param.entries.map((entry) => entry.type_expr);
  } else {
    return value;
  }

  const params = value.params.map((param, index) => {
    if (param.annotation !== undefined || param.type_annotation !== undefined) {
      return param;
    }
    const type = parameter_types[index];
    expect(type, "Missing imported callable parameter type");

    if (type.tag === "name") {
      return { ...param, annotation: type.name, type_annotation: type };
    }
    return { ...param, type_annotation: type };
  });
  return { ...value, params };
}

function collect_reachable_callables(
  root: string,
  available: Map<string, Extract<Stmt, { tag: "bind" }>>,
): Extract<Stmt, { tag: "bind" }>[] {
  const reached = new Set<string>();
  const ordered: Extract<Stmt, { tag: "bind" }>[] = [];

  const visit = (name: string): void => {
    if (reached.has(name)) {
      return;
    }
    reached.add(name);
    const binding = available.get(name);
    expect(binding, "Missing recursive module callable: " + name);
    const dependencies = referenced_callable_names(binding.value, available);

    for (const dependency of dependencies) {
      visit(dependency);
    }

    ordered.push(binding);
  };

  visit(root);
  return ordered;
}

function referenced_callable_names(
  value: FrontExpr,
  available: Map<string, Extract<Stmt, { tag: "bind" }>>,
): string[] {
  const referenced = new Set<string>();

  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }
    const node = candidate as Record<string, unknown>;
    if (
      node.tag === "var" && typeof node.name === "string" &&
      available.has(node.name)
    ) {
      referenced.add(node.name);
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };

  visit(value);
  return [...referenced];
}
