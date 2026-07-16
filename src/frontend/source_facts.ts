import type {
  ArrayLengthExpr,
  Declaration,
  EffectRowExpr,
  FrontExpr,
  FrontType,
  Param,
  Pattern,
  Source,
  Stmt,
  TypeExpr,
} from "./ast.ts";
import { prim_returns_bool } from "./numeric.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
} from "./semantic_diagnostic.ts";
import {
  format_type,
  scalar_representation_compatible,
  type Type,
  TypeEngine,
} from "./type_engine.ts";
import { is_builtin_type_name } from "./types.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import { f32x4_builtin_prim, numeric_builtin_prim } from "../op.ts";
import { diagnostic_codes, type DiagnosticCode } from "../diagnostic.ts";

function array_length_is_known(
  length: ArrayLengthExpr,
  type_parameters: Set<string>,
): boolean {
  if (length.tag === "number") {
    return true;
  }

  if (length.tag === "name") {
    return type_parameters.has(length.name);
  }

  return array_length_is_known(length.left, type_parameters) &&
    array_length_is_known(length.right, type_parameters);
}

type SourceAggregateTypeValue = Extract<
  FrontExpr,
  { tag: "struct_type" | "union_type" }
>;

function source_aggregate_type_value(
  value: FrontExpr,
): SourceAggregateTypeValue | undefined {
  if (
    value.tag !== "app" || value.func.tag !== "var" ||
    value.func.name !== "struct" ||
    value.arg?.tag !== "shape"
  ) {
    return undefined;
  }

  const fields = [];

  for (const entry of value.arg.entries) {
    if (entry.label === undefined) {
      return undefined;
    }

    const type_expr = source_constructor_type_expr(entry.value);

    if (type_expr === undefined) {
      return undefined;
    }

    fields.push({ name: entry.label, type_name: format_type_expr(type_expr) });
  }

  return { tag: "struct_type", fields };
}

function source_constructor_type_expr(value: FrontExpr): TypeExpr | undefined {
  if (value.tag === "var" || value.tag === "type_name") {
    return { tag: "name", name: value.name };
  }

  if (value.tag === "set_type") {
    return value.type_expr;
  }

  if (value.tag === "product") {
    const entries: Extract<TypeExpr, { tag: "product" }>["entries"] = [];

    for (const entry of value.entries) {
      const type_expr = source_constructor_type_expr(entry.value);

      if (type_expr === undefined) {
        return undefined;
      }

      entries.push({ label: entry.label, type_expr });
    }

    return { tag: "product", entries };
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    const inner = source_constructor_type_expr(value.value);

    if (inner === undefined) {
      return undefined;
    }

    if (value.tag === "borrow") {
      return { tag: "borrow", value: inner };
    }

    return { tag: "frozen", value: inner };
  }

  if (value.tag === "app") {
    let type_expr = source_constructor_type_expr(value.func);

    if (type_expr === undefined) {
      return undefined;
    }

    for (const arg of value.args) {
      const arg_type = source_constructor_type_expr(arg);

      if (arg_type === undefined) {
        return undefined;
      }

      type_expr = { tag: "apply", func: type_expr, arg: arg_type };
    }

    return type_expr;
  }

  if (value.tag === "array_repeat") {
    const element = source_constructor_type_expr(value.value);
    const length = source_constructor_array_length(value.length);

    if (element === undefined || length === undefined) {
      return undefined;
    }

    return { tag: "array", element, length };
  }

  return undefined;
}

function source_constructor_array_length(
  value: FrontExpr,
): ArrayLengthExpr | undefined {
  if (
    value.tag === "num" && value.type === "i32" &&
    typeof value.value === "number" && Number.isSafeInteger(value.value) &&
    value.value >= 0
  ) {
    return { tag: "number", value: value.value };
  }

  if (value.tag === "var") {
    return { tag: "name", name: value.name };
  }

  return undefined;
}

export type SourceFieldTypeFact = {
  name: string;
  type: SourceTypeFact | undefined;
};

export type SourceTypeSetFact = {
  operation: "union" | "intersection" | "difference";
  left: SourceTypeFact;
  right: SourceTypeFact;
};

/** A source-level type fact that keeps editor-only structure unavailable in FrontType. */
export type SourceTypeFact = {
  canonical_type: () => Type | undefined;
  name: string;
  resolved_name: string;
  nominal: string | undefined;
  call_params: (SourceTypeFact | undefined)[] | undefined;
  call_result: SourceTypeFact | undefined;
  fields: SourceFieldTypeFact[] | undefined;
  positional_fields: boolean;
  cases: Map<string, SourceTypeFact> | undefined;
  members: Map<string, SourceTypeFact> | undefined;
  constructed: SourceTypeFact | undefined;
  handler_input: SourceTypeFact | undefined;
  handler_result: SourceTypeFact | undefined;
  alias_target: SourceTypeFact | undefined;
  type_set: SourceTypeSetFact | undefined;
  inference_variable: boolean;
  quantified_variables: SourceTypeFact[] | undefined;
};

/** Small, best-effort facts safe to use while a document has syntax errors. */
export type SourceFacts = {
  type_of: WeakMap<object, FrontType>;
  nominal_of: WeakMap<object, string>;
  const_source_of: WeakMap<object, object>;
  editor_type_of: WeakMap<object, SourceTypeFact>;
  definition_type_of: WeakMap<object, Map<string, SourceTypeFact>>;
  inference_diagnostics: SourceDiagnostic[];
  expressions: FrontExpr[];
};

type Scope = Map<string, SourceTypeFact>;

type ClosureCallContext = {
  callable: SourceTypeFact;
  closure: Extract<FrontExpr, { tag: "lam" | "rec" }>;
  scope: Scope;
  calls: (SourceTypeFact | undefined)[][];
};

const cached_source_facts = new WeakMap<Source, SourceFacts>();

export function source_facts(source: Source): SourceFacts {
  const cached = cached_source_facts.get(source);

  if (cached !== undefined) {
    return cached;
  }

  const recorder = new SourceFactRecorder(source);
  const facts = recorder.record();
  cached_source_facts.set(source, facts);
  return facts;
}

export function invalidate_source_facts(source: Source): void {
  cached_source_facts.delete(source);
}

export function source_inference_diagnostics(
  source: Source,
  facts: SourceFacts,
): SourceDiagnostic[] {
  const diagnostics = [...facts.inference_diagnostics];
  const known_names = new Set<string>([
    "Bool",
    "Unit",
    "Int",
    "I32",
    "U32",
    "I64",
    "F32",
    "F32x4",
    "Text",
    "Bytes",
    "Utf8.decode",
    "Utf8.encode",
    "Resume",
    "Type",
    "bit_and",
    "bit_or",
    "bit_xor",
    "shift_left",
    "shift_right_u",
    "f32_sqrt",
    "f32_from_i32",
    "i32_from_f32",
    "f32x4",
    "f32x4_splat",
    "f32x4_add",
    "f32x4_sub",
    "f32x4_mul",
    "f32x4_div",
    "f32x4_extract_lane",
    "f32x4_replace_lane",
    "format_i32",
    "format_i64",
    "format_f32",
  ]);

  for (const declaration of source.declarations || []) {
    if (declaration.tag !== "extend" && declaration.tag !== "fixity") {
      known_names.add(declaration.name);
    }
  }

  for (const statement of source.statements) {
    let aggregate_type: SourceAggregateTypeValue | undefined;

    if (statement.tag === "bind" && statement.kind === "const") {
      aggregate_type = source_aggregate_type_value(statement.value);
    }

    if (
      statement.tag === "bind" && statement.kind === "const" &&
      (statement.value.tag === "struct_type" ||
        statement.value.tag === "union_type" || aggregate_type !== undefined)
    ) {
      known_names.add(statement.name);
    }
  }

  for (const statement of source.statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    const annotation = binding_annotation_type(statement);

    if (annotation === undefined) {
      continue;
    }

    append_unresolved_annotation_diagnostic(
      diagnostics,
      annotation,
      known_names,
      "binding " + statement.name,
      statement,
    );
  }

  return diagnostics;
}

function binding_annotation_type(
  statement: Extract<Stmt, { tag: "bind" }>,
): TypeExpr | undefined {
  if (statement.type_annotation !== undefined) {
    return statement.type_annotation;
  }

  if (statement.annotation !== undefined) {
    return { tag: "name", name: statement.annotation };
  }

  return undefined;
}

function append_unresolved_annotation_diagnostic(
  diagnostics: SourceDiagnostic[],
  annotation: TypeExpr,
  known_names: Set<string>,
  site: string,
  subject: object,
): void {
  const inference = new TypeEngine();
  const unresolved_names = new Set<string>();
  collect_unresolved_annotation_names(
    annotation,
    known_names,
    unresolved_names,
  );

  if (unresolved_names.size === 0) {
    return;
  }

  const variables = [...unresolved_names].sort().map((name) => {
    return inference.fresh_variable(name);
  });
  let type = variables[0];

  if (type === undefined) {
    throw new Error("Missing unresolved annotation variable");
  }

  if (variables.length > 1) {
    type = { tag: "named", name: "annotation", args: variables };
  }

  try {
    inference.require_resolved(type, site);
  } catch (error) {
    if (error instanceof Error) {
      diagnostics.push(source_diagnostic(
        "DUCK2311",
        error.message,
        subject,
      ));
      return;
    }

    throw error;
  }
}

function collect_unresolved_annotation_names(
  annotation: TypeExpr,
  known_names: Set<string>,
  unresolved_names: Set<string>,
): void {
  if (annotation.tag === "forall") {
    const scoped_names = new Set(known_names);

    for (const param of annotation.params) {
      scoped_names.add(param);
    }

    collect_unresolved_annotation_names(
      annotation.body,
      scoped_names,
      unresolved_names,
    );
    return;
  }

  if (annotation.tag === "name") {
    if (!known_names.has(annotation.name)) {
      unresolved_names.add(annotation.name);
    }

    return;
  }

  if (
    annotation.tag === "atom" || annotation.tag === "top" ||
    annotation.tag === "never"
  ) {
    return;
  }

  if (annotation.tag === "frozen" || annotation.tag === "borrow") {
    collect_unresolved_annotation_names(
      annotation.value,
      known_names,
      unresolved_names,
    );
    return;
  }

  if (
    annotation.tag === "union" || annotation.tag === "intersection" ||
    annotation.tag === "difference"
  ) {
    collect_unresolved_annotation_names(
      annotation.left,
      known_names,
      unresolved_names,
    );
    collect_unresolved_annotation_names(
      annotation.right,
      known_names,
      unresolved_names,
    );
    return;
  }

  if (annotation.tag === "apply") {
    collect_unresolved_annotation_names(
      annotation.func,
      known_names,
      unresolved_names,
    );
    collect_unresolved_annotation_names(
      annotation.arg,
      known_names,
      unresolved_names,
    );
    return;
  }

  if (annotation.tag === "tuple") {
    for (const item of annotation.items) {
      collect_unresolved_annotation_names(item, known_names, unresolved_names);
    }

    return;
  }

  if (annotation.tag === "product") {
    for (const entry of annotation.entries) {
      collect_unresolved_annotation_names(
        entry.type_expr,
        known_names,
        unresolved_names,
      );
    }

    return;
  }

  if (annotation.tag === "array") {
    collect_unresolved_annotation_names(
      annotation.element,
      known_names,
      unresolved_names,
    );
    return;
  }

  collect_unresolved_annotation_names(
    annotation.param,
    known_names,
    unresolved_names,
  );
  collect_unresolved_annotation_names(
    annotation.result,
    known_names,
    unresolved_names,
  );
}

class SourceFactRecorder {
  readonly facts: SourceFacts = {
    type_of: new WeakMap(),
    nominal_of: new WeakMap(),
    const_source_of: new WeakMap(),
    editor_type_of: new WeakMap(),
    definition_type_of: new WeakMap(),
    inference_diagnostics: [],
    expressions: [],
  };
  readonly declarations = new Map<string, Declaration>();
  readonly declaration_types = new Map<string, SourceTypeFact>();
  readonly applied_declaration_types = new Map<string, SourceTypeFact>();
  readonly namespaces = new Map<string, SourceTypeFact>();
  readonly case_owners = new Map<string, string[]>();
  readonly legacy_type_values = new Map<
    string,
    Extract<FrontExpr, { tag: "struct_type" | "union_type" }>
  >();
  readonly legacy_type_names = new WeakMap<object, string>();
  readonly source_aggregate_type_values = new WeakMap<
    object,
    SourceAggregateTypeValue
  >();
  readonly recorded_expressions = new WeakSet<object>();
  readonly return_type_stack: (SourceTypeFact | undefined)[][] = [];
  readonly validating_effects = new Set<string>();
  readonly closure_call_contexts = new WeakMap<
    SourceTypeFact,
    ClosureCallContext
  >();
  readonly closure_calls: ClosureCallContext[] = [];
  replaying_closure = false;

  constructor(readonly source: Source) {
    if (source.declarations !== undefined) {
      for (const declaration of source.declarations) {
        if (declaration.tag === "extend" || declaration.tag === "fixity") {
          continue;
        }

        this.declarations.set(declaration.name, declaration);

        if (declaration.tag === "type" && declaration.body.tag === "sum") {
          for (const union_case of declaration.body.cases) {
            this.add_case_owner(union_case.name, declaration.name);
          }
        }
      }
    }

    for (const statement of source.statements) {
      let value: SourceAggregateTypeValue | undefined;

      if (statement.tag === "bind" && statement.kind === "const") {
        value = source_aggregate_type_value(statement.value);

        if (value !== undefined) {
          this.source_aggregate_type_values.set(statement.value, value);
        }
      }

      if (
        statement.tag !== "bind" || statement.kind !== "const" ||
        (statement.value.tag !== "struct_type" &&
          statement.value.tag !== "union_type" && value === undefined)
      ) {
        continue;
      }

      if (value === undefined) {
        value = statement.value as SourceAggregateTypeValue;
      }

      this.legacy_type_values.set(statement.name, value);
      this.legacy_type_names.set(value, statement.name);

      if (value.tag === "union_type") {
        for (const union_case of value.cases) {
          this.add_case_owner(union_case.name, statement.name);
        }
      }
    }
  }

  add_case_owner(case_name: string, owner: string): void {
    let owners = this.case_owners.get(case_name);

    if (owners === undefined) {
      owners = [];
      this.case_owners.set(case_name, owners);
    }

    owners.push(owner);
  }

  record(): SourceFacts {
    const scope: Scope = new Map();

    for (const declaration of this.declarations.values()) {
      if (declaration.tag === "extend" || declaration.tag === "fixity") {
        continue;
      }

      scope.set(declaration.name, this.namespace_for(declaration.name));
    }

    this.record_declaration_definitions();

    if (this.source.module !== undefined) {
      for (const param of this.source.module.params) {
        const type = this.parameter_type(param);
        this.record_definition(param, "name", type);

        if (type !== undefined) {
          scope.set(param.name, type);
        }
      }
    }

    this.record_statements(this.source.statements, scope, undefined);
    this.record_called_closures();
    return this.facts;
  }

  record_called_closures(): void {
    this.replaying_closure = true;

    try {
      for (const context of this.closure_calls) {
        if (context.calls.length === 0) {
          continue;
        }

        const parameter_types: SourceTypeFact[] = [];
        let needs_inference = false;

        for (let index = 0; index < context.closure.params.length; index += 1) {
          const param = context.closure.params[index];

          if (param === undefined) {
            throw new Error("Missing source closure parameter " + index);
          }

          const annotated = this.parameter_type(param);

          if (annotated !== undefined) {
            parameter_types.push(annotated);
            continue;
          }

          needs_inference = true;
          const observed_types = context.calls.map((call) => call[index]);
          const inferred = common_type_facts(observed_types);

          if (inferred === undefined) {
            parameter_types.length = 0;
            break;
          }

          if (
            observed_types.some((observed) =>
              observed === undefined || observed.name !== inferred.name
            )
          ) {
            parameter_types.length = 0;
            break;
          }

          if (!source_type_fact_is_resolved(inferred)) {
            parameter_types.length = 0;
            break;
          }

          parameter_types.push(inferred);
        }

        if (
          !needs_inference ||
          parameter_types.length !== context.closure.params.length
        ) {
          continue;
        }

        const callable = this.record_closure(
          context.closure,
          new Map(context.scope),
          undefined,
          undefined,
          parameter_types,
        );

        if (
          callable === undefined || callable.call_params === undefined ||
          callable.call_result === undefined
        ) {
          continue;
        }

        context.callable.call_params = callable.call_params;
        context.callable.call_result = callable.call_result;
      }
    } finally {
      this.replaying_closure = false;
    }
  }

  record_declaration_definitions(): void {
    for (const declaration of this.declarations.values()) {
      if (declaration.tag === "extend" || declaration.tag === "fixity") {
        continue;
      }

      const namespace = this.namespace_for(declaration.name);

      if (declaration.tag === "effect") {
        for (const operation of declaration.operations) {
          this.record_definition(
            operation,
            "name",
            namespace.members?.get(operation.name),
          );
        }

        continue;
      }

      if (declaration.tag === "record") {
        for (const field of declaration.fields) {
          this.record_definition(
            field,
            "name",
            namespace.members?.get(field.name),
          );
        }

        continue;
      }

      if (declaration.tag === "duck") {
        for (const member of declaration.members) {
          this.record_definition(
            member,
            "name",
            namespace.members?.get(member.name),
          );
        }

        continue;
      }

      if (declaration.tag === "type" && declaration.body.tag === "product") {
        for (const field of declaration.body.fields) {
          this.record_definition(
            field,
            "name",
            namespace.members?.get(field.name),
          );
        }
      } else if (
        declaration.tag === "type" && declaration.body.tag === "sum"
      ) {
        for (const union_case of declaration.body.cases) {
          this.record_definition(
            union_case,
            "name",
            namespace.members?.get(union_case.name),
          );
        }
      }
    }
  }

  record_statements(
    statements: Stmt[],
    scope: Scope,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    let result: SourceTypeFact | undefined = unit_type();
    let returned = false;
    let unreachable_scope: Scope | undefined;

    for (const statement of statements) {
      if (returned) {
        if (unreachable_scope === undefined) {
          unreachable_scope = new Map(scope);
        }

        this.return_type_stack.push([]);

        try {
          this.record_statement(statement, unreachable_scope, undefined);
        } finally {
          this.return_type_stack.pop();
        }

        continue;
      }

      result = this.record_statement(statement, scope, break_types);

      if (statement_returns(statement)) {
        returned = true;
      }
    }

    return result;
  }

  record_statement(
    statement: Stmt,
    scope: Scope,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    if (statement.tag === "bind") {
      const declared = this.type_from_annotation(
        statement.annotation,
        statement.type_annotation,
      );

      if (statement.is_recursive && declared !== undefined) {
        scope.set(statement.name, declared);
      }

      let inferred = this.record_expr(
        statement.value,
        scope,
        declared,
        break_types,
      );

      if (
        declared === undefined && statement.kind === "const" &&
        (statement.value.tag === "lam" || statement.value.tag === "rec") &&
        inferred !== undefined
      ) {
        inferred = generalize_const_source_type(inferred, scope);
      }

      let definition_type = inferred;
      let scope_type = inferred;

      if (declared !== undefined) {
        if (
          declared.quantified_variables !== undefined &&
          (inferred === undefined ||
            !source_types_compatible(declared, inferred))
        ) {
          this.facts.inference_diagnostics.push(source_diagnostic(
            "DUCK2312",
            "Binding " + statement.name +
              " does not satisfy polymorphic annotation " + declared.name,
            statement.value,
          ));
        }

        if (
          inferred !== undefined &&
          source_types_compatible(declared, inferred)
        ) {
          definition_type = declared;
          scope_type = declared;
        } else {
          definition_type = named_type("unknown");
          scope_type = definition_type;
        }
      }

      this.record_definition(statement, "name", definition_type);

      if (statement.pattern !== undefined) {
        this.record_pattern_bindings(statement.pattern, scope_type, scope);
      }

      if (scope_type !== undefined) {
        scope.set(statement.name, scope_type);
      }

      if (statement.annotation !== undefined) {
        this.facts.nominal_of.set(statement, statement.annotation);
        this.facts.nominal_of.set(statement.value, statement.annotation);
      }

      if (
        statement.type_annotation !== undefined &&
        statement.type_annotation.tag === "name"
      ) {
        this.facts.nominal_of.set(
          statement,
          statement.type_annotation.name,
        );
        this.facts.nominal_of.set(
          statement.value,
          statement.type_annotation.name,
        );
      }

      if (statement.kind === "const") {
        this.facts.const_source_of.set(statement, statement.value);
      }

      return scope_type;
    }

    if (statement.tag === "state_bind") {
      const type = this.record_expr(
        statement.value,
        scope,
        undefined,
        break_types,
      );

      if (statement.value_name !== undefined) {
        this.record_definition(statement, "value_name", type);

        if (type !== undefined) {
          scope.set(statement.value_name, type);
        }
      }

      return type;
    }

    if (statement.tag === "bind_pattern") {
      const type = this.record_expr(
        statement.value,
        scope,
        undefined,
        break_types,
      );

      for (let index = 0; index < statement.items.length; index += 1) {
        const binding = statement.items[index];

        if (binding === undefined) {
          throw new Error("Missing source pattern binding " + index);
        }

        let binding_type: SourceTypeFact | undefined;

        const fields = source_fields(type);

        if (fields !== undefined) {
          const named = fields.find((field) => field.name === binding.name);

          if (named !== undefined) {
            binding_type = named.type;
          } else if (source_fields_are_positional(type)) {
            binding_type = fields[index]?.type;
          }
        }

        if (binding_type === undefined) {
          binding_type = named_type("unknown");
        }

        this.record_definition(binding, "name", binding_type);

        if (binding_type !== undefined) {
          scope.set(binding.name, binding_type);
        }
      }

      return type;
    }

    if (statement.tag === "resume_dup") {
      const type = this.record_expr(
        statement.value,
        scope,
        undefined,
        break_types,
      );
      this.record_definition(statement, "left", type);
      this.record_definition(statement, "right", type);

      if (type !== undefined) {
        scope.set(statement.left, type);
        scope.set(statement.right, type);
      }

      return type;
    }

    if (statement.tag === "assign") {
      const previous = scope.get(statement.name);
      const type = this.record_expr(
        statement.value,
        scope,
        previous,
        break_types,
      );

      if (statement.mode === "same" && previous !== undefined) {
        if (type !== undefined && source_types_compatible(previous, type)) {
          this.record_definition(statement, "name", previous);
          return previous;
        }

        this.record_definition(statement, "name", named_type("unknown"));
        return undefined;
      }

      this.record_definition(statement, "name", type);

      if (type !== undefined) {
        scope.set(statement.name, type);
      }

      return type;
    }

    if (statement.tag === "index_assign") {
      this.record_expr(statement.index, scope, undefined, break_types);
      return this.record_expr(statement.value, scope, undefined, break_types);
    }

    if (statement.tag === "expr") {
      return this.record_expr(statement.expr, scope, undefined, break_types);
    }

    if (statement.tag === "return") {
      const type = this.record_expr(
        statement.value,
        scope,
        undefined,
        break_types,
      );
      const return_types = this.return_type_stack.at(-1);

      if (return_types !== undefined) {
        return_types.push(type);
      }

      return type;
    }

    if (statement.tag === "if_stmt") {
      this.record_expr(statement.cond, scope, undefined, break_types);
      this.record_statements(statement.body, new Map(scope), break_types);
      return unit_type();
    }

    if (statement.tag === "if_let_stmt") {
      const target = this.record_expr(
        statement.target,
        scope,
        undefined,
        break_types,
      );
      const branch = new Map(scope);
      const payload = this.union_payload_type(target, statement.case_name);

      if (statement.value_name !== undefined) {
        if (payload !== undefined && payload.resolved_name !== "Unit") {
          this.record_definition(statement, "value_name", payload);
          branch.set(statement.value_name, payload);
        } else {
          this.record_definition(
            statement,
            "value_name",
            named_type("unknown"),
          );
        }
      }

      this.record_statements(statement.body, branch, break_types);
      return unit_type();
    }

    if (statement.tag === "for_range") {
      const start = this.record_expr(
        statement.start,
        scope,
        undefined,
        break_types,
      );
      const end = this.record_expr(
        statement.end,
        scope,
        undefined,
        break_types,
      );
      const step = this.record_expr(
        statement.step,
        scope,
        undefined,
        break_types,
      );
      const body = new Map(scope);
      let index_type = named_type("unknown");

      if (
        start !== undefined && end !== undefined && step !== undefined &&
        is_i32_family(start) && is_i32_family(end) && is_i32_family(step)
      ) {
        index_type = named_type("I32");
      }

      this.record_definition(statement, "index", index_type);
      body.set(statement.index, index_type);
      this.record_statements(statement.body, body, break_types);
      return unit_type();
    }

    if (statement.tag === "for_collection") {
      const collection = this.record_expr(
        statement.collection,
        scope,
        undefined,
        break_types,
      );
      const body = new Map(scope);

      if (
        collection !== undefined && is_type_variable(collection) &&
        statement.body.some((body_statement) =>
          uses_shape_entry_projection(body_statement, statement.item)
        )
      ) {
        Object.assign(collection, shape_type());
      }

      if (statement.index !== undefined) {
        const index_type = named_type("I32");
        this.record_definition(statement, "index", index_type);
        body.set(statement.index, index_type);
      }

      let element = this.homogeneous_field_type(collection);

      if (
        collection !== undefined &&
        (collection.resolved_name === "Text" ||
          collection.resolved_name === "Bytes")
      ) {
        element = named_type("I32");
      }
      this.record_definition(statement, "item", element);

      if (element !== undefined) {
        body.set(statement.item, element);
      }

      this.record_statements(statement.body, body, break_types);
      return unit_type();
    }

    if (statement.tag === "type_check") {
      this.record_expr(statement.target, scope, undefined, break_types);
      return unit_type();
    }

    if (statement.tag === "break") {
      let type: SourceTypeFact | undefined = unit_type();

      if (statement.value !== undefined) {
        type = this.record_expr(
          statement.value,
          scope,
          undefined,
          break_types,
        );
      }

      if (break_types !== undefined) {
        break_types.push(type);
      }

      return type;
    }

    return unit_type();
  }

  record_expr(
    expr: FrontExpr,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    this.record_expression(expr);
    let type: SourceTypeFact | undefined;

    if (expr.tag === "bool") {
      type = named_type("Bool");
    } else if (expr.tag === "num") {
      if (expr.type === "i64") {
        type = named_type("I64");
      } else if (expr.type === "f32") {
        type = named_type("F32");
      } else {
        type = named_type("I32");
      }
    } else if (expr.tag === "text") {
      if (expr.encoding === "bytes") {
        type = named_type("Bytes");
      } else {
        type = named_type("Text");
      }
    } else if (expr.tag === "unit") {
      type = unit_type();
    } else if (expr.tag === "atom") {
      type = named_type("#" + expr.name);
    } else if (expr.tag === "var" || expr.tag === "linear") {
      type = scope.get(expr.name);

      if (
        type !== undefined && expected !== undefined &&
        is_type_variable(type) && !is_type_variable(expected)
      ) {
        Object.assign(type, expected);
      }

      if (type === undefined && expr.resume_signature !== undefined) {
        type = callable_type(
          "Resume",
          [this.type_from_name(expr.resume_signature.input_type)],
          this.type_from_name(expr.resume_signature.output_type),
        );
      }
    } else if (expr.tag === "type_name") {
      type = this.namespace_for(expr.name);
      this.facts.nominal_of.set(expr, expr.name);
    } else if (expr.tag === "set_type") {
      type = named_type("Type");
    } else if (expr.tag === "struct_type" || expr.tag === "union_type") {
      type = this.type_value_namespace(expr);
    } else if (expr.tag === "shape") {
      for (const entry of expr.entries) {
        this.record_expr(entry.value, scope, undefined, break_types);
      }

      type = shape_type();
    } else if (expr.tag === "array") {
      for (const item of expr.items) {
        this.record_expr(item, scope, undefined, break_types);
      }

      if (expr.rest !== undefined) {
        const rest = this.record_expr(
          expr.rest,
          scope,
          expected,
          break_types,
        );

        if (
          rest?.resolved_name === "StructSlots" ||
          rest?.resolved_name === "StructMethods"
        ) {
          type = rest;
        }
      }

      if (type === undefined && expected !== undefined) {
        if (
          expected.resolved_name === "StructSlots" ||
          expected.resolved_name === "StructMethods"
        ) {
          type = expected;
        }
      }

      if (type === undefined) {
        type = named_type("Product");
      }
    } else if (expr.tag === "array_repeat") {
      this.record_expr(expr.value, scope, undefined, break_types);
      this.record_expr(
        expr.length,
        scope,
        named_type("I32"),
        break_types,
      );
      type = named_type("Product");
    } else if (expr.tag === "prim") {
      type = this.record_primitive(expr, scope, break_types);
    } else if (expr.tag === "lam" || expr.tag === "rec") {
      type = this.record_closure(expr, scope, expected, break_types);

      if (type !== undefined && !this.replaying_closure) {
        const context: ClosureCallContext = {
          callable: type,
          closure: expr,
          scope: new Map(scope),
          calls: [],
        };
        this.closure_call_contexts.set(type, context);
        this.closure_calls.push(context);
      }
    } else if (expr.tag === "app") {
      let aggregate_type = this.source_aggregate_type_values.get(expr);

      if (aggregate_type === undefined) {
        aggregate_type = source_aggregate_type_value(expr);
      }

      if (aggregate_type !== undefined) {
        type = this.type_value_namespace(aggregate_type);
        this.store_expr_type(expr, type);
        return type;
      }

      const func = this.record_expr(expr.func, scope, undefined, break_types);
      const args: (SourceTypeFact | undefined)[] = [];
      const builtin = this.builtin_call_name(expr, scope);

      for (let index = 0; index < expr.args.length; index += 1) {
        const arg = expr.args[index];

        if (arg === undefined) {
          throw new Error("Missing source call argument " + index);
        }

        let expected_arg: SourceTypeFact | undefined;

        if (builtin === "Bytes.generate") {
          if (index === 0) {
            expected_arg = named_type("I32");
          } else if (index === 1) {
            expected_arg = callable_type(
              "Bytes.generate callback",
              [named_type("I32")],
              named_type("I32"),
            );
          }
        } else if (builtin === "Utf8.encode") {
          expected_arg = named_type("Text");
        } else if (builtin === "Utf8.decode") {
          expected_arg = named_type("Bytes");
        } else if (builtin === "format_i32") {
          expected_arg = named_type("I32");
        } else if (builtin === "format_i64") {
          expected_arg = named_type("I64");
        } else if (builtin === "format_f32") {
          if (index === 0) {
            expected_arg = named_type("F32");
          } else if (index === 1) {
            expected_arg = named_type("I32");
          }
        } else if (builtin === "@shape.entries") {
          expected_arg = named_type("Shape");
        } else if (builtin === "@type.product") {
          expected_arg = named_type("StructSlots");
        } else if (builtin === "@type.namespace") {
          expected_arg = type_namespace_argument_type();
        } else if (
          builtin === undefined && func !== undefined &&
          func.call_params !== undefined
        ) {
          expected_arg = func.call_params[index];
        }

        args.push(this.record_expr(arg, scope, expected_arg, break_types));
      }

      if (func !== undefined && !this.replaying_closure) {
        const context = this.closure_call_contexts.get(func);

        if (
          context !== undefined &&
          args.length === context.closure.params.length
        ) {
          context.calls.push(args);
        }
      }

      if (builtin !== undefined) {
        type = builtin_call_result(builtin, args);
      } else if (func !== undefined) {
        let inferred_callable = false;

        if (
          is_type_variable(func) &&
          func.call_params === undefined
        ) {
          func.call_params = args;
          func.call_result = inference_type();
          inferred_callable = true;
        }

        if (inferred_callable) {
          type = func.call_result;
        } else {
          type = this.specialize_call_result(func, args, expr);
        }
      }
    } else if (expr.tag === "block") {
      type = this.record_statements(
        expr.statements,
        new Map(scope),
        break_types,
      );
    } else if (expr.tag === "loop") {
      const loop_breaks: (SourceTypeFact | undefined)[] = [];
      this.record_statements(expr.body, new Map(scope), loop_breaks);
      const loop_result = common_type_facts(loop_breaks);

      if (loop_result !== undefined && is_supported_loop_result(loop_result)) {
        type = loop_result;
      }
    } else if (expr.tag === "comptime" || expr.tag === "captured") {
      type = this.record_expr(expr.expr, scope, expected, break_types);
    } else if (expr.tag === "borrow" || expr.tag === "freeze") {
      type = this.record_expr(expr.value, scope, expected, break_types);
    } else if (expr.tag === "scratch") {
      type = this.record_expr(expr.body, new Map(scope), expected, break_types);
    } else if (expr.tag === "if") {
      type = this.record_if(expr, scope, expected, break_types);
    } else if (expr.tag === "if_let") {
      type = this.record_if_let(expr, scope, expected, break_types);
    } else if (expr.tag === "match") {
      type = this.record_match(expr, scope, expected, break_types);
    } else if (expr.tag === "field") {
      type = this.record_field(expr, scope, break_types);
    } else if (expr.tag === "index") {
      type = this.record_index(expr, scope, break_types);
    } else if (expr.tag === "product") {
      type = this.record_product(expr, scope, expected, break_types);
    } else if (expr.tag === "struct_value") {
      type = this.record_struct_value(expr, scope, expected, break_types);
    } else if (expr.tag === "struct_update") {
      type = this.record_struct_update(expr, scope, expected, break_types);
    } else if (expr.tag === "with") {
      type = this.record_struct_update(expr, scope, expected, break_types);
    } else if (expr.tag === "type_with") {
      this.record_expr(expr.base, scope, named_type("Type"), break_types);

      for (const member of expr.members) {
        this.record_expr(
          member.name,
          scope,
          named_type("Text"),
          break_types,
        );
        this.record_expr(
          member.value,
          scope,
          callable_type(
            "type namespace member",
            [named_type("Product")],
            inference_type(),
          ),
          break_types,
        );
      }

      type = named_type("Type");
    } else if (expr.tag === "union_case") {
      type = this.record_union_case(expr, scope, expected, break_types);
    } else if (expr.tag === "as") {
      type = this.type_from_type_expr(expr.type_expr);
      this.record_expr(expr.value, scope, type, break_types);
    } else if (expr.tag === "is") {
      this.record_expr(expr.value, scope, undefined, break_types);

      if (this.type_expr_is_known(expr.type_expr, new Set(), new Set())) {
        type = named_type("Bool");
      }
    } else if (expr.tag === "handler") {
      type = this.record_handler(expr, scope, expected, break_types);
    } else if (expr.tag === "try_with") {
      const body = this.record_expr(
        expr.body,
        scope,
        undefined,
        break_types,
      );
      const handler = this.record_expr(
        expr.handler,
        scope,
        undefined,
        break_types,
      );

      if (
        body !== undefined && handler !== undefined &&
        handler.handler_input !== undefined &&
        handler.handler_result !== undefined
      ) {
        const callable = callable_type(
          "handler",
          [handler.handler_input],
          handler.handler_result,
        );
        type = this.specialize_call_result(callable, [body], expr);
      }
    }

    if (type === undefined) {
      this.store_expr_type(expr, named_type("unknown"));
    } else {
      this.store_expr_type(expr, type);
    }

    return type;
  }

  specialize_call_result(
    func: SourceTypeFact,
    args: (SourceTypeFact | undefined)[],
    subject: object,
  ): SourceTypeFact | undefined {
    const exact_error = exact_call_constraint_error(func, args);

    if (exact_error !== undefined) {
      let code: DiagnosticCode = diagnostic_codes.unresolved_call_type;
      if (exact_error.rank_n) {
        code = diagnostic_codes.rank_n_type_mismatch;
      }

      this.facts.inference_diagnostics.push(source_diagnostic(
        code,
        exact_error.message,
        subject,
      ));
      return undefined;
    }

    return specialize_call_result(func, args);
  }

  builtin_call_name(
    expr: Extract<FrontExpr, { tag: "app" }>,
    scope: Scope,
  ): string | undefined {
    if (expr.func.tag !== "var" || scope.has(expr.func.name)) {
      return undefined;
    }

    if (
      expr.func.name === "len" || expr.func.name === "get" ||
      expr.func.name === "slice" || expr.func.name === "append" ||
      expr.func.name === "Bytes.generate" ||
      expr.func.name === "Utf8.encode" ||
      expr.func.name === "Utf8.decode" ||
      expr.func.name === "format_i32" || expr.func.name === "format_i64" ||
      expr.func.name === "format_f32" ||
      expr.func.name === "@shape.entries" ||
      expr.func.name === "@type.product" ||
      expr.func.name === "@type.namespace" ||
      expr.func.name === "describe_type" ||
      expr.func.name === "describe_fields" ||
      expr.func.name === "describe_cases" || expr.func.name === "construct" ||
      expr.func.name === "project" || expr.func.name === "is_case" ||
      f32x4_builtin_prim(expr.func.name) !== undefined ||
      numeric_builtin_prim(expr.func.name) !== undefined
    ) {
      return expr.func.name;
    }

    return undefined;
  }

  type_expr_is_known(
    type: TypeExpr,
    type_parameters: Set<string>,
    resolving: Set<string>,
  ): boolean {
    if (type.tag === "forall") {
      const scoped_parameters = new Set(type_parameters);

      for (const param of type.params) {
        scoped_parameters.add(param);
      }

      return this.type_expr_is_known(
        type.body,
        scoped_parameters,
        resolving,
      );
    }

    if (type.tag === "name") {
      if (type_parameters.has(type.name)) {
        return true;
      }

      if (type.name === "Type" || is_builtin_type_name(type.name)) {
        return true;
      }

      const legacy = this.legacy_type_values.get(type.name);

      if (legacy !== undefined) {
        return this.legacy_type_value_is_known(
          type.name,
          legacy,
          resolving,
        );
      }

      const declaration = this.declarations.get(type.name);

      if (
        declaration === undefined ||
        (declaration.tag !== "record" && declaration.tag !== "type") ||
        (declaration.tag === "type" && declaration.params.length !== 0)
      ) {
        return false;
      }

      return this.declaration_type_is_known(declaration, resolving);
    }

    if (type.tag === "atom" || type.tag === "top" || type.tag === "never") {
      return true;
    }

    if (type.tag === "frozen" || type.tag === "borrow") {
      return this.type_expr_is_known(type.value, type_parameters, resolving);
    }

    if (
      type.tag === "union" || type.tag === "intersection" ||
      type.tag === "difference"
    ) {
      return this.type_expr_is_known(type.left, type_parameters, resolving) &&
        this.type_expr_is_known(type.right, type_parameters, resolving);
    }

    if (type.tag === "apply") {
      const applied = applied_type_expr(type);
      const declaration = this.declarations.get(applied.name);

      if (
        declaration === undefined || declaration.tag !== "type" ||
        declaration.params.length !== applied.args.length ||
        !this.declaration_type_is_known(declaration, resolving)
      ) {
        return false;
      }

      for (const arg of applied.args) {
        if (!this.type_expr_is_known(arg, type_parameters, resolving)) {
          return false;
        }
      }

      return true;
    }

    if (type.tag === "tuple") {
      for (const item of type.items) {
        if (!this.type_expr_is_known(item, type_parameters, resolving)) {
          return false;
        }
      }

      return true;
    }

    if (type.tag === "product") {
      for (const entry of type.entries) {
        if (
          !this.type_expr_is_known(
            entry.type_expr,
            type_parameters,
            resolving,
          )
        ) {
          return false;
        }
      }

      return true;
    }

    if (type.tag === "array") {
      if (!this.type_expr_is_known(type.element, type_parameters, resolving)) {
        return false;
      }

      return array_length_is_known(type.length, type_parameters);
    }

    if (type.tag !== "arrow") {
      const unreachable: never = type;
      void unreachable;
      throw new Error("Unknown type expression");
    }

    if (!this.type_expr_is_known(type.param, type_parameters, resolving)) {
      return false;
    }

    if (!this.type_expr_is_known(type.result, type_parameters, resolving)) {
      return false;
    }

    if (type.effects === undefined) {
      return true;
    }

    return this.effect_row_is_known(type.effects);
  }

  declaration_type_is_known(
    declaration: Extract<Declaration, { tag: "record" | "type" }>,
    resolving: Set<string>,
  ): boolean {
    if (resolving.has(declaration.name)) {
      return true;
    }

    const next = new Set(resolving);
    next.add(declaration.name);
    const type_parameters = new Set<string>();

    if (declaration.tag === "type") {
      for (const param of declaration.params) {
        type_parameters.add(param);
      }
    }

    let type_names: string[];

    if (declaration.tag === "record") {
      type_names = declaration.fields.map((field) => field.type_name);
    } else if (declaration.body.tag === "alias") {
      type_names = [declaration.body.type_name];
    } else if (declaration.body.tag === "product") {
      type_names = declaration.body.fields.map((field) => field.type_name);
    } else {
      type_names = declaration.body.cases.map((union_case) =>
        union_case.type_name
      );
    }

    for (const type_name of type_names) {
      const type_expr = parse_type_expr(tokenize(type_name));

      if (!this.type_expr_is_known(type_expr, type_parameters, next)) {
        return false;
      }
    }

    return true;
  }

  legacy_type_value_is_known(
    name: string,
    value: Extract<FrontExpr, { tag: "struct_type" | "union_type" }>,
    resolving: Set<string>,
  ): boolean {
    if (resolving.has(name)) {
      return true;
    }

    const next = new Set(resolving);
    next.add(name);
    let type_names: string[];

    if (value.tag === "struct_type") {
      type_names = value.fields.map((field) => field.type_name);
    } else {
      type_names = value.cases.map((union_case) => union_case.type_name);
    }

    for (const type_name of type_names) {
      const type_expr = parse_type_expr(tokenize(type_name));

      if (!this.type_expr_is_known(type_expr, new Set(), next)) {
        return false;
      }
    }

    return true;
  }

  effect_row_is_known(row: EffectRowExpr): boolean {
    if (row.tag === "family") {
      const declaration = this.declarations.get(row.name);
      return declaration !== undefined && declaration.tag === "effect" &&
        this.effect_declaration_is_known(declaration);
    }

    if (row.tag === "operation") {
      const declaration = this.declarations.get(row.effect);

      if (declaration === undefined || declaration.tag !== "effect") {
        return false;
      }

      return this.effect_declaration_is_known(declaration) &&
        declaration.operations.some((operation) =>
          operation.name === row.operation
        );
    }

    if (row.tag === "variable") {
      return false;
    }

    if (row.tag === "group") {
      return this.effect_row_is_known(row.value);
    }

    return this.effect_row_is_known(row.left) &&
      this.effect_row_is_known(row.right);
  }

  effect_declaration_is_known(
    declaration: Extract<Declaration, { tag: "effect" }>,
  ): boolean {
    if (this.validating_effects.has(declaration.name)) {
      return true;
    }

    this.validating_effects.add(declaration.name);

    try {
      for (const operation of declaration.operations) {
        for (const param of operation.params) {
          if (
            !declaration.params.includes(param.type_name) &&
            is_error_type(this.type_from_name(param.type_name))
          ) {
            return false;
          }
        }

        if (
          !declaration.params.includes(operation.result.type_name) &&
          is_error_type(this.type_from_name(operation.result.type_name))
        ) {
          return false;
        }
      }
    } finally {
      this.validating_effects.delete(declaration.name);
    }

    return true;
  }

  record_primitive(
    expr: Extract<FrontExpr, { tag: "prim" }>,
    scope: Scope,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const left = this.record_expr(expr.left, scope, undefined, break_types);
    const right = this.record_expr(expr.right, scope, undefined, break_types);

    if (left === undefined || right === undefined) {
      return undefined;
    }

    if (prim_returns_bool(expr.prim)) {
      if (compatible_equality_operands(expr.prim, left, right)) {
        return named_type("Bool");
      }

      return undefined;
    }

    if (same_numeric_type_family(left, right)) {
      return left;
    }

    return undefined;
  }

  record_closure(
    expr: Extract<FrontExpr, { tag: "lam" | "rec" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
    inferred_params?: SourceTypeFact[],
  ): SourceTypeFact | undefined {
    const declared_expected = expected;

    if (
      expected !== undefined &&
      expected.quantified_variables !== undefined
    ) {
      expected = skolemize_quantified_source_type(expected);
    }

    const body_scope = new Map(scope);
    const params: (SourceTypeFact | undefined)[] = [];
    let context_matches = true;
    let contextual_arity_matches = true;
    let valid = true;

    if (
      expected !== undefined && expected.call_params !== undefined &&
      expected.call_params.length !== expr.params.length
    ) {
      context_matches = false;
      contextual_arity_matches = false;
    }

    for (let index = 0; index < expr.params.length; index += 1) {
      const param = expr.params[index];

      if (param === undefined) {
        throw new Error("Missing source closure parameter " + index);
      }

      let type = this.parameter_type(param);
      let contextual: SourceTypeFact | undefined;

      if (
        contextual_arity_matches && expected !== undefined &&
        expected.call_params !== undefined
      ) {
        contextual = expected.call_params[index];
      }

      if (
        type === undefined && inferred_params !== undefined &&
        inferred_params[index] !== undefined
      ) {
        type = inferred_params[index];
      }

      if (
        type !== undefined && contextual !== undefined &&
        (!source_types_compatible(contextual, type) ||
          !source_types_compatible(type, contextual))
      ) {
        context_matches = false;
      }

      if (!contextual_arity_matches) {
        type = named_type("unknown");
      } else if (type === undefined) {
        type = contextual;
      }

      if (type === undefined) {
        type = inference_type();
      }

      if (is_error_type(type)) {
        valid = false;
      }

      params.push(type);
      this.record_definition(param, "name", type);

      if (type !== undefined) {
        body_scope.set(param.name, type);
      }
    }

    const return_types: (SourceTypeFact | undefined)[] = [];
    this.return_type_stack.push(return_types);
    let contextual_result: SourceTypeFact | undefined;

    if (contextual_arity_matches && expected !== undefined) {
      contextual_result = expected.call_result;
    }

    let result = this.record_expr(
      expr.body,
      body_scope,
      contextual_result,
      break_types,
    );
    this.return_type_stack.pop();

    if (return_types.length > 0) {
      result = common_type_facts([...return_types, result]);
    }

    if (result !== undefined && is_error_type(result)) {
      valid = false;
    }

    if (
      context_matches && expected !== undefined &&
      expected.call_params !== undefined && expected.call_result !== undefined
    ) {
      if (
        result !== undefined &&
        source_types_compatible(expected.call_result, result)
      ) {
        if (declared_expected !== undefined) {
          return declared_expected;
        }

        return expected;
      }
    }

    if (
      declared_expected?.quantified_variables !== undefined &&
      result !== undefined
    ) {
      return callable_type("non-polymorphic function", params, result);
    }

    if (expected !== undefined || !valid) {
      return callable_type("unknown", params, undefined);
    }

    return callable_type("function", params, result);
  }

  record_if(
    expr: Extract<FrontExpr, { tag: "if" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const condition = this.record_expr(
      expr.cond,
      scope,
      undefined,
      break_types,
    );
    const then_type = this.record_expr(
      expr.then_branch,
      new Map(scope),
      expected,
      break_types,
    );
    const else_type = this.record_expr(
      expr.else_branch,
      new Map(scope),
      expected,
      break_types,
    );

    if (condition === undefined || !is_condition_type(condition)) {
      return undefined;
    }

    return common_type_facts([then_type, else_type]);
  }

  record_if_let(
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const target = this.record_expr(
      expr.target,
      scope,
      undefined,
      break_types,
    );
    const then_scope = new Map(scope);
    const payload = this.union_payload_type(target, expr.case_name);
    const cases = source_cases(target);
    let valid = cases !== undefined && cases.has(expr.case_name);

    if (expr.value_name !== undefined) {
      if (payload !== undefined && payload.resolved_name !== "Unit") {
        this.record_definition(expr, "value_name", payload);
        then_scope.set(expr.value_name, payload);
      } else {
        this.record_definition(expr, "value_name", named_type("unknown"));
        valid = false;
      }
    }

    const then_type = this.record_expr(
      expr.then_branch,
      then_scope,
      expected,
      break_types,
    );
    const else_type = this.record_expr(
      expr.else_branch,
      new Map(scope),
      expected,
      break_types,
    );

    if (!valid) {
      return undefined;
    }

    return common_type_facts([then_type, else_type]);
  }

  record_match(
    expr: Extract<FrontExpr, { tag: "match" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const literal_types: SourceTypeFact[] = [];

    for (const arm of expr.arms) {
      if (arm.pattern.tag !== "literal") {
        continue;
      }

      const literal = arm.pattern.value;

      if (literal.tag === "bool") {
        literal_types.push(named_type("Bool"));
      } else if (literal.tag === "num") {
        if (literal.type === "i64") {
          literal_types.push(named_type("I64"));
        } else if (literal.type === "f32") {
          literal_types.push(named_type("F32"));
        } else {
          literal_types.push(named_type("I32"));
        }
      } else if (literal.tag === "text") {
        literal_types.push(named_type("Text"));
      } else {
        literal_types.push(named_type("#" + literal.name));
      }
    }

    const target_type = this.record_expr(
      expr.target,
      scope,
      common_type_facts(literal_types),
      break_types,
    );
    const result_types: (SourceTypeFact | undefined)[] = [];

    for (const arm of expr.arms) {
      const arm_scope = new Map(scope);
      this.record_pattern_bindings(arm.pattern, target_type, arm_scope);

      if (arm.guard !== undefined) {
        this.record_expr(
          arm.guard,
          arm_scope,
          named_type("Bool"),
          break_types,
        );
      }

      result_types.push(
        this.record_expr(arm.body, arm_scope, expected, break_types),
      );
    }

    return common_type_facts(result_types);
  }

  record_field(
    expr: Extract<FrontExpr, { tag: "field" }>,
    scope: Scope,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const object = this.record_expr(expr.object, scope, undefined, break_types);

    if (expr.resume_signature !== undefined) {
      return callable_type(
        "Resume",
        [this.type_from_name(expr.resume_signature.input_type)],
        this.type_from_name(expr.resume_signature.output_type),
      );
    }

    if (object === undefined) {
      return undefined;
    }

    if (object.members !== undefined) {
      return object.members.get(expr.name);
    }

    const fields = source_fields(object);

    if (fields !== undefined) {
      return fields.find((field) => field.name === expr.name)?.type;
    }

    return undefined;
  }

  record_index(
    expr: Extract<FrontExpr, { tag: "index" }>,
    scope: Scope,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const object = this.record_expr(expr.object, scope, undefined, break_types);
    const index = this.record_expr(
      expr.index,
      scope,
      named_type("I32"),
      break_types,
    );

    if (object === undefined) {
      return undefined;
    }

    if (
      is_type_variable(object) && index !== undefined && is_i32_family(index)
    ) {
      Object.assign(object, named_type("Product"));
    }

    if (
      object.resolved_name === "Text" || object.resolved_name === "Bytes"
    ) {
      if (index === undefined || !is_i32_family(index)) {
        return undefined;
      }

      return named_type("I32");
    }

    const fields = source_fields(object);

    if (fields === undefined) {
      return undefined;
    }

    if (expr.index.tag === "num" && expr.index.type === "i32") {
      const numeric_index = Number(expr.index.value);

      if (Number.isInteger(numeric_index) && numeric_index >= 0) {
        return fields[numeric_index]?.type;
      }

      return undefined;
    }

    if (index === undefined || !is_i32_family(index)) {
      return undefined;
    }

    return this.homogeneous_field_type(object);
  }

  record_struct_value(
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const type_expr = this.record_expr(
      expr.type_expr,
      scope,
      undefined,
      break_types,
    );
    let type = expected;

    if (type === undefined && type_expr !== undefined) {
      type = type_expr.constructed;
    }

    const inferred_fields: SourceFieldTypeFact[] = [];
    const expected_fields = source_fields(type);
    const seen_field_names = new Set<string>();
    let valid = true;

    if (
      type !== undefined &&
      (expected_fields === undefined ||
        expected_fields.length !== expr.fields.length)
    ) {
      valid = false;
    }

    for (let index = 0; index < expr.fields.length; index += 1) {
      const field = expr.fields[index];

      if (field === undefined) {
        throw new Error("Missing source struct field " + index);
      }

      let field_expected: SourceTypeFact | undefined;

      if (expected_fields !== undefined) {
        if (expr.bracketed === "positional") {
          field_expected = expected_fields[index]?.type;
        } else {
          field_expected = expected_fields.find((candidate) =>
            candidate.name === field.name
          )?.type;

          if (seen_field_names.has(field.name)) {
            field_expected = undefined;
          }

          seen_field_names.add(field.name);
        }
      }

      const field_type = this.record_expr(
        field.value,
        scope,
        field_expected,
        break_types,
      );
      inferred_fields.push({ name: field.name, type: field_type });

      if (
        type !== undefined &&
        (field_expected === undefined || field_type === undefined ||
          !source_types_compatible(field_expected, field_type))
      ) {
        valid = false;
      }
    }

    if (type !== undefined && valid) {
      return type;
    }

    if (type !== undefined) {
      return undefined;
    }

    return struct_type(
      inferred_fields,
      undefined,
      expr.bracketed === "positional",
    );
  }

  record_pattern_bindings(
    pattern: Pattern,
    type: SourceTypeFact | undefined,
    scope: Scope,
  ): void {
    if (pattern.tag === "binding") {
      const binding_type = type || named_type("unknown");
      this.record_definition(pattern, "name", binding_type);
      scope.set(pattern.name, binding_type);
      return;
    }

    if (
      pattern.tag === "wildcard" || pattern.tag === "unit" ||
      pattern.tag === "literal" || pattern.tag === "type"
    ) {
      return;
    }

    if (pattern.tag === "union_case") {
      if (pattern.value !== undefined) {
        this.record_pattern_bindings(pattern.value, undefined, scope);
      }
      return;
    }

    const fields = source_fields(type);

    if (pattern.tag === "product") {
      for (let index = 0; index < pattern.entries.length; index += 1) {
        const entry = pattern.entries[index];

        if (entry === undefined) {
          throw new Error("Missing product pattern entry " + index);
        }

        let entry_type = fields?.[index]?.type;

        if (entry.label !== undefined && fields !== undefined) {
          entry_type = fields.find((field) => field.name === entry.label)?.type;
        }

        this.record_pattern_bindings(entry.pattern, entry_type, scope);
      }
      return;
    }

    if (pattern.tag === "record") {
      for (const field of pattern.fields) {
        const field_type = fields?.find((candidate) =>
          candidate.name === field.name
        )?.type;
        this.record_pattern_bindings(field.pattern, field_type, scope);
      }

      if (pattern.rest !== undefined) {
        this.record_pattern_bindings(pattern.rest, undefined, scope);
      }
      return;
    }

    for (let index = 0; index < pattern.items.length; index += 1) {
      const item = pattern.items[index];

      if (item === undefined) {
        throw new Error("Missing array pattern item " + index);
      }

      this.record_pattern_bindings(item, fields?.[index]?.type, scope);
    }

    if (pattern.rest !== undefined) {
      this.record_pattern_bindings(pattern.rest, undefined, scope);
    }
  }

  record_product(
    expr: Extract<FrontExpr, { tag: "product" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const expected_fields = source_fields(expected);
    const inferred_fields: SourceFieldTypeFact[] = [];
    const positional = expr.entries.every((entry) => entry.label === undefined);
    let valid = expected !== undefined &&
      expected_fields !== undefined &&
      expected_fields.length === expr.entries.length;

    for (let index = 0; index < expr.entries.length; index += 1) {
      const entry = expr.entries[index];

      if (entry === undefined) {
        throw new Error("Missing source product entry " + index);
      }

      let field_expected: SourceTypeFact | undefined;

      if (expected_fields !== undefined) {
        const expected_field = expected_fields[index];

        if (entry.label === undefined) {
          field_expected = expected_field?.type;
        } else if (
          entry.label !== undefined && expected_field?.name === entry.label
        ) {
          field_expected = expected_field.type;
        }
      }

      const field_type = this.record_expr(
        entry.value,
        scope,
        field_expected,
        break_types,
      );
      let field_name = index.toString();

      if (entry.label !== undefined) {
        field_name = entry.label;
      }

      inferred_fields.push({ name: field_name, type: field_type });

      if (
        expected !== undefined &&
        (field_expected === undefined || field_type === undefined ||
          !source_types_compatible(field_expected, field_type))
      ) {
        valid = false;
      }
    }

    if (valid) {
      return expected;
    }

    if (
      expected?.resolved_name === "StructSlots" ||
      expected?.resolved_name === "StructMethods"
    ) {
      return expected;
    }

    return struct_type(inferred_fields, undefined, positional);
  }

  record_struct_update(
    expr: Extract<FrontExpr, { tag: "struct_update" | "with" }>,
    scope: Scope,
    _expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const base = this.record_expr(expr.base, scope, undefined, break_types);
    let type = base;

    if (base !== undefined && base.constructed !== undefined) {
      type = base.constructed;
    }

    const expected_fields = source_fields(type);
    let valid = type !== undefined && expected_fields !== undefined;

    for (const field of expr.fields) {
      let field_expected: SourceTypeFact | undefined;

      if (expected_fields !== undefined) {
        field_expected = expected_fields.find((candidate) =>
          candidate.name === field.name
        )?.type;
      }

      const field_type = this.record_expr(
        field.value,
        scope,
        field_expected,
        break_types,
      );

      if (
        field_expected === undefined || field_type === undefined ||
        !source_types_compatible(field_expected, field_type)
      ) {
        valid = false;
      }
    }

    if (valid) {
      return type;
    }

    return undefined;
  }

  record_union_case(
    expr: Extract<FrontExpr, { tag: "union_case" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    let union_type = expected;

    if (expr.type_expr !== undefined) {
      const namespace = this.record_expr(
        expr.type_expr,
        scope,
        undefined,
        break_types,
      );

      if (namespace !== undefined && namespace.constructed !== undefined) {
        union_type = namespace.constructed;
      }
    }

    if (union_type === undefined) {
      const owners = this.case_owners.get(expr.name);

      if (owners !== undefined && owners.length === 1) {
        const owner = owners[0];

        if (owner !== undefined) {
          union_type = this.type_from_name(owner);
        }
      }
    }

    const cases = source_cases(union_type);

    if (cases === undefined || !cases.has(expr.name)) {
      if (expr.value !== undefined) {
        this.record_expr(expr.value, scope, undefined, break_types);
      }

      return undefined;
    }

    const payload_type = cases.get(expr.name);

    if (expr.value !== undefined) {
      const value_type = this.record_expr(
        expr.value,
        scope,
        payload_type,
        break_types,
      );

      if (
        payload_type === undefined || value_type === undefined ||
        !source_types_compatible(payload_type, value_type)
      ) {
        return undefined;
      }
    } else if (
      payload_type !== undefined && payload_type.resolved_name !== "Unit"
    ) {
      return undefined;
    }

    return union_type;
  }

  record_handler(
    expr: Extract<FrontExpr, { tag: "handler" }>,
    scope: Scope,
    expected: SourceTypeFact | undefined,
    break_types: (SourceTypeFact | undefined)[] | undefined,
  ): SourceTypeFact | undefined {
    const handler_scope = new Map(scope);
    let valid = true;

    for (const state of expr.state) {
      const declared = this.type_from_annotation(state.annotation, undefined);
      const inferred = this.record_expr(
        state.value,
        handler_scope,
        declared,
        break_types,
      );
      let type = inferred;

      if (declared !== undefined) {
        if (
          inferred !== undefined &&
          source_types_compatible(declared, inferred)
        ) {
          type = declared;
        } else {
          type = named_type("unknown");
          valid = false;
        }
      }

      this.record_definition(state, "name", type);

      if (type !== undefined) {
        handler_scope.set(state.name, type);
      }
    }

    const return_scope = new Map(handler_scope);
    let return_parameter = this.parameter_type(expr.return_clause.param);

    if (return_parameter === undefined) {
      return_parameter = inference_type();
    } else if (is_error_type(return_parameter)) {
      valid = false;
    }

    this.record_definition(expr.return_clause.param, "name", return_parameter);
    return_scope.set(expr.return_clause.param.name, return_parameter);

    const handler_result = this.record_expr(
      expr.return_clause.body,
      return_scope,
      expected,
      break_types,
    );

    if (handler_result === undefined || is_error_type(handler_result)) {
      valid = false;
    }

    const declaration = this.declarations.get(expr.effect);

    if (declaration === undefined || declaration.tag !== "effect") {
      valid = false;
    }

    for (const clause of expr.clauses) {
      const clause_scope = new Map(handler_scope);
      let operation_params: SourceTypeFact[] = [];
      let operation_result: SourceTypeFact | undefined;
      let operation_found = false;

      if (declaration !== undefined && declaration.tag === "effect") {
        const substitutions = new Map<string, SourceTypeFact>();

        for (const param of declaration.params) {
          substitutions.set(param, inference_type());
        }

        const operation = declaration.operations.find((candidate) =>
          candidate.name === clause.name
        );

        if (operation !== undefined) {
          operation_found = true;
          operation_params = operation.params.map((param) => {
            const substitution = substitutions.get(param.type_name);

            if (substitution !== undefined) {
              return substitution;
            }

            return this.type_from_name(param.type_name);
          });
          operation_result = substitutions.get(operation.result.type_name);

          if (operation_result === undefined) {
            operation_result = this.type_from_name(operation.result.type_name);
          }

          if (
            operation_params.some((param) => is_error_type(param)) ||
            operation_result === undefined || is_error_type(operation_result)
          ) {
            operation_found = false;
          }
        }
      }

      const clause_signature_matches = operation_found &&
        clause.params.length === operation_params.length + 1;

      if (
        !operation_found || clause.params.length !== operation_params.length + 1
      ) {
        valid = false;
      }

      for (let index = 0; index < clause.params.length; index += 1) {
        const param = clause.params[index];

        if (param === undefined) {
          throw new Error("Missing handler parameter " + index);
        }

        const annotated = this.parameter_type(param);
        let expected_param: SourceTypeFact | undefined;

        if (clause_signature_matches) {
          expected_param = operation_params[index];

          if (index === operation_params.length) {
            expected_param = resume_type(operation_result, handler_result);
          }
        }

        let type = annotated;

        if (!clause_signature_matches) {
          type = named_type("unknown");
        } else if (type === undefined) {
          type = expected_param;
        } else if (
          expected_param === undefined ||
          !source_types_compatible(expected_param, type) ||
          !source_types_compatible(type, expected_param)
        ) {
          type = named_type("unknown");
          valid = false;
        }

        this.record_definition(param, "name", type);

        if (type !== undefined) {
          clause_scope.set(param.name, type);
        }
      }

      const clause_result = this.record_expr(
        clause.body,
        clause_scope,
        handler_result,
        break_types,
      );

      if (
        handler_result === undefined || clause_result === undefined ||
        !source_types_compatible(handler_result, clause_result)
      ) {
        valid = false;
      }
    }

    const type = named_type("unknown");

    if (valid) {
      type.handler_input = return_parameter;
      type.handler_result = handler_result;
    }

    return type;
  }

  namespace_for(name: string): SourceTypeFact {
    const cached = this.namespaces.get(name);

    if (cached !== undefined) {
      return cached;
    }

    const legacy = this.legacy_type_values.get(name);

    if (legacy !== undefined) {
      return this.legacy_type_namespace(name, legacy);
    }

    const declaration = this.declarations.get(name);

    if (declaration === undefined) {
      if (name === "Type" || is_builtin_type_name(name)) {
        const namespace = named_type("Type");
        namespace.constructed = this.type_from_name(name);
        this.namespaces.set(name, namespace);
        return namespace;
      }

      return named_type("unknown");
    }

    let instance = this.type_from_name(name);

    if (declaration.tag === "type" && declaration.params.length > 0) {
      instance = named_type(name, name);
      const substitutions = new Map<string, SourceTypeFact>();

      for (const param of declaration.params) {
        substitutions.set(param, inference_type());
      }

      this.populate_declaration_type(
        declaration,
        instance,
        substitutions,
        new Set(),
      );
    }

    const members = new Map<string, SourceTypeFact>();

    if (declaration.tag === "effect") {
      const substitutions = new Map<string, SourceTypeFact>();

      for (const param of declaration.params) {
        substitutions.set(param, inference_type());
      }

      for (const operation of declaration.operations) {
        let result = substitutions.get(operation.result.type_name);

        if (result === undefined) {
          result = this.type_from_name(operation.result.type_name);
        }

        const params = operation.params.map((param) => param.type_name);
        const param_types = operation.params.map((param) => {
          const substitution = substitutions.get(param.type_name);

          if (substitution !== undefined) {
            return substitution;
          }

          return this.type_from_name(param.type_name);
        });

        if (
          is_error_type(result) ||
          param_types.some((param) => is_error_type(param))
        ) {
          members.set(operation.name, named_type("unknown"));
        } else {
          members.set(
            operation.name,
            callable_type(
              "(" + params.join(", ") + ") -> " + result.name,
              param_types,
              result,
            ),
          );
        }
      }
    } else if (declaration.tag === "duck") {
      for (const member of declaration.members) {
        members.set(member.name, named_type("unknown"));
      }
    } else if (declaration.tag === "record") {
      for (const field of declaration.fields) {
        members.set(field.name, this.type_from_name(field.type_name));
      }
    } else if (
      declaration.tag === "type" && declaration.body.tag === "product"
    ) {
      for (const field of declaration.body.fields) {
        members.set(field.name, this.type_from_name(field.type_name));
      }
    } else if (declaration.tag === "type" && declaration.body.tag === "sum") {
      for (const union_case of declaration.body.cases) {
        const payload = this.type_from_name(union_case.type_name);

        if (is_error_type(payload) || is_error_type(instance)) {
          members.set(union_case.name, named_type("unknown"));
        } else if (payload.resolved_name === "Unit") {
          members.set(union_case.name, instance);
        } else {
          members.set(
            union_case.name,
            callable_type(
              "(" + payload.name + ") -> " + instance.name,
              [payload],
              instance,
            ),
          );
        }
      }
    } else if (
      declaration.tag === "type" && declaration.body.tag === "alias"
    ) {
      const fields = source_fields(instance);

      if (fields !== undefined) {
        for (const field of fields) {
          if (field.type !== undefined) {
            members.set(field.name, field.type);
          }
        }
      }

      const cases = source_cases(instance);

      if (cases !== undefined) {
        for (const [case_name, payload] of cases) {
          if (is_error_type(payload) || is_error_type(instance)) {
            members.set(case_name, named_type("unknown"));
          } else if (payload.resolved_name === "Unit") {
            members.set(case_name, instance);
          } else {
            members.set(
              case_name,
              callable_type(
                "(" + payload.name + ") -> " + instance.name,
                [payload],
                instance,
              ),
            );
          }
        }
      }
    }

    const namespace = named_type("Type");
    namespace.members = members;

    if (
      declaration.tag !== "effect" && declaration.tag !== "duck" &&
      !is_error_type(instance)
    ) {
      namespace.constructed = instance;
    }

    this.namespaces.set(name, namespace);
    return namespace;
  }

  type_value_namespace(
    value: Extract<FrontExpr, { tag: "struct_type" | "union_type" }>,
  ): SourceTypeFact {
    const name = this.legacy_type_names.get(value);

    if (name !== undefined) {
      return this.namespace_for(name);
    }

    const instance = this.legacy_type_instance(undefined, value, new Set());
    const namespace = named_type("Type");
    namespace.constructed = instance;
    return namespace;
  }

  legacy_type_namespace(
    name: string,
    value: Extract<FrontExpr, { tag: "struct_type" | "union_type" }>,
  ): SourceTypeFact {
    const cached = this.namespaces.get(name);

    if (cached !== undefined) {
      return cached;
    }

    const instance = this.legacy_type_instance(name, value, new Set());
    const members = new Map<string, SourceTypeFact>();

    if (value.tag === "struct_type") {
      for (const field of value.fields) {
        members.set(field.name, this.type_from_name(field.type_name));
      }
    } else {
      for (const union_case of value.cases) {
        const payload = this.type_from_name(union_case.type_name);

        if (is_error_type(payload)) {
          members.set(union_case.name, named_type("unknown"));
        } else if (payload.resolved_name === "Unit") {
          members.set(union_case.name, instance);
        } else {
          members.set(
            union_case.name,
            callable_type(
              "(" + payload.name + ") -> " + instance.name,
              [payload],
              instance,
            ),
          );
        }
      }
    }

    const namespace = named_type("Type");
    namespace.members = members;
    namespace.constructed = instance;
    this.namespaces.set(name, namespace);
    return namespace;
  }

  legacy_type_instance(
    name: string | undefined,
    value: Extract<FrontExpr, { tag: "struct_type" | "union_type" }>,
    resolving: Set<string>,
  ): SourceTypeFact {
    if (name !== undefined) {
      const cached = this.declaration_types.get(name);

      if (cached !== undefined) {
        return cached;
      }
    }

    let type_name = "struct";

    if (name !== undefined) {
      type_name = name;
    } else if (value.tag === "union_type") {
      type_name = "union";
    }

    const type = named_type(type_name, name);

    if (name !== undefined) {
      this.declaration_types.set(name, type);
    }

    if (value.tag === "struct_type") {
      type.fields = value.fields.map((field) => ({
        name: field.name,
        type: this.resolve_declared_type(field.type_name, new Map(), resolving),
      }));
    } else {
      type.cases = new Map(
        value.cases.map((union_case) => [
          union_case.name,
          this.resolve_declared_type(
            union_case.type_name,
            new Map(),
            resolving,
          ),
        ]),
      );
    }

    return type;
  }

  type_from_name(name: string): SourceTypeFact {
    const cached = this.declaration_types.get(name);

    if (cached !== undefined) {
      return cached;
    }

    if (name.includes(" ")) {
      return this.type_from_type_expr(parse_type_expr(tokenize(name)));
    }

    return this.resolve_type_name(name, new Set());
  }

  resolve_type_name(name: string, resolving: Set<string>): SourceTypeFact {
    const cached = this.declaration_types.get(name);

    if (cached !== undefined) {
      return cached;
    }

    if (name === "Type" || is_builtin_type_name(name)) {
      return named_type(name);
    }

    const legacy = this.legacy_type_values.get(name);

    if (legacy !== undefined) {
      return this.legacy_type_instance(name, legacy, resolving);
    }

    const declaration = this.declarations.get(name);

    if (
      declaration === undefined ||
      (declaration.tag !== "record" && declaration.tag !== "type") ||
      (declaration.tag === "type" && declaration.params.length !== 0)
    ) {
      return named_type("unknown");
    }

    const type = named_type(name, name);
    this.declaration_types.set(name, type);

    if (resolving.has(name)) {
      return type;
    }

    this.populate_declaration_type(
      declaration,
      type,
      new Map(),
      resolving,
    );

    if (is_error_type(type)) {
      this.declaration_types.set(name, type);
    }

    return type;
  }

  type_from_annotation(
    annotation: string | undefined,
    type_expr: TypeExpr | undefined,
  ): SourceTypeFact | undefined {
    if (type_expr !== undefined) {
      return this.type_from_type_expr(type_expr);
    }

    if (annotation !== undefined) {
      return this.type_from_name(annotation);
    }

    return undefined;
  }

  type_from_type_expr(type_expr: TypeExpr): SourceTypeFact {
    return this.resolve_type_expr(type_expr, new Map(), new Set());
  }

  resolve_type_expr(
    type_expr: TypeExpr,
    substitutions: Map<string, SourceTypeFact>,
    resolving: Set<string>,
  ): SourceTypeFact {
    if (type_expr.tag === "forall") {
      const scoped = new Map(substitutions);
      const quantified_variables: SourceTypeFact[] = [];

      for (const param of type_expr.params) {
        const variable = inference_type();
        scoped.set(param, variable);
        quantified_variables.push(variable);
      }

      const body = this.resolve_type_expr(type_expr.body, scoped, resolving);
      const quantified_replacements = new Map<
        SourceTypeFact,
        SourceTypeFact
      >();

      for (const variable of quantified_variables) {
        quantified_replacements.set(variable, variable);
      }

      const quantified = clone_source_type(
        body,
        quantified_replacements,
        new Map(),
      );
      quantified.name = format_type_expr(type_expr);
      quantified.resolved_name = quantified.name;
      quantified.quantified_variables = quantified_variables;
      return quantified;
    }

    if (type_expr.tag === "name") {
      const substituted = substitutions.get(type_expr.name);

      if (substituted !== undefined) {
        return substituted;
      }

      return this.resolve_type_name(type_expr.name, resolving);
    }

    if (type_expr.tag === "atom") {
      return named_type("#" + type_expr.name);
    }

    if (type_expr.tag === "top" || type_expr.tag === "never") {
      return named_type(format_type_expr(type_expr));
    }

    if (
      (type_expr.tag === "tuple" && type_expr.items.length === 0) ||
      (type_expr.tag === "product" && type_expr.entries.length === 0)
    ) {
      return unit_type();
    }

    if (type_expr.tag === "arrow") {
      const params: SourceTypeFact[] = [];

      if (type_expr.param.tag === "tuple") {
        for (const item of type_expr.param.items) {
          params.push(this.resolve_type_expr(item, substitutions, resolving));
        }
      } else if (type_expr.param.tag === "product") {
        for (const entry of type_expr.param.entries) {
          params.push(
            this.resolve_type_expr(entry.type_expr, substitutions, resolving),
          );
        }
      } else {
        params.push(
          this.resolve_type_expr(type_expr.param, substitutions, resolving),
        );
      }

      const result = this.resolve_type_expr(
        type_expr.result,
        substitutions,
        resolving,
      );

      if (
        params.some((param) => is_error_type(param)) ||
        is_error_type(result) ||
        (type_expr.effects !== undefined &&
          !this.effect_row_is_known(type_expr.effects))
      ) {
        return named_type("unknown");
      }

      return callable_type(
        format_type_expr(type_expr),
        params,
        result,
      );
    }

    if (type_expr.tag === "apply") {
      const applied = applied_type_expr(type_expr);
      const declaration = this.declarations.get(applied.name);

      if (
        declaration !== undefined && declaration.tag === "type" &&
        declaration.params.length === applied.args.length
      ) {
        const args = applied.args.map((arg) =>
          this.resolve_type_expr(arg, substitutions, resolving)
        );

        if (args.some((arg) => is_error_type(arg))) {
          return named_type("unknown");
        }

        return this.specialize_declaration(
          declaration,
          args,
          resolving,
        );
      }

      return named_type("unknown");
    }

    if (type_expr.tag === "frozen" || type_expr.tag === "borrow") {
      const value = this.resolve_type_expr(
        type_expr.value,
        substitutions,
        resolving,
      );

      if (is_error_type(value)) {
        return named_type("unknown");
      }

      return named_type(format_type_expr(type_expr));
    }

    if (type_expr.tag === "tuple") {
      for (const item of type_expr.items) {
        const type = this.resolve_type_expr(item, substitutions, resolving);

        if (is_error_type(type)) {
          return named_type("unknown");
        }
      }

      return named_type(format_type_expr(type_expr));
    }

    if (type_expr.tag === "product") {
      const fields: SourceFieldTypeFact[] = [];

      for (let index = 0; index < type_expr.entries.length; index += 1) {
        const entry = type_expr.entries[index];

        if (entry === undefined) {
          throw new Error(
            "Missing source product type entry " + index.toString(),
          );
        }
        const type = this.resolve_type_expr(
          entry.type_expr,
          substitutions,
          resolving,
        );

        if (is_error_type(type)) {
          return named_type("unknown");
        }

        let name = index.toString();

        if (entry.label !== undefined) {
          name = entry.label;
        }

        fields.push({ name, type });
      }

      const positional = type_expr.entries.every((entry) =>
        entry.label === undefined
      );
      return struct_type(fields, undefined, positional);
    }

    if (type_expr.tag === "array") {
      const element = this.resolve_type_expr(
        type_expr.element,
        substitutions,
        resolving,
      );

      if (is_error_type(element)) {
        return named_type("unknown");
      }

      return named_type(format_type_expr(type_expr));
    }

    if (
      type_expr.tag !== "union" && type_expr.tag !== "intersection" &&
      type_expr.tag !== "difference"
    ) {
      type_expr satisfies never;
      throw new Error("Unknown type expression");
    }

    const left = this.resolve_type_expr(
      type_expr.left,
      substitutions,
      resolving,
    );
    const right = this.resolve_type_expr(
      type_expr.right,
      substitutions,
      resolving,
    );

    if (is_error_type(left) || is_error_type(right)) {
      return named_type("unknown");
    }

    const type = named_type(format_type_expr(type_expr));
    type.type_set = {
      operation: type_expr.tag,
      left,
      right,
    };
    return type;
  }

  specialize_declaration(
    declaration: Extract<Declaration, { tag: "type" }>,
    args: SourceTypeFact[],
    resolving: Set<string>,
  ): SourceTypeFact {
    const specialized_name = declaration.name + " " +
      args.map((arg) => arg.name).join(" ");
    const cached = this.applied_declaration_types.get(specialized_name);

    if (cached !== undefined) {
      return cached;
    }

    const type = named_type(specialized_name, declaration.name);
    this.applied_declaration_types.set(specialized_name, type);

    if (resolving.has(declaration.name)) {
      return type;
    }

    const substitutions = new Map<string, SourceTypeFact>();

    for (let index = 0; index < declaration.params.length; index += 1) {
      const param = declaration.params[index];
      const arg = args[index];

      if (param !== undefined && arg !== undefined) {
        substitutions.set(param, arg);
      }
    }

    this.populate_declaration_type(
      declaration,
      type,
      substitutions,
      resolving,
    );
    return type;
  }

  populate_declaration_type(
    declaration: Extract<Declaration, { tag: "record" | "type" }>,
    type: SourceTypeFact,
    substitutions: Map<string, SourceTypeFact>,
    resolving: Set<string>,
  ): void {
    if (resolving.has(declaration.name)) {
      return;
    }

    const next = new Set(resolving);
    next.add(declaration.name);

    if (declaration.tag === "record") {
      type.fields = declaration.fields.map((field) => ({
        name: field.name,
        type: this.resolve_declared_type(
          field.type_name,
          substitutions,
          next,
        ),
      }));
    } else if (declaration.body.tag === "alias") {
      const target = this.resolve_declared_type(
        declaration.body.type_name,
        substitutions,
        next,
      );
      type.alias_target = target;

      if (is_error_type(target)) {
        type.name = "unknown";
        type.resolved_name = "unknown";
        type.nominal = undefined;
      } else {
        type.resolved_name = target.resolved_name;
      }
    } else if (declaration.body.tag === "product") {
      type.positional_fields = declaration.body.positional;
      type.fields = declaration.body.fields.map((field) => ({
        name: field.name,
        type: this.resolve_declared_type(
          field.type_name,
          substitutions,
          next,
        ),
      }));
    } else if (declaration.body.tag === "sum") {
      type.cases = new Map(
        declaration.body.cases.map((union_case) => [
          union_case.name,
          this.resolve_declared_type(
            union_case.type_name,
            substitutions,
            next,
          ),
        ]),
      );
    }
  }

  resolve_declared_type(
    text: string,
    substitutions: Map<string, SourceTypeFact>,
    resolving: Set<string>,
  ): SourceTypeFact {
    return this.resolve_type_expr(
      parse_type_expr(tokenize(text)),
      substitutions,
      resolving,
    );
  }

  parameter_type(param: Param): SourceTypeFact | undefined {
    return this.type_from_annotation(param.annotation, param.type_annotation);
  }

  union_payload_type(
    target: SourceTypeFact | undefined,
    case_name: string,
  ): SourceTypeFact | undefined {
    const cases = source_cases(target);

    if (cases === undefined) {
      return undefined;
    }

    return cases.get(case_name);
  }

  homogeneous_field_type(
    type: SourceTypeFact | undefined,
  ): SourceTypeFact | undefined {
    const fields = source_fields(type);

    if (fields === undefined) {
      return undefined;
    }

    const field_types = fields.map((field) => field.type);
    return common_type_facts(field_types);
  }

  record_definition(
    owner: object,
    slot: string,
    type: SourceTypeFact | undefined,
  ): void {
    if (type === undefined) {
      return;
    }

    let definitions = this.facts.definition_type_of.get(owner);

    if (definitions === undefined) {
      definitions = new Map();
      this.facts.definition_type_of.set(owner, definitions);
    }

    definitions.set(slot, type);
  }

  record_expression(expr: FrontExpr): void {
    if (this.recorded_expressions.has(expr)) {
      return;
    }

    this.recorded_expressions.add(expr);
    this.facts.expressions.push(expr);
  }

  store_expr_type(expr: FrontExpr, type: SourceTypeFact): void {
    this.facts.editor_type_of.set(expr, type);

    const front_type = front_type_from_source_fact(type);

    if (front_type !== undefined) {
      this.facts.type_of.set(expr, front_type);
    }
  }
}

function applied_type_expr(
  type: Extract<TypeExpr, { tag: "apply" }>,
): { name: string; args: TypeExpr[] } {
  const args: TypeExpr[] = [];
  let current: TypeExpr = type;

  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.func;
  }

  if (current.tag === "name") {
    return { name: current.name, args };
  }

  return { name: format_type_expr(current), args };
}

function statement_returns(statement: Stmt): boolean {
  if (statement.tag === "return") {
    return true;
  }

  if (statement.tag === "bind" || statement.tag === "state_bind") {
    return expression_returns(statement.value);
  }

  if (statement.tag === "assign" || statement.tag === "index_assign") {
    return expression_returns(statement.value);
  }

  if (statement.tag === "expr") {
    return expression_returns(statement.expr);
  }

  return false;
}

function expression_returns(expr: FrontExpr): boolean {
  if (expr.tag === "block") {
    for (const statement of expr.statements) {
      if (statement_returns(statement)) {
        return true;
      }
    }

    return false;
  }

  if (
    expr.tag === "scratch" || expr.tag === "comptime" ||
    expr.tag === "captured"
  ) {
    if (expr.tag === "scratch") {
      return expression_returns(expr.body);
    }

    return expression_returns(expr.expr);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return expression_returns(expr.value);
  }

  if (expr.tag === "if") {
    return expression_returns(expr.then_branch) &&
      expression_returns(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return expression_returns(expr.then_branch) &&
      expression_returns(expr.else_branch);
  }

  return false;
}

function builtin_call_result(
  name: string,
  args: (SourceTypeFact | undefined)[],
): SourceTypeFact | undefined {
  if (name === "@shape.entries" && args.length === 1) {
    return shape_entries_type();
  }

  if (
    (name === "@type.product" || name === "@type.namespace") &&
    args.length === 1
  ) {
    return named_type("Type");
  }

  if (name === "f32x4" && args.length === 4) {
    if (args.every((arg) => arg?.resolved_name === "F32")) {
      return named_type("F32x4");
    }

    return undefined;
  }

  if (name === "f32x4_splat" && args.length === 1) {
    if (args[0]?.resolved_name === "F32") {
      return named_type("F32x4");
    }

    return undefined;
  }

  if (
    (name === "f32x4_add" || name === "f32x4_sub" ||
      name === "f32x4_mul" || name === "f32x4_div") &&
    args.length === 2
  ) {
    if (
      args[0]?.resolved_name === "F32x4" &&
      args[1]?.resolved_name === "F32x4"
    ) {
      return named_type("F32x4");
    }

    return undefined;
  }

  if (name === "f32x4_extract_lane" && args.length === 2) {
    if (
      args[0]?.resolved_name === "F32x4" && args[1] !== undefined &&
      is_i32_family(args[1])
    ) {
      return named_type("F32");
    }

    return undefined;
  }

  if (name === "f32x4_replace_lane" && args.length === 3) {
    if (
      args[0]?.resolved_name === "F32x4" && args[1] !== undefined &&
      is_i32_family(args[1]) && args[2]?.resolved_name === "F32"
    ) {
      return named_type("F32x4");
    }

    return undefined;
  }

  if (
    (name === "bit_and" || name === "bit_or" || name === "bit_xor" ||
      name === "shift_left" || name === "shift_right_u") &&
    args.length === 2
  ) {
    const left = args[0];
    const right = args[1];

    if (
      left !== undefined && right !== undefined &&
      left.resolved_name === right.resolved_name &&
      (left.resolved_name === "I32" || left.resolved_name === "Int" ||
        left.resolved_name === "U32" || left.resolved_name === "I64")
    ) {
      return left;
    }

    return undefined;
  }

  if (name === "f32_sqrt" && args.length === 1) {
    if (args[0]?.resolved_name === "F32") {
      return named_type("F32");
    }

    return undefined;
  }

  if (name === "f32_from_i32" && args.length === 1) {
    if (args[0] !== undefined && is_i32_family(args[0])) {
      return named_type("F32");
    }

    return undefined;
  }

  if (name === "i32_from_f32" && args.length === 1) {
    if (args[0]?.resolved_name === "F32") {
      return named_type("I32");
    }

    return undefined;
  }

  if (name === "describe_type" && args.length === 1) {
    const described = args[0]?.constructed;

    if (described === undefined) {
      return undefined;
    }

    return descriptor_type_fact(described);
  }

  if (name === "describe_fields" && args.length === 1) {
    const described = args[0]?.constructed;
    const fields = source_fields(described);

    if (fields === undefined) {
      return descriptor_collection_type("FieldDescriptor", []);
    }

    return descriptor_collection_type(
      "FieldDescriptor",
      fields.map((field) => field_descriptor_type_fact(field.type)),
    );
  }

  if (name === "describe_cases" && args.length === 1) {
    const described = args[0]?.constructed;
    const cases = source_cases(described);

    if (described === undefined || cases === undefined) {
      return descriptor_collection_type("CaseDescriptor", []);
    }

    return descriptor_collection_type(
      "CaseDescriptor",
      [...cases.values()].map((payload) =>
        case_descriptor_type_fact(payload, described)
      ),
    );
  }

  if (name === "construct" && args.length === 2) {
    return args[0]?.constructed;
  }

  if (name === "project" && args.length === 2) {
    return args[1]?.alias_target;
  }

  if (name === "is_case" && args.length === 2) {
    return named_type("Bool");
  }

  if (name === "len") {
    if (args.length === 1 && args[0] !== undefined) {
      return named_type("I32");
    }

    return undefined;
  }

  if (name === "Bytes.generate") {
    if (args.length === 2) {
      return named_type("Bytes");
    }

    return undefined;
  }

  if (name === "Utf8.encode") {
    if (args.length === 1 && args[0]?.resolved_name === "Text") {
      return named_type("Bytes");
    }

    return undefined;
  }

  if (name === "Utf8.decode") {
    if (args.length === 1 && args[0]?.resolved_name === "Bytes") {
      return named_type("Text");
    }

    return undefined;
  }

  if (name === "format_i32") {
    if (args.length === 1 && args[0] !== undefined && is_i32_family(args[0])) {
      return named_type("Text");
    }

    return undefined;
  }

  if (name === "format_i64") {
    if (args.length === 1 && args[0]?.resolved_name === "I64") {
      return named_type("Text");
    }

    return undefined;
  }

  if (name === "format_f32") {
    if (
      args.length === 2 && args[0]?.resolved_name === "F32" &&
      args[1] !== undefined && is_i32_family(args[1])
    ) {
      return named_type("Text");
    }

    return undefined;
  }

  if (name === "get") {
    if (
      args.length === 2 && is_text_family(args[0]) &&
      args[1] !== undefined && is_i32_family(args[1])
    ) {
      return named_type("I32");
    }

    return undefined;
  }

  if (name === "slice") {
    if (
      args.length === 3 && is_text_family(args[0]) &&
      args[1] !== undefined && is_i32_family(args[1]) &&
      args[2] !== undefined && is_i32_family(args[2])
    ) {
      return args[0];
    }

    return undefined;
  }

  if (
    name === "append" && args.length === 2 && is_text_family(args[0]) &&
    is_text_family(args[1]) && args[0] !== undefined &&
    args[1] !== undefined && args[0].resolved_name === args[1].resolved_name
  ) {
    return args[0];
  }

  return undefined;
}

function descriptor_type_fact(described: SourceTypeFact): SourceTypeFact {
  const fields = source_fields(described);
  const cases = source_cases(described);
  const field_descriptors: SourceTypeFact[] = [];
  const case_descriptors: SourceTypeFact[] = [];

  if (fields !== undefined) {
    for (const field of fields) {
      field_descriptors.push(field_descriptor_type_fact(field.type));
    }
  }

  if (cases !== undefined) {
    for (const payload of cases.values()) {
      case_descriptors.push(case_descriptor_type_fact(payload, described));
    }
  }

  return struct_type(
    [
      { name: "kind", type: named_type("unknown") },
      { name: "name", type: named_type("Text") },
      { name: "size", type: named_type("I32") },
      { name: "align", type: named_type("I32") },
      { name: "stride", type: named_type("I32") },
      { name: "length", type: named_type("I32") },
      { name: "element", type: named_type("Type") },
      {
        name: "fields",
        type: descriptor_collection_type("FieldDescriptor", field_descriptors),
      },
      {
        name: "cases",
        type: descriptor_collection_type("CaseDescriptor", case_descriptors),
      },
    ],
    undefined,
    false,
  );
}

function field_descriptor_type_fact(
  target: SourceTypeFact | undefined,
): SourceTypeFact {
  const descriptor = struct_type(
    [
      { name: "kind", type: named_type("#field") },
      { name: "name", type: named_type("Text") },
      { name: "index", type: named_type("I32") },
      { name: "offset", type: named_type("I32") },
      { name: "type", type: named_type("Type") },
    ],
    undefined,
    false,
  );
  descriptor.name = "FieldDescriptor";

  if (target !== undefined) {
    descriptor.alias_target = target;
  }

  return descriptor;
}

function case_descriptor_type_fact(
  target: SourceTypeFact,
  owner: SourceTypeFact,
): SourceTypeFact {
  const descriptor = struct_type(
    [
      { name: "kind", type: named_type("#case") },
      { name: "name", type: named_type("Text") },
      { name: "index", type: named_type("I32") },
      { name: "tag", type: named_type("I32") },
      { name: "offset", type: named_type("I32") },
      { name: "type", type: named_type("Type") },
      { name: "owner", type: named_type("Type") },
    ],
    undefined,
    false,
  );
  descriptor.name = "CaseDescriptor";
  descriptor.alias_target = target;
  descriptor.constructed = owner;
  return descriptor;
}

function descriptor_collection_type(
  name: "FieldDescriptor" | "CaseDescriptor",
  descriptors: SourceTypeFact[],
): SourceTypeFact {
  const type = named_type(
    "[" + name + "; " + descriptors.length.toString() + "]",
  );
  type.positional_fields = true;
  type.fields = descriptors.map((descriptor, index) => ({
    name: index.toString(),
    type: descriptor,
  }));
  return type;
}

function is_text_family(
  type: SourceTypeFact | undefined,
): type is SourceTypeFact {
  return type !== undefined &&
    (type.resolved_name === "Text" || type.resolved_name === "Bytes");
}

function is_supported_loop_result(type: SourceTypeFact): boolean {
  return is_numeric_type(type) || type.resolved_name === "Bool" ||
    type.resolved_name === "Unit" || type.resolved_name.startsWith("#");
}

function named_type(name: string, nominal?: string): SourceTypeFact {
  const type: SourceTypeFact = {
    canonical_type: () => {
      return canonical_type_from_source_fact(
        type,
        new TypeEngine(),
        new WeakMap(),
        new Set(),
      );
    },
    name,
    resolved_name: name,
    nominal,
    call_params: undefined,
    call_result: undefined,
    fields: undefined,
    positional_fields: false,
    cases: undefined,
    members: undefined,
    constructed: undefined,
    handler_input: undefined,
    handler_result: undefined,
    alias_target: undefined,
    type_set: undefined,
    inference_variable: false,
    quantified_variables: undefined,
  };
  return type;
}

function shape_entries_type(): SourceTypeFact {
  const entry = struct_type(
    [
      { name: "name", type: named_type("Text") },
      { name: "type", type: named_type("Type") },
      { name: "index", type: named_type("I32") },
    ],
    undefined,
    false,
  );
  entry.name = "ShapeEntry";
  entry.resolved_name = "ShapeEntry";

  const entries = struct_type(
    [{ name: "0", type: entry }],
    undefined,
    true,
  );
  entries.name = "ShapeEntries";
  entries.resolved_name = "ShapeEntries";
  return entries;
}

function shape_type(): SourceTypeFact {
  const shape = struct_type(
    [{ name: "0", type: shape_entry_type() }],
    undefined,
    true,
  );
  shape.name = "Shape";
  shape.resolved_name = "Shape";
  return shape;
}

function shape_entry_type(): SourceTypeFact {
  const entry = struct_type(
    [
      { name: "name", type: named_type("Text") },
      { name: "value", type: named_type("Type") },
    ],
    undefined,
    false,
  );
  entry.name = "ShapeEntry";
  entry.resolved_name = "ShapeEntry";
  return entry;
}

function uses_shape_entry_projection(
  value: unknown,
  item_name: string,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const node = value as Record<string, unknown>;

  if (
    node.tag === "field" &&
    (node.name === "name" || node.name === "value")
  ) {
    const object = node.object as Record<string, unknown> | undefined;

    if (object?.tag === "var" && object.name === item_name) {
      return true;
    }
  }

  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      if (
        child.some((entry) => uses_shape_entry_projection(entry, item_name))
      ) {
        return true;
      }
      continue;
    }

    if (uses_shape_entry_projection(child, item_name)) {
      return true;
    }
  }

  return false;
}

function type_namespace_argument_type(): SourceTypeFact {
  return struct_type(
    [
      { name: "0", type: named_type("Type") },
      { name: "1", type: named_type("StructMethods") },
    ],
    undefined,
    true,
  );
}

function inference_type(): SourceTypeFact {
  const type = named_type("unknown");
  type.inference_variable = true;
  return type;
}

function generalize_const_source_type(
  type: SourceTypeFact,
  scope: Scope,
): SourceTypeFact {
  const environment_variables = new Set<SourceTypeFact>();

  for (const scoped of scope.values()) {
    collect_source_inference_variables(
      scoped,
      environment_variables,
      new Set(),
    );
  }

  const variables = new Set<SourceTypeFact>();
  collect_source_inference_variables(type, variables, new Set());
  const quantified_variables = [...variables].filter((variable) =>
    !environment_variables.has(variable)
  );

  if (quantified_variables.length === 0) {
    return type;
  }

  const quantified_replacements = new Map<
    SourceTypeFact,
    SourceTypeFact
  >();

  for (const variable of quantified_variables) {
    quantified_replacements.set(variable, variable);
  }

  const generalized = clone_source_type(
    type,
    quantified_replacements,
    new Map(),
  );
  generalized.name = "forall " + quantified_variables.length.toString() +
    " variables. " + type.name;
  generalized.resolved_name = generalized.name;
  generalized.quantified_variables = quantified_variables;
  return generalized;
}

function collect_source_inference_variables(
  type: SourceTypeFact,
  variables: Set<SourceTypeFact>,
  visited: Set<SourceTypeFact>,
): void {
  if (visited.has(type)) {
    return;
  }

  visited.add(type);

  if (is_type_variable(type)) {
    variables.add(type);
    return;
  }

  if (type.call_params !== undefined) {
    for (const param of type.call_params) {
      if (param !== undefined) {
        collect_source_inference_variables(param, variables, visited);
      }
    }
  }

  if (type.call_result !== undefined) {
    collect_source_inference_variables(type.call_result, variables, visited);
  }

  if (type.fields !== undefined) {
    for (const field of type.fields) {
      if (field.type !== undefined) {
        collect_source_inference_variables(field.type, variables, visited);
      }
    }
  }

  if (type.cases !== undefined) {
    for (const payload of type.cases.values()) {
      collect_source_inference_variables(payload, variables, visited);
    }
  }
}

function unit_type(): SourceTypeFact {
  return named_type("Unit");
}

function callable_type(
  name: string,
  params: (SourceTypeFact | undefined)[] | undefined,
  result: SourceTypeFact | undefined,
): SourceTypeFact {
  const type = named_type(name);
  type.call_params = params;
  type.call_result = result;
  return type;
}

function exact_call_constraint_error(
  func: SourceTypeFact,
  args: (SourceTypeFact | undefined)[],
): { message: string; rank_n: boolean } | undefined {
  if (
    func.call_params === undefined || func.call_result === undefined ||
    func.call_params.length !== args.length
  ) {
    return undefined;
  }

  const engine = new TypeEngine();
  const variables = new WeakMap<SourceTypeFact, Type>();

  for (let index = 0; index < func.call_params.length; index += 1) {
    const expected = func.call_params[index];
    const actual = args[index];

    if (expected === undefined || actual === undefined) {
      return undefined;
    }

    if (expected.quantified_variables !== undefined) {
      if (actual.quantified_variables === undefined) {
        return {
          message: "call argument " + (index + 1).toString() +
            ": expected polymorphic type " + expected.name + ", got " +
            actual.name,
          rank_n: true,
        };
      }

      const expected_type = canonical_type_from_source_fact(
        expected,
        engine,
        variables,
        new Set(),
      );
      const actual_type = canonical_type_from_source_fact(
        actual,
        engine,
        variables,
        new Set(),
      );

      if (
        expected_type === undefined || actual_type === undefined ||
        !engine.alpha_equivalent(expected_type, actual_type)
      ) {
        return {
          message: "call argument " + (index + 1).toString() +
            ": polymorphic type " + actual.name +
            " does not satisfy " + expected.name,
          rank_n: true,
        };
      }

      continue;
    }

    const expected_type = canonical_type_from_source_fact(
      expected,
      engine,
      variables,
      new Set(),
    );
    const actual_type = canonical_type_from_source_fact(
      actual,
      engine,
      variables,
      new Set(),
    );

    if (expected_type === undefined || actual_type === undefined) {
      return undefined;
    }

    if (
      expected_type.tag === "scalar" && actual_type.tag === "scalar" &&
      scalar_representation_compatible(expected_type.name, actual_type.name)
    ) {
      continue;
    }

    try {
      engine.unify(
        expected_type,
        actual_type,
        "call argument " + (index + 1),
      );
    } catch (error) {
      if (error instanceof Error) {
        return { message: error.message, rank_n: false };
      }

      throw error;
    }
  }

  return undefined;
}

function canonical_type_from_source_fact(
  source: SourceTypeFact,
  engine: TypeEngine,
  variables: WeakMap<SourceTypeFact, Type>,
  visiting: Set<SourceTypeFact>,
  unwrapped_quantifiers = new Set<SourceTypeFact>(),
  variable_kind: "flexible" | "rigid" = "flexible",
): Type | undefined {
  if (is_error_type(source)) {
    return undefined;
  }

  if (
    source.quantified_variables !== undefined &&
    !unwrapped_quantifiers.has(source)
  ) {
    const quantified_variables: number[] = [];

    for (const quantified_source of source.quantified_variables) {
      let quantified = variables.get(quantified_source);

      if (quantified === undefined) {
        quantified = engine.fresh_variable(quantified_source.name);
        variables.set(quantified_source, quantified);
      }

      if (quantified.tag !== "variable") {
        throw new Error(
          "Quantified source type did not map to a canonical variable: " +
            source.name,
        );
      }

      quantified_variables.push(quantified.id);
    }

    const unwrapped = new Set(unwrapped_quantifiers);
    unwrapped.add(source);
    const body = canonical_type_from_source_fact(
      source,
      engine,
      variables,
      visiting,
      unwrapped,
      variable_kind,
    );

    if (body === undefined) {
      return undefined;
    }

    return { tag: "forall", quantified_variables, body };
  }

  const canonical_type_set = source_type_set(source);

  if (canonical_type_set !== undefined) {
    const left = canonical_type_from_source_fact(
      canonical_type_set.left,
      engine,
      variables,
      visiting,
      unwrapped_quantifiers,
      variable_kind,
    );
    const right = canonical_type_from_source_fact(
      canonical_type_set.right,
      engine,
      variables,
      visiting,
      unwrapped_quantifiers,
      variable_kind,
    );

    if (left === undefined || right === undefined) {
      return undefined;
    }

    if (canonical_type_set.operation === "union") {
      return { tag: "union", members: [left, right] };
    }

    if (canonical_type_set.operation === "intersection") {
      return { tag: "intersection", members: [left, right] };
    }

    return { tag: "difference", base: left, removed: right };
  }

  if (is_type_variable(source)) {
    const existing = variables.get(source);

    if (existing !== undefined) {
      return existing;
    }

    let variable: Type;

    if (variable_kind === "rigid") {
      variable = engine.fresh_rigid(source.name);
    } else {
      variable = engine.fresh_variable(source.name);
    }

    variables.set(source, variable);
    return variable;
  }

  if (visiting.has(source)) {
    return undefined;
  }

  const scalar = canonical_scalar_from_source_name(source.resolved_name);

  if (scalar !== undefined) {
    return { tag: "scalar", name: scalar };
  }

  if (source.call_params !== undefined || source.call_result !== undefined) {
    if (source.call_params === undefined || source.call_result === undefined) {
      return undefined;
    }

    const next = new Set(visiting);
    next.add(source);
    const params: Type[] = [];

    for (const param of source.call_params) {
      if (param === undefined) {
        return undefined;
      }

      const param_type = canonical_type_from_source_fact(
        param,
        engine,
        variables,
        next,
        unwrapped_quantifiers,
        variable_kind,
      );

      if (param_type === undefined) {
        return undefined;
      }

      params.push(param_type);
    }

    const result = canonical_type_from_source_fact(
      source.call_result,
      engine,
      variables,
      next,
      unwrapped_quantifiers,
      variable_kind,
    );

    if (result === undefined) {
      return undefined;
    }

    return { tag: "function", params, effects: [], result };
  }

  if (source.nominal !== undefined) {
    return { tag: "named", name: source.nominal, args: [] };
  }

  const fields = source_fields(source);

  if (fields !== undefined) {
    const next = new Set(visiting);
    next.add(source);

    if (source_fields_are_positional(source)) {
      const product_fields: Extract<
        Type,
        { tag: "product" }
      >["fields"] = [];

      for (const field of fields) {
        if (field.type === undefined) {
          return undefined;
        }

        const field_type = canonical_type_from_source_fact(
          field.type,
          engine,
          variables,
          next,
          unwrapped_quantifiers,
          variable_kind,
        );

        if (field_type === undefined) {
          return undefined;
        }

        let label: string | undefined;

        if (field.name !== "") {
          label = field.name;
        }

        product_fields.push({ label, type: field_type });
      }

      return { tag: "product", fields: product_fields };
    }

    const record_fields: Extract<Type, { tag: "record" }>["fields"] = [];

    for (const field of fields) {
      if (field.type === undefined) {
        return undefined;
      }

      const field_type = canonical_type_from_source_fact(
        field.type,
        engine,
        variables,
        next,
        unwrapped_quantifiers,
        variable_kind,
      );

      if (field_type === undefined) {
        return undefined;
      }

      record_fields.push({ label: field.name, type: field_type });
    }

    return { tag: "record", fields: record_fields };
  }

  const cases = source_cases(source);

  if (cases !== undefined) {
    const next = new Set(visiting);
    next.add(source);
    const sum_cases: Extract<Type, { tag: "sum" }>["cases"] = [];

    for (const [label, payload] of cases) {
      const payload_type = canonical_type_from_source_fact(
        payload,
        engine,
        variables,
        next,
        unwrapped_quantifiers,
        variable_kind,
      );

      if (payload_type === undefined) {
        return undefined;
      }

      sum_cases.push({ label, payload: payload_type });
    }

    return { tag: "sum", cases: sum_cases };
  }

  return { tag: "named", name: source.resolved_name, args: [] };
}

function canonical_scalar_from_source_name(
  name: string,
): Extract<Type, { tag: "scalar" }>["name"] | undefined {
  if (
    name === "Bool" || name === "Unit" || name === "Int" ||
    name === "I32" || name === "U32" || name === "I64" ||
    name === "F32" || name === "F32x4" || name === "Text" ||
    name === "Bytes" || name === "Resume"
  ) {
    return name;
  }

  return undefined;
}

function specialize_call_result(
  func: SourceTypeFact,
  args: (SourceTypeFact | undefined)[],
): SourceTypeFact | undefined {
  if (func.call_params === undefined || func.call_result === undefined) {
    return undefined;
  }

  if (func.call_params.length !== args.length) {
    return undefined;
  }

  const engine = new TypeEngine();
  const expected_variables = new WeakMap<SourceTypeFact, Type>();
  const actual_variables = new WeakMap<SourceTypeFact, Type>();

  for (let index = 0; index < func.call_params.length; index += 1) {
    const expected = func.call_params[index];

    if (expected === undefined) {
      continue;
    }

    const actual = args[index];

    if (actual === undefined) {
      return undefined;
    }

    const expected_type = canonical_type_from_source_fact(
      expected,
      engine,
      expected_variables,
      new Set(),
    );
    const actual_type = canonical_type_from_source_fact(
      actual,
      engine,
      actual_variables,
      new Set(),
    );

    if (expected_type === undefined || actual_type === undefined) {
      return undefined;
    }

    try {
      engine.constrain_subtype(
        actual_type,
        expected_type,
        "call argument " + (index + 1).toString(),
      );
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      return undefined;
    }
  }

  return materialize_source_type_from_engine(
    func.call_result,
    engine,
    expected_variables,
    new Map(),
  );
}

function skolemize_quantified_source_type(
  type: SourceTypeFact,
): SourceTypeFact {
  const quantified = type.quantified_variables;

  if (quantified === undefined) {
    return type;
  }

  const engine = new TypeEngine();
  const variables = new WeakMap<SourceTypeFact, Type>();
  const canonical = canonical_type_from_source_fact(
    type,
    engine,
    variables,
    new Set(),
  );

  if (canonical === undefined || canonical.tag !== "forall") {
    throw new Error("Invalid quantified source type: " + type.name);
  }

  const skolemization = engine.skolemize_with_replacements({
    quantified_variables: canonical.quantified_variables,
    type: canonical.body,
  });
  const replacements = new Map<SourceTypeFact, SourceTypeFact>();

  for (const quantified_source of quantified) {
    const variable = variables.get(quantified_source);

    if (variable === undefined || variable.tag !== "variable") {
      throw new Error(
        "Missing canonical quantified variable for " + quantified_source.name,
      );
    }

    const skolem = skolemization.skolems.get(variable.id);

    if (skolem === undefined) {
      throw new Error(
        "Missing skolem replacement for " + quantified_source.name,
      );
    }

    replacements.set(quantified_source, named_type(format_type(skolem)));
  }

  const instantiated = clone_source_type(type, replacements, new Map());
  instantiated.quantified_variables = undefined;
  return instantiated;
}

function clone_source_type(
  source: SourceTypeFact,
  replacements: Map<SourceTypeFact, SourceTypeFact>,
  copied: Map<SourceTypeFact, SourceTypeFact>,
): SourceTypeFact {
  const replacement = replacements.get(source);

  if (replacement !== undefined) {
    return replacement;
  }

  const cached = copied.get(source);

  if (cached !== undefined) {
    return cached;
  }

  const result = named_type(source.name, source.nominal);
  result.resolved_name = source.resolved_name;
  result.inference_variable = source.inference_variable;
  result.positional_fields = source.positional_fields;
  copied.set(source, result);

  if (source.quantified_variables !== undefined) {
    result.quantified_variables = source.quantified_variables.map((variable) =>
      clone_source_type(variable, replacements, copied)
    );
  }

  if (source.type_set !== undefined) {
    result.type_set = {
      operation: source.type_set.operation,
      left: clone_source_type(source.type_set.left, replacements, copied),
      right: clone_source_type(source.type_set.right, replacements, copied),
    };
  }

  if (source.call_params !== undefined) {
    result.call_params = source.call_params.map((param) => {
      if (param === undefined) {
        return undefined;
      }

      return clone_source_type(param, replacements, copied);
    });
  }

  if (source.call_result !== undefined) {
    result.call_result = clone_source_type(
      source.call_result,
      replacements,
      copied,
    );
  }

  if (source.fields !== undefined) {
    result.fields = source.fields.map((field) => {
      let field_type: SourceTypeFact | undefined;

      if (field.type !== undefined) {
        field_type = clone_source_type(field.type, replacements, copied);
      }

      return { name: field.name, type: field_type };
    });
  }

  if (source.cases !== undefined) {
    result.cases = new Map();

    for (const [name, payload] of source.cases) {
      result.cases.set(
        name,
        clone_source_type(payload, replacements, copied),
      );
    }
  }

  if (source.members !== undefined) {
    result.members = new Map();

    for (const [name, member] of source.members) {
      result.members.set(
        name,
        clone_source_type(member, replacements, copied),
      );
    }
  }

  if (source.constructed !== undefined) {
    result.constructed = clone_source_type(
      source.constructed,
      replacements,
      copied,
    );
  }

  if (source.alias_target !== undefined) {
    result.alias_target = clone_source_type(
      source.alias_target,
      replacements,
      copied,
    );
  }

  if (source.handler_input !== undefined) {
    result.handler_input = clone_source_type(
      source.handler_input,
      replacements,
      copied,
    );
  }

  if (source.handler_result !== undefined) {
    result.handler_result = clone_source_type(
      source.handler_result,
      replacements,
      copied,
    );
  }

  return result;
}

function is_type_variable(type: SourceTypeFact): boolean {
  return type.inference_variable && type.call_params === undefined &&
    type.fields === undefined && type.cases === undefined &&
    type.alias_target === undefined;
}

function is_error_type(type: SourceTypeFact): boolean {
  return type.resolved_name === "unknown" && !type.inference_variable;
}

function materialize_source_type_from_engine(
  source: SourceTypeFact,
  engine: TypeEngine,
  variables: WeakMap<SourceTypeFact, Type>,
  copied: Map<SourceTypeFact, SourceTypeFact>,
): SourceTypeFact {
  const cached = copied.get(source);

  if (cached !== undefined) {
    return cached;
  }

  if (is_type_variable(source)) {
    const canonical = variables.get(source);

    if (canonical === undefined) {
      const unresolved = inference_type();
      copied.set(source, unresolved);
      return unresolved;
    }

    const resolved = engine.substitute(canonical);

    if (resolved.tag === "variable") {
      const unresolved = inference_type();
      copied.set(source, unresolved);
      return unresolved;
    }

    const materialized = source_type_from_canonical(resolved, new Map());
    copied.set(source, materialized);
    return materialized;
  }

  const result = named_type(source.name, source.nominal);
  result.resolved_name = source.resolved_name;
  result.inference_variable = source.inference_variable;
  result.positional_fields = source.positional_fields;
  copied.set(source, result);

  if (source.quantified_variables !== undefined) {
    result.quantified_variables = source.quantified_variables.map((variable) =>
      materialize_source_type_from_engine(variable, engine, variables, copied)
    );
  }

  if (source.type_set !== undefined) {
    result.type_set = {
      operation: source.type_set.operation,
      left: materialize_source_type_from_engine(
        source.type_set.left,
        engine,
        variables,
        copied,
      ),
      right: materialize_source_type_from_engine(
        source.type_set.right,
        engine,
        variables,
        copied,
      ),
    };
  }

  if (source.call_params !== undefined) {
    result.call_params = source.call_params.map((param) => {
      if (param === undefined) {
        return undefined;
      }

      return materialize_source_type_from_engine(
        param,
        engine,
        variables,
        copied,
      );
    });
  }

  if (source.call_result !== undefined) {
    result.call_result = materialize_source_type_from_engine(
      source.call_result,
      engine,
      variables,
      copied,
    );
  }

  if (source.fields !== undefined) {
    result.fields = source.fields.map((field) => {
      let field_type: SourceTypeFact | undefined;

      if (field.type !== undefined) {
        field_type = materialize_source_type_from_engine(
          field.type,
          engine,
          variables,
          copied,
        );
      }

      return { name: field.name, type: field_type };
    });
  }

  if (source.cases !== undefined) {
    result.cases = new Map();

    for (const [name, payload] of source.cases) {
      result.cases.set(
        name,
        materialize_source_type_from_engine(
          payload,
          engine,
          variables,
          copied,
        ),
      );
    }
  }

  if (source.members !== undefined) {
    result.members = new Map();

    for (const [name, member] of source.members) {
      result.members.set(
        name,
        materialize_source_type_from_engine(
          member,
          engine,
          variables,
          copied,
        ),
      );
    }
  }

  if (source.constructed !== undefined) {
    result.constructed = materialize_source_type_from_engine(
      source.constructed,
      engine,
      variables,
      copied,
    );
  }

  if (source.alias_target !== undefined) {
    result.alias_target = materialize_source_type_from_engine(
      source.alias_target,
      engine,
      variables,
      copied,
    );
  }

  if (source.handler_input !== undefined) {
    result.handler_input = materialize_source_type_from_engine(
      source.handler_input,
      engine,
      variables,
      copied,
    );
  }

  if (source.handler_result !== undefined) {
    result.handler_result = materialize_source_type_from_engine(
      source.handler_result,
      engine,
      variables,
      copied,
    );
  }

  return result;
}

function source_type_from_canonical(
  type: Type,
  variables: Map<number, SourceTypeFact>,
): SourceTypeFact {
  switch (type.tag) {
    case "variable": {
      const existing = variables.get(type.id);

      if (existing !== undefined) {
        return existing;
      }

      const variable = inference_type();
      variables.set(type.id, variable);
      return variable;
    }

    case "rigid":
      return named_type(format_type(type));

    case "forall": {
      const scoped = new Map(variables);
      const quantified_variables: SourceTypeFact[] = [];

      for (const variable of type.quantified_variables) {
        const quantified = inference_type();
        scoped.set(variable, quantified);
        quantified_variables.push(quantified);
      }

      const body = source_type_from_canonical(type.body, scoped);
      body.name = format_type(type);
      body.resolved_name = body.name;
      body.quantified_variables = quantified_variables;
      return body;
    }

    case "top":
      return named_type("Any");

    case "never":
      return named_type("Never");

    case "scalar":
      return named_type(type.name);

    case "named":
      return named_type(type.name, type.name);

    case "product":
      return struct_type(
        type.fields.map((field) => {
          let name = "";

          if (field.label !== undefined) {
            name = field.label;
          }

          return {
            name,
            type: source_type_from_canonical(field.type, variables),
          };
        }),
        undefined,
        true,
      );

    case "record":
      return struct_type(
        type.fields.map((field) => {
          return {
            name: field.label,
            type: source_type_from_canonical(field.type, variables),
          };
        }),
        undefined,
        false,
      );

    case "fixed_array":
      return named_type(format_type(type));

    case "sum": {
      const cases = new Map<string, SourceTypeFact>();

      for (const sum_case of type.cases) {
        cases.set(
          sum_case.label,
          source_type_from_canonical(sum_case.payload, variables),
        );
      }

      const result = named_type("union");
      result.cases = cases;
      return result;
    }

    case "function":
      return callable_type(
        format_type(type),
        type.params.map((param) => {
          return source_type_from_canonical(param, variables);
        }),
        source_type_from_canonical(type.result, variables),
      );

    case "owned":
      return named_type(format_type(type));

    case "type_value": {
      const result = named_type("Type");
      result.constructed = source_type_from_canonical(
        type.represented,
        variables,
      );
      return result;
    }

    case "union":
    case "intersection": {
      const members = type.members.map((member) => {
        return source_type_from_canonical(member, variables);
      });
      const first = members[0];

      if (first === undefined) {
        if (type.tag === "union") {
          return named_type("Never");
        }

        return named_type("Any");
      }

      let result = first;

      for (let index = 1; index < members.length; index += 1) {
        const member = members[index];

        if (member === undefined) {
          throw new Error("Missing canonical type-set member " + index);
        }

        const combined = named_type(format_type(type));
        combined.type_set = {
          operation: type.tag,
          left: result,
          right: member,
        };
        result = combined;
      }

      return result;
    }

    case "difference": {
      const result = named_type(format_type(type));
      result.type_set = {
        operation: "difference",
        left: source_type_from_canonical(type.base, variables),
        right: source_type_from_canonical(type.removed, variables),
      };
      return result;
    }
  }
}

function source_types_compatible(
  expected: SourceTypeFact,
  actual: SourceTypeFact,
): boolean {
  if (is_error_type(expected) || is_error_type(actual)) {
    return false;
  }

  if (is_type_variable(expected)) {
    return true;
  }

  if (is_type_variable(actual)) {
    return false;
  }

  const engine = new TypeEngine();
  const expected_type = canonical_type_from_source_fact(
    expected,
    engine,
    new WeakMap(),
    new Set(),
  );
  let actual_type = canonical_type_from_source_fact(
    actual,
    engine,
    new WeakMap(),
    new Set(),
    new Set(),
    "rigid",
  );

  if (expected_type === undefined || actual_type === undefined) {
    return false;
  }

  if (expected_type.tag === "forall") {
    if (actual_type.tag !== "forall") {
      return false;
    }

    return engine.alpha_equivalent(expected_type, actual_type);
  }

  if (actual_type.tag === "forall") {
    actual_type = engine.instantiate({
      quantified_variables: actual_type.quantified_variables,
      type: actual_type.body,
    });
  }

  if (
    expected_type.tag === "scalar" && actual_type.tag === "scalar" &&
    scalar_representation_compatible(expected_type.name, actual_type.name)
  ) {
    return true;
  }

  try {
    engine.unify(expected_type, actual_type, "source type compatibility");
    return true;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  return engine.subtype(actual_type, expected_type);
}

function resume_type(
  input: SourceTypeFact | undefined,
  output: SourceTypeFact | undefined,
): SourceTypeFact {
  let name = "Resume";

  if (input !== undefined && output !== undefined) {
    name = "(" + input.name + ") -> " + output.name;
  }

  let params: (SourceTypeFact | undefined)[] | undefined;

  if (input !== undefined) {
    params = [input];
  }

  return callable_type(name, params, output);
}

function struct_type(
  fields: SourceFieldTypeFact[],
  nominal: string | undefined,
  positional: boolean,
): SourceTypeFact {
  let name = "struct";

  if (nominal !== undefined) {
    name = nominal;
  }

  const type = named_type(name, nominal);
  type.positional_fields = positional;
  type.fields = fields;
  return type;
}

function source_fields(
  type: SourceTypeFact | undefined,
  seen = new Set<SourceTypeFact>(),
): SourceFieldTypeFact[] | undefined {
  if (type === undefined || seen.has(type)) {
    return undefined;
  }

  if (type.fields !== undefined) {
    return type.fields;
  }

  seen.add(type);
  return source_fields(type.alias_target, seen);
}

function source_fields_are_positional(
  type: SourceTypeFact | undefined,
  seen = new Set<SourceTypeFact>(),
): boolean {
  if (type === undefined || seen.has(type)) {
    return false;
  }

  if (type.fields !== undefined) {
    return type.positional_fields;
  }

  seen.add(type);
  return source_fields_are_positional(type.alias_target, seen);
}

function source_cases(
  type: SourceTypeFact | undefined,
  seen = new Set<SourceTypeFact>(),
): Map<string, SourceTypeFact> | undefined {
  if (type === undefined || seen.has(type)) {
    return undefined;
  }

  if (type.cases !== undefined) {
    return type.cases;
  }

  seen.add(type);
  return source_cases(type.alias_target, seen);
}

function source_type_set(
  type: SourceTypeFact | undefined,
  seen = new Set<SourceTypeFact>(),
): SourceTypeSetFact | undefined {
  if (type === undefined || seen.has(type)) {
    return undefined;
  }

  if (type.type_set !== undefined) {
    return type.type_set;
  }

  seen.add(type);
  return source_type_set(type.alias_target, seen);
}

function common_type_facts(
  types: (SourceTypeFact | undefined)[],
): SourceTypeFact | undefined {
  if (types.length === 0) {
    return undefined;
  }

  const first = types[0];

  if (first === undefined || first.resolved_name === "unknown") {
    return undefined;
  }

  for (let index = 1; index < types.length; index += 1) {
    const type = types[index];

    if (
      type === undefined || type.resolved_name === "unknown" ||
      !source_types_compatible(first, type) ||
      !source_types_compatible(type, first)
    ) {
      return undefined;
    }
  }

  return first;
}

function source_type_fact_is_resolved(
  type: SourceTypeFact,
  visiting = new WeakSet<SourceTypeFact>(),
): boolean {
  if (type.inference_variable || type.resolved_name === "unknown") {
    return false;
  }

  if (visiting.has(type)) {
    return true;
  }

  visiting.add(type);

  if (type.call_params !== undefined) {
    if (type.call_result === undefined) {
      return false;
    }

    for (const param of type.call_params) {
      if (
        param === undefined || !source_type_fact_is_resolved(param, visiting)
      ) {
        return false;
      }
    }

    if (!source_type_fact_is_resolved(type.call_result, visiting)) {
      return false;
    }
  }

  if (type.fields !== undefined) {
    for (const field of type.fields) {
      if (
        field.type === undefined ||
        !source_type_fact_is_resolved(field.type, visiting)
      ) {
        return false;
      }
    }
  }

  if (type.cases !== undefined) {
    for (const payload of type.cases.values()) {
      if (!source_type_fact_is_resolved(payload, visiting)) {
        return false;
      }
    }
  }

  if (
    type.alias_target !== undefined &&
    !source_type_fact_is_resolved(type.alias_target, visiting)
  ) {
    return false;
  }

  if (
    type.handler_input !== undefined &&
    !source_type_fact_is_resolved(type.handler_input, visiting)
  ) {
    return false;
  }

  if (
    type.handler_result !== undefined &&
    !source_type_fact_is_resolved(type.handler_result, visiting)
  ) {
    return false;
  }

  return true;
}

function is_numeric_type(type: SourceTypeFact): boolean {
  return type.resolved_name === "I32" || type.resolved_name === "I64" ||
    type.resolved_name === "F32" || type.resolved_name === "Int" ||
    type.resolved_name === "U32";
}

function is_i32_family(type: SourceTypeFact): boolean {
  return type.resolved_name === "I32" || type.resolved_name === "Int" ||
    type.resolved_name === "U32";
}

function same_runtime_type_family(
  left: SourceTypeFact,
  right: SourceTypeFact,
): boolean {
  if (is_i32_family(left) && is_i32_family(right)) {
    return true;
  }

  return left.resolved_name === right.resolved_name;
}

function same_numeric_type_family(
  left: SourceTypeFact,
  right: SourceTypeFact,
): boolean {
  return is_numeric_type(left) && is_numeric_type(right) &&
    same_runtime_type_family(left, right);
}

function is_condition_type(type: SourceTypeFact): boolean {
  return type.resolved_name === "Bool" || type.resolved_name === "I32" ||
    type.resolved_name === "Int" || type.resolved_name === "U32";
}

function compatible_equality_operands(
  prim: string,
  left: SourceTypeFact,
  right: SourceTypeFact,
): boolean {
  if (!same_runtime_type_family(left, right)) {
    if (
      left.resolved_name.startsWith("#") &&
      right.resolved_name.startsWith("#")
    ) {
      return prim === "i32.eq" || prim === "i32.ne";
    }

    return false;
  }

  if (is_numeric_type(left)) {
    if (left.resolved_name === "I64") {
      return prim.startsWith("i64.");
    }

    if (left.resolved_name === "F32") {
      return prim.startsWith("f32.");
    }

    return prim.startsWith("i32.");
  }

  if (
    left.resolved_name === "Bool" || left.resolved_name === "Text" ||
    left.resolved_name === "Bytes" || left.resolved_name === "Unit" ||
    left.resolved_name.startsWith("#")
  ) {
    return prim === "i32.eq" || prim === "i32.ne";
  }

  return false;
}

function front_type_from_source_fact(
  type: SourceTypeFact,
): FrontType | undefined {
  if (type.resolved_name === "Bool") {
    return { tag: "bool" };
  }

  if (
    type.resolved_name === "I32" || type.resolved_name === "Int" ||
    type.resolved_name === "U32"
  ) {
    return { tag: "int", type: "i32" };
  }

  if (type.resolved_name === "I64") {
    return { tag: "int", type: "i64" };
  }

  if (type.resolved_name === "F32") {
    return { tag: "int", type: "f32" };
  }

  if (type.resolved_name === "F32x4") {
    return { tag: "f32x4" };
  }

  if (type.resolved_name === "Text") {
    return { tag: "text" };
  }

  if (type.resolved_name === "Bytes") {
    return { tag: "text", encoding: "bytes" };
  }

  if (type.resolved_name === "Type") {
    return { tag: "type" };
  }

  if (type.resolved_name.startsWith("#")) {
    return { tag: "atom", name: type.resolved_name.slice(1) };
  }

  const fields = source_fields(type);

  if (fields !== undefined) {
    return {
      tag: "struct",
      fields: fields.map((field) => field.name),
      field_types: undefined,
    };
  }

  return undefined;
}
