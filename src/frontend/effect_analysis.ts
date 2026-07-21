import { expect } from "../expect.ts";
import type {
  EffectDeclaration,
  EffectRef,
  EffectRowExpr,
  FrontExpr,
  HandlerClause,
  Param,
  Source,
  Stmt,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import { val_type_from_type_name } from "./types.ts";
import { specialize_effect_operation } from "./effect_operation.ts";
import { resolve_effect_row } from "./effect_row.ts";
import { format_type_expr, function_type_expr } from "./type_expr.ts";
import { prim_result_type, prim_returns_bool } from "./numeric.ts";
import { specialize_prim_for_operands, type ValType } from "../op.ts";
import {
  const_i32_value,
  expanded_type_product_entries,
} from "./fixed_array_type.ts";

export type FrontEffectFunction = {
  name: string;
  effects: EffectRef[];
  annotated: boolean;
};

export type FrontEffectAnalysis = {
  module_effects: EffectRef[];
  functions: Record<string, FrontEffectFunction>;
};

type ActiveHandler = {
  effect: string;
  operations: Set<string>;
};

type CallEdge = {
  name: string;
  handlers: ActiveHandler[];
};

type EffectScan = {
  direct: Map<string, EffectRef>;
  calls: Map<string, CallEdge>;
};

type FunctionFact = {
  name: string;
  type_annotation: FunctionTypeExpr | undefined;
  parameter_effects: ParameterEffectRows;
  params: Param[];
  body: FrontExpr;
  direct: Map<string, EffectRef>;
  calls: Map<string, CallEdge>;
};

type FunctionTypeExpr = Extract<TypeExpr, { tag: "arrow" }>;
type ParameterEffectRows = Map<string, EffectRowExpr | undefined>;

type EffectIndex = {
  effects: Map<string, EffectDeclaration>;
  scalar_type_aliases: Map<string, string>;
};

type BindingValue = {
  value: FrontExpr;
  is_const: boolean;
};

type HandlerVariant = {
  expr: Extract<FrontExpr, { tag: "handler" }>;
};

type HandlerResolution = {
  effect: string;
  operations: Set<string>;
  variants: HandlerVariant[];
};

type AnalysisContext = {
  index: EffectIndex;
  bindings: Map<string, BindingValue>;
  scalar_type_aliases: Map<string, string>;
  active_parameter_effects: ParameterEffectRows;
  active_parameter_result_types: Map<string, string | undefined>;
  observed_effect_variables: Set<string> | undefined;
};

export function analyze_front_effects(source: Source): FrontEffectAnalysis {
  const scalar_type_aliases = front_scalar_type_aliases(source);
  const index = build_effect_index(source, scalar_type_aliases);
  const bindings = collect_binding_values(source.statements);
  const analysis = {
    index,
    bindings,
    scalar_type_aliases,
    active_parameter_effects: new Map<string, EffectRowExpr | undefined>(),
    active_parameter_result_types: new Map<string, string | undefined>(),
    observed_effect_variables: undefined,
  };
  const facts = collect_function_facts(source, analysis);
  infer_transitive_effects(facts);
  refine_function_effects(facts, analysis);
  validate_function_effects(facts, analysis);
  const module_scan = scan_statements(
    source.statements,
    analysis,
    facts,
    [],
  );
  const module_effects = effects_with_calls(module_scan, facts);
  validate_resolved_duck_root(module_effects, index);
  const functions: Record<string, FrontEffectFunction> = {};

  for (const fact of facts.values()) {
    const has_latent_row = fact.type_annotation?.effects !== undefined;

    if (fact.direct.size === 0 && !has_latent_row) {
      continue;
    }

    const item: FrontEffectFunction = {
      name: fact.name,
      effects: sorted_effects(fact.direct),
      annotated: fact.type_annotation !== undefined,
    };

    functions[fact.name] = item;
  }

  return { module_effects: sorted_effects(module_effects), functions };
}

export function analyze_front_expression_effects(
  source: Source,
  expr: FrontExpr,
): EffectRef[] {
  const scalar_type_aliases = front_scalar_type_aliases(source);
  const index = build_effect_index(source, scalar_type_aliases);
  const bindings = collect_binding_values(source.statements);
  const analysis: AnalysisContext = {
    index,
    bindings,
    scalar_type_aliases,
    active_parameter_effects: new Map(),
    active_parameter_result_types: new Map(),
    observed_effect_variables: undefined,
  };
  const facts = collect_function_facts(source, analysis);
  infer_transitive_effects(facts);
  refine_function_effects(facts, analysis);
  const scan = scan_expr(expr, analysis, facts, false, []);
  return sorted_effects(effects_with_calls(scan, facts));
}

function build_effect_index(
  source: Source,
  scalar_type_aliases: Map<string, string>,
): EffectIndex {
  const effects = new Map<string, EffectDeclaration>();
  let declarations = source.declarations;

  if (!declarations) {
    declarations = [];
  }

  for (const declaration of declarations) {
    if (declaration.tag !== "effect") {
      continue;
    }

    expect(
      !effects.has(declaration.name),
      "Duplicate effect declaration: " + declaration.name,
    );
    effects.set(declaration.name, declaration);
    const operation_names = new Set<string>();

    for (const operation of declaration.operations) {
      expect(
        !operation_names.has(operation.name),
        "Duplicate effect operation: " + declaration.name + "." +
          operation.name,
      );
      operation_names.add(operation.name);
    }
  }

  return { effects, scalar_type_aliases };
}

export function front_scalar_type_aliases(
  source: Source,
): Map<string, string> {
  const declarations = new Map<string, TypeDeclaration>();

  for (const declaration of source.declarations || []) {
    if (declaration.tag === "type") {
      declarations.set(declaration.name, declaration);
    }
  }

  const aliases = new Map<string, string>();

  for (const name of declarations.keys()) {
    const resolved = resolve_declared_scalar_alias(
      name,
      declarations,
      new Set(),
    );

    if (resolved) {
      aliases.set(name, resolved);
    }
  }

  return aliases;
}

function resolve_declared_scalar_alias(
  name: string,
  declarations: Map<string, TypeDeclaration>,
  resolving: Set<string>,
): string | undefined {
  if (val_type_from_type_name(name) || name === "Unit") {
    return name;
  }

  const declaration = declarations.get(name);

  if (
    !declaration || declaration.params.length !== 0 ||
    declaration.body.tag !== "alias" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(declaration.body.type_name)
  ) {
    return undefined;
  }

  if (resolving.has(name)) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(name);
  return resolve_declared_scalar_alias(
    declaration.body.type_name,
    declarations,
    next,
  );
}

export function normalize_front_effect_scalar_alias_ownership(
  source: Source,
  scalar_type_aliases: Map<string, string>,
): void {
  for (const declaration of source.declarations || []) {
    if (declaration.tag !== "effect") {
      continue;
    }

    for (const operation of declaration.operations) {
      for (const param of operation.params) {
        if (
          param.ownership === "ownership_transfer" &&
          scalar_type_aliases.has(param.type_name)
        ) {
          param.ownership = "scalar";
        }
      }

      if (
        operation.result.ownership === "unique_heap" &&
        scalar_type_aliases.has(operation.result.type_name)
      ) {
        operation.result.ownership = "scalar";
      }
    }
  }
}

function collect_binding_values(
  statements: Stmt[],
  result: Map<string, BindingValue> = new Map(),
): Map<string, BindingValue> {
  for (const stmt of statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    result.set(stmt.name, {
      value: stmt.value,
      is_const: stmt.kind === "const",
    });

    if (
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      stmt.value.body.tag === "block"
    ) {
      collect_binding_values(
        stmt.value.body.statements,
        result,
      );
    }
  }

  return result;
}

function collect_function_facts(
  source: Source,
  analysis: AnalysisContext,
): Map<string, FunctionFact> {
  const facts = new Map<string, FunctionFact>();

  collect_function_facts_from_statements(source.statements, analysis, facts);
  return facts;
}

function collect_function_facts_from_statements(
  statements: Stmt[],
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact>,
): void {
  for (const stmt of statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    if (stmt.value.tag !== "lam" && stmt.value.tag !== "rec") {
      continue;
    }

    const value = stmt.value;

    let type_annotation: FunctionTypeExpr | undefined;

    const declared_function_type = function_type_expr(stmt.type_annotation);

    if (declared_function_type) {
      type_annotation = declared_function_type;
      const params = function_type_params(type_annotation, analysis);
      expect(
        params.length === value.params.length,
        "Function type on " + stmt.name + " expects " +
          params.length.toString() + " parameters, got " +
          value.params.length.toString(),
      );
    }

    const parameter_effects = function_parameter_effects(
      type_annotation,
      value.params,
      analysis,
    );
    const parameter_result_types = function_parameter_result_types(
      type_annotation,
      value.params,
      analysis,
    );

    const scan = with_parameter_effects(
      analysis,
      parameter_effects,
      () => {
        return with_parameter_result_types(
          analysis,
          parameter_result_types,
          () => {
            return scan_expr(
              value.body,
              analysis,
              undefined,
              false,
              [],
            );
          },
        );
      },
    );
    facts.set(stmt.name, {
      name: stmt.name,
      type_annotation,
      parameter_effects,
      params: value.params,
      body: value.body,
      direct: scan.direct,
      calls: scan.calls,
    });

    if (value.body.tag === "block") {
      collect_function_facts_from_statements(
        value.body.statements,
        analysis,
        facts,
      );
    }
  }
}

function infer_transitive_effects(facts: Map<string, FunctionFact>): void {
  let changed = true;

  while (changed) {
    changed = false;

    for (const fact of facts.values()) {
      for (const edge of fact.calls.values()) {
        const called = facts.get(edge.name);

        if (!called) {
          continue;
        }

        const before = fact.direct.size;
        merge_visible_effects(fact.direct, called.direct, edge.handlers);

        if (fact.direct.size !== before) {
          changed = true;
        }
      }
    }
  }
}

function refine_function_effects(
  facts: Map<string, FunctionFact>,
  analysis: AnalysisContext,
): void {
  let changed = true;

  while (changed) {
    let before = 0;

    for (const fact of facts.values()) {
      before += fact.direct.size + fact.calls.size;
      const scan = with_parameter_effects(
        analysis,
        fact.parameter_effects,
        () => {
          return with_parameter_result_types(
            analysis,
            function_parameter_result_types(
              fact.type_annotation,
              fact.params,
              analysis,
            ),
            () => {
              return scan_expr(
                fact.body,
                analysis,
                facts,
                false,
                [],
              );
            },
          );
        },
      );
      merge_effects(fact.direct, scan.direct);
      merge_calls(fact.calls, scan.calls);
    }

    infer_transitive_effects(facts);
    let after = 0;

    for (const fact of facts.values()) {
      after += fact.direct.size + fact.calls.size;
    }

    changed = after !== before;
  }
}

function validate_function_effects(
  facts: Map<string, FunctionFact>,
  analysis: AnalysisContext,
): void {
  for (const fact of facts.values()) {
    const observed_effect_variables = new Set<string>();
    with_parameter_effects(
      analysis,
      fact.parameter_effects,
      () => {
        with_parameter_result_types(
          analysis,
          function_parameter_result_types(
            fact.type_annotation,
            fact.params,
            analysis,
          ),
          () => {
            with_effect_variable_observer(
              analysis,
              observed_effect_variables,
              () => {
                scan_expr(
                  fact.body,
                  analysis,
                  facts,
                  false,
                  [],
                );
              },
            );
          },
        );
      },
    );
    validate_function_value_type(
      fact,
      analysis.index.effects,
      observed_effect_variables,
      analysis.scalar_type_aliases,
      analysis,
    );

    const allowed_rows: { label: string; operations: EffectRef[] }[] = [];

    if (fact.type_annotation) {
      let operations: EffectRef[] = [];

      if (fact.type_annotation.effects) {
        const resolved = resolve_type_effect_row(
          fact.type_annotation.effects,
          analysis.index.effects,
          new Map(),
          true,
        );
        operations = Array.from(resolved.effects.values());
      }

      allowed_rows.push({
        label: "Function type on " + fact.name,
        operations,
      });
    }

    for (const row of allowed_rows) {
      const allowed = new Set(
        row.operations.map((effect) => effect_key(effect)),
      );

      for (const effect of fact.direct.values()) {
        if (!allowed.has(effect_key(effect))) {
          throw new Error(
            row.label + " does not allow " + effect_text(effect),
          );
        }
      }
    }
  }
}

function validate_function_value_type(
  fact: FunctionFact,
  effects: Map<string, EffectDeclaration>,
  observed_effect_variables: Set<string>,
  scalar_type_aliases: Map<string, string>,
  analysis: AnalysisContext,
): void {
  const type = fact.type_annotation;

  if (!type) {
    for (const variable of observed_effect_variables) {
      throw new Error(
        "Row-polymorphic callback parameter " + variable + " on " +
          fact.name + " requires a binding function type",
      );
    }

    return;
  }

  const param_types = function_type_params(type, analysis);
  const value_types = new Map<string, string>();
  let outer_effects: ResolvedTypeEffectRow = {
    effects: new Map(),
    variables: new Set(),
  };

  if (type.effects) {
    outer_effects = resolve_type_effect_row(
      type.effects,
      effects,
      new Map(),
      true,
    );
  }

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const param = fact.params[index];
    expect(param_type, "Missing function parameter type " + index.toString());
    expect(param, "Missing function parameter " + index.toString());

    if (param_type.tag === "arrow") {
      continue;
    }

    if (param_type.tag !== "name") {
      continue;
    }

    if (param.annotation) {
      expect(
        same_declared_type(
          param.annotation,
          param_type.name,
          scalar_type_aliases,
        ),
        "Function type on " + fact.name + " expects parameter " +
          param.name + " to be " + param_type.name + ", got " +
          param.annotation,
      );
    }

    value_types.set(param.name, param_type.name);
  }

  for (const variable of observed_effect_variables) {
    expect(
      outer_effects.variables.has(variable),
      "Function type on " + fact.name +
        " does not expose callback row variable " + variable,
    );
  }

  if (type.result.tag !== "name") {
    return;
  }

  const result = infer_simple_type(
    fact.body,
    value_types,
    scalar_type_aliases,
  );

  if (!result) {
    return;
  }

  expect(
    same_declared_type(
      result,
      type.result.name,
      scalar_type_aliases,
    ),
    "Function type on " + fact.name + " returns " + type.result.name +
      ", got " + result,
  );
}

function function_type_params(
  type: FunctionTypeExpr,
  analysis: AnalysisContext,
): TypeExpr[] {
  if (type.param.tag === "tuple") {
    return type.param.items;
  }

  if (type.param.tag === "product") {
    return expanded_type_product_entries(
      type.param,
      (name) => effect_const_i32_name(name, analysis, new Set()),
    ).map((entry) => entry.type_expr);
  }

  return [type.param];
}

function effect_const_i32_name(
  name: string,
  analysis: AnalysisContext,
  resolving: Set<string>,
): number | undefined {
  if (resolving.has(name)) {
    return undefined;
  }

  const binding = analysis.bindings.get(name);

  if (binding === undefined || !binding.is_const) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(name);
  return const_i32_value(
    binding.value,
    (nested_name) => effect_const_i32_name(nested_name, analysis, next),
  );
}

function function_parameter_effects(
  type: FunctionTypeExpr | undefined,
  params: Param[],
  analysis: AnalysisContext,
): ParameterEffectRows {
  const result = new Map<string, EffectRowExpr | undefined>();
  let types: TypeExpr[] = [];

  if (type) {
    types = function_type_params(type, analysis);
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const param_type = types[index];
    expect(param, "Missing function parameter " + index.toString());

    if (param.type_annotation && param_type) {
      expect(
        format_type_expr(param.type_annotation) ===
          format_type_expr(param_type),
        "Function parameter type on " + param.name +
          " conflicts with its binding function type",
      );
    }

    let callback_type = param.type_annotation;

    if (param_type) {
      callback_type = param_type;
    }

    const callback_function_type = function_type_expr(callback_type);

    if (callback_function_type) {
      result.set(param.name, callback_function_type.effects);
    }
  }

  return result;
}

function function_parameter_result_types(
  type: FunctionTypeExpr | undefined,
  params: Param[],
  analysis: AnalysisContext,
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  let types: TypeExpr[] = [];

  if (type) {
    types = function_type_params(type, analysis);
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const param_type = types[index];
    expect(param, "Missing function parameter " + index.toString());

    let callback_type = param.type_annotation;

    if (param_type) {
      callback_type = param_type;
    }

    const callback_function_type = function_type_expr(callback_type);

    if (callback_function_type) {
      if (callback_function_type.result.tag === "name") {
        result.set(param.name, callback_function_type.result.name);
      } else {
        result.set(param.name, undefined);
      }
    }
  }

  return result;
}

function with_parameter_effects<value>(
  analysis: AnalysisContext,
  effects: ParameterEffectRows,
  run: () => value,
): value {
  const previous = analysis.active_parameter_effects;
  analysis.active_parameter_effects = effects;

  try {
    return run();
  } finally {
    analysis.active_parameter_effects = previous;
  }
}

function with_parameter_result_types<value>(
  analysis: AnalysisContext,
  result_types: Map<string, string | undefined>,
  run: () => value,
): value {
  const previous = analysis.active_parameter_result_types;
  analysis.active_parameter_result_types = result_types;

  try {
    return run();
  } finally {
    analysis.active_parameter_result_types = previous;
  }
}

function active_parameter_effect_row(
  name: string,
  analysis: AnalysisContext,
): ResolvedTypeEffectRow | undefined {
  if (!analysis.active_parameter_effects.has(name)) {
    return undefined;
  }

  const row = analysis.active_parameter_effects.get(name);

  if (!row) {
    return { effects: new Map(), variables: new Set() };
  }

  return resolve_type_effect_row(
    row,
    analysis.index.effects,
    new Map(),
    true,
  );
}

function with_effect_variable_observer<value>(
  analysis: AnalysisContext,
  variables: Set<string>,
  run: () => value,
): value {
  const previous = analysis.observed_effect_variables;
  analysis.observed_effect_variables = variables;

  try {
    return run();
  } finally {
    analysis.observed_effect_variables = previous;
  }
}

type ResolvedTypeEffectRow = {
  effects: Map<string, EffectRef>;
  variables: Set<string>;
};

function resolve_type_effect_row(
  row: EffectRowExpr,
  effects: Map<string, EffectDeclaration>,
  bindings: Map<string, ResolvedTypeEffectRow>,
  allow_unbound: boolean,
): ResolvedTypeEffectRow {
  if (row.tag === "variable") {
    const bound = bindings.get(row.name);

    if (bound) {
      return {
        effects: new Map(bound.effects),
        variables: new Set(bound.variables),
      };
    }

    expect(
      allow_unbound,
      "Cannot infer effect row variable: " + row.name,
    );
    return { effects: new Map(), variables: new Set([row.name]) };
  }

  if (row.tag === "family" || row.tag === "operation") {
    const resolved = resolve_effect_row(row, effects);
    return {
      effects: new Map(resolved.map((effect) => [effect_key(effect), effect])),
      variables: new Set(),
    };
  }

  if (row.tag === "group") {
    return resolve_type_effect_row(
      row.value,
      effects,
      bindings,
      allow_unbound,
    );
  }

  const left = resolve_type_effect_row(
    row.left,
    effects,
    bindings,
    allow_unbound,
  );
  const right = resolve_type_effect_row(
    row.right,
    effects,
    bindings,
    allow_unbound,
  );

  if (row.tag === "union") {
    merge_effects(left.effects, right.effects);

    for (const variable of right.variables) {
      left.variables.add(variable);
    }

    return left;
  }

  let operator = "\\";

  if (row.tag === "intersection") {
    operator = "&";
  }

  expect(
    left.variables.size === 0 && right.variables.size === 0,
    "Effect row variables under `" + operator +
      "` require a concrete call-site row",
  );

  if (row.tag === "intersection") {
    for (const operation of Array.from(left.effects.keys())) {
      if (!right.effects.has(operation)) {
        left.effects.delete(operation);
      }
    }

    return left;
  }

  if (row.tag === "difference") {
    for (const operation of right.effects.keys()) {
      left.effects.delete(operation);
    }

    return left;
  }

  row satisfies never;
  throw new Error("Unknown effect row expression");
}

function instantiate_call_effects(
  expr: Extract<FrontExpr, { tag: "app" }>,
  called: FunctionFact,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact>,
): ResolvedTypeEffectRow {
  const type = called.type_annotation;
  expect(type, "Missing function type for " + called.name);
  const param_types = function_type_params(type, analysis);
  const bindings = new Map<string, ResolvedTypeEffectRow>();

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const arg = expr.args[index];
    expect(param_type, "Missing parameter type for " + called.name);
    expect(arg, "Missing argument for " + called.name);

    if (param_type.tag !== "arrow") {
      continue;
    }

    const actual = latent_effects_of_expr(
      arg,
      analysis,
      facts,
    );

    if (!actual) {
      continue;
    }

    if (!param_type.effects) {
      expect(
        actual.effects.size === 0 && actual.variables.size === 0,
        "Function argument " + (index + 1).toString() + " to " +
          called.name + " exceeds its pure callback type",
      );
      continue;
    }

    const declared = resolve_type_effect_row(
      param_type.effects,
      analysis.index.effects,
      new Map(),
      true,
    );

    if (declared.variables.size === 0) {
      expect(
        actual.variables.size === 0,
        "Function argument " + (index + 1).toString() + " to " +
          called.name + " has an unresolved effect row",
      );

      for (const effect of actual.effects.values()) {
        expect(
          declared.effects.has(effect_key(effect)),
          "Function argument " + (index + 1).toString() + " to " +
            called.name + " exceeds its effect row with " +
            effect_text(effect),
        );
      }

      continue;
    }

    expect(
      declared.variables.size === 1,
      "Cannot infer multiple effect row variables in one parameter of " +
        called.name,
    );
    const variable = Array.from(declared.variables)[0];
    expect(variable, "Missing effect row variable for " + called.name);
    let bound = bindings.get(variable);

    if (!bound) {
      bound = { effects: new Map(), variables: new Set() };
      bindings.set(variable, bound);
    }

    for (const [operation, effect] of actual.effects) {
      if (!declared.effects.has(operation)) {
        bound.effects.set(operation, effect);
      }
    }

    for (const actual_variable of actual.variables) {
      bound.variables.add(actual_variable);
    }
  }

  let result: ResolvedTypeEffectRow = {
    effects: new Map(),
    variables: new Set(),
  };

  if (type.effects) {
    result = resolve_type_effect_row(
      type.effects,
      analysis.index.effects,
      bindings,
      true,
    );
  }

  if (analysis.observed_effect_variables) {
    for (const variable of result.variables) {
      analysis.observed_effect_variables.add(variable);
    }
  }

  const available_variables = new Set<string>();

  for (const row of analysis.active_parameter_effects.values()) {
    if (!row) {
      continue;
    }

    const resolved = resolve_type_effect_row(
      row,
      analysis.index.effects,
      new Map(),
      true,
    );

    for (const variable of resolved.variables) {
      available_variables.add(variable);
    }
  }

  for (const variable of result.variables) {
    expect(
      available_variables.has(variable),
      "Cannot infer effect row variable " + variable + " while calling " +
        called.name,
    );
  }

  return result;
}

function validate_parameter_callback_arguments(
  expr: Extract<FrontExpr, { tag: "app" }>,
  called: FunctionFact,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact>,
): void {
  let args = expr.args;
  const packed = expr.args[0];

  if (
    expr.args.length === 1 && packed !== undefined &&
    packed.tag === "product" &&
    packed.entries.length === called.params.length
  ) {
    args = packed.entries.map((entry) => entry.value);
  }

  for (let index = 0; index < called.params.length; index += 1) {
    const param = called.params[index];
    expect(param, "Missing parameter for " + called.name);

    if (param.is_variadic === true) {
      continue;
    }

    const arg = args[index];
    expect(arg, "Missing argument for " + called.name);
    const param_type = param.type_annotation;

    if (!param_type || param_type.tag !== "arrow") {
      continue;
    }

    const actual = latent_effects_of_expr(
      arg,
      analysis,
      facts,
    );

    if (!actual) {
      continue;
    }

    if (!param_type.effects) {
      expect(
        actual.effects.size === 0 && actual.variables.size === 0,
        "Function argument " + (index + 1).toString() + " to " +
          called.name + " exceeds its pure callback type",
      );
      continue;
    }

    const declared = resolve_type_effect_row(
      param_type.effects,
      analysis.index.effects,
      new Map(),
      true,
    );

    if (declared.variables.size > 0) {
      continue;
    }

    expect(
      actual.variables.size === 0,
      "Function argument " + (index + 1).toString() + " to " + called.name +
        " has an unresolved effect row",
    );

    for (const effect of actual.effects.values()) {
      expect(
        declared.effects.has(effect_key(effect)),
        "Function argument " + (index + 1).toString() + " to " +
          called.name + " exceeds its effect row with " + effect_text(effect),
      );
    }
  }
}

function latent_effects_of_expr(
  expr: FrontExpr,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact>,
): ResolvedTypeEffectRow | undefined {
  if (expr.tag === "lam" || expr.tag === "rec") {
    const variables = new Set<string>();
    const scan = with_effect_variable_observer(
      analysis,
      variables,
      () => {
        return scan_expr(
          expr.body,
          analysis,
          facts,
          false,
          [],
        );
      },
    );
    return {
      effects: effects_with_calls(scan, facts),
      variables,
    };
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const fact = facts.get(expr.name);

  if (fact) {
    return { effects: new Map(fact.direct), variables: new Set() };
  }

  const parameter_row = active_parameter_effect_row(expr.name, analysis);

  if (!parameter_row) {
    return undefined;
  }

  return parameter_row;
}

function validate_resolved_duck_root(
  effects: Map<string, EffectRef>,
  index: EffectIndex,
): void {
  for (const effect of sorted_effects(effects)) {
    const declaration = index.effects.get(effect.effect);
    expect(declaration, "Missing effect declaration: " + effect.effect);

    if (declaration.implementation === "duck") {
      throw new Error(
        "Unresolved Duck effect at module boundary: " + effect_text(effect),
      );
    }
  }
}

function scan_statements(
  statements: Stmt[],
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  handlers: ActiveHandler[],
): EffectScan {
  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  for (const stmt of statements) {
    if (stmt.tag === "state_bind") {
      const operation = direct_effect_call(stmt.value, analysis.index);
      expect(
        operation,
        "Effect bind must call a declared effect operation",
      );

      add_visible_effect(direct, operation, handlers);
      const nested = scan_app_args(
        stmt.value,
        analysis,
        facts,
        handlers,
      );
      merge_scan(direct, calls, nested);
      continue;
    }

    if (stmt.tag === "bind_pattern" || stmt.tag === "resume_dup") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "bind") {
      if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
        continue;
      }

      if (facts && function_type_expr(stmt.type_annotation)) {
        throw new Error(
          "Typed function alias " + stmt.name +
            " is not supported yet; bind a function literal instead",
        );
      }

      if (facts && stmt.value.tag === "var") {
        const aliased = facts.get(stmt.value.name);

        if (
          aliased &&
          (aliased.direct.size > 0 ||
            aliased.type_annotation?.effects !== undefined)
        ) {
          throw new Error(
            "Effectful named function " + stmt.value.name +
              " cannot be aliased as " + stmt.name + " yet",
          );
        }
      }

      const scan = scan_expr(
        stmt.value,
        analysis,
        facts,
        false,
        handlers,
      );

      if (facts) {
        const effectful = expression_is_effectful(
          stmt.value,
          analysis,
          facts,
          scan,
        );

        if (stmt.effectful) {
          expect(
            effectful,
            "Effect bind for " + stmt.name +
              " requires an effectful computation",
          );
        } else {
          expect(
            !effectful,
            "Effectful binding " + stmt.name + " must use `<-`",
          );
        }
      }

      merge_scan(direct, calls, scan);
      continue;
    }

    if (stmt.tag === "assign") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "index_assign") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.index,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "expr") {
      const scan = scan_expr(
        stmt.expr,
        analysis,
        facts,
        false,
        handlers,
      );

      if (stmt.effectful && facts) {
        expect(
          expression_is_effectful(
            stmt.expr,
            analysis,
            facts,
            scan,
          ),
          "Unit effect bind requires an effectful computation",
        );

        const result_type = infer_effect_bind_result_type(
          stmt.expr,
          analysis,
          facts,
        );
        expect(
          result_type,
          "Cannot infer result type of discarded effect computation",
        );
        expect(
          effect_result_is_discardable_scalar(
            result_type,
            analysis.scalar_type_aliases,
          ),
          "Discarding an effectful function result requires an explicit " +
            "cleanup path for owned results; bind the result until owned " +
            "function-result discard lowering is implemented",
        );
      }

      merge_scan(direct, calls, scan);
      continue;
    }

    if (stmt.tag === "return") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "for_range") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.start,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.end,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.step,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "for_collection") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.collection,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "if_stmt") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.cond,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.target,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "type_check") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.target,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
    }
  }

  return { direct, calls };
}

function scan_expr(
  expr: FrontExpr,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  allow_direct: boolean,
  handlers: ActiveHandler[],
): EffectScan {
  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  if (expr.tag === "app") {
    const operation = direct_effect_call(expr, analysis.index);

    if (operation) {
      expect(
        allow_direct,
        "Effect operation " + effect_text(operation) +
          " must be bound with `<-`",
      );
      add_visible_effect(direct, operation, handlers);
    } else if (expr.func.tag === "var") {
      const parameter_row = active_parameter_effect_row(
        expr.func.name,
        analysis,
      );

      if (parameter_row) {
        merge_visible_effects(direct, parameter_row.effects, handlers);

        if (analysis.observed_effect_variables) {
          for (const variable of parameter_row.variables) {
            analysis.observed_effect_variables.add(variable);
          }
        }
      } else {
        add_call(calls, expr.func.name, handlers);
      }

      if (facts) {
        const called = facts.get(expr.func.name);

        if (called) {
          if (called.type_annotation) {
            const instantiated = instantiate_call_effects(
              expr,
              called,
              analysis,
              facts,
            );
            merge_visible_effects(direct, instantiated.effects, handlers);
          } else {
            validate_parameter_callback_arguments(
              expr,
              called,
              analysis,
              facts,
            );
          }
        }
      }
    } else if (
      facts && (expr.func.tag === "lam" || expr.func.tag === "rec")
    ) {
      const invoked = scan_expr(
        expr.func.body,
        analysis,
        facts,
        false,
        [],
      );
      merge_visible_effects(
        direct,
        effects_with_calls(invoked, facts),
        handlers,
      );
    }

    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.func,
        analysis,
        facts,
        true,
        handlers,
      ),
    );

    for (const arg of expr.args) {
      merge_scan(
        direct,
        calls,
        scan_expr(arg, analysis, facts, false, handlers),
      );
    }

    return { direct, calls };
  }

  if (expr.tag === "block") {
    return scan_statements(
      expr.statements,
      analysis,
      facts,
      handlers,
    );
  }

  if (expr.tag === "handler") {
    validate_handler_shape(expr, analysis.index);

    for (const state of expr.state) {
      const state_scan = scan_expr(
        state.value,
        analysis,
        facts,
        false,
        handlers,
      );

      if (facts) {
        const pure_scan = scan_expr(
          state.value,
          analysis,
          facts,
          false,
          [],
        );
        const state_effects = effects_with_calls(pure_scan, facts);
        expect(
          state_effects.size === 0,
          "Handler state initializer must be pure: " + state.name +
            format_effect_suffix(state_effects),
        );
      }

      merge_scan(direct, calls, state_scan);
    }

    return { direct, calls };
  }

  if (expr.tag === "try_with") {
    if (expr.infer_default_handlers === true) {
      return scan_expr(
        expr.body,
        analysis,
        facts,
        false,
        handlers,
      );
    }

    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.handler,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
    const resolution = resolve_handler_expr(
      expr.handler,
      analysis,
      new Map(),
      new Set(),
    );
    expect(resolution, "Cannot resolve handler expression statically");
    const active = {
      effect: resolution.effect,
      operations: new Set(resolution.operations),
    };
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.body,
        analysis,
        facts,
        false,
        [active, ...handlers],
      ),
    );

    for (const variant of resolution.variants) {
      merge_scan(
        direct,
        calls,
        scan_handler_dependencies(
          variant,
          analysis,
          facts,
          handlers,
        ),
      );
    }

    return { direct, calls };
  }

  if (expr.tag === "prim") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.left, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(expr.right, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "lam" || expr.tag === "rec") {
    return { direct, calls };
  } else if (expr.tag === "comptime") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.expr, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "borrow" || expr.tag === "freeze") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.value, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "scratch") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.body, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "loop") {
    merge_scan(
      direct,
      calls,
      scan_statements(expr.body, analysis, facts, handlers),
    );
  } else if (expr.tag === "captured") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.expr, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "with" || expr.tag === "struct_update") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.base, analysis, facts, false, handlers),
    );

    for (const field of expr.fields) {
      merge_scan(
        direct,
        calls,
        scan_expr(field.value, analysis, facts, false, handlers),
      );
    }
  } else if (expr.tag === "struct_value") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.type_expr, analysis, facts, false, handlers),
    );

    for (const field of expr.fields) {
      merge_scan(
        direct,
        calls,
        scan_expr(field.value, analysis, facts, false, handlers),
      );
    }
  } else if (expr.tag === "if") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.cond, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.then_branch,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.else_branch,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
  } else if (expr.tag === "if_let") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.target, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.then_branch,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.else_branch,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
  } else if (expr.tag === "match") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.target, analysis, facts, false, handlers),
    );

    for (const arm of expr.arms) {
      if (arm.guard !== undefined) {
        merge_scan(
          direct,
          calls,
          scan_expr(arm.guard, analysis, facts, false, handlers),
        );
      }

      merge_scan(
        direct,
        calls,
        scan_expr(arm.body, analysis, facts, false, handlers),
      );
    }
  } else if (expr.tag === "field") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.object, analysis, facts, true, handlers),
    );
  } else if (expr.tag === "index") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.object, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(expr.index, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "union_case" && expr.value) {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.value, analysis, facts, false, handlers),
    );
  }

  return { direct, calls };
}

function scan_handler_dependencies(
  variant: HandlerVariant,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  outer_handlers: ActiveHandler[],
): EffectScan {
  const scan = scan_handler_dependency_bodies(
    variant,
    analysis,
    facts,
    outer_handlers,
  );

  return scan;
}

function scan_handler_dependency_bodies(
  variant: HandlerVariant,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  handlers: ActiveHandler[],
): EffectScan {
  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  for (const clause of variant.expr.clauses) {
    merge_scan(
      direct,
      calls,
      scan_expr(
        clause.body,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
  }

  merge_scan(
    direct,
    calls,
    scan_expr(
      variant.expr.return_clause.body,
      analysis,
      facts,
      false,
      handlers,
    ),
  );
  return { direct, calls };
}

function scan_app_args(
  expr: FrontExpr,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  handlers: ActiveHandler[],
): EffectScan {
  if (expr.tag !== "app") {
    return { direct: new Map(), calls: new Map() };
  }

  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  for (const arg of expr.args) {
    merge_scan(
      direct,
      calls,
      scan_expr(arg, analysis, facts, false, handlers),
    );
  }

  return { direct, calls };
}

function direct_effect_call(
  expr: FrontExpr,
  index: EffectIndex,
): EffectRef | undefined {
  if (expr.tag !== "app" || expr.func.tag !== "field") {
    return undefined;
  }

  const object = expr.func.object;

  if (object.tag === "var") {
    const effect = index.effects.get(object.name);

    if (effect) {
      const operation_name = expr.func.name;
      expect(
        effect.operations.some((operation) => {
          return operation.name === operation_name;
        }),
        "Unknown effect operation: " + object.name + "." + operation_name,
      );
      return { effect: object.name, operation: operation_name };
    }
  }

  return undefined;
}

function expression_is_effectful(
  expr: FrontExpr,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact>,
  scan: EffectScan,
): boolean {
  if (direct_effect_call(expr, analysis.index)) {
    return true;
  }

  if (expr.tag === "app" && expr.func.tag === "var") {
    const parameter_row = active_parameter_effect_row(
      expr.func.name,
      analysis,
    );

    if (parameter_row) {
      return parameter_row.effects.size > 0 || parameter_row.variables.size > 0;
    }

    const called = facts.get(expr.func.name);

    if (called) {
      if (called.direct.size > 0) {
        return true;
      }

      if (called.type_annotation) {
        const instantiated = instantiate_call_effects(
          expr,
          called,
          analysis,
          facts,
        );

        if (
          instantiated.effects.size > 0 ||
          instantiated.variables.size > 0
        ) {
          return true;
        }
      }
    }
  }

  return effects_with_calls(scan, facts).size > 0;
}

function validate_handler_shape(
  handler: Extract<FrontExpr, { tag: "handler" }>,
  index: EffectIndex,
): void {
  const effect = index.effects.get(handler.effect);
  expect(effect, "Unknown handled effect: " + handler.effect);
  expect(
    effect.implementation === "duck",
    "Cannot handle host-declared effect: " + handler.effect,
  );
  const state_names = new Set<string>();
  const state_types = new Map<string, string>();

  for (const state of handler.state) {
    expect(
      !state_names.has(state.name),
      "Duplicate handler state binding: " + state.name,
    );
    state_names.add(state.name);
    const state_type = state.annotation ||
      infer_simple_type(state.value, new Map());

    if (state_type) {
      state_types.set(state.name, state_type);
    }
  }

  const clauses = new Set<string>();
  const return_types = new Map(state_types);

  if (handler.return_clause.param.annotation) {
    return_types.set(
      handler.return_clause.param.name,
      handler.return_clause.param.annotation,
    );
  }

  const handler_output_type = infer_simple_type(
    handler.return_clause.body,
    return_types,
  );

  for (const clause of handler.clauses) {
    expect(
      !clauses.has(clause.name),
      "Duplicate handler clause: " + handler.effect + "." + clause.name,
    );
    clauses.add(clause.name);
    const operation = effect.operations.find((candidate) => {
      return candidate.name === clause.name;
    });
    expect(
      operation,
      "Unknown handler clause: " + handler.effect + "." + clause.name,
    );
    expect(
      clause.params.length === operation.params.length + 1,
      "Handler clause " + handler.effect + "." + clause.name + " expects " +
        (operation.params.length + 1).toString() + " parameters, got " +
        clause.params.length.toString(),
    );
    const resume = clause.params[clause.params.length - 1];
    expect(resume, "Missing handler resumption parameter");
    if (resume.annotation) {
      expect(
        resume.annotation === "Resume",
        "Handler resumption parameter " + resume.name +
          " expects Resume, got " + resume.annotation,
      );
    }
    const clause_types = new Map(state_types);

    for (
      let param_index = 0;
      param_index < operation.params.length;
      param_index += 1
    ) {
      const param = clause.params[param_index];
      const declared = operation.params[param_index];
      expect(param, "Missing handler clause parameter");
      expect(declared, "Missing effect operation parameter");
      if (param.annotation) {
        expect(
          same_declared_type(
            param.annotation,
            declared.type_name,
            index.scalar_type_aliases,
          ),
          "Handler clause parameter " + param.name + " expects " +
            declared.type_name + ", got " + param.annotation,
        );
      }
      clause_types.set(param.name, declared.type_name);
    }

    validate_resume_argument_types(
      clause.body,
      resume.name,
      operation.result.type_name,
      clause_types,
    );
    validate_handler_state_assignments(clause, state_names);
    validate_state_assignment_types(clause.body, state_types, clause_types);
    const clause_output_type = infer_simple_type(clause.body, clause_types);

    if (handler_output_type && clause_output_type) {
      expect(
        same_simple_type(handler_output_type, clause_output_type),
        "Handler clause " + handler.effect + "." + clause.name +
          " returns " + clause_output_type + ", expected " +
          handler_output_type,
      );
    }
  }

  validate_handler_state_expr_assignments(
    handler.return_clause.body,
    state_names,
  );
}

function validate_resume_argument_types(
  expr: FrontExpr,
  resume_name: string,
  input_type: string,
  types: Map<string, string>,
): void {
  if (
    expr.tag === "app" &&
    (expr.func.tag === "linear" || expr.func.tag === "var") &&
    expr.func.name === resume_name
  ) {
    let arg = expr.arg;

    if (arg === undefined) {
      expect(
        expr.args.length === 1,
        "Resumption " + resume_name + " expects exactly one argument",
      );
      arg = expr.args[0];
    }

    expect(arg, "Missing resumption argument");
    const actual = infer_simple_type(arg, types);

    if (actual) {
      expect(
        same_simple_type(actual, input_type),
        "Resumption " + resume_name + " expects " + input_type +
          ", got " + actual,
      );
    }
  }

  walk_typed_expr_children(expr, types, (child, child_types) => {
    validate_resume_argument_types(
      child,
      resume_name,
      input_type,
      child_types,
    );
  });
}

function validate_state_assignment_types(
  expr: FrontExpr,
  state_types: Map<string, string>,
  types: Map<string, string>,
): void {
  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
      if (stmt.tag === "assign" && state_types.has(stmt.name)) {
        const expected = state_types.get(stmt.name);
        expect(expected, "Missing handler state type: " + stmt.name);
        const actual = infer_simple_type(stmt.value, local);

        if (actual) {
          expect(
            same_simple_type(actual, expected),
            "Handler state " + stmt.name + " expects " + expected +
              ", got " + actual,
          );
        }
      }

      validate_state_assignment_stmt_types(stmt, state_types, local);

      if (stmt.tag === "bind") {
        const type = stmt.annotation || infer_simple_type(stmt.value, local);

        if (type) {
          local.set(stmt.name, type);
        }
      }

      if (stmt.tag === "assign") {
        const type = infer_simple_type(stmt.value, local);

        if (type) {
          local.set(stmt.name, type);
        }
      }
    }

    return;
  }

  walk_typed_expr_children(expr, types, (child, child_types) => {
    validate_state_assignment_types(child, state_types, child_types);
  });
}

function validate_state_assignment_stmt_types(
  stmt: Stmt,
  state_types: Map<string, string>,
  types: Map<string, string>,
): void {
  if (stmt.tag === "bind" || stmt.tag === "state_bind") {
    validate_state_assignment_types(stmt.value, state_types, types);
    return;
  }

  if (stmt.tag === "bind_pattern" || stmt.tag === "resume_dup") {
    validate_state_assignment_types(stmt.value, state_types, types);
    return;
  }

  if (stmt.tag === "assign") {
    validate_state_assignment_types(stmt.value, state_types, types);
    return;
  }

  if (stmt.tag === "index_assign") {
    validate_state_assignment_types(stmt.index, state_types, types);
    validate_state_assignment_types(stmt.value, state_types, types);
    return;
  }

  if (stmt.tag === "for_range") {
    validate_state_assignment_types(stmt.start, state_types, types);
    validate_state_assignment_types(stmt.end, state_types, types);
    validate_state_assignment_types(stmt.step, state_types, types);

    for (const item of stmt.body) {
      validate_state_assignment_stmt_types(item, state_types, new Map(types));
    }

    return;
  }

  if (stmt.tag === "for_collection") {
    validate_state_assignment_types(stmt.collection, state_types, types);

    for (const item of stmt.body) {
      validate_state_assignment_stmt_types(item, state_types, new Map(types));
    }

    return;
  }

  if (stmt.tag === "if_stmt") {
    validate_state_assignment_types(stmt.cond, state_types, types);

    for (const item of stmt.body) {
      validate_state_assignment_stmt_types(item, state_types, new Map(types));
    }

    return;
  }

  if (stmt.tag === "if_let_stmt") {
    validate_state_assignment_types(stmt.target, state_types, types);

    for (const item of stmt.body) {
      validate_state_assignment_stmt_types(item, state_types, new Map(types));
    }

    return;
  }

  if (stmt.tag === "type_check") {
    validate_state_assignment_types(stmt.target, state_types, types);
    return;
  }

  if (stmt.tag === "return") {
    validate_state_assignment_types(stmt.value, state_types, types);
    return;
  }

  if (stmt.tag === "expr") {
    validate_state_assignment_types(stmt.expr, state_types, types);
  }
}

function walk_typed_expr_children(
  expr: FrontExpr,
  types: Map<string, string>,
  visit: (expr: FrontExpr, types: Map<string, string>) => void,
): void {
  if (expr.tag === "prim") {
    visit(expr.left, types);
    visit(expr.right, types);
    return;
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const local = new Map(types);

    for (const param of expr.params) {
      if (param.annotation) {
        local.set(param.name, param.annotation);
      }
    }

    visit(expr.body, local);
    return;
  }

  if (expr.tag === "app") {
    visit(expr.func, types);

    for (const arg of expr.args) {
      visit(arg, types);
    }

    return;
  }

  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
      visit_stmt_exprs(stmt, local, visit);

      if (stmt.tag === "bind") {
        const type = stmt.annotation || infer_simple_type(stmt.value, local);

        if (type) {
          local.set(stmt.name, type);
        }
      }
    }

    return;
  }

  if (expr.tag === "comptime") {
    visit(expr.expr, types);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    visit(expr.value, types);
    return;
  }

  if (expr.tag === "scratch") {
    visit(expr.body, types);
    return;
  }

  if (expr.tag === "loop") {
    const local = new Map(types);

    for (const stmt of expr.body) {
      visit_stmt_exprs(stmt, local, visit);
    }

    return;
  }

  if (expr.tag === "captured") {
    visit(expr.expr, types);
    return;
  }

  if (expr.tag === "handler") {
    return;
  }

  if (expr.tag === "try_with") {
    visit(expr.body, types);
    visit(expr.handler, types);
    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    visit(expr.base, types);

    for (const field of expr.fields) {
      visit(field.value, types);
    }

    return;
  }

  if (expr.tag === "struct_value") {
    visit(expr.type_expr, types);

    for (const field of expr.fields) {
      visit(field.value, types);
    }

    return;
  }

  if (expr.tag === "if") {
    visit(expr.cond, types);
    visit(expr.then_branch, new Map(types));
    visit(expr.else_branch, new Map(types));
    return;
  }

  if (expr.tag === "if_let") {
    visit(expr.target, types);
    visit(expr.then_branch, new Map(types));
    visit(expr.else_branch, new Map(types));
    return;
  }

  if (expr.tag === "field") {
    visit(expr.object, types);
    return;
  }

  if (expr.tag === "index") {
    visit(expr.object, types);
    visit(expr.index, types);
    return;
  }

  if (expr.tag === "union_case") {
    if (expr.value) {
      visit(expr.value, types);
    }

    if (expr.type_expr) {
      visit(expr.type_expr, types);
    }
  }
}

function visit_stmt_exprs(
  stmt: Stmt,
  types: Map<string, string>,
  visit: (expr: FrontExpr, types: Map<string, string>) => void,
): void {
  if (
    stmt.tag === "bind" || stmt.tag === "state_bind" ||
    stmt.tag === "bind_pattern" || stmt.tag === "resume_dup" ||
    stmt.tag === "assign"
  ) {
    visit(stmt.value, types);
    return;
  }

  if (stmt.tag === "index_assign") {
    visit(stmt.index, types);
    visit(stmt.value, types);
    return;
  }

  if (stmt.tag === "for_range") {
    visit(stmt.start, types);
    visit(stmt.end, types);
    visit(stmt.step, types);

    for (const item of stmt.body) {
      visit_stmt_exprs(item, new Map(types), visit);
    }

    return;
  }

  if (stmt.tag === "for_collection") {
    visit(stmt.collection, types);

    for (const item of stmt.body) {
      visit_stmt_exprs(item, new Map(types), visit);
    }

    return;
  }

  if (stmt.tag === "if_stmt") {
    visit(stmt.cond, types);

    for (const item of stmt.body) {
      visit_stmt_exprs(item, new Map(types), visit);
    }

    return;
  }

  if (stmt.tag === "if_let_stmt") {
    visit(stmt.target, types);

    for (const item of stmt.body) {
      visit_stmt_exprs(item, new Map(types), visit);
    }

    return;
  }

  if (stmt.tag === "type_check") {
    visit(stmt.target, types);
    return;
  }

  if (stmt.tag === "return") {
    visit(stmt.value, types);
    return;
  }

  if (stmt.tag === "break" && stmt.value) {
    visit(stmt.value, types);
    return;
  }

  if (stmt.tag === "expr") {
    visit(stmt.expr, types);
  }
}

function infer_simple_type(
  expr: FrontExpr,
  types: Map<string, string>,
  scalar_type_aliases: Map<string, string> = new Map(),
): string | undefined {
  if (expr.tag === "bool") {
    return "Bool";
  }

  if (expr.tag === "is") {
    return "Bool";
  }

  if (expr.tag === "unit") {
    return "Unit";
  }

  if (expr.tag === "num") {
    if (expr.character !== undefined) {
      return "Char";
    }

    if (expr.type === "i64") {
      return "I64";
    }

    if (expr.type === "f32") {
      return "F32";
    }

    if (expr.type === "f64") {
      return "F64";
    }

    return "I32";
  }

  if (expr.tag === "text") {
    if (expr.encoding === "bytes") {
      return "Bytes";
    }

    return "Text";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const type = types.get(expr.name);

    if (!type) {
      return undefined;
    }

    return resolved_scalar_type_name(type, scalar_type_aliases);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return infer_simple_type(expr.value, types, scalar_type_aliases);
  }

  if (expr.tag === "struct_value") {
    if (expr.type_expr.tag === "var" || expr.type_expr.tag === "type_name") {
      return expr.type_expr.name;
    }

    return undefined;
  }

  if (expr.tag === "struct_update" || expr.tag === "with") {
    if (expr.base.tag === "var" || expr.base.tag === "type_name") {
      return expr.base.name;
    }

    return infer_simple_type(expr.base, types, scalar_type_aliases);
  }

  if (expr.tag === "union_case") {
    if (
      expr.type_expr &&
      (expr.type_expr.tag === "var" || expr.type_expr.tag === "type_name")
    ) {
      return expr.type_expr.name;
    }

    return undefined;
  }

  if (
    expr.tag === "app" && expr.func.tag === "field" &&
    (expr.func.object.tag === "var" ||
      expr.func.object.tag === "type_name")
  ) {
    return expr.func.object.name;
  }

  if (expr.tag === "prim") {
    const left = infer_simple_type(expr.left, types, scalar_type_aliases);
    const right = infer_simple_type(expr.right, types, scalar_type_aliases);
    let left_value: ValType | undefined;
    let right_value: ValType | undefined;
    if (left) {
      left_value = val_type_from_type_name(
        resolved_scalar_type_name(left, scalar_type_aliases),
      );
    }
    if (right) {
      right_value = val_type_from_type_name(
        resolved_scalar_type_name(right, scalar_type_aliases),
      );
    }
    const prim = specialize_prim_for_operands(
      expr.prim,
      left_value,
      right_value,
    );

    if (prim_returns_bool(prim)) {
      return "Bool";
    }

    const result = prim_result_type(prim);
    if (result === "i64") {
      return "I64";
    }

    if (result === "f32") {
      return "F32";
    }

    if (result === "f64") {
      return "F64";
    }

    return "I32";
  }

  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
      if (stmt.tag === "bind") {
        const type = stmt.annotation || infer_simple_type(
          stmt.value,
          local,
          scalar_type_aliases,
        );

        if (type) {
          local.set(stmt.name, type);
        }
      }

      if (stmt.tag === "assign") {
        const type = infer_simple_type(
          stmt.value,
          local,
          scalar_type_aliases,
        );

        if (type) {
          local.set(stmt.name, type);
        }
      }
    }

    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return infer_simple_type(
        final_stmt.expr,
        local,
        scalar_type_aliases,
      );
    }

    if (final_stmt && final_stmt.tag === "return") {
      return infer_simple_type(
        final_stmt.value,
        local,
        scalar_type_aliases,
      );
    }
  }

  if (expr.tag === "if") {
    const left = infer_simple_type(
      expr.then_branch,
      new Map(types),
      scalar_type_aliases,
    );
    const right = infer_simple_type(
      expr.else_branch,
      new Map(types),
      scalar_type_aliases,
    );

    if (
      left && right &&
      same_simple_type(left, right, scalar_type_aliases)
    ) {
      return left;
    }
  }

  return undefined;
}

function infer_effect_bind_result_type(
  expr: FrontExpr,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  types: Map<string, string> = new Map(),
  resolving: Set<string> = new Set(),
): string | undefined {
  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return infer_effect_bind_result_type(
      expr.value,
      analysis,
      facts,
      types,
      resolving,
    );
  }

  if (expr.tag === "app") {
    const operation = direct_effect_call(expr, analysis.index);

    if (operation) {
      const declaration = analysis.index.effects.get(operation.effect);
      expect(declaration, "Missing effect declaration: " + operation.effect);
      const declared_operation = declaration.operations.find((candidate) => {
        return candidate.name === operation.operation;
      });
      expect(
        declared_operation,
        "Unknown effect operation: " + effect_text(operation),
      );
      return specialize_effect_operation(declared_operation, expr).result
        .type_name;
    }

    if (expr.func.tag === "var" && facts) {
      const called = facts.get(expr.func.name);

      if (called) {
        if (called.type_annotation) {
          if (called.type_annotation.result.tag === "name") {
            return called.type_annotation.result.name;
          }

          return undefined;
        }

        if (resolving.has(called.name)) {
          return undefined;
        }

        const next_resolving = new Set(resolving);
        next_resolving.add(called.name);
        const parameter_types = new Map<string, string>();

        for (const param of called.params) {
          if (param.annotation) {
            parameter_types.set(param.name, param.annotation);
          }
        }

        return with_parameter_result_types(
          analysis,
          function_parameter_result_types(
            called.type_annotation,
            called.params,
            analysis,
          ),
          () => {
            return infer_effect_bind_result_type(
              called.body,
              analysis,
              facts,
              parameter_types,
              next_resolving,
            );
          },
        );
      }
    }

    if (expr.func.tag === "var") {
      if (analysis.active_parameter_result_types.has(expr.func.name)) {
        return analysis.active_parameter_result_types.get(expr.func.name);
      }
    }

    if (expr.func.tag === "lam" || expr.func.tag === "rec") {
      const parameter_types = new Map<string, string>();

      for (const param of expr.func.params) {
        if (param.type_annotation?.tag === "name") {
          parameter_types.set(param.name, param.type_annotation.name);
        }
      }

      return infer_effect_bind_result_type(
        expr.func.body,
        analysis,
        facts,
        parameter_types,
        resolving,
      );
    }

    return undefined;
  }

  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
      if (stmt.tag === "bind") {
        const type = stmt.annotation || infer_effect_bind_result_type(
          stmt.value,
          analysis,
          facts,
          local,
          resolving,
        );

        if (type) {
          local.set(stmt.name, type);
        }
      }

      if (stmt.tag === "state_bind" && stmt.value_name !== undefined) {
        const type = infer_effect_bind_result_type(
          stmt.value,
          analysis,
          facts,
          local,
          resolving,
        );

        if (type) {
          local.set(stmt.value_name, type);
        }
      }

      if (stmt.tag === "assign") {
        const type = infer_effect_bind_result_type(
          stmt.value,
          analysis,
          facts,
          local,
          resolving,
        );

        if (type) {
          local.set(stmt.name, type);
        }
      }
    }

    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return "Unit";
    }

    if (final_stmt.tag === "state_bind") {
      return "Unit";
    }

    if (final_stmt.tag === "expr") {
      return infer_effect_bind_result_type(
        final_stmt.expr,
        analysis,
        facts,
        local,
        resolving,
      );
    }

    if (final_stmt.tag === "return") {
      return infer_effect_bind_result_type(
        final_stmt.value,
        analysis,
        facts,
        local,
        resolving,
      );
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const left = infer_effect_bind_result_type(
      expr.then_branch,
      analysis,
      facts,
      new Map(types),
      resolving,
    );
    const right = infer_effect_bind_result_type(
      expr.else_branch,
      analysis,
      facts,
      new Map(types),
      resolving,
    );

    if (
      left && right &&
      same_simple_type(left, right, analysis.scalar_type_aliases)
    ) {
      return left;
    }

    return undefined;
  }

  return infer_simple_type(expr, types, analysis.scalar_type_aliases);
}

function same_simple_type(
  left: string,
  right: string,
  scalar_type_aliases: Map<string, string> = new Map(),
): boolean {
  const resolved_left = resolved_scalar_type_name(
    left,
    scalar_type_aliases,
  );
  const resolved_right = resolved_scalar_type_name(
    right,
    scalar_type_aliases,
  );

  if (resolved_left === resolved_right) {
    return true;
  }

  if (
    resolved_left === "Bool" || resolved_right === "Bool" ||
    resolved_left === "Char" || resolved_right === "Char"
  ) {
    return false;
  }

  const left_value = val_type_from_type_name(resolved_left);
  const right_value = val_type_from_type_name(resolved_right);
  return left_value !== undefined && left_value === right_value;
}

function same_declared_type(
  left: string,
  right: string,
  scalar_type_aliases: Map<string, string>,
): boolean {
  const resolved_left = resolved_scalar_type_name(
    left,
    scalar_type_aliases,
  );
  const resolved_right = resolved_scalar_type_name(
    right,
    scalar_type_aliases,
  );

  if (resolved_left === resolved_right) {
    return true;
  }

  const i32_names = new Set(["Int", "I32", "U32"]);
  return i32_names.has(resolved_left) && i32_names.has(resolved_right);
}

function effect_result_is_discardable_scalar(
  type_name: string,
  scalar_type_aliases: Map<string, string>,
): boolean {
  const resolved = resolved_scalar_type_name(
    type_name,
    scalar_type_aliases,
  );
  return resolved === "Unit" || resolved === "Bool" || resolved === "Char" ||
    resolved === "Int" || resolved === "I32" || resolved === "U32" ||
    resolved === "I64" || resolved === "F32" || resolved === "F64";
}

function resolved_scalar_type_name(
  name: string,
  scalar_type_aliases: Map<string, string>,
): string {
  const resolved = scalar_type_aliases.get(name);

  if (resolved) {
    return resolved;
  }

  return name;
}

function validate_handler_state_assignments(
  clause: HandlerClause,
  state_names: Set<string>,
): void {
  validate_handler_state_expr_assignments(clause.body, state_names);
}

function validate_handler_state_expr_assignments(
  expr: FrontExpr,
  state_names: Set<string>,
): void {
  if (expr.tag === "block") {
    for (const stmt of expr.statements) {
      validate_handler_state_stmt_assignments(stmt, state_names);
    }

    return;
  }

  if (expr.tag === "prim") {
    validate_handler_state_expr_assignments(expr.left, state_names);
    validate_handler_state_expr_assignments(expr.right, state_names);
    return;
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    validate_handler_state_expr_assignments(expr.body, state_names);
    return;
  }

  if (expr.tag === "app") {
    validate_handler_state_expr_assignments(expr.func, state_names);

    for (const arg of expr.args) {
      validate_handler_state_expr_assignments(arg, state_names);
    }

    return;
  }

  if (expr.tag === "comptime") {
    validate_handler_state_expr_assignments(expr.expr, state_names);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    validate_handler_state_expr_assignments(expr.value, state_names);
    return;
  }

  if (expr.tag === "scratch") {
    validate_handler_state_expr_assignments(expr.body, state_names);
    return;
  }

  if (expr.tag === "loop") {
    for (const stmt of expr.body) {
      validate_handler_state_stmt_assignments(stmt, state_names);
    }

    return;
  }

  if (expr.tag === "captured") {
    validate_handler_state_expr_assignments(expr.expr, state_names);
    return;
  }

  if (expr.tag === "handler") {
    return;
  }

  if (expr.tag === "try_with") {
    validate_handler_state_expr_assignments(expr.body, state_names);
    validate_handler_state_expr_assignments(expr.handler, state_names);
    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    validate_handler_state_expr_assignments(expr.base, state_names);

    for (const field of expr.fields) {
      validate_handler_state_expr_assignments(field.value, state_names);
    }

    return;
  }

  if (expr.tag === "struct_value") {
    validate_handler_state_expr_assignments(expr.type_expr, state_names);

    for (const field of expr.fields) {
      validate_handler_state_expr_assignments(field.value, state_names);
    }

    return;
  }

  if (expr.tag === "if") {
    validate_handler_state_expr_assignments(expr.cond, state_names);
    validate_handler_state_expr_assignments(expr.then_branch, state_names);
    validate_handler_state_expr_assignments(expr.else_branch, state_names);
    return;
  }

  if (expr.tag === "if_let") {
    validate_handler_state_expr_assignments(expr.target, state_names);
    validate_handler_state_expr_assignments(expr.then_branch, state_names);
    validate_handler_state_expr_assignments(expr.else_branch, state_names);
    return;
  }

  if (expr.tag === "field") {
    validate_handler_state_expr_assignments(expr.object, state_names);
    return;
  }

  if (expr.tag === "index") {
    validate_handler_state_expr_assignments(expr.object, state_names);
    validate_handler_state_expr_assignments(expr.index, state_names);
    return;
  }

  if (expr.tag === "union_case") {
    if (expr.value) {
      validate_handler_state_expr_assignments(expr.value, state_names);
    }

    if (expr.type_expr) {
      validate_handler_state_expr_assignments(expr.type_expr, state_names);
    }
  }
}

function validate_handler_state_stmt_assignments(
  stmt: Stmt,
  state_names: Set<string>,
): void {
  if (stmt.tag === "assign") {
    if (state_names.has(stmt.name) && stmt.mode === "change") {
      throw new Error(
        "Handler state cannot change type with := " + stmt.name,
      );
    }

    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "bind" || stmt.tag === "state_bind") {
    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "bind_pattern" || stmt.tag === "resume_dup") {
    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "index_assign") {
    validate_handler_state_expr_assignments(stmt.index, state_names);
    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "for_range") {
    validate_handler_state_expr_assignments(stmt.start, state_names);
    validate_handler_state_expr_assignments(stmt.end, state_names);
    validate_handler_state_expr_assignments(stmt.step, state_names);

    for (const body_stmt of stmt.body) {
      validate_handler_state_stmt_assignments(body_stmt, state_names);
    }

    return;
  }

  if (stmt.tag === "for_collection") {
    validate_handler_state_expr_assignments(stmt.collection, state_names);

    for (const body_stmt of stmt.body) {
      validate_handler_state_stmt_assignments(body_stmt, state_names);
    }

    return;
  }

  if (stmt.tag === "if_stmt") {
    validate_handler_state_expr_assignments(stmt.cond, state_names);

    for (const body_stmt of stmt.body) {
      validate_handler_state_stmt_assignments(body_stmt, state_names);
    }

    return;
  }

  if (stmt.tag === "if_let_stmt") {
    validate_handler_state_expr_assignments(stmt.target, state_names);

    for (const body_stmt of stmt.body) {
      validate_handler_state_stmt_assignments(body_stmt, state_names);
    }

    return;
  }

  if (stmt.tag === "type_check") {
    validate_handler_state_expr_assignments(stmt.target, state_names);
    return;
  }

  if (stmt.tag === "return") {
    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "break" && stmt.value) {
    validate_handler_state_expr_assignments(stmt.value, state_names);
    return;
  }

  if (stmt.tag === "expr") {
    validate_handler_state_expr_assignments(stmt.expr, state_names);
  }
}

function resolve_handler_expr(
  expr: FrontExpr,
  analysis: AnalysisContext,
  replacements: Map<string, FrontExpr>,
  resolving: Set<string>,
): HandlerResolution | undefined {
  if (expr.tag === "handler") {
    validate_handler_shape(expr, analysis.index);
    return {
      effect: expr.effect,
      operations: new Set(expr.clauses.map((clause) => clause.name)),
      variants: [{ expr }],
    };
  }

  if (expr.tag === "captured") {
    return resolve_handler_expr(
      expr.expr,
      analysis,
      replacements,
      resolving,
    );
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const replacement = replacements.get(expr.name);

    if (replacement) {
      return resolve_handler_expr(
        replacement,
        analysis,
        replacements,
        resolving,
      );
    }

    if (resolving.has(expr.name)) {
      throw new Error("Recursive handler value: " + expr.name);
    }

    const binding = analysis.bindings.get(expr.name);

    if (!binding) {
      return undefined;
    }

    resolving.add(expr.name);

    try {
      return resolve_handler_expr(
        binding.value,
        analysis,
        replacements,
        resolving,
      );
    } finally {
      resolving.delete(expr.name);
    }
  }

  if (expr.tag === "app") {
    let target: Extract<FrontExpr, { tag: "lam" | "rec" }> | undefined;
    let target_name: string | undefined;

    if (expr.func.tag === "lam" || expr.func.tag === "rec") {
      target = expr.func;
    } else if (expr.func.tag === "var" || expr.func.tag === "linear") {
      const binding = analysis.bindings.get(expr.func.name);

      if (
        binding &&
        (binding.value.tag === "lam" || binding.value.tag === "rec")
      ) {
        target = binding.value;
        target_name = expr.func.name;
      }
    }

    if (!target) {
      return undefined;
    }

    expect(
      target.params.length === expr.args.length,
      "Handler factory argument count mismatch",
    );
    const local_replacements = new Map(replacements);

    for (let index = 0; index < target.params.length; index += 1) {
      const param = target.params[index];
      const arg = expr.args[index];
      expect(param, "Missing handler factory parameter");
      expect(arg, "Missing handler factory argument");
      local_replacements.set(param.name, arg);
    }

    if (target_name) {
      if (resolving.has(target_name)) {
        throw new Error("Recursive handler factory: " + target_name);
      }

      resolving.add(target_name);
    }

    try {
      return resolve_handler_expr(
        target.body,
        analysis,
        local_replacements,
        resolving,
      );
    } finally {
      if (target_name) {
        resolving.delete(target_name);
      }
    }
  }

  if (expr.tag === "block") {
    const local_replacements = new Map(replacements);

    for (let index = 0; index < expr.statements.length; index += 1) {
      const stmt = expr.statements[index];
      expect(stmt, "Missing handler factory block statement");

      if (stmt.tag === "bind") {
        local_replacements.set(stmt.name, stmt.value);
        continue;
      }

      if (stmt.tag === "assign") {
        local_replacements.set(stmt.name, stmt.value);
        continue;
      }

      if (stmt.tag === "expr" && index + 1 === expr.statements.length) {
        return resolve_handler_expr(
          stmt.expr,
          analysis,
          local_replacements,
          resolving,
        );
      }

      if (stmt.tag === "return") {
        return resolve_handler_expr(
          stmt.value,
          analysis,
          local_replacements,
          resolving,
        );
      }
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const left = resolve_handler_expr(
      expr.then_branch,
      analysis,
      new Map(replacements),
      new Set(resolving),
    );
    const right = resolve_handler_expr(
      expr.else_branch,
      analysis,
      new Map(replacements),
      new Set(resolving),
    );

    if (!left || !right) {
      return undefined;
    }

    expect(
      left.effect === right.effect,
      "Handler branches target different effects: " + left.effect +
        " and " + right.effect,
    );
    const operations = new Set<string>();

    for (const operation of left.operations) {
      if (right.operations.has(operation)) {
        operations.add(operation);
      }
    }

    return {
      effect: left.effect,
      operations,
      variants: [...left.variants, ...right.variants],
    };
  }

  return undefined;
}

function effects_with_calls(
  scan: EffectScan,
  facts: Map<string, FunctionFact>,
): Map<string, EffectRef> {
  const effects = new Map(scan.direct);

  for (const edge of scan.calls.values()) {
    const called = facts.get(edge.name);

    if (!called) {
      continue;
    }

    merge_visible_effects(effects, called.direct, edge.handlers);
  }

  return effects;
}

function add_visible_effect(
  target: Map<string, EffectRef>,
  effect: EffectRef,
  handlers: ActiveHandler[],
): void {
  if (effect_is_handled(effect, handlers)) {
    return;
  }

  target.set(effect_key(effect), effect);
}

function merge_visible_effects(
  target: Map<string, EffectRef>,
  source: Map<string, EffectRef>,
  handlers: ActiveHandler[],
): void {
  for (const effect of source.values()) {
    add_visible_effect(target, effect, handlers);
  }
}

function effect_is_handled(
  effect: EffectRef,
  handlers: ActiveHandler[],
): boolean {
  for (const handler of handlers) {
    if (
      handler.effect === effect.effect &&
      handler.operations.has(effect.operation)
    ) {
      return true;
    }
  }

  return false;
}

function add_call(
  calls: Map<string, CallEdge>,
  name: string,
  handlers: ActiveHandler[],
): void {
  const copied = handlers.map((handler) => {
    return {
      effect: handler.effect,
      operations: new Set(handler.operations),
    };
  });
  const edge = { name, handlers: copied };
  calls.set(call_key(edge), edge);
}

function call_key(edge: CallEdge): string {
  const handlers = edge.handlers.map((handler) => {
    return handler.effect + ":" +
      Array.from(handler.operations).sort().join(",");
  }).join("/");
  return edge.name + "|" + handlers;
}

function merge_scan(
  direct: Map<string, EffectRef>,
  calls: Map<string, CallEdge>,
  scan: EffectScan,
): void {
  merge_effects(direct, scan.direct);
  merge_calls(calls, scan.calls);
}

function merge_effects(
  target: Map<string, EffectRef>,
  source: Map<string, EffectRef>,
): void {
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

function merge_calls(
  target: Map<string, CallEdge>,
  source: Map<string, CallEdge>,
): void {
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

function format_effect_suffix(effects: Map<string, EffectRef>): string {
  const sorted = sorted_effects(effects);

  if (sorted.length === 0) {
    return "";
  }

  return "; calls " + sorted.map(effect_text).join(", ");
}

function effect_key(effect: EffectRef): string {
  return effect.effect + "." + effect.operation;
}

function effect_text(effect: EffectRef): string {
  return effect_key(effect);
}

function sorted_effects(effects: Map<string, EffectRef>): EffectRef[] {
  return Array.from(effects.values()).sort((left, right) => {
    return effect_key(left).localeCompare(effect_key(right));
  });
}
