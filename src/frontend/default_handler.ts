import { diagnostic_codes } from "../diagnostic.ts";
import { expect } from "../expect.ts";
import type {
  DuckDeclaration,
  ExtensionDeclaration,
  FrontExpr,
  Source,
  TypeExpr,
} from "./ast.ts";
import { analyze_front_expression_effects } from "./effect_analysis.ts";
import { throw_source_diagnostic } from "./semantic_diagnostic.ts";
import { source_facts } from "./source_facts.ts";
import { substitute_front_expr } from "./substitute.ts";
import {
  derive_missing_source_spans,
  has_source_span,
  inherit_source_span,
  source_span,
} from "./syntax.ts";

type AvailableDefaultHandler = {
  effect: string;
  interpretation: string;
  make: FrontExpr;
  order: number;
  output: FrontExpr;
};

type SelectedDefaultHandler = AvailableDefaultHandler & {
  argument: FrontExpr;
  output_type_constructor: string | undefined;
};

type RewriteState = {
  expanded: boolean;
};

export function infer_default_effect_handlers(source: Source): Source {
  const evidence = available_default_handlers(source);
  let rewritten = source;

  while (source_has_implicit_try(rewritten)) {
    const facts = source_facts(rewritten);
    const expected_types = expected_implicit_try_types(rewritten);
    const state: RewriteState = { expanded: false };
    const next = rewrite_first_implicit_try(
      rewritten,
      rewritten,
      evidence.defaults,
      facts,
      expected_types,
      state,
    );
    expect(state.expanded, "Implicit try rewrite made no progress");
    expect(next.tag === "program", "Implicit try rewrite changed source kind");
    rewritten = next;
  }

  if (evidence.extensions.size === 0) {
    return rewritten;
  }

  return {
    ...rewritten,
    declarations: (rewritten.declarations || []).filter((declaration) => {
      return declaration.tag !== "extend" ||
        !evidence.extensions.has(declaration);
    }),
  };
}

export function source_has_implicit_try(source: Source): boolean {
  return contains_implicit_try(source);
}

function available_default_handlers(
  source: Source,
): {
  defaults: Map<string, AvailableDefaultHandler[]>;
  extensions: Set<ExtensionDeclaration>;
} {
  const defaults = new Map<string, AvailableDefaultHandler[]>();
  const extensions = new Set<ExtensionDeclaration>();
  const protocol = (source.declarations || []).find((declaration) => {
    return declaration.tag === "duck" && declaration.name === "DefaultHandler";
  });

  if (protocol === undefined || protocol.tag !== "duck") {
    return { defaults, extensions };
  }

  validate_default_handler_protocol(protocol);

  for (const declaration of source.declarations || []) {
    if (declaration.tag !== "extend") {
      continue;
    }

    const handled = declaration.types.find((member) => {
      return member.name === "Handled";
    });

    if (handled === undefined) {
      continue;
    }

    const registration = default_handler_from_extension(
      declaration,
      handled.type_expr,
    );
    extensions.add(declaration);
    const registered = defaults.get(registration.effect);

    if (registered === undefined) {
      defaults.set(registration.effect, [registration]);
    } else {
      registered.push(registration);
    }
  }

  return { defaults, extensions };
}

function validate_default_handler_protocol(protocol: DuckDeclaration): void {
  expect(
    protocol.roles.length === 1 && protocol.roles[0] === "Effect",
    "DefaultHandler duck must declare the Effect role",
  );
  expect(
    protocol.types.some((member) => member.name === "Handled"),
    "DefaultHandler duck must declare associated type Handled",
  );
  expect(
    protocol.members.some((member) => member.name === "make"),
    "DefaultHandler duck must declare .make",
  );
  expect(
    protocol.members.some((member) => member.name === "output"),
    "DefaultHandler duck must declare .output",
  );
  expect(
    protocol.members.some((member) => member.name === "order"),
    "DefaultHandler duck must declare .order",
  );
}

function default_handler_from_extension(
  extension: ExtensionDeclaration,
  handled: TypeExpr,
): AvailableDefaultHandler {
  if (handled.tag !== "name") {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name +
        " must name one effect in associated type Handled",
      extension,
    );
  }

  const make = extension.fields.find((field) => field.name === "make");
  const output = extension.fields.find((field) => field.name === "output");
  const order = extension.fields.find((field) => field.name === "order");

  if (make === undefined) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name + " must implement .make",
      extension,
    );
  }

  if (make.value.tag !== "lam" || make.value.params.length !== 1) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name +
        " .make must be a one-argument function",
      make.value,
    );
  }

  if (output === undefined) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name + " must implement .output",
      extension,
    );
  }

  if (output.value.tag !== "lam" || output.value.params.length !== 1) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name +
        " .output must be a one-argument function",
      output.value,
    );
  }

  if (order === undefined) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name + " must implement .order",
      extension,
    );
  }

  const order_value = default_handler_order(extension, order.value);

  return {
    effect: handled.name,
    interpretation: extension.type_name,
    make: make.value,
    order: order_value,
    output: output.value,
  };
}

function default_handler_order(
  extension: ExtensionDeclaration,
  value: FrontExpr,
): number {
  if (
    value.tag !== "lam" || value.params.length !== 1 ||
    value.body.tag !== "num" || value.body.type !== "i32" ||
    typeof value.body.value !== "number" || !Number.isInteger(value.body.value)
  ) {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + extension.type_name +
        " .order must return an I32 literal",
      value,
    );
  }

  return value.body.value;
}

function rewrite_first_implicit_try<value>(
  value: value,
  source: Source,
  defaults: Map<string, AvailableDefaultHandler[]>,
  facts: ReturnType<typeof source_facts>,
  expected_types: WeakMap<object, string>,
  state: RewriteState,
): value {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const rewritten = rewrite_first_implicit_try(
        entry,
        source,
        defaults,
        facts,
        expected_types,
        state,
      );
      changed = changed || rewritten !== entry;
      return rewritten;
    });

    if (!changed) {
      return value;
    }

    return entries as value;
  }

  const original = value as Record<string, unknown>;
  let candidate = original;

  for (const [name, child] of Object.entries(original)) {
    const rewritten = rewrite_first_implicit_try(
      child,
      source,
      defaults,
      facts,
      expected_types,
      state,
    );

    if (rewritten === child) {
      continue;
    }

    if (candidate === original) {
      candidate = { ...original };
    }

    candidate[name] = rewritten;
  }

  if (
    state.expanded || candidate.tag !== "try_with" ||
    candidate.infer_default_handlers !== true
  ) {
    if (candidate !== original && has_source_span(original)) {
      return inherit_source_span(candidate, original) as value;
    }

    return candidate as value;
  }

  const implicit_try = candidate as Extract<FrontExpr, { tag: "try_with" }>;
  let expected_type = expected_types.get(implicit_try);

  if (expected_type === undefined) {
    expected_type = implicit_try.handler_output_type;
  }

  const inferred = infer_handlers_for_try(
    implicit_try,
    source,
    defaults,
    facts,
    expected_type,
  );
  state.expanded = true;
  return inferred as value;
}

function infer_handlers_for_try(
  expr: Extract<FrontExpr, { tag: "try_with" }>,
  source: Source,
  defaults: Map<string, AvailableDefaultHandler[]>,
  facts: ReturnType<typeof source_facts>,
  expected_type: string | undefined,
): FrontExpr {
  const effects = analyze_front_expression_effects(source, expr.body);
  const effect_names = new Set<string>();

  for (const effect of effects) {
    effect_names.add(effect.effect);
  }

  if (effect_names.size === 0) {
    return expr.body;
  }

  const selected: SelectedDefaultHandler[] = [];

  for (const effect of effect_names) {
    let candidates = defaults.get(effect);

    if (candidates === undefined || candidates.length === 0) {
      throw_source_diagnostic(
        diagnostic_codes.default_handler_resolution,
        "No default handler is in scope for effect " + effect,
        expr,
      );
    }

    const declaration = (source.declarations || []).find((candidate) => {
      return candidate.tag === "effect" && candidate.name === effect;
    });
    expect(
      declaration !== undefined && declaration.tag === "effect",
      "Missing effect declaration for default handler " + effect,
    );
    const type_arguments = declaration.type_arguments || [];

    if (type_arguments.length > 0) {
      const first = type_arguments[0];
      expect(first !== undefined, "Missing first effect type argument");
      const exact = candidates.filter((candidate) => {
        return candidate.interpretation === first.type_name;
      });

      if (exact.length > 0) {
        candidates = exact;
      } else {
        const family = candidates.filter((candidate) => {
          return candidate.interpretation === effect;
        });

        if (family.length > 0) {
          candidates = family;
        }
      }
    }

    if (candidates.length > 1) {
      throw_source_diagnostic(
        diagnostic_codes.default_handler_resolution,
        "More than one default handler is in scope for effect " + effect +
          ": " + candidates.map((candidate) => candidate.interpretation)
          .join(", "),
        expr,
      );
    }

    const candidate = candidates[0];
    expect(candidate !== undefined, "Missing selected default handler");
    selected.push(select_default_handler(candidate, type_arguments));
  }

  selected.sort((left, right) => left.order - right.order);

  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1];
    const current = selected[index];
    expect(previous !== undefined, "Missing previous default handler");
    expect(current !== undefined, "Missing current default handler");

    if (previous.order === current.order) {
      throw_source_diagnostic(
        diagnostic_codes.default_handler_resolution,
        "Default handlers " + previous.interpretation + " and " +
          current.interpretation + " use the same order " +
          current.order.toString(),
        expr,
      );
    }
  }

  const body_type = facts.editor_type_of.get(expr.body);
  let output_type: string | undefined;

  if (body_type !== undefined && body_type.resolved_name !== "unknown") {
    output_type = body_type.name;
  }

  let handled: FrontExpr = expr.body;

  for (let index = 0; index < selected.length; index += 1) {
    const registration = selected[index];
    expect(registration !== undefined, "Missing ordered default handler");
    const is_outermost = index === selected.length - 1;

    if (registration.output_type_constructor !== undefined) {
      if (is_outermost && expected_type !== undefined) {
        output_type = expected_type;
      } else {
        if (output_type === undefined) {
          throw_source_diagnostic(
            diagnostic_codes.default_handler_resolution,
            "Cannot infer the input type transformed by default handler " +
              registration.interpretation + "; add a result annotation",
            expr,
          );
        }

        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(output_type)) {
          output_type = registration.output_type_constructor + " " +
            output_type;
        } else {
          output_type = registration.output_type_constructor + " (" +
            output_type + ")";
        }
      }
    }

    const handler_factory = structuredClone(registration.make);
    expect(handler_factory.tag === "lam", "Default handler must be a function");
    const parameter = handler_factory.params[0];
    expect(parameter !== undefined, "Missing default handler parameter");
    const replacements = new Map<string, FrontExpr>();
    replacements.set(parameter.name, structuredClone(registration.argument));
    const handler = substitute_front_expr(handler_factory.body, replacements);
    const next: Extract<FrontExpr, { tag: "try_with" }> = {
      tag: "try_with",
      body: handled,
      handler,
      handler_output_type: output_type,
    };

    if (has_source_span(expr)) {
      derive_missing_source_spans(next, source_span(expr));
    }

    handled = next;
  }

  return handled;
}

function select_default_handler(
  candidate: AvailableDefaultHandler,
  type_arguments: { name: string; type_name: string }[],
): SelectedDefaultHandler {
  let argument: FrontExpr;

  if (type_arguments.length === 0) {
    argument = { tag: "type_name", name: candidate.interpretation };
  } else if (type_arguments.length === 1) {
    const type_argument = type_arguments[0];
    expect(type_argument !== undefined, "Missing default handler argument");
    argument = { tag: "type_name", name: type_argument.type_name };
  } else {
    argument = {
      tag: "product",
      entries: type_arguments.map((type_argument) => {
        return {
          value: { tag: "type_name" as const, name: type_argument.type_name },
        };
      }),
    };
  }

  expect(candidate.output.tag === "lam", "Default output must be a function");
  const parameter = candidate.output.params[0];
  expect(parameter !== undefined, "Missing default output parameter");
  const result = candidate.output.body;
  let output_type_constructor: string | undefined;

  if (result.tag === "var" && result.name === parameter.name) {
    if (type_arguments.length !== 1) {
      throw_source_diagnostic(
        diagnostic_codes.default_handler_resolution,
        "Default handler " + candidate.interpretation +
          " .output can return its argument only for a one-parameter effect",
        candidate.output,
      );
    }

    const type_argument = type_arguments[0];
    expect(type_argument !== undefined, "Missing default output argument");
    output_type_constructor = type_argument.type_name;
  } else if (
    (result.tag === "var" || result.tag === "type_name") &&
    /^[A-Z][A-Za-z0-9]*$/.test(result.name)
  ) {
    output_type_constructor = result.name;
  } else {
    throw_source_diagnostic(
      diagnostic_codes.default_handler_resolution,
      "Default handler " + candidate.interpretation +
        " .output must return a type constructor",
      candidate.output,
    );
  }

  if (output_type_constructor === "Identity") {
    output_type_constructor = undefined;
  }

  return {
    ...candidate,
    argument,
    output_type_constructor,
  };
}

function expected_implicit_try_types(source: Source): WeakMap<object, string> {
  const expected = new WeakMap<object, string>();

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }

      return;
    }

    const candidate = value as Record<string, unknown>;

    if (
      candidate.tag === "bind" && typeof candidate.annotation === "string" &&
      candidate.value !== null && typeof candidate.value === "object"
    ) {
      const expression = candidate.value as Record<string, unknown>;

      if (
        expression.tag === "try_with" &&
        expression.infer_default_handlers === true
      ) {
        expected.set(expression, candidate.annotation);
      }
    }

    for (const child of Object.values(candidate)) {
      visit(child);
    }
  };

  visit(source);
  return expected;
}

function contains_implicit_try(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(contains_implicit_try);
  }

  const candidate = value as Record<string, unknown>;

  if (
    candidate.tag === "try_with" &&
    candidate.infer_default_handlers === true
  ) {
    return true;
  }

  return Object.values(candidate).some(contains_implicit_try);
}
