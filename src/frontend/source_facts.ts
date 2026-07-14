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
  type InferenceType,
  scalar_representation_compatible,
  TypeInference,
} from "./type_inference.ts";
import { is_builtin_type_name } from "./types.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

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
    "Text",
    "Bytes",
    "Resume",
    "Type",
  ]);

  for (const declaration of source.declarations || []) {
    known_names.add(declaration.name);
  }

  for (const statement of source.statements) {
    if (
      statement.tag === "bind" && statement.kind === "const" &&
      (statement.value.tag === "struct_type" ||
        statement.value.tag === "union_type")
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
  const inference = new TypeInference();
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
        "IX2311",
        "error",
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
  readonly recorded_expressions = new WeakSet<object>();
  readonly return_type_stack: (SourceTypeFact | undefined)[][] = [];
  readonly validating_effects = new Set<string>();

  constructor(readonly source: Source) {
    if (source.declarations !== undefined) {
      for (const declaration of source.declarations) {
        this.declarations.set(declaration.name, declaration);

        if (declaration.tag === "type" && declaration.body.tag === "sum") {
          for (const union_case of declaration.body.cases) {
            this.add_case_owner(union_case.name, declaration.name);
          }
        }
      }
    }

    for (const statement of source.statements) {
      if (
        statement.tag !== "bind" || statement.kind !== "const" ||
        (statement.value.tag !== "struct_type" &&
          statement.value.tag !== "union_type")
      ) {
        continue;
      }

      this.legacy_type_values.set(statement.name, statement.value);
      this.legacy_type_names.set(statement.value, statement.name);

      if (statement.value.tag === "union_type") {
        for (const union_case of statement.value.cases) {
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
    return this.facts;
  }

  record_declaration_definitions(): void {
    for (const declaration of this.declarations.values()) {
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

      if (declaration.body.tag === "product") {
        for (const field of declaration.body.fields) {
          this.record_definition(
            field,
            "name",
            namespace.members?.get(field.name),
          );
        }
      } else if (declaration.body.tag === "sum") {
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

      const inferred = this.record_expr(
        statement.value,
        scope,
        declared,
        break_types,
      );

      let definition_type = inferred;
      let scope_type = inferred;

      if (declared !== undefined) {
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
      } else {
        type = named_type("I32");
      }
    } else if (expr.tag === "text") {
      type = named_type("Text");
    } else if (expr.tag === "unit") {
      type = unit_type();
    } else if (expr.tag === "atom") {
      type = named_type("#" + expr.name);
    } else if (expr.tag === "var" || expr.tag === "linear") {
      type = scope.get(expr.name);

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
    } else if (expr.tag === "prim") {
      type = this.record_primitive(expr, scope, break_types);
    } else if (expr.tag === "lam" || expr.tag === "rec") {
      type = this.record_closure(expr, scope, expected, break_types);
    } else if (expr.tag === "app") {
      const func = this.record_expr(expr.func, scope, undefined, break_types);
      const args: (SourceTypeFact | undefined)[] = [];
      const builtin = this.builtin_call_name(expr, scope);

      for (let index = 0; index < expr.args.length; index += 1) {
        const arg = expr.args[index];

        if (arg === undefined) {
          throw new Error("Missing source call argument " + index);
        }

        let expected_arg: SourceTypeFact | undefined;

        if (
          builtin === undefined && func !== undefined &&
          func.call_params !== undefined
        ) {
          expected_arg = func.call_params[index];
        }

        args.push(this.record_expr(arg, scope, expected_arg, break_types));
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
    } else if (expr.tag === "union_case") {
      type = this.record_union_case(expr, scope, expected, break_types);
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
      this.facts.inference_diagnostics.push(source_diagnostic(
        "IX2310",
        "error",
        exact_error,
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
      expr.func.name === "slice" || expr.func.name === "append"
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
        declaration === undefined || declaration.tag === "effect" ||
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
    declaration: Exclude<Declaration, { tag: "effect" }>,
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
          if (is_error_type(this.type_from_name(param.type_name))) {
            return false;
          }
        }

        if (is_error_type(this.type_from_name(operation.result.type_name))) {
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
  ): SourceTypeFact | undefined {
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
        return expected;
      }
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
    const index = this.record_expr(expr.index, scope, undefined, break_types);

    if (object === undefined) {
      return undefined;
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
      pattern.tag === "literal"
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

        if (entry.label === undefined && expected?.positional_fields) {
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

    if (expected !== undefined) {
      return undefined;
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
        const operation = declaration.operations.find((candidate) =>
          candidate.name === clause.name
        );

        if (operation !== undefined) {
          operation_found = true;
          operation_params = operation.params.map((param) =>
            this.type_from_name(param.type_name)
          );
          operation_result = this.type_from_name(operation.result.type_name);

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
      for (const operation of declaration.operations) {
        const result = this.type_from_name(operation.result.type_name);
        const params = operation.params.map((param) => param.type_name);
        const param_types = operation.params.map((param) =>
          this.type_from_name(param.type_name)
        );

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
    } else if (declaration.tag === "record") {
      for (const field of declaration.fields) {
        members.set(field.name, this.type_from_name(field.type_name));
      }
    } else if (declaration.body.tag === "product") {
      for (const field of declaration.body.fields) {
        members.set(field.name, this.type_from_name(field.type_name));
      }
    } else if (declaration.body.tag === "sum") {
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
    } else if (declaration.body.tag === "alias") {
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

    if (declaration.tag !== "effect" && !is_error_type(instance)) {
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
      declaration === undefined || declaration.tag === "effect" ||
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
      for (const entry of type_expr.entries) {
        const type = this.resolve_type_expr(
          entry.type_expr,
          substitutions,
          resolving,
        );

        if (is_error_type(type)) {
          return named_type("unknown");
        }
      }

      return named_type(format_type_expr(type_expr));
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
    declaration: Exclude<Declaration, { tag: "effect" }>,
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
  if (name === "len") {
    if (args.length === 1 && is_text_family(args[0])) {
      return named_type("I32");
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
  return {
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
  };
}

function inference_type(): SourceTypeFact {
  const type = named_type("unknown");
  type.inference_variable = true;
  return type;
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
): string | undefined {
  if (
    func.call_params === undefined || func.call_result === undefined ||
    func.call_params.length !== args.length
  ) {
    return undefined;
  }

  const inference = new TypeInference();
  const variables = new WeakMap<SourceTypeFact, InferenceType>();

  for (let index = 0; index < func.call_params.length; index += 1) {
    const expected = func.call_params[index];
    const actual = args[index];

    if (expected === undefined || actual === undefined) {
      return undefined;
    }

    const expected_type = inference_type_from_source_fact(
      expected,
      inference,
      variables,
      new Set(),
    );
    const actual_type = inference_type_from_source_fact(
      actual,
      inference,
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
      inference.unify(
        expected_type,
        actual_type,
        "call argument " + (index + 1),
      );
    } catch (error) {
      if (error instanceof Error) {
        return error.message;
      }

      throw error;
    }
  }

  return undefined;
}

function inference_type_from_source_fact(
  source: SourceTypeFact,
  inference: TypeInference,
  variables: WeakMap<SourceTypeFact, InferenceType>,
  visiting: Set<SourceTypeFact>,
): InferenceType | undefined {
  if (is_error_type(source) || source.type_set !== undefined) {
    return undefined;
  }

  if (is_type_variable(source)) {
    const existing = variables.get(source);

    if (existing !== undefined) {
      return existing;
    }

    const variable = inference.fresh_variable();
    variables.set(source, variable);
    return variable;
  }

  if (visiting.has(source)) {
    return undefined;
  }

  const scalar = inference_scalar_from_source_name(source.resolved_name);

  if (scalar !== undefined) {
    return { tag: "scalar", name: scalar };
  }

  if (source.call_params !== undefined || source.call_result !== undefined) {
    if (source.call_params === undefined || source.call_result === undefined) {
      return undefined;
    }

    const next = new Set(visiting);
    next.add(source);
    const params: InferenceType[] = [];

    for (const param of source.call_params) {
      if (param === undefined) {
        return undefined;
      }

      const param_type = inference_type_from_source_fact(
        param,
        inference,
        variables,
        next,
      );

      if (param_type === undefined) {
        return undefined;
      }

      params.push(param_type);
    }

    const result = inference_type_from_source_fact(
      source.call_result,
      inference,
      variables,
      next,
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
        InferenceType,
        { tag: "product" }
      >["fields"] = [];

      for (const field of fields) {
        if (field.type === undefined) {
          return undefined;
        }

        const field_type = inference_type_from_source_fact(
          field.type,
          inference,
          variables,
          next,
        );

        if (field_type === undefined) {
          return undefined;
        }

        product_fields.push({
          label: field.name || undefined,
          type: field_type,
        });
      }

      return { tag: "product", fields: product_fields };
    }

    const record_fields: Extract<InferenceType, { tag: "record" }>["fields"] =
      [];

    for (const field of fields) {
      if (field.type === undefined) {
        return undefined;
      }

      const field_type = inference_type_from_source_fact(
        field.type,
        inference,
        variables,
        next,
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
    const sum_cases: Extract<InferenceType, { tag: "sum" }>["cases"] = [];

    for (const [label, payload] of cases) {
      const payload_type = inference_type_from_source_fact(
        payload,
        inference,
        variables,
        next,
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

function inference_scalar_from_source_name(
  name: string,
): Extract<InferenceType, { tag: "scalar" }>["name"] | undefined {
  if (
    name === "Bool" || name === "Unit" || name === "Int" ||
    name === "I32" || name === "U32" || name === "I64" ||
    name === "Text" || name === "Bytes" || name === "Resume"
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

  const bindings: TypeBindings = {
    parents: new Map(),
    concrete: new Map(),
  };

  for (let index = 0; index < func.call_params.length; index += 1) {
    const expected = func.call_params[index];

    if (expected === undefined) {
      continue;
    }

    const actual = args[index];

    if (
      actual === undefined || !unify_source_types(expected, actual, bindings)
    ) {
      return undefined;
    }
  }

  return materialize_source_type(func.call_result, bindings, new Map());
}

type TypeBindings = {
  parents: Map<SourceTypeFact, SourceTypeFact>;
  concrete: Map<SourceTypeFact, SourceTypeFact>;
};

function unify_source_types(
  expected: SourceTypeFact,
  actual: SourceTypeFact,
  bindings: TypeBindings,
  seen = new WeakMap<SourceTypeFact, WeakSet<SourceTypeFact>>(),
): boolean {
  if (is_error_type(expected) || is_error_type(actual)) {
    return false;
  }

  const expected_variable = is_type_variable(expected);
  const actual_variable = is_type_variable(actual);

  if (expected_variable || actual_variable) {
    return unify_type_variables(expected, actual, bindings);
  }

  let actuals = seen.get(expected);

  if (actuals === undefined) {
    actuals = new WeakSet();
    seen.set(expected, actuals);
  } else if (actuals.has(actual)) {
    return true;
  }

  actuals.add(actual);

  const expected_type_set = source_type_set(expected);

  if (expected_type_set !== undefined) {
    if (
      source_type_set(actual) !== undefined &&
      expected.resolved_name === actual.resolved_name
    ) {
      return true;
    }

    return source_type_set_contains(
      expected_type_set,
      actual,
      (member, value) => unify_source_types(member, value, bindings, seen),
    );
  }

  if (expected.call_params !== undefined || actual.call_params !== undefined) {
    if (
      expected.call_params === undefined || actual.call_params === undefined ||
      expected.call_params.length !== actual.call_params.length
    ) {
      return false;
    }

    for (let index = 0; index < expected.call_params.length; index += 1) {
      const expected_param = expected.call_params[index];
      const actual_param = actual.call_params[index];

      if (expected_param === undefined) {
        continue;
      }

      if (
        actual_param === undefined ||
        !unify_source_types(expected_param, actual_param, bindings, seen)
      ) {
        return false;
      }
    }

    if (expected.call_result === undefined) {
      return true;
    }

    return actual.call_result !== undefined &&
      unify_source_types(
        expected.call_result,
        actual.call_result,
        bindings,
        seen,
      );
  }

  const expected_fields = source_fields(expected);
  const actual_fields = source_fields(actual);

  if (expected_fields !== undefined || actual_fields !== undefined) {
    if (
      expected_fields === undefined || actual_fields === undefined ||
      expected_fields.length !== actual_fields.length
    ) {
      return false;
    }

    for (let index = 0; index < expected_fields.length; index += 1) {
      const expected_field = expected_fields[index];
      const actual_field = actual_fields[index];

      if (
        expected_field === undefined || actual_field === undefined ||
        expected_field.name !== actual_field.name ||
        expected_field.type === undefined || actual_field.type === undefined ||
        !unify_source_types(
          expected_field.type,
          actual_field.type,
          bindings,
          seen,
        )
      ) {
        return false;
      }
    }

    return true;
  }

  const expected_cases = source_cases(expected);
  const actual_cases = source_cases(actual);

  if (expected_cases !== undefined || actual_cases !== undefined) {
    if (
      expected_cases === undefined || actual_cases === undefined ||
      expected_cases.size !== actual_cases.size
    ) {
      return false;
    }

    for (const [case_name, expected_payload] of expected_cases) {
      const actual_payload = actual_cases.get(case_name);

      if (
        actual_payload === undefined ||
        !unify_source_types(expected_payload, actual_payload, bindings, seen)
      ) {
        return false;
      }
    }

    return true;
  }

  return same_runtime_type_family(expected, actual);
}

function unify_type_variables(
  expected: SourceTypeFact,
  actual: SourceTypeFact,
  bindings: TypeBindings,
): boolean {
  if (is_type_variable(expected) && is_type_variable(actual)) {
    const expected_root = type_variable_root(expected, bindings);
    const actual_root = type_variable_root(actual, bindings);

    if (expected_root === actual_root) {
      return true;
    }

    const expected_concrete = bindings.concrete.get(expected_root);
    const actual_concrete = bindings.concrete.get(actual_root);
    bindings.parents.set(actual_root, expected_root);

    if (expected_concrete !== undefined && actual_concrete !== undefined) {
      return unify_source_types(expected_concrete, actual_concrete, bindings);
    }

    if (expected_concrete === undefined && actual_concrete !== undefined) {
      bindings.concrete.set(expected_root, actual_concrete);
    }

    return true;
  }

  let variable = expected;
  let concrete = actual;

  if (!is_type_variable(expected)) {
    variable = actual;
    concrete = expected;
  }

  const root = type_variable_root(variable, bindings);
  const bound = bindings.concrete.get(root);

  if (bound !== undefined) {
    return unify_source_types(bound, concrete, bindings);
  }

  bindings.concrete.set(root, concrete);
  return true;
}

function type_variable_root(
  type: SourceTypeFact,
  bindings: TypeBindings,
): SourceTypeFact {
  const parent = bindings.parents.get(type);

  if (parent === undefined) {
    return type;
  }

  const root = type_variable_root(parent, bindings);
  bindings.parents.set(type, root);
  return root;
}

function is_type_variable(type: SourceTypeFact): boolean {
  return type.inference_variable && type.call_params === undefined &&
    type.fields === undefined && type.cases === undefined &&
    type.alias_target === undefined;
}

function is_error_type(type: SourceTypeFact): boolean {
  return type.resolved_name === "unknown" && !type.inference_variable;
}

function materialize_source_type(
  source: SourceTypeFact,
  bindings: TypeBindings,
  copied: Map<SourceTypeFact, SourceTypeFact>,
): SourceTypeFact {
  if (is_type_variable(source)) {
    const root = type_variable_root(source, bindings);
    const existing = copied.get(root);

    if (existing !== undefined) {
      copied.set(source, existing);
      return existing;
    }

    const concrete = bindings.concrete.get(root);

    if (concrete !== undefined) {
      const result = materialize_source_type(concrete, bindings, copied);
      copied.set(root, result);
      copied.set(source, result);
      return result;
    }

    const result = inference_type();
    copied.set(root, result);
    copied.set(source, result);
    return result;
  }

  const cached = copied.get(source);

  if (cached !== undefined) {
    return cached;
  }

  const result = named_type(source.name, source.nominal);
  result.resolved_name = source.resolved_name;
  result.inference_variable = source.inference_variable;
  copied.set(source, result);

  if (source.type_set !== undefined) {
    result.type_set = {
      operation: source.type_set.operation,
      left: materialize_source_type(source.type_set.left, bindings, copied),
      right: materialize_source_type(source.type_set.right, bindings, copied),
    };
  }

  if (source.call_params !== undefined) {
    result.call_params = source.call_params.map((param) => {
      if (param === undefined) {
        return undefined;
      }

      return materialize_source_type(param, bindings, copied);
    });
  }

  if (source.call_result !== undefined) {
    result.call_result = materialize_source_type(
      source.call_result,
      bindings,
      copied,
    );
  }

  if (source.fields !== undefined) {
    result.positional_fields = source.positional_fields;
    result.fields = source.fields.map((field) => {
      let type: SourceTypeFact | undefined;

      if (field.type !== undefined) {
        type = materialize_source_type(field.type, bindings, copied);
      }

      return { name: field.name, type };
    });
  }

  if (source.cases !== undefined) {
    result.cases = new Map();

    for (const [name, type] of source.cases) {
      result.cases.set(name, materialize_source_type(type, bindings, copied));
    }
  }

  if (source.alias_target !== undefined) {
    result.alias_target = materialize_source_type(
      source.alias_target,
      bindings,
      copied,
    );
  }

  if (source.handler_input !== undefined) {
    result.handler_input = materialize_source_type(
      source.handler_input,
      bindings,
      copied,
    );
  }

  if (source.handler_result !== undefined) {
    result.handler_result = materialize_source_type(
      source.handler_result,
      bindings,
      copied,
    );
  }

  return result;
}

function source_types_compatible(
  expected: SourceTypeFact,
  actual: SourceTypeFact,
  seen = new WeakMap<SourceTypeFact, WeakSet<SourceTypeFact>>(),
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

  let actuals = seen.get(expected);

  if (actuals === undefined) {
    actuals = new WeakSet();
    seen.set(expected, actuals);
  } else if (actuals.has(actual)) {
    return true;
  }

  actuals.add(actual);

  const expected_type_set = source_type_set(expected);

  if (expected_type_set !== undefined) {
    if (
      source_type_set(actual) !== undefined &&
      expected.resolved_name === actual.resolved_name
    ) {
      return true;
    }

    return source_type_set_contains(
      expected_type_set,
      actual,
      (member, value) => source_types_compatible(member, value, seen),
    );
  }

  if (expected.call_params !== undefined || actual.call_params !== undefined) {
    if (
      expected.call_params === undefined || actual.call_params === undefined ||
      expected.call_params.length !== actual.call_params.length
    ) {
      return false;
    }

    for (let index = 0; index < expected.call_params.length; index += 1) {
      const expected_param = expected.call_params[index];

      if (expected_param === undefined) {
        continue;
      }

      const actual_param = actual.call_params[index];

      if (
        actual_param === undefined ||
        !source_types_compatible(expected_param, actual_param, seen)
      ) {
        return false;
      }
    }

    if (expected.call_result !== undefined) {
      if (actual.call_result === undefined) {
        return false;
      }

      if (
        !source_types_compatible(
          expected.call_result,
          actual.call_result,
          seen,
        )
      ) {
        return false;
      }
    }

    return true;
  }

  const expected_fields = source_fields(expected);
  const actual_fields = source_fields(actual);

  if (expected_fields !== undefined || actual_fields !== undefined) {
    if (
      expected_fields === undefined || actual_fields === undefined ||
      expected_fields.length !== actual_fields.length
    ) {
      return false;
    }

    for (let index = 0; index < expected_fields.length; index += 1) {
      const expected_field = expected_fields[index];
      const actual_field = actual_fields[index];

      if (
        expected_field === undefined || actual_field === undefined ||
        expected_field.name !== actual_field.name ||
        expected_field.type === undefined || actual_field.type === undefined ||
        !source_types_compatible(expected_field.type, actual_field.type, seen)
      ) {
        return false;
      }
    }

    return true;
  }

  const expected_cases = source_cases(expected);
  const actual_cases = source_cases(actual);

  if (expected_cases !== undefined || actual_cases !== undefined) {
    if (
      expected_cases === undefined || actual_cases === undefined ||
      expected_cases.size !== actual_cases.size
    ) {
      return false;
    }

    for (const [case_name, expected_payload] of expected_cases) {
      const actual_payload = actual_cases.get(case_name);

      if (
        actual_payload === undefined ||
        !source_types_compatible(expected_payload, actual_payload, seen)
      ) {
        return false;
      }
    }

    return true;
  }

  return same_runtime_type_family(expected, actual);
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

function source_type_set_contains(
  type_set: SourceTypeSetFact,
  actual: SourceTypeFact,
  member_matches: (
    expected: SourceTypeFact,
    actual: SourceTypeFact,
  ) => boolean,
): boolean {
  const left_matches = member_matches(type_set.left, actual);

  if (type_set.operation === "union") {
    if (left_matches) {
      return true;
    }

    return member_matches(type_set.right, actual);
  }

  const right_matches = member_matches(type_set.right, actual);

  if (type_set.operation === "intersection") {
    return left_matches && right_matches;
  }

  return left_matches && !right_matches;
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

function is_numeric_type(type: SourceTypeFact): boolean {
  return type.resolved_name === "I32" || type.resolved_name === "I64" ||
    type.resolved_name === "Int" || type.resolved_name === "U32";
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
