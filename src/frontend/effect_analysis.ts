import { expect } from "../expect.ts";
import type {
  EffectContext,
  EffectDeclaration,
  EffectRef,
  FrontExpr,
  HandlerClause,
  Source,
  Stmt,
} from "./ast.ts";
import { val_type_from_type_name } from "./types.ts";

export type FrontEffectFunction = {
  name: string;
  context: string;
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
  context: EffectContext | undefined;
  body: FrontExpr;
  direct: Map<string, EffectRef>;
  calls: Map<string, CallEdge>;
};

type EffectIndex = {
  effects: Map<string, EffectDeclaration>;
  operations: Map<string, EffectRef[]>;
};

type BindingValue = {
  value: FrontExpr;
  context: EffectContext | undefined;
};

type HandlerVariant = {
  expr: Extract<FrontExpr, { tag: "handler" }>;
  context: EffectContext | undefined;
};

type HandlerResolution = {
  effect: string;
  operations: Set<string>;
  variants: HandlerVariant[];
};

type AnalysisContext = {
  index: EffectIndex;
  bindings: Map<string, BindingValue>;
};

export function analyze_front_effects(source: Source): FrontEffectAnalysis {
  const index = build_effect_index(source);
  const bindings = collect_binding_values(source.statements);
  const analysis = { index, bindings };
  const facts = collect_function_facts(source, analysis);
  infer_transitive_effects(facts);
  validate_function_effects(facts, analysis);
  const module_scan = scan_statements(
    source.statements,
    undefined,
    analysis,
    facts,
    [],
  );
  const module_effects = effects_with_calls(module_scan, facts);
  validate_resolved_ix_root(module_effects, index);
  const functions: Record<string, FrontEffectFunction> = {};

  for (const fact of facts.values()) {
    if (!fact.context) {
      continue;
    }

    functions[fact.name] = {
      name: fact.name,
      context: fact.context.name,
      effects: sorted_effects(fact.direct),
      annotated: fact.context.operations !== undefined,
    };
  }

  return { module_effects: sorted_effects(module_effects), functions };
}

function build_effect_index(source: Source): EffectIndex {
  const effects = new Map<string, EffectDeclaration>();
  const operations = new Map<string, EffectRef[]>();
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
      const refs = operations.get(operation.name);
      const ref = { effect: declaration.name, operation: operation.name };

      if (refs) {
        refs.push(ref);
      } else {
        operations.set(operation.name, [ref]);
      }
    }
  }

  return { effects, operations };
}

function collect_binding_values(
  statements: Stmt[],
  context?: EffectContext,
  result: Map<string, BindingValue> = new Map(),
): Map<string, BindingValue> {
  for (const stmt of statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    let binding_context = context;

    if (stmt.effect_context) {
      binding_context = stmt.effect_context;
    }

    result.set(stmt.name, { value: stmt.value, context: binding_context });

    if (
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      stmt.value.body.tag === "block"
    ) {
      collect_binding_values(
        stmt.value.body.statements,
        binding_context,
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
      if (stmt.effect_context) {
        throw new Error(
          "Effect context is only valid on a function binding: " + stmt.name,
        );
      }

      continue;
    }

    if (stmt.effect_context) {
      validate_context_annotation(stmt.effect_context, analysis.index);
    }

    const scan = scan_expr(
      stmt.value.body,
      stmt.effect_context,
      analysis,
      undefined,
      false,
      [],
    );
    facts.set(stmt.name, {
      name: stmt.name,
      context: stmt.effect_context,
      body: stmt.value.body,
      direct: scan.direct,
      calls: scan.calls,
    });

    if (stmt.value.body.tag === "block") {
      collect_function_facts_from_statements(
        stmt.value.body.statements,
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

function validate_function_effects(
  facts: Map<string, FunctionFact>,
  analysis: AnalysisContext,
): void {
  for (const fact of facts.values()) {
    scan_expr(
      fact.body,
      fact.context,
      analysis,
      facts,
      false,
      [],
    );

    if (!fact.context && fact.direct.size > 0) {
      throw new Error(
        "Pure function " + fact.name +
          " calls effects; add an uppercase effect context holder",
      );
    }

    if (!fact.context || !fact.context.operations) {
      continue;
    }

    const allowed = new Set(
      fact.context.operations.map((effect) => effect_key(effect)),
    );

    for (const effect of fact.direct.values()) {
      if (!allowed.has(effect_key(effect))) {
        throw new Error(
          "Effect context " + fact.context.name + " on " + fact.name +
            " does not allow " + effect_text(effect),
        );
      }
    }

    validate_context_annotation(fact.context, analysis.index);
  }
}

function validate_context_annotation(
  context: EffectContext,
  index: EffectIndex,
): void {
  if (!context.operations) {
    return;
  }

  for (const ref of context.operations) {
    const effect = index.effects.get(ref.effect);
    expect(effect, "Unknown declared effect: " + ref.effect);
    expect(
      effect.operations.some((operation) => operation.name === ref.operation),
      "Unknown effect operation: " + effect_text(ref),
    );
  }
}

function validate_resolved_ix_root(
  effects: Map<string, EffectRef>,
  index: EffectIndex,
): void {
  for (const effect of sorted_effects(effects)) {
    const declaration = index.effects.get(effect.effect);
    expect(declaration, "Missing effect declaration: " + effect.effect);

    if (declaration.implementation === "ix") {
      throw new Error(
        "Unresolved Ix effect at module boundary: " + effect_text(effect),
      );
    }
  }
}

function scan_statements(
  statements: Stmt[],
  context: EffectContext | undefined,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  handlers: ActiveHandler[],
): EffectScan {
  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  for (const stmt of statements) {
    if (stmt.tag === "state_bind") {
      expect(context, "Effect state binding requires an effect context");
      expect(
        stmt.context === context.name,
        "Effect state binding renews " + stmt.context +
          " inside context " + context.name,
      );
      const operation = direct_effect_call(stmt.value, context, analysis.index);
      expect(
        operation,
        "Effect state binding must call an operation on " + context.name,
      );
      add_visible_effect(direct, operation, handlers);
      const nested = scan_app_args(
        stmt.value,
        context,
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
          context,
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

      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "assign") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          context,
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
          context,
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
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "expr") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.expr,
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      continue;
    }

    if (stmt.tag === "return") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.value,
          context,
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
          context,
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
          context,
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
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, context, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "for_collection") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.collection,
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, context, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "if_stmt") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.cond,
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, context, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.target,
          context,
          analysis,
          facts,
          false,
          handlers,
        ),
      );
      merge_scan(
        direct,
        calls,
        scan_statements(stmt.body, context, analysis, facts, handlers),
      );
      continue;
    }

    if (stmt.tag === "type_check") {
      merge_scan(
        direct,
        calls,
        scan_expr(
          stmt.target,
          context,
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
  context: EffectContext | undefined,
  analysis: AnalysisContext,
  facts: Map<string, FunctionFact> | undefined,
  allow_direct: boolean,
  handlers: ActiveHandler[],
): EffectScan {
  const direct = new Map<string, EffectRef>();
  const calls = new Map<string, CallEdge>();

  if (expr.tag === "app") {
    const operation = direct_effect_call(expr, context, analysis.index);

    if (operation) {
      let context_name = "<missing>";

      if (context) {
        context_name = context.name;
      }

      expect(
        allow_direct,
        "Effect operation " + effect_text(operation) +
          " must renew its context with let (!" + context_name + ", value)",
      );
      add_visible_effect(direct, operation, handlers);
    } else if (expr.func.tag === "var") {
      add_call(calls, expr.func.name, handlers);
    }

    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.func,
        context,
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
        scan_expr(arg, context, analysis, facts, false, handlers),
      );
    }

    return { direct, calls };
  }

  if (expr.tag === "block") {
    return scan_statements(
      expr.statements,
      context,
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
        context,
        analysis,
        facts,
        false,
        handlers,
      );

      if (facts) {
        const pure_scan = scan_expr(
          state.value,
          context,
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
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.handler,
        context,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
    const resolution = resolve_handler_expr(
      expr.handler,
      context,
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
        context,
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
      scan_expr(expr.left, context, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(expr.right, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "lam" || expr.tag === "rec") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.body, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "comptime") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.expr, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "borrow" || expr.tag === "freeze") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.value, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "scratch") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.body, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "captured") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.expr, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "with" || expr.tag === "struct_update") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.base, context, analysis, facts, false, handlers),
    );

    for (const field of expr.fields) {
      merge_scan(
        direct,
        calls,
        scan_expr(field.value, context, analysis, facts, false, handlers),
      );
    }
  } else if (expr.tag === "struct_value") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.type_expr, context, analysis, facts, false, handlers),
    );

    for (const field of expr.fields) {
      merge_scan(
        direct,
        calls,
        scan_expr(field.value, context, analysis, facts, false, handlers),
      );
    }
  } else if (expr.tag === "if") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.cond, context, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.then_branch,
        context,
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
        context,
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
      scan_expr(expr.target, context, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(
        expr.then_branch,
        context,
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
        context,
        analysis,
        facts,
        false,
        handlers,
      ),
    );
  } else if (expr.tag === "field") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.object, context, analysis, facts, true, handlers),
    );
  } else if (expr.tag === "index") {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.object, context, analysis, facts, false, handlers),
    );
    merge_scan(
      direct,
      calls,
      scan_expr(expr.index, context, analysis, facts, false, handlers),
    );
  } else if (expr.tag === "union_case" && expr.value) {
    merge_scan(
      direct,
      calls,
      scan_expr(expr.value, context, analysis, facts, false, handlers),
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

  if (facts) {
    const raw = scan_handler_dependency_bodies(
      variant,
      analysis,
      facts,
      [],
    );
    validate_handler_dependency_context(
      variant,
      effects_with_calls(raw, facts),
      analysis.index,
    );
  }

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
        variant.context,
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
      variant.context,
      analysis,
      facts,
      false,
      handlers,
    ),
  );
  return { direct, calls };
}

function validate_handler_dependency_context(
  variant: HandlerVariant,
  dependencies: Map<string, EffectRef>,
  index: EffectIndex,
): void {
  if (dependencies.size === 0) {
    return;
  }

  const context = variant.context;
  expect(
    context,
    "Handler " + variant.expr.effect +
      " clauses call effects; add an uppercase effect context holder",
  );

  if (!context.operations) {
    return;
  }

  validate_context_annotation(context, index);
  const allowed = new Set(
    context.operations.map((effect) => effect_key(effect)),
  );

  for (const dependency of dependencies.values()) {
    expect(
      allowed.has(effect_key(dependency)),
      "Effect context " + context.name + " on handler " +
        variant.expr.effect + " does not allow " + effect_text(dependency),
    );
  }
}

function scan_app_args(
  expr: FrontExpr,
  context: EffectContext,
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
      scan_expr(arg, context, analysis, facts, false, handlers),
    );
  }

  return { direct, calls };
}

function direct_effect_call(
  expr: FrontExpr,
  context: EffectContext | undefined,
  index: EffectIndex,
): EffectRef | undefined {
  if (!context || expr.tag !== "app" || expr.func.tag !== "field") {
    return undefined;
  }

  const object = expr.func.object;

  if (object.tag === "var" && object.name === context.name) {
    let candidates = index.operations.get(expr.func.name);

    if (!candidates) {
      candidates = [];
    }

    let filtered = candidates;

    const allowed_operations = context.operations;

    if (allowed_operations) {
      const annotated = candidates.filter((candidate) => {
        for (const allowed of allowed_operations) {
          if (effect_key(allowed) === effect_key(candidate)) {
            return true;
          }
        }

        return false;
      });

      if (annotated.length > 0) {
        filtered = annotated;
      }
    }

    expect(
      filtered.length > 0,
      "Unknown effect operation on " + context.name + ": " + expr.func.name,
    );
    expect(
      filtered.length === 1,
      "Ambiguous effect operation " + expr.func.name +
        "; use " + context.name + ".Effect." + expr.func.name,
    );
    return filtered[0];
  }

  if (
    object.tag === "field" && object.object.tag === "var" &&
    object.object.name === context.name
  ) {
    const effect = index.effects.get(object.name);
    const operation_name = expr.func.name;
    expect(effect, "Unknown declared effect: " + object.name);
    expect(
      effect.operations.some((operation) => operation.name === operation_name),
      "Unknown effect operation: " + object.name + "." + operation_name,
    );
    return { effect: object.name, operation: operation_name };
  }

  return undefined;
}

function validate_handler_shape(
  handler: Extract<FrontExpr, { tag: "handler" }>,
  index: EffectIndex,
): void {
  const effect = index.effects.get(handler.effect);
  expect(effect, "Unknown handled effect: " + handler.effect);
  expect(
    effect.implementation === "ix",
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
    expect(
      resume && resume.is_linear,
      "Handler clause " + handler.effect + "." + clause.name +
        " requires a final affine resumption parameter",
    );
    expect(resume, "Missing handler resumption parameter");
    if (resume.annotation) {
      expect(
        resume.annotation === "Resume",
        "Handler resumption parameter " + resume.name +
          " expects Resume, got " + resume.annotation,
      );
    }
    const clause_types = new Map(state_types);

    for (let index = 0; index < operation.params.length; index += 1) {
      const param = clause.params[index];
      const declared = operation.params[index];
      expect(param, "Missing handler clause parameter");
      expect(declared, "Missing effect operation parameter");
      if (param.annotation) {
        expect(
          same_declared_type(param.annotation, declared.type_name),
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
    expect(
      expr.args.length === 1,
      "Resumption " + resume_name + " expects exactly one argument",
    );
    const arg = expr.args[0];
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

  if (stmt.tag === "expr") {
    visit(stmt.expr, types);
  }
}

function infer_simple_type(
  expr: FrontExpr,
  types: Map<string, string>,
): string | undefined {
  if (expr.tag === "unit") {
    return "Unit";
  }

  if (expr.tag === "num") {
    if (expr.type === "i64") {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "text") {
    return "Text";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    return types.get(expr.name);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return infer_simple_type(expr.value, types);
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

    return infer_simple_type(expr.base, types);
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
    if (
      expr.prim.endsWith(".eq") || expr.prim.endsWith(".ne") ||
      expr.prim.includes(".lt_") || expr.prim.includes(".le_") ||
      expr.prim.includes(".gt_") || expr.prim.includes(".ge_")
    ) {
      return "I32";
    }

    if (expr.prim.startsWith("i64.")) {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
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

    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return infer_simple_type(final_stmt.expr, local);
    }

    if (final_stmt && final_stmt.tag === "return") {
      return infer_simple_type(final_stmt.value, local);
    }
  }

  if (expr.tag === "if") {
    const left = infer_simple_type(expr.then_branch, new Map(types));
    const right = infer_simple_type(expr.else_branch, new Map(types));

    if (left && right && same_simple_type(left, right)) {
      return left;
    }
  }

  return undefined;
}

function same_simple_type(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const left_value = val_type_from_type_name(left);
  const right_value = val_type_from_type_name(right);
  return left_value !== undefined && left_value === right_value;
}

function same_declared_type(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const i32_names = new Set(["Int", "I32", "U32"]);
  return i32_names.has(left) && i32_names.has(right);
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

  if (stmt.tag === "expr") {
    validate_handler_state_expr_assignments(stmt.expr, state_names);
  }
}

function resolve_handler_expr(
  expr: FrontExpr,
  context: EffectContext | undefined,
  analysis: AnalysisContext,
  replacements: Map<string, FrontExpr>,
  resolving: Set<string>,
): HandlerResolution | undefined {
  if (expr.tag === "handler") {
    validate_handler_shape(expr, analysis.index);
    return {
      effect: expr.effect,
      operations: new Set(expr.clauses.map((clause) => clause.name)),
      variants: [{ expr, context }],
    };
  }

  if (expr.tag === "captured") {
    return resolve_handler_expr(
      expr.expr,
      context,
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
        context,
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
        binding.context,
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
    let target_context = context;
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
        target_context = binding.context;
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
        target_context,
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
          context,
          analysis,
          local_replacements,
          resolving,
        );
      }

      if (stmt.tag === "return") {
        return resolve_handler_expr(
          stmt.value,
          context,
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
      context,
      analysis,
      new Map(replacements),
      new Set(resolving),
    );
    const right = resolve_handler_expr(
      expr.else_branch,
      context,
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
