import type {
  FrontExpr,
  Param,
  Pattern,
  RecursiveBinding,
  Source,
  Stmt,
  TypeExpr,
} from "./ast.ts";
import { collect_linear_closure_names } from "./linear_closure_names.ts";
import { apply_function_result_context } from "./parser_stmt/binding.ts";
import { stmt_result_expr } from "./block_result.ts";
import { analyze_front_expression_effects } from "./effect_analysis.ts";
import {
  source_facts,
  type SourceFacts,
  type SourceTypeFact,
} from "./source_facts.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

type FunctionBinding = {
  annotation: string | undefined;
  kind: "let" | "const";
  name: string;
  owner: object;
  pattern?: Pattern;
  recursive: boolean;
  type_annotation?: TypeExpr;
  value: FrontExpr;
};

type InferredSignature = {
  annotation: string | undefined;
  type_annotation: TypeExpr | undefined;
  pattern: Pattern | undefined;
  value: FrontExpr;
};

export function infer_front_function_signatures(source: Source): Source {
  let inferred = source;
  const initial_bindings = function_bindings(source);
  const maximum_rounds = initial_bindings.length + 1;
  const components = function_components(
    new Map(initial_bindings.map((binding) => [binding.name, binding])),
  );
  const effectful = effectful_function_names(source, initial_bindings);

  for (let round = 0; round < maximum_rounds; round += 1) {
    const facts = source_facts(inferred);
    const signatures = inferred_signatures(
      inferred,
      facts,
      components,
      effectful,
    );

    if (signatures.size === 0) {
      return inferred;
    }

    inferred = apply_inferred_signatures(inferred, signatures);
  }

  return inferred;
}

export function apply_front_function_signatures(
  source: Source,
  signature_source: Source,
): Source {
  const available = new Map(
    function_bindings(signature_source).map((
      binding,
    ) => [binding.name, binding]),
  );
  const signatures = new Map<string, InferredSignature>();

  for (const binding of function_bindings(source)) {
    if (
      binding.type_annotation !== undefined || binding.annotation !== undefined
    ) {
      continue;
    }

    const inferred = available.get(binding.name);

    if (
      inferred?.type_annotation === undefined ||
      (binding.value.tag !== "lam" && binding.value.tag !== "rec") ||
      (inferred.value.tag !== "lam" && inferred.value.tag !== "rec")
    ) {
      continue;
    }

    const inferred_value = inferred.value;

    const params = binding.value.params.map((param, index) => {
      const inferred_param = inferred_value.params[index];

      if (inferred_param === undefined) {
        throw new Error("Missing inferred function parameter");
      }

      return {
        ...param,
        annotation: inferred_param.annotation,
        type_annotation: inferred_param.type_annotation,
      };
    });
    let value: Extract<FrontExpr, { tag: "lam" | "rec" }> = {
      ...binding.value,
      params,
      pattern: inferred_value.pattern,
    };
    const contextual = apply_function_result_context(
      value,
      inferred.type_annotation,
    );

    if (contextual.tag !== "lam" && contextual.tag !== "rec") {
      throw new Error("Transferred signature requires a function value");
    }

    value = contextual;
    signatures.set(binding.name, {
      annotation: inferred.annotation,
      pattern: inferred.pattern,
      type_annotation: inferred.type_annotation,
      value,
    });
  }

  if (signatures.size === 0) {
    return source;
  }

  return apply_inferred_signatures(source, signatures);
}

function inferred_signatures(
  source: Source,
  facts: SourceFacts,
  components: readonly (readonly string[])[],
  effectful: ReadonlySet<string>,
): Map<string, InferredSignature> {
  const bindings = new Map(
    function_bindings(source).map((binding) => [binding.name, binding]),
  );
  const signatures = new Map<string, InferredSignature>();

  for (const component of components) {
    for (const name of component) {
      if (effectful.has(name)) {
        continue;
      }
      const binding = bindings.get(name);

      if (binding === undefined) {
        throw new Error("Missing function binding " + name);
      }

      const fact = facts.definition_type_of.get(binding.owner)?.get("name");
      const signature = inferred_signature(binding, fact);

      if (signature !== undefined) {
        signatures.set(name, signature);
      }
    }
  }

  return signatures;
}

function effectful_function_names(
  source: Source,
  bindings: FunctionBinding[],
): ReadonlySet<string> {
  const effectful = new Set<string>();
  const fully_handled = new Set<string>();

  for (const binding of bindings) {
    if (binding.value.tag !== "lam" && binding.value.tag !== "rec") {
      continue;
    }

    if (contains_handler(binding.value.body)) {
      const effects = analyze_front_expression_effects(
        source,
        binding.value.body,
      );

      if (effects.length > 0) {
        effectful.add(binding.name);
      } else {
        fully_handled.add(binding.name);
      }
      continue;
    }

    if (contains_state_binding(binding.value.body)) {
      effectful.add(binding.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const binding of bindings) {
      if (
        effectful.has(binding.name) || fully_handled.has(binding.name) ||
        (binding.value.tag !== "lam" && binding.value.tag !== "rec")
      ) {
        continue;
      }

      const references = new Set<string>();
      collect_linear_closure_names(binding.value.body, references);

      if ([...references].some((name) => effectful.has(name))) {
        effectful.add(binding.name);
        changed = true;
      }
    }
  }

  return effectful;
}

function contains_handler(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if ("tag" in value && value.tag === "try_with") {
    return true;
  }

  return Object.values(value).some(contains_handler);
}

function contains_state_binding(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if ("tag" in value && value.tag === "state_bind") {
    return true;
  }

  return Object.values(value).some(contains_state_binding);
}

function inferred_signature(
  binding: FunctionBinding,
  fact: SourceTypeFact | undefined,
): InferredSignature | undefined {
  if (
    fact?.call_params === undefined ||
    (binding.value.tag !== "lam" && binding.value.tag !== "rec")
  ) {
    return undefined;
  }

  if (
    binding.kind === "const" ||
    binding.value.params.some((param) => param.is_const)
  ) {
    return undefined;
  }

  let changed = false;
  let params = binding.value.params;
  let value = binding.value;
  let type_annotation = binding.type_annotation;
  let annotation = binding.annotation;
  let pattern = binding.pattern;
  const has_explicit_parameter = binding.value.params.some((param) =>
    param.annotation !== undefined || param.type_annotation !== undefined
  );
  const result_is_nominal = fact.call_result?.nominal !== undefined;

  if (
    type_annotation === undefined && annotation === undefined &&
    (!has_explicit_parameter || binding.recursive || result_is_nominal) &&
    fact.call_params.length === binding.value.params.length
  ) {
    const param_types = fact.call_params.map(source_type_expr);
    let result_type = source_type_expr(fact.call_result);

    if (
      result_type?.tag === "product" &&
      returns_value_pack_syntax(binding.value.body, binding.name)
    ) {
      result_type = { ...result_type, value_pack: true };
    }

    if (
      result_type !== undefined &&
      param_types.every((param): param is TypeExpr => param !== undefined)
    ) {
      type_annotation = function_type(param_types, result_type);
      annotation = format_type_expr(type_annotation);

      if (
        pattern?.tag === "binding" && pattern.annotation === undefined &&
        pattern.type_annotation === undefined
      ) {
        pattern = {
          ...pattern,
          annotation,
          type_annotation,
        };
      }

      params = binding.value.params.map((param, index) => {
        if (
          param.annotation !== undefined || param.type_annotation !== undefined
        ) {
          return param;
        }

        const param_type = param_types[index];

        if (param_type === undefined) {
          throw new Error("Missing inferred function parameter type");
        }

        let type_annotation: TypeExpr | undefined;

        if (param_type.tag !== "name") {
          type_annotation = param_type;
        }
        return {
          ...param,
          annotation: format_type_expr(param_type),
          type_annotation,
        };
      });

      value = {
        ...value,
        params,
        pattern: annotated_function_pattern(value.pattern, param_types),
      };

      const contextual = apply_function_result_context(value, type_annotation);

      if (contextual.tag !== "lam" && contextual.tag !== "rec") {
        throw new Error("Inferred signature requires a function value");
      }

      value = contextual;
      changed = true;
    }
  }

  if (type_annotation === undefined) {
    params = binding.value.params.map((param, index) => {
      if (
        param.type_annotation !== undefined || param.annotation !== undefined
      ) {
        return param;
      }

      const param_type = source_type_expr(fact.call_params?.[index]);

      if (param_type === undefined) {
        return param;
      }

      changed = true;
      return annotated_param(param, param_type);
    });
  }

  if (!changed) {
    return undefined;
  }

  return {
    annotation,
    pattern,
    type_annotation,
    value: { ...value, params },
  };
}

function source_type_expr(
  fact: SourceTypeFact | undefined,
): TypeExpr | undefined {
  if (
    fact === undefined || fact.inference_variable ||
    fact.resolved_name === "unknown"
  ) {
    return undefined;
  }

  let type: TypeExpr | undefined;

  if (
    fact.call_params !== undefined && fact.call_result !== undefined
  ) {
    const params = fact.call_params.map(source_type_expr);
    const result = source_type_expr(fact.call_result);

    if (
      result !== undefined &&
      params.every((param): param is TypeExpr => param !== undefined)
    ) {
      type = function_type(params, result);
    }
  } else if (fact.nominal !== undefined) {
    type = { tag: "name", name: fact.nominal };

    for (const argument of fact.type_arguments || []) {
      const argument_type = source_type_expr(argument);

      if (argument_type === undefined) {
        type = undefined;
        break;
      }

      type = { tag: "apply", func: type, arg: argument_type };
    }
  } else if (fact.name === "struct" && fact.fields !== undefined) {
    const entries = fact.fields.map((field) => {
      const field_type = source_type_expr(field.type);

      if (field_type === undefined) {
        return undefined;
      }

      let label: string | undefined;

      if (!fact.positional_fields) {
        label = field.name;
      }

      return {
        label,
        type_expr: field_type,
      };
    });

    if (
      entries.every((entry): entry is {
        label: string | undefined;
        type_expr: TypeExpr;
      } => entry !== undefined)
    ) {
      type = { tag: "product", entries };
    }
  } else if (fact.name !== "Product") {
    try {
      type = parse_type_expr(tokenize(fact.name));
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
  }

  if (type === undefined || fact.modality === "owned") {
    return type;
  }

  if (fact.modality === "borrowed") {
    return { tag: "borrow", value: type };
  }

  return { tag: "frozen", value: type };
}

function function_type(params: TypeExpr[], result: TypeExpr): TypeExpr {
  let param: TypeExpr = { tag: "product", entries: [] };

  if (params.length === 1) {
    const only = params[0];

    if (only === undefined) {
      throw new Error("Missing inferred function parameter type");
    }

    param = only;
  } else if (params.length > 1) {
    param = {
      tag: "product",
      entries: params.map((type_expr) => ({ type_expr })),
    };
  }

  return { tag: "arrow", param, effects: undefined, result };
}

function returns_value_pack_syntax(
  expr: FrontExpr,
  recursive_name: string,
): boolean {
  if (expr.tag === "product") {
    return expr.value_pack === true;
  }

  if (
    expr.tag === "app" && expr.func.tag === "var" &&
    expr.func.name === recursive_name
  ) {
    return true;
  }

  if (expr.tag === "captured" || expr.tag === "comptime") {
    return returns_value_pack_syntax(expr.expr, recursive_name);
  }

  if (expr.tag === "scratch") {
    return returns_value_pack_syntax(expr.body, recursive_name);
  }

  if (expr.tag === "block") {
    const final_statement = expr.statements[expr.statements.length - 1];

    if (final_statement === undefined) {
      return false;
    }

    const result = stmt_result_expr(final_statement);
    return result !== undefined &&
      returns_value_pack_syntax(result, recursive_name);
  }

  if (expr.tag === "if" || expr.tag === "if_let") {
    return returns_value_pack_syntax(expr.then_branch, recursive_name) &&
      returns_value_pack_syntax(expr.else_branch, recursive_name);
  }

  if (expr.tag === "match") {
    return expr.arms.length > 0 &&
      expr.arms.every((arm) =>
        returns_value_pack_syntax(arm.body, recursive_name)
      );
  }

  return false;
}

function annotated_param(param: Param, type: TypeExpr): Param {
  return {
    ...param,
    annotation: format_type_expr(type),
    type_annotation: type,
  };
}

function annotated_function_pattern(
  pattern: Pattern | undefined,
  param_types: TypeExpr[],
): Pattern | undefined {
  if (pattern === undefined) {
    return undefined;
  }

  if (pattern.tag === "binding" && param_types.length === 1) {
    const type = param_types[0];

    if (type === undefined || pattern.annotation !== undefined) {
      return pattern;
    }

    let type_annotation: TypeExpr | undefined;

    if (type.tag !== "name") {
      type_annotation = type;
    }

    return { ...pattern, annotation: format_type_expr(type), type_annotation };
  }

  if (
    pattern.tag !== "product" || pattern.entries.length !== param_types.length
  ) {
    return pattern;
  }

  return {
    ...pattern,
    entries: pattern.entries.map((entry, index) => {
      const type = param_types[index];

      if (
        type === undefined || entry.pattern.tag !== "binding" ||
        entry.pattern.annotation !== undefined
      ) {
        return entry;
      }

      let type_annotation: TypeExpr | undefined;

      if (type.tag !== "name") {
        type_annotation = type;
      }

      return {
        ...entry,
        pattern: {
          ...entry.pattern,
          annotation: format_type_expr(type),
          type_annotation,
        },
      };
    }),
  };
}

function apply_inferred_signatures(
  source: Source,
  signatures: Map<string, InferredSignature>,
): Source {
  return {
    ...source,
    statements: source.statements.map((statement) => {
      if (statement.tag !== "bind") {
        return statement;
      }

      const signature = signatures.get(statement.name);
      let rewritten = statement;

      if (signature !== undefined) {
        rewritten = {
          ...statement,
          annotation: signature.annotation,
          pattern: signature.pattern,
          type_annotation: signature.type_annotation,
          value: signature.value,
        };
      }

      if (statement.mutual === undefined) {
        return rewritten;
      }

      return {
        ...rewritten,
        mutual: statement.mutual.map((member) => {
          const member_signature = signatures.get(member.name);

          if (member_signature === undefined) {
            return member;
          }

          let pattern = member_signature.pattern;

          if (pattern === undefined) {
            pattern = member.pattern;
          }

          return {
            ...member,
            annotation: member_signature.annotation,
            pattern,
            type_annotation: member_signature.type_annotation,
            value: member_signature.value,
          };
        }),
      };
    }),
  };
}

function function_bindings(source: Source): FunctionBinding[] {
  const bindings: FunctionBinding[] = [];

  for (const statement of source.statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    if (
      !statement.name.startsWith("_duck_extension#") &&
      (statement.value.tag === "lam" || statement.value.tag === "rec")
    ) {
      bindings.push(function_binding(statement, statement));
    }

    for (const member of statement.mutual || []) {
      if (member.value.tag === "lam" || member.value.tag === "rec") {
        bindings.push(function_binding(member, member));
      }
    }
  }

  return bindings;
}

function function_binding(
  binding: Extract<Stmt, { tag: "bind" }> | RecursiveBinding,
  owner: object,
): FunctionBinding {
  let kind: "let" | "const" = "let";

  if ("kind" in binding) {
    kind = binding.kind;
  }

  return {
    annotation: binding.annotation,
    kind,
    name: binding.name,
    owner,
    pattern: binding.pattern,
    recursive: binding.value.tag === "rec" ||
      ("is_recursive" in binding && binding.is_recursive === true),
    type_annotation: binding.type_annotation,
    value: binding.value,
  };
}

function function_components(
  bindings: Map<string, FunctionBinding>,
): string[][] {
  const dependencies = new Map<string, Set<string>>();

  for (const binding of bindings.values()) {
    const names = new Set<string>();
    collect_linear_closure_names(binding.value, names);
    dependencies.set(
      binding.name,
      new Set([...names].filter((name) => bindings.has(name))),
    );
  }

  const indices = new Map<string, number>();
  const low_links = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let next_index = 0;

  function connect(name: string): void {
    const index = next_index;
    next_index += 1;
    indices.set(name, index);
    low_links.set(name, index);
    stack.push(name);
    stacked.add(name);

    for (const dependency of dependencies.get(name) || []) {
      if (!indices.has(dependency)) {
        connect(dependency);
        const dependency_low_link = low_links.get(dependency);

        if (dependency_low_link === undefined) {
          throw new Error("Missing dependency low link " + dependency);
        }

        const low_link = low_links.get(name);

        if (low_link === undefined) {
          throw new Error("Missing function low link " + name);
        }

        low_links.set(name, Math.min(low_link, dependency_low_link));
      } else if (stacked.has(dependency)) {
        const dependency_index = indices.get(dependency);

        if (dependency_index === undefined) {
          throw new Error("Missing dependency index " + dependency);
        }

        const low_link = low_links.get(name);

        if (low_link === undefined) {
          throw new Error("Missing function low link " + name);
        }

        low_links.set(name, Math.min(low_link, dependency_index));
      }
    }

    if (low_links.get(name) !== indices.get(name)) {
      return;
    }

    const component: string[] = [];

    while (true) {
      const member = stack.pop();

      if (member === undefined) {
        throw new Error("Missing function component member " + name);
      }

      stacked.delete(member);
      component.push(member);

      if (member === name) {
        break;
      }
    }

    components.push(component);
  }

  for (const name of bindings.keys()) {
    if (!indices.has(name)) {
      connect(name);
    }
  }

  return components;
}
