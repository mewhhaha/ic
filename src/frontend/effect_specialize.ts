import type {
  EffectDeclaration,
  EffectOperation,
  FrontExpr,
  Param,
  Source,
  Stmt,
} from "./ast.ts";
import { expect } from "../expect.ts";
import {
  source_diagnostic,
  SourceDiagnosticError,
} from "./semantic_diagnostic.ts";
import { source_facts, type SourceTypeFact } from "./source_facts.ts";
import {
  infer_effect_operation_type_arguments,
  substitute_effect_operation,
} from "./effect_operation.ts";

type EffectSpecialization = {
  declaration: EffectDeclaration;
  used: boolean;
  types: Map<string, string>;
};

export function specialize_front_effects(source: Source): Source {
  source = instantiate_named_effects(source);
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
  const handler_parameter_facts = new WeakMap<
    Extract<FrontExpr, { tag: "handler" }>,
    Map<string, SourceTypeFact[]>
  >();

  const function_bindings = new Map<
    string,
    Extract<FrontExpr, { tag: "lam" }>
  >();

  function collect_function_bindings(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        collect_function_bindings(entry);
      }
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.tag === "bind") {
      const statement = node as Extract<Stmt, { tag: "bind" }>;

      if (statement.value.tag === "lam") {
        function_bindings.set(statement.name, statement.value);
      }
    }

    for (const child of Object.values(node)) {
      collect_function_bindings(child);
    }
  }

  function attach_handler_parameter_facts(
    value: unknown,
    parameter_facts: Map<string, SourceTypeFact[]>,
  ): void {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        attach_handler_parameter_facts(entry, parameter_facts);
      }
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.tag === "handler") {
      const handler = node as Extract<FrontExpr, { tag: "handler" }>;
      const handler_facts = new Map(parameter_facts);

      for (const state of handler.state) {
        if (state.value.tag !== "var") {
          continue;
        }

        const inferred = handler_facts.get(state.value.name);

        if (inferred !== undefined) {
          handler_facts.set(state.name, [...inferred]);
        }
      }

      const previous = handler_parameter_facts.get(handler);

      if (previous === undefined) {
        handler_parameter_facts.set(handler, handler_facts);
      } else {
        for (const [name, inferred] of handler_facts) {
          const existing = previous.get(name);

          if (existing === undefined) {
            previous.set(name, [...inferred]);
          } else {
            existing.push(...inferred);
          }
        }
      }
    }

    for (const child of Object.values(node)) {
      attach_handler_parameter_facts(child, parameter_facts);
    }
  }

  function collect_handler_factory_calls(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        collect_handler_factory_calls(entry);
      }
      return;
    }

    const node = value as Record<string, unknown>;

    if (node.tag === "app") {
      const call = node as Extract<FrontExpr, { tag: "app" }>;

      if (call.func.tag === "var") {
        const target = function_bindings.get(call.func.name);

        if (target !== undefined && target.params.length === call.args.length) {
          const parameter_facts = new Map<string, SourceTypeFact[]>();

          for (let index = 0; index < target.params.length; index += 1) {
            const param = target.params[index];
            const arg = call.args[index];

            if (param === undefined || arg === undefined) {
              throw new Error("Missing handler factory argument " + index);
            }

            const fact = facts.editor_type_of.get(arg);

            if (fact !== undefined && !fact.inference_variable) {
              parameter_facts.set(param.name, [fact]);
            }
          }

          attach_handler_parameter_facts(target.body, parameter_facts);
        }
      }
    }

    for (const child of Object.values(node)) {
      collect_handler_factory_calls(child);
    }
  }

  collect_function_bindings(source.statements);
  collect_handler_factory_calls(source.statements);

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

    bind_type_name(specialization, param, inferred, subject);
  }

  function bind_type_name(
    specialization: EffectSpecialization,
    param: string,
    inferred: string,
    subject: object,
  ): void {
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

    const args = expr.args.map((arg) => facts.editor_type_of.get(arg));
    const inferred = infer_effect_operation_type_arguments(
      specialization.declaration,
      operation,
      args,
      facts.editor_type_of.get(expr),
    );

    for (const param of specialization.declaration.params) {
      const type_name = inferred.get(param);

      if (type_name !== undefined) {
        bind_type_name(
          specialization,
          param,
          type_name,
          expr,
        );
      }
    }

    expr.effect_type_arguments = operation.type_params.flatMap((param) => {
      const type_name = inferred.get(param);

      if (type_name === undefined) {
        return [];
      }

      return [{ name: param, type_name }];
    });
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
          handler_parameter_facts.get(expr),
        );
      }
    }
  }

  function bind_resumption_arguments(
    value: unknown,
    resume: Param,
    specialization: EffectSpecialization,
    operation: EffectOperation,
    parameter_facts: Map<string, SourceTypeFact[]> | undefined,
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
          parameter_facts,
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
          const fact = facts.editor_type_of.get(arg);
          bind(
            specialization,
            operation.result.type_name,
            fact,
            arg,
          );

          if (
            (fact === undefined || fact.inference_variable) &&
            arg.tag === "var"
          ) {
            const inferred = parameter_facts?.get(arg.name) || [];

            for (const parameter_fact of inferred) {
              bind(
                specialization,
                operation.result.type_name,
                parameter_fact,
                arg,
              );
            }
          }

          if (
            (fact === undefined || fact.inference_variable) &&
            arg.tag === "app" && arg.func.tag === "var"
          ) {
            const inferred = parameter_facts?.get(arg.func.name) || [];

            for (const parameter_fact of inferred) {
              bind(
                specialization,
                operation.result.type_name,
                parameter_fact.call_result,
                arg,
              );
            }
          }
        }
      }
    }

    for (const child of Object.values(node)) {
      bind_resumption_arguments(
        child,
        resume,
        specialization,
        operation,
        parameter_facts,
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
      type_arguments: declaration.params.map((param) => {
        const type_name = specialization.types.get(param);
        expect(type_name !== undefined, "Missing specialized effect argument");
        return { name: param, type_name };
      }),
      operations: specialize_effect_operations(
        declaration,
        specialization.types,
      ),
    });
  }

  return { ...source, declarations: specialized_declarations };
}

export function instantiate_named_effects(source: Source): Source {
  const declarations = source.declarations || [];
  const effects = new Map<string, EffectDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "effect") {
      effects.set(declaration.name, declaration);
    }
  }

  const instances: EffectDeclaration[] = [];
  const statements: Stmt[] = [];

  for (const statement of source.statements) {
    if (
      statement.tag !== "bind" || statement.pattern?.tag !== "binding"
    ) {
      statements.push(statement);
      continue;
    }

    let effect_name: string | undefined;
    let type_args: FrontExpr[] = [];

    if (statement.value.tag === "var") {
      effect_name = statement.value.name;
    } else if (
      statement.value.tag === "app" && statement.value.func.tag === "var"
    ) {
      effect_name = statement.value.func.name;
      type_args = statement.value.args;
    }

    if (effect_name === undefined) {
      statements.push(statement);
      continue;
    }

    const declaration = effects.get(effect_name);

    if (declaration === undefined) {
      statements.push(statement);
      continue;
    }

    if (statement.kind !== "const") {
      throw new SourceDiagnosticError(source_diagnostic(
        "DUCK2101",
        "Effect instance " + statement.name + " must use a const binding",
        statement,
      ));
    }

    if (
      declaration.params.length === 0 && type_args.length === 1 &&
      type_args[0]?.tag === "unit"
    ) {
      type_args = [];
    }

    if (
      type_args.length === 1 && type_args[0]?.tag === "product" &&
      type_args[0].entries.length === declaration.params.length
    ) {
      type_args = type_args[0].entries.map((entry) => entry.value);
    }

    if (type_args.length !== declaration.params.length) {
      throw new SourceDiagnosticError(source_diagnostic(
        "DUCK2312",
        "Effect " + declaration.name + " expects " +
          declaration.params.length + " type arguments, got " +
          type_args.length,
        statement.value,
      ));
    }

    const substitutions = new Map<string, string>();

    for (let index = 0; index < declaration.params.length; index += 1) {
      const param = declaration.params[index];
      const arg = type_args[index];

      if (param === undefined || arg === undefined) {
        throw new Error("Missing named effect type argument " + index);
      }

      if (arg.tag !== "var" && arg.tag !== "type_name") {
        throw new SourceDiagnosticError(source_diagnostic(
          "DUCK2312",
          "Named effect " + statement.name +
            " requires concrete type-name arguments",
          arg,
        ));
      }

      substitutions.set(param, arg.name);
    }

    instances.push({
      ...declaration,
      name: statement.name,
      params: [],
      operations: specialize_effect_operations(declaration, substitutions),
    });
  }

  if (instances.length === 0) {
    return source;
  }

  return {
    ...source,
    declarations: [...declarations, ...instances],
    statements,
  };
}

function specialize_effect_operations(
  declaration: EffectDeclaration,
  substitutions: Map<string, string>,
): EffectOperation[] {
  return declaration.operations.map((operation) =>
    substitute_effect_operation(operation, substitutions)
  );
}
