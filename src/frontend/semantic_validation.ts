import {
  type NumType,
  Prim,
  specialize_prim_for_operands,
  type ValType,
} from "../op.ts";
import { Callable } from "../trait.ts";
import { expect } from "../expect.ts";
import type { DiagnosticCode } from "../diagnostic.ts";
import type {
  ArrayLengthExpr,
  Binding,
  Declaration,
  EffectDeclaration,
  Env,
  Field,
  FrontExpr,
  FrontType,
  Param,
  Pattern,
  RecordDeclaration,
  Source,
  Stmt,
  TypeDeclaration,
  TypeExpr,
  TypeField,
} from "./ast.ts";
import { elaborate_product_expr } from "./aggregate.ts";
import { call_message, lookup_type_field } from "./fields.ts";
import { validate_const_expr } from "./constness.ts";
import { clone_env, create_env, push_binding } from "./env.ts";
import { is_no_demand_name } from "./names.ts";
import { require_struct_field } from "./struct_access.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
} from "./semantic_diagnostic.ts";
import {
  numeric_builtin_call,
  prim_result_type,
  prim_returns_bool,
} from "./numeric.ts";
import { dynamic_index_type_from_fields } from "./runtime_struct.ts";
import { format_type_expr, function_type_expr } from "./type_expr.ts";
import { front_type_from_type_name, same_type } from "./types.ts";
import { f32x4_builtin_call, validate_f32x4_lane_argument } from "./f32x4.ts";
import { scan_source, source_tokens } from "./tokenize.ts";
import { validate_union_payload_type } from "./union_payload.ts";
import {
  expanded_type_product_entries,
  fixed_array_length,
  value_pack_length,
} from "./fixed_array_type.ts";
import { integer_type_from_name } from "../integer.ts";

type SemanticBinding = {
  type: FrontType;
  type_annotation: TypeExpr | undefined;
  value: FrontExpr | undefined;
  value_env: SemanticEnv | undefined;
  resume_input_type?: FrontType;
  struct_fields: Field[] | undefined;
  declaration: Extract<Stmt, { tag: "bind" }> | undefined;
  used: boolean;
};

type SemanticEnv = {
  all_bindings: SemanticBinding[];
  bindings: Map<string, SemanticBinding>;
  const_env: Env;
  declarations: Map<string, TypeDeclaration>;
  effects: Map<string, EffectDeclaration>;
  records: Map<string, RecordDeclaration>;
  active_specialized_calls: Set<FrontExpr>;
};

type SemanticCallable = {
  target: Extract<FrontExpr, { tag: "lam" | "rec" }> | undefined;
  target_env: SemanticEnv;
  type_annotation: Extract<TypeExpr, { tag: "arrow" }> | undefined;
};

type SemanticHandler = {
  target: Extract<FrontExpr, { tag: "handler" }>;
  target_env: SemanticEnv;
};

export type SemanticValidationOptions = {
  scope?: "all" | "bool-representation" | "core-representation";
  warnings?: boolean;
};

const bool_route_diagnostics = new WeakSet<SourceDiagnostic>();
const core_route_diagnostics = new WeakSet<SourceDiagnostic>();
const semantic_unit_atom_name = "()";

export function validate_frontend_semantics(
  source: Source,
  options: SemanticValidationOptions = {},
): SourceDiagnostic[] {
  const declarations = source.declarations || [];
  const const_env = create_env();

  for (const declaration of declarations) {
    if (declaration.tag !== "type" && declaration.tag !== "record") {
      continue;
    }

    push_binding(const_env, {
      name: declaration.name,
      ic_name: declaration.name,
      type: { tag: "type" },
      is_const: true,
      is_linear: false,
      value: undefined,
      value_env: undefined,
    });
  }

  const env: SemanticEnv = {
    all_bindings: [],
    bindings: new Map(),
    const_env,
    declarations: declaration_index(declarations),
    effects: effect_index(declarations),
    records: record_index(declarations),
    active_specialized_calls: new Set(),
  };
  const diagnostics: SourceDiagnostic[] = [];

  validate_statements(source.statements, env, diagnostics);

  if (options.warnings === true) {
    append_unused_binding_warnings(env.all_bindings, diagnostics);
  }

  if (options.scope === "bool-representation") {
    return diagnostics.filter((diagnostic) =>
      bool_route_diagnostics.has(diagnostic)
    );
  }

  if (options.scope === "core-representation") {
    return diagnostics.filter((diagnostic) =>
      core_route_diagnostics.has(diagnostic)
    );
  }

  return diagnostics;
}

function bool_route_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
): SourceDiagnostic {
  const diagnostic = source_diagnostic(code, message, subject);
  bool_route_diagnostics.add(diagnostic);
  core_route_diagnostics.add(diagnostic);
  return diagnostic;
}

function core_route_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
): SourceDiagnostic {
  const diagnostic = source_diagnostic(code, message, subject);
  core_route_diagnostics.add(diagnostic);
  return diagnostic;
}

function value_representation_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
  expected: FrontType,
  value: FrontExpr,
  env: SemanticEnv,
): SourceDiagnostic | undefined {
  if (bool_value_representation_mismatch(expected, value, env)) {
    return bool_route_diagnostic(code, message, subject);
  }

  const actual = infer_type(value, env);

  if (text_encoding_mismatch(expected, actual)) {
    return core_route_diagnostic(code, message, subject);
  }

  return undefined;
}

function text_encoding_mismatch(
  expected: FrontType,
  actual: FrontType,
): boolean {
  if (expected.tag !== "text" || actual.tag !== "text") {
    return false;
  }

  if (expected.encoding === "bytes") {
    return actual.encoding !== "bytes";
  }

  return actual.encoding === "bytes";
}

function effect_index(
  declarations: Declaration[],
): Map<string, EffectDeclaration> {
  const index = new Map<string, EffectDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "effect") {
      index.set(declaration.name, declaration);
    }
  }

  return index;
}

function record_index(
  declarations: Declaration[],
): Map<string, RecordDeclaration> {
  const index = new Map<string, RecordDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "record") {
      index.set(declaration.name, declaration);
    }
  }

  return index;
}

function declaration_index(
  declarations: Declaration[],
): Map<string, TypeDeclaration> {
  const index = new Map<string, TypeDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "type") {
      index.set(declaration.name, declaration);
    }
  }

  return index;
}

function validate_statements(
  statements: Stmt[],
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  for (const stmt of statements) {
    validate_statement(stmt, env, diagnostics);
  }
}

function validate_statement(
  stmt: Stmt,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (stmt.tag === "bind" && stmt.mutual !== undefined) {
    const group = [
      { ...stmt, mutual: undefined },
      ...stmt.mutual.map((member): Extract<Stmt, { tag: "bind" }> => ({
        tag: "bind",
        kind: "let",
        is_recursive: true,
        ...member,
      })),
    ];

    for (const member of group) {
      env.bindings.set(member.name, {
        type: { tag: "unknown" },
        type_annotation: member.type_annotation,
        value: member.value,
        value_env: env,
        struct_fields: undefined,
        declaration: member,
        used: false,
      });
    }

    for (const member of group) {
      validate_statement(member, env, diagnostics);
    }

    return;
  }

  if (stmt.tag === "bind") {
    mark_annotation_use(stmt.annotation, stmt.type_annotation, env);
    let binding: SemanticBinding | undefined;

    if (
      stmt.is_recursive ||
      (stmt.kind === "const" && stmt.value.tag === "rec")
    ) {
      binding = {
        type: { tag: "unknown" },
        type_annotation: stmt.type_annotation,
        value: stmt.value,
        value_env: undefined,
        struct_fields: undefined,
        declaration: stmt,
        used: false,
      };
      env.bindings.set(stmt.name, binding);
      env.all_bindings.push(binding);
      bind_constness(env.const_env, stmt, binding.type);
    }

    const value_env = child_env(env);

    if (binding !== undefined) {
      binding.value_env = value_env;
    }

    if (stmt.kind === "const") {
      try {
        validate_const_expr(
          stmt.value,
          env.const_env,
          new Set(),
          "Const binding captures runtime value",
        );
      } catch (error) {
        if (error instanceof Error) {
          diagnostics.push(
            source_diagnostic("DUCK2101", error.message, stmt.value),
          );
        } else {
          throw error;
        }
      }
    }

    validate_type_repetition_annotation(
      stmt.type_annotation,
      env,
      diagnostics,
      stmt,
    );
    const before = diagnostics.length;
    const declared_function_type = function_type_expr(stmt.type_annotation);

    if (
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      declared_function_type !== undefined
    ) {
      validate_annotated_lambda(
        stmt.value,
        declared_function_type,
        env,
        diagnostics,
        stmt.kind !== "const",
      );
    } else {
      const accepts_value_pack = stmt.pattern?.tag === "product" &&
        stmt.pattern.value_pack === true;
      validate_expr(
        stmt.value,
        env,
        diagnostics,
        stmt.kind !== "const",
        accepts_value_pack,
      );
    }
    let type: FrontType = { tag: "unknown" };

    if (diagnostics.length === before) {
      type = infer_type(stmt.value, env);
    }

    validate_basic_annotation(stmt, type, env, diagnostics);
    validate_fixed_array_annotation(stmt, env, diagnostics);

    let struct_value: Extract<FrontExpr, { tag: "struct_value" }> | undefined;

    if (stmt.value.tag === "struct_value") {
      struct_value = stmt.value;
    } else if (stmt.value.tag === "product") {
      struct_value = elaborate_product_expr(stmt.value);
    }

    if (struct_value !== undefined) {
      let annotation_type: FrontType = { tag: "unknown" };

      if (stmt.annotation !== undefined) {
        annotation_type = resolve_type_name(stmt.annotation, env);
      } else if (stmt.type_annotation !== undefined) {
        annotation_type = type_from_type_expr(stmt.type_annotation, env);
      }

      if (
        annotation_type.tag === "struct" && annotation_type.field_types
      ) {
        validate_struct_field_values(
          struct_value.fields,
          annotation_type.field_types,
          env,
          diagnostics,
        );
      }
    }

    if (type.tag === "unknown") {
      if (stmt.annotation !== undefined) {
        type = resolve_type_name(stmt.annotation, env);
      } else if (
        stmt.type_annotation !== undefined &&
        stmt.type_annotation.tag === "name"
      ) {
        type = resolve_type_name(stmt.type_annotation.name, env);
      }
    }

    let resume_input_type: FrontType | undefined;

    if (stmt.value.tag === "var" || stmt.value.tag === "linear") {
      const value_binding = env.bindings.get(stmt.value.name);

      if (value_binding !== undefined) {
        resume_input_type = value_binding.resume_input_type;
      }
    }

    const binding_fields = contextual_binding_fields(stmt, env);

    if (binding === undefined) {
      binding = {
        type,
        type_annotation: stmt.type_annotation,
        value: stmt.value,
        value_env,
        resume_input_type,
        struct_fields: binding_fields,
        declaration: stmt,
        used: false,
      };
      env.all_bindings.push(binding);
      bind_constness(env.const_env, stmt, type);
    } else {
      binding.type = type;
      binding.type_annotation = stmt.type_annotation;
      binding.resume_input_type = resume_input_type;
      binding.struct_fields = binding_fields;
    }

    env.bindings.set(stmt.name, binding);

    if (stmt.pattern !== undefined && stmt.pattern.tag !== "binding") {
      bind_pattern_types(stmt.pattern, type, env, stmt.kind === "const");
    }

    return;
  }

  if (stmt.tag === "assign") {
    const before = diagnostics.length;
    validate_expr(stmt.value, env, diagnostics);
    const previous = env.bindings.get(stmt.name);

    if (!previous) {
      return;
    }

    if (diagnostics.length !== before) {
      bind_assignment_constness(env.const_env, stmt.name);
      return;
    }

    const value_type = infer_type(stmt.value, env);

    if (stmt.mode === "same" && !same_type(previous.type, value_type)) {
      const message = "Assignment changes type for " + stmt.name;

      if (
        previous.type.tag === "bool" || value_type.tag === "bool"
      ) {
        diagnostics.push(bool_route_diagnostic("DUCK2301", message, stmt));
      } else if (text_encoding_mismatch(previous.type, value_type)) {
        diagnostics.push(core_route_diagnostic("DUCK2301", message, stmt));
      } else {
        diagnostics.push(core_route_diagnostic(
          "DUCK2301",
          message,
          stmt,
        ));
      }

      return;
    }

    env.bindings.set(stmt.name, {
      type: value_type,
      type_annotation: undefined,
      value: stmt.value,
      value_env: child_env(env),
      struct_fields: struct_fields_of(stmt.value, env),
      declaration: undefined,
      used: false,
    });
    bind_assignment_constness(env.const_env, stmt.name);
    return;
  }

  if (stmt.tag === "expr") {
    validate_expr(stmt.expr, env, diagnostics);
    return;
  }

  if (stmt.tag === "return") {
    validate_expr(stmt.value, env, diagnostics, true, true);
    return;
  }

  if (stmt.tag === "if_stmt") {
    validate_expr(stmt.cond, env, diagnostics);
    validate_statements(stmt.body, child_env(env), diagnostics);
    return;
  }

  if (stmt.tag === "for_range") {
    validate_expr(stmt.start, env, diagnostics);
    validate_expr(stmt.end, env, diagnostics);
    validate_expr(stmt.step, env, diagnostics);
    validate_numeric_boundary(stmt.start, "Range start", env, diagnostics);
    validate_numeric_boundary(stmt.end, "Range end", env, diagnostics);
    validate_numeric_boundary(stmt.step, "Range step", env, diagnostics);
    const body = child_env(env);
    bind_local(
      body,
      stmt.index,
      { tag: "int", type: "i32" },
      undefined,
      false,
      false,
    );
    validate_statements(stmt.body, body, diagnostics);
    return;
  }

  if (stmt.tag === "for_collection") {
    validate_expr(stmt.collection, env, diagnostics);
    const body = child_env(env);
    const collection_type = infer_type(stmt.collection, env);
    let item_type: FrontType = { tag: "unknown" };

    if (collection_type.tag === "text") {
      item_type = { tag: "int", type: "i32" };
    } else if (
      collection_type.tag === "struct" && collection_type.field_types
    ) {
      try {
        item_type = dynamic_index_type_from_fields(collection_type.field_types);
      } catch (error) {
        if (error instanceof Error) {
          if (struct_fields_include_bool(collection_type.field_types, env)) {
            diagnostics.push(bool_route_diagnostic(
              "DUCK2304",
              error.message,
              stmt.collection,
            ));
          } else {
            diagnostics.push(source_diagnostic(
              "DUCK2304",
              error.message,
              stmt.collection,
            ));
          }
        } else {
          throw error;
        }
      }
    }

    if (stmt.index !== undefined) {
      bind_local(
        body,
        stmt.index,
        { tag: "int", type: "i32" },
        undefined,
        false,
        false,
      );
    }

    bind_local(body, stmt.item, item_type, undefined, false, false);
    validate_statements(stmt.body, body, diagnostics);
    return;
  }

  if (stmt.tag === "if_let_stmt") {
    validate_expr(stmt.target, env, diagnostics);
    const body = child_env(env);

    if (stmt.value_name !== undefined) {
      bind_local(
        body,
        stmt.value_name,
        union_case_payload_type(stmt.target, stmt.case_name, env),
        undefined,
        false,
        false,
      );
    }

    validate_statements(stmt.body, body, diagnostics);
    return;
  }

  if (stmt.tag === "index_assign") {
    mark_binding_used(stmt.name, env);
    validate_expr(stmt.index, env, diagnostics);
    validate_expr(stmt.value, env, diagnostics);
    validate_numeric_boundary(stmt.index, "Index", env, diagnostics);

    const binding = env.bindings.get(stmt.name);

    if (binding && binding.type.tag === "text") {
      if (binding.type.encoding !== "bytes") {
        diagnostics.push(core_route_diagnostic(
          "DUCK2306",
          "Cannot index-assign Text; convert it with Utf8.encode first",
          stmt,
        ));
        return;
      }

      const value_type = infer_type(stmt.value, env);

      if (
        value_type.tag !== "unknown" &&
        (value_type.tag !== "int" || value_type.type !== "i32")
      ) {
        diagnostics.push(core_route_diagnostic(
          "DUCK2306",
          "Bytes index assignment expects I32, got " + type_name(value_type),
          stmt.value,
        ));
      }

      return;
    }

    if (
      !binding || binding.type.tag !== "struct" ||
      !binding.type.field_types
    ) {
      return;
    }

    let expected: FrontType = { tag: "unknown" };

    try {
      const static_index = static_i32_index(stmt.index);

      if (static_index === undefined) {
        expected = dynamic_index_type_from_fields(binding.type.field_types);
      } else {
        const field = binding.type.field_types[static_index];

        if (field !== undefined) {
          expected = resolve_type_name(field.type_name, env);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (struct_fields_include_bool(binding.type.field_types, env)) {
          diagnostics.push(bool_route_diagnostic(
            "DUCK2304",
            error.message,
            stmt,
          ));
        } else {
          diagnostics.push(source_diagnostic(
            "DUCK2304",
            error.message,
            stmt,
          ));
        }

        return;
      }

      throw error;
    }

    const actual = infer_type(stmt.value, env);

    const representation_diagnostic = value_representation_diagnostic(
      "DUCK2306",
      "Struct index update expects " + type_name(expected) + ", got " +
        type_name(actual),
      stmt.value,
      expected,
      stmt.value,
      env,
    );

    if (representation_diagnostic) {
      diagnostics.push(representation_diagnostic);
    }

    return;
  }

  if (stmt.tag === "state_bind") {
    validate_expr(stmt.value, env, diagnostics);

    if (
      stmt.value.tag !== "app" || stmt.value.func.tag !== "field" ||
      stmt.value.func.object.tag !== "var"
    ) {
      diagnostics.push(source_diagnostic(
        "DUCK2307",
        "Effect bind must call a declared effect operation",
        stmt.value,
      ));
      return;
    }

    const effect_name = stmt.value.func.object.name;
    const effect = env.effects.get(effect_name);

    if (effect === undefined) {
      diagnostics.push(source_diagnostic(
        "DUCK2307",
        "Unknown effect: " + effect_name,
        stmt.value.func.object,
      ));
      return;
    }

    const operation_name = stmt.value.func.name;
    const operation = effect.operations.find((candidate) => {
      return candidate.name === operation_name;
    });

    if (operation === undefined) {
      diagnostics.push(source_diagnostic(
        "DUCK2307",
        "Unknown effect operation: " + effect_name + "." + operation_name,
        stmt.value.func,
      ));
      return;
    }

    if (stmt.value_name !== undefined) {
      const result_type = infer_type(stmt.value, env);
      bind_local(
        env,
        stmt.value_name,
        result_type,
        undefined,
        false,
        false,
      );
    }

    return;
  }

  if (stmt.tag === "bind_pattern") {
    validate_expr(stmt.value, env, diagnostics);
    const value_type = infer_type(stmt.value, env);

    for (const item of stmt.items) {
      let field_type: FrontType = { tag: "unknown" };

      if (value_type.tag === "struct" && value_type.field_types) {
        const field = lookup_type_field(value_type.field_types, item.name);

        if (field !== undefined) {
          field_type = resolve_type_name(field.type_name, env);
        }
      }

      bind_local(
        env,
        item.name,
        field_type,
        undefined,
        stmt.kind === "const",
        item.is_linear,
      );
    }

    return;
  }

  if (stmt.tag === "resume_dup") {
    validate_expr(stmt.value, env, diagnostics);
    let resume_input_type: FrontType | undefined;

    if (stmt.value.tag === "var" || stmt.value.tag === "linear") {
      const value_binding = env.bindings.get(stmt.value.name);

      if (value_binding !== undefined) {
        resume_input_type = value_binding.resume_input_type;
      }
    }

    const left_binding = bind_local(
      env,
      stmt.left,
      { tag: "unknown" },
      undefined,
      false,
      true,
    );
    const right_binding = bind_local(
      env,
      stmt.right,
      { tag: "unknown" },
      undefined,
      false,
      true,
    );
    left_binding.resume_input_type = resume_input_type;
    right_binding.resume_input_type = resume_input_type;
    return;
  }

  if (stmt.tag === "type_check") {
    validate_expr(stmt.target, env, diagnostics);

    for (const field of stmt.pattern.fields) {
      mark_annotation_text_use(field.type_name, env);

      if (field.set_member !== undefined) {
        mark_type_expr_uses(field.set_member, env);
      }
    }

    return;
  }

  if (stmt.tag === "break") {
    if (stmt.value !== undefined) {
      validate_expr(stmt.value, env, diagnostics);
    }

    return;
  }

  if (stmt.tag === "import") {
    bind_local(env, stmt.name, { tag: "unknown" }, undefined, true, false);
    return;
  }

  if (stmt.tag === "host_import") {
    bind_local(
      env,
      stmt.value.name,
      { tag: "unknown" },
      undefined,
      true,
      false,
    );
  }
}

function validate_expr(
  expr: FrontExpr,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
  check_comptime = true,
  accepts_value_pack = false,
): void {
  if (expr.tag === "var" || expr.tag === "linear") {
    mark_binding_used(expr.name, env);
    return;
  }

  if (expr.tag === "prim") {
    const before = diagnostics.length;
    validate_expr(expr.left, env, diagnostics, check_comptime);
    validate_expr(expr.right, env, diagnostics, check_comptime);

    if (diagnostics.length !== before) {
      return;
    }

    const left_type = infer_type(expr.left, env);
    const right_type = infer_type(expr.right, env);

    if (left_type.tag === "f32x4" || right_type.tag === "f32x4") {
      diagnostics.push(source_diagnostic(
        "DUCK2302",
        "F32x4 values require explicit f32x4_* builtins",
        expr,
      ));
      return;
    }

    if (left_type.tag === "bool" || right_type.tag === "bool") {
      const equality = expr.prim === "i32.eq" || expr.prim === "i32.ne";

      if (
        equality && left_type.tag === "bool" && right_type.tag === "bool"
      ) {
        return;
      }

      let message = "Primitive " + expr.prim +
        " expects numeric operands, got Bool";

      if (equality) {
        message = "Boolean equality requires Bool operands";
      }

      diagnostics.push(bool_route_diagnostic(
        "DUCK2302",
        message,
        expr,
      ));
      return;
    }

    try {
      specialize_prim_for_operands(
        expr.prim,
        numeric_type(expr.left, env),
        numeric_type(expr.right, env),
      );
    } catch (error) {
      if (error instanceof Error) {
        diagnostics.push(
          source_diagnostic("DUCK2302", error.message, expr),
        );
        return;
      }

      throw error;
    }

    return;
  }

  if (expr.tag === "if") {
    const before = diagnostics.length;
    validate_expr(expr.cond, env, diagnostics, check_comptime);

    if (diagnostics.length === before) {
      const condition = infer_type(expr.cond, env);

      if (
        condition.tag !== "unknown" &&
        condition.tag !== "bool"
      ) {
        diagnostics.push(source_diagnostic(
          "DUCK2303",
          "If condition expects Bool, got " + type_name(condition),
          expr.cond,
        ));
      }
    }

    validate_expr(
      expr.then_branch,
      child_env(env),
      diagnostics,
      check_comptime,
      accepts_value_pack,
    );
    validate_expr(
      expr.else_branch,
      child_env(env),
      diagnostics,
      check_comptime,
      accepts_value_pack,
    );

    if (diagnostics.length === before) {
      validate_branch_types(expr, env, diagnostics);
    }
    return;
  }

  if (expr.tag === "if_let") {
    const before = diagnostics.length;
    validate_expr(expr.target, env, diagnostics, check_comptime);
    const then_env = child_env(env);

    if (expr.value_name !== undefined) {
      bind_local(
        then_env,
        expr.value_name,
        union_case_payload_type(expr.target, expr.case_name, env),
        undefined,
        false,
        false,
      );
    }

    validate_expr(
      expr.then_branch,
      then_env,
      diagnostics,
      check_comptime,
      accepts_value_pack,
    );
    validate_expr(
      expr.else_branch,
      child_env(env),
      diagnostics,
      check_comptime,
      accepts_value_pack,
    );

    if (diagnostics.length === before) {
      validate_branch_types(expr, env, diagnostics);
    }
    return;
  }

  if (expr.tag === "field") {
    const before = diagnostics.length;
    validate_expr(expr.object, env, diagnostics, check_comptime);

    if (diagnostics.length !== before) {
      return;
    }

    const object = struct_fields_of(expr.object, env);

    if (object) {
      try {
        require_struct_field(find_field(object, expr.name), expr.name);
      } catch (error) {
        if (error instanceof Error) {
          diagnostics.push(
            source_diagnostic("DUCK2304", error.message, expr),
          );
          return;
        }

        throw error;
      }
    }

    return;
  }

  if (expr.tag === "app") {
    const f32x4_call = f32x4_builtin_call(expr);

    if (
      f32x4_call && expr.func.tag === "var" &&
      !env.bindings.has(expr.func.name)
    ) {
      const before = diagnostics.length;

      for (const arg of f32x4_call.args) {
        validate_expr(arg, env, diagnostics, check_comptime);
      }

      if (diagnostics.length === before) {
        validate_f32x4_builtin_call(expr, f32x4_call, env, diagnostics);
      }

      return;
    }

    const numeric_call = numeric_builtin_call(expr);

    if (
      numeric_call && expr.func.tag === "var" &&
      !env.bindings.has(expr.func.name)
    ) {
      const before = diagnostics.length;

      for (const arg of numeric_call.args) {
        validate_expr(arg, env, diagnostics, check_comptime);
      }

      if (diagnostics.length === before) {
        validate_numeric_builtin_call(expr, numeric_call, env, diagnostics);
      }

      return;
    }

    const before = diagnostics.length;
    validate_expr(expr.func, env, diagnostics, check_comptime);

    for (const arg of expr.args) {
      validate_expr(arg, env, diagnostics, check_comptime);
    }

    if (diagnostics.length === before) {
      validate_union_constructor(expr, env, diagnostics);
      validate_call_arguments(expr, env, diagnostics, check_comptime);

      if (expr.func.tag === "var" && expr.func.name === "@Bytes.generate") {
        validate_bytes_generate_call(expr, env, diagnostics);
      }

      validate_runtime_buffer_builtin_call(expr, env, diagnostics);

      if (expr.func.tag === "var" && expr.func.name === "@append") {
        validate_append_buffer_call(expr, env, diagnostics);
      }

      if (expr.func.tag === "var" && expr.func.name === "@get") {
        const index = expr.args[1];

        if (index !== undefined) {
          validate_numeric_boundary(index, "get index", env, diagnostics);
        }
      }

      if (expr.func.tag === "var" && expr.func.name === "@slice") {
        const start = expr.args[1];
        const end = expr.args[2];

        if (start !== undefined) {
          validate_numeric_boundary(start, "slice start", env, diagnostics);
        }

        if (end !== undefined) {
          validate_numeric_boundary(end, "slice end", env, diagnostics);
        }
      }
    }

    validate_comptime_fail(expr, diagnostics);
    return;
  }

  if (expr.tag === "block") {
    validate_statements(expr.statements, child_env(env), diagnostics);
    return;
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const body = child_env(env);
    bind_params(body, expr.params);

    if (expr.tag === "rec") {
      bind_rec_target(body, expr, undefined);
    }

    validate_expr(expr.body, body, diagnostics, check_comptime, true);
    return;
  }

  if (expr.tag === "comptime") {
    if (check_comptime) {
      try {
        validate_const_expr(
          expr.expr,
          env.const_env,
          new Set(),
          "Comptime expression captures runtime value",
        );
      } catch (error) {
        if (error instanceof Error) {
          diagnostics.push(
            source_diagnostic("DUCK2101", error.message, expr),
          );
        } else {
          throw error;
        }
      }
    }

    validate_expr(expr.expr, env, diagnostics, false);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    validate_expr(expr.value, env, diagnostics, check_comptime);
    return;
  }

  if (expr.tag === "scratch") {
    validate_expr(expr.body, env, diagnostics, check_comptime);
    return;
  }

  if (expr.tag === "loop") {
    validate_statements(expr.body, child_env(env), diagnostics);
    validate_loop_break_types(expr.body, env, diagnostics);
    return;
  }

  if (expr.tag === "captured") {
    validate_expr(expr.expr, env, diagnostics, check_comptime);
    return;
  }

  if (expr.tag === "handler") {
    const handler_env = child_env(env);
    const effect = env.effects.get(expr.effect);

    for (const state of expr.state) {
      mark_annotation_text_use(state.annotation, handler_env);
      validate_expr(
        state.value,
        handler_env,
        diagnostics,
        check_comptime,
      );
      const value_type = infer_type(state.value, handler_env);
      let state_type = value_type;

      if (state.annotation !== undefined) {
        state_type = resolve_type_name(state.annotation, handler_env);

        const representation_diagnostic = value_representation_diagnostic(
          "DUCK2306",
          "Handler state " + state.name + " expects " +
            type_name(state_type) + ", got " + type_name(value_type),
          state.value,
          state_type,
          state.value,
          handler_env,
        );

        if (representation_diagnostic) {
          diagnostics.push(representation_diagnostic);
        }
      }

      bind_local(
        handler_env,
        state.name,
        state_type,
        undefined,
        false,
        false,
      );
    }

    for (const clause of expr.clauses) {
      const clause_env = child_env(handler_env);
      let operation: EffectDeclaration["operations"][number] | undefined;

      if (effect !== undefined) {
        operation = effect.operations.find((candidate) =>
          candidate.name === clause.name
        );
      }

      for (let index = 0; index < clause.params.length; index += 1) {
        const param = clause.params[index];

        if (param === undefined) {
          continue;
        }

        mark_annotation_use(
          param.annotation,
          param.type_annotation,
          clause_env,
        );
        let type: FrontType = { tag: "unknown" };

        if (operation !== undefined && index < operation.params.length) {
          const declared = operation.params[index];

          if (declared !== undefined) {
            type = resolve_type_name(declared.type_name, clause_env);
          }
        } else if (
          operation !== undefined && index === operation.params.length
        ) {
          type = resolve_type_name("Resume", clause_env);
        } else if (param.annotation !== undefined) {
          type = resolve_type_name(param.annotation, clause_env);
        } else if (param.type_annotation !== undefined) {
          type = type_from_type_expr(param.type_annotation, clause_env);
        }

        const binding = bind_local(
          clause_env,
          param.name,
          type,
          param.type_annotation,
          param.is_const,
          param.is_linear,
        );

        if (
          operation !== undefined && index === operation.params.length
        ) {
          binding.resume_input_type = resolve_type_name(
            operation.result.type_name,
            clause_env,
          );
        }
      }

      validate_expr(
        clause.body,
        clause_env,
        diagnostics,
        check_comptime,
      );
    }

    const return_env = child_env(handler_env);
    bind_params(return_env, [expr.return_clause.param]);
    validate_expr(
      expr.return_clause.body,
      return_env,
      diagnostics,
      check_comptime,
    );
    return;
  }

  if (expr.tag === "try_with") {
    validate_expr(expr.body, env, diagnostics, check_comptime);
    validate_expr(expr.handler, env, diagnostics, check_comptime);

    const handler = resolve_handler_expr(expr.handler, env);

    if (handler !== undefined) {
      const input_type = infer_type(expr.body, env);
      const param = handler.target.return_clause.param;
      let annotated_type: FrontType = { tag: "unknown" };

      if (param.annotation !== undefined) {
        annotated_type = resolve_type_name(
          param.annotation,
          handler.target_env,
        );
      } else if (param.type_annotation !== undefined) {
        annotated_type = type_from_type_expr(
          param.type_annotation,
          handler.target_env,
        );
      }

      if (
        bool_representation_mismatch(
          annotated_type,
          input_type,
          handler.target_env,
          env,
        )
      ) {
        diagnostics.push(bool_route_diagnostic(
          "DUCK2306",
          "Handler return parameter " + param.name + " expects " +
            type_name(annotated_type) + ", got " + type_name(input_type),
          expr.body,
        ));
        return;
      }

      if (
        param.annotation !== undefined ||
        param.type_annotation !== undefined
      ) {
        return;
      }

      const return_env = handler_return_env(
        handler.target,
        input_type,
        handler.target_env,
      );
      validate_expr(
        handler.target.return_clause.body,
        return_env,
        diagnostics,
        check_comptime,
      );
    }

    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    validate_expr(expr.base, env, diagnostics, check_comptime);

    for (const field of expr.fields) {
      validate_expr(field.value, env, diagnostics, check_comptime);
    }

    const base_type = infer_type(expr.base, env);

    if (base_type.tag === "struct" && base_type.field_types) {
      validate_struct_field_values(
        expr.fields,
        base_type.field_types,
        env,
        diagnostics,
      );
    }

    return;
  }

  if (expr.tag === "type_with") {
    validate_expr(expr.base, env, diagnostics, check_comptime);

    for (const member of expr.members) {
      validate_expr(member.name, env, diagnostics, check_comptime);
      validate_expr(member.value, env, diagnostics, check_comptime);
    }

    return;
  }

  if (expr.tag === "struct_value") {
    validate_expr(expr.type_expr, env, diagnostics, check_comptime);

    for (const field of expr.fields) {
      validate_expr(field.value, env, diagnostics, check_comptime);
    }

    return;
  }

  if (expr.tag === "product") {
    if (expr.value_pack === true && !accepts_value_pack) {
      diagnostics.push(source_diagnostic(
        "DUCK2307",
        "Value packs may only be passed, returned, or destructured immediately; use `[...]` to store a tuple",
        expr,
      ));
    }

    for (const entry of expr.entries) {
      validate_expr(entry.value, env, diagnostics, check_comptime);
    }

    return;
  }

  if (expr.tag === "set_type") {
    mark_type_expr_uses(expr.type_expr, env);
    return;
  }

  if (expr.tag === "struct_type") {
    mark_type_field_uses(expr.fields, env);
    return;
  }

  if (expr.tag === "union_type") {
    mark_type_field_uses(expr.cases, env);
    return;
  }

  if (expr.tag === "index") {
    const before = diagnostics.length;
    validate_expr(expr.object, env, diagnostics, check_comptime);
    validate_expr(expr.index, env, diagnostics, check_comptime);

    if (diagnostics.length !== before) {
      return;
    }

    validate_numeric_boundary(expr.index, "Index", env, diagnostics);

    if (diagnostics.length !== before) {
      return;
    }

    try {
      infer_type(expr, env);
    } catch (error) {
      if (error instanceof Error) {
        const object_type = infer_type(expr.object, env);

        if (
          object_type.tag === "struct" && object_type.field_types &&
          struct_fields_include_bool(object_type.field_types, env)
        ) {
          diagnostics.push(bool_route_diagnostic(
            "DUCK2304",
            error.message,
            expr,
          ));
        } else {
          diagnostics.push(source_diagnostic(
            "DUCK2304",
            error.message,
            expr,
          ));
        }

        return;
      }

      throw error;
    }

    return;
  }

  if (expr.tag === "is") {
    validate_expr(expr.value, env, diagnostics, check_comptime);
    mark_type_expr_uses(expr.type_expr, env);
    return;
  }

  if (expr.tag === "union_case") {
    if (expr.type_expr !== undefined) {
      validate_expr(expr.type_expr, env, diagnostics, check_comptime);
    }

    if (expr.value !== undefined) {
      validate_expr(expr.value, env, diagnostics, check_comptime);
    }

    let cases: TypeField[] | undefined;

    if (expr.type_expr !== undefined) {
      cases = union_constructor_cases(expr.type_expr, env);
    } else {
      cases = unqualified_union_cases(expr.name, env);
    }

    if (cases === undefined || expr.value === undefined) {
      return;
    }

    const declared = lookup_type_field(cases, expr.name);

    if (declared === undefined || declared.type_name === "Unit") {
      return;
    }

    try {
      validate_union_payload_type(
        expr.name,
        declared.type_name,
        expr.value,
        create_env(),
        { infer_expr: (value) => infer_type(value, env) },
      );
    } catch (error) {
      if (error instanceof Error) {
        const expected = resolve_type_name(declared.type_name, env);
        const actual = infer_type(expr.value, env);

        const representation_diagnostic = value_representation_diagnostic(
          "DUCK2305",
          "Union case " + expr.name + " expects " + type_name(expected) +
            ", got " + type_name(actual),
          expr,
          expected,
          expr.value,
          env,
        );

        if (representation_diagnostic) {
          diagnostics.push(representation_diagnostic);
        } else {
          diagnostics.push(
            source_diagnostic("DUCK2305", error.message, expr),
          );
        }

        return;
      }

      throw error;
    }

    const expected = resolve_type_name(declared.type_name, env);
    const actual = infer_type(expr.value, env);

    const representation_diagnostic = value_representation_diagnostic(
      "DUCK2305",
      "Union case " + expr.name + " expects " + type_name(expected) +
        ", got " + type_name(actual),
      expr,
      expected,
      expr.value,
      env,
    );

    if (representation_diagnostic) {
      diagnostics.push(representation_diagnostic);
    }
  }
}

function validate_bytes_generate_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.args.length !== 2) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate expects 2 arguments, got " + expr.args.length.toString(),
      expr,
    ));
    return;
  }

  const length = expr.args[0];
  const generator = expr.args[1];
  expect(length, "Missing Bytes.generate length");
  expect(generator, "Missing Bytes.generate callback");
  const length_type = infer_type(length, env);

  if (
    length_type.tag !== "unknown" &&
    (length_type.tag !== "int" || length_type.type !== "i32")
  ) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate length expects I32, got " + type_name(length_type),
      length,
    ));
  }

  const callable = resolve_called_function(generator, env);

  if (callable === undefined) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate callback must be a function",
      generator,
    ));
    return;
  }

  if (callable_parameter_count(callable) !== 1) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate callback expects 1 I32 parameter",
      generator,
    ));
    return;
  }

  const parameter_type = callable_parameter_type(callable, 0);

  if (
    parameter_type.tag !== "unknown" &&
    (parameter_type.tag !== "int" || parameter_type.type !== "i32")
  ) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate callback parameter expects I32, got " +
        type_name(parameter_type),
      generator,
    ));
  }

  const result_type = callable_result_type(callable, new Set());

  if (
    result_type.tag !== "unknown" &&
    (result_type.tag !== "int" || result_type.type !== "i32")
  ) {
    diagnostics.push(source_diagnostic(
      "DUCK2307",
      "Bytes.generate callback result expects I32, got " +
        type_name(result_type),
      generator,
    ));
  }
}

function validate_runtime_buffer_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.func.tag !== "var") {
    return;
  }

  const name = expr.func.name;

  if (
    name !== "@Utf8.encode" && name !== "@Utf8.decode" &&
    name !== "@format_i32" && name !== "@format_i64" &&
    name !== "@format_f32"
  ) {
    return;
  }

  let expected_args = 1;

  if (name === "@format_f32") {
    expected_args = 2;
  }

  if (expr.args.length !== expected_args) {
    diagnostics.push(core_route_diagnostic(
      "DUCK2307",
      name + " expects " + expected_args.toString() + " arguments, got " +
        expr.args.length.toString(),
      expr,
    ));
    return;
  }

  const arg = expr.args[0];
  expect(arg, "Missing " + name + " argument");
  const actual = infer_type(arg, env);
  let expected: FrontType;

  if (name === "@Utf8.encode") {
    expected = { tag: "text" };
  } else if (name === "@Utf8.decode") {
    expected = { tag: "text", encoding: "bytes" };
  } else if (name === "@format_i64") {
    expected = { tag: "int", type: "i64" };
  } else if (name === "@format_f32") {
    expected = { tag: "int", type: "f32" };
  } else {
    expected = { tag: "int", type: "i32" };
  }

  if (actual.tag !== "unknown" && !same_type(expected, actual)) {
    diagnostics.push(core_route_diagnostic(
      "DUCK2307",
      name + " expects " + type_name(expected) + ", got " + type_name(actual),
      arg,
    ));
  }

  if (name !== "@format_f32") {
    return;
  }

  const precision = expr.args[1];
  expect(precision, "Missing format_f32 precision argument");
  const precision_type = infer_type(precision, env);

  if (
    precision_type.tag === "unknown" ||
    same_type({ tag: "int", type: "i32" }, precision_type)
  ) {
    return;
  }

  diagnostics.push(core_route_diagnostic(
    "DUCK2307",
    "format_f32 precision expects I32, got " + type_name(precision_type),
    precision,
  ));
}

function validate_append_buffer_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.args.length !== 2) {
    return;
  }

  const left = expr.args[0];
  const right = expr.args[1];
  expect(left, "Missing append left argument");
  expect(right, "Missing append right argument");
  const left_type = infer_type(left, env);
  const right_type = infer_type(right, env);

  if (
    left_type.tag !== "text" || right_type.tag !== "text" ||
    left_type.encoding === right_type.encoding
  ) {
    return;
  }

  diagnostics.push(core_route_diagnostic(
    "DUCK2307",
    "append arguments must both be Text or both be Bytes",
    expr,
  ));
}

function validate_union_constructor(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.func.tag !== "field") {
    return;
  }

  const cases = union_constructor_cases(expr.func.object, env);

  if (cases === undefined) {
    return;
  }

  const declared = lookup_type_field(cases, expr.func.name);

  if (!declared) {
    return;
  }

  let payload = expr.args[0];

  if (expr.arg !== undefined && expr.arg.tag !== "unit") {
    payload = expr.arg;
  }

  if (!payload) {
    return;
  }

  try {
    validate_union_payload_type(
      expr.func.name,
      declared.type_name,
      payload,
      create_env(),
      { infer_expr: (value) => infer_type(value, env) },
    );
  } catch (error) {
    if (error instanceof Error) {
      const expected = resolve_type_name(declared.type_name, env);
      const actual = infer_type(payload, env);

      const representation_diagnostic = value_representation_diagnostic(
        "DUCK2305",
        "Union case " + expr.func.name + " expects " +
          type_name(expected) + ", got " + type_name(actual),
        expr,
        expected,
        payload,
        env,
      );

      if (representation_diagnostic) {
        diagnostics.push(representation_diagnostic);
      } else {
        diagnostics.push(
          source_diagnostic("DUCK2305", error.message, expr),
        );
      }

      return;
    }

    throw error;
  }

  const expected = resolve_type_name(declared.type_name, env);
  const actual = infer_type(payload, env);

  const representation_diagnostic = value_representation_diagnostic(
    "DUCK2305",
    "Union case " + expr.func.name + " expects " + type_name(expected) +
      ", got " + type_name(actual),
    expr,
    expected,
    payload,
    env,
  );

  if (representation_diagnostic) {
    diagnostics.push(representation_diagnostic);
  }
}

function union_constructor_cases(
  type_expr: FrontExpr,
  env: SemanticEnv,
): TypeField[] | undefined {
  if (type_expr.tag !== "var" && type_expr.tag !== "linear") {
    return undefined;
  }

  const type = resolve_type_name(type_expr.name, env);

  if (type.tag !== "union_value") {
    return undefined;
  }

  return type.cases;
}

function unqualified_union_cases(
  case_name: string,
  env: SemanticEnv,
): TypeField[] | undefined {
  let matched: TypeField[] | undefined;

  for (const declaration of env.declarations.values()) {
    if (declaration.params.length !== 0) {
      continue;
    }

    const type = resolve_type_name(declaration.name, env);

    if (
      type.tag !== "union_value" ||
      lookup_type_field(type.cases, case_name) === undefined
    ) {
      continue;
    }

    if (matched !== undefined) {
      return undefined;
    }

    matched = type.cases;
  }

  return matched;
}

function validate_call_arguments(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
  check_comptime: boolean,
): void {
  if (expr.func.tag === "var" || expr.func.tag === "linear") {
    const binding = env.bindings.get(expr.func.name);

    if (binding !== undefined && binding.resume_input_type !== undefined) {
      const arg = expr.args[0];

      if (arg !== undefined) {
        const representation_diagnostic = value_representation_diagnostic(
          "DUCK2307",
          "Resumption " + expr.func.name + " expects " +
            type_name(binding.resume_input_type) + ", got " +
            type_name(infer_type(arg, env)),
          arg,
          binding.resume_input_type,
          arg,
          env,
        );

        if (representation_diagnostic) {
          diagnostics.push(representation_diagnostic);
        }
      }

      return;
    }
  }

  if (expr.func.tag === "field" && expr.func.object.tag === "var") {
    const effect = env.effects.get(expr.func.object.name);

    if (effect !== undefined) {
      const operation_name = expr.func.name;
      const operation = effect.operations.find((candidate) =>
        candidate.name === operation_name
      );

      if (operation === undefined) {
        return;
      }

      for (
        let index = 0;
        index < operation.params.length && index < expr.args.length;
        index += 1
      ) {
        const param = operation.params[index];
        const arg = expr.args[index];

        if (param === undefined || arg === undefined) {
          continue;
        }

        const expected = resolve_type_name(param.type_name, env);
        const actual = infer_type(arg, env);

        const representation_diagnostic = value_representation_diagnostic(
          "DUCK2307",
          "Call to " + effect.name + "." + operation.name + " argument " +
            (index + 1).toString() + " expects " + type_name(expected) +
            ", got " + type_name(actual),
          arg,
          expected,
          arg,
          env,
        );

        if (representation_diagnostic) {
          diagnostics.push(representation_diagnostic);
        }
      }

      return;
    }
  }

  const callable = resolve_called_function(expr.func, env);

  if (callable === undefined) {
    return;
  }

  if (
    callable.target?.pattern?.tag === "product" &&
    callable.target.pattern.entries.length > 0
  ) {
    const expects_pack = callable.target.pattern.value_pack === true;
    const received_pack = expr.arg?.tag === "product" &&
      expr.arg.value_pack === true;

    if (expects_pack !== received_pack) {
      let expected_syntax = "a tuple argument written `f([a, b])`";

      if (expects_pack) {
        expected_syntax = "an argument pack written `f(a, b)`";
      }

      diagnostics.push(source_diagnostic(
        "DUCK2307",
        "Call requires " + expected_syntax,
        expr,
      ));
      return;
    }
  }

  let target_name = "anonymous function";

  if (expr.func.tag === "var" || expr.func.tag === "linear") {
    target_name = expr.func.name;
  }

  const contextual_params = arrow_parameter_types(
    callable.type_annotation,
    callable.target_env,
  );
  let parameter_count = contextual_params.length;

  if (
    callable.target !== undefined &&
    callable.target.params.length > parameter_count
  ) {
    parameter_count = callable.target.params.length;
  }

  for (
    let index = 0;
    index < parameter_count && index < expr.args.length;
    index += 1
  ) {
    let param: Param | undefined;

    if (callable.target !== undefined) {
      param = callable.target.params[index];
    }

    const arg = expr.args[index];

    if (arg === undefined) {
      continue;
    }

    const contextual_type = contextual_params[index];

    if (contextual_type !== undefined && contextual_type.tag === "arrow") {
      validate_callable_argument(
        target_name,
        index,
        param,
        contextual_type,
        arg,
        env,
        diagnostics,
        check_comptime,
      );
      continue;
    }

    let expected: FrontType = { tag: "unknown" };

    if (contextual_type !== undefined) {
      expected = type_from_type_expr(contextual_type, env);
    } else if (param !== undefined && param.annotation !== undefined) {
      expected = resolve_type_name(param.annotation, env);
    } else if (param !== undefined && param.type_annotation !== undefined) {
      expected = type_from_type_expr(param.type_annotation, env);
    }

    const actual = infer_type(arg, env);

    const message_prefix = "Call to " + target_name + " argument " +
      (index + 1).toString();
    let parameter_label = "";

    if (param !== undefined) {
      parameter_label = " for parameter " + param.name;
    }

    const representation_diagnostic = value_representation_diagnostic(
      "DUCK2307",
      message_prefix + parameter_label + " expects " + type_name(expected) +
        ", got " + type_name(actual),
      arg,
      expected,
      arg,
      env,
    );

    if (representation_diagnostic) {
      diagnostics.push(representation_diagnostic);
    }
  }

  let requires_specialization = false;

  if (callable.target === undefined) {
    return;
  }

  for (let index = 0; index < callable.target.params.length; index += 1) {
    const param = callable.target.params[index];

    if (param === undefined) {
      continue;
    }

    if (
      contextual_params[index] === undefined &&
      param.annotation === undefined && param.type_annotation === undefined
    ) {
      requires_specialization = true;
      break;
    }
  }

  if (
    !requires_specialization ||
    env.active_specialized_calls.has(callable.target)
  ) {
    return;
  }

  const body_env = callable_body_env(callable, expr.args, env, new Set());
  env.active_specialized_calls.add(callable.target);
  validate_expr(
    callable.target.body,
    body_env,
    diagnostics,
    check_comptime,
    true,
  );
  env.active_specialized_calls.delete(callable.target);
}

function validate_callable_argument(
  target_name: string,
  index: number,
  param: Param | undefined,
  expected: Extract<TypeExpr, { tag: "arrow" }>,
  arg: FrontExpr,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
  check_comptime: boolean,
): void {
  const actual = resolve_called_function(arg, env);

  if (actual === undefined) {
    return;
  }

  const expected_params = arrow_parameter_types(expected, env);
  const actual_param_count = callable_parameter_count(actual);
  let mismatches = expected_params.length !== actual_param_count;
  let has_bool_mismatch = false;

  for (
    let param_index = 0;
    !mismatches && param_index < expected_params.length;
    param_index += 1
  ) {
    const expected_param = type_from_type_expr(
      expected_params[param_index],
      env,
    );
    const actual_param = callable_parameter_type(actual, param_index);

    if (
      bool_representation_mismatch(
        expected_param,
        actual_param,
        env,
        actual.target_env,
      )
    ) {
      mismatches = true;
      has_bool_mismatch = true;
    }
  }

  if (mismatches) {
    let parameter_label = "";

    if (param !== undefined) {
      parameter_label = " for parameter " + param.name;
    }

    const message = "Call to " + target_name + " argument " +
      (index + 1).toString() + parameter_label + " expects " +
      format_type_expr(expected) + ", got " + callable_type_name(actual);

    if (has_bool_mismatch) {
      diagnostics.push(bool_route_diagnostic("DUCK2307", message, arg));
    } else {
      diagnostics.push(source_diagnostic(
        "DUCK2307",
        message,
        arg,
      ));
    }

    return;
  }

  if (actual.target !== undefined) {
    const before = diagnostics.length;
    validate_annotated_lambda(
      actual.target,
      expected,
      actual.target_env,
      diagnostics,
      check_comptime,
    );

    if (diagnostics.length !== before) {
      return;
    }
  }

  const expected_result = type_from_type_expr(expected.result, env);
  const actual_result = callable_result_type(actual, new Set());

  if (
    !bool_representation_mismatch(
      expected_result,
      actual_result,
      env,
      actual.target_env,
    )
  ) {
    return;
  }

  let parameter_label = "";

  if (param !== undefined) {
    parameter_label = " for parameter " + param.name;
  }

  diagnostics.push(bool_route_diagnostic(
    "DUCK2307",
    "Call to " + target_name + " argument " + (index + 1).toString() +
      parameter_label + " expects " + format_type_expr(expected) +
      ", got " + callable_type_name(actual),
    arg,
  ));
}

function callable_parameter_count(callable: SemanticCallable): number {
  let count = arrow_parameter_types(
    callable.type_annotation,
    callable.target_env,
  ).length;

  if (callable.target !== undefined && callable.target.params.length > count) {
    count = callable.target.params.length;
  }

  return count;
}

function callable_parameter_type(
  callable: SemanticCallable,
  index: number,
): FrontType {
  const contextual = arrow_parameter_types(
    callable.type_annotation,
    callable.target_env,
  )[index];

  if (contextual !== undefined) {
    return type_from_type_expr(contextual, callable.target_env);
  }

  if (callable.target === undefined) {
    return { tag: "unknown" };
  }

  const param = callable.target.params[index];

  if (param === undefined) {
    return { tag: "unknown" };
  }

  if (param.annotation !== undefined) {
    return resolve_type_name(param.annotation, callable.target_env);
  }

  return type_from_type_expr(param.type_annotation, callable.target_env);
}

function callable_result_type(
  callable: SemanticCallable,
  active_calls: Set<FrontExpr>,
): FrontType {
  if (callable.type_annotation !== undefined) {
    const annotated = type_from_type_expr(
      callable.type_annotation.result,
      callable.target_env,
    );

    if (annotated.tag !== "unknown") {
      return annotated;
    }
  }

  if (
    callable.target === undefined || active_calls.has(callable.target)
  ) {
    return { tag: "unknown" };
  }

  const body_env = callable_body_env(
    callable,
    [],
    callable.target_env,
    active_calls,
  );
  active_calls.add(callable.target);
  const result = infer_type(callable.target.body, body_env, active_calls);
  active_calls.delete(callable.target);
  return result;
}

function callable_type_name(callable: SemanticCallable): string {
  if (callable.type_annotation !== undefined) {
    return format_type_expr(callable.type_annotation);
  }

  const parameter_names: string[] = [];

  for (let index = 0; index < callable_parameter_count(callable); index += 1) {
    parameter_names.push(type_name(callable_parameter_type(callable, index)));
  }

  let params = parameter_names.join(", ");

  if (parameter_names.length !== 1) {
    params = "(" + params + ")";
  }

  return params + " -> " + type_name(callable_result_type(
    callable,
    new Set(),
  ));
}

function same_callable_type(
  left: SemanticCallable,
  right: SemanticCallable,
  active_calls: Set<FrontExpr>,
): boolean {
  const parameter_count = callable_parameter_count(left);

  if (parameter_count !== callable_parameter_count(right)) {
    return false;
  }

  for (let index = 0; index < parameter_count; index += 1) {
    const left_type = callable_parameter_type(left, index);
    const right_type = callable_parameter_type(right, index);

    if (
      bool_representation_mismatch(
        left_type,
        right_type,
        left.target_env,
        right.target_env,
      ) || text_encoding_mismatch(left_type, right_type)
    ) {
      return false;
    }
  }

  const left_result = callable_result_type(left, active_calls);
  const right_result = callable_result_type(right, active_calls);
  if (
    bool_representation_mismatch(
      left_result,
      right_result,
      left.target_env,
      right.target_env,
    )
  ) {
    return false;
  }

  return !text_encoding_mismatch(left_result, right_result);
}

function validate_struct_field_values(
  values: Field[],
  declared_fields: TypeField[],
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  for (const value of values) {
    const declared = lookup_type_field(declared_fields, value.name);

    if (declared === undefined) {
      continue;
    }

    const expected = resolve_type_name(declared.type_name, env);
    const actual = infer_type(value.value, env);

    const representation_diagnostic = value_representation_diagnostic(
      "DUCK2306",
      "Struct field " + value.name + " expects " + type_name(expected) +
        ", got " + type_name(actual),
      value.value,
      expected,
      value.value,
      env,
    );

    if (representation_diagnostic) {
      diagnostics.push(representation_diagnostic);
    }
  }
}

function union_case_payload_type(
  target: FrontExpr,
  case_name: string,
  env: SemanticEnv,
): FrontType {
  const target_type = infer_type(target, env);

  if (target_type.tag !== "union_value") {
    return { tag: "unknown" };
  }

  const matched = lookup_type_field(target_type.cases, case_name);

  if (matched === undefined || matched.type_name === "Unit") {
    return { tag: "unknown" };
  }

  return resolve_type_name(matched.type_name, env);
}

function validate_branch_types(
  expr: Extract<FrontExpr, { tag: "if" | "if_let" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.implicit_else === true) {
    return;
  }

  let then_env = env;

  if (expr.tag === "if_let" && expr.value_name !== undefined) {
    then_env = child_env(env);
    bind_local(
      then_env,
      expr.value_name,
      union_case_payload_type(expr.target, expr.case_name, env),
      undefined,
      false,
      false,
    );
  }

  const then_callable = resolve_called_function(expr.then_branch, then_env);
  const else_callable = resolve_called_function(expr.else_branch, env);

  if (then_callable !== undefined && else_callable !== undefined) {
    const parameter_count = callable_parameter_count(then_callable);

    if (parameter_count !== callable_parameter_count(else_callable)) {
      diagnostics.push(source_diagnostic(
        "DUCK2306",
        "Conditional function branches have incompatible parameter counts " +
          parameter_count.toString() + " and " +
          callable_parameter_count(else_callable).toString(),
        expr,
      ));
      return;
    }

    for (let index = 0; index < parameter_count; index += 1) {
      const then_param = callable_parameter_type(then_callable, index);
      const else_param = callable_parameter_type(else_callable, index);

      const bool_mismatch = bool_representation_mismatch(
        then_param,
        else_param,
        then_callable.target_env,
        else_callable.target_env,
      );
      const text_mismatch = text_encoding_mismatch(then_param, else_param);

      if (!bool_mismatch && !text_mismatch) {
        continue;
      }

      const message = "Conditional function branches have incompatible " +
        "parameter " + (index + 1).toString() + " types " +
        type_name(then_param) + " and " + type_name(else_param);

      if (bool_mismatch) {
        diagnostics.push(bool_route_diagnostic("DUCK2306", message, expr));
      } else {
        diagnostics.push(core_route_diagnostic("DUCK2306", message, expr));
      }

      return;
    }

    const then_result = callable_result_type(then_callable, new Set());
    const else_result = callable_result_type(else_callable, new Set());

    const bool_mismatch = bool_representation_mismatch(
      then_result,
      else_result,
      then_callable.target_env,
      else_callable.target_env,
    );
    const text_mismatch = text_encoding_mismatch(then_result, else_result);

    if (bool_mismatch || text_mismatch) {
      const message =
        "Conditional function branches have incompatible result types " +
        type_name(then_result) + " and " + type_name(else_result);

      if (bool_mismatch) {
        diagnostics.push(bool_route_diagnostic("DUCK2306", message, expr));
      } else {
        diagnostics.push(core_route_diagnostic("DUCK2306", message, expr));
      }

      return;
    }
  }

  const then_type = infer_type(expr.then_branch, then_env);
  const else_type = infer_type(expr.else_branch, env);

  const message = "Conditional branches have incompatible types " +
    type_name(then_type) + " and " + type_name(else_type);
  const representation_diagnostic = value_representation_diagnostic(
    "DUCK2306",
    message,
    expr,
    then_type,
    expr.else_branch,
    env,
  );

  if (!representation_diagnostic) {
    return;
  }

  diagnostics.push(representation_diagnostic);
}

function validate_numeric_boundary(
  expr: FrontExpr,
  label: string,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  if (infer_type(expr, env).tag !== "bool") {
    return;
  }

  diagnostics.push(bool_route_diagnostic(
    "DUCK2302",
    label + " expects numeric value, got Bool",
    expr,
  ));
}

function bool_representation_mismatch(
  expected: FrontType,
  actual: FrontType,
  expected_env: SemanticEnv,
  actual_env: SemanticEnv = expected_env,
  visited_type_pairs: Set<string> = new Set(),
): boolean {
  if (expected.tag === "unknown" || actual.tag === "unknown") {
    return false;
  }

  if (expected.tag === "bool" || actual.tag === "bool") {
    return expected.tag !== actual.tag;
  }

  if (
    expected.tag === "struct" && actual.tag === "struct" &&
    expected.field_types !== undefined && actual.field_types !== undefined
  ) {
    for (const expected_field of expected.field_types) {
      const actual_field = lookup_type_field(
        actual.field_types,
        expected_field.name,
      );

      if (actual_field === undefined) {
        continue;
      }

      const type_pair = expected_field.type_name + "\u0000" +
        actual_field.type_name;

      if (visited_type_pairs.has(type_pair)) {
        continue;
      }

      visited_type_pairs.add(type_pair);

      if (
        bool_representation_mismatch(
          resolve_type_name(expected_field.type_name, expected_env),
          resolve_type_name(actual_field.type_name, actual_env),
          expected_env,
          actual_env,
          visited_type_pairs,
        )
      ) {
        return true;
      }

      visited_type_pairs.delete(type_pair);
    }

    return false;
  }

  if (expected.tag === "union_value" && actual.tag === "union_value") {
    for (const expected_case of expected.cases) {
      const actual_case = lookup_type_field(actual.cases, expected_case.name);

      if (actual_case === undefined) {
        continue;
      }

      const type_pair = expected_case.type_name + "\u0000" +
        actual_case.type_name;

      if (visited_type_pairs.has(type_pair)) {
        continue;
      }

      visited_type_pairs.add(type_pair);

      if (
        bool_representation_mismatch(
          resolve_type_name(expected_case.type_name, expected_env),
          resolve_type_name(actual_case.type_name, actual_env),
          expected_env,
          actual_env,
          visited_type_pairs,
        )
      ) {
        return true;
      }

      visited_type_pairs.delete(type_pair);
    }
  }

  return false;
}

function bool_value_representation_mismatch(
  expected: FrontType,
  value: FrontExpr,
  env: SemanticEnv,
  visited_bindings: Set<SemanticBinding> = new Set(),
): boolean {
  const actual = infer_type(value, env);

  if (bool_representation_mismatch(expected, actual, env)) {
    return true;
  }

  if (value.tag === "captured" || value.tag === "comptime") {
    return bool_value_representation_mismatch(
      expected,
      value.expr,
      env,
      visited_bindings,
    );
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return bool_value_representation_mismatch(
      expected,
      value.value,
      env,
      visited_bindings,
    );
  }

  if (value.tag === "scratch") {
    return bool_value_representation_mismatch(
      expected,
      value.body,
      env,
      visited_bindings,
    );
  }

  if (value.tag === "block") {
    const result = semantic_block_result(value, env, new Set());

    if (result === undefined) {
      return false;
    }

    return bool_value_representation_mismatch(
      expected,
      result.expr,
      result.env,
      visited_bindings,
    );
  }

  if (value.tag === "var" || value.tag === "linear") {
    const binding = env.bindings.get(value.name);

    if (
      binding === undefined || binding.value === undefined ||
      visited_bindings.has(binding)
    ) {
      return false;
    }

    visited_bindings.add(binding);
    let value_env = env;

    if (binding.value_env !== undefined) {
      value_env = binding.value_env;
    }

    const mismatch = bool_value_representation_mismatch(
      expected,
      binding.value,
      value_env,
      visited_bindings,
    );
    visited_bindings.delete(binding);
    return mismatch;
  }

  if (
    expected.tag === "struct" && expected.field_types !== undefined &&
    (value.tag === "struct_value" || value.tag === "product")
  ) {
    let fields: Field[];

    if (value.tag === "struct_value") {
      fields = value.fields;
    } else {
      fields = elaborate_product_expr(value).fields;
    }

    for (const expected_field of expected.field_types) {
      const actual_field = find_field(fields, expected_field.name);

      if (actual_field === undefined) {
        continue;
      }

      if (
        bool_value_representation_mismatch(
          resolve_type_name(expected_field.type_name, env),
          actual_field.value,
          env,
          visited_bindings,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  if (expected.tag !== "union_value") {
    return false;
  }

  if (value.tag === "union_case" && value.value !== undefined) {
    const expected_case = lookup_type_field(expected.cases, value.name);

    if (expected_case === undefined) {
      return false;
    }

    return bool_value_representation_mismatch(
      resolve_type_name(expected_case.type_name, env),
      value.value,
      env,
      visited_bindings,
    );
  }

  if (
    value.tag === "app" && value.func.tag === "field" &&
    value.args[0] !== undefined
  ) {
    const expected_case = lookup_type_field(
      expected.cases,
      value.func.name,
    );

    if (expected_case === undefined) {
      return false;
    }

    return bool_value_representation_mismatch(
      resolve_type_name(expected_case.type_name, env),
      value.args[0],
      env,
      visited_bindings,
    );
  }

  return false;
}

function struct_fields_include_bool(
  fields: TypeField[],
  env: SemanticEnv,
): boolean {
  for (const field of fields) {
    if (resolve_type_name(field.type_name, env).tag === "bool") {
      return true;
    }
  }

  return false;
}

function validate_comptime_fail(
  expr: Extract<FrontExpr, { tag: "app" }>,
  diagnostics: SourceDiagnostic[],
): void {
  if (expr.func.tag !== "var" || expr.func.name !== "@fail") {
    return;
  }

  diagnostics.push(source_diagnostic(
    "DUCK2102",
    "@fail: " + call_message(expr.args),
    expr,
  ));
}

function validate_numeric_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  call: NonNullable<ReturnType<typeof numeric_builtin_call>>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  const expected = Callable.arity(Prim, call.prim);

  if (call.args.length !== expected) {
    expect(expr.func.tag === "var", "Numeric builtin requires a name");
    diagnostics.push(source_diagnostic(
      "DUCK2302",
      expr.func.name + " expects " + expected + " arguments, got " +
        call.args.length,
      expr,
    ));
    return;
  }

  try {
    let prim = call.prim;

    if (expected === 2) {
      const left = call.args[0];
      const right = call.args[1];
      expect(left, "Missing numeric builtin argument 0");
      expect(right, "Missing numeric builtin argument 1");
      prim = specialize_prim_for_operands(
        prim,
        numeric_type(left, env),
        numeric_type(right, env),
      );
    }

    const signature = Callable.type(Prim, prim);

    for (let index = 0; index < call.args.length; index += 1) {
      const arg = call.args[index];
      const expected_type = signature.args[index];
      expect(arg, "Missing numeric builtin argument " + index);
      expect(expected_type, "Missing numeric builtin argument type " + index);
      const actual_type = numeric_type(arg, env);

      if (actual_type !== undefined && actual_type !== expected_type) {
        throw new Error(
          "Numeric builtin argument " + index + " expects " + expected_type +
            ", got " + actual_type,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      diagnostics.push(source_diagnostic(
        "DUCK2302",
        error.message,
        expr,
      ));
      return;
    }

    throw error;
  }
}

function validate_f32x4_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  call: NonNullable<ReturnType<typeof f32x4_builtin_call>>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  const signature = Callable.type(Prim, call.prim);

  if (call.args.length !== signature.args.length) {
    expect(expr.func.tag === "var", "F32x4 builtin requires a name");
    diagnostics.push(source_diagnostic(
      "DUCK2302",
      expr.func.name + " expects " + signature.args.length +
        " arguments, got " + call.args.length,
      expr,
    ));
    return;
  }

  try {
    validate_f32x4_lane_argument(call.prim, call.args);

    for (let index = 0; index < call.args.length; index += 1) {
      const arg = call.args[index];
      const expected_type = signature.args[index];
      expect(arg, "Missing f32x4 builtin argument " + index);
      expect(expected_type, "Missing f32x4 builtin argument type " + index);
      const actual = infer_type(arg, env);

      if (actual.tag === "unknown") {
        continue;
      }

      let matches = false;

      if (expected_type === "v128" && actual.tag === "f32x4") {
        matches = true;
      }

      if (
        expected_type !== "v128" && actual.tag === "int" &&
        actual.type === expected_type
      ) {
        matches = true;
      }

      if (!matches) {
        throw new Error(
          "F32x4 builtin argument " + index + " expects " +
            source_name_for_val_type(expected_type) + ", got " +
            type_name(actual),
        );
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      diagnostics.push(source_diagnostic(
        "DUCK2302",
        error.message,
        expr,
      ));
      return;
    }

    throw error;
  }
}

function source_name_for_val_type(type: ValType): string {
  if (type === "v128") {
    return "F32x4";
  }

  if (type === "f32") {
    return "F32";
  }

  if (type === "f64") {
    return "F64";
  }

  if (type === "i64") {
    return "I64";
  }

  return "I32";
}

function infer_type(
  expr: FrontExpr,
  env: SemanticEnv,
  active_calls: Set<FrontExpr> = new Set(),
): FrontType {
  if (expr.tag === "bool") {
    return { tag: "bool" };
  }

  if (expr.tag === "atom") {
    return { tag: "atom", name: expr.name };
  }

  if (expr.tag === "unit") {
    return { tag: "atom", name: semantic_unit_atom_name };
  }

  if (expr.tag === "num") {
    return { tag: "int", type: expr.type, integer: expr.integer };
  }

  if (expr.tag === "text") {
    return { tag: "text", encoding: expr.encoding };
  }

  if (
    expr.tag === "type_name" || expr.tag === "struct_type" ||
    expr.tag === "union_type"
  ) {
    return { tag: "type" };
  }

  if (expr.tag === "set_type") {
    return { tag: "set", type_expr: expr.type_expr };
  }

  if (expr.tag === "is") {
    return { tag: "bool" };
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const binding = env.bindings.get(expr.name);

    if (binding) {
      return binding.type;
    }
  }

  if (expr.tag === "prim") {
    const left_type = infer_type(expr.left, env, active_calls);
    const right_type = infer_type(expr.right, env, active_calls);

    if (!same_type(left_type, right_type)) {
      return { tag: "unknown" };
    }

    if (prim_returns_bool(expr.prim)) {
      return { tag: "bool" };
    }

    return { tag: "int", type: numeric_type(expr, env, active_calls) };
  }

  if (expr.tag === "if") {
    const then_type = infer_type(expr.then_branch, env, active_calls);

    if (expr.implicit_else === true) {
      return then_type;
    }

    const else_type = infer_type(expr.else_branch, env, active_calls);

    if (then_type.tag === "unknown") {
      return else_type;
    }

    if (else_type.tag === "unknown") {
      return then_type;
    }

    if (same_type(then_type, else_type)) {
      return then_type;
    }
  }

  if (expr.tag === "if_let") {
    const then_env = child_env(env);

    if (expr.value_name !== undefined) {
      bind_local(
        then_env,
        expr.value_name,
        union_case_payload_type(expr.target, expr.case_name, env),
        undefined,
        false,
        false,
      );
    }

    const then_type = infer_type(expr.then_branch, then_env, active_calls);

    if (expr.implicit_else === true) {
      return then_type;
    }

    const else_type = infer_type(expr.else_branch, env, active_calls);

    if (then_type.tag === "unknown") {
      return else_type;
    }

    if (else_type.tag === "unknown") {
      return then_type;
    }

    if (same_type(then_type, else_type)) {
      return then_type;
    }
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return { tag: "fn", params: expr.params };
  }

  if (expr.tag === "app") {
    const f32x4_call = f32x4_builtin_call(expr);

    if (
      f32x4_call && expr.func.tag === "var" &&
      !env.bindings.has(expr.func.name)
    ) {
      const signature = Callable.type(Prim, f32x4_call.prim);

      if (f32x4_call.args.length !== signature.args.length) {
        return { tag: "unknown" };
      }

      if (signature.result === "v128") {
        return { tag: "f32x4" };
      }

      expect(
        signature.result === "f32",
        "Unexpected f32x4 builtin result type: " + signature.result,
      );
      return { tag: "int", type: "f32" };
    }

    const numeric_call = numeric_builtin_call(expr);

    if (
      numeric_call && expr.func.tag === "var" &&
      !env.bindings.has(expr.func.name)
    ) {
      const expected = Callable.arity(Prim, numeric_call.prim);

      if (numeric_call.args.length !== expected) {
        return { tag: "unknown" };
      }

      let prim = numeric_call.prim;

      if (expected === 2) {
        const left = numeric_call.args[0];
        const right = numeric_call.args[1];
        expect(left, "Missing numeric builtin argument 0");
        expect(right, "Missing numeric builtin argument 1");
        prim = specialize_prim_for_operands(
          prim,
          numeric_type(left, env, active_calls),
          numeric_type(right, env, active_calls),
        );
      }

      const result = Callable.type(Prim, prim).result;
      expect(result !== "v128", "Numeric builtin cannot return F32x4");
      return { tag: "int", type: result };
    }

    if (expr.func.tag === "var" && expr.func.name === "@Bytes.generate") {
      return { tag: "text", encoding: "bytes" };
    }

    if (expr.func.tag === "var" && expr.func.name === "@Utf8.encode") {
      return { tag: "text", encoding: "bytes" };
    }

    if (
      expr.func.tag === "var" &&
      (expr.func.name === "@Utf8.decode" ||
        expr.func.name === "@format_i32" ||
        expr.func.name === "@format_i64" || expr.func.name === "@format_f32")
    ) {
      return { tag: "text" };
    }

    if (expr.func.tag === "field") {
      const cases = union_constructor_cases(expr.func.object, env);

      if (
        cases !== undefined &&
        lookup_type_field(cases, expr.func.name) !== undefined
      ) {
        return { tag: "union_value", cases };
      }
    }

    if (expr.func.tag === "field" && expr.func.object.tag === "var") {
      const effect = env.effects.get(expr.func.object.name);

      if (effect !== undefined) {
        const operation_name = expr.func.name;
        const operation = effect.operations.find((candidate) =>
          candidate.name === operation_name
        );

        if (operation !== undefined) {
          return resolve_type_name(operation.result.type_name, env);
        }
      }
    }

    const callable = resolve_called_function(
      expr.func,
      env,
      new Set(),
      active_calls,
    );

    if (callable === undefined) {
      return { tag: "unknown" };
    }

    if (callable.type_annotation !== undefined) {
      const annotated_result = type_from_type_expr(
        callable.type_annotation.result,
        callable.target_env,
      );

      if (annotated_result.tag !== "unknown") {
        return annotated_result;
      }
    }

    if (
      callable.target === undefined || active_calls.has(callable.target)
    ) {
      return { tag: "unknown" };
    }

    const body_env = callable_body_env(
      callable,
      expr.args,
      env,
      active_calls,
    );
    active_calls.add(callable.target);
    const result = infer_type(callable.target.body, body_env, active_calls);
    active_calls.delete(callable.target);
    return result;
  }

  if (expr.tag === "block") {
    return infer_block_type(expr.statements, env, active_calls);
  }

  if (
    expr.tag === "comptime" || expr.tag === "borrow" ||
    expr.tag === "freeze"
  ) {
    if (expr.tag === "comptime") {
      return infer_type(expr.expr, env, active_calls);
    }

    return infer_type(expr.value, env, active_calls);
  }

  if (expr.tag === "scratch") {
    return infer_type(expr.body, env, active_calls);
  }

  if (expr.tag === "loop") {
    return infer_loop_break_type(expr.body, env, active_calls);
  }

  if (expr.tag === "captured") {
    return infer_type(expr.expr, env, active_calls);
  }

  if (expr.tag === "try_with") {
    const handler = resolve_handler_expr(
      expr.handler,
      env,
      new Set(),
      active_calls,
    );

    if (handler !== undefined) {
      const return_env = handler_return_env(
        handler.target,
        infer_type(expr.body, env, active_calls),
        handler.target_env,
      );
      return infer_type(
        handler.target.return_clause.body,
        return_env,
        active_calls,
      );
    }
  }

  if (expr.tag === "struct_value") {
    return infer_struct_value_type(expr, env, active_calls);
  }

  if (expr.tag === "product") {
    return infer_struct_value_type(
      elaborate_product_expr(expr),
      env,
      active_calls,
    );
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    if (
      expr.base.tag === "var" && !env.bindings.has(expr.base.name)
    ) {
      return resolve_type_name(expr.base.name, env);
    }

    return infer_type(expr.base, env, active_calls);
  }

  if (expr.tag === "type_with") {
    return infer_type(expr.base, env, active_calls);
  }

  if (expr.tag === "field") {
    const object_type = infer_type(expr.object, env, active_calls);

    if (object_type.tag === "struct" && object_type.field_types) {
      const field = lookup_type_field(object_type.field_types, expr.name);

      if (field !== undefined) {
        return resolve_type_name(field.type_name, env);
      }
    }

    const fields = struct_fields_of(expr.object, env);

    if (fields !== undefined) {
      const field = find_field(fields, expr.name);

      if (field !== undefined) {
        return infer_type(field.value, env, active_calls);
      }
    }
  }

  if (expr.tag === "union_case") {
    let cases: TypeField[] | undefined;

    if (expr.type_expr !== undefined) {
      cases = union_constructor_cases(expr.type_expr, env);
    } else {
      cases = unqualified_union_cases(expr.name, env);
    }

    if (cases !== undefined) {
      return { tag: "union_value", cases };
    }
  }

  if (expr.tag === "index") {
    const object_type = infer_type(expr.object, env, active_calls);

    if (object_type.tag !== "struct" || !object_type.field_types) {
      return { tag: "unknown" };
    }

    const static_index = static_i32_index(expr.index);

    if (static_index === undefined) {
      return dynamic_index_type_from_fields(object_type.field_types);
    }

    const field = object_type.field_types[static_index];

    if (field !== undefined) {
      return resolve_type_name(field.type_name, env);
    }
  }

  return { tag: "unknown" };
}

function numeric_type(
  expr: FrontExpr,
  env: SemanticEnv,
  active_calls: Set<FrontExpr> = new Set(),
): NumType | undefined {
  if (expr.tag === "prim") {
    const specialized = specialize_prim_for_operands(
      expr.prim,
      numeric_type(expr.left, env, active_calls),
      numeric_type(expr.right, env, active_calls),
    );
    const result = prim_result_type(specialized);
    expect(result !== "v128", "Numeric primitive cannot return F32x4");
    return result;
  }

  const type = infer_type(expr, env, active_calls);

  if (type.tag === "int") {
    return type.type;
  }

  return undefined;
}

function infer_block_type(
  statements: Stmt[],
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): FrontType {
  const body_env = child_env(env);
  let result: FrontType = { tag: "unknown" };

  for (const stmt of statements) {
    if (stmt.tag === "bind") {
      let binding_type = infer_type(stmt.value, body_env, active_calls);

      if (binding_type.tag === "unknown") {
        if (stmt.annotation !== undefined) {
          binding_type = resolve_type_name(stmt.annotation, body_env);
        } else if (
          stmt.type_annotation !== undefined &&
          stmt.type_annotation.tag === "name"
        ) {
          binding_type = resolve_type_name(
            stmt.type_annotation.name,
            body_env,
          );
        }
      }

      body_env.bindings.set(stmt.name, {
        type: binding_type,
        type_annotation: stmt.type_annotation,
        value: stmt.value,
        value_env: child_env(body_env),
        struct_fields: struct_fields_of(stmt.value, body_env),
        declaration: undefined,
        used: false,
      });
      result = { tag: "unknown" };
      continue;
    }

    if (stmt.tag === "state_bind") {
      const binding_type = infer_type(stmt.value, body_env, active_calls);

      if (stmt.value_name !== undefined) {
        bind_local(
          body_env,
          stmt.value_name,
          binding_type,
          undefined,
          false,
          false,
        );
      }

      result = { tag: "unknown" };
      continue;
    }

    if (stmt.tag === "assign") {
      const binding_type = infer_type(stmt.value, body_env, active_calls);
      body_env.bindings.set(stmt.name, {
        type: binding_type,
        type_annotation: undefined,
        value: stmt.value,
        value_env: child_env(body_env),
        struct_fields: struct_fields_of(stmt.value, body_env),
        declaration: undefined,
        used: false,
      });
      result = { tag: "unknown" };
      continue;
    }

    if (stmt.tag === "expr") {
      result = infer_type(stmt.expr, body_env, active_calls);
      continue;
    }

    if (stmt.tag === "return") {
      return infer_type(stmt.value, body_env, active_calls);
    }

    result = { tag: "unknown" };
  }

  return result;
}

type SemanticLoopBreak = {
  type: FrontType;
  subject: FrontExpr;
};

function infer_loop_break_type(
  statements: Stmt[],
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): FrontType {
  const breaks = collect_loop_break_types(
    statements,
    child_env(env),
    active_calls,
  );
  let result: FrontType | undefined;

  for (const loop_break of breaks) {
    if (loop_break.type.tag === "unknown") {
      continue;
    }

    if (result === undefined) {
      result = loop_break.type;
    } else if (!same_type(result, loop_break.type)) {
      return { tag: "unknown" };
    }
  }

  if (result !== undefined) {
    return result;
  }

  return { tag: "unknown" };
}

function validate_loop_break_types(
  statements: Stmt[],
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  const breaks = collect_loop_break_types(
    statements,
    child_env(env),
    new Set(),
  );
  let result: FrontType | undefined;

  for (const loop_break of breaks) {
    if (loop_break.type.tag === "unknown") {
      continue;
    }

    if (result === undefined) {
      result = loop_break.type;
      continue;
    }

    if (!bool_representation_mismatch(result, loop_break.type, env)) {
      continue;
    }

    diagnostics.push(bool_route_diagnostic(
      "DUCK2306",
      "Loop break values have incompatible types " + type_name(result) +
        " and " + type_name(loop_break.type),
      loop_break.subject,
    ));
    return;
  }
}

function collect_loop_break_types(
  statements: Stmt[],
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): SemanticLoopBreak[] {
  const breaks: SemanticLoopBreak[] = [];
  scan_loop_break_statements(statements, env, active_calls, breaks);
  return breaks;
}

function scan_loop_break_statements(
  statements: Stmt[],
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
  breaks: SemanticLoopBreak[],
): void {
  for (const stmt of statements) {
    if (stmt.tag === "break") {
      if (stmt.value !== undefined) {
        breaks.push({
          type: infer_type(stmt.value, env, active_calls),
          subject: stmt.value,
        });
        scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      }

      continue;
    }

    if (
      stmt.tag === "continue" || stmt.tag === "return" ||
      stmt.tag === "for_range" || stmt.tag === "for_collection"
    ) {
      continue;
    }

    if (stmt.tag === "if_stmt") {
      scan_loop_break_expr(stmt.cond, env, active_calls, breaks);
      scan_loop_break_statements(
        stmt.body,
        child_env(env),
        active_calls,
        breaks,
      );
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      scan_loop_break_expr(stmt.target, env, active_calls, breaks);
      const body_env = child_env(env);

      if (stmt.value_name !== undefined) {
        bind_local(
          body_env,
          stmt.value_name,
          union_case_payload_type(stmt.target, stmt.case_name, env),
          undefined,
          false,
          false,
        );
      }

      scan_loop_break_statements(
        stmt.body,
        body_env,
        active_calls,
        breaks,
      );
      continue;
    }

    if (stmt.tag === "bind") {
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      let binding_type = infer_type(stmt.value, env, active_calls);

      if (binding_type.tag === "unknown") {
        if (stmt.annotation !== undefined) {
          binding_type = resolve_type_name(stmt.annotation, env);
        } else if (stmt.type_annotation !== undefined) {
          binding_type = type_from_type_expr(stmt.type_annotation, env);
        }
      }

      env.bindings.set(stmt.name, {
        type: binding_type,
        type_annotation: stmt.type_annotation,
        value: stmt.value,
        value_env: child_env(env),
        struct_fields: struct_fields_of(stmt.value, env),
        declaration: stmt,
        used: false,
      });
      continue;
    }

    if (stmt.tag === "state_bind") {
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);

      if (stmt.value_name !== undefined) {
        bind_local(
          env,
          stmt.value_name,
          infer_type(stmt.value, env, active_calls),
          undefined,
          false,
          false,
        );
      }

      continue;
    }

    if (stmt.tag === "bind_pattern") {
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      const value_type = infer_type(stmt.value, env, active_calls);

      for (const pattern of stmt.items) {
        let pattern_type: FrontType = { tag: "unknown" };

        if (value_type.tag === "struct" && value_type.field_types) {
          const field = lookup_type_field(
            value_type.field_types,
            pattern.name,
          );

          if (field !== undefined) {
            pattern_type = resolve_type_name(field.type_name, env);
          }
        }

        bind_local(
          env,
          pattern.name,
          pattern_type,
          undefined,
          stmt.kind === "const",
          pattern.is_linear,
        );
      }

      continue;
    }

    if (stmt.tag === "resume_dup") {
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      bind_local(env, stmt.left, { tag: "unknown" }, undefined, false, true);
      bind_local(env, stmt.right, { tag: "unknown" }, undefined, false, true);
      continue;
    }

    if (stmt.tag === "assign") {
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      env.bindings.set(stmt.name, {
        type: infer_type(stmt.value, env, active_calls),
        type_annotation: undefined,
        value: stmt.value,
        value_env: child_env(env),
        struct_fields: struct_fields_of(stmt.value, env),
        declaration: undefined,
        used: false,
      });
      continue;
    }

    if (stmt.tag === "index_assign") {
      scan_loop_break_expr(stmt.index, env, active_calls, breaks);
      scan_loop_break_expr(stmt.value, env, active_calls, breaks);
      continue;
    }

    if (stmt.tag === "type_check") {
      scan_loop_break_expr(stmt.target, env, active_calls, breaks);
      continue;
    }

    if (stmt.tag === "expr") {
      scan_loop_break_expr(stmt.expr, env, active_calls, breaks);
    }
  }
}

function scan_loop_break_expr(
  expr: FrontExpr,
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
  breaks: SemanticLoopBreak[],
): void {
  if (
    expr.tag === "loop" || expr.tag === "lam" || expr.tag === "rec" ||
    expr.tag === "handler" || expr.tag === "try_with" ||
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "atom" ||
    expr.tag === "unit" || expr.tag === "text" ||
    expr.tag === "type_name" || expr.tag === "set_type" ||
    expr.tag === "var" || expr.tag === "linear" ||
    expr.tag === "struct_type" || expr.tag === "union_type" ||
    expr.tag === "unsupported"
  ) {
    return;
  }

  if (expr.tag === "prim") {
    scan_loop_break_expr(expr.left, env, active_calls, breaks);
    scan_loop_break_expr(expr.right, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "app") {
    scan_loop_break_expr(expr.func, env, active_calls, breaks);

    for (const arg of expr.args) {
      scan_loop_break_expr(arg, env, active_calls, breaks);
    }

    return;
  }

  if (expr.tag === "block") {
    scan_loop_break_statements(
      expr.statements,
      child_env(env),
      active_calls,
      breaks,
    );
    return;
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    scan_loop_break_expr(expr.expr, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    scan_loop_break_expr(expr.value, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "scratch") {
    scan_loop_break_expr(expr.body, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    scan_loop_break_expr(expr.base, env, active_calls, breaks);

    for (const field of expr.fields) {
      scan_loop_break_expr(field.value, env, active_calls, breaks);
    }

    return;
  }

  if (expr.tag === "type_with") {
    scan_loop_break_expr(expr.base, env, active_calls, breaks);

    for (const member of expr.members) {
      scan_loop_break_expr(member.name, env, active_calls, breaks);
      scan_loop_break_expr(member.value, env, active_calls, breaks);
    }

    return;
  }

  if (expr.tag === "struct_value") {
    scan_loop_break_expr(expr.type_expr, env, active_calls, breaks);

    for (const field of expr.fields) {
      scan_loop_break_expr(field.value, env, active_calls, breaks);
    }

    return;
  }

  if (expr.tag === "if") {
    scan_loop_break_expr(expr.cond, env, active_calls, breaks);
    scan_loop_break_expr(
      expr.then_branch,
      child_env(env),
      active_calls,
      breaks,
    );
    scan_loop_break_expr(
      expr.else_branch,
      child_env(env),
      active_calls,
      breaks,
    );
    return;
  }

  if (expr.tag === "if_let") {
    scan_loop_break_expr(expr.target, env, active_calls, breaks);
    const then_env = child_env(env);

    if (expr.value_name !== undefined) {
      bind_local(
        then_env,
        expr.value_name,
        union_case_payload_type(expr.target, expr.case_name, env),
        undefined,
        false,
        false,
      );
    }

    scan_loop_break_expr(
      expr.then_branch,
      then_env,
      active_calls,
      breaks,
    );
    scan_loop_break_expr(
      expr.else_branch,
      child_env(env),
      active_calls,
      breaks,
    );
    return;
  }

  if (expr.tag === "match") {
    scan_loop_break_expr(expr.target, env, active_calls, breaks);
    const target_type = infer_type(expr.target, env, active_calls);

    for (const arm of expr.arms) {
      const arm_env = child_env(env);
      bind_pattern_types(arm.pattern, target_type, arm_env, false);

      if (arm.guard !== undefined) {
        scan_loop_break_expr(arm.guard, arm_env, active_calls, breaks);
      }

      scan_loop_break_expr(arm.body, arm_env, active_calls, breaks);
    }

    return;
  }

  if (expr.tag === "field") {
    scan_loop_break_expr(expr.object, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "index") {
    scan_loop_break_expr(expr.object, env, active_calls, breaks);
    scan_loop_break_expr(expr.index, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "is") {
    scan_loop_break_expr(expr.value, env, active_calls, breaks);
    return;
  }

  if (expr.tag === "union_case") {
    if (expr.value !== undefined) {
      scan_loop_break_expr(expr.value, env, active_calls, breaks);
    }

    if (expr.type_expr !== undefined) {
      scan_loop_break_expr(expr.type_expr, env, active_calls, breaks);
    }
  }
}

function infer_struct_value_type(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): FrontType {
  if (
    expr.type_expr.tag === "var" && expr.type_expr.name !== "object_type"
  ) {
    const declared = resolve_type_name(expr.type_expr.name, env);

    if (declared.tag === "struct") {
      return declared;
    }
  }

  const field_types: TypeField[] = [];

  for (const field of expr.fields) {
    const field_type = infer_type(field.value, env, active_calls);
    let field_type_name: string | undefined;

    if (field_type.tag === "bool") {
      field_type_name = "Bool";
    } else if (field_type.tag === "atom") {
      if (field_type.name === semantic_unit_atom_name) {
        field_type_name = "Unit";
      } else {
        field_type_name = "#" + field_type.name;
      }
    } else if (field_type.tag === "int" && field_type.type === "i32") {
      field_type_name = "I32";
    } else if (field_type.tag === "int" && field_type.type === "i64") {
      field_type_name = "I64";
    } else if (field_type.tag === "int" && field_type.type === "f32") {
      field_type_name = "F32";
    } else if (field_type.tag === "int" && field_type.type === "f64") {
      field_type_name = "F64";
    } else if (field_type.tag === "text") {
      field_type_name = "Text";

      if (field_type.encoding === "bytes") {
        field_type_name = "Bytes";
      }
    }

    if (field_type_name === undefined) {
      return {
        tag: "struct",
        fields: expr.fields.map((candidate) => candidate.name),
        field_types: undefined,
      };
    }

    field_types.push({ name: field.name, type_name: field_type_name });
  }

  return {
    tag: "struct",
    fields: expr.fields.map((field) => field.name),
    field_types,
  };
}

function resolve_called_function(
  expr: FrontExpr,
  env: SemanticEnv,
  visited_names: Set<string> = new Set(),
  active_calls: Set<FrontExpr> = new Set(),
): SemanticCallable | undefined {
  if (expr.tag === "lam" || expr.tag === "rec") {
    return {
      target: expr,
      target_env: env,
      type_annotation: undefined,
    };
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return resolve_called_function(
      expr.expr,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resolve_called_function(
      expr.value,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "scratch") {
    return resolve_called_function(
      expr.body,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "block") {
    const result = semantic_block_result(expr, env, active_calls);

    if (result === undefined) {
      return undefined;
    }

    return resolve_called_function(
      result.expr,
      result.env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "if") {
    const then_callable = resolve_called_function(
      expr.then_branch,
      env,
      new Set(visited_names),
      active_calls,
    );
    const else_callable = resolve_called_function(
      expr.else_branch,
      env,
      new Set(visited_names),
      active_calls,
    );

    if (then_callable === undefined || else_callable === undefined) {
      return undefined;
    }

    if (!same_callable_type(then_callable, else_callable, active_calls)) {
      return undefined;
    }

    return then_callable;
  }

  if (expr.tag === "app") {
    const called = resolve_called_function(
      expr.func,
      env,
      visited_names,
      active_calls,
    );

    if (called === undefined) {
      return undefined;
    }

    const result_annotation = function_type_expr(
      called.type_annotation?.result,
    );

    if (called.target === undefined || active_calls.has(called.target)) {
      if (result_annotation === undefined) {
        return undefined;
      }

      return {
        target: undefined,
        target_env: env,
        type_annotation: result_annotation,
      };
    }

    const body_env = callable_body_env(
      called,
      expr.args,
      env,
      active_calls,
    );
    active_calls.add(called.target);
    const returned = resolve_called_function(
      called.target.body,
      body_env,
      new Set(visited_names),
      active_calls,
    );
    active_calls.delete(called.target);

    if (returned === undefined) {
      if (result_annotation === undefined) {
        return undefined;
      }

      return {
        target: undefined,
        target_env: body_env,
        type_annotation: result_annotation,
      };
    }

    if (result_annotation !== undefined) {
      returned.type_annotation = result_annotation;
    }

    return returned;
  }

  if (expr.tag !== "var" && expr.tag !== "linear") {
    return undefined;
  }

  if (visited_names.has(expr.name)) {
    return undefined;
  }

  visited_names.add(expr.name);
  const binding = env.bindings.get(expr.name);

  if (binding === undefined) {
    return undefined;
  }

  const type_annotation = function_type_expr(binding.type_annotation);

  if (binding.value === undefined) {
    if (type_annotation === undefined) {
      return undefined;
    }

    return {
      target: undefined,
      target_env: env,
      type_annotation,
    };
  }

  let value_env = env;

  if (binding.value_env !== undefined) {
    value_env = binding.value_env;
  }

  const resolved = resolve_called_function(
    binding.value,
    value_env,
    visited_names,
    active_calls,
  );

  if (resolved === undefined) {
    if (type_annotation === undefined) {
      return undefined;
    }

    return {
      target: undefined,
      target_env: value_env,
      type_annotation,
    };
  }

  if (type_annotation !== undefined) {
    resolved.type_annotation = type_annotation;
  }

  return resolved;
}

function semantic_block_result(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): { expr: FrontExpr; env: SemanticEnv } | undefined {
  const body_env = child_env(env);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];

    if (stmt === undefined) {
      continue;
    }

    if (stmt.tag === "bind") {
      let binding_type = infer_type(stmt.value, body_env, active_calls);

      if (binding_type.tag === "unknown") {
        if (stmt.annotation !== undefined) {
          binding_type = resolve_type_name(stmt.annotation, body_env);
        } else if (
          stmt.type_annotation !== undefined &&
          stmt.type_annotation.tag === "name"
        ) {
          binding_type = resolve_type_name(
            stmt.type_annotation.name,
            body_env,
          );
        }
      }

      body_env.bindings.set(stmt.name, {
        type: binding_type,
        type_annotation: stmt.type_annotation,
        value: stmt.value,
        value_env: child_env(body_env),
        struct_fields: struct_fields_of(stmt.value, body_env),
        declaration: stmt,
        used: false,
      });
      continue;
    }

    if (
      (stmt.tag === "expr" || stmt.tag === "return") &&
      index === expr.statements.length - 1
    ) {
      if (stmt.tag === "expr") {
        return { expr: stmt.expr, env: body_env };
      }

      return { expr: stmt.value, env: body_env };
    }

    return undefined;
  }

  return undefined;
}

function callable_body_env(
  callable: SemanticCallable,
  args: FrontExpr[],
  call_env: SemanticEnv,
  active_calls: Set<FrontExpr>,
): SemanticEnv {
  const body_env = child_env(callable.target_env);

  if (callable.target === undefined) {
    return body_env;
  }

  const contextual_params = arrow_parameter_types(
    callable.type_annotation,
    callable.target_env,
  );

  for (let index = 0; index < callable.target.params.length; index += 1) {
    const param = callable.target.params[index];

    if (param === undefined) {
      continue;
    }

    const contextual_type = contextual_params[index];
    let param_type = type_from_type_expr(contextual_type, body_env);
    let param_type_annotation: TypeExpr | undefined = contextual_type;

    if (param_type.tag === "unknown" && param.annotation !== undefined) {
      param_type = resolve_type_name(param.annotation, body_env);
    }

    if (
      param_type.tag === "unknown" && param.type_annotation !== undefined
    ) {
      param_type = type_from_type_expr(param.type_annotation, body_env);
    }

    if (param_type_annotation === undefined) {
      param_type_annotation = param.type_annotation;
    }

    if (param_type.tag === "unknown") {
      const arg = args[index];

      if (arg !== undefined) {
        param_type = infer_type(arg, call_env, active_calls);
      }
    }

    bind_local(
      body_env,
      param.name,
      param_type,
      param_type_annotation,
      param.is_const,
      param.is_linear,
    );
  }

  if (callable.target.tag === "rec") {
    bind_rec_target(body_env, callable.target, callable.type_annotation);
  }

  return body_env;
}

function arrow_parameter_types(
  annotation: Extract<TypeExpr, { tag: "arrow" }> | undefined,
  env: SemanticEnv,
): TypeExpr[] {
  if (annotation === undefined) {
    return [];
  }

  if (annotation.param.tag === "tuple") {
    return annotation.param.items;
  }

  if (annotation.param.tag === "product") {
    try {
      return expanded_type_product_entries(
        annotation.param,
        (name) => semantic_const_i32_name(name, env, new Set()),
      ).map((entry) => entry.type_expr);
    } catch (error) {
      if (error instanceof Error) {
        return annotation.param.entries.map((entry) => entry.type_expr);
      }

      throw error;
    }
  }

  return [annotation.param];
}

function type_from_type_expr(
  type: TypeExpr | undefined,
  env: SemanticEnv,
): FrontType {
  if (type === undefined) {
    return { tag: "unknown" };
  }

  if (type.tag === "name") {
    return resolve_type_name(type.name, env);
  }

  if (type.tag === "atom") {
    return { tag: "atom", name: type.name };
  }

  if (type.tag === "never") {
    return { tag: "never" };
  }

  if (type.tag === "apply") {
    return resolve_type_name(format_type_expr(type), env);
  }

  if (
    (type.tag === "tuple" && type.items.length === 0) ||
    (type.tag === "product" && type.entries.length === 0)
  ) {
    return { tag: "atom", name: semantic_unit_atom_name };
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    return type_from_type_expr(type.value, env);
  }

  return { tag: "unknown" };
}

function bind_rec_target(
  env: SemanticEnv,
  expr: Extract<FrontExpr, { tag: "rec" }>,
  type_annotation: Extract<TypeExpr, { tag: "arrow" }> | undefined,
): void {
  const binding: SemanticBinding = {
    type: { tag: "fn", params: expr.params },
    type_annotation,
    value: expr,
    value_env: undefined,
    struct_fields: undefined,
    declaration: undefined,
    used: false,
  };
  env.bindings.set("rec", binding);
  binding.value_env = child_env(env);
}

function resolve_handler_expr(
  expr: FrontExpr,
  env: SemanticEnv,
  visited_names: Set<string> = new Set(),
  active_calls: Set<FrontExpr> = new Set(),
): SemanticHandler | undefined {
  if (expr.tag === "handler") {
    return { target: expr, target_env: env };
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return resolve_handler_expr(
      expr.expr,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resolve_handler_expr(
      expr.value,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "scratch") {
    return resolve_handler_expr(
      expr.body,
      env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "block") {
    const result = semantic_block_result(expr, env, active_calls);

    if (result === undefined) {
      return undefined;
    }

    return resolve_handler_expr(
      result.expr,
      result.env,
      visited_names,
      active_calls,
    );
  }

  if (expr.tag === "app") {
    const callable = resolve_called_function(
      expr.func,
      env,
      new Set(visited_names),
      active_calls,
    );

    if (
      callable === undefined || callable.target === undefined ||
      active_calls.has(callable.target)
    ) {
      return undefined;
    }

    const body_env = callable_body_env(
      callable,
      expr.args,
      env,
      active_calls,
    );
    active_calls.add(callable.target);
    const handler = resolve_handler_expr(
      callable.target.body,
      body_env,
      new Set(visited_names),
      active_calls,
    );
    active_calls.delete(callable.target);
    return handler;
  }

  if (expr.tag !== "var" && expr.tag !== "linear") {
    return undefined;
  }

  if (visited_names.has(expr.name)) {
    return undefined;
  }

  const binding = env.bindings.get(expr.name);

  if (binding === undefined || binding.value === undefined) {
    return undefined;
  }

  visited_names.add(expr.name);
  let value_env = env;

  if (binding.value_env !== undefined) {
    value_env = binding.value_env;
  }

  return resolve_handler_expr(
    binding.value,
    value_env,
    visited_names,
    active_calls,
  );
}

function static_i32_index(expr: FrontExpr): number | undefined {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    typeof expr.value === "number" && Number.isInteger(expr.value)
  ) {
    return expr.value;
  }

  return undefined;
}

function struct_fields_of(
  expr: FrontExpr,
  env: SemanticEnv,
): Field[] | undefined {
  if (expr.tag === "struct_value") {
    return expr.fields;
  }

  if (expr.tag === "product") {
    return elaborate_product_expr(expr).fields;
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const binding = env.bindings.get(expr.name);

    if (binding) {
      return binding.struct_fields;
    }
  }

  return undefined;
}

function contextual_binding_fields(
  stmt: Extract<Stmt, { tag: "bind" }>,
  env: SemanticEnv,
): Field[] | undefined {
  const fields = struct_fields_of(stmt.value, env);

  if (fields === undefined || stmt.value.tag !== "product") {
    return fields;
  }

  if (stmt.value.entries.some((entry) => entry.label !== undefined)) {
    return fields;
  }

  let annotation_type: FrontType = { tag: "unknown" };

  if (stmt.annotation !== undefined) {
    annotation_type = resolve_type_name(stmt.annotation, env);
  } else if (stmt.type_annotation !== undefined) {
    annotation_type = type_from_type_expr(stmt.type_annotation, env);
  }

  if (annotation_type.tag !== "struct" || !annotation_type.field_types) {
    return fields;
  }

  return fields.map((field, index) => {
    const declared = annotation_type.field_types?.[index];

    if (declared === undefined) {
      return field;
    }

    return { name: declared.name, value: field.value };
  });
}

function bind_pattern_types(
  pattern: Pattern,
  type: FrontType,
  env: SemanticEnv,
  binding_is_const: boolean,
): void {
  if (pattern.tag === "binding") {
    mark_annotation_use(pattern.annotation, pattern.type_annotation, env);
    let binding_type = type;

    if (pattern.annotation !== undefined) {
      binding_type = resolve_type_name(pattern.annotation, env);
    } else if (pattern.type_annotation !== undefined) {
      binding_type = type_from_type_expr(pattern.type_annotation, env);
    }

    bind_local(
      env,
      pattern.name,
      binding_type,
      pattern.type_annotation,
      binding_is_const || pattern.mode === "const",
      pattern.mode === "linear",
    );
    return;
  }

  if (
    pattern.tag === "wildcard" || pattern.tag === "unit" ||
    pattern.tag === "literal" || pattern.tag === "value" ||
    pattern.tag === "type"
  ) {
    return;
  }

  if (pattern.tag === "union_case") {
    if (pattern.value === undefined) {
      return;
    }

    let payload_type: FrontType = { tag: "unknown" };

    if (type.tag === "union_value") {
      const union_case = lookup_type_field(type.cases, pattern.name);

      if (union_case !== undefined) {
        payload_type = resolve_type_name(union_case.type_name, env);
      }
    }

    bind_pattern_types(pattern.value, payload_type, env, binding_is_const);
    return;
  }

  if (pattern.tag === "record") {
    for (const field of pattern.fields) {
      let field_type: FrontType = { tag: "unknown" };

      if (type.tag === "struct" && type.field_types !== undefined) {
        const declared = lookup_type_field(type.field_types, field.name);

        if (declared !== undefined) {
          field_type = resolve_type_name(declared.type_name, env);
        }
      }

      bind_pattern_types(
        field.pattern,
        field_type,
        env,
        binding_is_const,
      );
    }

    if (pattern.rest !== undefined) {
      bind_pattern_types(
        pattern.rest,
        { tag: "unknown" },
        env,
        binding_is_const,
      );
    }

    return;
  }

  const patterns: Pattern[] = [];

  if (pattern.tag === "product") {
    for (const entry of pattern.entries) {
      patterns.push(entry.pattern);
    }
  } else {
    patterns.push(...pattern.items);
  }

  for (let index = 0; index < patterns.length; index += 1) {
    const nested = patterns[index];

    if (nested === undefined) {
      continue;
    }

    let item_type: FrontType = { tag: "unknown" };

    if (type.tag === "struct" && type.field_types !== undefined) {
      const declared = type.field_types[index];

      if (declared !== undefined) {
        item_type = resolve_type_name(declared.type_name, env);
      }
    }

    bind_pattern_types(nested, item_type, env, binding_is_const);
  }

  if (pattern.tag === "array" && pattern.rest !== undefined) {
    bind_pattern_types(
      pattern.rest,
      { tag: "unknown" },
      env,
      binding_is_const,
    );
  }
}

function find_field(fields: Field[], name: string): Field | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

function child_env(env: SemanticEnv): SemanticEnv {
  return {
    all_bindings: env.all_bindings,
    bindings: new Map(env.bindings),
    const_env: clone_env(env.const_env),
    declarations: env.declarations,
    effects: env.effects,
    records: env.records,
    active_specialized_calls: env.active_specialized_calls,
  };
}

function handler_return_env(
  handler: Extract<FrontExpr, { tag: "handler" }>,
  input_type: FrontType,
  env: SemanticEnv,
): SemanticEnv {
  const handler_env = child_env(env);

  for (const state of handler.state) {
    let state_type = infer_type(state.value, handler_env);

    if (state.annotation !== undefined) {
      state_type = resolve_type_name(state.annotation, handler_env);
    }

    bind_local(
      handler_env,
      state.name,
      state_type,
      undefined,
      false,
      false,
    );
  }

  const return_env = child_env(handler_env);
  const param = handler.return_clause.param;
  let param_type = input_type;

  if (param.annotation !== undefined) {
    param_type = resolve_type_name(param.annotation, return_env);
  } else if (param.type_annotation !== undefined) {
    param_type = type_from_type_expr(param.type_annotation, return_env);
  }

  bind_local(
    return_env,
    param.name,
    param_type,
    param.type_annotation,
    param.is_const,
    param.is_linear,
  );
  return return_env;
}

function validate_annotated_lambda(
  expr: Extract<FrontExpr, { tag: "lam" | "rec" }>,
  annotation: Extract<TypeExpr, { tag: "arrow" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
  check_comptime: boolean,
): void {
  const body_env = child_env(env);
  const before = diagnostics.length;
  const param_types = arrow_parameter_types(annotation, env);

  for (let index = 0; index < expr.params.length; index += 1) {
    const param = expr.params[index];

    if (param === undefined) {
      continue;
    }

    mark_annotation_use(param.annotation, param.type_annotation, body_env);
    const annotated = param_types[index];
    const expected = type_from_type_expr(annotated, body_env);
    let declared: FrontType = { tag: "unknown" };

    if (param.annotation !== undefined) {
      declared = resolve_type_name(param.annotation, body_env);
    } else if (
      param.type_annotation !== undefined
    ) {
      declared = type_from_type_expr(param.type_annotation, body_env);
    }

    let param_type = expected;

    if (expected.tag === "unknown") {
      param_type = declared;
    } else if (bool_representation_mismatch(expected, declared, body_env)) {
      diagnostics.push(bool_route_diagnostic(
        "DUCK2306",
        "Function parameter " + param.name + " expects " +
          type_name(expected) + ", got " + type_name(declared),
        expr,
      ));
      param_type = declared;
    }

    let param_type_annotation: TypeExpr | undefined = annotated;

    if (param_type_annotation === undefined) {
      param_type_annotation = param.type_annotation;
    }

    bind_local(
      body_env,
      param.name,
      param_type,
      param_type_annotation,
      param.is_const,
      param.is_linear,
    );
  }

  if (
    expr.pattern !== undefined && expr.params.length === 1 &&
    expr.pattern.tag !== "binding" && expr.pattern.tag !== "unit" &&
    !(expr.pattern.tag === "product" && expr.pattern.value_pack === true)
  ) {
    const param = expr.params[0];
    expect(param !== undefined, "Missing function pattern parameter");
    bind_pattern_types(
      expr.pattern,
      type_from_type_expr(param.type_annotation, body_env),
      body_env,
      param.is_const,
    );
  }

  if (expr.tag === "rec") {
    bind_rec_target(body_env, expr, annotation);
  }

  const returned_function_type = function_type_expr(annotation.result);

  if (returned_function_type) {
    const returned = resolve_called_function(expr.body, body_env);

    if (returned !== undefined && returned.target !== undefined) {
      validate_annotated_lambda(
        returned.target,
        returned_function_type,
        returned.target_env,
        diagnostics,
        check_comptime,
      );
      return;
    }
  }

  const returns_value_pack = annotation.result.tag === "product" &&
    annotation.result.value_pack === true;
  validate_expr(
    expr.body,
    body_env,
    diagnostics,
    check_comptime,
    returns_value_pack,
  );

  if (diagnostics.length !== before) {
    return;
  }

  const expected = type_from_type_expr(annotation.result, body_env);

  if (expected.tag === "unknown") {
    return;
  }

  const actual = infer_type(expr.body, body_env);

  const representation_diagnostic = value_representation_diagnostic(
    "DUCK2306",
    "Function result expects " + type_name(expected) + ", got " +
      type_name(actual),
    expr.body,
    expected,
    expr.body,
    body_env,
  );

  if (!representation_diagnostic) {
    return;
  }

  diagnostics.push(representation_diagnostic);
}

function bind_params(env: SemanticEnv, params: Param[]): void {
  for (const param of params) {
    mark_annotation_use(param.annotation, param.type_annotation, env);
    let type: FrontType = { tag: "unknown" };

    if (param.annotation !== undefined) {
      type = resolve_type_name(param.annotation, env);
    } else if (param.type_annotation !== undefined) {
      type = type_from_type_expr(param.type_annotation, env);
    }

    bind_local(
      env,
      param.name,
      type,
      param.type_annotation,
      param.is_const,
      param.is_linear,
    );
  }
}

function bind_local(
  env: SemanticEnv,
  name: string,
  type: FrontType,
  type_annotation: TypeExpr | undefined,
  is_const: boolean,
  is_linear: boolean,
): SemanticBinding {
  const binding: SemanticBinding = {
    type,
    type_annotation,
    value: undefined,
    value_env: undefined,
    struct_fields: undefined,
    declaration: undefined,
    used: false,
  };
  env.bindings.set(name, binding);
  push_binding(env.const_env, {
    name,
    ic_name: name,
    type,
    is_const,
    is_linear,
    value: undefined,
    value_env: undefined,
  });
  return binding;
}

function mark_binding_used(name: string, env: SemanticEnv): void {
  const binding = env.bindings.get(name);

  if (binding !== undefined) {
    binding.used = true;
  }
}

function mark_annotation_use(
  annotation: string | undefined,
  type_annotation: TypeExpr | undefined,
  env: SemanticEnv,
): void {
  mark_annotation_text_use(annotation, env);

  if (type_annotation !== undefined) {
    mark_type_expr_uses(type_annotation, env);
  }
}

function mark_annotation_text_use(
  annotation: string | undefined,
  env: SemanticEnv,
): void {
  if (annotation === undefined) {
    return;
  }

  const syntax = scan_source(annotation);

  for (const token of source_tokens(syntax)) {
    if (token.kind === "name") {
      mark_binding_used(token.text, env);
    }
  }
}

function mark_type_field_uses(
  fields: TypeField[],
  env: SemanticEnv,
): void {
  for (const field of fields) {
    mark_annotation_text_use(field.type_name, env);

    if (field.set_member !== undefined) {
      mark_type_expr_uses(field.set_member, env);
    }
  }
}

function mark_type_expr_uses(type: TypeExpr, env: SemanticEnv): void {
  if (type.tag === "name") {
    mark_binding_used(type.name, env);
    return;
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    mark_type_expr_uses(type.value, env);
    return;
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    mark_type_expr_uses(type.left, env);
    mark_type_expr_uses(type.right, env);
    return;
  }

  if (type.tag === "apply") {
    mark_type_expr_uses(type.func, env);
    mark_type_expr_uses(type.arg, env);
    return;
  }

  if (type.tag === "tuple") {
    for (const item of type.items) {
      mark_type_expr_uses(item, env);
    }

    return;
  }

  if (type.tag === "product") {
    for (const entry of type.entries) {
      mark_type_expr_uses(entry.type_expr, env);
    }

    return;
  }

  if (type.tag === "array") {
    mark_type_expr_uses(type.element, env);
    mark_array_length_uses(type.length, env);
    return;
  }

  if (type.tag === "arrow") {
    mark_type_expr_uses(type.param, env);
    mark_type_expr_uses(type.result, env);
  }
}

function mark_array_length_uses(
  length: ArrayLengthExpr,
  env: SemanticEnv,
): void {
  if (length.tag === "number") {
    return;
  }

  if (length.tag === "name") {
    mark_binding_used(length.name, env);
    return;
  }

  mark_array_length_uses(length.left, env);
  mark_array_length_uses(length.right, env);
}

function append_unused_binding_warnings(
  bindings: SemanticBinding[],
  diagnostics: SourceDiagnostic[],
): void {
  for (const binding of bindings) {
    const declaration = binding.declaration;

    if (
      declaration === undefined || binding.used || declaration.is_linear ||
      is_no_demand_name(declaration.name)
    ) {
      continue;
    }

    let label = "runtime";

    if (declaration.kind === "const") {
      label = "const";
    }

    diagnostics.push(source_diagnostic(
      "DUCK2003",
      "Unused " + label + " binding " + declaration.name,
      declaration,
    ));
  }
}

function bind_constness(
  env: Env,
  stmt: Extract<Stmt, { tag: "bind" }>,
  type: FrontType,
): void {
  const binding: Binding = {
    name: stmt.name,
    ic_name: stmt.name,
    type,
    is_const: stmt.kind === "const",
    is_linear: stmt.is_linear,
    value: stmt.value,
    value_env: undefined,
  };
  push_binding(env, binding);
}

function bind_assignment_constness(env: Env, name: string): void {
  push_binding(env, {
    name,
    ic_name: name,
    type: { tag: "unknown" },
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });
}

function resolve_type_name(
  name: string,
  env: SemanticEnv,
  resolving: Set<string> = new Set(),
): FrontType {
  if (name === "Unit") {
    return { tag: "atom", name: semantic_unit_atom_name };
  }

  if (name === "Type") {
    return { tag: "type" };
  }

  if (name.startsWith("#")) {
    return { tag: "atom", name: name.slice(1) };
  }

  const builtin = front_type_from_type_name(name);

  if (builtin.tag !== "unknown") {
    return builtin;
  }

  const applied = name.split(" ");
  const generic_name = applied[0];

  if (generic_name !== undefined && applied.length > 1) {
    const generic = env.declarations.get(generic_name);

    if (
      generic !== undefined && generic.params.length === applied.length - 1
    ) {
      const arguments_by_param = new Map<string, string>();

      for (let index = 0; index < generic.params.length; index += 1) {
        const param = generic.params[index];
        const argument = applied[index + 1];

        if (param !== undefined && argument !== undefined) {
          arguments_by_param.set(param, canonical_type_name(argument, env));
        }
      }

      if (generic.body.tag === "sum") {
        return {
          tag: "union_value",
          cases: generic.body.cases.map((union_case) => ({
            ...union_case,
            type_name: arguments_by_param.get(union_case.type_name) ||
              canonical_type_name(union_case.type_name, env),
          })),
        };
      }

      if (generic.body.tag === "product") {
        const fields = generic.body.fields.map((field) => ({
          ...field,
          type_name: arguments_by_param.get(field.type_name) ||
            canonical_type_name(field.type_name, env),
        }));
        return {
          tag: "struct",
          fields: fields.map((field) => field.name),
          field_types: fields,
        };
      }
    }
  }

  const record = env.records.get(name);

  if (record !== undefined) {
    const fields = record.fields.map((field) => ({
      ...field,
      type_name: canonical_type_name(field.type_name, env),
    }));
    return {
      tag: "struct",
      fields: fields.map((field) => field.name),
      field_types: fields,
    };
  }

  const declaration = env.declarations.get(name);

  if (declaration === undefined || declaration.params.length !== 0) {
    return { tag: "unknown" };
  }

  if (declaration.body.tag === "product") {
    const fields = declaration.body.fields.map((field) => ({
      ...field,
      type_name: canonical_type_name(field.type_name, env),
    }));
    return {
      tag: "struct",
      fields: fields.map((field) => field.name),
      field_types: fields,
    };
  }

  if (declaration.body.tag === "sum") {
    return {
      tag: "union_value",
      cases: declaration.body.cases.map((union_case) => ({
        ...union_case,
        type_name: canonical_type_name(union_case.type_name, env),
      })),
    };
  }

  if (declaration.body.tag === "packed") {
    let width = 0;

    for (const field of declaration.body.fields) {
      const integer = integer_type_from_name(field.type_name);
      expect(integer, "Packed field requires an integer type: " + field.name);
      width += integer.width;
    }

    return front_type_from_type_name("U" + width.toString());
  }

  if (resolving.has(name)) {
    return { tag: "unknown" };
  }

  resolving.add(name);
  return resolve_type_name(declaration.body.type_name, env, resolving);
}

function canonical_type_name(
  name: string,
  env: SemanticEnv,
  resolving: Set<string> = new Set(),
): string {
  const declaration = env.declarations.get(name);

  if (
    declaration === undefined || declaration.params.length !== 0 ||
    declaration.body.tag !== "alias" || resolving.has(name)
  ) {
    return name;
  }

  resolving.add(name);
  return canonical_type_name(declaration.body.type_name, env, resolving);
}

function validate_basic_annotation(
  stmt: Extract<Stmt, { tag: "bind" }>,
  type: FrontType,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  let annotation = stmt.annotation;

  if (
    annotation === undefined && stmt.type_annotation !== undefined &&
    stmt.type_annotation.tag === "name"
  ) {
    annotation = stmt.type_annotation.name;
  }

  if (annotation === undefined || type.tag === "unknown") {
    return;
  }

  let expected = resolve_type_name(annotation, env);

  if (
    stmt.type_annotation !== undefined &&
    function_type_expr(stmt.type_annotation) === undefined
  ) {
    expected = type_from_type_expr(stmt.type_annotation, env);
  }

  if (expected.tag === "unknown") {
    return;
  }

  if (
    expected.tag === "struct" &&
    (stmt.value.tag === "struct_value" || stmt.value.tag === "product")
  ) {
    return;
  }

  if (bool_value_representation_mismatch(expected, stmt.value, env)) {
    diagnostics.push(bool_route_diagnostic(
      "DUCK2306",
      "Binding annotation expects " + annotation + ", got " +
        type_name(type),
      stmt.value,
    ));
    return;
  }

  let matches = true;

  if (expected.tag === "bool") {
    matches = type.tag === "bool";
  } else if (expected.tag === "text") {
    if (expected.encoding === "bytes") {
      matches = type.tag === "text" && type.encoding === "bytes";
    } else {
      matches = type.tag === "text" && type.encoding !== "bytes";
    }
  } else if (expected.tag === "int") {
    matches = type.tag === "int" && type.type === expected.type;
  } else {
    return;
  }

  if (matches) {
    return;
  }

  const message = "Binding annotation expects " + annotation + ", got " +
    type_name(type);

  if (expected.tag === "text") {
    diagnostics.push(core_route_diagnostic("DUCK2306", message, stmt.value));
    return;
  }

  diagnostics.push(source_diagnostic(
    "DUCK2306",
    message,
    stmt.value,
  ));
}

function validate_fixed_array_annotation(
  stmt: Extract<Stmt, { tag: "bind" }>,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
): void {
  const annotation = stmt.type_annotation;

  if (annotation?.tag !== "array") {
    return;
  }

  let length: number;

  try {
    length = fixed_array_length(
      annotation.length,
      (name) => semantic_const_i32_name(name, env, new Set()),
    );
  } catch (error) {
    if (error instanceof Error) {
      diagnostics.push(source_diagnostic(
        "DUCK2306",
        error.message,
        stmt,
      ));
      return;
    }

    throw error;
  }

  let items: FrontExpr[];

  if (stmt.value.tag === "product") {
    items = stmt.value.entries.map((entry) => entry.value);
  } else if (stmt.value.tag === "array") {
    items = stmt.value.items;
  } else {
    return;
  }

  if (stmt.value.tag === "array" && stmt.value.rest !== undefined) {
    diagnostics.push(source_diagnostic(
      "DUCK2306",
      "Fixed array annotation " + format_type_expr(annotation) +
        " cannot use an array spread",
      stmt.value,
    ));
    return;
  }

  if (items.length !== length) {
    diagnostics.push(source_diagnostic(
      "DUCK2306",
      "Binding annotation expects " + format_type_expr(annotation) + " with " +
        length.toString() + " items, got " + items.length.toString(),
      stmt.value,
    ));
    return;
  }

  const expected = type_from_type_expr(annotation.element, env);

  if (expected.tag === "unknown") {
    return;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    expect(item, "Missing fixed array item " + index.toString());
    const actual = infer_type(item, env);

    if (same_type(actual, expected)) {
      continue;
    }

    diagnostics.push(source_diagnostic(
      "DUCK2306",
      "Binding annotation " + format_type_expr(annotation) + " item " +
        index.toString() + " expects " + type_name(expected) + ", got " +
        type_name(actual),
      item,
    ));
  }
}

function validate_type_repetition_annotation(
  type: TypeExpr | undefined,
  env: SemanticEnv,
  diagnostics: SourceDiagnostic[],
  stmt: Stmt,
): void {
  if (type === undefined) {
    return;
  }

  if (type.tag === "product") {
    if (type.repeat !== undefined) {
      try {
        value_pack_length(
          type.repeat,
          (name) => semantic_const_i32_name(name, env, new Set()),
        );
      } catch (error) {
        if (error instanceof Error) {
          diagnostics.push(source_diagnostic("DUCK2306", error.message, stmt));
        } else {
          throw error;
        }
      }
    }

    for (const entry of type.entries) {
      validate_type_repetition_annotation(
        entry.type_expr,
        env,
        diagnostics,
        stmt,
      );
    }
    return;
  }

  if (type.tag === "forall") {
    validate_type_repetition_annotation(type.body, env, diagnostics, stmt);
    return;
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    validate_type_repetition_annotation(type.value, env, diagnostics, stmt);
    return;
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    validate_type_repetition_annotation(type.left, env, diagnostics, stmt);
    validate_type_repetition_annotation(type.right, env, diagnostics, stmt);
    return;
  }

  if (type.tag === "apply") {
    validate_type_repetition_annotation(type.func, env, diagnostics, stmt);
    validate_type_repetition_annotation(type.arg, env, diagnostics, stmt);
    return;
  }

  if (type.tag === "tuple") {
    for (const item of type.items) {
      validate_type_repetition_annotation(item, env, diagnostics, stmt);
    }
    return;
  }

  if (type.tag === "array") {
    validate_type_repetition_annotation(type.element, env, diagnostics, stmt);
    return;
  }

  if (type.tag === "arrow") {
    validate_type_repetition_annotation(type.param, env, diagnostics, stmt);
    validate_type_repetition_annotation(type.result, env, diagnostics, stmt);
  }
}

function semantic_const_i32_name(
  name: string,
  env: SemanticEnv,
  resolving: Set<string>,
): number | undefined {
  if (resolving.has(name)) {
    throw new Error(
      "Recursive fixed array length: " + [...resolving, name].join(" -> "),
    );
  }

  const binding = env.bindings.get(name);

  if (
    binding?.declaration?.kind !== "const" || binding.value === undefined
  ) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(name);
  return semantic_const_i32_expr(binding.value, env, next);
}

function semantic_const_i32_expr(
  expr: FrontExpr,
  env: SemanticEnv,
  resolving: Set<string>,
): number | undefined {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    typeof expr.value === "number"
  ) {
    return expr.value;
  }

  if (expr.tag === "var") {
    return semantic_const_i32_name(expr.name, env, resolving);
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return semantic_const_i32_expr(expr.expr, env, resolving);
  }

  if (expr.tag !== "prim") {
    return undefined;
  }

  const left = semantic_const_i32_expr(expr.left, env, resolving);
  const right = semantic_const_i32_expr(expr.right, env, resolving);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (expr.prim === "i32.add") {
    return (left + right) | 0;
  }

  if (expr.prim === "i32.sub") {
    return (left - right) | 0;
  }

  if (expr.prim === "i32.mul") {
    return Math.imul(left, right);
  }

  if (expr.prim === "i32.div_s") {
    if (right === 0) {
      throw new Error("Fixed array length divides by zero");
    }

    return Math.trunc(left / right) | 0;
  }

  if (expr.prim === "i32.rem_s") {
    if (right === 0) {
      throw new Error("Fixed array length divides by zero");
    }

    return left % right;
  }

  return undefined;
}

function type_name(type: FrontType): string {
  if (type.tag === "bool") {
    return "Bool";
  }

  if (type.tag === "f32x4") {
    return "F32x4";
  }

  if (type.tag === "text") {
    if (type.encoding === "bytes") {
      return "Bytes";
    }

    return "Text";
  }

  if (type.tag === "atom") {
    if (type.name === semantic_unit_atom_name) {
      return "Unit";
    }

    return "#" + type.name;
  }

  if (type.tag === "int" && type.type === "i64") {
    return "I64";
  }

  if (type.tag === "int" && type.type === "f32") {
    return "F32";
  }

  if (type.tag === "int" && type.type === "f64") {
    return "F64";
  }

  if (type.tag === "int") {
    return "I32";
  }

  return type.tag;
}
