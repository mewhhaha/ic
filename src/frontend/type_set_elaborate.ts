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
import {
  format_type_expr,
  function_type_expr,
  parse_type_expr,
} from "./type_expr.ts";
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
import { format_pattern } from "./format/common.ts";
import { normalize_fixed_array_type_lengths } from "./fixed_array_type.ts";
import { is_builtin_type_name } from "./types.ts";
import { integer_type_name } from "../integer.ts";
import { prim_returns_bool } from "./numeric.ts";
import { text_byte_length } from "./text.ts";
import { parameter_arguments } from "./call_args.ts";
import { compiler_builtin_args } from "./compiler_builtin_args.ts";

type TypeSetBinding = {
  annotation: string | undefined;
  compiletime_only?: boolean;
  inferred_type?: FrontExpr;
  is_const?: boolean;
  type_annotation?: TypeExpr;
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
  declared_union_types: Map<
    string,
    Extract<FrontExpr, { tag: "union_type" }>
  >;
  evaluating_const_body: boolean;
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

  let intrinsic_args = args;

  if (args.length === 1 && unary_arg?.tag === "product") {
    intrinsic_args = unary_arg.entries.map((entry) => entry.value);
  }

  const binding = scope.bindings.get(func.name);
  let intrinsic: string | undefined;

  if (func.name.startsWith("@type.") || func.name.startsWith("@shape.")) {
    intrinsic = func.name;
  } else if (binding?.value?.tag === "var") {
    intrinsic = binding.value.name;
  } else if (
    binding?.value?.tag === "lam" && binding.value.body.tag === "app" &&
    binding.value.body.func.tag === "var" &&
    binding.value.params.length === binding.value.body.args.length
  ) {
    let forwards_parameters = true;

    for (let index = 0; index < binding.value.params.length; index += 1) {
      const param = binding.value.params[index];
      const body_arg = binding.value.body.args[index];

      if (
        param === undefined || body_arg?.tag !== "var" ||
        body_arg.name !== param.name
      ) {
        forwards_parameters = false;
        break;
      }
    }

    if (forwards_parameters) {
      intrinsic = binding.value.body.func.name;
    }
  }

  if (
    intrinsic === "@type.union" || intrinsic === "@type.intersection" ||
    intrinsic === "@type.difference"
  ) {
    if (intrinsic_args.length !== 2) {
      throw new Error(intrinsic + " expects exactly two type values");
    }

    const left_arg = intrinsic_args[0];
    const right_arg = intrinsic_args[1];
    expect(left_arg, "Missing left type operand for " + intrinsic);
    expect(right_arg, "Missing right type operand for " + intrinsic);
    const left = unwrap_const_result(
      resolve_scope_const_value(left_arg, scope),
    );
    const right = unwrap_const_result(
      resolve_scope_const_value(right_arg, scope),
    );

    if (
      !scope_const_expr_known(left, scope) ||
      !scope_const_expr_known(right, scope)
    ) {
      return undefined;
    }

    let tag: "union" | "intersection" | "difference";

    if (intrinsic === "@type.union") {
      tag = "union";
    } else if (intrinsic === "@type.intersection") {
      tag = "intersection";
    } else {
      tag = "difference";
    }

    return {
      tag: "set_type",
      type_expr: {
        tag,
        left: prelude_type_expr(left),
        right: prelude_type_expr(right),
      },
    };
  }

  if (intrinsic === "@type.extend") {
    if (intrinsic_args.length !== 2) {
      throw new Error("@type.extend expects exactly two operands");
    }

    const base = intrinsic_args[0];
    const additions_arg = intrinsic_args[1];
    expect(base, "Missing @type.extend base operand");
    expect(additions_arg, "Missing @type.extend additions operand");

    for (const binding of scope.bindings.values()) {
      if (binding.compiletime_only === true && binding.value === undefined) {
        return undefined;
      }
    }

    if (
      !scope.evaluating_const_call && base.tag === "var" &&
      additions_arg.tag === "shape"
    ) {
      const base_binding = scope.bindings.get(base.name);
      if (
        base_binding !== undefined && base_binding.compiletime_only !== true
      ) {
        return {
          tag: "struct_update",
          base,
          fields: additions_arg.entries.map((entry) => {
            expect(entry.label !== undefined, "Struct update requires a field");
            return { name: entry.label, value: entry.value };
          }),
        };
      }
    }

    if (
      additions_arg.tag === "product" && additions_arg.value_pack === true &&
      additions_arg.entries.length === 2
    ) {
      const name = additions_arg.entries[0]?.value;
      const value = additions_arg.entries[1]?.value;
      expect(name, "Missing computed extension member name");
      expect(value, "Missing computed extension member value");
      return {
        tag: "type_with",
        base,
        members: [{ name, value }],
      };
    }

    let additions = unwrap_const_result(
      resolve_scope_const_value(additions_arg, scope),
    );

    if (additions.tag !== "shape" && additions_arg.tag === "shape") {
      additions = additions_arg;
    }

    if (
      additions.tag !== "shape" &&
      !scope_const_expr_known(additions, scope)
    ) {
      return undefined;
    }

    expect(
      additions.tag === "shape",
      "@type.extend expects an ordered shape, got " + additions.tag,
    );
    const fields = additions.entries.map((entry) => {
      expect(entry.label !== undefined, "Extension member requires a name");
      const resolved_value = unwrap_const_result(
        resolve_scope_const_value(entry.value, scope),
      );
      expect(
        scope_const_expr_known(resolved_value, scope),
        "Type extension member " + entry.label +
          " must be a compile-time value",
      );
      let value = resolved_value;

      if (value.tag === "lam" || value.tag === "rec") {
        value = capture_const_bindings(value, scope);
      }

      return { name: entry.label, value };
    });
    const resolved_type = resolve_front_type_value(
      base,
      scope.type_values,
      new Set(),
    );
    let extends_type = resolved_type !== undefined;

    if (
      base.tag === "var" && resolved_type?.tag === "var" &&
      resolved_type.name === base.name && !scope.type_values.has(base.name) &&
      !is_builtin_type_name(base.name)
    ) {
      extends_type = false;
    }

    if (extends_type) {
      let extended_base = base;

      if (scope.evaluating_const_call) {
        extended_base = unwrap_const_result(
          resolve_scope_const_value(base, scope),
        );
      }

      for (const field of fields) {
        expect(
          resolve_extension_field(
            extended_base,
            field.name,
            scope,
            new Set(),
          ) === undefined,
          "Duplicate type namespace member: " + field.name,
        );
      }

      return { tag: "with", base: extended_base, fields };
    }

    return { tag: "struct_update", base, fields };
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
  const statements = materialize_structural_function_result_types(
    source.statements,
  );
  const scope: TypeSetScope = {
    bindings: new Map(),
    const_evaluation: undefined,
    const_recursion: undefined,
    declared_union_types: new Map(),
    evaluating_const_body: false,
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

    if (declaration.body.tag === "product") {
      if (declaration.body.initializer === undefined) {
        scope.type_values.set(declaration.name, {
          tag: "struct_type",
          fields: declaration.body.fields,
        });
      }
    } else if (declaration.body.tag === "sum") {
      const union_type: Extract<FrontExpr, { tag: "union_type" }> = {
        tag: "union_type",
        cases: declaration.body.cases,
      };
      scope.type_values.set(declaration.name, union_type);
      scope.declared_union_types.set(declaration.name, union_type);
    }
  }

  for (const stmt of statements) {
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
    statements: rewrite_statements(statements, scope),
  };
}

function materialize_structural_function_result_types(
  statements: Stmt[],
): Stmt[] {
  const reserved_names = new Set<string>();

  for (const stmt of statements) {
    if (stmt.tag === "bind") {
      reserved_names.add(stmt.name);
    }
  }

  const materialized: Stmt[] = [];
  let next_type = 0;

  for (const stmt of statements) {
    if (
      stmt.tag !== "bind" ||
      (stmt.value.tag !== "lam" && stmt.value.tag !== "rec") ||
      stmt.type_annotation?.tag === "forall"
    ) {
      materialized.push(stmt);
      continue;
    }

    const function_type = function_type_expr(stmt.type_annotation);

    if (
      function_type === undefined || function_type.result.tag !== "product" ||
      function_type.result.value_pack === true
    ) {
      materialized.push(stmt);
      continue;
    }

    let type_name = "_duck_result_type_" + next_type.toString();
    next_type += 1;

    while (reserved_names.has(type_name)) {
      type_name = "_duck_result_type_" + next_type.toString();
      next_type += 1;
    }

    reserved_names.add(type_name);
    const result_type = function_type.result;
    const type_value: Extract<FrontExpr, { tag: "struct_type" }> = {
      tag: "struct_type",
      fields: result_type.entries.map((entry, index) => {
        let name = entry.label;

        if (name === undefined) {
          name = "item_" + index.toString();
        }

        return {
          name,
          type_name: format_type_expr(entry.type_expr),
          set_member: entry.type_expr,
        };
      }),
    };
    materialized.push({
      tag: "bind",
      kind: "const",
      name: type_name,
      is_recursive: false,
      is_linear: false,
      annotation: undefined,
      value: type_value,
    });

    const named_result: TypeExpr = { tag: "name", name: type_name };
    const type_annotation = replace_function_result_type(
      stmt.type_annotation,
      named_result,
    );
    let pattern = stmt.pattern;

    if (pattern?.tag === "binding") {
      pattern = {
        ...pattern,
        annotation: format_type_expr(type_annotation),
        type_annotation,
      };
    }

    materialized.push({
      ...stmt,
      annotation: format_type_expr(type_annotation),
      pattern,
      type_annotation,
    });
  }

  return materialized;
}

function replace_function_result_type(
  type: TypeExpr | undefined,
  result: TypeExpr,
): TypeExpr {
  expect(type, "Missing structural function type annotation");

  if (type.tag === "forall") {
    return {
      ...type,
      body: replace_function_result_type(type.body, result),
    };
  }

  expect(type.tag === "arrow", "Structural function type must be callable");
  return { ...type, result };
}

function rewrite_statements(
  statements: Stmt[],
  scope: TypeSetScope,
): Stmt[] {
  const result: Stmt[] = [];

  for (const stmt of statements) {
    let inferred_binding_type: FrontExpr | undefined;

    if (stmt.tag === "bind") {
      inferred_binding_type = static_type_value(stmt.value, scope, new Set());
    }

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

      let candidate_inferred_type = inferred_binding_type;

      if (expanded.length > 1) {
        candidate_inferred_type = static_type_value(
          candidate.value,
          scope,
          new Set(),
        );
      }

      let candidate_annotation = candidate.annotation;

      if (
        candidate_annotation === undefined &&
        candidate_inferred_type !== undefined
      ) {
        const resolved_inferred_type = resolve_front_type_value(
          candidate_inferred_type,
          scope.type_values,
          new Set(),
        );
        const inferred_builtin = resolved_inferred_type?.tag === "type_name" &&
          (resolved_inferred_type.name === "Text" ||
            resolved_inferred_type.name === "Bytes");

        if (
          inferred_builtin || resolved_inferred_type?.tag === "union_type"
        ) {
          candidate_annotation = format_type_expr(
            prelude_type_expr(candidate_inferred_type),
          );
        }
      }

      let elaborated_candidate = candidate;

      if (candidate_annotation !== candidate.annotation) {
        elaborated_candidate = {
          ...candidate,
          annotation: candidate_annotation,
        };
      }

      let compiletime_only = elaborated_candidate.kind === "const" &&
        (elaborated_candidate.value.tag === "rec" ||
          elaborated_candidate.value.tag === "shape");

      if (
        elaborated_candidate.kind === "const" &&
        elaborated_candidate.value.tag === "lam"
      ) {
        const all_params_are_const = elaborated_candidate.value.params.length >
            0 &&
          elaborated_candidate.value.params.every((param) => param.is_const);
        const const_result = unwrap_const_result(
          elaborated_candidate.value.body,
        );
        compiletime_only = expr_requires_type_specialization(
          elaborated_candidate.value.body,
        ) ||
          all_params_are_const ||
          elaborated_candidate.value.body.tag === "comptime" ||
          const_result.tag === "shape";
      }

      let binding_value = elaborated_candidate.value;

      if (
        const_rec !== undefined && stmt.tag === "bind" &&
        elaborated_candidate.name === stmt.name
      ) {
        binding_value = const_rec;
      }

      scope.bindings.set(elaborated_candidate.name, {
        annotation: elaborated_candidate.annotation,
        compiletime_only,
        inferred_type: candidate_inferred_type,
        is_const: elaborated_candidate.kind === "const",
        type_annotation: elaborated_candidate.type_annotation,
        value: binding_value,
        union_type: binding_union_type(elaborated_candidate.annotation, scope),
      });

      if (elaborated_candidate.kind === "const") {
        scope.type_values.set(elaborated_candidate.name, binding_value);

        if (
          binding_value.tag === "union_type" &&
          /^[A-Z][A-Za-z0-9]*$/.test(elaborated_candidate.name)
        ) {
          scope.declared_union_types.set(
            elaborated_candidate.name,
            binding_value,
          );
        }
      }

      if (compiletime_only) {
        if (scope.evaluating_const_call) {
          result.push(elaborated_candidate);
        }

        continue;
      }

      if (
        elaborated_candidate.kind === "const" &&
        is_comptime_descriptor_value(elaborated_candidate.value)
      ) {
        continue;
      }

      if (elaborated_candidate.kind === "const") {
        const storage_type = type_storage_without_namespace(
          elaborated_candidate.value,
          scope,
        );

        if (storage_type !== undefined) {
          result.push({ ...elaborated_candidate, value: storage_type });
          continue;
        }
      }

      result.push(elaborated_candidate);
    }
  }

  return result;
}

function type_storage_without_namespace(
  value: FrontExpr,
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (value.tag === "lam") {
    const body = type_storage_without_namespace(value.body, scope);

    if (body === undefined) {
      return undefined;
    }

    return { ...value, body };
  }

  if (value.tag !== "with") {
    return undefined;
  }

  let base = value.base;

  while (base.tag === "with") {
    base = base.base;
  }

  if (base.tag === "struct_type") {
    return nominalize_struct_type_fields(
      base,
      scope.type_values,
      new Set(),
    );
  }

  const product = product_type_with_namespace(value);

  if (product === undefined) {
    return undefined;
  }

  return nominalize_struct_type_fields(
    product,
    scope.type_values,
    new Set(),
  );
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
  let source_annotation = stmt.annotation;

  if (source_annotation === undefined && stmt.value.tag === "var") {
    source_annotation = scope.bindings.get(stmt.value.name)?.annotation;
  }

  if (stmt.kind === "const" && scope_const_expr_known(source_shape, scope)) {
    source = source_shape;
  } else {
    result.push({
      tag: "bind",
      kind: stmt.kind,
      name: source_name,
      is_recursive: stmt.is_recursive,
      is_linear: false,
      annotation: source_annotation,
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
  if (
    pattern === undefined || pattern.tag === "binding" ||
    pattern.tag === "unit" ||
    (pattern.tag === "product" &&
      (pattern.value_pack === true || flattenable_product_pattern(pattern)))
  ) {
    return false;
  }

  if (
    pattern.tag !== "value" && pattern.tag !== "type" &&
    params.some((param) => param.is_const || param.is_linear)
  ) {
    return false;
  }

  return true;
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
    pattern.tag === "literal" || pattern.tag === "value" ||
    pattern.tag === "union_case" || pattern.tag === "type" ||
    pattern.tag === "or" || pattern.tag === "text_capture"
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
        projected = {
          tag: "field",
          object: source,
          name: entry.label,
          move: true,
        };
      } else {
        projected = {
          tag: "index",
          object: source,
          index: { tag: "num", type: "i32", value: index },
          move: true,
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

    if (pattern.rest !== undefined && pattern.rest.tag !== "wildcard") {
      const rest = product_rest_expr(pattern, source_shape);
      elaborate_pattern_bindings(pattern.rest, rest, rest, kind, result);
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
        move: true,
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
      move: true,
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

  if (
    arity !== undefined && pattern.rest !== undefined &&
    arity < pattern.entries.length
  ) {
    throw new Error(
      "Product binding pattern expects at least " +
        pattern.entries.length.toString() + " entries, got " +
        arity.toString(),
    );
  }

  if (
    arity !== undefined && pattern.rest === undefined &&
    arity !== pattern.entries.length
  ) {
    throw new Error(
      "Product binding pattern expects " + pattern.entries.length.toString() +
        " entries, got " + arity.toString(),
    );
  }
}

function product_rest_expr(
  pattern: Extract<Pattern, { tag: "product" }>,
  source: FrontExpr | undefined,
): FrontExpr {
  if (source?.tag !== "product") {
    throw new Error(
      "Value-pack rest binding requires a compile-time product value",
    );
  }

  return {
    tag: "product",
    entries: source.entries.slice(pattern.entries.length),
    value_pack: true,
  };
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
  scope: TypeSetScope,
): FrontExpr {
  if (value.tag === "captured") {
    return {
      ...value,
      expr: contextualize_product_value(
        value.expr,
        annotation,
        declared,
        scope,
      ),
    };
  }

  if (value.tag === "if") {
    return {
      ...value,
      then_branch: contextualize_product_value(
        value.then_branch,
        annotation,
        declared,
        scope,
      ),
      else_branch: contextualize_product_value(
        value.else_branch,
        annotation,
        declared,
        scope,
      ),
    };
  }

  if (value.tag === "if_let") {
    return {
      ...value,
      then_branch: contextualize_product_value(
        value.then_branch,
        annotation,
        declared,
        scope,
      ),
      else_branch: contextualize_product_value(
        value.else_branch,
        annotation,
        declared,
        scope,
      ),
    };
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return {
      ...value,
      value: contextualize_product_value(
        value.value,
        annotation,
        declared,
        scope,
      ),
    };
  }

  if (value.tag === "scratch") {
    return {
      ...value,
      body: contextualize_product_value(
        value.body,
        annotation,
        declared,
        scope,
      ),
    };
  }

  if (value.tag === "block") {
    const statements = [...value.statements];
    const final_index = statements.length - 1;
    const final_statement = statements[final_index];

    if (
      final_statement?.tag !== "expr" && final_statement?.tag !== "return"
    ) {
      return value;
    }

    if (final_statement.tag === "expr") {
      statements[final_index] = {
        ...final_statement,
        expr: contextualize_product_value(
          final_statement.expr,
          annotation,
          declared,
          scope,
        ),
      };
    } else {
      statements[final_index] = {
        ...final_statement,
        value: contextualize_product_value(
          final_statement.value,
          annotation,
          declared,
          scope,
        ),
      };
    }
    return { ...value, statements };
  }

  if (value.tag === "lam" || value.tag === "rec") {
    return {
      ...value,
      body: contextualize_product_value(
        value.body,
        annotation,
        declared,
        scope,
      ),
    };
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
    type_expr: type_value_from_type_expr(
      parse_type_expr(tokenize(annotation)),
    ),
    fields: declared.fields.map((field, index) => {
      const entry = value.entries[index];
      expect(entry, "Missing contextual product entry " + index.toString());

      if (entry.label !== undefined && entry.label !== field.name) {
        throw new Error(
          "Contextual product entry " + index.toString() +
            " expects label ." + field.name + ", got ." + entry.label,
        );
      }

      let field_value = entry.value;
      const field_type_expr = type_value_from_type_expr(
        parse_type_expr(tokenize(field.type_name)),
      );
      const field_type = resolve_front_type_value(
        field_type_expr,
        scope.type_values,
        new Set(),
      );

      if (
        field_value.tag === "union_case" &&
        field_value.type_expr === undefined
      ) {
        field_value = {
          ...field_value,
          type_expr: field_type_expr,
        };
      } else if (field_type?.tag === "struct_type") {
        field_value = contextualize_product_value(
          field_value,
          field.type_name,
          field_type,
          scope,
        );
      }

      return { name: field.name, value: field_value };
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
    scope,
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
      const normalized_type_annotation = normalize_scope_type_expr(
        stmt.type_annotation,
        scope,
      );
      let source_value = stmt.value;
      const function_type = function_type_expr(normalized_type_annotation);

      if (
        function_type !== undefined &&
        (source_value.tag === "lam" || source_value.tag === "rec") &&
        source_value.params.length === 1 &&
        source_value.params[0]?.name.startsWith("_pattern#param")
      ) {
        const param = source_value.params[0];
        expect(param, "Missing structural function parameter");
        source_value = {
          ...source_value,
          params: [{ ...param, type_annotation: function_type.param }],
        };
      }

      let value = rewrite_expr(source_value, scope);
      if (function_type !== undefined) {
        const result_type_value = scope_type_value_from_type_expr(
          function_type.result,
        );
        let declared_result: FrontExpr | undefined;

        if (result_type_value !== undefined) {
          declared_result = resolve_front_type_value(
            result_type_value,
            scope.type_values,
            new Set(),
          );
        }

        if (declared_result === undefined) {
          declared_result = front_type_value_for_semantic_type(
            "<function result>",
            function_type.result,
            semantic_type_for_expr(function_type.result, scope, new Set()),
          );
        }

        if (declared_result.tag === "struct_type") {
          value = contextualize_product_value(
            value,
            format_type_expr(function_type.result),
            declared_result,
            scope,
          );
        }
      }
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
          value = contextualize_product_value(
            value,
            annotation,
            declared,
            scope,
          );
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
        type_annotation: normalized_type_annotation,
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
      return {
        ...stmt,
        pattern: {
          ...stmt.pattern,
          fields: stmt.pattern.fields.map((field) => ({
            ...field,
            type_name: normalize_scope_annotation(field.type_name, scope),
          })),
        },
        target: rewrite_expr(stmt.target, scope),
      };

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
  const arms = expand_match_alternatives(expr.arms);

  if (arms.some((arm) => arm.pattern.tag === "type")) {
    return elaborate_type_match_expr({ ...expr, arms }, target, scope);
  }

  const target_shape = resolve_binding_pattern_source(
    target,
    scope,
    new Set(),
  );
  const union_type = union_type_for_value(target, scope);

  if (
    scope.evaluating_const_call && target_shape.tag === "product" &&
    target_shape.value_pack === true
  ) {
    for (const arm of arms) {
      const replacements = const_value_pack_pattern_replacements(
        arm.pattern,
        target_shape,
      );

      if (replacements === undefined) {
        continue;
      }

      if (arm.guard !== undefined) {
        const guard = rewrite_expr(
          substitute_front_expr(arm.guard, replacements),
          clone_scope(scope),
        );
        const condition = static_i32_source_value(guard);

        if (condition === undefined) {
          throw new Error(
            "Value-pack match guard requires a compile-time condition",
          );
        }

        if (condition === 0) {
          continue;
        }
      }

      return rewrite_expr(
        substitute_front_expr(arm.body, replacements),
        clone_scope(scope),
      );
    }
  }

  validate_match_coverage(arms, union_type);

  if (
    scope.evaluating_const_call &&
    (target.tag === "bool" || target.tag === "num" ||
      target.tag === "atom" || target.tag === "unit" ||
      target.tag === "text")
  ) {
    for (const arm of arms) {
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
      } else if (
        arm.pattern.tag === "text_capture" && target.tag === "text"
      ) {
        const value = target.value;
        matches = value.startsWith(arm.pattern.prefix) &&
          value.endsWith(arm.pattern.suffix) &&
          value.length >= arm.pattern.prefix.length + arm.pattern.suffix.length;

        if (matches) {
          const end = value.length - arm.pattern.suffix.length;
          body = substitute_front_expr(
            body,
            new Map([[
              arm.pattern.name,
              {
                tag: "text",
                value: value.slice(arm.pattern.prefix.length, end),
              },
            ]]),
          );
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
  const first_arm = arms[0];

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

  for (let index = arms.length - 1; index >= 0; index -= 1) {
    const arm = arms[index];
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

function expand_match_alternatives(arms: MatchArm[]): MatchArm[] {
  const expanded: MatchArm[] = [];

  for (const arm of arms) {
    if (arm.pattern.tag !== "or") {
      expanded.push(arm);
      continue;
    }

    for (const alternative of arm.pattern.alternatives) {
      expanded.push({ ...arm, pattern: alternative });
    }
  }

  return expanded;
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

function const_value_pack_pattern_replacements(
  pattern: Pattern,
  value: FrontExpr,
): Map<string, FrontExpr> | undefined {
  if (pattern.tag === "wildcard") {
    return new Map();
  }

  if (pattern.tag === "binding") {
    if (pattern.mode === "linear") {
      throw new Error(
        "Linear bindings are not supported in compile-time value-pack matches",
      );
    }

    return new Map([[pattern.name, value]]);
  }

  if (pattern.tag === "unit") {
    if (
      value.tag === "product" && value.value_pack === true &&
      value.entries.length === 0
    ) {
      return new Map();
    }

    if (value.tag === "unit") {
      return new Map();
    }

    return undefined;
  }

  if (pattern.tag === "literal") {
    if (pattern.value.tag !== value.tag) {
      return undefined;
    }

    if (pattern.value.tag === "bool" && value.tag === "bool") {
      if (pattern.value.value === value.value) {
        return new Map();
      }

      return undefined;
    }

    if (pattern.value.tag === "num" && value.tag === "num") {
      if (
        pattern.value.type === value.type &&
        pattern.value.value === value.value
      ) {
        return new Map();
      }

      return undefined;
    }

    if (pattern.value.tag === "text" && value.tag === "text") {
      if (pattern.value.value === value.value) {
        return new Map();
      }

      return undefined;
    }

    if (pattern.value.tag === "atom" && value.tag === "atom") {
      if (pattern.value.name === value.name) {
        return new Map();
      }

      return undefined;
    }

    return undefined;
  }

  if (pattern.tag === "or") {
    for (const alternative of pattern.alternatives) {
      const replacements = const_value_pack_pattern_replacements(
        alternative,
        value,
      );

      if (replacements !== undefined) {
        return replacements;
      }
    }

    return undefined;
  }

  if (
    pattern.tag !== "product" || pattern.value_pack !== true ||
    value.tag !== "product" || value.value_pack !== true
  ) {
    return undefined;
  }

  if (
    pattern.rest === undefined &&
    pattern.entries.length !== value.entries.length
  ) {
    return undefined;
  }

  if (pattern.entries.length > value.entries.length) {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < pattern.entries.length; index += 1) {
    const entry = pattern.entries[index];
    const received = value.entries[index];
    expect(entry, "Missing compile-time value-pack pattern entry " + index);
    expect(received, "Missing compile-time value-pack entry " + index);
    const nested = const_value_pack_pattern_replacements(
      entry.pattern,
      received.value,
    );

    if (nested === undefined) {
      return undefined;
    }

    for (const [name, replacement] of nested) {
      replacements.set(name, replacement);
    }
  }

  if (pattern.rest !== undefined) {
    const remaining: FrontExpr = {
      tag: "product",
      entries: value.entries.slice(pattern.entries.length),
      value_pack: true,
    };
    const nested = const_value_pack_pattern_replacements(
      pattern.rest,
      remaining,
    );

    if (nested === undefined) {
      return undefined;
    }

    for (const [name, replacement] of nested) {
      replacements.set(name, replacement);
    }
  }

  return replacements;
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

  if (arm.pattern.tag === "text_capture") {
    return elaborate_text_capture_arm(
      arm,
      arm.pattern,
      target,
      fallback,
      scope,
    );
  }

  if (arm.pattern.tag === "or") {
    throw new Error("Pattern alternatives must be expanded before lowering");
  }

  if (arm.pattern.tag === "type") {
    throw new Error("Type match must be elaborated at compile time");
  }

  if (arm.pattern.tag === "value") {
    throw new Error(
      "Compile-time value pattern must be specialized before lowering: " +
        arm.pattern.name,
    );
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

function elaborate_text_capture_arm(
  arm: MatchArm,
  pattern: Extract<Pattern, { tag: "text_capture" }>,
  target: FrontExpr,
  fallback: FrontExpr,
  scope: TypeSetScope,
): FrontExpr {
  const encoder = new TextEncoder();
  const prefix_length = encoder.encode(pattern.prefix).length;
  const suffix_length = encoder.encode(pattern.suffix).length;
  const target_length: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: "@len" },
    arg: target,
    args: [target],
  };
  const capture_end: FrontExpr = {
    tag: "prim",
    prim: "i32.sub",
    left: target_length,
    right: { tag: "num", type: "i32", value: suffix_length },
  };
  const capture: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: "@slice" },
    arg: {
      tag: "product",
      entries: [
        { value: target },
        { value: { tag: "num", type: "i32", value: prefix_length } },
        { value: capture_end },
      ],
    },
    args: [
      target,
      { tag: "num", type: "i32", value: prefix_length },
      capture_end,
    ],
  };
  const branch = clone_scope(scope);
  branch.bindings.set(pattern.name, {
    annotation: "Text",
    value: undefined,
  });
  const matched = guarded_match_body(
    arm.guard,
    arm.body,
    fallback,
    branch,
  );
  const prefix_name = fresh_match_target_name(scope);
  const suffix_name = fresh_match_target_name(scope);
  const prefix: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: "@slice" },
    arg: {
      tag: "product",
      entries: [
        { value: target },
        { value: { tag: "num", type: "i32", value: 0 } },
        { value: { tag: "num", type: "i32", value: prefix_length } },
      ],
    },
    args: [
      target,
      { tag: "num", type: "i32", value: 0 },
      { tag: "num", type: "i32", value: prefix_length },
    ],
  };
  const suffix: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: "@slice" },
    arg: {
      tag: "product",
      entries: [
        { value: target },
        { value: capture_end },
        { value: target_length },
      ],
    },
    args: [target, capture_end, target_length],
  };
  const successful_branch: FrontExpr = {
    tag: "block",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: prefix_name,
        is_linear: false,
        annotation: "Text",
        value: prefix,
      },
      {
        tag: "bind",
        kind: "let",
        name: suffix_name,
        is_linear: false,
        annotation: "Text",
        value: suffix,
      },
      {
        tag: "bind",
        kind: "let",
        pattern: {
          tag: "binding",
          name: pattern.name,
          mode: "default",
          annotation: "Text",
        },
        name: pattern.name,
        is_linear: false,
        annotation: "Text",
        value: capture,
      },
      {
        tag: "expr",
        expr: {
          tag: "if",
          cond: match_literal_condition(
            { tag: "var", name: prefix_name },
            {
              tag: "literal",
              value: { tag: "text", value: pattern.prefix },
            },
          ),
          then_branch: {
            tag: "if",
            cond: match_literal_condition(
              { tag: "var", name: suffix_name },
              {
                tag: "literal",
                value: { tag: "text", value: pattern.suffix },
              },
            ),
            then_branch: matched,
            else_branch: fallback,
          },
          else_branch: fallback,
        },
      },
    ],
  };

  return {
    tag: "if",
    cond: {
      tag: "prim",
      prim: "i32.ge_s",
      left: target_length,
      right: {
        tag: "num",
        type: "i32",
        value: prefix_length + suffix_length,
      },
    },
    then_branch: successful_branch,
    else_branch: fallback,
  };
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

    const right: FrontExpr = {
      tag: "num",
      type: value.type,
      value: value.value,
    };

    if (value.character !== undefined) {
      right.character = value.character;
    }

    return {
      tag: "prim",
      prim,
      left: target,
      right,
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

    if (arm.pattern.tag === "value") {
      continue;
    }

    if (arm.pattern.tag === "text_capture") {
      continue;
    }

    if (arm.pattern.tag === "or") {
      throw new Error(
        "Pattern alternatives must be expanded before coverage analysis",
      );
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
            ": `" + case_name,
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
    ).map((item) => {
      if (item.type_name === "Unit") {
        return "`" + item.name + " ()";
      }

      return "`" + item.name + " _";
    });
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
    if (value.character !== undefined) {
      return "char:" + value.value.toString();
    }

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

      if (function_pattern_requires_projection(expr.pattern, params)) {
        const pattern = expr.pattern;
        expect(pattern, "Missing function parameter pattern");
        const param_name = fresh_pattern_parameter_name(scope);
        const is_linear = pattern_bindings(pattern).some((binding) => {
          return binding.mode === "linear";
        });
        const original_param = params[0];
        let type_annotation: TypeExpr | undefined;

        if (original_param !== undefined) {
          type_annotation = original_param.type_annotation;
        }

        if (type_annotation === undefined) {
          type_annotation = structural_pattern_type(pattern);
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
        const source: FrontExpr = { tag: "var", name: param_name };

        const compiletime_value_alternatives = pattern.tag === "or" &&
          pattern.alternatives.every((alternative) => {
            return alternative.tag === "value";
          });

        if (
          pattern.tag === "literal" || pattern.tag === "union_case" ||
          pattern.tag === "type" || pattern.tag === "text_capture" ||
          (pattern.tag === "or" && !compiletime_value_alternatives)
        ) {
          const message: FrontExpr = {
            tag: "text",
            value: "Function argument does not match " +
              format_pattern(pattern),
          };
          const panic: FrontExpr = {
            tag: "app",
            func: { tag: "var", name: "@panic" },
            arg: message,
            args: [message],
          };
          return {
            ...expr,
            pattern,
            params: [param],
            body: rewrite_expr({
              tag: "match",
              target: source,
              arms: [
                { pattern, guard: undefined, body: expr.body },
                {
                  pattern: { tag: "wildcard", mode: "default" },
                  guard: undefined,
                  body: panic,
                },
              ],
            }, body_scope),
          };
        }

        if (pattern.tag === "value") {
          return {
            ...expr,
            pattern,
            params: [{ ...param, is_const: true }],
            body: rewrite_expr(expr.body, body_scope),
          };
        }

        if (compiletime_value_alternatives) {
          return {
            ...expr,
            pattern,
            params: [{ ...param, is_const: true }],
            body: rewrite_expr(expr.body, body_scope),
          };
        }

        const bindings: Stmt[] = [];
        elaborate_pattern_bindings(
          pattern,
          source,
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

      body_scope.evaluating_const_body = false;

      return { ...expr, params, body: rewrite_expr(expr.body, body_scope) };
    }

    case "app": {
      const func = rewrite_expr(expr.func, scope);
      const queried_type = elaborate_type_of_call(func, expr.args, scope);

      if (queried_type !== undefined) {
        return rewrite_expr(queried_type, scope);
      }

      let arg = expr.arg;

      if (arg !== undefined) {
        arg = rewrite_expr(arg, scope);
      }

      let args = expr.args.map((item) => rewrite_expr(item, scope));
      const product_pattern = callable_product_pattern(func, scope, new Set());

      if (
        product_pattern !== undefined &&
        flattenable_product_pattern(product_pattern) && args.length === 1
      ) {
        const source = args[0];
        expect(source !== undefined, "Missing structural function argument");
        args = flatten_product_pattern_arguments(product_pattern, source);
        arg = {
          tag: "product",
          entries: args.map((value) => ({ value })),
          value_pack: true,
        };
      }
      const value_pattern = callable_value_pattern(func, scope, new Set());

      if (value_pattern !== undefined) {
        expect(
          args.length === 1,
          "Value-pattern function expects exactly one argument: " +
            value_pattern.names.join(" | "),
        );
        const value = args[0];
        expect(value !== undefined, "Missing value-pattern function argument");

        const matches = value_pattern.names.some((name) => {
          return named_value_pattern_matches(name, value, scope);
        });

        if (!matches) {
          throw new Error(
            "Function argument does not match " +
              value_pattern.names.join(" | ") + ": " +
              format_expr(value),
          );
        }

        return rewrite_expr(value_pattern.body, scope);
      }
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

      if (
        func.tag === "var" && func.name === "@cast" && args.length === 2
      ) {
        let value = args[0];
        const target = args[1];
        expect(value, "Missing checked cast value");
        expect(target, "Missing checked cast target");

        if (scope.evaluating_const_call && value.tag === "var") {
          value = unwrap_const_result(resolve_scope_const_value(value, scope));
        }

        const resolved_target = resolve_front_type_value(
          target,
          scope.type_values,
          new Set(),
        );

        if (
          value.tag === "array" && value.rest === undefined &&
          resolved_target !== undefined &&
          resolved_target.tag === "struct_type"
        ) {
          value = {
            tag: "product",
            entries: value.items.map((item) => ({ value: item })),
          };
        }

        if (
          value.tag === "product" && resolved_target !== undefined &&
          !(resolved_target.tag === "var" &&
            !scope.type_values.has(resolved_target.name) &&
            !is_builtin_type_name(resolved_target.name))
        ) {
          const checked_cast: Extract<FrontExpr, { tag: "as" }> = {
            tag: "as",
            value,
            type_expr: prelude_type_expr(resolved_target),
          };
          return rewrite_expr(
            elaborate_product_as_expr(checked_cast, resolved_target),
            scope,
          );
        }
      }

      let checked_cast_wrapper = func;

      if (func.tag === "var") {
        const binding = scope.bindings.get(func.name);

        if (binding?.value !== undefined) {
          checked_cast_wrapper = binding.value;
        }
      }

      if (
        checked_cast_wrapper.tag === "lam" &&
        checked_cast_wrapper.params.length === args.length &&
        checked_cast_wrapper.body.tag === "app" &&
        checked_cast_wrapper.body.func.tag === "var" &&
        (checked_cast_wrapper.body.func.name === "@cast" ||
          checked_cast_wrapper.body.func.name === "@seal" ||
          checked_cast_wrapper.body.func.name === "@representation")
      ) {
        let forwards_parameters = true;

        for (
          let index = 0;
          index < checked_cast_wrapper.params.length;
          index += 1
        ) {
          const param = checked_cast_wrapper.params[index];
          const body_arg = checked_cast_wrapper.body.args[index];

          if (
            param === undefined || body_arg?.tag !== "var" ||
            body_arg.name !== param.name
          ) {
            forwards_parameters = false;
            break;
          }
        }

        if (!forwards_parameters) {
          return {
            ...expr,
            func,
            arg,
            args,
          };
        }

        const replacements = new Map<string, FrontExpr>();

        for (let index = 0; index < args.length; index += 1) {
          const param = checked_cast_wrapper.params[index];
          const value = args[index];
          expect(param, "Missing checked cast wrapper parameter");
          expect(value, "Missing checked cast wrapper argument");
          replacements.set(param.name, value);
        }

        return rewrite_expr(
          substitute_front_expr(
            checked_cast_wrapper.body,
            replacements,
          ),
          scope,
        );
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

        if (scope.evaluating_const_call && scope.evaluating_const_body) {
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

          if (scope_const_expr_known(rest, scope)) {
            throw new Error(
              "Compile-time product spread requires a fixed product value, got " +
                value.tag,
            );
          }
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

    case "block": {
      let can_evaluate_block = scope.evaluating_const_call;

      for (const binding of scope.bindings.values()) {
        if (binding.compiletime_only === true && binding.value === undefined) {
          can_evaluate_block = false;
          break;
        }
      }

      const needs_const_block_evaluation = expr.statements.some((statement) => {
        if (statement.tag === "for_collection") {
          return true;
        }

        if (statement.tag !== "assign") {
          return false;
        }

        if (statement.value.tag === "type_with") {
          return true;
        }

        return statement.value.tag === "app" &&
          statement.value.func.tag === "var" &&
          statement.value.func.name === "@type.extend";
      });

      if (can_evaluate_block && needs_const_block_evaluation) {
        const evaluated = evaluate_const_block(expr.statements, scope);

        if (evaluated !== undefined) {
          return evaluated;
        }
      }

      return {
        ...expr,
        statements: rewrite_statements(expr.statements, clone_scope(scope)),
      };
    }

    case "comptime": {
      const evaluation_scope = clone_scope(scope);
      evaluation_scope.evaluating_const_body = true;
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
      return {
        ...expr,
        base: rewrite_expr(expr.base, scope),
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewrite_expr(field.value, scope),
        })),
      };

    case "struct_update": {
      const base = rewrite_expr(expr.base, scope);
      const base_type = static_type_value(base, scope, new Set());
      let declared: Extract<FrontExpr, { tag: "struct_type" }> | undefined;

      if (base_type !== undefined) {
        const resolved = resolve_front_type_value(
          base_type,
          scope.type_values,
          new Set(),
        );

        if (resolved?.tag === "struct_type") {
          declared = resolved;
        }
      }

      return {
        ...expr,
        base,
        fields: expr.fields.map((field) => {
          let value = rewrite_expr(field.value, scope);
          const declared_field = declared?.fields.find((candidate) => {
            return candidate.name === field.name;
          });

          if (declared_field === undefined) {
            return { ...field, value };
          }

          const field_type_expr = type_value_from_type_expr(
            parse_type_expr(tokenize(declared_field.type_name)),
          );
          const field_type = resolve_front_type_value(
            field_type_expr,
            scope.type_values,
            new Set(),
          );

          if (value.tag === "union_case" && value.type_expr === undefined) {
            value = { ...value, type_expr: field_type_expr };
          } else if (field_type?.tag === "struct_type") {
            value = contextualize_product_value(
              value,
              declared_field.type_name,
              field_type,
              scope,
            );
          }

          return { ...field, value };
        }),
      };
    }

    case "type_with": {
      const base = rewrite_expr(expr.base, scope);
      const members = expr.members.map((member) => ({
        name: rewrite_expr(member.name, scope),
        value: rewrite_expr(member.value, scope),
      }));

      for (const binding of scope.bindings.values()) {
        if (binding.compiletime_only === true && binding.value === undefined) {
          return { ...expr, base, members };
        }
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
          scope_const_expr_known(resolved_value, scope),
          "Computed type member " + name.value +
            " must be a compile-time value",
        );
        let value = resolved_value;

        if (value.tag === "lam" || value.tag === "rec") {
          value = capture_const_bindings(value, scope);
        }
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
      const resolved_object = resolve_type_namespace_value(
        expr.object,
        scope,
        new Set(),
      );

      if (resolved_object !== undefined) {
        const extension_field = resolve_extension_field(
          resolved_object,
          expr.name,
          scope,
          new Set(),
        );

        if (extension_field !== undefined) {
          return rewrite_expr(extension_field, scope);
        }
      }

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
        index.type === "i32" && index.character === undefined &&
        typeof index.value === "number"
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
        index.character === undefined &&
        typeof index.value === "number"
      ) {
        const item = object.items[index.value];

        if (item !== undefined) {
          return rewrite_expr(item, scope);
        }
      }

      if (
        object.tag === "product" && index.tag === "num" &&
        index.type === "i32" && index.character === undefined &&
        typeof index.value === "number"
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
        index.character === undefined &&
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
      let union_type_value:
        | Extract<FrontExpr, { tag: "union_type" }>
        | undefined;

      if (value) {
        value = rewrite_expr(value, scope);
      }

      if (type_expr) {
        type_expr = rewrite_expr(type_expr, scope);
        const resolved = resolve_front_type_value(
          type_expr,
          scope.type_values,
          new Set(),
        );

        if (resolved?.tag === "union_type") {
          union_type_value = resolved;
        }
      } else {
        let inferred: string | undefined;

        for (const [name, type_value] of scope.declared_union_types) {
          if (!type_value.cases.some((item) => item.name === expr.name)) {
            continue;
          }

          if (inferred !== undefined) {
            inferred = undefined;
            break;
          }

          inferred = name;
        }

        if (inferred !== undefined) {
          type_expr = { tag: "var", name: inferred };
          union_type_value = scope.declared_union_types.get(inferred);
        }
      }

      if (union_type_value !== undefined && value !== undefined) {
        const declared = union_type_value.cases.find((union_case) => {
          return union_case.name === expr.name;
        });
        expect(declared, "Missing inferred union case: " + expr.name);
        const payload_type_expr = parse_type_expr(
          tokenize(declared.type_name),
        );
        const payload_type = resolve_front_type_value(
          type_value_from_type_expr(payload_type_expr),
          scope.type_values,
          new Set(),
        );

        if (payload_type?.tag === "struct_type") {
          value = contextualize_product_value(
            value,
            declared.type_name,
            payload_type,
            scope,
          );
        }

        const actual = semantic_type_for_value(value, scope);

        if (actual !== undefined) {
          const expected = semantic_type_for_expr(
            payload_type_expr,
            scope,
            new Set(),
          );

          if (
            actual.tag === "scalar" && expected.tag === "scalar" &&
            !sem_type_subtype(actual, expected)
          ) {
            throw new Error(
              "Union case " + expr.name + " expects " + declared.type_name +
                ", got " + actual.name,
            );
          }
        }
      }

      return { ...expr, value, type_expr };
    }
  }
}

function callable_value_pattern(
  expr: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): { names: string[]; body: FrontExpr } | undefined {
  if (expr.tag === "lam") {
    if (expr.pattern?.tag === "value") {
      return { names: [expr.pattern.name], body: expr.body };
    }

    if (
      expr.pattern?.tag === "or" &&
      expr.pattern.alternatives.every((alternative) => {
        return alternative.tag === "value";
      })
    ) {
      return {
        names: expr.pattern.alternatives.map((alternative) => {
          expect(
            alternative.tag === "value",
            "Compile-time alternative must be a value pattern",
          );
          return alternative.name;
        }),
        body: expr.body,
      };
    }

    return undefined;
  }

  if (
    expr.tag === "rec" &&
    (expr.pattern?.tag === "value" || expr.pattern?.tag === "or")
  ) {
    throw new Error("Recursive value-pattern functions are not supported");
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return callable_value_pattern(expr.expr, scope, resolving);
  }

  if (expr.tag !== "var" || resolving.has(expr.name)) {
    return undefined;
  }

  const binding = scope.bindings.get(expr.name);

  if (binding?.value === undefined) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(expr.name);
  return callable_value_pattern(binding.value, scope, next);
}

function callable_product_pattern(
  expr: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): Extract<Pattern, { tag: "product" }> | undefined {
  if (expr.tag === "lam" || expr.tag === "rec") {
    if (expr.pattern?.tag === "product") {
      return expr.pattern;
    }

    return undefined;
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return callable_product_pattern(expr.expr, scope, resolving);
  }

  if (expr.tag !== "var" || resolving.has(expr.name)) {
    return undefined;
  }

  const binding = scope.bindings.get(expr.name);

  if (binding?.value === undefined) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(expr.name);
  return callable_product_pattern(binding.value, scope, next);
}

function flattenable_product_pattern(
  pattern: Extract<Pattern, { tag: "product" }>,
): boolean {
  if (pattern.value_pack === true || pattern.rest !== undefined) {
    return false;
  }

  return pattern.entries.every((entry) => {
    if (entry.pattern.tag === "binding") {
      return true;
    }

    if (entry.pattern.tag === "wildcard") {
      return true;
    }

    if (entry.pattern.tag === "product") {
      return flattenable_product_pattern(entry.pattern);
    }

    return false;
  });
}

function flatten_product_pattern_arguments(
  pattern: Extract<Pattern, { tag: "product" }>,
  source: FrontExpr,
): FrontExpr[] {
  const args: FrontExpr[] = [];

  for (let index = 0; index < pattern.entries.length; index += 1) {
    const entry = pattern.entries[index];
    expect(entry, "Missing structural function pattern entry");
    let projected: FrontExpr;
    let direct: FrontExpr | undefined;

    if (source.tag === "product" || source.tag === "shape") {
      if (entry.label === undefined) {
        direct = source.entries[index]?.value;
      } else {
        direct = source.entries.find((candidate) => {
          return candidate.label === entry.label;
        })?.value;
      }
    }

    if (direct !== undefined) {
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

    if (entry.pattern.tag === "product") {
      args.push(...flatten_product_pattern_arguments(entry.pattern, projected));
    } else {
      args.push(projected);
    }
  }

  return args;
}

function structural_pattern_type(pattern: Pattern): TypeExpr | undefined {
  if (pattern.tag === "binding") {
    if (pattern.type_annotation !== undefined) {
      return pattern.type_annotation;
    }

    if (pattern.annotation !== undefined) {
      return { tag: "name", name: pattern.annotation };
    }

    return undefined;
  }

  if (pattern.tag !== "product") {
    return undefined;
  }

  if (pattern.rest !== undefined) {
    return undefined;
  }

  const entries: Extract<TypeExpr, { tag: "product" }>["entries"] = [];

  for (const entry of pattern.entries) {
    const type_expr = structural_pattern_type(entry.pattern);

    if (type_expr === undefined) {
      return undefined;
    }

    entries.push({ label: entry.label, type_expr });
  }

  const type: Extract<TypeExpr, { tag: "product" }> = {
    tag: "product",
    entries,
  };

  if (pattern.value_pack === true) {
    type.value_pack = true;
  }

  return type;
}

function named_value_pattern_matches(
  expected_name: string,
  actual: FrontExpr,
  scope: TypeSetScope,
): boolean {
  if (actual.tag === "var" && actual.name === expected_name) {
    return true;
  }

  const expected = resolve_front_type_value(
    { tag: "var", name: expected_name },
    scope.type_values,
    new Set(),
  );
  const resolved_actual = resolve_front_type_value(
    actual,
    scope.type_values,
    new Set(),
  );

  if (expected === undefined || resolved_actual === undefined) {
    return false;
  }

  return format_expr(expected) === format_expr(resolved_actual);
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

function resolve_type_namespace_value(
  value: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  if (value.tag === "captured" || value.tag === "comptime") {
    return resolve_type_namespace_value(value.expr, scope, resolving);
  }

  if (value.tag === "with" || value.tag === "struct_update") {
    return value;
  }

  if (value.tag === "var") {
    if (resolving.has(value.name)) {
      return undefined;
    }

    const target = scope.type_values.get(value.name);

    if (target === undefined) {
      return undefined;
    }

    const next = new Set(resolving);
    next.add(value.name);
    return resolve_type_namespace_value(target, scope, next);
  }

  if (value.tag !== "app") {
    return undefined;
  }

  return specialize_front_type_constructor(
    value,
    scope.type_values,
    resolving,
  );
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
  if (
    func.tag === "lam" && !scope.evaluating_const_call &&
    func.params.length > 0 &&
    func.params.every((param) => param.is_const) &&
    args.every((arg) => scope_const_expr_known(arg, scope))
  ) {
    const bindings = parameter_arguments(func.params, args);

    if (bindings === undefined) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (const { param, arg } of bindings) {
      replacements.set(param.name, arg);
    }

    const evaluation_scope = clone_scope(scope);
    evaluation_scope.evaluating_const_body = true;
    evaluation_scope.evaluating_const_call = true;
    evaluation_scope.const_evaluation = {
      recursions: new Map(),
      steps: 0,
    };
    return unwrap_const_result(rewrite_expr(
      substitute_front_expr(func.body, replacements),
      evaluation_scope,
    ));
  }

  if (func.tag === "lam" && scope.evaluating_const_call) {
    const bindings = parameter_arguments(func.params, args);

    if (bindings === undefined) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (const { param, arg } of bindings) {
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
    const bindings = parameter_arguments(const_value.params, args);

    if (bindings === undefined) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (const { param, arg } of bindings) {
      replacements.set(param.name, arg);
    }

    return substitute_front_expr(const_value.body, replacements);
  }

  const binding = scope.bindings.get(func.name);

  if (
    !scope.evaluating_const_call && binding?.compiletime_only === true &&
    binding.value?.tag === "lam"
  ) {
    const bindings = parameter_arguments(binding.value.params, args);

    if (bindings !== undefined) {
      for (const { param, arg } of bindings) {
        if (param.is_const && !scope_const_expr_known(arg, scope)) {
          throw new Error(
            "Const parameter " + param.name +
              " requires compile-time argument: " + format_expr(arg),
          );
        }
      }
    }
  }

  if (
    !scope.evaluating_const_call && binding !== undefined &&
    binding.value?.tag === "lam" &&
    binding.value.params.every((param) => param.is_const) &&
    args.every((arg) => scope_const_expr_known(arg, scope))
  ) {
    const bindings = parameter_arguments(binding.value.params, args);

    if (bindings === undefined) {
      return undefined;
    }

    const replacements = new Map<string, FrontExpr>();

    for (const { param, arg } of bindings) {
      replacements.set(param.name, arg);
    }

    const evaluation_scope = clone_scope(scope);
    evaluation_scope.evaluating_const_body = true;
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
    evaluation_scope.evaluating_const_body = true;
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
  local.evaluating_const_body = true;
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
  const captured = capture_const_bindings(value, scope);
  let result = unwrap_const_result(
    resolve_scope_const_value(rewrite_expr(captured, scope), scope),
  );
  result = unwrap_const_result(resolve_scope_const_value(result, scope));

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
    if (
      statement.tag === "for_collection" || statement.tag === "for_range" ||
      statement.tag === "if_stmt" || statement.tag === "if_let_stmt"
    ) {
      propagate_const_assignments(statement.body, source, target);
      continue;
    }

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
    return true;
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

  if (scope.evaluating_const_call && value.tag === "text") {
    return { tag: "num", type: "i32", value: text_byte_length(value.value) };
  }

  if (value.tag === "array" && value.rest === undefined) {
    return { tag: "num", type: "i32", value: value.items.length };
  }

  if (value.tag === "product" || value.tag === "shape") {
    return { tag: "num", type: "i32", value: value.entries.length };
  }

  if (value.tag === "struct_value") {
    return { tag: "num", type: "i32", value: value.fields.length };
  }

  return undefined;
}

function elaborate_type_of_call(
  func: FrontExpr,
  args: FrontExpr[],
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (func.tag !== "var" || func.name !== "@type_of") {
    return undefined;
  }

  if (args.length !== 1) {
    throw new Error("@type_of expects exactly one value");
  }

  const value = args[0];
  expect(value, "Missing @type_of value");
  const type = type_of_static_type_value(value, scope, new Set());

  if (type === undefined) {
    throw new Error(
      "@type_of cannot determine the static type of " + format_expr(value),
    );
  }

  return type;
}

function static_type_value(
  expr: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  if (expr.tag === "bool") {
    return { tag: "type_name", name: "Bool" };
  }

  if (expr.tag === "num") {
    let name = "I32";

    if (expr.character !== undefined) {
      name = "Char";
    } else if (expr.integer !== undefined) {
      name = integer_type_name(expr.integer);
    } else if (expr.type === "i64") {
      name = "I64";
    } else if (expr.type === "f32") {
      name = "F32";
    } else if (expr.type === "f64") {
      name = "F64";
    }

    return { tag: "type_name", name };
  }

  if (expr.tag === "unit") {
    return { tag: "type_name", name: "Unit" };
  }

  if (expr.tag === "text") {
    if (expr.encoding === "bytes") {
      return { tag: "type_name", name: "Bytes" };
    }

    return { tag: "type_name", name: "Text" };
  }

  if (expr.tag === "atom") {
    return {
      tag: "set_type",
      type_expr: { tag: "atom", name: expr.name },
    };
  }

  if (
    expr.tag === "type_name" || expr.tag === "set_type" ||
    expr.tag === "struct_type" || expr.tag === "union_type" ||
    expr.tag === "shape" || expr.tag === "type_with"
  ) {
    return { tag: "type_name", name: "Type" };
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    if (
      expr.tag === "var" &&
      (expr.name === "Type" || is_builtin_type_name(expr.name))
    ) {
      return { tag: "type_name", name: "Type" };
    }

    const binding = scope.bindings.get(expr.name);

    if (binding?.annotation !== undefined) {
      return type_value_from_type_expr(
        parse_type_expr(tokenize(binding.annotation)),
      );
    }

    if (binding?.type_annotation !== undefined) {
      return type_value_from_type_expr(binding.type_annotation);
    }

    if (binding?.inferred_type !== undefined) {
      return binding.inferred_type;
    }

    if (
      binding?.value === undefined || resolving.has(expr.name)
    ) {
      return undefined;
    }

    const nested = new Set(resolving);
    nested.add(expr.name);
    return static_type_value(binding.value, scope, nested);
  }

  if (expr.tag === "as") {
    return type_value_from_type_expr(expr.type_expr);
  }

  if (
    expr.tag === "comptime" || expr.tag === "borrow" ||
    expr.tag === "freeze" || expr.tag === "scratch" ||
    expr.tag === "captured"
  ) {
    let value: FrontExpr;

    if (expr.tag === "scratch") {
      value = expr.body;
    } else if (expr.tag === "borrow" || expr.tag === "freeze") {
      value = expr.value;
    } else {
      value = expr.expr;
    }

    const inner = static_type_value(value, scope, resolving);

    if (
      inner === undefined || expr.tag === "comptime" ||
      expr.tag === "captured" || expr.tag === "scratch"
    ) {
      return inner;
    }

    const type_expr = prelude_type_expr(inner);

    if (expr.tag === "borrow") {
      return {
        tag: "set_type",
        type_expr: { tag: "borrow", value: type_expr },
      };
    }

    return { tag: "set_type", type_expr: { tag: "frozen", value: type_expr } };
  }

  if (expr.tag === "is") {
    return { tag: "type_name", name: "Bool" };
  }

  if (expr.tag === "prim") {
    if (prim_returns_bool(expr.prim)) {
      return { tag: "type_name", name: "Bool" };
    }

    const operand_type = static_type_value(expr.left, scope, resolving);

    if (operand_type === undefined) {
      return undefined;
    }

    return widened_type_value(operand_type);
  }

  if (expr.tag === "struct_value") {
    if (
      expr.type_expr.tag !== "var" || expr.type_expr.name !== "object_type"
    ) {
      return expr.type_expr;
    }

    return static_product_type_value(
      expr.fields.map((field) => ({ label: field.name, value: field.value })),
      scope,
      resolving,
    );
  }

  if (expr.tag === "product") {
    return static_product_type_value(expr.entries, scope, resolving);
  }

  if (expr.tag === "array" && expr.rest === undefined) {
    const first = expr.items[0];

    if (first === undefined) {
      return undefined;
    }

    const element = static_type_value(first, scope, resolving);

    if (element === undefined) {
      return undefined;
    }

    const element_expr = prelude_type_expr(element);

    for (const item of expr.items.slice(1)) {
      const item_type = static_type_value(item, scope, resolving);

      if (
        item_type === undefined ||
        format_type_expr(prelude_type_expr(item_type)) !==
          format_type_expr(element_expr)
      ) {
        return undefined;
      }
    }

    return {
      tag: "set_type",
      type_expr: {
        tag: "array",
        element: element_expr,
        length: { tag: "number", value: expr.items.length },
      },
    };
  }

  if (expr.tag === "array_repeat" && expr.length.tag === "num") {
    const element = static_type_value(expr.value, scope, resolving);

    if (element === undefined || typeof expr.length.value !== "number") {
      return undefined;
    }

    return {
      tag: "set_type",
      type_expr: {
        tag: "array",
        element: prelude_type_expr(element),
        length: { tag: "number", value: expr.length.value },
      },
    };
  }

  if (expr.tag === "union_case" && expr.type_expr !== undefined) {
    return expr.type_expr;
  }

  if (expr.tag === "struct_update" || expr.tag === "with") {
    return static_type_value(expr.base, scope, resolving);
  }

  if (expr.tag === "field") {
    const object_type = static_type_value(expr.object, scope, resolving);

    if (object_type === undefined) {
      return undefined;
    }

    return static_aggregate_field_type(object_type, expr.name, scope);
  }

  if (
    expr.tag === "index" && expr.index.tag === "num" &&
    typeof expr.index.value === "number"
  ) {
    const object_type = static_type_value(expr.object, scope, resolving);

    if (object_type === undefined) {
      return undefined;
    }

    return static_aggregate_index_type(
      object_type,
      expr.index.value,
      scope,
    );
  }

  if (expr.tag === "app") {
    const callable = static_type_value(expr.func, scope, resolving);

    if (callable === undefined) {
      return undefined;
    }

    const arrow = function_type_expr(prelude_type_expr(callable));

    if (arrow === undefined) {
      return undefined;
    }

    return type_value_from_type_expr(arrow.result);
  }

  if (expr.tag === "if") {
    return common_static_type_value(
      expr.then_branch,
      expr.else_branch,
      scope,
      resolving,
    );
  }

  if (expr.tag === "if_let") {
    return common_static_type_value(
      expr.then_branch,
      expr.else_branch,
      scope,
      resolving,
    );
  }

  if (expr.tag === "match") {
    let result: FrontExpr | undefined;

    for (const arm of expr.arms) {
      const arm_type = static_type_value(arm.body, scope, resolving);

      if (arm_type === undefined) {
        return undefined;
      }

      if (result === undefined) {
        result = arm_type;
        continue;
      }

      if (
        format_type_expr(prelude_type_expr(result)) !==
          format_type_expr(prelude_type_expr(arm_type))
      ) {
        return undefined;
      }
    }

    return result;
  }

  return undefined;
}

function type_of_static_type_value(
  expr: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  if (
    expr.tag === "app" && expr.func.tag === "var" &&
    expr.func.name === "@cast"
  ) {
    const args = compiler_builtin_args(expr);
    const target = args[1];

    if (args.length === 2 && target !== undefined) {
      const resolved_target = resolve_front_type_value(
        target,
        scope.type_values,
        new Set(),
      );

      if (resolved_target !== undefined) {
        return resolved_target;
      }
    }
  }

  if (expr.tag === "bool") {
    return {
      tag: "set_type",
      type_expr: { tag: "literal", value: expr },
    };
  }

  if (expr.tag === "num" && (expr.type === "i32" || expr.type === "i64")) {
    return {
      tag: "set_type",
      type_expr: { tag: "literal", value: expr },
    };
  }

  if (expr.tag === "text" && expr.encoding !== "bytes") {
    return {
      tag: "set_type",
      type_expr: {
        tag: "literal",
        value: { tag: "text", value: expr.value },
      },
    };
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const binding = scope.bindings.get(expr.name);

    if (
      binding?.annotation === undefined &&
      binding?.type_annotation === undefined && binding?.is_const === true &&
      binding.value !== undefined && !resolving.has(expr.name)
    ) {
      const nested = new Set(resolving);
      nested.add(expr.name);
      return type_of_static_type_value(binding.value, scope, nested);
    }
  }

  return static_type_value(expr, scope, resolving);
}

function widened_type_value(type: FrontExpr): FrontExpr {
  if (type.tag !== "set_type" || type.type_expr.tag !== "literal") {
    return type;
  }

  const literal = type.type_expr.value;

  if (literal.tag === "bool") {
    return { tag: "type_name", name: "Bool" };
  }

  if (literal.tag === "text") {
    return { tag: "type_name", name: "Text" };
  }

  if (literal.character !== undefined) {
    return { tag: "type_name", name: "Char" };
  }

  let name = "I32";

  if (literal.integer !== undefined) {
    name = integer_type_name(literal.integer);
  } else if (literal.type === "i64") {
    name = "I64";
  } else if (literal.type === "f32") {
    name = "F32";
  } else if (literal.type === "f64") {
    name = "F64";
  }

  return { tag: "type_name", name };
}

function static_product_type_value(
  entries: { label?: string; value: FrontExpr }[],
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  const type_entries: Extract<TypeExpr, { tag: "product" }>["entries"] = [];

  for (const entry of entries) {
    const type = static_type_value(entry.value, scope, resolving);

    if (type === undefined) {
      return undefined;
    }

    type_entries.push({
      label: entry.label,
      type_expr: prelude_type_expr(type),
    });
  }

  return {
    tag: "set_type",
    type_expr: { tag: "product", entries: type_entries },
  };
}

function static_aggregate_field_type(
  object_type: FrontExpr,
  name: string,
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (
    object_type.tag === "set_type" &&
    (object_type.type_expr.tag === "borrow" ||
      object_type.type_expr.tag === "frozen")
  ) {
    return static_aggregate_field_type(
      type_value_from_type_expr(object_type.type_expr.value),
      name,
      scope,
    );
  }

  const resolved = resolve_front_type_value(
    object_type,
    scope.type_values,
    new Set(),
  );

  if (resolved?.tag === "struct_type") {
    const field = resolved.fields.find((candidate) => candidate.name === name);

    if (field === undefined) {
      return undefined;
    }

    if (field.set_member !== undefined) {
      return type_value_from_type_expr(field.set_member);
    }

    return type_value_from_type_expr(
      parse_type_expr(tokenize(field.type_name)),
    );
  }

  if (
    object_type.tag !== "set_type" || object_type.type_expr.tag !== "product"
  ) {
    return undefined;
  }

  const entry = object_type.type_expr.entries.find((candidate) => {
    return candidate.label === name;
  });

  if (entry === undefined) {
    return undefined;
  }

  return type_value_from_type_expr(entry.type_expr);
}

function static_aggregate_index_type(
  object_type: FrontExpr,
  index: number,
  scope: TypeSetScope,
): FrontExpr | undefined {
  if (
    object_type.tag === "set_type" &&
    (object_type.type_expr.tag === "borrow" ||
      object_type.type_expr.tag === "frozen")
  ) {
    return static_aggregate_index_type(
      type_value_from_type_expr(object_type.type_expr.value),
      index,
      scope,
    );
  }

  const resolved = resolve_front_type_value(
    object_type,
    scope.type_values,
    new Set(),
  );

  if (resolved?.tag === "struct_type") {
    const field = resolved.fields[index];

    if (field === undefined) {
      return undefined;
    }

    if (field.set_member !== undefined) {
      return type_value_from_type_expr(field.set_member);
    }

    return type_value_from_type_expr(
      parse_type_expr(tokenize(field.type_name)),
    );
  }

  if (object_type.tag !== "set_type") {
    return undefined;
  }

  if (object_type.type_expr.tag === "array") {
    return type_value_from_type_expr(object_type.type_expr.element);
  }

  if (object_type.type_expr.tag !== "product") {
    return undefined;
  }

  const entry = object_type.type_expr.entries[index];

  if (entry === undefined) {
    return undefined;
  }

  return type_value_from_type_expr(entry.type_expr);
}

function common_static_type_value(
  left: FrontExpr,
  right: FrontExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): FrontExpr | undefined {
  const left_type = static_type_value(left, scope, resolving);
  const right_type = static_type_value(right, scope, resolving);

  if (left_type === undefined || right_type === undefined) {
    return undefined;
  }

  if (
    format_type_expr(prelude_type_expr(left_type)) !==
      format_type_expr(prelude_type_expr(right_type))
  ) {
    return undefined;
  }

  return left_type;
}

function type_value_from_type_expr(type: TypeExpr): FrontExpr {
  if (type.tag === "name") {
    if (type.name === "Type" || is_builtin_type_name(type.name)) {
      return { tag: "type_name", name: type.name };
    }

    return { tag: "var", name: type.name };
  }

  if (type.tag === "apply") {
    const func = type_value_from_type_expr(type.func);
    const arg = type_value_from_type_expr(type.arg);
    return { tag: "app", func, arg, args: [arg] };
  }

  return { tag: "set_type", type_expr: type };
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
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "import":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "type_with":
      return true;

    case "app":
      if (
        expr.func.tag === "var" &&
        (expr.func.name === "@describe_type" ||
          expr.func.name === "@describe_fields" ||
          expr.func.name === "@describe_cases" ||
          expr.func.name === "@type_of" ||
          expr.func.name === "@construct" ||
          expr.func.name === "@project" ||
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

    case "match":
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

    case "block":
      return expr.statements.some(statement_requires_type_specialization);

    case "loop":
      return expr.body.some(statement_requires_type_specialization);

    case "lam":
    case "rec":
    case "scratch":
      return expr_requires_type_specialization(expr.body);

    case "comptime":
      return expr_requires_type_specialization(expr.expr);

    case "borrow":
    case "freeze":
    case "is":
    case "as":
      return expr_requires_type_specialization(expr.value);

    case "captured":
      return expr_requires_type_specialization(expr.expr);

    case "prim":
      return expr_requires_type_specialization(expr.left) ||
        expr_requires_type_specialization(expr.right);

    case "product":
    case "shape":
      return expr.entries.some((entry) => {
        return expr_requires_type_specialization(entry.value);
      });

    case "array":
      if (expr.items.some(expr_requires_type_specialization)) {
        return true;
      }
      if (expr.rest === undefined) {
        return false;
      }
      return expr_requires_type_specialization(expr.rest);

    case "array_repeat":
      return expr_requires_type_specialization(expr.value) ||
        expr_requires_type_specialization(expr.length);

    case "handler":
      if (
        expr.state.some((state) => {
          return expr_requires_type_specialization(state.value);
        })
      ) {
        return true;
      }
      if (
        expr.clauses.some((clause) => {
          return expr_requires_type_specialization(clause.body);
        })
      ) {
        return true;
      }
      return expr_requires_type_specialization(expr.return_clause.body);

    case "try_with":
      return expr_requires_type_specialization(expr.body) ||
        expr_requires_type_specialization(expr.handler);

    case "with":
    case "struct_update":
      if (expr_requires_type_specialization(expr.base)) {
        return true;
      }
      return expr.fields.some((field) => {
        return expr_requires_type_specialization(field.value);
      });

    case "struct_value":
      if (expr_requires_type_specialization(expr.type_expr)) {
        return true;
      }
      return expr.fields.some((field) => {
        return expr_requires_type_specialization(field.value);
      });

    case "if":
      return expr_requires_type_specialization(expr.cond) ||
        expr_requires_type_specialization(expr.then_branch) ||
        expr_requires_type_specialization(expr.else_branch);

    case "if_let":
      return expr_requires_type_specialization(expr.target) ||
        expr_requires_type_specialization(expr.then_branch) ||
        expr_requires_type_specialization(expr.else_branch);

    case "field":
      return expr_requires_type_specialization(expr.object);

    case "index":
      return expr_requires_type_specialization(expr.object) ||
        expr_requires_type_specialization(expr.index);

    case "union_case":
      if (
        expr.value !== undefined &&
        expr_requires_type_specialization(expr.value)
      ) {
        return true;
      }
      if (expr.type_expr === undefined) {
        return false;
      }
      return expr_requires_type_specialization(expr.type_expr);
  }
}

function statement_requires_type_specialization(statement: Stmt): boolean {
  switch (statement.tag) {
    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return false;

    case "bind":
    case "assign":
    case "return":
    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
      return expr_requires_type_specialization(statement.value);

    case "expr":
      return expr_requires_type_specialization(statement.expr);

    case "index_assign":
      return expr_requires_type_specialization(statement.index) ||
        expr_requires_type_specialization(statement.value);

    case "for_collection":
      return expr_requires_type_specialization(statement.collection) ||
        statement.body.some(statement_requires_type_specialization);

    case "for_range":
      return expr_requires_type_specialization(statement.start) ||
        expr_requires_type_specialization(statement.end) ||
        expr_requires_type_specialization(statement.step) ||
        statement.body.some(statement_requires_type_specialization);

    case "if_stmt":
      return expr_requires_type_specialization(statement.cond) ||
        statement.body.some(statement_requires_type_specialization);

    case "if_let_stmt":
      return expr_requires_type_specialization(statement.target) ||
        statement.body.some(statement_requires_type_specialization);

    case "type_check":
      return expr_requires_type_specialization(statement.target);

    case "break":
      if (statement.value === undefined) {
        return false;
      }
      return expr_requires_type_specialization(statement.value);
  }
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

  if (expr.type_expr.tag === "literal") {
    return match_literal_condition(value, {
      tag: "literal",
      value: expr.type_expr.value,
    });
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

  if (!binding) {
    return undefined;
  }

  if (!binding.annotation) {
    if (binding.inferred_type === undefined) {
      return undefined;
    }

    const inferred = resolve_front_type_value(
      binding.inferred_type,
      scope.type_values,
      new Set(),
    );

    if (inferred?.tag === "union_type") {
      return inferred;
    }

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
    annotation,
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
  let type = normalize_scope_type_expr(
    parse_type_expr(tokenize(annotation)),
    scope,
  );
  expect(type, "Missing normalized type annotation");

  if (type.tag === "name") {
    const resolving = new Set<string>();

    while (!resolving.has(type.name)) {
      resolving.add(type.name);
      const value = scope.type_values.get(type.name);

      if (value?.tag !== "var") {
        break;
      }

      type = { tag: "name", name: value.name };
    }
  }

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
    expr.character === undefined &&
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
      return { tag: "literal", value };

    case "atom":
      return { tag: "atom", name: value.name };

    case "num":
      return { tag: "literal", value };

    case "text":
      if (value.encoding === "bytes") {
        return { tag: "scalar", name: "Bytes" };
      }

      return { tag: "literal", value };

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
        fields: resolved.fields.map((field) => {
          let field_type = parse_type_expr(tokenize(field.type_name));
          const nominal_name = nominal_struct_type_name(
            field_type,
            scope,
            next,
          );

          if (nominal_name !== undefined) {
            field_type = { tag: "name", name: nominal_name };
          }

          return {
            name: field.name,
            type: semantic_type_for_expr(field_type, scope, next),
          };
        }),
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

function nominal_struct_type_name(
  type: TypeExpr,
  scope: TypeSetScope,
  resolving: Set<string>,
): string | undefined {
  if (type.tag !== "product") {
    return undefined;
  }

  const expected = format_type_expr(type);

  for (const [name, value] of scope.type_values) {
    if (resolving.has(name)) {
      continue;
    }

    const resolved = resolve_front_type_value(
      value,
      scope.type_values,
      new Set([name]),
    );

    if (
      resolved?.tag === "struct_type" &&
      format_type_expr(prelude_type_expr(resolved)) === expected
    ) {
      return name;
    }
  }

  return undefined;
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
      return nominalize_struct_type_fields(product, type_values, resolving);
    }

    return resolve_front_type_value(value.base, type_values, resolving);
  }

  if (value.tag === "product") {
    const product = product_type_with_namespace(value);

    if (product === undefined) {
      return undefined;
    }

    return nominalize_struct_type_fields(product, type_values, resolving);
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

function nominalize_struct_type_fields(
  value: Extract<FrontExpr, { tag: "struct_type" }>,
  type_values: Map<string, FrontExpr>,
  resolving: Set<string>,
): Extract<FrontExpr, { tag: "struct_type" }> {
  return {
    ...value,
    fields: value.fields.map((field) => {
      const field_type = parse_type_expr(tokenize(field.type_name));

      if (field_type.tag !== "product") {
        return field;
      }

      const expected = format_type_expr(field_type);

      for (const [name, candidate] of type_values) {
        if (resolving.has(name)) {
          continue;
        }

        const resolved = resolve_front_type_value(
          candidate,
          type_values,
          new Set([...resolving, name]),
        );

        if (
          resolved?.tag === "struct_type" &&
          format_type_expr(prelude_type_expr(resolved)) === expected
        ) {
          return { name: field.name, type_name: name };
        }
      }

      return field;
    }),
  };
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

  const replacements = new Map<string, FrontExpr>();

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

    replacements.set(param.name, { tag: "var", name: type_name });
  }

  return substitute_front_expr(func.body, replacements);
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
    const actual = semantic_type_for_value(value, scope);
    const annotated = semantic_type_for_expr(
      parse_type_expr(tokenize(annotation)),
      scope,
      new Set(),
    );

    if (annotated.tag !== "literal" || actual === undefined) {
      return value;
    }

    if (sem_type_subtype(actual, annotated)) {
      return value;
    }

    throw new Error(
      "Type-set " + annotation_site + " annotation expects " + annotation +
        ", got " + semantic_type_display_name(actual),
    );
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

  throw new Error(
    "Type-set " + annotation_site + " annotation expects " + annotation +
      ", got " + semantic_type_display_name(actual),
  );
}

function semantic_type_display_name(type: SemType): string {
  if (type.tag === "scalar") {
    return type.name;
  }

  if (type.tag === "atom") {
    return "#" + type.name;
  }

  if (type.tag === "literal") {
    return format_type_expr({ tag: "literal", value: type.value });
  }

  return sem_type_key(type);
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
    declared_union_types: new Map(scope.declared_union_types),
    evaluating_const_body: scope.evaluating_const_body,
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
