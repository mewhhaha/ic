import type {
  EffectDeclaration,
  EffectOperation,
  FrontExpr,
  Param,
  Source,
} from "./ast.ts";
import {
  source_diagnostic,
  SourceDiagnosticError,
} from "./semantic_diagnostic.ts";
import { source_facts, type SourceTypeFact } from "./source_facts.ts";

type EffectSpecialization = {
  declaration: EffectDeclaration;
  used: boolean;
  types: Map<string, string>;
};

export function specialize_front_effects(source: Source): Source {
  const declarations = source.declarations || [];
  const specializations = new Map<string, EffectSpecialization>();

  for (const declaration of declarations) {
    if (declaration.tag === "effect" && declaration.params.length > 0) {
      specializations.set(declaration.name, {
        declaration,
        used: false,
        types: new Map(),
      });
    }
  }

  if (specializations.size === 0) {
    return source;
  }

  const facts = source_facts(source);
  const visited = new WeakSet<object>();

  function bind(
    specialization: EffectSpecialization,
    param: string,
    fact: SourceTypeFact | undefined,
    subject: object,
  ): void {
    if (
      fact === undefined || fact.inference_variable ||
      fact.resolved_name === "unknown"
    ) {
      return;
    }

    let inferred = fact.resolved_name;

    if (fact.nominal !== undefined) {
      inferred = fact.nominal;
    }

    const previous = specialization.types.get(param);

    if (previous === undefined) {
      specialization.types.set(param, inferred);
      return;
    }

    if (previous === inferred) {
      return;
    }

    throw new SourceDiagnosticError(source_diagnostic(
      "DUCK2312",
      "Effect " + specialization.declaration.name + " parameter " + param +
        " is used as both " + previous + " and " + inferred,
      subject,
    ));
  }

  function bind_operation_call(
    expr: Extract<FrontExpr, { tag: "app" }>,
  ): void {
    if (expr.func.tag !== "field" || expr.func.object.tag !== "var") {
      return;
    }

    const specialization = specializations.get(expr.func.object.name);

    if (specialization === undefined) {
      return;
    }

    const operation_name = expr.func.name;
    const operation = specialization.declaration.operations.find(
      (candidate) => candidate.name === operation_name,
    );

    if (operation === undefined) {
      return;
    }

    specialization.used = true;

    for (let index = 0; index < operation.params.length; index += 1) {
      const declared = operation.params[index];
      const arg = expr.args[index];

      if (declared === undefined || arg === undefined) {
        continue;
      }

      if (specialization.declaration.params.includes(declared.type_name)) {
        bind(
          specialization,
          declared.type_name,
          facts.editor_type_of.get(arg),
          arg,
        );
      }
    }

    if (
      specialization.declaration.params.includes(operation.result.type_name)
    ) {
      bind(
        specialization,
        operation.result.type_name,
        facts.editor_type_of.get(expr),
        expr,
      );
    }
  }

  function bind_handler(expr: Extract<FrontExpr, { tag: "handler" }>): void {
    const specialization = specializations.get(expr.effect);

    if (specialization === undefined) {
      return;
    }

    specialization.used = true;

    for (const clause of expr.clauses) {
      const operation = specialization.declaration.operations.find(
        (candidate) => candidate.name === clause.name,
      );

      if (operation === undefined) {
        continue;
      }

      for (let index = 0; index < operation.params.length; index += 1) {
        const declared = operation.params[index];
        const param = clause.params[index];

        if (declared === undefined || param === undefined) {
          continue;
        }

        if (specialization.declaration.params.includes(declared.type_name)) {
          bind(
            specialization,
            declared.type_name,
            facts.editor_type_of.get(param),
            param,
          );
        }
      }

      if (
        !specialization.declaration.params.includes(
          operation.result.type_name,
        )
      ) {
        continue;
      }

      const resume = clause.params[operation.params.length];

      if (resume !== undefined) {
        bind_resumption_arguments(
          clause.body,
          resume,
          specialization,
          operation,
        );
      }
    }
  }

  function bind_resumption_arguments(
    value: unknown,
    resume: Param,
    specialization: EffectSpecialization,
    operation: EffectOperation,
  ): void {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        bind_resumption_arguments(
          entry,
          resume,
          specialization,
          operation,
        );
      }
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.tag === "app") {
      const app = node as Extract<FrontExpr, { tag: "app" }>;

      if (
        (app.func.tag === "var" || app.func.tag === "linear") &&
        app.func.name === resume.name
      ) {
        const arg = app.args[0];

        if (arg !== undefined) {
          bind(
            specialization,
            operation.result.type_name,
            facts.editor_type_of.get(arg),
            arg,
          );
        }
      }
    }

    for (const child of Object.values(node)) {
      bind_resumption_arguments(
        child,
        resume,
        specialization,
        operation,
      );
    }
  }

  function visit(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.tag === "app") {
      bind_operation_call(node as Extract<FrontExpr, { tag: "app" }>);
    } else if (node.tag === "handler") {
      bind_handler(node as Extract<FrontExpr, { tag: "handler" }>);
    }

    for (const child of Object.values(node)) {
      visit(child);
    }
  }

  visit(source.statements);

  const specialized_declarations = [];

  for (const declaration of declarations) {
    if (declaration.tag !== "effect" || declaration.params.length === 0) {
      specialized_declarations.push(declaration);
      continue;
    }

    const specialization = specializations.get(declaration.name);

    if (specialization === undefined) {
      throw new Error("Missing effect specialization: " + declaration.name);
    }

    if (!specialization.used) {
      continue;
    }

    for (const param of declaration.params) {
      if (!specialization.types.has(param)) {
        throw new SourceDiagnosticError(source_diagnostic(
          "DUCK2312",
          "Cannot infer effect " + declaration.name + " parameter " + param,
          declaration,
        ));
      }
    }

    specialized_declarations.push({
      ...declaration,
      params: [],
      operations: declaration.operations.map((operation) => {
        const result_type_name = substitute_effect_type(
          operation.result.type_name,
          specialization.types,
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
              specialization.types,
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
      }),
    });
  }

  return { ...source, declarations: specialized_declarations };
}

function substitute_effect_type(
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

function is_effect_scalar_type(type_name: string): boolean {
  return type_name === "Unit" || type_name === "Bool" ||
    type_name === "Int" || type_name === "I32" || type_name === "U32" ||
    type_name === "I64" || type_name === "F32";
}
