import { expect } from "../expect.ts";
import type {
  EffectDeclaration,
  EffectOperation,
  FrontExpr,
  TypeExpr,
} from "./ast.ts";
import type { SourceTypeFact } from "./source_facts.ts";
import { tokenize } from "./tokenize.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";

export function infer_effect_operation_type_arguments(
  declaration: EffectDeclaration,
  operation: EffectOperation,
  args: (SourceTypeFact | undefined)[],
  result: SourceTypeFact | undefined,
): Map<string, string> {
  const roles = new Set([
    ...declaration.params,
    ...operation.type_params,
  ]);
  const bindings = new Map<string, string>();

  for (let index = 0; index < operation.params.length; index += 1) {
    const param = operation.params[index];
    const arg = args[index];
    expect(param, "Missing effect operation parameter " + index.toString());
    bind_effect_type(
      parse_type_expr(tokenize(param.type_name)),
      source_fact_type_expr(arg),
      roles,
      bindings,
    );
  }

  bind_effect_type(
    parse_type_expr(tokenize(operation.result.type_name)),
    source_fact_type_expr(result),
    roles,
    bindings,
  );
  return bindings;
}

export function specialize_effect_operation(
  operation: EffectOperation,
  call: Extract<FrontExpr, { tag: "app" }>,
): EffectOperation {
  const substitutions = new Map<string, string>();
  const type_arguments = call.effect_type_arguments;

  if (type_arguments === undefined) {
    return operation;
  }

  for (const argument of type_arguments) {
    substitutions.set(argument.name, argument.type_name);
  }

  if (substitutions.size === 0) {
    return operation;
  }

  return substitute_effect_operation(operation, substitutions);
}

export function substitute_effect_operation(
  operation: EffectOperation,
  substitutions: Map<string, string>,
): EffectOperation {
  const result_type_name = substitute_effect_type(
    operation.result.type_name,
    substitutions,
  );
  let result_ownership = operation.result.ownership;

  if (
    result_ownership === "unique_heap" &&
    is_effect_scalar_type(result_type_name)
  ) {
    result_ownership = "scalar";
  }

  return {
    ...operation,
    params: operation.params.map((param) => {
      const type_name = substitute_effect_type(
        param.type_name,
        substitutions,
      );
      let ownership = param.ownership;

      if (
        ownership === "ownership_transfer" &&
        is_effect_scalar_type(type_name)
      ) {
        ownership = "scalar";
      }

      return { ...param, type_name, ownership };
    }),
    result: {
      ...operation.result,
      type_name: result_type_name,
      ownership: result_ownership,
    },
  };
}

export function substitute_effect_type(
  type_name: string,
  substitutions: Map<string, string>,
): string {
  let specialized = type_name;

  for (const [param, concrete] of substitutions) {
    specialized = specialized.replace(
      new RegExp("\\b" + param + "\\b", "g"),
      concrete,
    );
  }

  return specialized;
}

export function is_effect_scalar_type(type_name: string): boolean {
  return type_name === "Unit" || type_name === "Bool" ||
    type_name === "Char" || type_name === "Int" || type_name === "I32" ||
    type_name === "U32" || type_name === "I64" || type_name === "F32" ||
    type_name === "F64";
}

function source_fact_type_expr(
  fact: SourceTypeFact | undefined,
): TypeExpr | undefined {
  if (
    fact === undefined || fact.inference_variable || fact.name === "" ||
    fact.name === "unknown"
  ) {
    return undefined;
  }

  let representation = fact;
  const seen = new Set<SourceTypeFact>();

  while (
    representation.alias_target !== undefined &&
    !seen.has(representation)
  ) {
    seen.add(representation);
    representation = representation.alias_target;
  }

  return parse_type_expr(tokenize(representation.name));
}

function bind_effect_type(
  pattern: TypeExpr,
  actual: TypeExpr | undefined,
  roles: Set<string>,
  bindings: Map<string, string>,
): void {
  if (actual === undefined) {
    return;
  }

  if (pattern.tag === "name" && roles.has(pattern.name)) {
    const actual_name = format_type_expr(actual);
    const previous = bindings.get(pattern.name);

    if (previous === undefined) {
      bindings.set(pattern.name, actual_name);
      return;
    }

    expect(
      previous === actual_name,
      "Effect type parameter " + pattern.name + " is both " + previous +
        " and " + actual_name,
    );
    return;
  }

  if (pattern.tag === "apply" && actual.tag === "apply") {
    bind_effect_type(pattern.func, actual.func, roles, bindings);
    bind_effect_type(pattern.arg, actual.arg, roles, bindings);
    return;
  }

  if (pattern.tag === "arrow" && actual.tag === "arrow") {
    bind_effect_type(pattern.param, actual.param, roles, bindings);
    bind_effect_type(pattern.result, actual.result, roles, bindings);
    return;
  }

  return;
}
