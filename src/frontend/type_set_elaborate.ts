import { expect } from "../expect.ts";
import type {
  Env,
  FrontExpr,
  MatchArm,
  Param,
  Pattern,
  Source,
  Stmt,
  TypeExpr,
  TypeField,
} from "./ast.ts";
import {
  intersect_sem_types,
  sem_type_from_expr,
  sem_type_key,
  sem_type_subtype,
  sem_types_are_disjoint,
  type SemType,
} from "./semantic_type.ts";
import { substitute_front_expr } from "./substitute.ts";
import { front_type_value_for_semantic_type } from "./type_declaration.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import {
  constant_repeat_length,
  elaborate_array_repeat_expr,
  elaborate_product_as_expr,
} from "./aggregate.ts";
import { pattern_bindings } from "./pattern.ts";
import {
  describe_comptime_cases,
  describe_comptime_fields,
  describe_comptime_type,
} from "./comptime_descriptor.ts";
import { resolve_comptime_type } from "./comptime_value.ts";
import { lookup_field } from "./fields.ts";
import { format_expr } from "./format.ts";
import { normalize_fixed_array_type_lengths } from "./fixed_array_type.ts";
import { is_builtin_type_name } from "./types.ts";

type TypeSetBinding = {
  annotation: string | undefined;
  compiletime_only?: boolean;
  value: FrontExpr | undefined;
  union_type?: Extract<FrontExpr, { tag: "union_type" }>;
};

type TypeSetConstRecursion = {
  active: Set<string>;
  memo: Map<string, FrontExpr>;
  name: string;
  target: Extract<FrontExpr, { tag: "rec" }>;
};

type TypeSetConstEvaluation = {
  recursions: Map<FrontExpr, TypeSetConstRecursion>;
  steps: number;
};

type TypeSetScope = {
  bindings: Map<string, TypeSetBinding>;
  const_evaluation: TypeSetConstEvaluation | undefined;
  const_recursion: TypeSetConstRecursion | undefined;
  evaluating_const_call: boolean;
  fresh: { next: number };
  type_values: Map<string, FrontExpr>;
};

function elaborate_comptime_type_intrinsic(
  func: FrontExpr,
  unary_arg: FrontExpr | undefined,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag !== "var") {
    return undefined;
  }

  const binding = scope.bindings.get(func.name);
  let intrinsic: string | undefined;

  if (func.name.startsWith("@type.") || func.name.startsWith("@shape.")) {
    intrinsic = func.name;
  } else if (binding?.value?.tag === "var") {
    intrinsic = binding.value.name;
  } else if (
    binding?.value?.tag === "lam" && binding.value.params.length === 1 &&
    binding.value.body.tag === "app" &&
    binding.value.body.func.tag === "var" &&
    binding.value.body.arg?.tag === "var" &&
    binding.value.body.arg.name === binding.value.params[0]?.name
  ) {
    intrinsic = binding.value.body.func.name;
  }

  let arg = unary_arg;

  if (arg === undefined && args.length === 1) {
    arg = args[0];
  }

  if (intrinsic !== undefined && arg !== undefined) {
    const resolved_arg = unwrap_const_result(
      resolve_scope_const_value(arg, scope),
    );

    if (!scope_const_expr_known(resolved_arg, scope)) {
      return undefined;
    }

    arg = resolved_arg;
  }

  if (intrinsic === "@shape.entries") {
    expect(arg, "Missing shape entries argument");
    return elaborate_shape_entries(arg);
  }

  if (intrinsic === "@type.product") {
    expect(arg, "Missing product constructor argument");
    return elaborate_product_type_constructor(arg, scope);
  }

  if (intrinsic === "@type.namespace") {
    expect(arg, "Missing type namespace argument");
    return elaborate_type_namespace(arg, scope);
  }

  return undefined;
}

function prelude_type_expr(value: FrontExpr): TypeExpr {
  if (value.tag === "var" || value.tag === "type_name") {
    return { tag: "name", name: value.name };
  }

  if (value.tag === "set_type") {
    return value.type_expr;
  }

  if (value.tag === "with") {
    return prelude_type_expr(value.base);
  }

  if (value.tag === "struct_type") {
    return {
      tag: "product",
      entries: value.fields.map((field) => {
        let type_expr = field.set_member;

        if (type_expr === undefined) {
          type_expr = parse_type_expr(tokenize(field.type_name));
        }

        return { label: field.name, type_expr };
      }),
    };
  }

  if (value.tag === "product") {
    return {
      tag: "product",
      entries: value.entries.map((entry) => ({
        label: entry.label,
        type_expr: prelude_type_expr(entry.value),
      })),
    };
  }

  if (value.tag === "borrow") {
    return { tag: "borrow", value: prelude_type_expr(value.value) };
  }

  if (value.tag === "freeze") {
    return { tag: "frozen", value: prelude_type_expr(value.value) };
  }

  if (value.tag === "app") {
    let type_expr = prelude_type_expr(value.func);

    for (const arg of value.args) {
      type_expr = {
        tag: "apply",
        func: type_expr,
        arg: prelude_type_expr(arg),
      };
    }

    return type_expr;
  }

  throw new Error(
    "Type constructor member must be a compile-time type, got " + value.tag,
  );
}

function elaborate_product_type_constructor(
  value: FrontExpr,
  scope: TypeSetScope,
): Extract<FrontExpr, { tag: "struct_type" }> {
  expect(value.tag === "product", "product expects ordered slot descriptors");
  expect(value.entries.length > 0, "product expects at least one slot");

  const fields: TypeField[] = [];

  for (const entry of value.entries) {
    expect(
      entry.label === undefined,
      "product slot descriptors cannot have outer labels",
    );
    expect(entry.value.tag === "shape", "product slot must be a shape");
    const name_value = ordered_shape_field(entry.value, "name");
    const type_value = ordered_shape_field(entry.value, "type");
    expect(
      name_value.tag === "text" && name_value.value.length > 0,
      "product slot " + fields.length.toString() +
        " requires a non-empty Text name",
    );
    expect(
      compiletime_type_value(type_value, scope),
      "product slot " + name_value.value + " requires a compile-time type",
    );

    const type_expr = prelude_type_expr(type_value);
    const field: TypeField = {
      name: name_value.value,
      type_name: format_type_expr(type_expr),
    };

    if (type_expr.tag !== "name") {
      field.set_member = type_expr;
    }

    fields.push(field);
  }

  return { tag: "struct_type", fields };
}

function elaborate_shape_entries(value: FrontExpr): FrontExpr {
  expect(value.tag === "shape", "shape entries expects an ordered shape");
  expect(value.entries.length > 0, "shape entries expects at least one field");

  return {
    tag: "product",
    entries: value.entries.map((entry, index) => {
      expect(entry.label !== undefined, "Shape entry requires a label");
      return {
        value: {
          tag: "shape",
          entries: [
            { label: "name", value: { tag: "text", value: entry.label } },
            { label: "type", value: entry.value },
            {
              label: "index",
              value: { tag: "num", type: "i32", value: index },
            },
          ],
        },
      };
    }),
  };
}

function elaborate_type_namespace(
  value: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  expect(
    value.tag === "product" && value.entries.length === 2,
    "type namespace expects a product containing data and methods",
  );
  const data_entry = value.entries[0];
  const methods_entry = value.entries[1];
  expect(data_entry, "Type namespace is missing its data type");
  expect(methods_entry, "Type namespace is missing its methods");
  const data_type = resolve_front_type_value(
    data_entry.value,
    scope.type_values,
    new Set(),
  );
  expect(
    data_type?.tag === "struct_type",
    "Type namespace data must be a product",
  );
  const methods = unwrap_const_result(
    resolve_scope_const_value(methods_entry.value, scope),
  );
  expect(methods.tag === "product", "Type namespace methods must be ordered");
  let namespace: FrontExpr = data_entry.value;
  const names = new Set<string>();

  for (const entry of methods.entries) {
    expect(
      entry.value.tag === "shape",
      "Type namespace method must be a shape",
    );
    const name_value = ordered_shape_field(entry.value, "name");
    const method_value = resolve_scope_const_value(
      ordered_shape_field(entry.value, "value"),
      scope,
    );
    expect(
      name_value.tag === "text" && name_value.value.length > 0,
      "Type namespace method requires a non-empty Text name",
    );
    expect(
      method_value.tag === "lam",
      "Type namespace member " + name_value.value + " must be a function",
    );
    expect(
      !names.has(name_value.value),
      "Duplicate type namespace member: " + name_value.value,
    );
    names.add(name_value.value);
    namespace = {
      tag: "with",
      base: namespace,
      fields: [{ name: name_value.value, value: method_value }],
    };
  }

  return namespace;
}

function ordered_shape_field(
  shape: Extract<FrontExpr, { tag: "shape" }>,
  name: string,
): FrontExpr {
  const entry = shape.entries.find((candidate) => candidate.label === name);
  expect(entry, "Ordered shape is missing field " + name);
  return entry.value;
}

function compiletime_type_value(
  value: FrontExpr,
  scope: TypeSetScope,
): boolean {
  if (
    value.tag === "set_type" || value.tag === "type_name" ||
    value.tag === "struct_type" || value.tag === "union_type"
  ) {
    return true;
  }

  if (value.tag === "var") {
    return true;
  }

  if (value.tag === "product") {
    return value.entries.every((entry) =>
      compiletime_type_value(entry.value, scope)
    );
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return compiletime_type_value(value.value, scope);
  }

  if (value.tag === "app") {
    if (!compiletime_type_value(value.func, scope)) {
      return false;
    }

    return value.args.every((arg) => compiletime_type_value(arg, scope));
  }

  if (value.tag === "with") {
    return compiletime_type_value(value.base, scope) &&
      value.fields.every((field) => scope_const_expr_known(field.value, scope));
  }

  return false;
}

function is_product_type_value(
  value: FrontExpr,
  scope: TypeSetScope,
): boolean {
  let base = value;

  while (base.tag === "with") {
    base = base.base;
  }

  if (base.tag === "struct_type") {
    return true;
  }

  return base.tag === "product" &&
    base.entries.every((entry) => compiletime_type_value(entry.value, scope));
}

function capture_const_bindings(
  value: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  const replacements = new Map<string, FrontExpr>();

  for (const [name, binding] of scope.bindings) {
    if (
      binding.value !== undefined &&
      scope_const_expr_known(binding.value, scope)
    ) {
      replacements.set(name, binding.value);
    }
  }

  return substitute_front_expr(value, replacements);
}

export function elaborate_front_type_sets(source: Source): Source {
  const scope: TypeSetScope = {
    bindings: new Map(),
    const_evaluation: undefined,
    const_recursion: undefined,
    evaluating_const_call: false,
    fresh: { next: 0 },
    type_values: new Map(),
  };

  for (const declaration of source.declarations || []) {
    if (
      declaration.tag !== "type" || declaration.params.length !== 0
    ) {
      continue;
    }

    if (
      declaration.body.tag === "product" &&
      declaration.body.initializer === undefined
    ) {
      scope.type_values.set(declaration.name, {
        tag: "struct_type",
        fields: declaration.body.fields,
      });
    } else if (declaration.body.tag === "sum") {
      scope.type_values.set(declaration.name, {
        tag: "union_type",
        cases: declaration.body.cases,
      });
    }
  }

  for (const stmt of source.statements) {
    if (stmt.tag === "bind" && stmt.kind === "const") {
      scope.type_values.set(stmt.name, stmt.value);
    }
  }

  let module = source.module;

  if (module !== undefined) {
    module = {
      ...module,
      params: module.params.map((param) => normalize_scope_param(param, scope)),
    };
  }

  return {
    ...source,
    module,
    statements: rewrite_statements(source.statements, scope),
  };
}

function rewrite_statements(
  statements: Stmt[],
  scope: TypeSetScope,
): Stmt[] {
  const result: Stmt[] = [];

  for (const stmt of statements) {
    let const_rec: Extract<FrontExpr, { tag: "rec" }> | undefined;

    if (
      stmt.tag === "bind" && stmt.kind === "const" &&
      stmt.value.tag === "rec"
    ) {
      const_rec = stmt.value;
    }

    const rewritten = rewrite_statement(stmt, scope);
    let expanded = [rewritten];

    if (
      rewritten.tag === "bind" && rewritten.pattern !== undefined &&
      rewritten.pattern.tag !== "binding"
    ) {
      expanded = elaborate_binding_pattern(rewritten, scope);
    }

    for (const candidate of expanded) {
      if (candidate.tag !== "bind") {
        result.push(candidate);
        continue;
      }

      const compiletime_only = candidate.kind === "const" &&
        (candidate.value.tag === "rec" ||
          (candidate.value.tag === "lam" &&
            (expr_requires_type_specialization(candidate.value.body) ||
              (candidate.value.params.length > 0 &&
                candidate.value.params.every((param) => param.is_const) &&
                candidate.value.body.tag === "comptime"))));
      let binding_value = candidate.value;

      if (
        const_rec !== undefined && stmt.tag === "bind" &&
        candidate.name === stmt.name
      ) {
        binding_value = const_rec;
      }

      scope.bindings.set(candidate.name, {
        annotation: candidate.annotation,
        compiletime_only,
        value: binding_value,
        union_type: binding_union_type(candidate.annotation, scope),
      });

      if (candidate.kind === "const") {
        scope.type_values.set(candidate.name, binding_value);
      }

      if (compiletime_only) {
        if (scope.evaluating_const_call) {
          result.push(candidate);
        }

        continue;
      }

      if (
        candidate.kind === "const" &&
        is_comptime_descriptor_value(candidate.value)
      ) {
        continue;
      }

      result.push(candidate);
    }
  }

  return result;
}

function is_comptime_descriptor_value(expr: FrontExpr): boolean {
  if (expr.tag === "array" && expr.rest === undefined) {
    return expr.items.length > 0 &&
      expr.items.every(is_comptime_descriptor_value);
  }

  if (expr.tag !== "struct_value") {
    return false;
  }

  const kind = lookup_field(expr.fields, "kind");

  if (!kind || kind.value.tag !== "atom") {
    return false;
  }

  if (kind.value.name === "field" || kind.value.name === "case") {
    return true;
  }

  return lookup_field(expr.fields, "size") !== undefined &&
    lookup_field(expr.fields, "align") !== undefined &&
    lookup_field(expr.fields, "fields") !== undefined &&
    lookup_field(expr.fields, "cases") !== undefined;
}

function elaborate_binding_pattern(
  stmt: Extract<Stmt, { tag: "bind" }>,
  scope: TypeSetScope,
): Stmt[] {
  const pattern = stmt.pattern;
  expect(pattern, "Missing complex binding pattern");
  const source_name = fresh_pattern_source_name(scope);
  const source_shape = resolve_binding_pattern_source(
    stmt.value,
    scope,
    new Set(),
  );
  let source: FrontExpr = { tag: "var", name: source_name };
  const result: Stmt[] = [];

  if (stmt.kind === "const" && scope_const_expr_known(source_shape, scope)) {
    source = source_shape;
  } else {
    result.push({
      tag: "bind",
      kind: stmt.kind,
      name: source_name,
      is_recursive: stmt.is_recursive,
      is_linear: false,
      annotation: stmt.annotation,
      type_annotation: stmt.type_annotation,
      effectful: stmt.effectful,
      value: stmt.value,
    });
  }
  elaborate_pattern_bindings(
    pattern,
    source,
    source_shape,
    stmt.kind,
    result,
  );
  return result;
}

function resolve_binding_pattern_source(
  source: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr {
  if (source.tag !== "var") {
    return source;
  }

  if (resolving.has(source.name)) {
    return source;
  }

  const binding = scope.bindings.get(source.name);

  if (!binding || binding.value === undefined) {
    return source;
  }

  const next = new Set(resolving);
  next.add(source.name);
  return resolve_binding_pattern_source(binding.value, scope, next);
}

function function_pattern_requires_projection(
  pattern: Pattern | undefined,
  params: Param[],
): boolean {
  if (pattern === undefined || pattern.tag === "binding") {
    return false;
  }

  if (params.some((param) => param.is_const || param.is_linear)) {
    return false;
  }

  return pattern.tag === "wildcard" || pattern.tag === "product" ||
    pattern.tag === "record" || pattern.tag === "array";
}

function elaborate_pattern_bindings(
  pattern: Pattern,
  source: FrontExpr,
  source_shape: FrontExpr | undefined,
  kind: "let" | "const" | undefined,
  result: Stmt[],
): void {
  if (pattern.tag === "binding") {
    let binding_kind: "let" | "const" = "let";

    if (kind !== undefined) {
      binding_kind = kind;
    } else if (pattern.mode === "const") {
      binding_kind = "const";
    }

    const binding: Extract<Stmt, { tag: "bind" }> = {
      tag: "bind",
      kind: binding_kind,
      pattern,
      name: pattern.name,
      is_linear: pattern.mode === "linear",
      annotation: pattern.annotation,
      value: source,
    };

    if (pattern.type_annotation !== undefined) {
      binding.type_annotation = pattern.type_annotation;
    }

    result.push(binding);
    return;
  }

  if (pattern.tag === "wildcard" || pattern.tag === "unit") {
    return;
  }

  if (
    pattern.tag === "literal" || pattern.tag === "union_case" ||
    pattern.tag === "type"
  ) {
    throw new Error(
      "Refutable " + pattern.tag +
        " pattern is not allowed in a plain binding",
    );
  }

  if (pattern.tag === "product") {
    validate_product_pattern_shape(pattern, source_shape);

    for (let index = 0; index < pattern.entries.length; index += 1) {
      const entry = pattern.entries[index];
      expect(entry, "Missing product binding entry " + index.toString());
      let projected: FrontExpr;

      const direct = product_source_entry(source_shape, entry.label, index);

      if (source === source_shape && direct !== undefined) {
        projected = direct;
      } else if (entry.label !== undefined) {
        projected = { tag: "field", object: source, name: entry.label };
      } else {
        projected = {
          tag: "index",
          object: source,
          index: { tag: "num", type: "i32", value: index },
        };
      }

      elaborate_pattern_bindings(
        entry.pattern,
        projected,
        product_source_entry(source_shape, entry.label, index),
        kind,
        result,
      );
    }
    return;
  }

  if (pattern.tag === "record") {
    validate_record_pattern_shape(pattern, source_shape);

    for (const field of pattern.fields) {
      let projected: FrontExpr = {
        tag: "field",
        object: source,
        name: field.name,
      };
      const direct = record_source_field(source_shape, field.name);

      if (source === source_shape && direct !== undefined) {
        projected = direct;
      }

      elaborate_pattern_bindings(
        field.pattern,
        projected,
        direct,
        kind,
        result,
      );
    }

    if (pattern.rest !== undefined && pattern.rest.tag !== "wildcard") {
      const rest = record_rest_expr(pattern, source, source_shape);
      elaborate_pattern_bindings(pattern.rest, rest, rest, kind, result);
    }
    return;
  }

  validate_array_pattern_shape(pattern, source_shape);

  for (let index = 0; index < pattern.items.length; index += 1) {
    const item = pattern.items[index];
    expect(item, "Missing array binding item " + index.toString());
    let projected: FrontExpr = {
      tag: "index",
      object: source,
      index: { tag: "num", type: "i32", value: index },
    };
    const direct = array_source_item(source_shape, index);

    if (source === source_shape && direct !== undefined) {
      projected = direct;
    }

    elaborate_pattern_bindings(
      item,
      projected,
      direct,
      kind,
      result,
    );
  }

  if (pattern.rest !== undefined && pattern.rest.tag !== "wildcard") {
    const rest = array_rest_expr(pattern, source, source_shape);
    elaborate_pattern_bindings(pattern.rest, rest, rest, kind, result);
  }
}

function validate_product_pattern_shape(
  pattern: Extract<Pattern, { tag: "product" }>,
  source: FrontExpr | undefined,
): void {
  const labeled = pattern.entries.every((entry) => {
    return entry.label !== undefined;
  });

  if (labeled) {
    const names = known_record_field_names(source);

    if (names === undefined) {
      return;
    }

    for (const entry of pattern.entries) {
      expect(entry.label, "Missing labeled product binding name");

      if (!names.includes(entry.label)) {
        throw new Error("Missing product binding field: " + entry.label);
      }
    }
    return;
  }

  const arity = known_product_arity(source);

  if (arity !== undefined && arity !== pattern.entries.length) {
    throw new Error(
      "Product binding pattern expects " + pattern.entries.length.toString() +
        " entries, got " + arity.toString(),
    );
  }
}

function validate_record_pattern_shape(
  pattern: Extract<Pattern, { tag: "record" }>,
  source: FrontExpr | undefined,
): void {
  const names = known_record_field_names(source);

  if (names === undefined) {
    if (pattern.rest !== undefined && pattern.rest.tag !== "wildcard") {
      throw new Error(
        "Record rest binding requires a statically known source shape",
      );
    }
    return;
  }

  for (const field of pattern.fields) {
    if (!names.includes(field.name)) {
      throw new Error("Missing record binding field: " + field.name);
    }
  }
}

function validate_array_pattern_shape(
  pattern: Extract<Pattern, { tag: "array" }>,
  source: FrontExpr | undefined,
): void {
  const length = known_array_length(source);

  if (length === undefined) {
    if (pattern.rest !== undefined && pattern.rest.tag !== "wildcard") {
      throw new Error(
        "Array rest binding requires a statically known source length",
      );
    }
    return;
  }

  if (pattern.rest === undefined && length !== pattern.items.length) {
    throw new Error(
      "Array binding pattern expects " + pattern.items.length.toString() +
        " items, got " + length.toString(),
    );
  }

  if (pattern.rest !== undefined && length < pattern.items.length) {
    throw new Error(
      "Array binding pattern requires at least " +
        pattern.items.length.toString() + " items, got " + length.toString(),
    );
  }
}

function known_product_arity(
  source: FrontExpr | undefined,
): number | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "product") {
    return source.entries.length;
  }

  if (source.tag === "array" && source.rest === undefined) {
    return source.items.length;
  }

  if (source.tag === "struct_value") {
    return source.fields.length;
  }

  if (source.tag === "comptime" || source.tag === "captured") {
    return known_product_arity(source.expr);
  }

  return undefined;
}

function known_record_field_names(
  source: FrontExpr | undefined,
): string[] | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "struct_value") {
    return source.fields.map((field) => field.name);
  }

  if (source.tag === "product") {
    const names: string[] = [];

    for (const entry of source.entries) {
      if (entry.label === undefined) {
        return undefined;
      }

      names.push(entry.label);
    }

    return names;
  }

  if (source.tag === "comptime" || source.tag === "captured") {
    return known_record_field_names(source.expr);
  }

  return undefined;
}

function known_array_length(source: FrontExpr | undefined): number | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "array" && source.rest === undefined) {
    return source.items.length;
  }

  if (source.tag === "product") {
    return source.entries.length;
  }

  if (
    source.tag === "app" && source.func.tag === "lam" &&
    source.func.body.tag === "array" && source.func.body.rest === undefined
  ) {
    return source.func.body.items.length;
  }

  if (source.tag === "comptime" || source.tag === "captured") {
    return known_array_length(source.expr);
  }

  return undefined;
}

function product_source_entry(
  source: FrontExpr | undefined,
  label: string | undefined,
  index: number,
): FrontExpr | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "product") {
    if (label !== undefined) {
      return source.entries.find((entry) => entry.label === label)?.value;
    }

    return source.entries[index]?.value;
  }

  if (source.tag === "array") {
    return source.items[index];
  }

  if (source.tag === "struct_value") {
    if (label !== undefined) {
      return source.fields.find((field) => field.name === label)?.value;
    }

    return source.fields[index]?.value;
  }

  return undefined;
}

function record_source_field(
  source: FrontExpr | undefined,
  name: string,
): FrontExpr | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "struct_value") {
    return source.fields.find((field) => field.name === name)?.value;
  }

  if (source.tag === "product") {
    return source.entries.find((entry) => entry.label === name)?.value;
  }

  return undefined;
}

function array_source_item(
  source: FrontExpr | undefined,
  index: number,
): FrontExpr | undefined {
  if (source === undefined) {
    return undefined;
  }

  if (source.tag === "array") {
    return source.items[index];
  }

  if (source.tag === "product") {
    return source.entries[index]?.value;
  }

  if (
    source.tag === "app" && source.func.tag === "lam" &&
    source.func.body.tag === "array"
  ) {
    return source.args[0];
  }

  return undefined;
}

function record_rest_expr(
  pattern: Extract<Pattern, { tag: "record" }>,
  source: FrontExpr,
  source_shape: FrontExpr | undefined,
): FrontExpr {
  const names = known_record_field_names(source_shape);
  expect(names, "Missing statically known record rest shape");
  const selected = new Set(pattern.fields.map((field) => field.name));
  return {
    tag: "product",
    entries: names.filter((name) => !selected.has(name)).map((name) => {
      const direct = record_source_field(source_shape, name);

      if (source === source_shape && direct !== undefined) {
        return { label: name, value: direct };
      }

      return {
        label: name,
        value: { tag: "field", object: source, name },
      };
    }),
  };
}

function array_rest_expr(
  pattern: Extract<Pattern, { tag: "array" }>,
  source: FrontExpr,
  source_shape: FrontExpr | undefined,
): FrontExpr {
  const length = known_array_length(source_shape);
  expect(length !== undefined, "Missing statically known array rest length");
  const items: FrontExpr[] = [];

  for (let index = pattern.items.length; index < length; index += 1) {
    const direct = array_source_item(source_shape, index);

    if (source === source_shape && direct !== undefined) {
      items.push(direct);
      continue;
    }

    items.push({
      tag: "index",
      object: source,
      index: { tag: "num", type: "i32", value: index },
    });
  }

  return {
    tag: "product",
    entries: items.map((value) => ({ value })),
  };
}

function contextualize_product_value(
  value: FrontExpr,
  annotation: string,
  declared: Extract<FrontExpr, { tag: "struct_type" }>,
): FrontExpr {
  if (value.tag === "captured") {
    return {
      ...value,
      expr: contextualize_product_value(value.expr, annotation, declared),
    };
  }

  if (value.tag === "if") {
    return {
      ...value,
      then_branch: contextualize_product_value(
        value.then_branch,
        annotation,
        declared,
      ),
      else_branch: contextualize_product_value(
        value.else_branch,
        annotation,
        declared,
      ),
    };
  }

  if (value.tag === "block") {
    const statements = [...value.statements];
    const final_index = statements.length - 1;
    const final_statement = statements[final_index];

    if (final_statement?.tag !== "expr") {
      return value;
    }

    statements[final_index] = {
      ...final_statement,
      expr: contextualize_product_value(
        final_statement.expr,
        annotation,
        declared,
      ),
    };
    return { ...value, statements };
  }

  if (value.tag !== "product") {
    return value;
  }

  const labels = new Set<string>();

  for (const entry of value.entries) {
    if (entry.label === undefined) {
      continue;
    }

    if (labels.has(entry.label)) {
      throw new Error("Duplicate struct field: " + entry.label);
    }

    labels.add(entry.label);

    if (!declared.fields.some((field) => field.name === entry.label)) {
      throw new Error("Unknown struct field: " + entry.label);
    }
  }

  if (value.entries.length < declared.fields.length) {
    const missing = declared.fields[value.entries.length];
    expect(missing, "Missing contextual struct field");
    throw new Error("Missing struct field: " + missing.name);
  }

  if (value.entries.length > declared.fields.length) {
    throw new Error(
      "Contextual product for " + annotation + " expects " +
        declared.fields.length.toString() + " values, got " +
        value.entries.length.toString(),
    );
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: annotation },
    fields: declared.fields.map((field, index) => {
      const entry = value.entries[index];
      expect(entry, "Missing contextual product entry " + index.toString());

      if (entry.label !== undefined && entry.label !== field.name) {
        throw new Error(
          "Contextual product entry " + index.toString() +
            " expects label ." + field.name + ", got ." + entry.label,
        );
      }

      return { name: field.name, value: entry.value };
    }),
    bracketed: "positional",
  };
}

function contextualize_union_call_payload(
  func: FrontExpr,
  arg: FrontExpr | undefined,
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag !== "field" || arg === undefined) {
    return arg;
  }

  const union_type = resolve_front_type_value(
    func.object,
    scope.type_values,
    new Set(),
  );

  if (union_type?.tag !== "union_type") {
    return arg;
  }

  const union_case = union_type.cases.find((candidate) => {
    return candidate.name === func.name;
  });

  if (union_case === undefined || union_case.type_name === "Unit") {
    return arg;
  }

  const payload_type = resolve_front_type_value(
    { tag: "var", name: union_case.type_name },
    scope.type_values,
    new Set(),
  );

  if (payload_type?.tag !== "struct_type") {
    return arg;
  }

  return contextualize_product_value(
    arg,
    union_case.type_name,
    payload_type,
  );
}

function rewrite_statement(stmt: Stmt, scope: TypeSetScope): Stmt {
  switch (stmt.tag) {
    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return stmt;

    case "bind": {
      let value = rewrite_expr(stmt.value, scope);
      const annotation = lower_direct_type_set_annotation(
        stmt.annotation,
        scope,
      );

      if (annotation !== undefined) {
        const declared = resolve_front_type_value(
          { tag: "var", name: annotation },
          scope.type_values,
          new Set(),
        );

        if (declared?.tag === "struct_type") {
          value = contextualize_product_value(value, annotation, declared);
        }
      }

      if (stmt.kind === "const" && value.tag === "app") {
        const specialized = specialize_front_type_constructor(
          value,
          scope.type_values,
          new Set([stmt.name]),
        );
        let resolved: FrontExpr | undefined;

        if (specialized !== undefined) {
          resolved = resolve_front_type_value(
            specialized,
            scope.type_values,
            new Set([stmt.name]),
          );
        }

        if (
          resolved &&
          (resolved.tag === "struct_type" || resolved.tag === "union_type" ||
            resolved.tag === "set_type")
        ) {
          if (specialized?.tag === "with") {
            value = specialized;
          } else {
            value = resolved;
          }
        }
      }

      if (annotation) {
        value = inject_type_set_value(annotation, value, scope, "binding");
      }

      return {
        ...stmt,
        annotation,
        type_annotation: normalize_scope_type_expr(
          stmt.type_annotation,
          scope,
        ),
        value,
      };
    }

    case "state_bind":
    case "resume_dup":
    case "assign":
      return { ...stmt, value: rewrite_expr(stmt.value, scope) };

    case "bind_pattern":
      return { ...stmt, value: rewrite_expr(stmt.value, scope) };

    case "index_assign":
      return {
        ...stmt,
        index: rewrite_expr(stmt.index, scope),
        value: rewrite_expr(stmt.value, scope),
      };

    case "for_range":
      return {
        ...stmt,
        start: rewrite_expr(stmt.start, scope),
        end: rewrite_expr(stmt.end, scope),
        step: rewrite_expr(stmt.step, scope),
        body: rewrite_statements(stmt.body, clone_scope(scope)),
      };

    case "for_collection":
      return {
        ...stmt,
        collection: rewrite_expr(stmt.collection, scope),
        body: rewrite_statements(stmt.body, clone_scope(scope)),
      };

    case "if_stmt":
      return {
        ...stmt,
        cond: rewrite_expr(stmt.cond, scope),
        body: rewrite_statements(stmt.body, clone_scope(scope)),
      };

    case "if_let_stmt": {
      const branch = clone_scope(scope);

      if (stmt.value_name) {
        branch.bindings.set(stmt.value_name, {
          annotation: union_case_payload_annotation(
            stmt.target,
            stmt.case_name,
            scope,
          ),
          value: undefined,
        });
      }

      return {
        ...stmt,
        target: rewrite_expr(stmt.target, scope),
        body: rewrite_statements(stmt.body, branch),
      };
    }

    case "type_check":
      return { ...stmt, target: rewrite_expr(stmt.target, scope) };

    case "break":
      if (!stmt.value) {
        return stmt;
      }

      return { ...stmt, value: rewrite_expr(stmt.value, scope) };

    case "return":
      return { ...stmt, value: rewrite_expr(stmt.value, scope) };

    case "expr":
      return { ...stmt, expr: rewrite_expr(stmt.expr, scope) };
  }
}

function elaborate_match_expr(
  expr: Extract<FrontExpr, { tag: "match" }>,
  scope: TypeSetScope,
): FrontExpr {
  const target = rewrite_expr(expr.target, scope);

  if (expr.arms.some((arm) => arm.pattern.tag === "type")) {
    return elaborate_type_match_expr(expr, target, scope);
  }

  const target_shape = resolve_binding_pattern_source(
    target,
    scope,
    new Set(),
  );
  const union_type = union_type_for_value(target, scope);
  validate_match_coverage(expr.arms, union_type);

  if (
    scope.evaluating_const_call &&
    (target.tag === "bool" || target.tag === "num" ||
      target.tag === "atom" || target.tag === "unit" ||
      target.tag === "text")
  ) {
    for (const arm of expr.arms) {
      let matches = arm.pattern.tag === "wildcard";
      let body = arm.body;

      if (arm.pattern.tag === "binding") {
        if (arm.pattern.mode === "linear") {
          throw new Error(
            "Linear bindings are not supported in compile-time matches",
          );
        }

        matches = true;
        body = substitute_front_expr(
          body,
          new Map([[arm.pattern.name, target]]),
        );
      } else if (arm.pattern.tag === "unit") {
        matches = target.tag === "unit";
      } else if (arm.pattern.tag === "literal") {
        const value = arm.pattern.value;

        if (value.tag === "bool" && target.tag === "bool") {
          matches = value.value === target.value;
        } else if (value.tag === "num" && target.tag === "num") {
          matches = value.type === target.type && value.value === target.value;
        } else if (value.tag === "text" && target.tag === "text") {
          matches = value.value === target.value;
        } else if (value.tag === "atom" && target.tag === "atom") {
          matches = value.name === target.name;
        }
      }

      if (!matches) {
        continue;
      }

      if (arm.guard !== undefined) {
        break;
      }

      return rewrite_expr(body, clone_scope(scope));
    }
  }

  const target_name = fresh_match_target_name(scope);
  let target_expr: FrontExpr = { tag: "var", name: target_name };
  let bind_target = true;
  const first_arm = expr.arms[0];

  if (
    first_arm !== undefined &&
    (first_arm.pattern.tag === "product" ||
      first_arm.pattern.tag === "record" ||
      first_arm.pattern.tag === "array") &&
    direct_pattern_projection_source(target)
  ) {
    target_expr = target;
    bind_target = false;
  }

  let result: FrontExpr = { tag: "unit" };

  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index];
    expect(arm, "Missing match arm " + index.toString());
    result = elaborate_match_arm(
      arm,
      target_expr,
      target_shape,
      result,
      union_type,
      scope,
    );
  }

  const statements: Stmt[] = [];

  if (bind_target) {
    statements.push({
      tag: "bind",
      kind: "let",
      name: target_name,
      is_linear: false,
      annotation: undefined,
      value: target,
    });
  }

  if (result.tag === "block") {
    statements.push(...result.statements);
  } else {
    statements.push({ tag: "expr", expr: result });
  }

  return { tag: "block", statements };
}

function elaborate_type_match_expr(
  expr: Extract<FrontExpr, { tag: "match" }>,
  target: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  const type_value = resolve_front_type_value(
    target,
    scope.type_values,
    new Set(),
  );
  expect(type_value, "Type match requires a compile-time type value");

  if (
    type_value.tag === "var" && target.tag === "var" &&
    type_value.name === target.name && !scope.type_values.has(target.name)
  ) {
    const arms: MatchArm[] = [];

    for (const arm of expr.arms) {
      let guard: FrontExpr | undefined;

      if (arm.guard !== undefined) {
        guard = rewrite_expr(arm.guard, clone_scope(scope));
      }

      arms.push({
        ...arm,
        guard,
        body: rewrite_expr(arm.body, clone_scope(scope)),
      });
    }

    return {
      ...expr,
      target,
      arms,
    };
  }

  let result: FrontExpr | undefined;

  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index];
    expect(arm, "Missing type match arm " + index.toString());
    let matches = false;
    let body = arm.body;

    if (arm.pattern.tag === "type") {
      matches = type_pattern_matches(arm.pattern.pattern, type_value, scope);
    } else if (arm.pattern.tag === "wildcard") {
      matches = true;
    } else if (arm.pattern.tag === "binding") {
      if (arm.pattern.mode === "linear") {
        throw new Error(
          "Linear bindings are not supported in compile-time type matches",
        );
      }

      matches = true;
      body = substitute_front_expr(
        arm.body,
        new Map([[arm.pattern.name, target]]),
      );
    } else {
      throw new Error(
        "Compile-time type match arm must use a type pattern or catch-all",
      );
    }

    if (!matches) {
      continue;
    }

    const rewritten_body = rewrite_expr(body, clone_scope(scope));

    if (arm.guard === undefined) {
      result = rewritten_body;
      continue;
    }

    if (result === undefined) {
      throw new Error(
        "Non-exhaustive guarded type match at arm " + index.toString(),
      );
    }

    result = {
      tag: "if",
      cond: rewrite_expr(arm.guard, clone_scope(scope)),
      then_branch: rewritten_body,
      else_branch: result,
    };
  }

  expect(result, "Non-exhaustive type match for compile-time type value");
  return result;
}

function type_pattern_matches(
  pattern: import("./ast.ts").TypePattern,
  value: FrontExpr,
  scope: TypeSetScope,
): boolean {
  let fields: import("./ast.ts").TypeField[];

  if (pattern.kind === "struct") {
    if (value.tag !== "struct_type") {
      return false;
    }

    fields = value.fields;
  } else {
    if (value.tag !== "union_type") {
      return false;
    }

    fields = value.cases;
  }

  for (const expected of pattern.fields) {
    const actual = fields.find((field) => field.name === expected.name);

    if (!actual) {
      return false;
    }

    const expected_type = semantic_type_for_expr(
      parse_type_expr(tokenize(expected.type_name)),
      scope,
      new Set(),
    );
    const actual_type = semantic_type_for_expr(
      parse_type_expr(tokenize(actual.type_name)),
      scope,
      new Set(),
    );

    if (sem_type_key(expected_type) !== sem_type_key(actual_type)) {
      return false;
    }
  }

  if (!pattern.open && fields.length !== pattern.fields.length) {
    return false;
  }

  return true;
}

function direct_pattern_projection_source(expr: FrontExpr): boolean {
  if (
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "atom" ||
    expr.tag === "unit" || expr.tag === "text" || expr.tag === "var"
  ) {
    return true;
  }

  if (expr.tag === "product") {
    return expr.entries.every((entry) => {
      return direct_pattern_projection_source(entry.value);
    });
  }

  if (expr.tag === "array" && expr.rest === undefined) {
    return expr.items.every(direct_pattern_projection_source);
  }

  if (expr.tag === "struct_value") {
    return expr.fields.every((field) => {
      return direct_pattern_projection_source(field.value);
    });
  }

  return false;
}

function elaborate_match_arm(
  arm: MatchArm,
  target: FrontExpr,
  target_shape: FrontExpr,
  fallback: FrontExpr,
  union_type: Extract<FrontExpr, { tag: "union_type" }> | undefined,
  scope: TypeSetScope,
): FrontExpr {
  if (arm.pattern.tag === "binding") {
    if (arm.pattern.mode === "linear") {
      throw new Error(
        "Linear binding match patterns are not supported during elaboration: " +
          arm.pattern.name,
      );
    }

    const replacements = new Map([[arm.pattern.name, target]]);
    const guard = substitute_optional_match_expr(arm.guard, replacements);
    const body = substitute_front_expr(arm.body, replacements);
    return guarded_match_body(guard, body, fallback, scope);
  }

  if (arm.pattern.tag === "wildcard") {
    return guarded_match_body(arm.guard, arm.body, fallback, scope);
  }

  if (arm.pattern.tag === "unit") {
    return {
      tag: "if",
      cond: {
        tag: "prim",
        prim: "i32.eq",
        left: target,
        right: { tag: "unit" },
      },
      then_branch: guarded_match_body(
        arm.guard,
        arm.body,
        fallback,
        scope,
      ),
      else_branch: fallback,
    };
  }

  if (arm.pattern.tag === "literal") {
    return {
      tag: "if",
      cond: match_literal_condition(target, arm.pattern),
      then_branch: guarded_match_body(
        arm.guard,
        arm.body,
        fallback,
        scope,
      ),
      else_branch: fallback,
    };
  }

  if (arm.pattern.tag === "type") {
    throw new Error("Type match must be elaborated at compile time");
  }

  if (arm.pattern.tag === "union_case") {
    const branch = clone_scope(scope);
    let value_name: string | undefined;

    if (arm.pattern.value?.tag === "binding") {
      if (arm.pattern.value.mode === "linear") {
        throw new Error(
          "Linear union payload patterns are not supported during match elaboration: " +
            arm.pattern.value.name,
        );
      }

      value_name = arm.pattern.value.name;
      branch.bindings.set(value_name, {
        annotation: union_case_annotation(union_type, arm.pattern.name),
        value: undefined,
      });
    } else if (
      arm.pattern.value !== undefined &&
      arm.pattern.value.tag !== "wildcard" && arm.pattern.value.tag !== "unit"
    ) {
      throw new Error(
        "Unsupported nested match payload pattern for ." +
          arm.pattern.name + ": " + arm.pattern.value.tag,
      );
    }

    return {
      tag: "if_let",
      case_name: arm.pattern.name,
      value_name,
      target,
      then_branch: guarded_match_body(
        arm.guard,
        arm.body,
        fallback,
        branch,
      ),
      else_branch: fallback,
    };
  }

  if (
    arm.pattern.tag === "product" || arm.pattern.tag === "record" ||
    arm.pattern.tag === "array"
  ) {
    const branch = clone_scope(scope);
    const bindings: Stmt[] = [];
    elaborate_pattern_bindings(
      arm.pattern,
      target,
      target_shape,
      "let",
      bindings,
    );

    if (target === target_shape) {
      const replacements = new Map<string, FrontExpr>();

      for (const binding of bindings) {
        if (binding.tag !== "bind") {
          continue;
        }

        replacements.set(binding.name, binding.value);
      }

      const body = rewrite_expr(
        substitute_front_expr(arm.body, replacements),
        branch,
      );

      if (arm.guard === undefined) {
        return body;
      }

      return {
        tag: "if",
        cond: rewrite_expr(
          substitute_front_expr(arm.guard, replacements),
          branch,
        ),
        then_branch: body,
        else_branch: fallback,
      };
    }

    const rewritten_bindings = rewrite_statements(bindings, branch);
    const body = rewrite_expr(arm.body, branch);
    let result = body;

    if (arm.guard !== undefined) {
      result = {
        tag: "if",
        cond: rewrite_expr(arm.guard, branch),
        then_branch: body,
        else_branch: fallback,
      };
    }

    return {
      tag: "block",
      statements: [
        ...rewritten_bindings,
        { tag: "expr", expr: result },
      ],
    };
  }

  arm.pattern satisfies never;
  throw new Error("Unsupported match pattern during elaboration");
}

function guarded_match_body(
  guard: FrontExpr | undefined,
  body: FrontExpr,
  fallback: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  const rewritten_body = rewrite_expr(body, clone_scope(scope));

  if (guard === undefined) {
    return rewritten_body;
  }

  return {
    tag: "if",
    cond: rewrite_expr(guard, clone_scope(scope)),
    then_branch: rewritten_body,
    else_branch: fallback,
  };
}

function substitute_optional_match_expr(
  expr: FrontExpr | undefined,
  replacements: Map<string, FrontExpr>,
): FrontExpr | undefined {
  if (expr === undefined) {
    return undefined;
  }

  return substitute_front_expr(expr, replacements);
}

function match_literal_condition(
  target: FrontExpr,
  pattern: Extract<Pattern, { tag: "literal" }>,
): FrontExpr {
  const value = pattern.value;

  if (value.tag === "bool") {
    return {
      tag: "prim",
      prim: "i32.eq",
      left: target,
      right: { tag: "bool", value: value.value },
    };
  }

  if (value.tag === "num") {
    let prim: "i32.eq" | "i64.eq" = "i32.eq";

    if (value.type === "i64") {
      prim = "i64.eq";
    }

    return {
      tag: "prim",
      prim,
      left: target,
      right: { tag: "num", type: value.type, value: value.value },
    };
  }

  if (value.tag === "text") {
    return {
      tag: "prim",
      prim: "i32.eq",
      left: target,
      right: { tag: "text", value: value.value },
    };
  }

  return {
    tag: "prim",
    prim: "i32.eq",
    left: target,
    right: { tag: "atom", name: value.name },
  };
}

function validate_match_coverage(
  arms: MatchArm[],
  union_type: Extract<FrontExpr, { tag: "union_type" }> | undefined,
): void {
  const covered_union_cases = new Set<string>();
  const covered_literals = new Set<string>();
  let covers_false = false;
  let covers_true = false;
  let has_catch_all = false;

  for (let index = 0; index < arms.length; index += 1) {
    const arm = arms[index];
    expect(arm, "Missing match coverage arm " + index.toString());

    if (
      has_catch_all || (covers_false && covers_true) ||
      union_coverage_complete(union_type, covered_union_cases)
    ) {
      throw new Error("Unreachable match arm " + index.toString());
    }

    const unguarded = arm.guard === undefined;

    if (
      arm.pattern.tag === "binding" || arm.pattern.tag === "wildcard"
    ) {
      if (unguarded) {
        has_catch_all = true;
      }
      continue;
    }

    if (
      arm.pattern.tag === "product" || arm.pattern.tag === "record" ||
      arm.pattern.tag === "array"
    ) {
      continue;
    }

    if (arm.pattern.tag === "unit") {
      if (covered_literals.has("unit")) {
        throw new Error(
          "Unreachable duplicate unit match at arm " + index.toString(),
        );
      }

      if (unguarded) {
        covered_literals.add("unit");
      }
      continue;
    }

    if (arm.pattern.tag === "literal") {
      const key = match_literal_key(arm.pattern.value);

      if (covered_literals.has(key)) {
        throw new Error(
          "Unreachable duplicate match literal at arm " + index.toString() +
            ": " + key,
        );
      }

      if (unguarded) {
        covered_literals.add(key);

        if (key === "bool:false") {
          covers_false = true;
        } else if (key === "bool:true") {
          covers_true = true;
        }
      }
      continue;
    }

    if (arm.pattern.tag === "type") {
      continue;
    }

    if (arm.pattern.tag === "union_case") {
      const case_name = arm.pattern.name;

      if (
        union_type !== undefined &&
        !union_type.cases.some((item) => item.name === case_name)
      ) {
        throw new Error(
          "Unknown match union case ." + case_name,
        );
      }

      if (covered_union_cases.has(case_name)) {
        throw new Error(
          "Unreachable duplicate match case at arm " + index.toString() +
            ": ." + case_name,
        );
      }

      if (unguarded) {
        covered_union_cases.add(case_name);
      }
      continue;
    }

    arm.pattern satisfies never;
    throw new Error("Unsupported match pattern during coverage analysis");
  }

  if (
    has_catch_all || (covers_false && covers_true) ||
    union_coverage_complete(union_type, covered_union_cases)
  ) {
    return;
  }

  if (union_type !== undefined) {
    const missing = union_type.cases.filter((item) =>
      !covered_union_cases.has(item.name)
    ).map((item) => "." + item.name);
    throw new Error("Non-exhaustive match, missing " + missing.join(", "));
  }

  throw new Error(
    "Non-exhaustive match requires a wildcard or binding arm",
  );
}

function union_coverage_complete(
  union_type: Extract<FrontExpr, { tag: "union_type" }> | undefined,
  covered: Set<string>,
): boolean {
  if (union_type === undefined || union_type.cases.length === 0) {
    return false;
  }

  return union_type.cases.every((item) => covered.has(item.name));
}

function match_literal_key(
  value: Extract<Pattern, { tag: "literal" }>["value"],
): string {
  if (value.tag === "bool") {
    return "bool:" + value.value.toString();
  }

  if (value.tag === "num") {
    return "num:" + value.type + ":" + value.value.toString();
  }

  if (value.tag === "text") {
    return "text:" + value.value;
  }

  return "atom:" + value.name;
}

function union_case_annotation(
  union_type: Extract<FrontExpr, { tag: "union_type" }> | undefined,
  case_name: string,
): string | undefined {
  if (union_type === undefined) {
    return undefined;
  }

  const union_case = union_type.cases.find((item) => item.name === case_name);

  if (union_case === undefined) {
    return undefined;
  }

  return member_annotation(union_case.set_member) || union_case.type_name;
}

function rewrite_expr(expr: FrontExpr, scope: TypeSetScope): FrontExpr {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "unsupported":
      return expr;

    case "set_type":
      return {
        ...expr,
        type_expr: normalize_scope_type_expr(expr.type_expr, scope),
      };

    case "struct_type":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          type_name: normalize_scope_annotation(field.type_name, scope),
          set_member: normalize_scope_type_expr(field.set_member, scope),
        })),
      };

    case "union_type":
      return {
        ...expr,
        cases: expr.cases.map((union_case) => ({
          ...union_case,
          type_name: normalize_scope_annotation(
            union_case.type_name,
            scope,
          ),
          set_member: normalize_scope_type_expr(
            union_case.set_member,
            scope,
          ),
        })),
      };

    case "prim": {
      const value: FrontExpr = {
        ...expr,
        left: rewrite_expr(expr.left, scope),
        right: rewrite_expr(expr.right, scope),
      };
      let static_value: number | undefined;

      if (scope.evaluating_const_call) {
        static_value = static_const_equality(value);

        if (static_value === undefined) {
          static_value = static_i32_source_value(value);
        }
      }

      if (static_value !== undefined) {
        return { tag: "num", type: "i32", value: static_value };
      }

      return value;
    }

    case "lam":
    case "rec": {
      const params = expr.params.map((param) =>
        normalize_scope_param(param, scope)
      );

      if (
        expr.tag === "rec" &&
        function_pattern_requires_projection(expr.pattern, params)
      ) {
        const pattern = expr.pattern;
        expect(pattern, "Missing function parameter pattern");
        const param_name = fresh_pattern_parameter_name(scope);
        const is_linear = pattern_bindings(pattern).some((binding) => {
          return binding.mode === "linear";
        });
        let type_annotation: TypeExpr | undefined;

        if (pattern.tag === "product") {
          const entries: Extract<TypeExpr, { tag: "product" }>["entries"] = [];

          for (const entry of pattern.entries) {
            if (entry.pattern.tag !== "binding") {
              entries.length = 0;
              break;
            }

            let entry_type = entry.pattern.type_annotation;

            if (
              entry_type === undefined &&
              entry.pattern.annotation !== undefined
            ) {
              entry_type = {
                tag: "name",
                name: entry.pattern.annotation,
              };
            }

            if (entry_type === undefined) {
              entries.length = 0;
              break;
            }

            entries.push({ label: entry.label, type_expr: entry_type });
          }

          if (entries.length === pattern.entries.length) {
            type_annotation = { tag: "product", entries };
          }
        }

        const param: Param = {
          name: param_name,
          is_const: false,
          is_linear,
          annotation: undefined,
        };

        if (type_annotation !== undefined) {
          param.type_annotation = type_annotation;
        }
        const body_scope = scope_for_params([param], scope);
        const bindings: Stmt[] = [];
        elaborate_pattern_bindings(
          pattern,
          { tag: "var", name: param_name },
          undefined,
          undefined,
          bindings,
        );
        const rewritten_bindings = rewrite_statements(bindings, body_scope);
        const body = rewrite_expr(expr.body, body_scope);
        return {
          ...expr,
          pattern,
          params: [param],
          body: {
            tag: "block",
            statements: [
              ...rewritten_bindings,
              { tag: "expr", expr: body },
            ],
          },
        };
      }

      const body_scope = scope_for_params(params, scope);
      return { ...expr, params, body: rewrite_expr(expr.body, body_scope) };
    }

    case "app": {
      const func = rewrite_expr(expr.func, scope);
      let arg = expr.arg;

      if (arg !== undefined) {
        arg = rewrite_expr(arg, scope);
      }

      let args = expr.args.map((item) => rewrite_expr(item, scope));
      const unconstrained_arg = arg;
      arg = contextualize_union_call_payload(func, arg, scope);

      if (
        arg !== undefined && arg !== unconstrained_arg && args.length === 1
      ) {
        args = [arg];
      }

      const packed_arg = args[0];
      const callable_params = callable_type_set_params(func, scope, new Set());

      if (
        args.length === 1 && packed_arg !== undefined &&
        packed_arg.tag === "product" && callable_params !== undefined &&
        callable_params.length > 1 &&
        callable_params.length === packed_arg.entries.length
      ) {
        args = packed_arg.entries.map((entry) => entry.value);
      }

      if (func.tag === "union_case" && func.value === undefined) {
        if (arg !== undefined && arg.tag !== "unit") {
          return { ...func, value: arg };
        }

        if (args.length === 1) {
          const value = args[0];
          expect(value, "Missing shorthand union constructor payload");
          return { ...func, value };
        }
      }

      args = inject_type_set_call_arguments(func, args, scope);

      if (arg !== undefined) {
        if (
          arg.tag === "product" && func.tag !== "field" &&
          args.length === arg.entries.length &&
          !(args.length === 1 && args[0]?.tag === "product")
        ) {
          arg = {
            ...arg,
            entries: arg.entries.map((entry, index) => {
              const value = args[index];
              expect(value, "Missing elaborated product call argument");
              return { ...entry, value };
            }),
          };
        } else if (arg.tag !== "unit" && args.length === 1) {
          const value = args[0];
          expect(value, "Missing elaborated unary call argument");
          arg = value;
        }
      }

      const aggregate_type = elaborate_comptime_type_intrinsic(
        func,
        arg,
        args,
        scope,
      );

      if (aggregate_type !== undefined) {
        return rewrite_expr(aggregate_type, scope);
      }

      const type_match_call = specialize_type_match_call(func, args, scope);

      if (type_match_call !== undefined) {
        return rewrite_expr(type_match_call, scope);
      }

      const descriptor = elaborate_comptime_descriptor_call(func, args, scope);

      if (descriptor !== undefined) {
        return rewrite_expr(descriptor, scope);
      }

      const collection = elaborate_const_collection_call(func, args, scope);

      if (collection !== undefined) {
        return rewrite_expr(collection, scope);
      }

      const const_directed = elaborate_const_directed_call(func, args, scope);

      if (const_directed !== undefined) {
        return rewrite_expr(const_directed, scope);
      }

      const const_call = specialize_const_function_call(func, args, scope);

      if (const_call !== undefined) {
        return rewrite_expr(const_call, scope);
      }

      return {
        ...expr,
        func,
        arg,
        args,
      };
    }

    case "product":
    case "shape":
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          ...entry,
          value: rewrite_expr(entry.value, scope),
        })),
      };

    case "array": {
      const items = expr.items.map((item) => rewrite_expr(item, scope));
      let rest = expr.rest;

      if (rest !== undefined) {
        rest = rewrite_expr(rest, scope);

        if (
          scope.evaluating_const_call &&
          scope_const_expr_known(rest, scope)
        ) {
          const value = resolve_scope_const_value(rest, scope);

          if (value.tag === "product") {
            const spread = value.entries;
            const direct = items.map((item) => ({ value: item }));

            if (expr.leading_rest === true) {
              return {
                tag: "product",
                entries: [...spread, ...direct],
              };
            }

            return {
              tag: "product",
              entries: [...direct, ...spread],
            };
          }

          if (value.tag === "array" && value.rest === undefined) {
            if (expr.leading_rest === true) {
              return {
                ...expr,
                items: [...value.items, ...items],
                rest: undefined,
              };
            }

            return {
              ...expr,
              items: [...items, ...value.items],
              rest: undefined,
            };
          }

          throw new Error(
            "Compile-time product spread requires a fixed product value, got " +
              value.tag,
          );
        }
      }

      return {
        ...expr,
        items,
        rest,
      };
    }

    case "array_repeat": {
      const rewritten: Extract<FrontExpr, { tag: "array_repeat" }> = {
        ...expr,
        value: rewrite_expr(expr.value, scope),
        length: rewrite_expr(expr.length, scope),
      };

      if (!scope.evaluating_const_call) {
        constant_repeat_length(rewritten.length);
        return rewritten;
      }

      return rewrite_expr(
        elaborate_array_repeat_expr(
          rewritten,
          fresh_array_repeat_name(scope),
        ),
        scope,
      );
    }

    case "import":
      return expr;

    case "block":
      if (
        scope.evaluating_const_call &&
        expr.statements.some((statement) => statement.tag === "for_collection")
      ) {
        const evaluated = evaluate_const_block(expr.statements, scope);

        if (evaluated !== undefined) {
          return evaluated;
        }
      }

      return {
        ...expr,
        statements: rewrite_statements(expr.statements, clone_scope(scope)),
      };

    case "comptime": {
      const evaluation_scope = clone_scope(scope);
      evaluation_scope.evaluating_const_call = true;
      evaluation_scope.const_evaluation = {
        recursions: new Map(),
        steps: 0,
      };
      const value = rewrite_expr(expr.expr, evaluation_scope);
      const result = unwrap_const_result(value);

      if (scope_const_expr_known(result, evaluation_scope)) {
        return result;
      }

      return { ...expr, expr: value };
    }

    case "borrow":
    case "freeze":
      return { ...expr, value: rewrite_expr(expr.value, scope) };

    case "scratch":
      return { ...expr, body: rewrite_expr(expr.body, clone_scope(scope)) };

    case "loop":
      return {
        ...expr,
        body: rewrite_statements(expr.body, clone_scope(scope)),
      };

    case "captured":
      return { ...expr, expr: rewrite_expr(expr.expr, scope) };

    case "handler":
      return {
        ...expr,
        state: expr.state.map((state) => ({
          ...state,
          annotation: lower_direct_type_set_annotation(
            state.annotation,
            scope,
          ),
          value: rewrite_expr(state.value, scope),
        })),
        clauses: expr.clauses.map((clause) => {
          const params = clause.params.map((param) =>
            normalize_scope_param(param, scope)
          );

          return {
            ...clause,
            params,
            body: rewrite_expr(clause.body, scope_for_params(params, scope)),
          };
        }),
        return_clause: {
          ...expr.return_clause,
          param: normalize_scope_param(expr.return_clause.param, scope),
          body: rewrite_expr(expr.return_clause.body, clone_scope(scope)),
        },
      };

    case "try_with":
      return {
        ...expr,
        body: rewrite_expr(expr.body, scope),
        handler: rewrite_expr(expr.handler, scope),
      };

    case "with":
    case "struct_update":
      return {
        ...expr,
        base: rewrite_expr(expr.base, scope),
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewrite_expr(field.value, scope),
        })),
      };

    case "type_with": {
      const base = rewrite_expr(expr.base, scope);
      const members = expr.members.map((member) => ({
        name: rewrite_expr(member.name, scope),
        value: rewrite_expr(member.value, scope),
      }));

      if (!scope.evaluating_const_call) {
        return { ...expr, base, members };
      }

      const resolved_base = unwrap_const_result(
        scope_const_binding_value(base, scope),
      );

      if (
        resolved_base.tag !== "product" && resolved_base.tag !== "with" &&
        resolved_base.tag !== "struct_type"
      ) {
        return { ...expr, base, members };
      }

      expect(
        is_product_type_value(resolved_base, scope),
        "Computed type members require a product type value, got " +
          resolved_base.tag,
      );
      const fields: import("./ast.ts").Field[] = [];

      for (const member of members) {
        const name = unwrap_const_result(
          scope_const_binding_value(member.name, scope),
        );

        if (!scope_const_expr_known(name, scope)) {
          return { ...expr, base, members };
        }

        expect(
          name.tag === "text" && name.value.length > 0,
          "Computed type member name must be non-empty Text",
        );
        const resolved_value = unwrap_const_result(
          resolve_scope_const_value(member.value, scope),
        );
        expect(
          resolved_value.tag === "lam",
          "Computed type member " + name.value + " must be a function",
        );
        const value = capture_const_bindings(resolved_value, scope);
        expect(
          resolve_extension_field(
            resolved_base,
            name.value,
            scope,
            new Set(),
          ) === undefined,
          "Duplicate type namespace member: " + name.value,
        );
        fields.push({ name: name.value, value });
      }

      return { tag: "with", base: resolved_base, fields };
    }

    case "struct_value":
      return {
        ...expr,
        type_expr: rewrite_expr(expr.type_expr, scope),
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewrite_expr(field.value, scope),
        })),
      };

    case "if":
      return rewrite_if(expr, scope);

    case "if_let": {
      const branch = clone_scope(scope);

      if (expr.value_name) {
        branch.bindings.set(expr.value_name, {
          annotation: union_case_payload_annotation(
            expr.target,
            expr.case_name,
            scope,
          ),
          value: undefined,
        });
      }

      return {
        ...expr,
        target: rewrite_expr(expr.target, scope),
        then_branch: rewrite_expr(expr.then_branch, branch),
        else_branch: rewrite_expr(expr.else_branch, clone_scope(scope)),
      };
    }

    case "field": {
      let object = rewrite_expr(expr.object, scope);

      if (object.tag === "var") {
        const const_value = scope.type_values.get(object.name);

        if (const_value !== undefined) {
          const extension_field = resolve_extension_field(
            const_value,
            expr.name,
            scope,
            new Set([object.name]),
          );

          if (extension_field !== undefined) {
            return rewrite_expr(extension_field, scope);
          }
        }

        if (
          const_value !== undefined &&
          is_comptime_descriptor_value(const_value)
        ) {
          object = rewrite_expr(const_value, scope);
        } else if (const_value?.tag === "shape") {
          object = rewrite_expr(const_value, scope);
        }
      }

      if (object.tag === "shape") {
        return rewrite_expr(ordered_shape_field(object, expr.name), scope);
      }

      if (object.tag === "struct_value") {
        const field = lookup_field(object.fields, expr.name);

        if (field !== undefined) {
          return rewrite_expr(field.value, scope);
        }
      }

      if (
        object.tag === "if_let" && object.value_name !== undefined &&
        object.then_branch.tag === "var" &&
        object.then_branch.name === object.value_name
      ) {
        return {
          ...object,
          then_branch: {
            tag: "field",
            object: object.then_branch,
            name: expr.name,
          },
        };
      }

      return { ...expr, object };
    }

    case "index": {
      let object = rewrite_expr(expr.object, scope);
      const index = rewrite_expr(expr.index, scope);
      let repeated: Extract<FrontExpr, { tag: "array_repeat" }> | undefined;

      if (object.tag === "array_repeat") {
        repeated = object;
      } else if (object.tag === "var") {
        const const_value = scope.type_values.get(object.name);

        if (const_value?.tag === "array_repeat") {
          repeated = const_value;
        } else if (
          const_value?.tag === "product" || const_value?.tag === "array"
        ) {
          object = rewrite_expr(const_value, scope);
        } else {
          const binding = scope.bindings.get(object.name);

          if (binding?.value?.tag === "array_repeat") {
            repeated = binding.value;
          }
        }
      }

      if (
        repeated !== undefined && index.tag === "num" &&
        index.type === "i32" && typeof index.value === "number"
      ) {
        const length = constant_repeat_length(repeated.length);

        if (index.value < 0 || index.value >= length) {
          throw new Error(
            "Repeated product index out of bounds: " + index.value.toString() +
              " for length " + length.toString(),
          );
        }

        return rewrite_expr(repeated.value, scope);
      }

      if (object.tag === "var") {
        const const_value = scope.type_values.get(object.name);

        if (
          const_value !== undefined &&
          is_comptime_descriptor_value(const_value)
        ) {
          object = rewrite_expr(const_value, scope);
        }
      }

      if (
        object.tag === "array" && object.rest === undefined &&
        index.tag === "num" && index.type === "i32" &&
        typeof index.value === "number"
      ) {
        const item = object.items[index.value];

        if (item !== undefined) {
          return rewrite_expr(item, scope);
        }
      }

      if (
        object.tag === "product" && index.tag === "num" &&
        index.type === "i32" && typeof index.value === "number"
      ) {
        const entry = object.entries[index.value];

        if (entry !== undefined) {
          return rewrite_expr(entry.value, scope);
        }
      }

      if (
        object.tag === "if_let" && object.value_name !== undefined &&
        object.then_branch.tag === "var" &&
        object.then_branch.name === object.value_name &&
        index.tag === "num" && index.type === "i32" &&
        typeof index.value === "number"
      ) {
        return {
          ...object,
          then_branch: {
            tag: "index",
            object: object.then_branch,
            index,
          },
        };
      }

      return { ...expr, object, index };
    }

    case "is":
      return lower_is_boolean({
        ...expr,
        type_expr: normalize_scope_type_expr(expr.type_expr, scope),
      }, scope);

    case "as": {
      const result_type_expr = normalize_scope_type_expr(expr.type_expr, scope);
      let result_type_value = scope_type_value_from_type_expr(result_type_expr);

      if (result_type_value === undefined) {
        result_type_value = { tag: "set_type", type_expr: result_type_expr };
      }

      const rewritten: Extract<FrontExpr, { tag: "as" }> = {
        ...expr,
        value: rewrite_expr(expr.value, scope),
        type_expr: relabel_product_type_expr(expr.type_expr, scope),
      };
      return rewrite_expr(
        elaborate_product_as_expr(rewritten, result_type_value),
        scope,
      );
    }

    case "match": {
      if (expr.target.tag === "var") {
        const binding = scope.bindings.get(expr.target.name);

        if (
          binding?.compiletime_only === true && binding.value === undefined
        ) {
          return expr;
        }
      }

      return elaborate_match_expr(expr, scope);
    }

    case "union_case": {
      let value = expr.value;
      let type_expr = expr.type_expr;

      if (value) {
        value = rewrite_expr(value, scope);
      }

      if (type_expr) {
        type_expr = rewrite_expr(type_expr, scope);
      }

      return { ...expr, value, type_expr };
    }
  }
}

function relabel_product_type_expr(
  type: TypeExpr,
  scope: TypeSetScope,
): TypeExpr {
  const normalized = normalize_scope_type_expr(type, scope);
  const type_value = scope_type_value_from_type_expr(normalized);

  if (type_value === undefined) {
    return normalized;
  }

  const resolved = resolve_front_type_value(
    type_value,
    scope.type_values,
    new Set(),
  );

  if (resolved?.tag !== "struct_type") {
    return normalized;
  }

  return {
    tag: "product",
    entries: resolved.fields.map((field) => {
      let field_type = field.set_member;

      if (field_type === undefined) {
        field_type = parse_type_expr(tokenize(field.type_name));
      }

      return {
        label: field.name,
        type_expr: normalize_scope_type_expr(field_type, scope),
      };
    }),
  };
}

function resolve_extension_field(
  value: FrontExpr,
  name: string,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  if (value.tag === "with" || value.tag === "struct_update") {
    const field = lookup_field(value.fields, name);

    if (field !== undefined) {
      return field.value;
    }

    return resolve_extension_field(value.base, name, scope, resolving);
  }

  if (value.tag !== "var" || resolving.has(value.name)) {
    return undefined;
  }

  const next = scope.type_values.get(value.name);

  if (next === undefined) {
    return undefined;
  }

  resolving.add(value.name);
  return resolve_extension_field(next, name, scope, resolving);
}

function specialize_type_match_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  let target = func;

  if (target.tag === "var") {
    const binding = scope.bindings.get(target.name);

    if (!binding || binding.value === undefined) {
      return undefined;
    }

    target = binding.value;
  }

  if (
    target.tag !== "lam" ||
    !expr_requires_type_specialization(target.body)
  ) {
    return undefined;
  }

  if (target.params.length !== args.length) {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < args.length; index += 1) {
    const param = target.params[index];
    const arg = args[index];

    if (!param || !arg) {
      return undefined;
    }

    const type = resolve_front_type_value(arg, scope.type_values, new Set());

    if (!type || (type.tag === "var" && !scope.type_values.has(type.name))) {
      return undefined;
    }

    replacements.set(param.name, arg);
  }

  return substitute_front_expr(target.body, replacements);
}

function specialize_const_function_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag === "lam" && scope.evaluating_const_call) {
    if (func.params.length !== args.length) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (let index = 0; index < args.length; index += 1) {
      const param = func.params[index];
      const arg = args[index];
      expect(param, "Missing const lambda parameter " + index.toString());
      expect(arg, "Missing const lambda argument " + index.toString());
      replacements.set(param.name, arg);
    }

    return substitute_front_expr(func.body, replacements);
  }

  if (func.tag === "rec" && scope.evaluating_const_call) {
    const recursive_args = args.map((arg) =>
      unwrap_const_result(resolve_scope_const_value(arg, scope))
    );

    if (!recursive_args.every((arg) => scope_const_expr_known(arg, scope))) {
      return undefined;
    }

    return specialize_const_rec_call(
      func,
      recursive_args,
      scope,
      "const recursion",
    );
  }

  if (func.tag !== "var") {
    return undefined;
  }

  if (
    scope.evaluating_const_call && func.name === "rec" &&
    scope.const_recursion !== undefined
  ) {
    const recursive_args = args.map((arg) =>
      unwrap_const_result(resolve_scope_const_value(arg, scope))
    );

    if (!recursive_args.every((arg) => scope_const_expr_known(arg, scope))) {
      return undefined;
    }

    return specialize_const_rec_call(
      scope.const_recursion.target,
      recursive_args,
      scope,
      scope.const_recursion.name,
    );
  }

  const const_value = scope.type_values.get(func.name);

  if (
    scope.evaluating_const_call && const_value !== undefined &&
    const_value.tag === "lam"
  ) {
    if (const_value.params.length !== args.length) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (let index = 0; index < args.length; index += 1) {
      const param = const_value.params[index];
      const arg = args[index];
      expect(param, "Missing named const lambda parameter " + index.toString());
      expect(arg, "Missing named const lambda argument " + index.toString());
      replacements.set(param.name, arg);
    }

    return substitute_front_expr(const_value.body, replacements);
  }

  const binding = scope.bindings.get(func.name);

  if (
    !scope.evaluating_const_call && binding?.compiletime_only === true &&
    binding.value?.tag === "lam" &&
    binding.value.params.every((param) => param.is_const) &&
    args.every((arg) => scope_const_expr_known(arg, scope))
  ) {
    if (binding.value.params.length !== args.length) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (let index = 0; index < args.length; index += 1) {
      const param = binding.value.params[index];
      const arg = args[index];
      expect(param, "Missing const lambda parameter " + index.toString());
      expect(arg, "Missing const lambda argument " + index.toString());
      replacements.set(param.name, arg);
    }

    const evaluation_scope = clone_scope(scope);
    evaluation_scope.evaluating_const_call = true;
    evaluation_scope.const_evaluation = {
      recursions: new Map(),
      steps: 0,
    };
    return unwrap_const_result(rewrite_expr(
      substitute_front_expr(binding.value.body, replacements),
      evaluation_scope,
    ));
  }

  if (!scope.evaluating_const_call) {
    return undefined;
  }

  if (
    binding?.compiletime_only !== true || binding.value?.tag !== "rec"
  ) {
    return undefined;
  }

  if (!args.every((arg) => scope_const_expr_known(arg, scope))) {
    return undefined;
  }

  return specialize_const_rec_call(binding.value, args, scope, func.name);
}

function specialize_const_rec_call(
  target: Extract<FrontExpr, { tag: "rec" }>,
  initial_args: FrontExpr[],
  scope: TypeSetScope,
  name: string,
): FrontExpr {
  if (target.params.length !== initial_args.length) {
    throw new Error(
      "Const recursive function " + name + " expects " +
        target.params.length.toString() + " arguments, got " +
        initial_args.length.toString(),
    );
  }

  const context = scope.const_evaluation;
  expect(context, "Missing compile-time recursion context for " + name);
  let recursion = context.recursions.get(target);

  if (recursion === undefined) {
    recursion = {
      active: new Set(),
      memo: new Map(),
      name,
      target,
    };
    context.recursions.set(target, recursion);
  }

  const key = initial_args.map(format_expr).join(", ");
  context.steps += 1;

  if (context.steps > 10000) {
    throw new Error("Compile-time recursion exceeded 10000 steps: " + name);
  }

  const memoized = recursion.memo.get(key);

  if (memoized !== undefined) {
    return memoized;
  }

  if (recursion.active.has(key)) {
    throw new Error(
      "Compile-time recursion cycle detected at step " +
        context.steps.toString() + ": " + key,
    );
  }

  recursion.active.add(key);

  try {
    const replacements = new Map<string, FrontExpr>();

    for (let index = 0; index < initial_args.length; index += 1) {
      const param = target.params[index];
      const arg = initial_args[index];
      expect(param, "Missing const rec parameter " + index.toString());
      expect(arg, "Missing const rec argument " + index.toString());
      replacements.set(param.name, arg);
    }

    const evaluation_scope = clone_scope(scope);
    evaluation_scope.const_recursion = recursion;
    evaluation_scope.evaluating_const_call = true;
    const body = rewrite_expr(
      substitute_front_expr(target.body, replacements),
      evaluation_scope,
    );
    const result = unwrap_const_result(body);
    recursion.memo.set(key, result);
    return result;
  } finally {
    recursion.active.delete(key);
  }
}

function evaluate_const_block(
  statements: Stmt[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  const local = clone_scope(scope);
  const result = evaluate_const_statements(statements, local, true);

  if (result.tag === "unsupported") {
    return undefined;
  }

  if (result.value === undefined) {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();

  for (const statement of statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    const binding = local.bindings.get(statement.name);

    if (
      binding?.value !== undefined &&
      scope_const_expr_known(binding.value, local)
    ) {
      replacements.set(
        statement.name,
        substitute_front_expr(binding.value, replacements),
      );
    }
  }

  for (const [name, binding] of local.bindings) {
    if (
      replacements.has(name) || binding.value === undefined ||
      !scope_const_expr_known(binding.value, local) ||
      compiletime_type_value(binding.value, local)
    ) {
      continue;
    }

    replacements.set(name, substitute_front_expr(binding.value, replacements));
  }

  return materialize_product_type_value(
    substitute_front_expr(result.value, replacements),
  );
}

function materialize_product_type_value(value: FrontExpr): FrontExpr {
  if (value.tag !== "with") {
    return value;
  }

  const product = product_type_with_namespace(value);

  if (product === undefined) {
    return value;
  }

  return replace_product_type_base(value, product);
}

function replace_product_type_base(
  value: Extract<FrontExpr, { tag: "with" }>,
  product: Extract<FrontExpr, { tag: "struct_type" }>,
): Extract<FrontExpr, { tag: "with" }> {
  let base = value.base;

  if (base.tag === "with") {
    base = replace_product_type_base(base, product);
  } else {
    expect(base.tag === "product", "Product namespace has no product base");
    base = product;
  }

  return { ...value, base };
}

type ConstStatementEvaluation =
  | { tag: "complete"; value: FrontExpr | undefined }
  | { tag: "return"; value: FrontExpr }
  | { tag: "unsupported" };

function evaluate_const_statements(
  statements: Stmt[],
  local: TypeSetScope,
  keep_final_expression: boolean,
): ConstStatementEvaluation {
  let final_value: FrontExpr | undefined;

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    expect(statement, "Missing compile-time block statement " + index);
    const is_final = index + 1 === statements.length;

    if (statement.tag === "bind") {
      if (
        statement.is_linear ||
        (statement.pattern !== undefined &&
          statement.pattern.tag !== "binding")
      ) {
        return { tag: "unsupported" };
      }

      const value = evaluate_const_block_value(statement.value, local);
      set_const_scope_binding(local, statement.name, value);
      continue;
    }

    if (statement.tag === "assign") {
      if (!local.bindings.has(statement.name)) {
        throw new Error(
          "Cannot assign unbound compile-time name: " + statement.name,
        );
      }

      const value = evaluate_const_block_value(statement.value, local);
      set_const_scope_binding(local, statement.name, value);
      continue;
    }

    if (statement.tag === "for_collection") {
      const collection = evaluate_const_block_value(
        statement.collection,
        local,
      );
      const items = const_collection_items(collection);

      if (items === undefined) {
        return { tag: "unsupported" };
      }

      for (let item_index = 0; item_index < items.length; item_index += 1) {
        const item = items[item_index];
        expect(item, "Missing compile-time collection item " + item_index);
        const iteration = clone_scope(local);
        set_const_scope_binding(iteration, statement.item, item);

        if (statement.index !== undefined) {
          set_const_scope_binding(iteration, statement.index, {
            tag: "num",
            type: "i32",
            value: item_index,
          });
        }

        const result = evaluate_const_statements(
          statement.body,
          iteration,
          false,
        );

        if (result.tag === "unsupported") {
          return result;
        }

        if (result.tag === "return") {
          return result;
        }

        propagate_const_assignments(statement.body, iteration, local);
      }

      continue;
    }

    if (statement.tag === "expr") {
      const value = evaluate_const_block_value(statement.expr, local);

      if (is_final && keep_final_expression) {
        final_value = value;
      }

      continue;
    }

    if (statement.tag === "return") {
      return {
        tag: "return",
        value: evaluate_const_block_value(statement.value, local),
      };
    }

    return { tag: "unsupported" };
  }

  return { tag: "complete", value: final_value };
}

function evaluate_const_block_value(
  value: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  const result = unwrap_const_result(
    resolve_scope_const_value(rewrite_expr(value, scope), scope),
  );

  if (result.tag === "lam" || result.tag === "rec") {
    return capture_const_bindings(result, scope);
  }

  return result;
}

function set_const_scope_binding(
  scope: TypeSetScope,
  name: string,
  value: FrontExpr,
): void {
  scope.bindings.set(name, {
    annotation: undefined,
    value,
  });
  scope.type_values.set(name, value);
}

function const_collection_items(value: FrontExpr): FrontExpr[] | undefined {
  if (value.tag === "shape") {
    return value.entries.map((entry) => {
      expect(entry.label !== undefined, "Shape entry requires a name");
      return {
        tag: "shape",
        entries: [
          { label: "name", value: { tag: "text", value: entry.label } },
          { label: "value", value: entry.value },
        ],
      };
    });
  }

  if (value.tag === "product") {
    return value.entries.map((entry) => entry.value);
  }

  if (value.tag === "array" && value.rest === undefined) {
    return value.items;
  }

  return undefined;
}

function propagate_const_assignments(
  statements: Stmt[],
  source: TypeSetScope,
  target: TypeSetScope,
): void {
  for (const statement of statements) {
    if (statement.tag !== "assign" || !target.bindings.has(statement.name)) {
      continue;
    }

    const binding = source.bindings.get(statement.name);
    expect(binding, "Missing assigned compile-time binding " + statement.name);
    target.bindings.set(statement.name, binding);

    const type_value = source.type_values.get(statement.name);
    expect(type_value, "Missing assigned compile-time value " + statement.name);
    target.type_values.set(statement.name, type_value);
  }
}

function unwrap_const_result(expr: FrontExpr): FrontExpr {
  let result = expr;

  while (result.tag === "block") {
    const replacements = new Map<string, FrontExpr>();
    let next: FrontExpr | undefined;

    for (let index = 0; index < result.statements.length; index += 1) {
      const statement = result.statements[index];
      expect(statement, "Missing compile-time result statement " + index);

      if (
        statement.tag === "bind" && statement.kind === "const" &&
        index + 1 < result.statements.length
      ) {
        replacements.set(
          statement.name,
          substitute_front_expr(statement.value, replacements),
        );
        continue;
      }

      if (
        (statement.tag === "expr" || statement.tag === "return") &&
        index + 1 === result.statements.length
      ) {
        if (statement.tag === "expr") {
          next = substitute_front_expr(statement.expr, replacements);
        } else {
          next = substitute_front_expr(statement.value, replacements);
        }
      }

      break;
    }

    if (next === undefined) {
      break;
    }

    result = next;
  }

  return result;
}

function scope_const_expr_known(
  expr: FrontExpr,
  scope: TypeSetScope,
): boolean {
  if (
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "atom" ||
    expr.tag === "unit" || expr.tag === "text" || expr.tag === "type_name" ||
    expr.tag === "set_type" || expr.tag === "struct_type" ||
    expr.tag === "union_type" || expr.tag === "lam" || expr.tag === "rec"
  ) {
    return true;
  }

  if (expr.tag === "var") {
    return scope.type_values.has(expr.name) || is_builtin_type_name(expr.name);
  }

  if (expr.tag === "product") {
    return expr.entries.every((entry) =>
      scope_const_expr_known(entry.value, scope)
    );
  }

  if (expr.tag === "shape") {
    return expr.entries.every((entry) =>
      entry.value.tag === "var" || scope_const_expr_known(entry.value, scope)
    );
  }

  if (expr.tag === "array" && expr.rest === undefined) {
    return expr.items.every((item) => scope_const_expr_known(item, scope));
  }

  if (expr.tag === "struct_value") {
    return expr.fields.every((field) =>
      scope_const_expr_known(field.value, scope)
    );
  }

  if (expr.tag === "with") {
    return scope_const_expr_known(expr.base, scope) &&
      expr.fields.every((field) => scope_const_expr_known(field.value, scope));
  }

  if (expr.tag === "type_with") {
    return scope_const_expr_known(expr.base, scope) &&
      expr.members.every((member) =>
        scope_const_expr_known(member.name, scope) &&
        scope_const_expr_known(member.value, scope)
      );
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return scope_const_expr_known(expr.expr, scope);
  }

  return false;
}

function elaborate_const_collection_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag !== "var" || func.name !== "@len") {
    return undefined;
  }

  if (args.length !== 1) {
    throw new Error("len expects one collection value");
  }

  const arg = args[0];
  expect(arg, "Missing len collection value");
  const value = resolve_scope_const_value(arg, scope);

  if (value.tag === "array" && value.rest === undefined) {
    return { tag: "num", type: "i32", value: value.items.length };
  }

  if (value.tag === "product") {
    return { tag: "num", type: "i32", value: value.entries.length };
  }

  if (value.tag === "struct_value") {
    return { tag: "num", type: "i32", value: value.fields.length };
  }

  return undefined;
}

function elaborate_comptime_descriptor_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (
    func.tag !== "var" ||
    (func.name !== "@describe_type" && func.name !== "@describe_fields" &&
      func.name !== "@describe_cases")
  ) {
    return undefined;
  }

  if (args.length !== 1) {
    throw new Error(func.name + " expects one compile-time type value");
  }

  const arg = args[0];
  expect(arg, "Missing " + func.name + " type argument");
  const type = resolve_comptime_type_in_scope(arg, scope);

  if (type === undefined) {
    return undefined;
  }

  if (func.name === "@describe_type") {
    return describe_comptime_type(type);
  }

  if (func.name === "@describe_fields") {
    return describe_comptime_fields(type);
  }

  return describe_comptime_cases(type);
}

function resolve_comptime_type_in_scope(
  expr: FrontExpr,
  scope: TypeSetScope,
): import("./comptime_value.ts").ComptimeType | undefined {
  const resolved = resolve_front_type_value(
    expr,
    scope.type_values,
    new Set(),
  );

  if (
    resolved?.tag === "var" && expr.tag === "var" &&
    resolved.name === expr.name && !scope.type_values.has(expr.name) &&
    !is_builtin_type_name(expr.name)
  ) {
    return undefined;
  }

  const env: Env = { scopes: [], next: new Map() };
  return resolve_comptime_type(expr, env, {
    resolve_const_expr_with_env: (value, value_env) => {
      const resolved = resolve_front_type_value(
        value,
        scope.type_values,
        new Set(),
      );

      if (resolved === undefined) {
        return undefined;
      }

      return { expr: resolved, env: value_env };
    },
  });
}

function elaborate_const_directed_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag !== "var") {
    return undefined;
  }

  if (func.name === "@is_case") {
    if (args.length !== 2) {
      throw new Error(
        "is_case expects a union value and one compile-time case descriptor",
      );
    }

    const value = args[0];
    const descriptor_arg = args[1];
    expect(value, "is_case is missing its value");
    expect(descriptor_arg, "is_case is missing its case descriptor");
    const descriptor = resolve_scope_const_value(descriptor_arg, scope);

    if (descriptor.tag !== "struct_value") {
      if (
        descriptor.tag === "var" || descriptor.tag === "field" ||
        descriptor.tag === "index" || descriptor.tag === "app" ||
        descriptor.tag === "captured"
      ) {
        return undefined;
      }

      throw new Error("is_case requires a compile-time case descriptor");
    }

    if (const_descriptor_kind(descriptor) !== "case") {
      throw new Error("is_case requires a compile-time case descriptor");
    }

    return {
      tag: "if_let",
      case_name: const_descriptor_text(descriptor, "name"),
      value_name: undefined,
      target: value,
      then_branch: { tag: "bool", value: true },
      else_branch: { tag: "bool", value: false },
    };
  }

  if (func.name === "@project") {
    if (args.length !== 2) {
      throw new Error(
        "project expects a value and one compile-time field descriptor",
      );
    }

    const value = args[0];
    const descriptor_arg = args[1];
    expect(value, "project is missing its value");
    expect(descriptor_arg, "project is missing its field descriptor");
    const descriptor = resolve_scope_const_value(descriptor_arg, scope);

    if (descriptor.tag !== "struct_value") {
      if (
        descriptor.tag === "var" || descriptor.tag === "field" ||
        descriptor.tag === "index" || descriptor.tag === "app" ||
        descriptor.tag === "captured"
      ) {
        return undefined;
      }

      throw new Error("project requires a compile-time field descriptor");
    }

    const name_field = lookup_field(descriptor.fields, "name");
    const index_field = lookup_field(descriptor.fields, "index");

    if (const_descriptor_kind(descriptor) === "case") {
      const case_name = const_descriptor_text(descriptor, "name");
      const payload_name = fresh_is_payload_name("case_" + case_name, scope);
      const message: FrontExpr = {
        tag: "text",
        value: "project expected union case " + case_name,
      };
      return {
        tag: "if_let",
        case_name,
        value_name: payload_name,
        target: value,
        then_branch: { tag: "var", name: payload_name },
        else_branch: {
          tag: "app",
          func: { tag: "var", name: "@panic" },
          arg: message,
          args: [message],
        },
      };
    }

    if (
      name_field !== undefined && name_field.value.tag === "text" &&
      name_field.value.value.length > 0
    ) {
      return {
        tag: "field",
        object: value,
        name: name_field.value.value,
      };
    }

    if (
      index_field === undefined || index_field.value.tag !== "num" ||
      typeof index_field.value.value !== "number"
    ) {
      throw new Error("project descriptor is missing a numeric index");
    }

    return {
      tag: "index",
      object: value,
      index: {
        tag: "num",
        type: "i32",
        value: index_field.value.value,
      },
    };
  }

  if (func.name !== "@construct") {
    return undefined;
  }

  if (args.length !== 2) {
    throw new Error(
      "construct expects a compile-time type and one aggregate value",
    );
  }

  const type_expr = args[0];
  const values = args[1];
  expect(type_expr, "construct is missing its type");
  expect(values, "construct is missing its aggregate value");
  const descriptor = resolve_scope_const_value(type_expr, scope);

  if (
    descriptor.tag === "struct_value" &&
    const_descriptor_kind(descriptor) === "case"
  ) {
    const owner = lookup_field(descriptor.fields, "owner");
    expect(owner, "construct case descriptor is missing its owner type");
    return {
      tag: "union_case",
      name: const_descriptor_text(descriptor, "name"),
      value: values,
      type_expr: owner.value,
    };
  }

  const type = resolve_comptime_type_in_scope(type_expr, scope);

  if (type === undefined) {
    return undefined;
  }

  if (type.tag === "record") {
    const fields = type.fields.map((field, index) => {
      expect(field.name !== undefined, "construct record field has no name");
      let value: FrontExpr;

      if (values.tag === "struct_value") {
        const source = lookup_field(values.fields, field.name);
        expect(source, "construct is missing field " + field.name);
        value = source.value;
      } else if (values.tag === "product") {
        const source = values.entries[index];
        expect(
          source,
          "construct is missing field index " + index.toString(),
        );
        value = source.value;
      } else {
        value = { tag: "field", object: values, name: field.name };
      }

      return { name: field.name, value };
    });

    return { tag: "struct_value", type_expr, fields };
  }

  if (type.tag === "product" || type.tag === "tuple") {
    let fields: import("./comptime_value.ts").ComptimeTypeField[];

    if (type.tag === "product") {
      fields = type.entries;
    } else {
      fields = type.items.map((item) => ({
        name: undefined,
        type: item,
        source: item.source,
      }));
    }

    const entries: Extract<FrontExpr, { tag: "product" }>["entries"] = [];

    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      expect(field, "Missing construct product field " + index.toString());
      let value: FrontExpr;

      if (values.tag === "product") {
        const source = values.entries[index];
        expect(source, "construct is missing product entry " + index);
        value = source.value;
      } else {
        value = {
          tag: "index",
          object: values,
          index: { tag: "num", type: "i32", value: index },
        };
      }

      const entry: typeof entries[number] = { value };

      if (field.name !== undefined) {
        entry.label = field.name;
      }

      entries.push(entry);
    }

    return { tag: "product", entries };
  }

  if (type.tag === "array") {
    if (values.tag !== "array" || values.rest !== undefined) {
      throw new Error("construct fixed array requires an array value");
    }

    if (type.length.tag !== "number") {
      throw new Error("construct fixed array requires a resolved length");
    }

    if (values.items.length !== type.length.value) {
      throw new Error(
        "construct fixed array expects " + type.length.value.toString() +
          " values, got " + values.items.length.toString(),
      );
    }

    return values;
  }

  throw new Error("construct does not support type kind " + type.tag);
}

function const_descriptor_kind(
  descriptor: Extract<FrontExpr, { tag: "struct_value" }>,
): string | undefined {
  const kind = lookup_field(descriptor.fields, "kind");

  if (kind?.value.tag !== "atom") {
    return undefined;
  }

  return kind.value.name;
}

function const_descriptor_text(
  descriptor: Extract<FrontExpr, { tag: "struct_value" }>,
  name: string,
): string {
  const field = lookup_field(descriptor.fields, name);
  expect(field, "Compile-time descriptor is missing field " + name);
  expect(
    field.value.tag === "text" && field.value.value.length > 0,
    "Compile-time descriptor field " + name + " must be non-empty Text",
  );
  return field.value.value;
}

function resolve_scope_const_value(
  expr: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  let value = expr;
  const resolving = new Set<string>();

  while (value.tag === "var") {
    if (resolving.has(value.name)) {
      throw new Error("Recursive compile-time value: " + value.name);
    }

    const binding = scope.bindings.get(value.name);

    if (!binding || binding.value === undefined) {
      break;
    }

    resolving.add(value.name);
    value = binding.value;
  }

  return rewrite_expr(value, scope);
}

function scope_const_binding_value(
  expr: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  let value = expr;
  const resolving = new Set<string>();

  while (value.tag === "var") {
    if (resolving.has(value.name)) {
      throw new Error("Recursive compile-time value: " + value.name);
    }

    const binding = scope.bindings.get(value.name);

    if (binding?.value === undefined) {
      break;
    }

    resolving.add(value.name);
    value = binding.value;
  }

  return value;
}

function expr_requires_type_specialization(expr: FrontExpr): boolean {
  if (expr.tag === "type_with") {
    return true;
  }

  if (expr.tag === "match") {
    if (expr.arms.some((arm) => arm.pattern.tag === "type")) {
      return true;
    }

    if (expr_requires_type_specialization(expr.target)) {
      return true;
    }

    return expr.arms.some((arm) => {
      if (
        arm.guard !== undefined &&
        expr_requires_type_specialization(arm.guard)
      ) {
        return true;
      }

      return expr_requires_type_specialization(arm.body);
    });
  }

  if (expr.tag === "app") {
    if (
      expr.func.tag === "var" &&
      (expr.func.name === "@describe_type" ||
        expr.func.name === "@describe_fields" ||
        expr.func.name === "@describe_cases" ||
        expr.func.name === "@construct" || expr.func.name === "@project" ||
        expr.func.name === "@is_case" ||
        expr.func.name.startsWith("@type.") ||
        expr.func.name.startsWith("@shape."))
    ) {
      return true;
    }

    if (expr_requires_type_specialization(expr.func)) {
      return true;
    }

    return expr.args.some(expr_requires_type_specialization);
  }

  if (expr.tag === "block") {
    return expr.statements.some(statement_requires_type_specialization);
  }

  if (expr.tag === "if") {
    return expr_requires_type_specialization(expr.cond) ||
      expr_requires_type_specialization(expr.then_branch) ||
      expr_requires_type_specialization(expr.else_branch);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return expr_requires_type_specialization(expr.body);
  }

  if (expr.tag === "prim") {
    return expr_requires_type_specialization(expr.left) ||
      expr_requires_type_specialization(expr.right);
  }

  if (expr.tag === "field") {
    return expr_requires_type_specialization(expr.object);
  }

  if (expr.tag === "index") {
    return expr_requires_type_specialization(expr.object) ||
      expr_requires_type_specialization(expr.index);
  }

  return false;
}

function statement_requires_type_specialization(statement: Stmt): boolean {
  if (
    statement.tag === "bind" || statement.tag === "assign" ||
    statement.tag === "return"
  ) {
    return expr_requires_type_specialization(statement.value);
  }

  if (statement.tag === "expr") {
    return expr_requires_type_specialization(statement.expr);
  }

  if (statement.tag === "for_collection") {
    return expr_requires_type_specialization(statement.collection) ||
      statement.body.some(statement_requires_type_specialization);
  }

  if (statement.tag === "for_range") {
    return expr_requires_type_specialization(statement.start) ||
      expr_requires_type_specialization(statement.end) ||
      expr_requires_type_specialization(statement.step) ||
      statement.body.some(statement_requires_type_specialization);
  }

  if (statement.tag === "if_stmt") {
    return expr_requires_type_specialization(statement.cond) ||
      statement.body.some(statement_requires_type_specialization);
  }

  return false;
}

function rewrite_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  scope: TypeSetScope,
): FrontExpr {
  if (expr.cond.tag !== "is" || expr.cond.value.tag !== "var") {
    const cond = rewrite_expr(expr.cond, scope);
    const static_cond = static_i32_source_value(cond);

    if (scope.evaluating_const_call && static_cond !== undefined) {
      if (static_cond === 0) {
        return rewrite_expr(expr.else_branch, clone_scope(scope));
      }

      return rewrite_expr(expr.then_branch, clone_scope(scope));
    }

    return {
      ...expr,
      cond,
      then_branch: rewrite_expr(expr.then_branch, clone_scope(scope)),
      else_branch: rewrite_expr(expr.else_branch, clone_scope(scope)),
    };
  }

  const cases = matching_union_cases(
    expr.cond.value,
    expr.cond.type_expr,
    scope,
  );

  if (!cases || cases.length !== 1) {
    return {
      ...expr,
      cond: lower_is_boolean(expr.cond, scope),
      then_branch: rewrite_expr(expr.then_branch, clone_scope(scope)),
      else_branch: rewrite_expr(expr.else_branch, clone_scope(scope)),
    };
  }

  const matched = cases[0];
  expect(matched, "Missing matched type-set case");
  const then_name = fresh_is_payload_name(expr.cond.value.name, scope);
  const then_scope = clone_scope(scope);
  then_scope.bindings.set(then_name, {
    annotation: member_annotation(matched.set_member),
    value: undefined,
  });
  const union_type = union_type_for_value(expr.cond.value, scope);
  let else_branch: FrontExpr;

  if (union_type) {
    const remaining = union_type.cases.filter((item) =>
      item.name !== matched.name
    );
    const else_scope = clone_scope(scope);

    if (remaining.length > 0) {
      else_scope.bindings.set(
        expr.cond.value.name,
        binding_for_union_cases(remaining),
      );
    }

    if (remaining.length === 1) {
      const other = remaining[0];
      expect(other, "Missing complementary type-set case");
      const else_name = fresh_is_payload_name(expr.cond.value.name, scope);
      const payload_scope = clone_scope(else_scope);
      payload_scope.bindings.set(else_name, {
        annotation: member_annotation(other.set_member),
        value: undefined,
      });
      else_branch = {
        tag: "if_let",
        case_name: other.name,
        value_name: else_name,
        target: rewrite_expr(expr.cond.value, scope),
        then_branch: rewrite_expr(
          substitute_narrowed_value(
            expr.else_branch,
            expr.cond.value.name,
            else_name,
          ),
          payload_scope,
        ),
        else_branch: { tag: "unit" },
        implicit_else: true,
      };
    } else {
      else_branch = rewrite_expr(expr.else_branch, else_scope);
    }
  } else {
    else_branch = rewrite_expr(expr.else_branch, clone_scope(scope));
  }

  return {
    tag: "if_let",
    case_name: matched.name,
    value_name: then_name,
    target: rewrite_expr(expr.cond.value, scope),
    then_branch: rewrite_expr(
      substitute_narrowed_value(
        expr.then_branch,
        expr.cond.value.name,
        then_name,
      ),
      then_scope,
    ),
    else_branch,
    implicit_else: expr.implicit_else,
  };
}

function lower_is_boolean(
  expr: Extract<FrontExpr, { tag: "is" }>,
  scope: TypeSetScope,
): FrontExpr {
  const value = rewrite_expr(expr.value, scope);
  const cases = matching_union_cases(value, expr.type_expr, scope);

  if (cases) {
    if (cases.length === 0) {
      return { tag: "bool", value: false };
    }

    const union_type = union_type_for_value(value, scope);

    if (union_type && cases.length === union_type.cases.length) {
      return { tag: "bool", value: true };
    }

    let result: FrontExpr = { tag: "bool", value: false };

    for (let index = cases.length - 1; index >= 0; index -= 1) {
      const union_case = cases[index];
      expect(union_case, "Missing type-set predicate case " + index.toString());
      result = {
        tag: "if_let",
        case_name: union_case.name,
        value_name: undefined,
        target: value,
        then_branch: { tag: "bool", value: true },
        else_branch: result,
      };
    }

    return result;
  }

  if (expr.type_expr.tag === "atom") {
    return {
      tag: "prim",
      prim: "i32.eq",
      left: value,
      right: { tag: "atom", name: expr.type_expr.name },
    };
  }

  const value_type = semantic_type_for_value(value, scope);
  const tested = semantic_type_for_expr(expr.type_expr, scope, new Set());

  if (value_type) {
    if (sem_type_subtype(value_type, tested)) {
      return { tag: "bool", value: true };
    }

    if (sem_types_are_disjoint(value_type, tested)) {
      return { tag: "bool", value: false };
    }
  }

  throw new Error(
    "Cannot lower runtime `is` test for " + format_type_expr(expr.type_expr),
  );
}

function matching_union_cases(
  value: FrontExpr,
  tested: TypeExpr,
  scope: TypeSetScope,
): Array<{ name: string; set_member: TypeExpr }> | undefined {
  const union_type = union_type_for_value(value, scope);

  if (!union_type) {
    return undefined;
  }

  const target = semantic_type_for_expr(tested, scope, new Set());
  const result: Array<{ name: string; set_member: TypeExpr }> = [];

  for (const union_case of union_type.cases) {
    if (!union_case.set_member) {
      return undefined;
    }

    const member = semantic_type_for_expr(
      union_case.set_member,
      scope,
      new Set(),
    );

    if (sem_type_subtype(member, target)) {
      result.push({ name: union_case.name, set_member: union_case.set_member });
      continue;
    }

    const overlap = intersect_sem_types(member, target);

    if (overlap.tag !== "never") {
      throw new Error(
        "Runtime `is` test partially overlaps one tagged member: " +
          format_type_expr(union_case.set_member),
      );
    }
  }

  return result;
}

function union_type_for_value(
  value: FrontExpr,
  scope: TypeSetScope,
): Extract<FrontExpr, { tag: "union_type" }> | undefined {
  if (value.tag === "captured") {
    return union_type_for_value(value.expr, scope);
  }

  if (value.tag === "union_case" && value.type_expr) {
    return union_type_from_expr(value.type_expr, scope);
  }

  if (value.tag !== "var" && value.tag !== "linear") {
    return undefined;
  }

  const binding = scope.bindings.get(value.name);

  if (!binding || !binding.annotation) {
    return undefined;
  }

  if (binding.union_type) {
    return binding.union_type;
  }

  return union_type_from_annotation(binding.annotation, scope);
}

function union_type_from_annotation(
  annotation: string,
  scope: TypeSetScope,
): Extract<FrontExpr, { tag: "union_type" }> | undefined {
  const named = scope.type_values.get(annotation);
  let resolved_named: FrontExpr | undefined;

  if (named) {
    resolved_named = resolve_front_type_value(
      named,
      scope.type_values,
      new Set([annotation]),
    );
  }

  if (resolved_named?.tag === "union_type") {
    return resolved_named;
  }

  const type = parse_type_expr(tokenize(annotation));
  const type_value = scope_type_value_from_type_expr(type);

  if (type_value) {
    const resolved = resolve_front_type_value(
      type_value,
      scope.type_values,
      new Set(),
    );

    if (resolved?.tag === "union_type") {
      return resolved;
    }
  }

  const value = front_type_value_for_semantic_type(
    "<is annotation>",
    type,
    semantic_type_for_expr(type, scope, new Set()),
  );

  if (value.tag === "union_type") {
    return value;
  }

  return undefined;
}

function scope_type_value_from_type_expr(
  type: TypeExpr,
): FrontExpr | undefined {
  if (type.tag === "name") {
    return { tag: "var", name: type.name };
  }

  if (type.tag === "apply") {
    const func = scope_type_value_from_type_expr(type.func);
    const arg = scope_type_value_from_type_expr(type.arg);

    if (!func || !arg) {
      return undefined;
    }

    return { tag: "app", func, args: [arg] };
  }

  return undefined;
}

function lower_direct_type_set_annotation(
  annotation: string | undefined,
  scope: TypeSetScope,
): string | undefined {
  if (!annotation) {
    return undefined;
  }

  const type = normalize_scope_type_expr(
    parse_type_expr(tokenize(annotation)),
    scope,
  );
  expect(type, "Missing normalized type annotation");
  const normalized_annotation = format_type_expr(type);

  if (type.tag !== "apply") {
    return normalized_annotation;
  }

  const union_type = union_type_from_annotation(normalized_annotation, scope);

  if (!union_type) {
    return normalized_annotation;
  }

  const first = union_type.cases[0];

  if (!first?.set_member) {
    return normalized_annotation;
  }

  let resolved = first.set_member;

  for (const union_case of union_type.cases.slice(1)) {
    if (!union_case.set_member) {
      return normalized_annotation;
    }

    resolved = {
      tag: "union",
      left: resolved,
      right: union_case.set_member,
    };
  }

  return format_type_expr(resolved);
}

function normalize_scope_param(param: Param, scope: TypeSetScope): Param {
  return {
    ...param,
    annotation: lower_direct_type_set_annotation(param.annotation, scope),
    type_annotation: normalize_scope_type_expr(param.type_annotation, scope),
  };
}

function normalize_scope_annotation(
  annotation: string,
  scope: TypeSetScope,
): string {
  const type = normalize_scope_type_expr(
    parse_type_expr(tokenize(annotation)),
    scope,
  );
  expect(type, "Missing normalized type annotation");
  return format_type_expr(type);
}

function normalize_scope_type_expr(
  type: TypeExpr,
  scope: TypeSetScope,
): TypeExpr;
function normalize_scope_type_expr(
  type: TypeExpr | undefined,
  scope: TypeSetScope,
): TypeExpr | undefined;
function normalize_scope_type_expr(
  type: TypeExpr | undefined,
  scope: TypeSetScope,
): TypeExpr | undefined {
  if (type === undefined) {
    return undefined;
  }

  return normalize_fixed_array_type_lengths(
    type,
    (name) => scope_const_i32_name(name, scope, new Set()),
  );
}

function scope_const_i32_name(
  name: string,
  scope: TypeSetScope,
  resolving: Set<string>,
): number | undefined {
  if (resolving.has(name)) {
    throw new Error(
      "Recursive fixed array length: " + [...resolving, name].join(" -> "),
    );
  }

  const value = scope.type_values.get(name);

  if (value === undefined) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(name);
  return scope_const_i32_expr(value, scope, next);
}

function scope_const_i32_expr(
  expr: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): number | undefined {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    typeof expr.value === "number"
  ) {
    return expr.value;
  }

  if (expr.tag === "var") {
    return scope_const_i32_name(expr.name, scope, resolving);
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return scope_const_i32_expr(expr.expr, scope, resolving);
  }

  if (expr.tag === "block") {
    return scope_const_i32_expr(
      unwrap_const_result(expr),
      scope,
      resolving,
    );
  }

  if (expr.tag !== "prim") {
    return undefined;
  }

  const left = scope_const_i32_expr(expr.left, scope, resolving);
  const right = scope_const_i32_expr(expr.right, scope, resolving);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  return static_i32_source_value({
    ...expr,
    left: { tag: "num", type: "i32", value: left },
    right: { tag: "num", type: "i32", value: right },
  });
}

function union_type_from_expr(
  expr: FrontExpr,
  scope: TypeSetScope,
): Extract<FrontExpr, { tag: "union_type" }> | undefined {
  if (expr.tag === "union_type") {
    return expr;
  }

  if (expr.tag === "var") {
    const value = scope.type_values.get(expr.name);
    let resolved: FrontExpr | undefined;

    if (value) {
      resolved = resolve_front_type_value(
        value,
        scope.type_values,
        new Set([expr.name]),
      );
    }

    if (resolved?.tag === "union_type") {
      return resolved;
    }
  }

  return undefined;
}

function semantic_type_for_value(
  value: FrontExpr,
  scope: TypeSetScope,
): SemType | undefined {
  switch (value.tag) {
    case "bool":
      return { tag: "scalar", name: "Bool" };

    case "atom":
      return { tag: "atom", name: value.name };

    case "num":
      if (value.type === "i64") {
        return { tag: "scalar", name: "I64" };
      }

      return { tag: "scalar", name: "I32" };

    case "text":
      return { tag: "scalar", name: "Text" };

    case "freeze": {
      const inner = semantic_type_for_value(value.value, scope);

      if (!inner) {
        return undefined;
      }

      return { tag: "frozen", value: inner };
    }

    case "borrow": {
      const inner = semantic_type_for_value(value.value, scope);

      if (!inner) {
        return undefined;
      }

      return { tag: "borrow", value: inner };
    }

    case "var":
    case "linear": {
      const binding = scope.bindings.get(value.name);

      if (!binding?.annotation) {
        return undefined;
      }

      return semantic_type_for_expr(
        parse_type_expr(tokenize(binding.annotation)),
        scope,
        new Set(),
      );
    }

    default:
      return undefined;
  }
}

function semantic_type_for_expr(
  type: TypeExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): SemType {
  return sem_type_from_expr(type, (name) => {
    if (resolving.has(name)) {
      throw new Error(
        "Recursive type-set alias: " + [...resolving, name].join(" -> "),
      );
    }

    const value = scope.type_values.get(name);

    if (!value) {
      return undefined;
    }

    const next = new Set(resolving);
    next.add(name);

    const resolved = resolve_front_type_value(value, scope.type_values, next);

    if (!resolved) {
      return undefined;
    }

    if (resolved.tag === "set_type") {
      return semantic_type_for_expr(resolved.type_expr, scope, next);
    }

    if (resolved.tag === "struct_type") {
      return {
        tag: "record",
        name,
        fields: resolved.fields.map((field) => ({
          name: field.name,
          type: semantic_type_for_expr(
            parse_type_expr(tokenize(field.type_name)),
            scope,
            next,
          ),
        })),
      };
    }

    if (resolved.tag === "union_type") {
      const members: SemType[] = [];

      for (const union_case of resolved.cases) {
        if (!union_case.set_member) {
          return { tag: "variant", name };
        }

        members.push(
          semantic_type_for_expr(union_case.set_member, scope, next),
        );
      }

      return { tag: "union", members };
    }

    if (resolved.tag === "var" || resolved.tag === "type_name") {
      return semantic_type_for_expr(
        { tag: "name", name: resolved.name },
        scope,
        next,
      );
    }

    return undefined;
  });
}

export function resolve_front_type_value(
  value: FrontExpr,
  type_values: Map<string, FrontExpr>,
  resolving: Set<string>,
): FrontExpr | undefined {
  if (value.tag === "captured" || value.tag === "comptime") {
    return resolve_front_type_value(value.expr, type_values, resolving);
  }

  if (value.tag === "with") {
    const product = product_type_with_namespace(value);

    if (product !== undefined) {
      return product;
    }

    return resolve_front_type_value(value.base, type_values, resolving);
  }

  if (value.tag === "product") {
    return product_type_with_namespace(value);
  }

  if (
    value.tag === "union_type" || value.tag === "struct_type" ||
    value.tag === "set_type" || value.tag === "lam"
  ) {
    return value;
  }

  if (value.tag === "var") {
    if (resolving.has(value.name)) {
      return undefined;
    }

    const target = type_values.get(value.name);

    if (!target) {
      return value;
    }

    const next = new Set(resolving);
    next.add(value.name);
    return resolve_front_type_value(target, type_values, next);
  }

  if (value.tag !== "app") {
    return undefined;
  }

  const specialized = specialize_front_type_constructor(
    value,
    type_values,
    resolving,
  );

  if (specialized === undefined) {
    return undefined;
  }

  return resolve_front_type_value(
    specialized,
    type_values,
    resolving,
  );
}

function product_type_with_namespace(
  value: Extract<FrontExpr, { tag: "product" | "with" }>,
): Extract<FrontExpr, { tag: "struct_type" }> | undefined {
  const members: import("./ast.ts").Field[] = [];
  let base: FrontExpr = value;

  while (base.tag === "with") {
    members.push(...base.fields);
    base = base.base;
  }

  if (
    base.tag !== "product" ||
    !base.entries.every((entry) => source_type_value_syntax(entry.value))
  ) {
    return undefined;
  }

  const names = new Map<number, string>();

  for (const member of members) {
    const index = namespace_accessor_index(member.value);

    if (index !== undefined) {
      names.set(index, member.name);
    }
  }

  return {
    tag: "struct_type",
    fields: base.entries.map((entry, index) => {
      const type_expr = prelude_type_expr(entry.value);
      let name = entry.label;

      if (name === undefined) {
        name = names.get(index);
      }

      if (name === undefined) {
        name = "item_" + index.toString();
      }

      const field: TypeField = {
        name,
        type_name: format_type_expr(type_expr),
      };

      if (type_expr.tag !== "name") {
        field.set_member = type_expr;
      }

      return field;
    }),
  };
}

function namespace_accessor_index(value: FrontExpr): number | undefined {
  if (
    value.tag !== "lam" || value.params.length !== 1 ||
    value.body.tag !== "index" || value.body.object.tag !== "var" ||
    value.body.index.tag !== "num" || value.body.index.type !== "i32" ||
    typeof value.body.index.value !== "number"
  ) {
    return undefined;
  }

  const param = value.params[0];

  if (
    param === undefined || value.body.object.name !== param.name ||
    !Number.isInteger(value.body.index.value) || value.body.index.value < 0
  ) {
    return undefined;
  }

  return value.body.index.value;
}

function source_type_value_syntax(value: FrontExpr): boolean {
  if (
    value.tag === "var" || value.tag === "type_name" ||
    value.tag === "set_type" || value.tag === "struct_type" ||
    value.tag === "union_type"
  ) {
    return true;
  }

  if (value.tag === "with") {
    return source_type_value_syntax(value.base);
  }

  if (value.tag === "product") {
    return value.entries.every((entry) =>
      source_type_value_syntax(entry.value)
    );
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return source_type_value_syntax(value.value);
  }

  if (value.tag === "app") {
    return source_type_value_syntax(value.func) &&
      value.args.every(source_type_value_syntax);
  }

  return false;
}

function specialize_front_type_constructor(
  value: Extract<FrontExpr, { tag: "app" }>,
  type_values: Map<string, FrontExpr>,
  resolving: Set<string>,
): FrontExpr | undefined {
  const func = resolve_front_type_value(value.func, type_values, resolving);

  if (!func || func.tag !== "lam") {
    return undefined;
  }

  if (func.params.length !== value.args.length) {
    return undefined;
  }

  const type_args = new Map<string, string>();

  for (let index = 0; index < func.params.length; index += 1) {
    const param = func.params[index];
    const arg = value.args[index];

    if (!param || !arg) {
      return undefined;
    }

    const type_name = scope_type_argument_name(arg, type_values, resolving);

    if (!type_name) {
      return undefined;
    }

    type_args.set(param.name, type_name);
  }

  return substitute_scope_type_value(func.body, type_args);
}

function scope_type_argument_name(
  value: FrontExpr,
  type_values: Map<string, FrontExpr>,
  resolving: Set<string>,
): string | undefined {
  if (value.tag === "type_name" || value.tag === "var") {
    const target = type_values.get(value.name);

    if (target) {
      const next = new Set(resolving);
      next.add(value.name);
      const resolved_target = resolve_front_type_value(
        target,
        type_values,
        next,
      );

      if (
        resolved_target?.tag === "type_name" || resolved_target?.tag === "var"
      ) {
        return resolved_target.name;
      }
    }

    return value.name;
  }

  const resolved = resolve_front_type_value(value, type_values, resolving);

  if (resolved?.tag === "type_name" || resolved?.tag === "var") {
    return resolved.name;
  }

  return undefined;
}

function substitute_scope_type_value(
  value: FrontExpr,
  type_args: Map<string, string>,
): FrontExpr {
  if (value.tag === "var") {
    const type_name = type_args.get(value.name);

    if (type_name) {
      return { tag: "var", name: type_name };
    }

    return value;
  }

  if (value.tag === "union_type") {
    return {
      tag: "union_type",
      cases: value.cases.map((union_case) => {
        let type_name = union_case.type_name;
        const replacement = type_args.get(type_name);

        if (replacement) {
          type_name = replacement;
        }

        const result = { ...union_case, type_name };

        if (union_case.set_member) {
          result.set_member = substitute_scope_type_expr(
            union_case.set_member,
            type_args,
          );
        }

        return result;
      }),
    };
  }

  if (value.tag === "struct_type") {
    return {
      tag: "struct_type",
      fields: value.fields.map((field) => {
        const replacement = type_args.get(field.type_name);

        if (!replacement) {
          return field;
        }

        return { ...field, type_name: replacement };
      }),
    };
  }

  if (value.tag === "set_type") {
    return {
      tag: "set_type",
      type_expr: substitute_scope_type_expr(value.type_expr, type_args),
    };
  }

  if (value.tag === "with") {
    return {
      tag: "with",
      base: substitute_scope_type_value(value.base, type_args),
      fields: value.fields.map((field) => ({
        ...field,
        value: substitute_scope_type_value(field.value, type_args),
      })),
    };
  }

  if (value.tag === "app") {
    return {
      ...value,
      func: substitute_scope_type_value(value.func, type_args),
      args: value.args.map((arg) =>
        substitute_scope_type_value(arg, type_args)
      ),
    };
  }

  if (value.tag === "lam") {
    const scoped = new Map(type_args);

    for (const param of value.params) {
      scoped.delete(param.name);
    }

    return {
      ...value,
      body: substitute_scope_type_value(value.body, scoped),
    };
  }

  return value;
}

function substitute_scope_type_expr(
  type: TypeExpr,
  type_args: Map<string, string>,
): TypeExpr {
  switch (type.tag) {
    case "forall": {
      const scoped = new Map(type_args);

      for (const param of type.params) {
        scoped.delete(param);
      }

      return {
        ...type,
        body: substitute_scope_type_expr(type.body, scoped),
      };
    }

    case "name": {
      const type_name = type_args.get(type.name);

      if (type_name) {
        return { tag: "name", name: type_name };
      }

      return type;
    }

    case "atom":
    case "top":
    case "never":
      return type;

    case "frozen":
    case "borrow":
      return {
        ...type,
        value: substitute_scope_type_expr(type.value, type_args),
      };

    case "union":
    case "intersection":
    case "difference":
      return {
        ...type,
        left: substitute_scope_type_expr(type.left, type_args),
        right: substitute_scope_type_expr(type.right, type_args),
      };

    case "apply":
      return {
        tag: "apply",
        func: substitute_scope_type_expr(type.func, type_args),
        arg: substitute_scope_type_expr(type.arg, type_args),
      };

    case "tuple":
      return {
        tag: "tuple",
        items: type.items.map((item) =>
          substitute_scope_type_expr(item, type_args)
        ),
      };

    case "product":
      return {
        tag: "product",
        entries: type.entries.map((entry) => ({
          ...entry,
          type_expr: substitute_scope_type_expr(entry.type_expr, type_args),
        })),
      };

    case "array":
      return {
        ...type,
        element: substitute_scope_type_expr(type.element, type_args),
      };

    case "arrow":
      return {
        ...type,
        param: substitute_scope_type_expr(type.param, type_args),
        result: substitute_scope_type_expr(type.result, type_args),
      };
  }
}

function union_case_payload_annotation(
  target: FrontExpr,
  case_name: string,
  scope: TypeSetScope,
): string | undefined {
  const union_type = union_type_for_value(target, scope);

  if (!union_type) {
    return undefined;
  }

  const union_case = union_type.cases.find((item) => item.name === case_name);

  if (!union_case) {
    return undefined;
  }

  return member_annotation(union_case.set_member) || union_case.type_name;
}

function member_annotation(member: TypeExpr | undefined): string | undefined {
  if (!member) {
    return undefined;
  }

  return format_type_expr(member);
}

function scope_for_params(params: Param[], parent: TypeSetScope): TypeSetScope {
  const scope = clone_scope(parent);

  for (const param of params) {
    scope.bindings.set(param.name, {
      annotation: param.annotation,
      compiletime_only: param.is_const,
      value: undefined,
      union_type: binding_union_type(param.annotation, scope),
    });
  }

  return scope;
}

function binding_union_type(
  annotation: string | undefined,
  scope: TypeSetScope,
): Extract<FrontExpr, { tag: "union_type" }> | undefined {
  if (!annotation) {
    return undefined;
  }

  return union_type_from_annotation(annotation, scope);
}

function inject_type_set_call_arguments(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr[] {
  const params = callable_type_set_params(func, scope, new Set());

  if (!params) {
    return args;
  }

  return args.map((arg, index) => {
    const param = params[index];

    if (!param?.annotation) {
      return arg;
    }

    return inject_type_set_value(param.annotation, arg, scope, "parameter");
  });
}

function callable_type_set_params(
  func: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): Param[] | undefined {
  if (func.tag === "lam" || func.tag === "rec") {
    return func.params;
  }

  if (func.tag === "captured" || func.tag === "comptime") {
    return callable_type_set_params(func.expr, scope, resolving);
  }

  if (func.tag === "block") {
    const final = func.statements[func.statements.length - 1];

    if (final?.tag === "expr") {
      return callable_type_set_params(final.expr, scope, resolving);
    }

    if (final?.tag === "return") {
      return callable_type_set_params(final.value, scope, resolving);
    }

    return undefined;
  }

  if (func.tag === "if") {
    const then_params = callable_type_set_params(
      func.then_branch,
      scope,
      new Set(resolving),
    );
    const else_params = callable_type_set_params(
      func.else_branch,
      scope,
      new Set(resolving),
    );

    if (!then_params || !else_params) {
      return undefined;
    }

    if (then_params.length !== else_params.length) {
      return undefined;
    }

    for (let index = 0; index < then_params.length; index += 1) {
      const then_param = then_params[index];
      const else_param = else_params[index];

      if (!then_param || !else_param) {
        return undefined;
      }

      if (!same_callable_type_set_param(then_param, else_param, scope)) {
        return undefined;
      }
    }

    return then_params;
  }

  if (func.tag !== "var" && func.tag !== "linear") {
    return undefined;
  }

  if (resolving.has(func.name)) {
    return undefined;
  }

  const binding = scope.bindings.get(func.name);

  if (!binding?.value) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(func.name);
  return callable_type_set_params(binding.value, scope, next);
}

function static_const_equality(expr: FrontExpr): number | undefined {
  if (
    expr.tag !== "prim" ||
    (expr.prim !== "i32.eq" && expr.prim !== "i32.ne")
  ) {
    return undefined;
  }

  let equal: boolean | undefined;

  if (expr.left.tag === "atom" && expr.right.tag === "atom") {
    equal = expr.left.name === expr.right.name;
  } else if (expr.left.tag === "text" && expr.right.tag === "text") {
    equal = expr.left.value === expr.right.value;
  } else if (
    expr.left.tag === "type_name" && expr.right.tag === "type_name"
  ) {
    equal = expr.left.name === expr.right.name;
  }

  if (equal === undefined) {
    return undefined;
  }

  if (expr.prim === "i32.ne") {
    equal = !equal;
  }

  if (equal) {
    return 1;
  }

  return 0;
}

function static_i32_source_value(expr: FrontExpr): number | undefined {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    typeof expr.value === "number"
  ) {
    return expr.value;
  }

  if (expr.tag === "bool") {
    if (expr.value) {
      return 1;
    }

    return 0;
  }

  if (expr.tag !== "prim") {
    return undefined;
  }

  const left = static_i32_source_value(expr.left);
  const right = static_i32_source_value(expr.right);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  switch (expr.prim) {
    case "i32.add":
      return (left + right) | 0;
    case "i32.sub":
      return (left - right) | 0;
    case "i32.mul":
      return Math.imul(left, right);
    case "i32.div_s":
      if (right === 0) {
        throw new Error("Compile-time integer division by zero");
      }
      return Math.trunc(left / right) | 0;
    case "i32.rem_s":
      if (right === 0) {
        throw new Error("Compile-time integer remainder by zero");
      }
      return left % right;
    case "i32.eq":
      if (left === right) {
        return 1;
      }
      return 0;
    case "i32.ne":
      if (left !== right) {
        return 1;
      }
      return 0;
    case "i32.lt_s":
      if (left < right) {
        return 1;
      }
      return 0;
    case "i32.le_s":
      if (left <= right) {
        return 1;
      }
      return 0;
    case "i32.gt_s":
      if (left > right) {
        return 1;
      }
      return 0;
    case "i32.ge_s":
      if (left >= right) {
        return 1;
      }
      return 0;
    case "i64.add":
    case "i64.sub":
    case "i64.mul":
    case "i64.div_s":
    case "i64.rem_s":
    case "i64.eq":
    case "i64.ne":
    case "i64.lt_s":
    case "i64.le_s":
    case "i64.gt_s":
    case "i64.ge_s":
    case "i32.select":
    case "i64.select":
    case "i32.load":
    case "i64.load":
    case "i32.load8_u":
    case "i64.load8_u":
    case "i32.trap":
    case "i64.trap":
      return undefined;
  }
}

function same_callable_type_set_param(
  left: Param,
  right: Param,
  scope: TypeSetScope,
): boolean {
  if (left.annotation === right.annotation) {
    return true;
  }

  if (!left.annotation || !right.annotation) {
    return false;
  }

  const left_union = union_type_from_annotation(left.annotation, scope);
  const right_union = union_type_from_annotation(right.annotation, scope);

  if (!left_union || !right_union) {
    return false;
  }

  if (left_union.cases.length !== right_union.cases.length) {
    return false;
  }

  for (let index = 0; index < left_union.cases.length; index += 1) {
    const left_case = left_union.cases[index];
    const right_case = right_union.cases[index];

    if (!left_case || !right_case) {
      return false;
    }

    if (!left_case.set_member || !right_case.set_member) {
      return false;
    }

    if (
      left_case.name !== right_case.name ||
      left_case.type_name !== right_case.type_name
    ) {
      return false;
    }
  }

  const left_semantic = semantic_type_for_expr(
    parse_type_expr(tokenize(left.annotation)),
    scope,
    new Set(),
  );
  const right_semantic = semantic_type_for_expr(
    parse_type_expr(tokenize(right.annotation)),
    scope,
    new Set(),
  );
  return sem_type_key(left_semantic) === sem_type_key(right_semantic);
}

function inject_type_set_value(
  annotation: string,
  value: FrontExpr,
  scope: TypeSetScope,
  annotation_site: "binding" | "parameter",
): FrontExpr {
  if (value.tag === "union_case") {
    return value;
  }

  const union_type = union_type_from_annotation(annotation, scope);

  if (!union_type) {
    return value;
  }

  const actual = semantic_type_for_value(value, scope);

  if (!actual) {
    return value;
  }

  for (const union_case of union_type.cases) {
    if (!union_case.set_member) {
      return value;
    }

    const expected = semantic_type_for_expr(
      union_case.set_member,
      scope,
      new Set(),
    );

    if (!sem_type_subtype(actual, expected)) {
      continue;
    }

    let type_expr: FrontExpr = union_type;
    const named = scope.type_values.get(annotation);

    if (named?.tag === "union_type") {
      type_expr = { tag: "var", name: annotation };
    }

    return {
      tag: "union_case",
      name: union_case.name,
      value,
      type_expr,
    };
  }

  const annotated = semantic_type_for_expr(
    parse_type_expr(tokenize(annotation)),
    scope,
    new Set(),
  );

  if (sem_type_key(actual) === sem_type_key(annotated)) {
    return value;
  }

  let actual_name = sem_type_key(actual);

  if (actual.tag === "scalar") {
    actual_name = actual.name;
  } else if (actual.tag === "atom") {
    actual_name = "#" + actual.name;
  }

  throw new Error(
    "Type-set " + annotation_site + " annotation expects " + annotation +
      ", got " + actual_name,
  );
}

function binding_for_union_cases(
  cases: Array<{
    name: string;
    type_name: string;
    set_member?: TypeExpr;
  }>,
): TypeSetBinding {
  const members: TypeExpr[] = [];

  for (const union_case of cases) {
    if (!union_case.set_member) {
      return {
        annotation: union_case_payload_annotation_text(cases),
        value: undefined,
      };
    }

    members.push(union_case.set_member);
  }

  const first = members[0];
  expect(first, "Missing remaining type-set member");
  let annotation_type = first;

  for (const member of members.slice(1)) {
    annotation_type = {
      tag: "union",
      left: annotation_type,
      right: member,
    };
  }

  return {
    annotation: format_type_expr(annotation_type),
    value: undefined,
    union_type: { tag: "union_type", cases },
  };
}

function union_case_payload_annotation_text(
  cases: Array<{ type_name: string }>,
): string | undefined {
  const first = cases[0];

  if (!first) {
    return undefined;
  }

  let annotation = first.type_name;

  for (const union_case of cases.slice(1)) {
    annotation += "|" + union_case.type_name;
  }

  return annotation;
}

function clone_scope(scope: TypeSetScope): TypeSetScope {
  return {
    bindings: new Map(scope.bindings),
    const_evaluation: scope.const_evaluation,
    const_recursion: scope.const_recursion,
    evaluating_const_call: scope.evaluating_const_call,
    fresh: scope.fresh,
    type_values: new Map(scope.type_values),
  };
}

function fresh_is_payload_name(name: string, scope: TypeSetScope): string {
  const fresh = "_" + name + "#is" + scope.fresh.next.toString();
  scope.fresh.next += 1;
  return fresh;
}

function fresh_match_target_name(scope: TypeSetScope): string {
  const fresh = "_match#target" + scope.fresh.next.toString();
  scope.fresh.next += 1;
  return fresh;
}

function fresh_pattern_source_name(scope: TypeSetScope): string {
  const fresh = "_pattern#source" + scope.fresh.next.toString();
  scope.fresh.next += 1;
  return fresh;
}

function fresh_pattern_parameter_name(scope: TypeSetScope): string {
  const fresh = "_pattern#param" + scope.fresh.next.toString();
  scope.fresh.next += 1;
  return fresh;
}

function fresh_array_repeat_name(scope: TypeSetScope): string {
  const fresh = "_array_repeat#value" + scope.fresh.next.toString();
  scope.fresh.next += 1;
  return fresh;
}

function substitute_narrowed_value(
  expr: FrontExpr,
  name: string,
  payload_name: string,
): FrontExpr {
  return substitute_front_expr(
    expr,
    new Map([[name, { tag: "var", name: payload_name }]]),
  );
}
