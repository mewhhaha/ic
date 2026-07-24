import {
  createFunctionalModuleArtifact,
  type EncodedFunctionalModule,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostDefinitionBinding,
  type FunctionalHostType,
  FunctionalHostTypes,
  type FunctionalModuleArtifact,
  FunctionalNumericConversion,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceTypeDeclaration,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
  type FunctionalWasmHostValue,
  type FunctionalWasmInit,
  type FunctionalWasmInitBinding,
  FunctionalWasmIntrinsic,
  linkFunctionalModules,
  surface,
} from "../../../gpufuck/functional.ts";
import {
  type AbiImport,
  type AbiManifest,
  type AbiOwnership,
  type AbiType,
  type AbiTypeRef,
  build_abi_manifest,
} from "../../src/abi.ts";
import {
  type Core as CoreProgram,
  type CoreExpr,
  type CoreParam,
  type CoreStmt,
} from "../../src/core/ast.ts";
import { analyze_core_demand } from "../../src/core/demand.ts";
import { core_from_source } from "../../src/core/from_source.ts";
import type { Source } from "../../src/frontend/ast.ts";
import {
  expanded_source_for_gpufuck,
} from "../../src/frontend/gpufuck_pipeline.ts";
import { source_with_expanded_attributes } from "../../src/frontend/attribute_expand.ts";
import { infer_default_effect_handlers } from "../../src/frontend/default_handler.ts";
import { specialize_front_effects } from "../../src/frontend/effect_specialize.ts";
import { source_with_host_callable_exports } from "../../src/frontend/host_exports.ts";
import { tokenize } from "../../src/frontend/tokenize.ts";
import {
  format_type_expr,
  parse_type_expr,
} from "../../src/frontend/type_expr.ts";
import type { TypeExpr } from "../../src/type_syntax.ts";
import type { Prim } from "../../src/op.ts";
import { expect } from "../../src/expect.ts";

const duck_runtime_capability = "$DuckRuntime";
const unit_type: FunctionalTypeSchema = { kind: "unit" };
const integer_type: FunctionalTypeSchema = { kind: "integer" };
const empty_referenced_names: ReadonlySet<string> = new Set();

export type LoweredDuckGpufuckModule = {
  abi: AbiManifest;
  artifact: FunctionalModuleArtifact;
  encoded: EncodedFunctionalModule;
  automatic_init: FunctionalWasmInit;
};

type DuckTypeDefinition = {
  name: string;
  shape: "struct" | "union";
  fields: readonly { name: string; type: FunctionalTypeSchema }[];
  cases: readonly { name: string; type: FunctionalTypeSchema }[];
};

type DuckTypeConstructor = {
  parameters: readonly string[];
  body: CoreExpr;
};

type LoweredExpression = {
  expression: FunctionalSurfaceExpression;
  type: FunctionalTypeSchema | undefined;
};

type RuntimeField = {
  declaration: FunctionalHostCapabilityDeclaration["fields"][number];
  binder: string;
};

export function lower_duck_source_to_gpufuck(
  source: Source,
  source_byte_length: number,
): LoweredDuckGpufuckModule {
  source = source_with_expanded_attributes(source);
  source = source_with_host_callable_exports(source);
  const abi_source = infer_default_effect_handlers(
    specialize_front_effects(source),
  );
  let compiled_source = expanded_source_for_gpufuck(source);
  compiled_source = {
    ...compiled_source,
    statements: compiled_source.statements.map((statement) => {
      if (
        statement.tag !== "bind" || statement.annotation !== undefined ||
        statement.type_annotation === undefined
      ) {
        return statement;
      }
      return {
        ...statement,
        annotation: format_type_expr(statement.type_annotation),
      };
    }),
  };
  let core: CoreProgram;
  try {
    core = core_from_source(compiled_source);
  } catch (error) {
    try {
      core = core_from_source(source);
    } catch {
      throw error;
    }
  }
  core = analyze_core_demand(core);
  const abi = build_abi_manifest(abi_source, compiled_source);
  const type_aliases = new Map<string, string>();
  const declared_types = new Set<string>();
  if (source.declarations !== undefined) {
    for (const declaration of source.declarations) {
      if (declaration.tag === "type") {
        declared_types.add(declaration.name);
      }
      if (
        declaration.tag === "type" && declaration.params.length === 0 &&
        declaration.body.tag === "alias"
      ) {
        const target = parse_type_expr(tokenize(declaration.body.type_name));
        if (target.tag === "name" || target.tag === "apply") {
          type_aliases.set(declaration.name, declaration.body.type_name);
        }
      }
    }
  }
  return new DuckCoreLowering(
    core,
    abi,
    source_byte_length,
    type_aliases,
    declared_types,
  ).lower();
}

class DuckCoreLowering {
  readonly #core: CoreProgram;
  readonly #abi: AbiManifest;
  readonly #source_byte_length: number;
  readonly #declared_types: ReadonlySet<string>;
  readonly #types = new Map<string, DuckTypeDefinition>();
  readonly #type_aliases = new Map<string, string>();
  readonly #type_constructors = new Map<string, DuckTypeConstructor>();
  readonly #materializing_types = new Set<string>();
  readonly #function_parameter_types = new Map<
    string,
    readonly (FunctionalTypeSchema | undefined)[]
  >();
  readonly #source_functions = new Map<
    string,
    {
      params: readonly CoreParam[];
      body: CoreExpr;
    }
  >();
  readonly #specializing_function_types = new Set<string>();
  readonly #specializing_function_bodies = new Set<string>();
  readonly #specialized_type_parameters: Map<
    string,
    FunctionalTypeSchema
  >[] = [];
  readonly #function_expected_results: (
    FunctionalTypeSchema | undefined
  )[] = [];
  readonly #host_import_binders = new Map<string, string>();
  readonly #host_capabilities: FunctionalHostCapabilityDeclaration[] = [];
  readonly #runtime_fields = new Map<string, RuntimeField>();
  readonly #automatic_runtime_bindings: Record<
    string,
    FunctionalWasmInitBinding
  > = {};
  readonly #recursive_names: string[] = [];
  readonly #imported_recursive_dependencies = new Set<string>();
  readonly #recursive_function_names: readonly string[];
  readonly #referenced_names_by_value = new WeakMap<
    object,
    ReadonlySet<string>
  >();
  readonly #last_reference_index_by_statements = new WeakMap<
    readonly CoreStmt[],
    ReadonlyMap<string, number>
  >();
  readonly #loop_controls: {
    break_result: FunctionalSurfaceExpression;
    continue_result: FunctionalSurfaceExpression;
  }[] = [];
  #temporary_index = 0;

  constructor(
    core: CoreProgram,
    abi: AbiManifest,
    source_byte_length: number,
    type_aliases: ReadonlyMap<string, string>,
    declared_types: ReadonlySet<string>,
  ) {
    this.#core = core;
    this.#abi = abi;
    this.#source_byte_length = source_byte_length;
    this.#declared_types = declared_types;
    this.#recursive_function_names = Object.keys(this.#core.recFunctions || {});
    for (const [name, target] of type_aliases) {
      this.#type_aliases.set(name, target);
    }
    for (const statement of this.#core.statements) {
      if (
        statement.tag === "bind" &&
        (statement.value.tag === "lam" || statement.value.tag === "rec")
      ) {
        this.#source_functions.set(statement.name, {
          params: statement.value.params,
          body: statement.value.body,
        });
      }
    }
    const recursive_functions = this.#core.recFunctions;
    if (recursive_functions !== undefined) {
      for (const name of Object.keys(recursive_functions)) {
        if (name.includes("#module#")) {
          this.#imported_recursive_dependencies.add(name);
        }
      }
    }
    this.collect_types();
    this.collect_function_parameter_types();
    this.collect_host_capabilities();
  }

  lower(): LoweredDuckGpufuckModule {
    const environment = new Map<string, FunctionalTypeSchema>();
    const body = this.lower_statements(this.#core.statements, 0, environment);
    const entry_type = this.entry_type(body.type);
    const definitions = this.callable_definitions();
    const entry_parameters: string[] = [];
    const entry_annotation: FunctionalTypeSchema | null = entry_type;

    const runtime_capability = this.runtime_capability();
    if (runtime_capability !== undefined) {
      this.#host_capabilities.push(runtime_capability);
    }

    const host_definitions = this.host_definitions();
    definitions.push(...host_definitions.definitions);

    definitions.push({
      name: "main",
      parameters: entry_parameters,
      annotation: entry_annotation,
      body: body.expression,
    });

    const type_declarations = this.functional_type_declarations();
    if (entry_annotation === null) {
      throw new Error(
        "Duck gpufuck module artifact requires a concrete entry type",
      );
    }
    const artifact = createFunctionalModuleArtifact({
      name: "duck",
      definitions,
      typeDeclarations: type_declarations,
      imports: [],
      exports: [{ name: "main", definition: "main", type: entry_annotation }],
      sourceByteLength: this.#source_byte_length,
      options: {
        evaluationProfile: FunctionalEvaluationProfile.StrictEager,
        hostCapabilities: this.#host_capabilities,
        hostDefinitions: host_definitions.bindings,
        wasmExports: this.callable_exports(),
      },
    });
    const encoded = linkFunctionalModules([artifact], {
      module: "duck",
      exportName: "main",
    }).module;
    const automatic_init: Record<
      string,
      Record<string, FunctionalWasmInitBinding>
    > = {};
    if (runtime_capability !== undefined) {
      automatic_init[duck_runtime_capability] =
        this.#automatic_runtime_bindings;
    }
    return { abi: this.#abi, artifact, encoded, automatic_init };
  }

  private collect_types(): void {
    this.#types.set("F32x4", {
      name: "F32x4",
      shape: "struct",
      fields: ["0", "1", "2", "3"].map((name) => ({
        name,
        type: { kind: "float-32" },
      })),
      cases: [],
    });

    for (const type of Object.values(this.#abi.types)) {
      this.#types.set(type.name, this.type_definition_from_abi(type));
    }

    for (const statement of this.#core.statements) {
      if (
        statement.tag !== "bind" || statement.kind !== "const" ||
        statement.value.tag !== "lam"
      ) {
        continue;
      }
      const parameters: string[] = [];
      let has_const_parameter = false;
      let body: CoreExpr = statement.value;
      while (body.tag === "lam") {
        for (const parameter of body.params) {
          parameters.push(parameter.name);

          if (parameter.is_const) {
            has_const_parameter = true;
          }
        }
        body = body.body;
      }
      if (
        (!this.#declared_types.has(statement.name) && !has_const_parameter) ||
        !this.is_type_constructor_expression(body, new Set(parameters))
      ) {
        continue;
      }
      this.#type_constructors.set(statement.name, {
        parameters,
        body,
      });
    }

    for (const statement of this.#core.statements) {
      if (statement.tag !== "bind" || statement.kind !== "const") {
        continue;
      }
      if (
        this.#types.has(statement.name) ||
        this.#type_aliases.has(statement.name)
      ) {
        continue;
      }
      if (statement.value.tag === "type_name") {
        this.#type_aliases.set(statement.name, statement.value.name);
        continue;
      }
      if (
        statement.value.tag === "var" &&
        this.is_duck_type_name(statement.value.name)
      ) {
        this.#type_aliases.set(statement.name, statement.value.name);
        continue;
      }
      const definition = this.type_definition_from_core(
        statement.name,
        statement.value,
      );
      if (definition !== undefined) {
        this.#types.set(statement.name, definition);
      }
    }

    if (this.#abi.init !== undefined) {
      this.#types.set(this.#abi.init.name, {
        name: this.#abi.init.name,
        shape: "struct",
        fields: this.#abi.init.fields.map((field) => ({
          name: field.name,
          type: this.schema_from_abi_ref(field.type),
        })),
        cases: [],
      });
    }

    for (const statement of this.#core.statements) {
      this.collect_anonymous_types(statement);
    }
  }

  private collect_anonymous_types(value: unknown): void {
    if (value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.collect_anonymous_types(entry);
      }
      return;
    }
    const expression = value as Partial<CoreExpr>;
    if (expression.tag === "struct_value") {
      const struct_value = expression as Extract<
        CoreExpr,
        { tag: "struct_value" }
      >;
      let declared_name: string | undefined;
      if (struct_value.type_expr.tag !== "struct_type") {
        declared_name = this.type_expression_name(struct_value.type_expr);
        this.materialize_type_definition(declared_name);
      }
      if (declared_name === undefined || !this.#types.has(declared_name)) {
        const name = "$DuckObject:" +
          struct_value.fields.map((field) => field.name).join(",");
        if (!this.#types.has(name)) {
          const fields: { name: string; type: FunctionalTypeSchema }[] = [];
          for (const field of struct_value.fields) {
            const type = this.simple_expression_type(field.value, new Map());
            if (
              type === undefined || contains_type_parameter(type) ||
              this.contains_unapplied_type_constructor(type)
            ) {
              fields.length = 0;
              break;
            }
            fields.push({ name: field.name, type });
          }
          if (fields.length === struct_value.fields.length) {
            this.#types.set(name, {
              name,
              shape: "struct",
              fields,
              cases: [],
            });
          }
        }
      }
    }
    for (const child of Object.values(value)) {
      this.collect_anonymous_types(child);
    }
  }

  private type_definition_from_abi(type: AbiType): DuckTypeDefinition {
    if (type.tag === "struct") {
      return {
        name: type.name,
        shape: "struct",
        fields: type.fields.map((field) => ({
          name: field.name,
          type: this.schema_from_abi_ref(field.type),
        })),
        cases: [],
      };
    }
    if (type.tag === "union") {
      return {
        name: type.name,
        shape: "union",
        fields: [],
        cases: type.cases.map((union_case) => ({
          name: union_case.name,
          type: this.schema_from_abi_ref(union_case.payload),
        })),
      };
    }
    const fields: { name: string; type: FunctionalTypeSchema }[] = [];
    for (let index = 0; index < type.length; index += 1) {
      fields.push({
        name: index.toString(),
        type: this.schema_from_abi_ref(type.element),
      });
    }
    return { name: type.name, shape: "struct", fields, cases: [] };
  }

  private collect_function_parameter_types(): void {
    const inferred = new Map<string, (FunctionalTypeSchema | undefined)[]>();
    for (const statement of this.#core.statements) {
      if (statement.tag !== "bind") {
        continue;
      }
      if (statement.value.tag === "lam" || statement.value.tag === "rec") {
        inferred.set(
          statement.name,
          statement.value.params.map((parameter) =>
            this.schema_from_optional_type_name(parameter.annotation)
          ),
        );
      } else if (statement.value.tag === "rec_ref") {
        inferred.set(
          statement.name,
          statement.value.params.map((parameter) =>
            this.schema_from_optional_type_name(parameter.annotation)
          ),
        );
      }
    }
    const environment = new Map<string, FunctionalTypeSchema>();
    const scan = (
      value: unknown,
      scope: Map<string, FunctionalTypeSchema>,
    ): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          scan(entry, scope);
        }
        return;
      }
      const expression = value as Partial<CoreExpr>;
      if (expression.tag === "lam" || expression.tag === "rec") {
        const callable = expression as Extract<
          CoreExpr,
          { tag: "lam" | "rec" }
        >;
        const body_scope = new Map(scope);
        for (const parameter of callable.params) {
          const parameter_type = this.schema_from_optional_type_name(
            parameter.annotation,
          );
          if (parameter_type !== undefined) {
            body_scope.set(parameter.name, parameter_type);
          }
        }
        scan(callable.body, body_scope);
        return;
      }
      if (expression.tag === "block") {
        const block = expression as Extract<CoreExpr, { tag: "block" }>;
        const block_scope = new Map(scope);
        for (const statement of block.statements) {
          scan(statement, block_scope);
          if (statement.tag !== "bind") {
            continue;
          }
          let binding_type = this.schema_from_optional_type_name(
            statement.annotation,
          );
          if (binding_type === undefined) {
            binding_type = this.simple_expression_type(
              statement.value,
              block_scope,
            );
          }
          if (binding_type !== undefined) {
            block_scope.set(statement.name, binding_type);
          }
        }
        return;
      }
      if (expression.tag === "app") {
        const app = expression as Extract<CoreExpr, { tag: "app" }>;
        if (app.func.tag === "var") {
          const parameters = inferred.get(app.func.name);
          if (parameters !== undefined) {
            for (let index = 0; index < app.args.length; index += 1) {
              const arg = app.args[index];
              if (arg === undefined) {
                throw new Error(
                  "Duck gpufuck type collection lost call argument " +
                    index.toString(),
                );
              }
              const type = this.simple_expression_type(arg, scope);
              if (type !== undefined && parameters[index] === undefined) {
                parameters[index] = type;
              }
            }
          }
        }
      }
      for (const child of Object.values(value)) {
        scan(child, scope);
      }
    };

    for (const statement of this.#core.statements) {
      scan(statement, environment);
      if (statement.tag !== "bind") {
        continue;
      }
      let type = this.schema_from_optional_type_name(statement.annotation);
      if (
        type?.kind === "named" && !this.#types.has(type.name) &&
        this.simple_expression_type(statement.value, environment) !== undefined
      ) {
        type = this.simple_expression_type(statement.value, environment);
      }
      if (type === undefined) {
        type = this.simple_expression_type(statement.value, environment);
      }
      if (type !== undefined) {
        environment.set(statement.name, type);
      }
    }
    for (const definition of Object.values(this.#core.recFunctions || {})) {
      const function_scope = new Map(environment);
      for (const parameter of definition.params) {
        const parameter_type = this.schema_from_optional_type_name(
          parameter.annotation,
        );
        if (parameter_type !== undefined) {
          function_scope.set(parameter.name, parameter_type);
        }
      }
      scan(definition.body, function_scope);
    }
    for (const [name, parameters] of inferred) {
      this.#function_parameter_types.set(name, parameters);
    }
  }

  private simple_expression_type(
    expression: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): FunctionalTypeSchema | undefined {
    if (expression.tag === "num") {
      if (expression.type === "i64") {
        return { kind: "signed-integer-64" };
      }
      if (expression.type === "f32") {
        return { kind: "float-32" };
      }
      if (expression.type === "f64") {
        return { kind: "float-64" };
      }
      return integer_type;
    }
    if (expression.tag === "text") {
      return FunctionalHostTypes.text;
    }
    if (expression.tag === "var" || expression.tag === "linear") {
      return environment.get(expression.name);
    }
    if (expression.tag === "borrow" || expression.tag === "freeze") {
      return this.simple_expression_type(expression.value, environment);
    }
    if (expression.tag === "scratch" || expression.tag === "comptime") {
      let value: CoreExpr;
      if (expression.tag === "scratch") {
        value = expression.body;
      } else {
        value = expression.expr;
      }
      return this.simple_expression_type(value, environment);
    }
    if (expression.tag === "struct_value") {
      if (expression.type_expr.tag === "struct_type") {
        return this.simple_anonymous_struct_type(
          expression.fields,
          environment,
        );
      }
      const name = this.type_expression_name(expression.type_expr);
      if (this.#types.has(name)) {
        return this.named_type(name);
      }
      return this.simple_anonymous_struct_type(expression.fields, environment);
    }
    if (expression.tag === "with") {
      return this.named_type(
        "$DuckObject:" + expression.fields.map((field) => field.name).join(","),
      );
    }
    if (expression.tag === "field") {
      const object_type = this.simple_expression_type(
        expression.object,
        environment,
      );
      if (object_type?.kind !== "named") {
        return undefined;
      }
      const definition = this.#types.get(object_type.name);
      if (definition === undefined) {
        return undefined;
      }
      return definition.fields.find((field) => field.name === expression.name)
        ?.type;
    }
    if (expression.tag === "union_case") {
      if (expression.type_expr !== undefined) {
        return this.named_type(this.type_expression_name(expression.type_expr));
      }

      let payload_type: FunctionalTypeSchema | undefined = unit_type;
      if (expression.value !== undefined) {
        payload_type = this.simple_expression_type(
          expression.value,
          environment,
        );
      }
      let inferred: string | undefined;

      if (payload_type !== undefined) {
        for (const definition of this.#types.values()) {
          if (definition.shape !== "union") {
            continue;
          }
          const matching_case = definition.cases.find((candidate) => {
            return candidate.name === expression.name &&
              this.same_type(candidate.type, payload_type);
          });

          if (matching_case === undefined) {
            continue;
          }

          const resolved = this.resolve_type_alias(
            this.named_type(definition.name),
          );
          let candidate_name = definition.name;
          if (resolved.kind === "named") {
            candidate_name = resolved.name;
          }

          if (inferred !== undefined && inferred !== candidate_name) {
            return undefined;
          }
          inferred = candidate_name;
        }
      }

      if (inferred !== undefined) {
        return this.named_type(inferred);
      }
    }
    if (expression.tag === "rec_ref") {
      return this.function_type_from_signature(
        expression.params,
        expression.result_annotation,
      );
    }
    if (expression.tag === "app") {
      if (expression.func.tag === "var") {
        if (expression.func.name === "@Bytes.generate") {
          return FunctionalHostTypes.bytes;
        }
        if (expression.func.name === "@Utf8.encode") {
          return FunctionalHostTypes.bytes;
        }
        if (expression.func.name === "@Utf8.decode") {
          return FunctionalHostTypes.text;
        }
        if (
          expression.func.name === "@len" ||
          expression.func.name === "@get"
        ) {
          return integer_type;
        }
        if (
          expression.func.name === "@append" ||
          expression.func.name === "@slice"
        ) {
          const first = expression.args[0];
          if (first !== undefined) {
            return this.simple_expression_type(first, environment);
          }
        }
      }
      if (
        expression.func.tag === "var" && expression.args.length > 0 &&
        !this.#specializing_function_types.has(expression.func.name)
      ) {
        const definition = this.#source_functions.get(expression.func.name);
        if (
          definition !== undefined &&
          definition.params.length === expression.args.length
        ) {
          const specialized_environment = new Map(environment);
          let can_specialize = true;
          for (let index = 0; index < definition.params.length; index += 1) {
            const parameter = definition.params[index];
            const argument = expression.args[index];
            if (parameter === undefined || argument === undefined) {
              throw new Error(
                "Duck gpufuck type specialization lost function argument " +
                  index.toString(),
              );
            }
            const argument_type = this.simple_expression_type(
              argument,
              environment,
            );
            if (argument_type === undefined) {
              can_specialize = false;
              break;
            }
            specialized_environment.set(parameter.name, argument_type);
          }
          if (can_specialize) {
            this.#specializing_function_types.add(expression.func.name);
            try {
              const specialized = this.simple_expression_type(
                definition.body,
                specialized_environment,
              );
              if (specialized !== undefined) {
                return specialized;
              }
            } finally {
              this.#specializing_function_types.delete(expression.func.name);
            }
          }
        }
      }
      let type = this.simple_expression_type(expression.func, environment);
      if (expression.args.length === 0) {
        if (type?.kind !== "function") {
          return undefined;
        }
        return type.result;
      }
      for (const _arg of expression.args) {
        if (type?.kind !== "function") {
          return undefined;
        }
        type = type.result;
      }
      return type;
    }
    if (expression.tag === "lam" || expression.tag === "rec") {
      const function_environment = new Map(environment);
      const parameter_types: FunctionalTypeSchema[] = [];
      for (const parameter of expression.params) {
        let parameter_type = this.schema_from_optional_type_name(
          parameter.annotation,
        );
        if (parameter_type === undefined) {
          parameter_type = this.infer_function_parameter_type(
            expression.body,
            parameter.name,
            function_environment,
          );
        }
        if (parameter_type === undefined) {
          return undefined;
        }
        function_environment.set(parameter.name, parameter_type);
        parameter_types.push(parameter_type);
      }
      let type = this.simple_expression_type(
        expression.body,
        function_environment,
      );
      if (type === undefined) {
        return undefined;
      }
      if (expression.params.length === 0) {
        return { kind: "function", parameter: unit_type, result: type };
      }
      for (let index = parameter_types.length - 1; index >= 0; index -= 1) {
        const parameter_type = parameter_types[index];
        if (parameter_type === undefined) {
          throw new Error(
            "Duck gpufuck type collection lost function parameter " +
              index.toString(),
          );
        }
        type = { kind: "function", parameter: parameter_type, result: type };
      }
      return type;
    }
    if (expression.tag === "prim") {
      if (
        expression.prim === "f32x4.make" ||
        expression.prim === "f32x4.splat" ||
        expression.prim === "f32x4.add" ||
        expression.prim === "f32x4.sub" ||
        expression.prim === "f32x4.mul" ||
        expression.prim === "f32x4.div" ||
        expression.prim === "f32x4.replace_lane"
      ) {
        return this.named_type("F32x4");
      }
      if (expression.prim === "f32x4.extract_lane") {
        return { kind: "float-32" };
      }
      const binary = lower_binary_primitive(expression.prim);
      if (binary !== undefined) {
        if (binary.result.kind === "boolean") {
          return integer_type;
        }
        return binary.result;
      }
      const unary = this.unary_primitive(expression.prim);
      if (unary !== undefined) {
        return unary.result;
      }
      const conversion = this.conversion_primitive(expression.prim);
      if (conversion !== undefined) {
        return conversion.result;
      }
    }
    if (expression.tag === "if") {
      const then_type = this.simple_expression_type(
        expression.then_branch,
        environment,
      );
      if (then_type !== undefined) {
        return then_type;
      }
      return this.simple_expression_type(expression.else_branch, environment);
    }
    if (expression.tag === "loop") {
      const pending = [...expression.body];
      while (pending.length > 0) {
        const statement = pending.shift();
        if (statement === undefined) {
          throw new Error("Duck gpufuck loop type scan lost a statement");
        }
        if (statement.tag === "break" && statement.value !== undefined) {
          return this.simple_expression_type(statement.value, environment);
        }
        if (statement.tag === "if_stmt") {
          pending.push(...statement.body);
        }
        if (statement.tag === "if_else_stmt") {
          pending.push(...statement.then_body, ...statement.else_body);
        }
        if (statement.tag === "if_let_stmt") {
          pending.push(...statement.body);
        }
      }
      return undefined;
    }
    if (expression.tag === "block") {
      const block_environment = new Map(environment);
      for (const statement of expression.statements) {
        if (statement.tag !== "bind") {
          continue;
        }
        let binding_type = this.schema_from_optional_type_name(
          statement.annotation,
        );
        if (binding_type === undefined) {
          binding_type = this.simple_expression_type(
            statement.value,
            block_environment,
          );
        }
        if (binding_type !== undefined) {
          block_environment.set(statement.name, binding_type);
        }
      }
      const final_statement = expression.statements.at(-1);
      if (final_statement?.tag === "expr") {
        return this.simple_expression_type(
          final_statement.expr,
          block_environment,
        );
      }
      if (final_statement?.tag === "return") {
        return this.simple_expression_type(
          final_statement.value,
          block_environment,
        );
      }
    }
    return undefined;
  }

  private simple_anonymous_struct_type(
    fields: Extract<CoreExpr, { tag: "struct_value" }>["fields"],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): FunctionalTypeSchema {
    const name = "$DuckObject:" + fields.map((field) => field.name).join(",");
    if (this.#types.has(name)) {
      return this.named_type(name);
    }
    const definition_fields: { name: string; type: FunctionalTypeSchema }[] =
      [];
    for (const field of fields) {
      const type = this.simple_expression_type(field.value, environment);
      if (
        type === undefined || contains_type_parameter(type) ||
        this.contains_unapplied_type_constructor(type)
      ) {
        return this.named_type(name);
      }
      definition_fields.push({ name: field.name, type });
    }
    this.#types.set(name, {
      name,
      shape: "struct",
      fields: definition_fields,
      cases: [],
    });
    return this.named_type(name);
  }

  private type_definition_from_core(
    name: string,
    expression: CoreExpr,
    replacements: ReadonlyMap<string, TypeExpr> = new Map(),
  ): DuckTypeDefinition | undefined {
    if (expression.tag === "with") {
      return this.type_definition_from_core(
        name,
        expression.base,
        replacements,
      );
    }
    if (expression.tag === "struct_type") {
      return {
        name,
        shape: "struct",
        fields: expression.fields.map((field) => ({
          name: field.name,
          type: this.schema_from_type_name(
            this.substitute_type_parameters(field.type_name, replacements),
          ),
        })),
        cases: [],
      };
    }
    if (expression.tag === "union_type") {
      return {
        name,
        shape: "union",
        fields: [],
        cases: expression.cases.map((union_case) => ({
          name: union_case.name,
          type: this.schema_from_type_name(
            this.substitute_type_parameters(
              union_case.type_name,
              replacements,
            ),
          ),
        })),
      };
    }
    return undefined;
  }

  private substitute_type_parameters(
    name: string,
    replacements: ReadonlyMap<string, TypeExpr>,
  ): string {
    const substitute = (type: TypeExpr): TypeExpr => {
      if (type.tag === "name") {
        const replacement = replacements.get(type.name);
        if (replacement !== undefined) {
          return replacement;
        }
        return type;
      }
      if (type.tag === "apply") {
        return {
          tag: "apply",
          func: substitute(type.func),
          arg: substitute(type.arg),
        };
      }
      if (type.tag === "forall") {
        return { ...type, body: substitute(type.body) };
      }
      if (type.tag === "frozen" || type.tag === "borrow") {
        return { ...type, value: substitute(type.value) };
      }
      if (
        type.tag === "union" || type.tag === "intersection" ||
        type.tag === "difference"
      ) {
        return {
          ...type,
          left: substitute(type.left),
          right: substitute(type.right),
        };
      }
      if (type.tag === "tuple") {
        return { ...type, items: type.items.map(substitute) };
      }
      if (type.tag === "product") {
        return {
          ...type,
          entries: type.entries.map((entry) => ({
            ...entry,
            type_expr: substitute(entry.type_expr),
          })),
        };
      }
      if (type.tag === "array") {
        return { ...type, element: substitute(type.element) };
      }
      if (type.tag === "arrow") {
        return {
          ...type,
          param: substitute(type.param),
          result: substitute(type.result),
        };
      }
      return type;
    };

    return format_type_expr(substitute(parse_type_expr(tokenize(name))));
  }

  private materialize_type_definition(name: string): void {
    if (this.#types.has(name) || this.#materializing_types.has(name)) {
      return;
    }

    const args: TypeExpr[] = [];
    let constructor_expression: TypeExpr;
    try {
      constructor_expression = parse_type_expr(tokenize(name));
    } catch (error) {
      throw new Error(
        "Duck gpufuck lowering cannot parse runtime type name " + name,
        { cause: error },
      );
    }
    while (constructor_expression.tag === "apply") {
      args.unshift(constructor_expression.arg);
      constructor_expression = constructor_expression.func;
    }
    if (constructor_expression.tag !== "name" || args.length === 0) {
      return;
    }

    const constructor = this.#type_constructors.get(
      constructor_expression.name,
    );
    if (constructor === undefined) {
      return;
    }
    if (constructor.parameters.length !== args.length) {
      throw new Error(
        "Duck type constructor " + constructor_expression.name + " expects " +
          constructor.parameters.length.toString() + " arguments, got " +
          args.length.toString(),
      );
    }

    const replacements = new Map<string, TypeExpr>();
    for (let index = 0; index < constructor.parameters.length; index += 1) {
      const parameter = constructor.parameters[index];
      const arg = args[index];
      if (parameter === undefined || arg === undefined) {
        throw new Error(
          "Duck type constructor " + constructor_expression.name +
            " omitted argument " + index.toString(),
        );
      }
      replacements.set(parameter, arg);
    }

    this.#materializing_types.add(name);
    const definition = this.type_definition_from_core(
      name,
      constructor.body,
      replacements,
    );
    this.#materializing_types.delete(name);
    if (definition === undefined) {
      throw new Error(
        "Duck type constructor " + constructor_expression.name +
          " did not produce an aggregate type",
      );
    }
    this.#types.set(name, definition);
  }

  private collect_host_capabilities(): void {
    const imports = this.#abi.imports;
    for (const effect of Object.values(this.#abi.effects)) {
      const fields: FunctionalHostCapabilityDeclaration["fields"][number][] =
        [];
      const init_field = this.#abi.init?.fields.find((field) =>
        field.type.effect === effect.name
      );
      if (init_field !== undefined) {
        const binder = this.host_binder(effect.name, "$resource");
        fields.push({
          kind: "value",
          name: "$resource",
          type: FunctionalHostTypes.resource(effect.name),
          ownership: "frozen-shareable",
        });
        this.#host_import_binders.set(init_field.import, binder);
      }
      for (const operation of Object.values(effect.operations)) {
        const imported = imports[operation.import];
        if (imported === undefined) {
          throw new Error(
            "Duck gpufuck lowering cannot find effect import " +
              operation.import,
          );
        }
        const binder = this.host_binder(effect.name, operation.name);
        fields.push({
          kind: "operation",
          name: operation.name,
          purity: "effectful",
          execution: operation.execution,
          parameter: this.operation_parameter_type(
            operation.params.map((param) => param.type),
          ),
          result: this.schema_from_abi_ref(operation.result.type),
          ...this.parameter_ownership(operation.params),
          ...this.result_ownership(operation.result.ownership),
        });
        this.#host_import_binders.set(imported.name, binder);
      }
      this.#host_capabilities.push({ name: effect.name, fields });
    }

    for (const imported of Object.values(imports)) {
      if (this.#host_import_binders.has(imported.name)) {
        continue;
      }
      const binder = this.host_binder(imported.module, imported.field);
      let fields = this.#host_capabilities.find((capability) =>
        capability.name === imported.module
      )?.fields;
      if (fields === undefined) {
        fields = [];
        this.#host_capabilities.push({ name: imported.module, fields });
      }
      if (imported.params.length === 0) {
        const mutable_fields =
          fields as FunctionalHostCapabilityDeclaration["fields"][number][];
        mutable_fields.push({
          kind: "value",
          name: imported.field,
          type: this.schema_from_abi_ref(imported.result.type),
          ...this.value_ownership(imported.result.ownership),
        });
      } else {
        const mutable_fields =
          fields as FunctionalHostCapabilityDeclaration["fields"][number][];
        mutable_fields.push({
          kind: "operation",
          name: imported.field,
          purity: "effectful",
          parameter: this.operation_parameter_type(
            imported.params.map((param) => param.type),
          ),
          result: this.schema_from_abi_ref(imported.result.type),
          ...this.parameter_ownership(imported.params),
          ...this.result_ownership(imported.result.ownership),
        });
      }
      this.#host_import_binders.set(imported.name, binder);
    }
  }

  private lower_statements(
    statements: readonly CoreStmt[],
    index: number,
    environment: Map<string, FunctionalTypeSchema>,
    expected_result?: FunctionalTypeSchema,
  ): LoweredExpression {
    const statement = statements[index];
    if (statement === undefined) {
      throw new Error(
        "Duck gpufuck lowering expected a result after statements " +
          statements.map((candidate) => candidate.tag).join(", "),
      );
    }

    if (statement.tag === "bind") {
      if (this.#abi.callables?.[statement.name] !== undefined) {
        return this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      }
      if (
        statement.value.tag === "rec_ref" &&
        this.#imported_recursive_dependencies.has(statement.value.name)
      ) {
        return this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      }
      if (
        statement.kind === "const" &&
        (this.#types.has(statement.name) ||
          this.#type_constructors.has(statement.name) ||
          this.is_type_level_expression(statement.value) ||
          this.is_protocol_expression(statement.value))
      ) {
        return this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      }
      if (
        statement.kind === "const" &&
        (statement.value.tag === "lam" || statement.value.tag === "rec" ||
          statement.value.tag === "rec_ref") &&
        !this.statements_reference_name(
          statements,
          index + 1,
          statement.name,
        ) &&
        !this.reachable_recursive_functions_reference_name(
          statements,
          index + 1,
          statement.name,
        )
      ) {
        return this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      }
      let value: LoweredExpression;
      let recursive = false;
      if (statement.value.tag === "rec_ref") {
        const rec_function = this.#core.recFunctions?.[statement.value.name];
        if (rec_function === undefined) {
          throw new Error(
            "Duck gpufuck lowering cannot find recursive function " +
              statement.value.name,
          );
        }
        const recursive_names = new Set([statement.value.name]);
        const pending_names = [statement.value.name];
        while (pending_names.length > 0) {
          const pending_name = pending_names.pop();
          if (pending_name === undefined) {
            throw new Error("Duck gpufuck recursive group lost a function");
          }
          const pending_function = this.#core.recFunctions?.[pending_name];
          if (pending_function === undefined) {
            throw new Error(
              "Duck gpufuck lowering cannot find recursive function " +
                pending_name,
            );
          }
          for (const candidate of this.#recursive_function_names) {
            if (
              recursive_names.has(candidate) || environment.has(candidate)
            ) {
              continue;
            }
            if (this.value_references_name(pending_function.body, candidate)) {
              recursive_names.add(candidate);
              pending_names.push(candidate);
            }
          }
        }

        if (recursive_names.size > 1) {
          const previous_types = new Map<
            string,
            FunctionalTypeSchema | undefined
          >();
          const bindings: {
            name: string;
            parameters: string[];
            body: FunctionalSurfaceExpression;
          }[] = [];
          try {
            for (const recursive_name of recursive_names) {
              previous_types.set(
                recursive_name,
                environment.get(recursive_name),
              );
              const definition = this.#core.recFunctions?.[recursive_name];
              if (definition === undefined) {
                throw new Error(
                  "Duck gpufuck lowering cannot find recursive function " +
                    recursive_name,
                );
              }
              const recursive_type = this.function_type_from_signature(
                definition.params,
                definition.result_annotation,
              );
              if (recursive_type !== undefined) {
                environment.set(recursive_name, recursive_type);
              }
            }

            for (const recursive_name of recursive_names) {
              const definition = this.#core.recFunctions?.[recursive_name];
              if (definition === undefined) {
                throw new Error(
                  "Duck gpufuck lowering cannot find recursive function " +
                    recursive_name,
                );
              }
              const lowered = this.lower_function(
                definition.params,
                definition.body,
                environment,
                this.#function_parameter_types.get(recursive_name),
                this.schema_from_optional_type_name(
                  definition.result_annotation,
                ),
              );
              let function_body = lowered.expression;
              const parameters: string[] = [];
              const parameter_count = Math.max(1, definition.params.length);
              for (
                let parameter_index = 0;
                parameter_index < parameter_count;
                parameter_index += 1
              ) {
                if (function_body.kind !== "lambda") {
                  throw new Error(
                    "Duck gpufuck recursive function is not a lambda: " +
                      recursive_name,
                  );
                }
                parameters.push(function_body.parameter);
                function_body = function_body.body;
              }
              bindings.push({
                name: recursive_name,
                parameters,
                body: function_body,
              });
              if (lowered.type !== undefined) {
                environment.set(recursive_name, lowered.type);
              }
            }

            const body = this.lower_statements(
              statements,
              index + 1,
              environment,
              expected_result,
            );
            return {
              expression: {
                kind: "let-rec-group",
                bindings,
                body: body.expression,
              },
              type: body.type,
            };
          } finally {
            for (const [recursive_name, previous_type] of previous_types) {
              if (previous_type === undefined) {
                environment.delete(recursive_name);
              } else {
                environment.set(recursive_name, previous_type);
              }
            }
          }
        }
        const recursive_type = this.function_type_from_signature(
          rec_function.params,
          rec_function.result_annotation,
        );
        if (recursive_type !== undefined) {
          environment.set(statement.value.name, recursive_type);
        }
        this.#recursive_names.push(statement.value.name);
        try {
          value = this.lower_function(
            rec_function.params,
            rec_function.body,
            environment,
            this.#function_parameter_types.get(statement.name),
            this.schema_from_optional_type_name(
              rec_function.result_annotation,
            ),
          );
        } finally {
          this.#recursive_names.pop();
        }
        recursive = true;
      } else if (statement.value.tag === "rec") {
        const recursive_type = this.function_type_from_signature(
          statement.value.params,
          statement.value.result_annotation,
        );
        if (recursive_type !== undefined) {
          environment.set(statement.name, recursive_type);
        }
        this.#recursive_names.push(statement.name);
        let recursive_expected = this.schema_from_optional_type_name(
          statement.value.result_annotation,
        );
        if (recursive_expected === undefined) {
          recursive_expected = this.schema_from_optional_type_name(
            statement.annotation,
          );
          for (const _param of statement.value.params) {
            if (recursive_expected?.kind === "function") {
              recursive_expected = recursive_expected.result;
            } else {
              recursive_expected = undefined;
            }
          }
        }
        try {
          let known_parameter_types = this.#function_parameter_types.get(
            statement.name,
          );
          if (
            known_parameter_types === undefined &&
            statement.name.startsWith("__duck_loop_")
          ) {
            known_parameter_types = statement.value.params.map((param) =>
              environment.get(param.name)
            );
          }
          value = this.lower_function(
            statement.value.params,
            statement.value.body,
            environment,
            known_parameter_types,
            recursive_expected,
          );
        } finally {
          this.#recursive_names.pop();
        }
        recursive = true;
      } else if (statement.value.tag === "lam") {
        if (
          this.function_requires_specialization(statement.name) &&
          references_are_saturated_calls(
            statements.slice(index + 1),
            statement.name,
            statement.value.params.length,
          )
        ) {
          return this.lower_statements(
            statements,
            index + 1,
            environment,
            expected_result,
          );
        }

        let function_expected_result = this.schema_from_optional_type_name(
          statement.annotation,
        );
        for (const _param of statement.value.params) {
          if (function_expected_result?.kind === "function") {
            function_expected_result = function_expected_result.result;
          } else {
            function_expected_result = undefined;
          }
        }
        try {
          value = this.lower_function(
            statement.value.params,
            statement.value.body,
            environment,
            this.#function_parameter_types.get(statement.name),
            function_expected_result,
          );
        } catch (error) {
          if (error instanceof Error) {
            throw new Error(
              "Duck gpufuck lowering failed for function " + statement.name +
                ": " + error.message,
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        const expected = this.schema_from_optional_type_name(
          statement.annotation,
        );
        value = this.lower_expression(statement.value, environment, expected);
      }
      const binding_type = this.schema_from_optional_type_name(
        statement.annotation,
      );
      let next_type: FunctionalTypeSchema | undefined;
      if (
        binding_type?.kind === "named" && !this.#types.has(binding_type.name) &&
        value.type !== undefined
      ) {
        next_type = value.type;
      } else if (binding_type !== undefined) {
        next_type = binding_type;
      } else if (value.type !== undefined) {
        next_type = value.type;
      }
      const previous_type = environment.get(statement.name);
      if (next_type !== undefined) {
        environment.set(statement.name, next_type);
      }
      let body: LoweredExpression;
      try {
        body = this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      } finally {
        if (next_type !== undefined) {
          if (previous_type === undefined) {
            environment.delete(statement.name);
          } else {
            environment.set(statement.name, previous_type);
          }
        }
      }
      if (recursive) {
        return {
          expression: {
            kind: "let-rec",
            name: statement.name,
            value: value.expression,
            body: body.expression,
          },
          type: body.type,
        };
      }
      return {
        expression: {
          kind: "let",
          name: statement.name,
          value: value.expression,
          body: body.expression,
        },
        type: body.type,
      };
    }

    if (statement.tag === "assign") {
      const expected = environment.get(statement.name);
      const value = this.lower_expression(
        statement.value,
        environment,
        expected,
      );
      if (index === statements.length - 1) {
        return {
          expression: {
            kind: "let",
            name: statement.name,
            value: value.expression,
            body: surface.name("$Unit"),
          },
          type: unit_type,
        };
      }
      const previous_type = environment.get(statement.name);
      if (value.type !== undefined) {
        environment.set(statement.name, value.type);
      }
      let body: LoweredExpression;
      try {
        body = this.lower_statements(
          statements,
          index + 1,
          environment,
          expected_result,
        );
      } finally {
        if (value.type !== undefined) {
          if (previous_type === undefined) {
            environment.delete(statement.name);
          } else {
            environment.set(statement.name, previous_type);
          }
        }
      }
      return {
        expression: {
          kind: "let",
          name: statement.name,
          value: value.expression,
          body: body.expression,
        },
        type: body.type,
      };
    }

    if (statement.tag === "index_assign") {
      const object_type = environment.get(statement.name);
      if (object_type === undefined) {
        throw new Error(
          "Duck gpufuck lowering cannot type indexed assignment to " +
            statement.name,
        );
      }
      const updated = this.lower_index_update(
        surface.name(statement.name),
        object_type,
        statement.index,
        statement.value,
        environment,
      );
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      return {
        expression: {
          kind: "let",
          name: statement.name,
          value: updated.expression,
          body: body.expression,
        },
        type: body.type,
      };
    }

    if (statement.tag === "expr") {
      if (index === statements.length - 1) {
        return this.lower_expression(
          statement.expr,
          environment,
          expected_result,
        );
      }
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      let break_result: FunctionalSurfaceExpression | undefined;
      let continue_result: FunctionalSurfaceExpression | undefined;
      const loop_control = this.#loop_controls.at(-1);
      if (loop_control !== undefined) {
        break_result = loop_control.break_result;
        continue_result = loop_control.continue_result;
      }
      return {
        expression: this.lower_control_expression(
          statement.expr,
          environment,
          body.expression,
          break_result,
          continue_result,
        ),
        type: body.type,
      };
    }

    if (statement.tag === "return") {
      if (index !== statements.length - 1) {
        throw new Error(
          "Duck gpufuck lowering does not support an early return",
        );
      }
      return this.lower_expression(
        statement.value,
        environment,
        expected_result,
      );
    }

    if (statement.tag === "type_check") {
      return this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
    }

    if (statement.tag === "if_stmt") {
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      let break_result: FunctionalSurfaceExpression | undefined;
      let continue_result: FunctionalSurfaceExpression | undefined;
      const loop_control = this.#loop_controls.at(-1);
      if (loop_control !== undefined) {
        break_result = loop_control.break_result;
        continue_result = loop_control.continue_result;
      }
      const consequent = this.lower_control_statements(
        statement.body,
        0,
        environment,
        body.expression,
        break_result,
        continue_result,
      );
      const condition = this.lower_condition(statement.cond, environment);
      return {
        expression: {
          kind: "if",
          condition: condition.expression,
          consequent,
          alternate: body.expression,
        },
        type: body.type,
      };
    }

    if (statement.tag === "if_else_stmt") {
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      let break_result: FunctionalSurfaceExpression | undefined;
      let continue_result: FunctionalSurfaceExpression | undefined;
      const loop_control = this.#loop_controls.at(-1);
      if (loop_control !== undefined) {
        break_result = loop_control.break_result;
        continue_result = loop_control.continue_result;
      }
      const consequent = this.lower_control_statements(
        statement.then_body,
        0,
        environment,
        body.expression,
        break_result,
        continue_result,
      );
      const alternate = this.lower_control_statements(
        statement.else_body,
        0,
        environment,
        body.expression,
        break_result,
        continue_result,
      );
      const condition = this.lower_condition(statement.cond, environment);
      return {
        expression: {
          kind: "if",
          condition: condition.expression,
          consequent,
          alternate,
        },
        type: body.type,
      };
    }

    if (statement.tag === "range_loop") {
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      return this.lower_range_loop(statement, environment, body);
    }

    if (statement.tag === "collection_loop") {
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      return this.lower_collection_loop(statement, environment, body);
    }

    if (statement.tag === "if_let_stmt") {
      const body = this.lower_statements(
        statements,
        index + 1,
        environment,
        expected_result,
      );
      let break_result: FunctionalSurfaceExpression | undefined;
      let continue_result: FunctionalSurfaceExpression | undefined;
      const loop_control = this.#loop_controls.at(-1);
      if (loop_control !== undefined) {
        break_result = loop_control.break_result;
        continue_result = loop_control.continue_result;
      }
      return {
        expression: this.lower_if_let_statement(
          statement,
          environment,
          body.expression,
          break_result,
          continue_result,
        ),
        type: body.type,
      };
    }

    throw new Error(
      "Duck gpufuck lowering does not support " + statement.tag +
        " statement",
    );
  }

  private lower_expression(
    expression: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression {
    if (expression.tag === "num") {
      if (expression.type === "i32" && typeof expression.value === "number") {
        if (expected?.kind === "unit" && expression.value === 0) {
          return {
            expression: surface.name("$Unit"),
            type: unit_type,
          };
        }
        if (expected?.kind === "boolean") {
          return {
            expression: surface.boolean(expression.value !== 0),
            type: { kind: "boolean" },
          };
        }
        return {
          expression: surface.integer(expression.value),
          type: integer_type,
        };
      }
      if (expression.type === "i64" && typeof expression.value === "bigint") {
        return {
          expression: surface.signedInteger64(expression.value),
          type: { kind: "signed-integer-64" },
        };
      }
      if (expression.type === "f32" && typeof expression.value === "number") {
        return {
          expression: surface.float32(expression.value),
          type: { kind: "float-32" },
        };
      }
      if (expression.type === "f64" && typeof expression.value === "number") {
        return {
          expression: surface.float64(expression.value),
          type: { kind: "float-64" },
        };
      }
      throw new Error(
        "Duck gpufuck lowering found invalid " + expression.type + " literal",
      );
    }

    if (expression.tag === "text") {
      return this.lower_text_literal(expression.value, expected);
    }

    if (expression.tag === "var" || expression.tag === "linear") {
      if (expression.name === "rec") {
        const recursive_name = this.#recursive_names.at(-1);
        if (recursive_name === undefined) {
          throw new Error(
            "Duck gpufuck lowering found rec outside a recursive binding",
          );
        }
        return {
          expression: surface.name(recursive_name),
          type: environment.get(recursive_name),
        };
      }
      const type = environment.get(expression.name);
      if (expected?.kind === "boolean" && type?.kind === "integer") {
        return {
          expression: surface.binary(
            FunctionalBinaryOperator.NotEqual,
            surface.name(expression.name),
            surface.integer(0),
          ),
          type: { kind: "boolean" },
        };
      }
      return {
        expression: surface.name(expression.name),
        type,
      };
    }

    if (expression.tag === "rec_ref") {
      return {
        expression: surface.name(expression.name),
        type: environment.get(expression.name),
      };
    }

    if (expression.tag === "prim") {
      return this.lower_primitive(expression, environment);
    }

    if (expression.tag === "lam" || expression.tag === "rec") {
      const parameter_types: (FunctionalTypeSchema | undefined)[] = [];
      let function_type = expected;
      for (
        let parameter_index = 0;
        parameter_index < expression.params.length;
        parameter_index += 1
      ) {
        if (function_type?.kind === "function") {
          parameter_types.push(function_type.parameter);
          function_type = function_type.result;
        } else {
          parameter_types.push(undefined);
        }
      }
      return this.lower_function(
        expression.params,
        expression.body,
        environment,
        parameter_types,
        function_type,
      );
    }

    if (expression.tag === "app") {
      return this.lower_application(expression, environment, expected);
    }

    if (expression.tag === "block") {
      return this.lower_statements(
        expression.statements,
        0,
        new Map(environment),
        expected,
      );
    }

    if (expression.tag === "comptime") {
      return this.lower_expression(expression.expr, environment, expected);
    }

    if (
      expression.tag === "borrow" || expression.tag === "freeze" ||
      expression.tag === "scratch"
    ) {
      let value: CoreExpr;
      if (expression.tag === "scratch") {
        value = expression.body;
      } else {
        value = expression.value;
      }
      return this.lower_expression(value, environment, expected);
    }

    if (expression.tag === "if") {
      const condition = this.lower_condition(expression.cond, environment);
      let branch_expected = expected;
      if (branch_expected === undefined) {
        const consequent_type = this.simple_expression_type(
          expression.then_branch,
          environment,
        );
        const alternate_type = this.simple_expression_type(
          expression.else_branch,
          environment,
        );
        if (consequent_type !== undefined) {
          branch_expected = consequent_type;
        } else if (alternate_type !== undefined) {
          branch_expected = alternate_type;
        }
      }
      const consequent = this.lower_expression(
        expression.then_branch,
        environment,
        branch_expected,
      );
      const alternate = this.lower_expression(
        expression.else_branch,
        environment,
        consequent.type,
      );
      return {
        expression: {
          kind: "if",
          condition: condition.expression,
          consequent: consequent.expression,
          alternate: alternate.expression,
        },
        type: consequent.type,
      };
    }

    if (expression.tag === "struct_value") {
      return this.lower_struct_value(expression, environment, expected);
    }

    if (expression.tag === "with") {
      return this.lower_extension(expression, environment);
    }

    if (expression.tag === "field") {
      return this.lower_field(expression.object, expression.name, environment);
    }

    if (expression.tag === "index") {
      return this.lower_index(expression.object, expression.index, environment);
    }

    if (expression.tag === "struct_update") {
      return this.lower_struct_update(expression, environment);
    }

    if (expression.tag === "union_case") {
      return this.lower_union_case(expression, environment, expected);
    }

    if (expression.tag === "if_let") {
      return this.lower_if_let(expression, environment, expected);
    }

    if (expression.tag === "loop") {
      let result_type = expected;
      if (result_type === undefined) {
        result_type = this.simple_expression_type(expression, environment);
      }
      return this.lower_loop_expression(
        expression.body,
        environment,
        result_type,
      );
    }

    throw new Error(
      "Duck gpufuck lowering does not support " + expression.tag +
        " expression",
    );
  }

  private lower_range_loop(
    statement: Extract<CoreStmt, { tag: "range_loop" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    continuation: LoweredExpression,
  ): LoweredExpression {
    const loop_name = this.temporary("range");
    const index_name = this.temporary(statement.index);
    const start_name = this.temporary("range_start");
    const end_name = this.temporary("range_end");
    const step_name = this.temporary("range_step");
    const state_name = this.temporary("range_state");
    const carried = statement.carried.filter((name) => environment.has(name));
    const state_fields = carried.map((name) => {
      const type = this.require_type(
        environment.get(name),
        "range-carried value " + name,
      );
      if (contains_type_parameter(type)) {
        throw new Error(
          "Duck gpufuck lowering cannot resolve range-carried value " + name,
        );
      }
      return { name, type };
    });
    this.#types.set(state_name, {
      name: state_name,
      shape: "struct",
      fields: state_fields,
      cases: [],
    });
    const state_value = surface.apply(
      surface.name(this.struct_constructor(state_name)),
      ...carried.map((name) => surface.name(name)),
    );
    const next_index = surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name(index_name),
      surface.name(step_name),
    );
    const continue_call = surface.apply(
      surface.name(loop_name),
      next_index,
      ...carried.map((name) => surface.name(name)),
    );
    const loop_environment = new Map(environment);
    loop_environment.set(statement.index, integer_type);
    loop_environment.set(index_name, integer_type);
    this.#loop_controls.push({
      break_result: state_value,
      continue_result: continue_call,
    });
    let loop_body: FunctionalSurfaceExpression;
    try {
      loop_body = this.lower_control_statements(
        statement.body,
        0,
        loop_environment,
        continue_call,
        state_value,
        continue_call,
      );
    } finally {
      this.#loop_controls.pop();
    }
    const positive = surface.binary(
      FunctionalBinaryOperator.Greater,
      surface.name(step_name),
      surface.integer(0),
    );
    const ascending = surface.binary(
      FunctionalBinaryOperator.Less,
      surface.name(index_name),
      surface.name(end_name),
    );
    const descending = surface.binary(
      FunctionalBinaryOperator.Greater,
      surface.name(index_name),
      surface.name(end_name),
    );
    const direction_condition: FunctionalSurfaceExpression = {
      kind: "if",
      condition: positive,
      consequent: ascending,
      alternate: descending,
    };
    const nonzero = surface.binary(
      FunctionalBinaryOperator.NotEqual,
      surface.name(step_name),
      surface.integer(0),
    );
    const valid_condition: FunctionalSurfaceExpression = {
      kind: "if",
      condition: nonzero,
      consequent: direction_condition,
      alternate: this.runtime_trap(
        { kind: "boolean" },
        "Duck range step cannot be zero",
      ).expression,
    };
    let loop_value: FunctionalSurfaceExpression = {
      kind: "if",
      condition: valid_condition,
      consequent: {
        kind: "let",
        name: statement.index,
        value: surface.name(index_name),
        body: loop_body,
      },
      alternate: state_value,
    };
    for (let index = carried.length - 1; index >= 0; index -= 1) {
      const name = carried[index];
      if (name === undefined) {
        throw new Error(
          "Duck range loop lost carried value " + index.toString(),
        );
      }
      loop_value = surface.lambda(name, loop_value);
    }
    loop_value = surface.lambda(index_name, loop_value);

    const start = this.lower_expression(
      statement.start,
      environment,
      integer_type,
    );
    const end = this.lower_expression(statement.end, environment, integer_type);
    const step = this.lower_expression(
      statement.step,
      environment,
      integer_type,
    );
    const initial_call = surface.apply(
      surface.name(loop_name),
      surface.name(start_name),
      ...carried.map((name) => surface.name(name)),
    );
    const state_binders = carried.map((name) => name);
    const resumed: FunctionalSurfaceExpression = {
      kind: "case",
      value: initial_call,
      arms: [{
        constructor: this.struct_constructor(state_name),
        binders: state_binders,
        body: continuation.expression,
      }],
    };
    return {
      expression: {
        kind: "let",
        name: start_name,
        value: start.expression,
        body: {
          kind: "let",
          name: end_name,
          value: end.expression,
          body: {
            kind: "let",
            name: step_name,
            value: step.expression,
            body: {
              kind: "let-rec",
              name: loop_name,
              value: loop_value,
              body: resumed,
            },
          },
        },
      },
      type: continuation.type,
    };
  }

  private lower_loop_expression(
    statements: readonly CoreStmt[],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected: FunctionalTypeSchema | undefined,
    continuation?: LoweredExpression,
  ): LoweredExpression {
    const loop_name = this.temporary("loop");
    const unit_name = this.temporary("loop_unit");
    const carried_names = this.loop_assigned_names(statements).filter((name) =>
      environment.has(name)
    );
    if (expected !== undefined && carried_names.length > 0) {
      throw new Error(
        "Duck gpufuck lowering does not support a value-returning loop " +
          "that mutates " + carried_names.join(", "),
      );
    }

    const continue_call = surface.apply(
      surface.name(loop_name),
      surface.name("$Unit"),
      ...carried_names.map((name) => surface.name(name)),
    );
    let break_result = surface.name("$Unit");
    let state_name: string | undefined;
    if (expected === undefined) {
      state_name = this.temporary("loop_state");
      this.#types.set(state_name, {
        name: state_name,
        shape: "struct",
        fields: carried_names.map((name) => ({
          name,
          type: this.require_type(
            environment.get(name),
            "loop-carried value " + name,
          ),
        })),
        cases: [],
      });
      break_result = surface.apply(
        surface.name(this.struct_constructor(state_name)),
        ...carried_names.map((name) => surface.name(name)),
      );
    }
    this.#loop_controls.push({ break_result, continue_result: continue_call });
    let body: FunctionalSurfaceExpression;
    try {
      body = this.lower_control_statements(
        statements,
        0,
        environment,
        continue_call,
        break_result,
        continue_call,
      );
    } finally {
      this.#loop_controls.pop();
    }
    for (let index = carried_names.length - 1; index >= 0; index -= 1) {
      const name = carried_names[index];
      if (name === undefined) {
        throw new Error(
          "Duck loop lost carried value " + index.toString(),
        );
      }
      body = surface.lambda(name, body);
    }
    const loop_value = surface.lambda(unit_name, body);
    const initial_call = surface.apply(
      surface.name(loop_name),
      surface.name("$Unit"),
      ...carried_names.map((name) => surface.name(name)),
    );
    let resumed = initial_call;
    let result_type = expected;
    if (state_name !== undefined) {
      let resumed_body = surface.name("$Unit");
      result_type = unit_type;
      if (continuation !== undefined) {
        resumed_body = continuation.expression;
        result_type = continuation.type;
      }
      resumed = {
        kind: "case",
        value: initial_call,
        arms: [{
          constructor: this.struct_constructor(state_name),
          binders: carried_names,
          body: resumed_body,
        }],
      };
    }
    return {
      expression: {
        kind: "let-rec",
        name: loop_name,
        value: loop_value,
        body: resumed,
      },
      type: result_type,
    };
  }

  private loop_assigned_names(statements: readonly CoreStmt[]): string[] {
    const names: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
        return;
      }
      const tagged = value as { tag?: string; name?: string };
      if (tagged.tag === "lam" || tagged.tag === "rec") {
        return;
      }
      if (
        (tagged.tag === "assign" || tagged.tag === "index_assign") &&
        tagged.name !== undefined && !names.includes(tagged.name)
      ) {
        names.push(tagged.name);
      }
      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(statements);
    return names;
  }

  private lower_if_let_statement(
    statement: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    terminal: FunctionalSurfaceExpression,
    break_result: FunctionalSurfaceExpression | undefined,
    continue_result: FunctionalSurfaceExpression | undefined,
  ): FunctionalSurfaceExpression {
    const target = this.lower_expression(statement.target, environment);
    const name = this.named_type_name(
      target.type,
      "if let statement " + statement.case_name,
    );
    const definition = this.require_definition(name);
    let fallback_name: string | undefined;
    let fallback_parameter: string | undefined;
    if (definition.cases.length > 2) {
      fallback_name = this.temporary("if_let_fallback");
      fallback_parameter = this.temporary("if_let_unit");
    }
    const arms: FunctionalSurfaceCaseArm[] = [];
    for (const union_case of definition.cases) {
      let binder = this.temporary(union_case.name);
      let body = terminal;
      if (union_case.name === statement.case_name) {
        const branch_environment = new Map(environment);
        if (statement.value_name !== undefined) {
          binder = statement.value_name;
          branch_environment.set(statement.value_name, union_case.type);
        }
        body = this.lower_control_statements(
          statement.body,
          0,
          branch_environment,
          terminal,
          break_result,
          continue_result,
        );
      } else if (fallback_name !== undefined) {
        body = surface.apply(
          surface.name(fallback_name),
          surface.name("$Unit"),
        );
      }
      arms.push({
        constructor: this.union_constructor(name, union_case.name),
        binders: [binder],
        body,
      });
    }
    const matched: FunctionalSurfaceExpression = {
      kind: "case",
      value: target.expression,
      arms,
    };
    if (fallback_name !== undefined && fallback_parameter !== undefined) {
      return {
        kind: "let",
        name: fallback_name,
        value: surface.lambda(fallback_parameter, terminal),
        body: matched,
      };
    }
    return matched;
  }

  private lower_collection_loop(
    statement: Extract<CoreStmt, { tag: "collection_loop" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    continuation: LoweredExpression,
  ): LoweredExpression {
    const collection = this.lower_expression(statement.collection, environment);
    const collection_name = this.temporary("collection");
    let index_name = statement.index;
    if (index_name === undefined) {
      index_name = this.temporary("collection_index");
    }
    let end: CoreExpr;
    let element: CoreExpr;
    if (
      this.same_type(collection.type, FunctionalHostTypes.text) ||
      this.same_type(collection.type, FunctionalHostTypes.bytes)
    ) {
      end = {
        tag: "app",
        func: { tag: "var", name: "@len" },
        args: [{ tag: "var", name: collection_name }],
      };
      element = {
        tag: "app",
        func: { tag: "var", name: "@get" },
        args: [
          { tag: "var", name: collection_name },
          { tag: "var", name: index_name },
        ],
      };
    } else if (collection.type?.kind === "named") {
      const name = source_type_name_from_schema(collection.type);
      this.materialize_type_definition(name);
      const definition = this.#types.get(name);

      if (definition === undefined) {
        throw new Error(
          "Duck gpufuck lowering cannot iterate collection type " + name,
        );
      }
      end = { tag: "num", type: "i32", value: definition.fields.length };
      element = {
        tag: "index",
        object: { tag: "var", name: collection_name },
        index: { tag: "var", name: index_name },
      };
    } else {
      throw new Error(
        "Duck gpufuck lowering cannot iterate this collection type",
      );
    }
    const element_binding: CoreStmt = {
      tag: "bind",
      kind: "let",
      name: statement.item,
      is_linear: false,
      annotation: undefined,
      value: element,
    };
    const range: Extract<CoreStmt, { tag: "range_loop" }> = {
      tag: "range_loop",
      index: index_name,
      start: { tag: "num", type: "i32", value: 0 },
      end,
      end_bound: "exclusive",
      step: { tag: "num", type: "i32", value: 1 },
      carried: statement.carried,
      body: [element_binding, ...statement.body],
    };
    const collection_environment = new Map(environment);
    if (collection.type !== undefined) {
      collection_environment.set(collection_name, collection.type);
    }
    const loop = this.lower_range_loop(
      range,
      collection_environment,
      continuation,
    );
    return {
      expression: {
        kind: "let",
        name: collection_name,
        value: collection.expression,
        body: loop.expression,
      },
      type: continuation.type,
    };
  }

  private lower_control_statements(
    statements: readonly CoreStmt[],
    index: number,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    terminal: FunctionalSurfaceExpression,
    break_result: FunctionalSurfaceExpression | undefined,
    continue_result: FunctionalSurfaceExpression | undefined,
  ): FunctionalSurfaceExpression {
    const statement = statements[index];
    if (statement === undefined) {
      return terminal;
    }
    if (statement.tag === "bind") {
      let recursive_value:
        | Extract<CoreExpr, { tag: "rec" }>
        | undefined;
      let capture_statements: Extract<CoreStmt, { tag: "bind" }>[] = [];

      if (statement.value.tag === "rec") {
        recursive_value = statement.value;
      } else if (statement.value.tag === "block") {
        const final_statement = statement.value.statements.at(-1);
        const preceding_statements = statement.value.statements.slice(0, -1);

        if (
          final_statement?.tag === "expr" &&
          final_statement.expr.tag === "rec" &&
          preceding_statements.every((candidate) => candidate.tag === "bind")
        ) {
          recursive_value = final_statement.expr;
          capture_statements = preceding_statements as Extract<
            CoreStmt,
            { tag: "bind" }
          >[];
        }
      }

      if (recursive_value !== undefined) {
        const body_environment = new Map(environment);
        const captures: {
          name: string;
          value: FunctionalSurfaceExpression;
        }[] = [];

        for (const capture_statement of capture_statements) {
          const capture_expected = this.schema_from_optional_type_name(
            capture_statement.annotation,
          );
          const capture = this.lower_expression(
            capture_statement.value,
            body_environment,
            capture_expected,
          );
          const capture_type = capture_expected;

          if (capture_type !== undefined) {
            body_environment.set(capture_statement.name, capture_type);
          } else if (capture.type !== undefined) {
            body_environment.set(capture_statement.name, capture.type);
          }

          captures.push({
            name: capture_statement.name,
            value: capture.expression,
          });
        }

        const recursive_type = this.function_type_from_signature(
          recursive_value.params,
          recursive_value.result_annotation,
        );
        if (recursive_type !== undefined) {
          body_environment.set(statement.name, recursive_type);
        }
        this.#recursive_names.push(statement.name);
        let value: LoweredExpression;
        let recursive_expected = this.schema_from_optional_type_name(
          recursive_value.result_annotation,
        );
        if (recursive_expected === undefined) {
          recursive_expected = this.schema_from_optional_type_name(
            statement.annotation,
          );
          for (const _param of recursive_value.params) {
            if (recursive_expected?.kind === "function") {
              recursive_expected = recursive_expected.result;
            } else {
              recursive_expected = undefined;
            }
          }
        }
        try {
          let known_parameter_types = this.#function_parameter_types.get(
            statement.name,
          );
          if (
            known_parameter_types === undefined &&
            statement.name.startsWith("__duck_loop_")
          ) {
            known_parameter_types = recursive_value.params.map((param) =>
              body_environment.get(param.name)
            );
          }
          value = this.lower_function(
            recursive_value.params,
            recursive_value.body,
            body_environment,
            known_parameter_types,
            recursive_expected,
          );
        } finally {
          this.#recursive_names.pop();
        }
        if (value.type !== undefined) {
          body_environment.set(statement.name, value.type);
        }
        const body = this.lower_control_statements(
          statements,
          index + 1,
          body_environment,
          terminal,
          break_result,
          continue_result,
        );
        let result: FunctionalSurfaceExpression = {
          kind: "let-rec",
          name: statement.name,
          value: value.expression,
          body,
        };

        for (let index = captures.length - 1; index >= 0; index -= 1) {
          const capture = captures[index];
          if (capture === undefined) {
            throw new Error(
              "Duck gpufuck lowering lost recursive capture " +
                index.toString(),
            );
          }
          result = {
            kind: "let",
            name: capture.name,
            value: capture.value,
            body: result,
          };
        }

        return result;
      }

      const expected = this.schema_from_optional_type_name(
        statement.annotation,
      );
      const value = this.lower_expression(
        statement.value,
        environment,
        expected,
      );
      const body_environment = new Map(environment);
      if (expected !== undefined) {
        body_environment.set(statement.name, expected);
      } else if (value.type !== undefined) {
        body_environment.set(statement.name, value.type);
      }
      const body = this.lower_control_statements(
        statements,
        index + 1,
        body_environment,
        terminal,
        break_result,
        continue_result,
      );
      return {
        kind: "let",
        name: statement.name,
        value: value.expression,
        body,
      };
    }
    if (statement.tag === "assign") {
      const expected = environment.get(statement.name);
      const value = this.lower_expression(
        statement.value,
        environment,
        expected,
      );
      const body_environment = new Map(environment);
      if (!body_environment.has(statement.name) && value.type !== undefined) {
        body_environment.set(statement.name, value.type);
      }
      const body = this.lower_control_statements(
        statements,
        index + 1,
        body_environment,
        terminal,
        break_result,
        continue_result,
      );
      return {
        kind: "let",
        name: statement.name,
        value: value.expression,
        body,
      };
    }
    const remainder = this.lower_control_statements(
      statements,
      index + 1,
      environment,
      terminal,
      break_result,
      continue_result,
    );
    if (statement.tag === "index_assign") {
      const object_type = environment.get(statement.name);
      if (object_type === undefined) {
        throw new Error(
          "Duck gpufuck lowering cannot type indexed loop assignment",
        );
      }
      const value = this.lower_index_update(
        surface.name(statement.name),
        object_type,
        statement.index,
        statement.value,
        environment,
      );
      return {
        kind: "let",
        name: statement.name,
        value: value.expression,
        body: remainder,
      };
    }
    if (statement.tag === "expr") {
      if (statement.expr.tag === "loop") {
        return this.lower_loop_expression(
          statement.expr.body,
          environment,
          undefined,
          { expression: remainder, type: undefined },
        ).expression;
      }
      return this.lower_control_expression(
        statement.expr,
        environment,
        remainder,
        break_result,
        continue_result,
      );
    }
    if (statement.tag === "if_stmt") {
      const condition = this.lower_condition(statement.cond, environment);
      return {
        kind: "if",
        condition: condition.expression,
        consequent: this.lower_control_statements(
          statement.body,
          0,
          environment,
          remainder,
          break_result,
          continue_result,
        ),
        alternate: remainder,
      };
    }
    if (statement.tag === "if_else_stmt") {
      const condition = this.lower_condition(statement.cond, environment);
      return {
        kind: "if",
        condition: condition.expression,
        consequent: this.lower_control_statements(
          statement.then_body,
          0,
          environment,
          remainder,
          break_result,
          continue_result,
        ),
        alternate: this.lower_control_statements(
          statement.else_body,
          0,
          environment,
          remainder,
          break_result,
          continue_result,
        ),
      };
    }
    if (statement.tag === "range_loop") {
      return this.lower_range_loop(
        statement,
        environment,
        { expression: remainder, type: undefined },
      ).expression;
    }
    if (statement.tag === "collection_loop") {
      return this.lower_collection_loop(
        statement,
        environment,
        { expression: remainder, type: undefined },
      ).expression;
    }
    if (statement.tag === "if_let_stmt") {
      return this.lower_if_let_statement(
        statement,
        environment,
        remainder,
        break_result,
        continue_result,
      );
    }
    if (statement.tag === "break") {
      if (statement.value !== undefined) {
        return this.lower_expression(statement.value, environment).expression;
      }
      if (break_result === undefined) {
        throw new Error("Duck gpufuck lowering found break outside a loop");
      }
      return break_result;
    }
    if (statement.tag === "continue") {
      if (continue_result === undefined) {
        throw new Error("Duck gpufuck lowering found continue outside a loop");
      }
      return continue_result;
    }
    if (statement.tag === "return") {
      const expected = this.#function_expected_results.at(-1);
      return this.lower_expression(
        statement.value,
        environment,
        expected,
      ).expression;
    }
    if (statement.tag === "type_check") {
      return remainder;
    }
    throw new Error(
      "Duck gpufuck lowering does not support " + statement.tag +
        " in control flow",
    );
  }

  private lower_control_expression(
    expression: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    terminal: FunctionalSurfaceExpression,
    break_result: FunctionalSurfaceExpression | undefined,
    continue_result: FunctionalSurfaceExpression | undefined,
  ): FunctionalSurfaceExpression {
    if (expression.tag === "block") {
      return this.lower_control_statements(
        expression.statements,
        0,
        environment,
        terminal,
        break_result,
        continue_result,
      );
    }
    if (expression.tag === "loop") {
      return this.lower_loop_expression(
        expression.body,
        environment,
        undefined,
        { expression: terminal, type: undefined },
      ).expression;
    }
    if (expression.tag === "if") {
      const condition = this.lower_condition(expression.cond, environment);
      return {
        kind: "if",
        condition: condition.expression,
        consequent: this.lower_control_expression(
          expression.then_branch,
          environment,
          terminal,
          break_result,
          continue_result,
        ),
        alternate: this.lower_control_expression(
          expression.else_branch,
          environment,
          terminal,
          break_result,
          continue_result,
        ),
      };
    }
    if (expression.tag === "if_let") {
      const target = this.lower_expression(expression.target, environment);
      const name = this.named_type_name(
        target.type,
        "control if let " + expression.case_name + " on " +
          JSON.stringify(expression.target),
      );
      if (!this.#types.has(name) && !this.#type_aliases.has(name)) {
        throw new Error(
          "Duck gpufuck cannot match " + expression.case_name + " against " +
            name + " from " + JSON.stringify(expression.target),
        );
      }
      const definition = this.require_definition(name);
      let fallback_name: string | undefined;
      let fallback_parameter: string | undefined;
      let fallback: FunctionalSurfaceExpression | undefined;
      if (definition.cases.length > 2) {
        fallback_name = this.temporary("if_let_fallback");
        fallback_parameter = this.temporary("if_let_unit");
        fallback = this.lower_control_expression(
          expression.else_branch,
          environment,
          terminal,
          break_result,
          continue_result,
        );
      }
      const arms: FunctionalSurfaceCaseArm[] = [];
      for (const union_case of definition.cases) {
        let binder = this.temporary(union_case.name);
        let body: FunctionalSurfaceExpression;
        if (union_case.name === expression.case_name) {
          const branch_environment = new Map(environment);
          if (expression.value_name !== undefined) {
            binder = expression.value_name;
            branch_environment.set(expression.value_name, union_case.type);
          }
          body = this.lower_control_expression(
            expression.then_branch,
            branch_environment,
            terminal,
            break_result,
            continue_result,
          );
        } else if (fallback_name !== undefined) {
          body = surface.apply(
            surface.name(fallback_name),
            surface.name("$Unit"),
          );
        } else {
          body = this.lower_control_expression(
            expression.else_branch,
            environment,
            terminal,
            break_result,
            continue_result,
          );
        }
        arms.push({
          constructor: this.union_constructor(name, union_case.name),
          binders: [binder],
          body,
        });
      }
      const matched: FunctionalSurfaceExpression = {
        kind: "case",
        value: target.expression,
        arms,
      };
      if (
        fallback_name !== undefined && fallback_parameter !== undefined &&
        fallback !== undefined
      ) {
        return {
          kind: "let",
          name: fallback_name,
          value: surface.lambda(fallback_parameter, fallback),
          body: matched,
        };
      }
      return matched;
    }
    let expected: FunctionalTypeSchema | undefined;
    if (
      expression.tag === "app" && expression.func.tag === "var" &&
      expression.func.name === "@panic"
    ) {
      expected = unit_type;
    }
    const value = this.lower_expression(expression, environment, expected);
    return {
      kind: "let",
      name: this.temporary("discarded"),
      value: value.expression,
      body: terminal,
      valueEvaluation: FunctionalEvaluationProfile.StrictEager,
    };
  }

  private lower_function(
    params: readonly CoreParam[],
    body: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    known_parameter_types?: readonly (FunctionalTypeSchema | undefined)[],
    expected_result?: FunctionalTypeSchema,
  ): LoweredExpression {
    if (params.length === 0) {
      this.#function_expected_results.push(expected_result);
      let lowered_body: LoweredExpression;
      try {
        lowered_body = this.lower_expression(
          body,
          environment,
          expected_result,
        );
      } finally {
        this.#function_expected_results.pop();
      }
      return {
        expression: surface.lambda(
          this.temporary("unit"),
          lowered_body.expression,
        ),
        type: {
          kind: "function",
          parameter: unit_type,
          result: this.require_type(
            lowered_body.type,
            "zero-parameter function result",
          ),
        },
      };
    }
    const body_environment = new Map(environment);
    const param_types: FunctionalTypeSchema[] = [];
    for (let index = 0; index < params.length; index += 1) {
      const param = params[index];
      if (param === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost function parameter " + index.toString(),
        );
      }
      let param_type = this.schema_from_optional_type_name(param.annotation);
      if (
        param_type?.kind === "named" && !this.#types.has(param_type.name) &&
        known_parameter_types?.[index] !== undefined
      ) {
        param_type = known_parameter_types[index];
      }
      if (param_type === undefined) {
        param_type = known_parameter_types?.[index];
      }
      if (param_type === undefined) {
        param_type = this.require_type(
          this.infer_function_parameter_type(
            body,
            param.name,
            body_environment,
          ),
          "function parameter " + param.name + " in (" +
            params.map((candidate) => candidate.name).join(", ") + ")",
        );
      }
      body_environment.set(param.name, param_type);
      param_types.push(param_type);
    }
    this.#function_expected_results.push(expected_result);
    let lowered_body: LoweredExpression;
    try {
      lowered_body = this.lower_expression(
        body,
        body_environment,
        expected_result,
      );
    } finally {
      this.#function_expected_results.pop();
    }
    let lowered = lowered_body.expression;
    let inferred_result = lowered_body.type;
    if (inferred_result === undefined) {
      inferred_result = expected_result;
    }
    let function_type = this.require_type(
      inferred_result,
      "function result for (" +
        params.map((candidate) => candidate.name).join(", ") + ")",
    );
    for (let index = params.length - 1; index >= 0; index -= 1) {
      const param = params[index];
      const param_type = param_types[index];
      if (param === undefined || param_type === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost function parameter " + index.toString(),
        );
      }
      lowered = surface.lambda(param.name, lowered);
      function_type = {
        kind: "function",
        parameter: param_type,
        result: function_type,
      };
    }
    return { expression: lowered, type: function_type };
  }

  private function_type_from_signature(
    params: readonly CoreParam[],
    result_annotation: string | undefined,
  ): FunctionalTypeSchema | undefined {
    if (result_annotation === undefined) {
      return undefined;
    }

    let type = this.schema_from_type_name(result_annotation);
    for (let index = params.length - 1; index >= 0; index -= 1) {
      const param = params[index];
      if (param === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost recursive parameter " +
            index.toString(),
        );
      }
      const parameter_type = this.schema_from_optional_type_name(
        param.annotation,
      );
      if (parameter_type === undefined) {
        return undefined;
      }
      type = {
        kind: "function",
        parameter: parameter_type,
        result: type,
      };
    }
    return type;
  }

  private callable_definitions(): FunctionalSurfaceDefinition[] {
    const callables = this.#abi.callables;
    if (callables === undefined) {
      return [];
    }
    const callable_types = new Map<string, FunctionalTypeSchema>();
    for (const callable of Object.values(callables)) {
      callable_types.set(callable.name, this.callable_type(callable));
    }
    const dependency_names = new Set<string>();
    const pending_dependencies: string[] = [];
    for (const callable of Object.values(callables)) {
      const recursive = this.#core.recFunctions?.[callable.name];
      if (recursive === undefined) {
        throw new Error(
          "Duck gpufuck lowering cannot find host callable " +
            callable.name,
        );
      }
      for (const candidate of this.#source_functions.keys()) {
        if (this.#type_constructors.has(candidate)) {
          continue;
        }
        if (this.value_references_name(recursive.body, candidate)) {
          dependency_names.add(candidate);
          pending_dependencies.push(candidate);
        }
      }
    }
    while (pending_dependencies.length > 0) {
      const dependency_name = pending_dependencies.pop();
      if (dependency_name === undefined) {
        throw new Error("Duck host callable dependency scan lost a name");
      }
      const dependency = this.#source_functions.get(dependency_name);
      if (dependency === undefined) {
        throw new Error(
          "Duck host callable dependency scan cannot find " +
            dependency_name,
        );
      }
      for (const candidate of this.#source_functions.keys()) {
        if (
          !this.#type_constructors.has(candidate) &&
          !dependency_names.has(candidate) &&
          this.value_references_name(dependency.body, candidate)
        ) {
          dependency_names.add(candidate);
          pending_dependencies.push(candidate);
        }
      }
    }
    const definitions: FunctionalSurfaceDefinition[] = [];
    const dependency_environment = new Map(callable_types);
    for (const statement of this.#core.statements) {
      if (
        statement.tag !== "bind" || !dependency_names.has(statement.name) ||
        (statement.value.tag !== "lam" && statement.value.tag !== "rec")
      ) {
        continue;
      }
      let expected_result = this.schema_from_optional_type_name(
        statement.annotation,
      );
      for (const _parameter of statement.value.params) {
        if (expected_result?.kind === "function") {
          expected_result = expected_result.result;
        } else {
          expected_result = undefined;
        }
      }
      const lowered = this.lower_function(
        statement.value.params,
        statement.value.body,
        dependency_environment,
        this.#function_parameter_types.get(statement.name),
        expected_result,
      );
      let function_body = lowered.expression;
      const parameters: string[] = [];
      const parameter_count = Math.max(1, statement.value.params.length);
      for (
        let parameter_index = 0;
        parameter_index < parameter_count;
        parameter_index += 1
      ) {
        if (function_body.kind !== "lambda") {
          throw new Error(
            "Duck host callable dependency is not a function: " +
              statement.name,
          );
        }
        parameters.push(function_body.parameter);
        function_body = function_body.body;
      }
      definitions.push({
        name: statement.name,
        parameters,
        annotation: this.require_type(
          lowered.type,
          "host callable dependency " + statement.name,
        ),
        body: function_body,
      });
      dependency_environment.set(
        statement.name,
        this.require_type(
          lowered.type,
          "host callable dependency " + statement.name,
        ),
      );
    }
    for (const callable of Object.values(callables)) {
      const recursive = this.#core.recFunctions?.[callable.name];
      if (recursive === undefined) {
        throw new Error(
          "Duck gpufuck lowering cannot find host callable " +
            callable.name,
        );
      }
      if (recursive.params.length !== callable.params.length) {
        throw new Error(
          "Duck host callable " + callable.name + " has " +
            recursive.params.length.toString() + " Core parameters for " +
            callable.params.length.toString() + " ABI parameters",
        );
      }
      const environment = new Map(dependency_environment);
      for (let index = 0; index < recursive.params.length; index += 1) {
        const parameter = recursive.params[index];
        const contract = callable.params[index];
        if (parameter === undefined || contract === undefined) {
          throw new Error(
            "Duck host callable " + callable.name +
              " lost parameter " + index.toString(),
          );
        }
        environment.set(
          parameter.name,
          this.schema_from_abi_ref(contract.type),
        );
      }
      this.#recursive_names.push(callable.name);
      let body: LoweredExpression;
      try {
        body = this.lower_expression(
          recursive.body,
          environment,
          this.schema_from_abi_ref(callable.result.type),
        );
      } finally {
        this.#recursive_names.pop();
      }
      definitions.push({
        name: callable.name,
        parameters: recursive.params.map((parameter) => parameter.name),
        annotation: this.callable_type(callable),
        body: body.expression,
      });
    }
    return definitions;
  }

  private reachable_recursive_functions_reference_name(
    statements: readonly CoreStmt[],
    start_index: number,
    name: string,
  ): boolean {
    const recursive_functions = this.#core.recFunctions;
    if (recursive_functions === undefined) {
      return false;
    }

    const reached = new Set<string>();
    const pending: string[] = [];
    for (const candidate of this.#recursive_function_names) {
      if (this.statements_reference_name(statements, start_index, candidate)) {
        reached.add(candidate);
        pending.push(candidate);
      }
    }

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        throw new Error("Duck gpufuck dependency scan lost a function");
      }
      const definition = recursive_functions[current];
      if (definition === undefined) {
        throw new Error(
          "Duck gpufuck dependency scan cannot find function " + current,
        );
      }
      if (this.value_references_name(definition.body, name)) {
        return true;
      }
      for (const candidate of this.#recursive_function_names) {
        if (
          !reached.has(candidate) &&
          this.value_references_name(definition.body, candidate)
        ) {
          reached.add(candidate);
          pending.push(candidate);
        }
      }
    }

    return false;
  }

  private callable_type(
    callable: NonNullable<AbiManifest["callables"]>[string],
  ): FunctionalTypeSchema {
    let type = this.schema_from_abi_ref(callable.result.type);
    for (let index = callable.params.length - 1; index >= 0; index -= 1) {
      const parameter = callable.params[index];
      if (parameter === undefined) {
        throw new Error(
          "Duck host callable " + callable.name +
            " lost parameter " + index.toString(),
        );
      }
      type = {
        kind: "function",
        parameter: this.schema_from_abi_ref(parameter.type),
        result: type,
      };
    }
    return type;
  }

  private callable_exports(): { name: string; definition: string }[] {
    const callables = this.#abi.callables;
    if (callables === undefined) {
      return [];
    }
    return Object.values(callables).map((callable) => ({
      name: callable.export,
      definition: callable.name,
    }));
  }

  private infer_function_parameter_type(
    body: CoreExpr,
    parameter_name: string,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): FunctionalTypeSchema | undefined {
    let inferred: FunctionalTypeSchema | undefined;
    const record = (type: FunctionalTypeSchema): void => {
      if (inferred !== undefined && !this.same_type(inferred, type)) {
        throw new Error(
          "Duck gpufuck lowering inferred conflicting types for parameter " +
            parameter_name,
        );
      }
      inferred = type;
    };
    const scan = (value: unknown): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          scan(entry);
        }
        return;
      }
      const expression = value as Partial<CoreExpr>;
      if (expression.tag === "prim") {
        const primitive = expression as Extract<CoreExpr, { tag: "prim" }>;
        for (const arg of primitive.args) {
          if (arg.tag === "var" && arg.name === parameter_name) {
            record(this.type_from_primitive_prefix(primitive.prim));
          }
        }
      } else if (expression.tag === "if") {
        const condition = (expression as Extract<CoreExpr, { tag: "if" }>).cond;
        if (condition.tag === "var" && condition.name === parameter_name) {
          record(integer_type);
        }
      } else if (expression.tag === "index") {
        const index = (expression as Extract<CoreExpr, { tag: "index" }>).index;
        if (index.tag === "var" && index.name === parameter_name) {
          record(integer_type);
        }
      } else if (expression.tag === "app") {
        const app = expression as Extract<CoreExpr, { tag: "app" }>;
        if (app.func.tag === "var") {
          let function_type = environment.get(app.func.name);
          for (const arg of app.args) {
            if (function_type?.kind !== "function") {
              break;
            }
            if (arg.tag === "var" && arg.name === parameter_name) {
              record(function_type.parameter);
            }
            function_type = function_type.result;
          }
        }
      }
      for (const child of Object.values(value)) {
        scan(child);
      }
    };
    scan(body);
    return inferred;
  }

  private statements_reference_name(
    statements: readonly CoreStmt[],
    start_index: number,
    name: string,
  ): boolean {
    let last_reference_index = this.#last_reference_index_by_statements.get(
      statements,
    );
    if (last_reference_index === undefined) {
      const collected = new Map<string, number>();
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (statement === undefined) {
          throw new Error(
            "Duck gpufuck reference index lost statement " +
              index.toString(),
          );
        }
        for (const referenced_name of this.referenced_names(statement)) {
          collected.set(referenced_name, index);
        }
      }
      last_reference_index = collected;
      this.#last_reference_index_by_statements.set(
        statements,
        last_reference_index,
      );
    }
    const last_index = last_reference_index.get(name);
    return last_index !== undefined && last_index >= start_index;
  }

  private value_references_name(value: unknown, name: string): boolean {
    return this.referenced_names(value).has(name);
  }

  private referenced_names(value: unknown): ReadonlySet<string> {
    if (value === null || typeof value !== "object") {
      return empty_referenced_names;
    }
    let names = this.#referenced_names_by_value.get(value);
    if (names === undefined) {
      const collected = new Set<string>();
      const pending: object[] = [value];
      const visited = new WeakSet<object>();
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) {
          throw new Error("Duck gpufuck reference index lost a pending value");
        }
        if (visited.has(current)) {
          continue;
        }
        visited.add(current);
        if (ArrayBuffer.isView(current)) {
          continue;
        }
        const expression = current as Partial<CoreExpr>;
        if (
          (expression.tag === "var" || expression.tag === "linear" ||
            expression.tag === "rec_ref") && expression.name !== undefined
        ) {
          collected.add(expression.name);
        }
        const statement = current as Partial<CoreStmt>;
        if (
          (statement.tag === "assign" || statement.tag === "index_assign") &&
          statement.name !== undefined
        ) {
          collected.add(statement.name);
        }
        for (const child of Object.values(current)) {
          if (child !== null && typeof child === "object") {
            pending.push(child);
          }
        }
      }
      names = collected;
      this.#referenced_names_by_value.set(value, names);
    }
    return names;
  }

  private lower_application(
    expression: Extract<CoreExpr, { tag: "app" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression {
    if (expression.func.tag === "var") {
      const builtin = this.lower_builtin_application(
        expression.func.name,
        expression.args,
        environment,
        expected,
      );
      if (builtin !== undefined) {
        return builtin;
      }
      const imported = this.#abi.imports[expression.func.name];
      if (imported !== undefined) {
        return this.lower_host_import(imported, expression.args, environment);
      }

      const specialized = this.lower_specialized_function_application(
        expression.func.name,
        expression.args,
        environment,
        expected,
      );

      if (specialized !== undefined) {
        return specialized;
      }
    }

    if (
      expression.func.tag === "field" && expression.func.object.tag === "var" &&
      (this.#types.has(expression.func.object.name) ||
        this.#type_aliases.has(expression.func.object.name))
    ) {
      const type_name = this.type_expression_name(expression.func.object);
      return this.lower_static_type_call(
        type_name,
        expression.func.name,
        expression.args,
        environment,
      );
    }

    const callee = this.lower_expression(expression.func, environment);
    let result_expression = callee.expression;
    let result_type = callee.type;
    if (expression.args.length === 0) {
      result_expression = surface.apply(
        result_expression,
        surface.name("$Unit"),
      );
      if (result_type?.kind === "function") {
        result_type = result_type.result;
      }
    } else {
      for (const arg of expression.args) {
        let parameter_type: FunctionalTypeSchema | undefined;
        if (result_type?.kind === "function") {
          parameter_type = result_type.parameter;
        }
        const lowered_arg = this.lower_expression(
          arg,
          environment,
          parameter_type,
        );
        result_expression = surface.apply(
          result_expression,
          lowered_arg.expression,
        );
        if (result_type?.kind === "function") {
          result_type = result_type.result;
        } else {
          result_type = undefined;
        }
      }
    }
    const specialized_type = this.simple_expression_type(
      expression,
      environment,
    );
    if (specialized_type !== undefined) {
      result_type = specialized_type;
    }
    return { expression: result_expression, type: result_type };
  }

  private lower_specialized_function_application(
    name: string,
    args: readonly CoreExpr[],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected: FunctionalTypeSchema | undefined,
  ): LoweredExpression | undefined {
    if (
      !this.function_requires_specialization(name) ||
      this.#specializing_function_bodies.has(name)
    ) {
      return undefined;
    }

    const definition = this.#source_functions.get(name);

    if (
      definition === undefined || definition.params.length !== args.length
    ) {
      return undefined;
    }

    const lowered_args = args.map((arg) =>
      this.lower_expression(arg, environment)
    );
    const body_environment = new Map(environment);
    const type_parameters = new Map<string, FunctionalTypeSchema>();
    const parameter_types = this.#function_parameter_types.get(name);

    for (let index = 0; index < definition.params.length; index += 1) {
      const parameter = definition.params[index];
      const argument = lowered_args[index];
      expect(parameter, "Missing specialized function parameter " + index);
      expect(argument, "Missing specialized function argument " + index);
      body_environment.set(
        parameter.name,
        this.require_type(
          argument.type,
          "specialized function argument " + parameter.name,
        ),
      );
      const parameter_type = parameter_types?.[index];
      if (parameter_type !== undefined && argument.type !== undefined) {
        this.collect_specialized_type_parameters(
          parameter_type,
          argument.type,
          type_parameters,
        );
      }
    }

    this.#specializing_function_bodies.add(name);
    this.#specialized_type_parameters.push(type_parameters);
    let body: LoweredExpression;

    try {
      body = this.lower_expression(
        definition.body,
        body_environment,
        expected,
      );
    } finally {
      this.#specialized_type_parameters.pop();
      this.#specializing_function_bodies.delete(name);
    }

    let expression = body.expression;

    for (let index = definition.params.length - 1; index >= 0; index -= 1) {
      const parameter = definition.params[index];
      const argument = lowered_args[index];
      expect(parameter, "Missing specialized function parameter " + index);
      expect(argument, "Missing specialized function argument " + index);
      expression = {
        kind: "let",
        name: parameter.name,
        value: argument.expression,
        body: expression,
      };
    }

    return { expression, type: body.type };
  }

  private collect_specialized_type_parameters(
    template: FunctionalTypeSchema,
    actual: FunctionalTypeSchema,
    parameters: Map<string, FunctionalTypeSchema>,
  ): void {
    if (template.kind === "parameter") {
      const existing = parameters.get(template.name);
      if (existing !== undefined && !this.same_type(existing, actual)) {
        throw new Error(
          "Duck generic parameter " + template.name +
            " has incompatible specializations " + this.type_key(existing) +
            " and " + this.type_key(actual),
        );
      }
      parameters.set(template.name, actual);
      return;
    }
    if (template.kind !== actual.kind) {
      return;
    }
    if (template.kind === "function" && actual.kind === "function") {
      this.collect_specialized_type_parameters(
        template.parameter,
        actual.parameter,
        parameters,
      );
      this.collect_specialized_type_parameters(
        template.result,
        actual.result,
        parameters,
      );
      return;
    }
    if (template.kind === "tuple" && actual.kind === "tuple") {
      this.collect_specialized_type_parameters(
        template.values[0],
        actual.values[0],
        parameters,
      );
      this.collect_specialized_type_parameters(
        template.values[1],
        actual.values[1],
        parameters,
      );
      return;
    }
    if (template.kind === "named" && actual.kind === "named") {
      const template_application = source_type_application(template.name);
      const actual_application = source_type_application(actual.name);
      if (
        template_application !== undefined &&
        actual_application !== undefined &&
        template_application.name === actual_application.name &&
        template_application.args.length === actual_application.args.length
      ) {
        for (
          let index = 0;
          index < template_application.args.length;
          index += 1
        ) {
          const template_argument = template_application.args[index];
          const actual_argument = actual_application.args[index];
          expect(
            template_argument,
            "Missing generic template type argument " + index.toString(),
          );
          expect(
            actual_argument,
            "Missing generic actual type argument " + index.toString(),
          );
          this.collect_specialized_type_parameters(
            this.schema_from_type_name(format_type_expr(template_argument)),
            this.schema_from_type_name(format_type_expr(actual_argument)),
            parameters,
          );
        }
        return;
      }
      if (
        template.name !== actual.name ||
        template.arguments.length !== actual.arguments.length
      ) {
        return;
      }
      for (let index = 0; index < template.arguments.length; index += 1) {
        const template_argument = template.arguments[index];
        const actual_argument = actual.arguments[index];
        expect(
          template_argument,
          "Missing generic template argument " + index.toString(),
        );
        expect(
          actual_argument,
          "Missing generic actual argument " + index.toString(),
        );
        this.collect_specialized_type_parameters(
          template_argument,
          actual_argument,
          parameters,
        );
      }
    }
  }

  private function_requires_specialization(name: string): boolean {
    const parameter_types = this.#function_parameter_types.get(name);
    return parameter_types !== undefined &&
      parameter_types.some((type) =>
        type !== undefined && contains_type_parameter(type)
      );
  }

  private lower_builtin_application(
    name: string,
    args: readonly CoreExpr[],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression | undefined {
    if (name === "@Bytes.generate") {
      const length = this.lower_expression(
        this.required_arg(args, 0, name),
        environment,
        integer_type,
      );
      const generator_type: FunctionalTypeSchema = {
        kind: "function",
        parameter: integer_type,
        result: integer_type,
      };
      const generator = this.lower_expression(
        this.required_arg(args, 1, name),
        environment,
        generator_type,
      );
      const parameter = this.tuple_type(integer_type, generator_type);
      const field = this.runtime_intrinsic(
        "generate:bytes",
        parameter,
        FunctionalHostTypes.bytes,
        FunctionalWasmIntrinsic.BufferGenerate,
        "bounded-borrow",
        "unique",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          this.tuple_expression(length.expression, generator.expression),
        ),
        type: FunctionalHostTypes.bytes,
      };
    }

    if (name === "@Utf8.encode" || name === "@Utf8.decode") {
      let parameter = FunctionalHostTypes.text;
      let result = FunctionalHostTypes.bytes;
      if (name === "@Utf8.decode") {
        parameter = FunctionalHostTypes.bytes;
        result = FunctionalHostTypes.text;
      }
      const value = this.lower_expression(
        this.required_arg(args, 0, name),
        environment,
        parameter,
      );
      const field = this.runtime_intrinsic(
        "convert:" + this.type_key(parameter) + ":" + this.type_key(result),
        parameter,
        result,
        FunctionalWasmIntrinsic.BufferConvert,
        "bounded-borrow",
        "unique",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          value.expression,
        ),
        type: result,
      };
    }

    if (name === "@len") {
      const value = this.required_arg(args, 0, name);
      const lowered = this.lower_expression(value, environment);
      const argument_type = this.require_type(lowered.type, "@len argument");
      let field: RuntimeField;
      if (
        this.same_type(argument_type, FunctionalHostTypes.text) ||
        this.same_type(argument_type, FunctionalHostTypes.bytes)
      ) {
        field = this.runtime_intrinsic(
          "len:" + this.type_key(argument_type),
          argument_type,
          integer_type,
          FunctionalWasmIntrinsic.BufferByteLength,
          "bounded-borrow",
        );
      } else {
        field = this.runtime_operation(
          "len:" + this.type_key(argument_type),
          argument_type,
          integer_type,
          (argument) => {
            if (argument.kind === "array" || argument.kind === "slice") {
              return { kind: "integer", value: argument.values.length };
            }
            throw new TypeError("Duck @len received " + argument.kind);
          },
          "bounded-borrow",
        );
      }
      return {
        expression: surface.apply(
          surface.name(field.binder),
          lowered.expression,
        ),
        type: integer_type,
      };
    }

    if (name === "@append") {
      const left_arg = this.required_arg(args, 0, name);
      const right_arg = this.required_arg(args, 1, name);
      const inferred_left = this.lower_expression(left_arg, environment);
      let buffer_type: FunctionalTypeSchema;
      if (
        this.same_type(inferred_left.type, FunctionalHostTypes.text) ||
        this.same_type(inferred_left.type, FunctionalHostTypes.bytes)
      ) {
        buffer_type = this.require_type(inferred_left.type, "@append left");
      } else if (
        expected !== undefined &&
          this.same_type(expected, FunctionalHostTypes.text) ||
        expected !== undefined &&
          this.same_type(expected, FunctionalHostTypes.bytes)
      ) {
        buffer_type = this.require_type(expected, "@append result");
      } else {
        const inferred_right = this.lower_expression(right_arg, environment);
        buffer_type = this.require_buffer_type(
          inferred_right.type,
          "@append operands",
        );
      }
      const left = this.lower_expression(left_arg, environment, buffer_type);
      const right = this.lower_expression(
        right_arg,
        environment,
        buffer_type,
      );
      const parameter = this.tuple_type(
        buffer_type,
        buffer_type,
      );
      const field = this.runtime_intrinsic(
        "append:" + this.type_key(buffer_type),
        parameter,
        buffer_type,
        FunctionalWasmIntrinsic.BufferAppend,
        "bounded-borrow",
        "unique",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          this.tuple_expression(left.expression, right.expression),
        ),
        type: buffer_type,
      };
    }

    if (name === "@get") {
      const collection = this.lower_expression(
        this.required_arg(args, 0, name),
        environment,
      );
      const index = this.lower_expression(
        this.required_arg(args, 1, name),
        environment,
        integer_type,
      );
      if (
        this.same_type(collection.type, FunctionalHostTypes.text) ||
        this.same_type(collection.type, FunctionalHostTypes.bytes)
      ) {
        const buffer_type = this.require_buffer_type(
          collection.type,
          "@get input",
        );
        const parameter = this.tuple_type(
          buffer_type,
          integer_type,
        );
        const field = this.runtime_intrinsic(
          "get_byte:" + this.type_key(buffer_type),
          parameter,
          integer_type,
          FunctionalWasmIntrinsic.BufferByteGet,
          "bounded-borrow",
        );
        return {
          expression: surface.apply(
            surface.name(field.binder),
            this.tuple_expression(collection.expression, index.expression),
          ),
          type: integer_type,
        };
      }
    }

    if (name === "@slice") {
      const text = this.lower_expression(
        this.required_arg(args, 0, name),
        environment,
      );
      const buffer_type = this.require_buffer_type(text.type, "@slice input");
      const start = this.lower_expression(
        this.required_arg(args, 1, name),
        environment,
        integer_type,
      );
      const end = this.lower_expression(
        this.required_arg(args, 2, name),
        environment,
        integer_type,
      );
      const indices_type = this.tuple_type(integer_type, integer_type);
      const parameter = this.tuple_type(buffer_type, indices_type);
      const field = this.runtime_intrinsic(
        "slice:" + this.type_key(buffer_type),
        parameter,
        buffer_type,
        FunctionalWasmIntrinsic.BufferByteSlice,
        "bounded-borrow",
        "unique",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          this.tuple_expression(
            text.expression,
            this.tuple_expression(start.expression, end.expression),
          ),
        ),
        type: buffer_type,
      };
    }

    if (name === "@panic") {
      return this.runtime_trap(expected, "Duck program called @panic");
    }

    return undefined;
  }

  private lower_host_import(
    imported: AbiImport,
    args: readonly CoreExpr[],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const binder = this.#host_import_binders.get(imported.name);
    if (binder === undefined) {
      throw new Error(
        "Duck gpufuck lowering cannot bind host import " + imported.name,
      );
    }
    if (imported.params.length === 0) {
      return {
        expression: surface.name(binder),
        type: this.schema_from_abi_ref(imported.result.type),
      };
    }
    let source_args = args;
    let contracts = imported.params;
    if (imported.effect !== undefined) {
      const resource_param = imported.effect.resource_param;
      source_args = args.filter((_arg, index) => index !== resource_param);
      contracts = imported.params.filter((_param, index) =>
        index !== resource_param
      );
    }
    const lowered_args = source_args.map((arg, index) => {
      const contract = contracts[index];
      if (contract === undefined) {
        throw new Error(
          "Duck gpufuck host import " + imported.name +
            " lost argument contract",
        );
      }
      return this.lower_expression(
        arg,
        environment,
        this.schema_from_abi_ref(contract.type),
      ).expression;
    });
    return {
      expression: surface.apply(
        surface.name(binder),
        this.pack_arguments(lowered_args),
      ),
      type: this.schema_from_abi_ref(imported.result.type),
    };
  }

  private lower_primitive(
    expression: Extract<CoreExpr, { tag: "prim" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    if (
      expression.prim === "i32.lt_u" ||
      expression.prim === "i32.le_u" ||
      expression.prim === "i32.gt_u" ||
      expression.prim === "i32.ge_u"
    ) {
      const left = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
        integer_type,
      );
      const right = this.lower_expression(
        this.required_arg(expression.args, 1, expression.prim),
        environment,
        integer_type,
      );
      let operator: FunctionalBinaryOperator;
      if (expression.prim === "i32.lt_u") {
        operator = FunctionalBinaryOperator.Less;
      } else if (expression.prim === "i32.le_u") {
        operator = FunctionalBinaryOperator.LessEqual;
      } else if (expression.prim === "i32.gt_u") {
        operator = FunctionalBinaryOperator.Greater;
      } else {
        operator = FunctionalBinaryOperator.GreaterEqual;
      }
      const sign_bit = surface.integer(-2147483648);
      const compared = surface.binary(
        operator,
        surface.binary(
          FunctionalBinaryOperator.BitwiseXor,
          left.expression,
          sign_bit,
        ),
        surface.binary(
          FunctionalBinaryOperator.BitwiseXor,
          right.expression,
          sign_bit,
        ),
      );
      return {
        expression: {
          kind: "if",
          condition: compared,
          consequent: surface.integer(1),
          alternate: surface.integer(0),
        },
        type: integer_type,
      };
    }
    if (expression.prim === "f32x4.make") {
      const lanes = expression.args.map((arg) =>
        this.lower_expression(arg, environment, { kind: "float-32" })
          .expression
      );
      if (lanes.length !== 4) {
        throw new Error(
          "Duck f32x4.make expects 4 lanes, got " + lanes.length.toString(),
        );
      }
      return {
        expression: surface.apply(
          surface.name(this.struct_constructor("F32x4")),
          ...lanes,
        ),
        type: this.named_type("F32x4"),
      };
    }
    if (expression.prim === "f32x4.splat") {
      const lane = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
        { kind: "float-32" },
      );
      return {
        expression: surface.apply(
          surface.name(this.struct_constructor("F32x4")),
          lane.expression,
          lane.expression,
          lane.expression,
          lane.expression,
        ),
        type: this.named_type("F32x4"),
      };
    }
    if (
      expression.prim === "f32x4.add" ||
      expression.prim === "f32x4.sub" ||
      expression.prim === "f32x4.mul" ||
      expression.prim === "f32x4.div"
    ) {
      let operator: FunctionalBinaryOperator;
      if (expression.prim === "f32x4.add") {
        operator = FunctionalBinaryOperator.AddFloat32;
      } else if (expression.prim === "f32x4.sub") {
        operator = FunctionalBinaryOperator.SubtractFloat32;
      } else if (expression.prim === "f32x4.mul") {
        operator = FunctionalBinaryOperator.MultiplyFloat32;
      } else {
        operator = FunctionalBinaryOperator.DivideFloat32;
      }
      const left = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
        this.named_type("F32x4"),
      );
      const right = this.lower_expression(
        this.required_arg(expression.args, 1, expression.prim),
        environment,
        this.named_type("F32x4"),
      );
      const left_binders = [0, 1, 2, 3].map((index) =>
        this.temporary("leftLane" + index.toString())
      );
      const right_binders = [0, 1, 2, 3].map((index) =>
        this.temporary("rightLane" + index.toString())
      );
      const lanes = left_binders.map((left_binder, index) => {
        const right_binder = right_binders[index];
        if (right_binder === undefined) {
          throw new Error(
            "Duck gpufuck lowering lost f32x4 lane " + index.toString(),
          );
        }
        return surface.binary(
          operator,
          surface.name(left_binder),
          surface.name(right_binder),
        );
      });
      return {
        expression: {
          kind: "case",
          value: left.expression,
          arms: [{
            constructor: this.struct_constructor("F32x4"),
            binders: left_binders,
            body: {
              kind: "case",
              value: right.expression,
              arms: [{
                constructor: this.struct_constructor("F32x4"),
                binders: right_binders,
                body: surface.apply(
                  surface.name(this.struct_constructor("F32x4")),
                  ...lanes,
                ),
              }],
            },
          }],
        },
        type: this.named_type("F32x4"),
      };
    }
    if (
      expression.prim === "f32x4.extract_lane" ||
      expression.prim === "f32x4.replace_lane"
    ) {
      const vector = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
        this.named_type("F32x4"),
      );
      const lane = this.required_arg(expression.args, 1, expression.prim);
      if (
        lane.tag !== "num" || lane.type !== "i32" ||
        typeof lane.value !== "number" || !Number.isInteger(lane.value) ||
        lane.value < 0 || lane.value > 3
      ) {
        throw new Error(
          "Duck " + expression.prim + " requires a lane from 0 through 3",
        );
      }
      const binders = [0, 1, 2, 3].map((index) =>
        this.temporary("lane" + index.toString())
      );
      const selected = binders[lane.value];
      if (selected === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost f32x4 lane " + lane.value.toString(),
        );
      }
      if (expression.prim === "f32x4.extract_lane") {
        return {
          expression: {
            kind: "case",
            value: vector.expression,
            arms: [{
              constructor: this.struct_constructor("F32x4"),
              binders,
              body: surface.name(selected),
            }],
          },
          type: { kind: "float-32" },
        };
      }
      const replacement = this.lower_expression(
        this.required_arg(expression.args, 2, expression.prim),
        environment,
        { kind: "float-32" },
      );
      const lanes = binders.map((binder, index) => {
        if (index === lane.value) {
          return replacement.expression;
        }
        return surface.name(binder);
      });
      return {
        expression: {
          kind: "case",
          value: vector.expression,
          arms: [{
            constructor: this.struct_constructor("F32x4"),
            binders,
            body: surface.apply(
              surface.name(this.struct_constructor("F32x4")),
              ...lanes,
            ),
          }],
        },
        type: this.named_type("F32x4"),
      };
    }
    if (expression.prim === "i32.eq" || expression.prim === "i32.ne") {
      const left = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
      );
      const right = this.lower_expression(
        this.required_arg(expression.args, 1, expression.prim),
        environment,
        left.type,
      );
      if (
        this.same_type(left.type, FunctionalHostTypes.text) ||
        this.same_type(left.type, FunctionalHostTypes.bytes)
      ) {
        const operand_type = this.require_type(
          left.type,
          "buffer equality operand",
        );
        const field = this.runtime_intrinsic(
          "equal:" + this.type_key(operand_type),
          this.tuple_type(operand_type, operand_type),
          { kind: "boolean" },
          FunctionalWasmIntrinsic.BufferEqual,
          "bounded-borrow",
        );
        let compared: FunctionalSurfaceExpression = surface.apply(
          surface.name(field.binder),
          this.tuple_expression(left.expression, right.expression),
        );
        if (expression.prim === "i32.ne") {
          compared = {
            kind: "if",
            condition: compared,
            consequent: surface.boolean(false),
            alternate: surface.boolean(true),
          };
        }
        return {
          expression: {
            kind: "if",
            condition: compared,
            consequent: surface.integer(1),
            alternate: surface.integer(0),
          },
          type: integer_type,
        };
      }
    }
    const unary = this.unary_primitive(expression.prim);
    if (unary !== undefined) {
      const value = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
      );
      return {
        expression: surface.unary(unary.operator, value.expression),
        type: unary.result,
      };
    }
    const conversion = this.conversion_primitive(expression.prim);
    if (conversion !== undefined) {
      const value = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
      );
      return {
        expression: surface.convert(conversion.conversion, value.expression),
        type: conversion.result,
      };
    }
    const binary = lower_binary_primitive(expression.prim);
    if (binary !== undefined) {
      const left = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
      );
      const right = this.lower_expression(
        this.required_arg(expression.args, 1, expression.prim),
        environment,
      );
      const operation = surface.binary(
        binary.operator,
        left.expression,
        right.expression,
      );
      if (binary.result.kind === "boolean") {
        return {
          expression: {
            kind: "if",
            condition: operation,
            consequent: surface.integer(1),
            alternate: surface.integer(0),
          },
          type: integer_type,
        };
      }
      return { expression: operation, type: binary.result };
    }
    if (expression.prim.endsWith(".select")) {
      const consequent = this.lower_expression(
        this.required_arg(expression.args, 0, expression.prim),
        environment,
      );
      const alternate = this.lower_expression(
        this.required_arg(expression.args, 1, expression.prim),
        environment,
        consequent.type,
      );
      const condition = this.lower_condition(
        this.required_arg(expression.args, 2, expression.prim),
        environment,
      );
      return {
        expression: {
          kind: "if",
          condition: condition.expression,
          consequent: consequent.expression,
          alternate: alternate.expression,
        },
        type: consequent.type,
      };
    }
    if (expression.prim.endsWith(".trap")) {
      return this.runtime_trap(
        this.type_from_primitive_prefix(expression.prim),
        expression.prim,
      );
    }
    throw new Error(
      "Duck gpufuck lowering does not support primitive " + expression.prim,
    );
  }

  private lower_struct_value(
    expression: Extract<CoreExpr, { tag: "struct_value" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected: FunctionalTypeSchema | undefined,
  ): LoweredExpression {
    if (expected !== undefined) {
      const resolved_expected = this.resolve_type_alias(expected);
      const field_types: FunctionalTypeSchema[] = [];
      let remaining_type = resolved_expected;

      while (remaining_type.kind === "tuple") {
        field_types.push(remaining_type.values[0]);
        remaining_type = remaining_type.values[1];
      }
      field_types.push(remaining_type);

      if (
        resolved_expected.kind === "tuple" &&
        field_types.length === expression.fields.length
      ) {
        const values = expression.fields.map((field, index) => {
          const field_type = field_types[index];
          expect(
            field_type,
            "Missing Duck tuple field type " + index.toString(),
          );
          return this.lower_expression(field.value, environment, field_type)
            .expression;
        });
        let value = values.at(-1);
        expect(value, "Duck tuple value requires at least two fields");

        for (let index = values.length - 2; index >= 0; index -= 1) {
          const field = values[index];
          expect(field, "Missing Duck tuple field " + index.toString());
          value = this.tuple_expression(field, value);
        }

        return { expression: value, type: resolved_expected };
      }
    }

    let name: string | undefined;
    if (expected !== undefined) {
      const resolved_expected = this.resolve_type_alias(expected);
      if (resolved_expected.kind === "named") {
        const expected_name = source_type_name_from_schema(resolved_expected);
        this.materialize_type_definition(expected_name);
        const expected_definition = this.#types.get(expected_name);
        if (
          expected_definition?.shape === "struct" &&
          expected_definition.fields.length === expression.fields.length
        ) {
          name = expected_name;
        }
      }
    }
    if (name === undefined && expression.type_expr.tag !== "struct_type") {
      name = this.type_expression_name(expression.type_expr);
      this.materialize_type_definition(name);
    }
    if (name === "object_type") {
      name = undefined;
    }
    const anonymous_name = "$DuckObject:" +
      expression.fields.map((field) => field.name).join(",");
    if (name === undefined) {
      name = anonymous_name;
    }
    let definition = this.#types.get(name);
    if (definition === undefined) {
      name = "$DuckObject:" +
        expression.fields.map((field) => field.name).join(",");
      definition = this.#types.get(name);
      if (definition === undefined) {
        const lowered_fields = expression.fields.map((field) =>
          this.lower_expression(field.value, environment)
        );
        definition = {
          name,
          shape: "struct",
          fields: expression.fields.map((field, index) => {
            const lowered = lowered_fields[index];
            if (lowered === undefined) {
              throw new Error(
                "Duck gpufuck lowering lost anonymous field " + field.name,
              );
            }
            const field_type = lowered.type;
            if (
              field_type === undefined || contains_type_parameter(field_type)
            ) {
              throw new Error(
                "Duck gpufuck lowering cannot infer anonymous field " +
                  field.name,
              );
            }
            return { name: field.name, type: field_type };
          }),
          cases: [],
        };
        this.#types.set(name, definition);
      }
    }
    if (definition.shape !== "struct") {
      throw new Error(
        "Duck gpufuck lowering cannot use non-struct type " + name,
      );
    }
    const values = definition.fields.map((declared) => {
      const field = expression.fields.find((candidate) =>
        candidate.name === declared.name
      );
      if (field === undefined) {
        throw new Error(
          "Duck struct " + name + " omits field " + declared.name,
        );
      }
      return this.lower_expression(field.value, environment, declared.type)
        .expression;
    });
    return {
      expression: surface.apply(
        surface.name(this.struct_constructor(name)),
        ...values,
      ),
      type: this.named_type(name),
    };
  }

  private lower_extension(
    expression: Extract<CoreExpr, { tag: "with" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const name = "$DuckObject:" +
      expression.fields.map((field) => field.name).join(",");
    const lowered_fields = expression.fields.map((field) =>
      this.lower_expression(field.value, environment)
    );
    let definition = this.#types.get(name);
    if (definition === undefined) {
      definition = {
        name,
        shape: "struct",
        fields: expression.fields.map((field, index) => {
          const lowered = lowered_fields[index];
          if (lowered === undefined) {
            throw new Error(
              "Duck gpufuck lowering lost extension field " + field.name,
            );
          }
          return {
            name: field.name,
            type: this.require_type(
              lowered.type,
              "extension field " + field.name,
            ),
          };
        }),
        cases: [],
      };
      this.#types.set(name, definition);
    }
    return {
      expression: surface.apply(
        surface.name(this.struct_constructor(name)),
        ...lowered_fields.map((field) => field.expression),
      ),
      type: this.named_type(name),
    };
  }

  private lower_field(
    object: CoreExpr,
    field_name: string,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    if (object.tag === "union_type") {
      for (const definition of this.#types.values()) {
        if (
          definition.shape !== "union" ||
          definition.cases.length !== object.cases.length
        ) {
          continue;
        }
        let matches = true;
        for (let index = 0; index < object.cases.length; index += 1) {
          const source_case = object.cases[index];
          const declared_case = definition.cases[index];
          if (
            source_case === undefined || declared_case === undefined ||
            source_case.name !== declared_case.name ||
            !this.same_type(
              this.schema_from_type_name(source_case.type_name),
              declared_case.type,
            )
          ) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
        const union_case = definition.cases.find((candidate) =>
          candidate.name === field_name
        );
        if (union_case !== undefined) {
          return {
            expression: surface.name(
              this.union_constructor(definition.name, field_name),
            ),
            type: {
              kind: "function",
              parameter: union_case.type,
              result: this.named_type(definition.name),
            },
          };
        }
      }
    }
    if (
      object.tag === "var" &&
      (this.#types.has(object.name) || this.#type_aliases.has(object.name))
    ) {
      const object_name = this.type_expression_name(object);
      const definition = this.require_definition(object_name);
      const union_case = definition.cases.find((candidate) =>
        candidate.name === field_name
      );
      if (union_case !== undefined) {
        return {
          expression: surface.name(
            this.union_constructor(object_name, field_name),
          ),
          type: {
            kind: "function",
            parameter: union_case.type,
            result: this.named_type(object_name),
          },
        };
      }
    }
    const lowered_object = this.lower_expression(object, environment);
    const name = this.named_type_name(
      lowered_object.type,
      "field " + field_name,
    );
    const definition = this.require_definition(name);
    const field_index = definition.fields.findIndex((field) =>
      field.name === field_name
    );
    if (field_index < 0) {
      throw new Error(
        "Duck type " + name + " does not contain field " + field_name,
      );
    }
    const binders = definition.fields.map((field) =>
      this.temporary(field.name)
    );
    const field = definition.fields[field_index];
    const binder = binders[field_index];
    if (field === undefined || binder === undefined) {
      throw new Error(
        "Duck gpufuck lowering lost field " + field_name + " of " + name,
      );
    }
    return {
      expression: {
        kind: "case",
        value: lowered_object.expression,
        arms: [{
          constructor: this.struct_constructor(name),
          binders,
          body: surface.name(binder),
        }],
      },
      type: field.type,
    };
  }

  private lower_index(
    object: CoreExpr,
    index: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const lowered_object = this.lower_expression(object, environment);
    if (
      this.same_type(lowered_object.type, FunctionalHostTypes.text) ||
      this.same_type(lowered_object.type, FunctionalHostTypes.bytes)
    ) {
      const lowered_index = this.lower_expression(
        index,
        environment,
        integer_type,
      );
      const collection_type = this.require_type(
        lowered_object.type,
        "buffer index",
      );
      const field = this.runtime_intrinsic(
        "get_byte:" + this.type_key(collection_type),
        this.tuple_type(collection_type, integer_type),
        integer_type,
        FunctionalWasmIntrinsic.BufferByteGet,
        "bounded-borrow",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          this.tuple_expression(
            lowered_object.expression,
            lowered_index.expression,
          ),
        ),
        type: integer_type,
      };
    }
    if (lowered_object.type?.kind === "tuple") {
      if (
        index.tag !== "num" || index.type !== "i32" ||
        typeof index.value !== "number" || !Number.isInteger(index.value) ||
        index.value < 0
      ) {
        throw new Error("Duck gpufuck tuple index must be a nonnegative I32");
      }

      let selected = lowered_object.expression;
      let selected_type: FunctionalTypeSchema = lowered_object.type;
      let remaining_index = index.value;

      while (selected_type.kind === "tuple") {
        const first = this.temporary("tuple_first");
        const rest = this.temporary("tuple_rest");
        if (remaining_index === 0) {
          return {
            expression: {
              kind: "case",
              value: selected,
              arms: [{
                constructor: "$Tuple",
                binders: [first, rest],
                body: surface.name(first),
              }],
            },
            type: selected_type.values[0],
          };
        }

        selected = {
          kind: "case",
          value: selected,
          arms: [{
            constructor: "$Tuple",
            binders: [first, rest],
            body: surface.name(rest),
          }],
        };
        selected_type = selected_type.values[1];
        remaining_index -= 1;
      }

      if (remaining_index === 0) {
        return { expression: selected, type: selected_type };
      }
      throw new Error(
        "Duck gpufuck tuple index " + index.value.toString() +
          " is outside its product",
      );
    }
    const name = this.named_type_name(
      lowered_object.type,
      "indexed value " + JSON.stringify(object),
    );
    const definition = this.require_definition(name);
    if (definition.fields.length === 0) {
      throw new Error("Duck gpufuck indexed type has no fields: " + name);
    }
    if (
      index.tag === "num" && index.type === "i32" &&
      typeof index.value === "number" && Number.isInteger(index.value)
    ) {
      const field = definition.fields[index.value];
      if (field === undefined) {
        throw new Error(
          "Duck gpufuck index " + index.value.toString() + " is outside " +
            name + " with " + definition.fields.length.toString() +
            " fields",
        );
      }
      const binders = definition.fields.map((candidate) =>
        this.temporary(candidate.name)
      );
      const binder = binders[index.value];
      if (binder === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost field " + index.value.toString() +
            " of " + name,
        );
      }
      return {
        expression: {
          kind: "case",
          value: lowered_object.expression,
          arms: [{
            constructor: this.struct_constructor(name),
            binders,
            body: surface.name(binder),
          }],
        },
        type: field.type,
      };
    }
    const lowered_index = this.lower_expression(
      index,
      environment,
      integer_type,
    );
    const binders = definition.fields.map((field) =>
      this.temporary(field.name)
    );
    const field_type = definition.fields[0]?.type;
    for (const field of definition.fields.slice(1)) {
      if (!this.same_type(field_type, field.type)) {
        throw new Error(
          "Duck gpufuck dynamic index requires uniform fields in " + name,
        );
      }
    }
    const selected = this.index_selection(
      binders,
      lowered_index.expression,
      field_type,
    );
    return {
      expression: {
        kind: "case",
        value: lowered_object.expression,
        arms: [{
          constructor: this.struct_constructor(name),
          binders,
          body: selected,
        }],
      },
      type: field_type,
    };
  }

  private lower_index_update(
    object: FunctionalSurfaceExpression,
    object_type: FunctionalTypeSchema,
    index: CoreExpr,
    value: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    if (this.same_type(object_type, FunctionalHostTypes.bytes)) {
      const lowered_index = this.lower_expression(
        index,
        environment,
        integer_type,
      );
      const lowered_value = this.lower_expression(
        value,
        environment,
        integer_type,
      );
      const index_and_value = this.tuple_type(integer_type, integer_type);
      const parameter = this.tuple_type(
        FunctionalHostTypes.bytes,
        index_and_value,
      );
      const field = this.runtime_operation(
        "set_byte:bytes",
        parameter,
        FunctionalHostTypes.bytes,
        (argument) => {
          const [buffer, update] = this.tuple_values(
            argument,
            "Bytes.set argument",
          );
          const [byte_index, byte_value] = this.tuple_values(
            update,
            "Bytes.set update",
          );
          if (buffer.kind !== "bytes") {
            throw new TypeError(
              "Duck Bytes.set expected Bytes, found " + buffer.kind,
            );
          }
          if (byte_index.kind !== "integer") {
            throw new TypeError(
              "Duck Bytes.set index expected I32, found " + byte_index.kind,
            );
          }
          if (byte_value.kind !== "integer") {
            throw new TypeError(
              "Duck Bytes.set value expected I32, found " + byte_value.kind,
            );
          }
          if (
            byte_index.value < 0 || byte_index.value >= buffer.value.length
          ) {
            throw new RangeError(
              "Duck Bytes.set index " + byte_index.value.toString() +
                " is outside length " + buffer.value.length.toString(),
            );
          }
          const updated = buffer.value.slice();
          updated[byte_index.value] = byte_value.value;
          return { kind: "bytes", value: updated };
        },
        "bounded-borrow",
        "unique",
      );
      return {
        expression: surface.apply(
          surface.name(field.binder),
          this.tuple_expression(
            object,
            this.tuple_expression(
              lowered_index.expression,
              lowered_value.expression,
            ),
          ),
        ),
        type: FunctionalHostTypes.bytes,
      };
    }
    const name = this.named_type_name(object_type, "indexed assignment");
    const definition = this.require_definition(name);
    const lowered_index = this.lower_expression(
      index,
      environment,
      integer_type,
    );
    const field_type = definition.fields[0]?.type;
    const lowered_value = this.lower_expression(value, environment, field_type);
    const binders = definition.fields.map((field) =>
      this.temporary(field.name)
    );
    const fields = binders.map((binder, field_index) => ({
      kind: "if" as const,
      condition: surface.binary(
        FunctionalBinaryOperator.Equal,
        lowered_index.expression,
        surface.integer(field_index),
      ),
      consequent: lowered_value.expression,
      alternate: surface.name(binder),
    }));
    return {
      expression: {
        kind: "case",
        value: object,
        arms: [{
          constructor: this.struct_constructor(name),
          binders,
          body: surface.apply(
            surface.name(this.struct_constructor(name)),
            ...fields,
          ),
        }],
      },
      type: object_type,
    };
  }

  private lower_struct_update(
    expression: Extract<CoreExpr, { tag: "struct_update" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const base = this.lower_expression(expression.base, environment);
    const name = this.named_type_name(base.type, "struct update");
    const definition = this.require_definition(name);
    const binders = definition.fields.map((field) =>
      this.temporary(field.name)
    );
    const fields = definition.fields.map((declared, index) => {
      const replacement = expression.fields.find((field) =>
        field.name === declared.name
      );
      if (replacement !== undefined) {
        return this.lower_expression(
          replacement.value,
          environment,
          declared.type,
        ).expression;
      }
      const binder = binders[index];
      if (binder === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost struct update field " + declared.name,
        );
      }
      return surface.name(binder);
    });
    return {
      expression: {
        kind: "case",
        value: base.expression,
        arms: [{
          constructor: this.struct_constructor(name),
          binders,
          body: surface.apply(
            surface.name(this.struct_constructor(name)),
            ...fields,
          ),
        }],
      },
      type: base.type,
    };
  }

  private lower_union_case(
    expression: Extract<CoreExpr, { tag: "union_case" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression {
    let name: string;
    if (expression.type_expr !== undefined) {
      name = this.type_expression_name(expression.type_expr);
      if (expected?.kind === "named") {
        const expected_name = source_type_name_from_schema(expected);
        const expected_application = source_type_application(expected_name);
        if (expected_application?.name === name) {
          name = expected_name;
        }
      }
    } else if (expected?.kind === "named") {
      name = source_type_name_from_schema(expected);
    } else {
      let payload_type: FunctionalTypeSchema | undefined;
      if (expression.value !== undefined) {
        payload_type = this.simple_expression_type(
          expression.value,
          environment,
        );
      } else {
        payload_type = unit_type;
      }
      const candidates: string[] = [];
      if (payload_type !== undefined) {
        for (const definition of this.#types.values()) {
          if (definition.shape !== "union") {
            continue;
          }
          const matching_case = definition.cases.find((candidate) =>
            candidate.name === expression.name &&
            this.same_type(candidate.type, payload_type)
          );
          if (matching_case !== undefined) {
            const resolved = this.resolve_type_alias(
              this.named_type(definition.name),
            );
            let candidate_name = definition.name;
            if (resolved.kind === "named") {
              candidate_name = source_type_name_from_schema(resolved);
            }
            if (!candidates.includes(candidate_name)) {
              candidates.push(candidate_name);
            }
          }
        }
      }
      if (candidates.length !== 1) {
        let payload_description = "unknown";
        if (payload_type !== undefined) {
          payload_description = this.type_key(payload_type);
        }
        throw new Error(
          "Duck gpufuck lowering cannot infer union type for case " +
            expression.name + " with payload " + payload_description +
            "; matching payload candidates: " +
            candidates.join(", ") + "; expression: " +
            JSON.stringify(expression),
        );
      }
      const inferred_name = candidates[0];
      if (inferred_name === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost inferred union for case " +
            expression.name,
        );
      }
      name = inferred_name;
    }
    const definition = this.require_definition(name);
    const union_case = definition.cases.find((candidate) =>
      candidate.name === expression.name
    );
    if (union_case === undefined) {
      throw new Error(
        "Duck union " + name + " does not contain case " + expression.name,
      );
    }
    const args: FunctionalSurfaceExpression[] = [];
    if (expression.value !== undefined) {
      args.push(
        this.lower_expression(expression.value, environment, union_case.type)
          .expression,
      );
    } else if (union_case.type.kind === "unit") {
      args.push(surface.name("$Unit"));
    }
    return {
      expression: surface.apply(
        surface.name(this.union_constructor(name, expression.name)),
        ...args,
      ),
      type: this.named_type(name),
    };
  }

  private lower_if_let(
    expression: Extract<CoreExpr, { tag: "if_let" }>,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression {
    const target = this.lower_expression(expression.target, environment);
    const name = this.named_type_name(
      target.type,
      "if let " + expression.case_name,
    );
    const definition = this.require_definition(name);
    const selected = definition.cases.find((candidate) =>
      candidate.name === expression.case_name
    );
    if (selected === undefined) {
      throw new Error(
        "Duck union " + name + " does not contain case " + expression.case_name,
      );
    }
    const selected_environment = new Map(environment);
    let selected_binder = this.temporary(selected.name);
    if (expression.value_name !== undefined) {
      selected_environment.set(expression.value_name, selected.type);
      selected_binder = expression.value_name;
    }
    const selected_branch = this.lower_expression(
      expression.then_branch,
      selected_environment,
      expected,
    );
    const other_branch = this.lower_expression(
      expression.else_branch,
      environment,
      selected_branch.type,
    );
    const result_type = selected_branch.type;
    let fallback_name: string | undefined;
    let fallback_parameter: string | undefined;
    if (definition.cases.length > 2) {
      fallback_name = this.temporary("if_let_fallback");
      fallback_parameter = this.temporary("if_let_unit");
    }
    const arms: FunctionalSurfaceCaseArm[] = [];
    for (const union_case of definition.cases) {
      let binder = this.temporary(union_case.name);
      if (union_case.name === expression.case_name) {
        binder = selected_binder;
        arms.push({
          constructor: this.union_constructor(name, union_case.name),
          binders: [binder],
          body: selected_branch.expression,
        });
      } else {
        let body = other_branch.expression;
        if (fallback_name !== undefined) {
          body = surface.apply(
            surface.name(fallback_name),
            surface.name("$Unit"),
          );
        }
        arms.push({
          constructor: this.union_constructor(name, union_case.name),
          binders: [binder],
          body,
        });
      }
    }
    const matched: FunctionalSurfaceExpression = {
      kind: "case",
      value: target.expression,
      arms,
    };
    if (fallback_name !== undefined && fallback_parameter !== undefined) {
      return {
        expression: {
          kind: "let",
          name: fallback_name,
          value: surface.lambda(
            fallback_parameter,
            other_branch.expression,
          ),
          body: matched,
        },
        type: result_type,
      };
    }
    return {
      expression: matched,
      type: result_type,
    };
  }

  private lower_static_type_call(
    type_name: string,
    member: string,
    args: readonly CoreExpr[],
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const definition = this.require_definition(type_name);
    const union_case = definition.cases.find((candidate) =>
      candidate.name === member
    );
    if (union_case !== undefined) {
      let value: FunctionalSurfaceExpression;
      if (this.same_type(union_case.type, unit_type) && args.length === 0) {
        value = surface.name("$Unit");
      } else {
        value = this.lower_expression(
          this.required_arg(args, 0, type_name + "." + member),
          environment,
          union_case.type,
        ).expression;
      }
      return {
        expression: surface.apply(
          surface.name(this.union_constructor(type_name, member)),
          value,
        ),
        type: this.named_type(type_name),
      };
    }
    const field = definition.fields.find((candidate) =>
      candidate.name === member
    );
    if (field !== undefined) {
      const value = this.required_arg(args, 0, type_name + "." + member);
      return this.lower_field(value, member, environment);
    }
    throw new Error("Duck type " + type_name + " has no member " + member);
  }

  private lower_text_literal(
    value: string,
    expected?: FunctionalTypeSchema,
  ): LoweredExpression {
    if (this.same_type(expected, FunctionalHostTypes.bytes)) {
      return {
        expression: surface.bytes(new TextEncoder().encode(value)),
        type: FunctionalHostTypes.bytes,
      };
    }
    return {
      expression: surface.text(value),
      type: FunctionalHostTypes.text,
    };
  }

  private runtime_operation(
    key: string,
    parameter: FunctionalHostType,
    result: FunctionalHostType,
    operation: (argument: FunctionalWasmHostValue) => FunctionalWasmHostValue,
    parameter_ownership?: "bounded-borrow" | "ownership-transfer",
    result_ownership?: "frozen-shareable" | "ownership-transfer" | "unique",
  ): RuntimeField {
    const existing = this.#runtime_fields.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const binder = this.host_binder(duck_runtime_capability, key);
    const ownership: {
      parameterOwnership?: "bounded-borrow" | "ownership-transfer";
      resultOwnership?: "frozen-shareable" | "ownership-transfer" | "unique";
    } = {};
    if (parameter_ownership !== undefined) {
      ownership.parameterOwnership = parameter_ownership;
    }
    if (result_ownership !== undefined) {
      ownership.resultOwnership = result_ownership;
    }
    const declaration: FunctionalHostCapabilityDeclaration["fields"][number] = {
      kind: "operation",
      name: key,
      purity: "pure",
      parameter,
      result,
      ...ownership,
    };
    const field = { declaration, binder };
    this.#runtime_fields.set(key, field);
    this.#automatic_runtime_bindings[key] = operation;
    return field;
  }

  private runtime_intrinsic(
    key: string,
    parameter: FunctionalHostType,
    result: FunctionalHostType,
    wasm_intrinsic: FunctionalWasmIntrinsic,
    parameter_ownership?: "bounded-borrow" | "ownership-transfer",
    result_ownership?: "frozen-shareable" | "ownership-transfer" | "unique",
  ): RuntimeField {
    const existing = this.#runtime_fields.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const binder = this.host_binder(duck_runtime_capability, key);
    const ownership: {
      parameterOwnership?: "bounded-borrow" | "ownership-transfer";
      resultOwnership?: "frozen-shareable" | "ownership-transfer" | "unique";
    } = {};
    if (parameter_ownership !== undefined) {
      ownership.parameterOwnership = parameter_ownership;
    }
    if (result_ownership !== undefined) {
      ownership.resultOwnership = result_ownership;
    }
    const declaration: FunctionalHostCapabilityDeclaration["fields"][number] = {
      kind: "operation",
      name: key,
      purity: "pure",
      parameter,
      result,
      wasmIntrinsic: wasm_intrinsic,
      ...ownership,
    };
    const field = { declaration, binder };
    this.#runtime_fields.set(key, field);
    return field;
  }

  private runtime_trap(
    expected: FunctionalTypeSchema | undefined,
    message: string,
  ): LoweredExpression {
    const result = this.require_type(expected, "trap result");
    const field = this.runtime_operation(
      "trap:" + this.type_key(result) + ":" +
        this.#runtime_fields.size.toString(),
      unit_type,
      result,
      () => {
        throw new Error(message);
      },
    );
    return {
      expression: surface.apply(
        surface.name(field.binder),
        surface.name("$Unit"),
      ),
      type: result,
    };
  }

  private runtime_capability():
    | FunctionalHostCapabilityDeclaration
    | undefined {
    if (this.#runtime_fields.size === 0) {
      return undefined;
    }
    return {
      name: duck_runtime_capability,
      fields: [...this.#runtime_fields.values()].map((field) =>
        field.declaration
      ),
    };
  }

  private host_definitions(): {
    definitions: FunctionalSurfaceDefinition[];
    bindings: FunctionalHostDefinitionBinding[];
  } {
    const definitions: FunctionalSurfaceDefinition[] = [];
    const bindings: FunctionalHostDefinitionBinding[] = [];

    for (const capability of this.#host_capabilities) {
      for (const field of capability.fields) {
        const definition = this.host_binder(capability.name, field.name);
        let annotation: FunctionalTypeSchema;

        if (field.kind === "value") {
          annotation = field.type;
        } else {
          annotation = {
            kind: "function",
            parameter: field.parameter,
            result: field.result,
          };
        }

        definitions.push({
          name: definition,
          parameters: [],
          annotation,
          body: {
            kind: "runtime-fault",
            message: "Unbound Duck host field " + capability.name + "." +
              field.name,
          },
        });
        bindings.push({
          definition,
          capability: capability.name,
          field: field.name,
        });
      }
    }

    return { definitions, bindings };
  }

  private functional_type_declarations(): FunctionalSurfaceTypeDeclaration[] {
    return [...this.#types.values()].flatMap((definition) => {
      const member_types = [
        ...definition.fields.map((field) => field.type),
        ...definition.cases.map((union_case) => union_case.type),
      ];
      if (
        member_types.some((type) =>
          contains_type_parameter(type) ||
          this.contains_unapplied_type_constructor(type)
        )
      ) {
        return [];
      }
      if (definition.shape === "union") {
        return [{
          name: definition.name,
          parameters: [],
          constructors: definition.cases.map((union_case) => ({
            name: this.union_constructor(definition.name, union_case.name),
            fields: [{ name: "value", type: union_case.type }],
          })),
        }];
      }
      return [{
        name: definition.name,
        parameters: [],
        constructors: [{
          name: this.struct_constructor(definition.name),
          fields: definition.fields,
        }],
      }];
    });
  }

  private schema_from_abi_ref(type: AbiTypeRef): FunctionalTypeSchema {
    switch (type.tag) {
      case "i32":
        return integer_type;
      case "i64":
        return { kind: "signed-integer-64" };
      case "f32":
        return { kind: "float-32" };
      case "f64":
        return { kind: "float-64" };
      case "unit":
        return unit_type;
      case "text":
        return FunctionalHostTypes.text;
      case "bytes":
        return FunctionalHostTypes.bytes;
      case "i32_slice":
        return FunctionalHostTypes.slice(integer_type);
      case "text_slice":
        return FunctionalHostTypes.slice(FunctionalHostTypes.text);
      case "resource":
        return FunctionalHostTypes.resource(type.effect);
      case "named":
        return this.schema_from_type_name(type.name);
    }
  }

  private schema_from_optional_type_name(
    name: string | undefined,
  ): FunctionalTypeSchema | undefined {
    if (name === undefined) {
      return undefined;
    }
    return this.schema_from_type_name(name);
  }

  private schema_from_type_name(name: string): FunctionalTypeSchema {
    while (
      name.startsWith("&") || name.startsWith("#") || name.startsWith("!")
    ) {
      name = name.slice(1);
    }
    const resolved_type = this.resolve_type_expr_aliases(
      parse_type_expr(tokenize(name)),
      new Set(),
    );
    const canonical_name = format_type_expr(resolved_type);
    if (canonical_name !== name) {
      return this.schema_from_type_name(canonical_name);
    }
    if (resolved_type.tag === "arrow") {
      return {
        kind: "function",
        parameter: this.schema_from_type_name(
          format_type_expr(resolved_type.param),
        ),
        result: this.schema_from_type_name(
          format_type_expr(resolved_type.result),
        ),
      };
    }
    if (resolved_type.tag === "literal") {
      if (resolved_type.value.tag === "bool") {
        return integer_type;
      }
      if (resolved_type.value.tag === "text") {
        return FunctionalHostTypes.text;
      }
      if (resolved_type.value.type === "i32") {
        return integer_type;
      }
      if (resolved_type.value.type === "i64") {
        return { kind: "signed-integer-64" };
      }
      if (resolved_type.value.type === "f32") {
        return { kind: "float-32" };
      }
      return { kind: "float-64" };
    }
    if (resolved_type.tag === "product") {
      if (resolved_type.entries.length === 0) {
        return unit_type;
      }

      const final_entry = resolved_type.entries.at(-1);
      expect(final_entry, "Missing final Duck product type entry");
      let result = this.schema_from_type_name(
        format_type_expr(final_entry.type_expr),
      );

      for (
        let index = resolved_type.entries.length - 2;
        index >= 0;
        index -= 1
      ) {
        const entry = resolved_type.entries[index];
        expect(entry, "Missing Duck product type entry " + index);
        result = this.tuple_type(
          this.schema_from_type_name(format_type_expr(entry.type_expr)),
          result,
        );
      }

      return result;
    }
    if (resolved_type.tag === "apply") {
      const application = source_type_application(canonical_name);
      expect(
        application,
        "Missing Duck applied type structure for " + canonical_name,
      );
      let specialized_type: TypeExpr = {
        tag: "name",
        name: application.name,
      };

      for (const argument of application.args) {
        specialized_type = {
          tag: "apply",
          func: specialized_type,
          arg: parse_type_expr(tokenize(source_type_name_from_schema(
            this.schema_from_type_name(format_type_expr(argument)),
          ))),
        };
      }

      const specialized_name = format_type_expr(specialized_type);
      this.materialize_type_definition(specialized_name);
      return this.named_type(specialized_name);
    }
    if (name === "Char" || name === "Int" || name === "I32") {
      return integer_type;
    }
    if (name === "Bool") {
      return integer_type;
    }
    if (name === "I64") {
      return { kind: "signed-integer-64" };
    }
    if (name === "F32") {
      return { kind: "float-32" };
    }
    if (name === "F64") {
      return { kind: "float-64" };
    }
    if (name === "Unit") {
      return unit_type;
    }
    if (name === "Text") {
      return FunctionalHostTypes.text;
    }
    if (name === "Bytes") {
      return FunctionalHostTypes.bytes;
    }
    if (this.#types.has(name) || this.#type_aliases.has(name)) {
      this.materialize_type_definition(name);
      return this.named_type(name);
    }
    if (/^[a-z_][A-Za-z0-9_]*$/.test(name)) {
      const substitutions = this.#specialized_type_parameters[
        this.#specialized_type_parameters.length - 1
      ];
      const specialized = substitutions?.get(name);
      if (specialized !== undefined) {
        return specialized;
      }
      return { kind: "parameter", name };
    }
    this.materialize_type_definition(name);
    return this.named_type(name);
  }

  private resolve_type_expr_aliases(
    type: TypeExpr,
    resolving: ReadonlySet<string>,
  ): TypeExpr {
    if (type.tag === "name") {
      const alias = this.#type_aliases.get(type.name);
      if (alias === undefined) {
        return type;
      }
      if (resolving.has(type.name)) {
        throw new Error("Duck type alias cycle includes " + type.name);
      }
      const next_resolving = new Set(resolving);
      next_resolving.add(type.name);
      return this.resolve_type_expr_aliases(
        parse_type_expr(tokenize(alias)),
        next_resolving,
      );
    }
    if (
      type.tag === "atom" || type.tag === "literal" ||
      type.tag === "top" || type.tag === "never"
    ) {
      return type;
    }
    if (type.tag === "forall") {
      return {
        ...type,
        body: this.resolve_type_expr_aliases(type.body, resolving),
      };
    }
    if (type.tag === "frozen" || type.tag === "borrow") {
      return {
        ...type,
        value: this.resolve_type_expr_aliases(type.value, resolving),
      };
    }
    if (
      type.tag === "union" || type.tag === "intersection" ||
      type.tag === "difference"
    ) {
      return {
        ...type,
        left: this.resolve_type_expr_aliases(type.left, resolving),
        right: this.resolve_type_expr_aliases(type.right, resolving),
      };
    }
    if (type.tag === "apply") {
      return {
        ...type,
        func: this.resolve_type_expr_aliases(type.func, resolving),
        arg: this.resolve_type_expr_aliases(type.arg, resolving),
      };
    }
    if (type.tag === "tuple") {
      return {
        ...type,
        items: type.items.map((item) =>
          this.resolve_type_expr_aliases(item, resolving)
        ),
      };
    }
    if (type.tag === "product") {
      return {
        ...type,
        entries: type.entries.map((entry) => ({
          ...entry,
          type_expr: this.resolve_type_expr_aliases(
            entry.type_expr,
            resolving,
          ),
        })),
      };
    }
    if (type.tag === "array") {
      return {
        ...type,
        element: this.resolve_type_expr_aliases(type.element, resolving),
      };
    }
    if (type.tag === "arrow") {
      return {
        ...type,
        param: this.resolve_type_expr_aliases(type.param, resolving),
        result: this.resolve_type_expr_aliases(type.result, resolving),
      };
    }
    throw new Error("Unsupported Duck type expression");
  }

  private operation_parameter_type(
    types: readonly AbiTypeRef[],
  ): FunctionalHostType {
    if (types.length === 0) {
      return unit_type;
    }
    const final_type = types[types.length - 1];
    if (final_type === undefined) {
      throw new Error("Duck gpufuck operation omitted its final parameter");
    }
    let result = this.schema_from_abi_ref(final_type);
    for (let index = types.length - 2; index >= 0; index -= 1) {
      const type = types[index];
      if (type === undefined) {
        throw new Error(
          "Duck gpufuck operation omitted parameter " + index.toString(),
        );
      }
      result = this.tuple_type(this.schema_from_abi_ref(type), result);
    }
    return result;
  }

  private pack_arguments(
    args: readonly FunctionalSurfaceExpression[],
  ): FunctionalSurfaceExpression {
    if (args.length === 0) {
      return surface.name("$Unit");
    }
    let result = args[args.length - 1];
    if (result === undefined) {
      throw new Error("Duck gpufuck lowering lost final packed argument");
    }
    for (let index = args.length - 2; index >= 0; index -= 1) {
      const arg = args[index];
      if (arg === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost packed argument " + index.toString(),
        );
      }
      result = this.tuple_expression(arg, result);
    }
    return result;
  }

  private parameter_ownership(
    params: readonly { ownership: AbiOwnership }[],
  ): { parameterOwnership?: "bounded-borrow" | "ownership-transfer" } {
    if (params.some((param) => param.ownership === "ownership_transfer")) {
      return { parameterOwnership: "ownership-transfer" };
    }
    if (params.some((param) => param.ownership === "bounded_borrow")) {
      return { parameterOwnership: "bounded-borrow" };
    }
    return {};
  }

  private result_ownership(
    ownership: AbiOwnership,
  ): {
    resultOwnership?: "frozen-shareable" | "ownership-transfer" | "unique";
  } {
    if (ownership === "unique_heap") {
      return { resultOwnership: "unique" };
    }
    if (ownership === "frozen_shareable") {
      return { resultOwnership: "frozen-shareable" };
    }
    if (ownership === "ownership_transfer") {
      return { resultOwnership: "ownership-transfer" };
    }
    return {};
  }

  private value_ownership(
    ownership: AbiOwnership,
  ): { ownership?: "frozen-shareable" | "ownership-transfer" } {
    if (ownership === "ownership_transfer") {
      return { ownership: "ownership-transfer" };
    }
    if (ownership === "frozen_shareable") {
      return { ownership: "frozen-shareable" };
    }
    return {};
  }

  private entry_type(
    inferred: FunctionalTypeSchema | undefined,
  ): FunctionalTypeSchema | null {
    if (this.#abi.entry?.result !== undefined) {
      return this.schema_from_abi_ref(this.#abi.entry.result.type);
    }
    if (inferred !== undefined && !contains_type_parameter(inferred)) {
      return inferred;
    }
    return null;
  }

  private named_type(name: string): FunctionalTypeSchema {
    return { kind: "named", name, arguments: [] };
  }

  private tuple_type(
    first: FunctionalTypeSchema,
    second: FunctionalTypeSchema,
  ): FunctionalTypeSchema {
    return { kind: "tuple", values: [first, second] };
  }

  private tuple_expression(
    first: FunctionalSurfaceExpression,
    second: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return surface.apply(surface.name("$Tuple"), first, second);
  }

  private tuple_values(
    value: FunctionalWasmHostValue,
    context: string,
  ): readonly [FunctionalWasmHostValue, FunctionalWasmHostValue] {
    if (value.kind !== "tuple") {
      throw new TypeError(
        "Duck " + context + " expected a tuple, found " + value.kind,
      );
    }
    return value.values;
  }

  private lower_condition(
    expression: CoreExpr,
    environment: ReadonlyMap<string, FunctionalTypeSchema>,
  ): LoweredExpression {
    const lowered = this.lower_expression(expression, environment, {
      kind: "boolean",
    });
    if (lowered.type?.kind === "boolean") {
      return lowered;
    }
    if (lowered.type?.kind === "integer") {
      return {
        expression: surface.binary(
          FunctionalBinaryOperator.NotEqual,
          lowered.expression,
          surface.integer(0),
        ),
        type: { kind: "boolean" },
      };
    }
    if (lowered.type === undefined || lowered.type.kind === "parameter") {
      return {
        expression: surface.binary(
          FunctionalBinaryOperator.NotEqual,
          lowered.expression,
          surface.integer(0),
        ),
        type: { kind: "boolean" },
      };
    }
    let found = "unknown";
    if (lowered.type !== undefined) {
      found = lowered.type.kind;
    }
    let subject = expression.tag;
    if (expression.tag === "var") {
      subject += " " + expression.name;
    }
    throw new Error(
      "Duck gpufuck lowering requires a Bool or I32 condition, found " +
        found + " while lowering " + subject,
    );
  }

  private is_type_level_expression(expression: CoreExpr): boolean {
    if (
      expression.tag === "struct_type" || expression.tag === "union_type" ||
      expression.tag === "type_name"
    ) {
      return true;
    }
    if (expression.tag === "var" && this.is_duck_type_name(expression.name)) {
      return true;
    }
    if (expression.tag === "with") {
      return this.is_type_level_expression(expression.base);
    }
    if (expression.tag === "comptime") {
      return this.is_type_level_expression(expression.expr);
    }
    if (expression.tag === "lam" || expression.tag === "rec") {
      return this.is_type_level_expression(expression.body);
    }
    if (expression.tag === "block") {
      const final_statement = expression.statements.at(-1);
      if (final_statement?.tag === "expr") {
        return this.is_type_level_expression(final_statement.expr);
      }
      if (final_statement?.tag === "return") {
        return this.is_type_level_expression(final_statement.value);
      }
    }
    return false;
  }

  private is_type_constructor_expression(
    expression: CoreExpr,
    parameters: ReadonlySet<string>,
  ): boolean {
    if (
      expression.tag === "struct_type" || expression.tag === "union_type" ||
      expression.tag === "type_name"
    ) {
      return true;
    }
    if (expression.tag === "var") {
      return parameters.has(expression.name) ||
        this.is_duck_type_name(expression.name) ||
        this.#type_constructors.has(expression.name);
    }
    if (expression.tag === "with") {
      return this.is_type_constructor_expression(expression.base, parameters);
    }
    if (expression.tag === "comptime") {
      return this.is_type_constructor_expression(expression.expr, parameters);
    }
    if (expression.tag === "lam" || expression.tag === "rec") {
      const nested_parameters = new Set(parameters);
      for (const parameter of expression.params) {
        nested_parameters.add(parameter.name);
      }
      return this.is_type_constructor_expression(
        expression.body,
        nested_parameters,
      );
    }
    if (expression.tag === "app") {
      if (
        !this.is_type_constructor_expression(expression.func, parameters)
      ) {
        return false;
      }
      for (const argument of expression.args) {
        if (!this.is_type_constructor_expression(argument, parameters)) {
          return false;
        }
      }
      return true;
    }
    if (expression.tag === "block") {
      const final_statement = expression.statements.at(-1);
      if (final_statement?.tag === "expr") {
        return this.is_type_constructor_expression(
          final_statement.expr,
          parameters,
        );
      }
      if (final_statement?.tag === "return") {
        return this.is_type_constructor_expression(
          final_statement.value,
          parameters,
        );
      }
    }
    return false;
  }

  private is_duck_type_name(name: string): boolean {
    return name === "Bool" || name === "Bytes" || name === "Char" ||
      name === "F32" || name === "F64" || name === "F32x4" ||
      name === "I32" || name === "I64" || name === "Int" ||
      name === "Resume" || name === "Text" || name === "Type" ||
      name === "U32" || name === "Unit" || this.#types.has(name) ||
      this.#type_aliases.has(name);
  }

  private contains_unapplied_type_constructor(
    type: FunctionalTypeSchema,
  ): boolean {
    if (type.kind === "function") {
      return this.contains_unapplied_type_constructor(type.parameter) ||
        this.contains_unapplied_type_constructor(type.result);
    }
    if (type.kind === "tuple") {
      return this.contains_unapplied_type_constructor(type.values[0]) ||
        this.contains_unapplied_type_constructor(type.values[1]);
    }
    if (type.kind === "forall") {
      return this.contains_unapplied_type_constructor(type.body);
    }
    if (type.kind !== "named") {
      return false;
    }

    const constructor = this.#type_constructors.get(type.name);
    if (
      constructor !== undefined &&
      type.arguments.length < constructor.parameters.length
    ) {
      return true;
    }
    return type.arguments.some((argument) =>
      this.contains_unapplied_type_constructor(argument)
    );
  }

  private is_protocol_expression(expression: CoreExpr): boolean {
    if (expression.tag !== "lam" || expression.params.length !== 1) {
      return false;
    }
    const parameter = expression.params[0];
    if (parameter === undefined || expression.body.tag !== "block") {
      return false;
    }
    const final_statement = expression.body.statements.at(-1);
    if (
      final_statement?.tag !== "expr" || final_statement.expr.tag !== "var" ||
      final_statement.expr.name !== parameter.name
    ) {
      return false;
    }
    return expression.body.statements.slice(0, -1).every((statement) => {
      return statement.tag === "expr" && statement.expr.tag === "field" &&
        statement.expr.object.tag === "var" &&
        statement.expr.object.name === parameter.name;
    });
  }

  private index_selection(
    binders: readonly string[],
    index: FunctionalSurfaceExpression,
    result_type: FunctionalTypeSchema | undefined,
  ): FunctionalSurfaceExpression {
    let selected =
      this.runtime_trap(result_type, "Duck index is outside its aggregate")
        .expression;
    for (
      let field_index = binders.length - 1;
      field_index >= 0;
      field_index -= 1
    ) {
      const binder = binders[field_index];
      if (binder === undefined) {
        throw new Error(
          "Duck gpufuck lowering lost indexed field " + field_index.toString(),
        );
      }
      selected = {
        kind: "if",
        condition: surface.binary(
          FunctionalBinaryOperator.Equal,
          index,
          surface.integer(field_index),
        ),
        consequent: surface.name(binder),
        alternate: selected,
      };
    }
    return selected;
  }

  private unary_primitive(
    prim: Prim,
  ):
    | { operator: FunctionalUnaryOperator; result: FunctionalTypeSchema }
    | undefined {
    const operators = unary_operators();
    return operators.get(prim);
  }

  private conversion_primitive(
    prim: Prim,
  ):
    | { conversion: FunctionalNumericConversion; result: FunctionalTypeSchema }
    | undefined {
    const conversions = numeric_conversions();
    return conversions.get(prim);
  }

  private type_from_primitive_prefix(prim: Prim): FunctionalTypeSchema {
    if (prim.startsWith("i64.")) {
      return { kind: "signed-integer-64" };
    }
    if (prim.startsWith("f32.")) {
      return { kind: "float-32" };
    }
    if (prim.startsWith("f64.")) {
      return { kind: "float-64" };
    }
    return integer_type;
  }

  private type_expression_name(expression: CoreExpr): string {
    if (expression.tag === "var" || expression.tag === "type_name") {
      return format_type_expr(
        this.resolve_type_expr_aliases(
          parse_type_expr(tokenize(expression.name)),
          new Set(),
        ),
      );
    }
    if (expression.tag === "app") {
      if (expression.args.length === 0) {
        throw new Error(
          "Duck gpufuck lowering found an empty type application",
        );
      }
      let applied = parse_type_expr(tokenize(
        this.type_expression_name(expression.func),
      ));
      for (const arg of expression.args) {
        applied = {
          tag: "apply",
          func: applied,
          arg: parse_type_expr(tokenize(this.type_expression_name(arg))),
        };
      }
      return format_type_expr(
        this.resolve_type_expr_aliases(applied, new Set()),
      );
    }
    if (expression.tag === "union_type") {
      const candidates: string[] = [];
      for (const definition of this.#types.values()) {
        if (
          definition.shape !== "union" ||
          definition.cases.length !== expression.cases.length
        ) {
          continue;
        }
        let matches = true;
        for (let index = 0; index < definition.cases.length; index += 1) {
          const definition_case = definition.cases[index];
          const expression_case = expression.cases[index];
          if (definition_case === undefined || expression_case === undefined) {
            throw new Error(
              "Duck gpufuck lowering lost union case " + index.toString(),
            );
          }
          if (
            definition_case.name !== expression_case.name ||
            !this.same_type(
              definition_case.type,
              this.schema_from_type_name(expression_case.type_name),
            )
          ) {
            matches = false;
            break;
          }
        }
        if (matches) {
          const resolved = this.resolve_type_alias(
            this.named_type(definition.name),
          );
          let candidate_name = definition.name;
          if (resolved.kind === "named") {
            candidate_name = resolved.name;
          }
          if (!candidates.includes(candidate_name)) {
            candidates.push(candidate_name);
          }
        }
      }
      if (candidates.length === 1) {
        const name = candidates[0];
        if (name === undefined) {
          throw new Error("Duck gpufuck lowering lost matched union type");
        }
        return name;
      }
      throw new Error(
        "Duck gpufuck lowering cannot resolve anonymous union; matching " +
          "runtime types: " + candidates.join(", "),
      );
    }
    throw new Error(
      "Duck gpufuck lowering requires a named runtime type, found " +
        expression.tag,
    );
  }

  private named_type_name(
    type: FunctionalTypeSchema | undefined,
    context: string,
  ): string {
    if (type?.kind !== "named") {
      throw new Error(
        "Duck gpufuck lowering requires a named type for " + context +
          "; found " + this.type_key(type),
      );
    }
    return source_type_name_from_schema(type);
  }

  private require_definition(name: string): DuckTypeDefinition {
    this.materialize_type_definition(name);
    const definition = this.#types.get(name);
    if (definition === undefined) {
      throw new Error("Duck gpufuck lowering cannot find type " + name);
    }
    return definition;
  }

  private require_type(
    type: FunctionalTypeSchema | undefined,
    context: string,
  ): FunctionalTypeSchema {
    if (type === undefined) {
      throw new Error("Duck gpufuck lowering cannot infer " + context);
    }
    return type;
  }

  private require_buffer_type(
    type: FunctionalTypeSchema | undefined,
    context: string,
  ): FunctionalTypeSchema {
    if (
      this.same_type(type, FunctionalHostTypes.text) ||
      this.same_type(type, FunctionalHostTypes.bytes)
    ) {
      return this.require_type(type, context);
    }
    throw new Error(
      "Duck gpufuck lowering requires Text or Bytes for " + context,
    );
  }

  private required_arg(
    args: readonly CoreExpr[],
    index: number,
    context: string,
  ): CoreExpr {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error(
        "Duck " + context + " omitted argument " + index.toString(),
      );
    }
    return arg;
  }

  private type_key(type: FunctionalTypeSchema | undefined): string {
    if (type === undefined) {
      return "unknown";
    }
    return JSON.stringify(type);
  }

  private same_type(
    left: FunctionalTypeSchema | undefined,
    right: FunctionalTypeSchema,
  ): boolean {
    if (left === undefined) {
      return false;
    }
    return JSON.stringify(this.resolve_type_alias(left)) ===
      JSON.stringify(this.resolve_type_alias(right));
  }

  private resolve_type_alias(
    type: FunctionalTypeSchema,
  ): FunctionalTypeSchema {
    let resolved = type;
    const seen = new Set<string>();

    while (resolved.kind === "named") {
      if (seen.has(resolved.name)) {
        throw new Error("Duck type alias cycle includes " + resolved.name);
      }
      seen.add(resolved.name);
      const alias = this.#type_aliases.get(resolved.name);
      if (alias === undefined) {
        break;
      }
      resolved = this.schema_from_type_name(alias);
    }

    return resolved;
  }

  private temporary(purpose: string): string {
    const name = "$Duck" + purpose + this.#temporary_index.toString();
    this.#temporary_index += 1;
    return name;
  }

  private host_binder(capability: string, field: string): string {
    return "$DuckHost:" + capability + ":" + field;
  }

  private struct_constructor(name: string): string {
    return "$DuckStruct:" + name;
  }

  private union_constructor(name: string, union_case: string): string {
    return "$DuckUnion:" + name + ":" + union_case;
  }
}

function lower_binary_primitive(
  prim: Prim,
):
  | { operator: FunctionalBinaryOperator; result: FunctionalTypeSchema }
  | undefined {
  const integer = integer_type;
  const boolean: FunctionalTypeSchema = { kind: "boolean" };
  const i64: FunctionalTypeSchema = { kind: "signed-integer-64" };
  const f32: FunctionalTypeSchema = { kind: "float-32" };
  const f64: FunctionalTypeSchema = { kind: "float-64" };
  const entries: readonly [
    Prim,
    FunctionalBinaryOperator,
    FunctionalTypeSchema,
  ][] = [
    ["i32.eq", FunctionalBinaryOperator.Equal, boolean],
    ["i32.ne", FunctionalBinaryOperator.NotEqual, boolean],
    ["i32.lt_s", FunctionalBinaryOperator.Less, boolean],
    ["i32.le_s", FunctionalBinaryOperator.LessEqual, boolean],
    ["i32.gt_s", FunctionalBinaryOperator.Greater, boolean],
    ["i32.ge_s", FunctionalBinaryOperator.GreaterEqual, boolean],
    ["i32.add", FunctionalBinaryOperator.Add, integer],
    ["i32.sub", FunctionalBinaryOperator.Subtract, integer],
    ["i32.mul", FunctionalBinaryOperator.Multiply, integer],
    ["i32.div_s", FunctionalBinaryOperator.Divide, integer],
    ["i32.rem_s", FunctionalBinaryOperator.Remainder, integer],
    ["i32.and", FunctionalBinaryOperator.BitwiseAnd, integer],
    ["i32.or", FunctionalBinaryOperator.BitwiseOr, integer],
    ["i32.xor", FunctionalBinaryOperator.BitwiseXor, integer],
    ["i32.shl", FunctionalBinaryOperator.ShiftLeft, integer],
    ["i32.shr_u", FunctionalBinaryOperator.ShiftRightUnsigned, integer],
    ["i64.eq", FunctionalBinaryOperator.EqualSignedInteger64, boolean],
    ["i64.ne", FunctionalBinaryOperator.NotEqualSignedInteger64, boolean],
    ["i64.lt_s", FunctionalBinaryOperator.LessSignedInteger64, boolean],
    ["i64.le_s", FunctionalBinaryOperator.LessEqualSignedInteger64, boolean],
    ["i64.gt_s", FunctionalBinaryOperator.GreaterSignedInteger64, boolean],
    ["i64.ge_s", FunctionalBinaryOperator.GreaterEqualSignedInteger64, boolean],
    ["i64.add", FunctionalBinaryOperator.AddSignedInteger64, i64],
    ["i64.sub", FunctionalBinaryOperator.SubtractSignedInteger64, i64],
    ["i64.mul", FunctionalBinaryOperator.MultiplySignedInteger64, i64],
    ["i64.div_s", FunctionalBinaryOperator.DivideSignedInteger64, i64],
    ["i64.rem_s", FunctionalBinaryOperator.RemainderSignedInteger64, i64],
    ["i64.and", FunctionalBinaryOperator.BitwiseAndSignedInteger64, i64],
    ["i64.or", FunctionalBinaryOperator.BitwiseOrSignedInteger64, i64],
    ["i64.xor", FunctionalBinaryOperator.BitwiseXorSignedInteger64, i64],
    ["i64.shl", FunctionalBinaryOperator.ShiftLeftSignedInteger64, i64],
    [
      "i64.shr_u",
      FunctionalBinaryOperator.ShiftRightUnsignedSignedInteger64,
      i64,
    ],
    ["f32.eq", FunctionalBinaryOperator.EqualFloat32, boolean],
    ["f32.ne", FunctionalBinaryOperator.NotEqualFloat32, boolean],
    ["f32.lt", FunctionalBinaryOperator.LessFloat32, boolean],
    ["f32.le", FunctionalBinaryOperator.LessEqualFloat32, boolean],
    ["f32.gt", FunctionalBinaryOperator.GreaterFloat32, boolean],
    ["f32.ge", FunctionalBinaryOperator.GreaterEqualFloat32, boolean],
    ["f32.add", FunctionalBinaryOperator.AddFloat32, f32],
    ["f32.sub", FunctionalBinaryOperator.SubtractFloat32, f32],
    ["f32.mul", FunctionalBinaryOperator.MultiplyFloat32, f32],
    ["f32.div", FunctionalBinaryOperator.DivideFloat32, f32],
    ["f64.eq", FunctionalBinaryOperator.EqualFloat64, boolean],
    ["f64.ne", FunctionalBinaryOperator.NotEqualFloat64, boolean],
    ["f64.lt", FunctionalBinaryOperator.LessFloat64, boolean],
    ["f64.le", FunctionalBinaryOperator.LessEqualFloat64, boolean],
    ["f64.gt", FunctionalBinaryOperator.GreaterFloat64, boolean],
    ["f64.ge", FunctionalBinaryOperator.GreaterEqualFloat64, boolean],
    ["f64.add", FunctionalBinaryOperator.AddFloat64, f64],
    ["f64.sub", FunctionalBinaryOperator.SubtractFloat64, f64],
    ["f64.mul", FunctionalBinaryOperator.MultiplyFloat64, f64],
    ["f64.div", FunctionalBinaryOperator.DivideFloat64, f64],
  ];
  const entry = entries.find((candidate) => candidate[0] === prim);
  if (entry === undefined) {
    return undefined;
  }
  return { operator: entry[1], result: entry[2] };
}

function unary_operators(): ReadonlyMap<
  Prim,
  { operator: FunctionalUnaryOperator; result: FunctionalTypeSchema }
> {
  return new Map([
    [
      "f32.sqrt",
      {
        operator: FunctionalUnaryOperator.SquareRootFloat32,
        result: { kind: "float-32" },
      },
    ],
  ]);
}

function numeric_conversions(): ReadonlyMap<
  Prim,
  { conversion: FunctionalNumericConversion; result: FunctionalTypeSchema }
> {
  return new Map([
    [
      "i64.extend_i32_s",
      {
        conversion:
          FunctionalNumericConversion.SignedInteger32ToSignedInteger64,
        result: { kind: "signed-integer-64" },
      },
    ],
    [
      "i32.wrap_i64",
      {
        conversion:
          FunctionalNumericConversion.SignedInteger64ToSignedInteger32,
        result: integer_type,
      },
    ],
    [
      "f32.convert_i32_s",
      {
        conversion: FunctionalNumericConversion.SignedInteger32ToFloat32,
        result: { kind: "float-32" },
      },
    ],
    [
      "f64.convert_i32_s",
      {
        conversion: FunctionalNumericConversion.SignedInteger32ToFloat64,
        result: { kind: "float-64" },
      },
    ],
    [
      "i32.trunc_f32_s",
      {
        conversion: FunctionalNumericConversion.Float32ToSignedInteger32,
        result: integer_type,
      },
    ],
    [
      "i32.trunc_f64_s",
      {
        conversion: FunctionalNumericConversion.Float64ToSignedInteger32,
        result: integer_type,
      },
    ],
    [
      "i32.reinterpret_f32",
      {
        conversion:
          FunctionalNumericConversion.ReinterpretFloat32AsSignedInteger32,
        result: integer_type,
      },
    ],
    [
      "f32.reinterpret_i32",
      {
        conversion:
          FunctionalNumericConversion.ReinterpretSignedInteger32AsFloat32,
        result: { kind: "float-32" },
      },
    ],
  ]);
}

function contains_type_parameter(type: FunctionalTypeSchema): boolean {
  if (type.kind === "parameter" || type.kind === "forall") {
    return true;
  }
  if (type.kind === "function") {
    return contains_type_parameter(type.parameter) ||
      contains_type_parameter(type.result);
  }
  if (type.kind === "tuple") {
    return contains_type_parameter(type.values[0]) ||
      contains_type_parameter(type.values[1]);
  }
  if (type.kind === "named") {
    for (const part of type.name.split(/\s+/)) {
      if (/^[a-z_]/.test(part)) {
        return true;
      }
    }
    return type.arguments.some(contains_type_parameter);
  }
  return false;
}

function source_type_application(
  name: string,
): { name: string; args: TypeExpr[] } | undefined {
  let expression: TypeExpr;
  try {
    expression = parse_type_expr(tokenize(name));
  } catch {
    return undefined;
  }

  const args: TypeExpr[] = [];
  while (expression.tag === "apply") {
    args.unshift(expression.arg);
    expression = expression.func;
  }

  if (expression.tag !== "name" || args.length === 0) {
    return undefined;
  }
  return { name: expression.name, args };
}

function source_type_name_from_schema(type: FunctionalTypeSchema): string {
  return format_type_expr(source_type_expr_from_schema(type));
}

function source_type_expr_from_schema(type: FunctionalTypeSchema): TypeExpr {
  if (type.kind === "integer") {
    return { tag: "name", name: "I32" };
  }
  if (type.kind === "signed-integer-64") {
    return { tag: "name", name: "I64" };
  }
  if (type.kind === "float-32") {
    return { tag: "name", name: "F32" };
  }
  if (type.kind === "float-64") {
    return { tag: "name", name: "F64" };
  }
  if (type.kind === "boolean") {
    return { tag: "name", name: "Bool" };
  }
  if (type.kind === "unit") {
    return { tag: "name", name: "Unit" };
  }
  if (type.kind === "parameter") {
    return { tag: "name", name: type.name };
  }
  if (type.kind === "tuple") {
    return {
      tag: "product",
      entries: type.values.map((value) => ({
        type_expr: source_type_expr_from_schema(value),
      })),
    };
  }
  if (type.kind === "function") {
    return {
      tag: "arrow",
      param: source_type_expr_from_schema(type.parameter),
      effects: undefined,
      result: source_type_expr_from_schema(type.result),
    };
  }
  if (type.kind === "forall") {
    return {
      tag: "forall",
      params: [...type.parameters],
      body: source_type_expr_from_schema(type.body),
    };
  }

  let name = type.name;
  if (type.name === FUNCTIONAL_TEXT_TYPE_NAME) {
    name = "Text";
  } else if (type.name === FUNCTIONAL_BYTES_TYPE_NAME) {
    name = "Bytes";
  }

  let expression: TypeExpr = { tag: "name", name };
  for (const argument of type.arguments) {
    expression = {
      tag: "apply",
      func: expression,
      arg: source_type_expr_from_schema(argument),
    };
  }
  return expression;
}

function references_are_saturated_calls(
  value: object,
  name: string,
  arity: number,
): boolean {
  const pending: object[] = [value];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    expect(current, "Missing pending saturated-call reference");

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const expression = current as Partial<CoreExpr>;
    if (
      expression.tag === "app" &&
      expression.func?.tag === "var" &&
      expression.func.name === name
    ) {
      if (expression.args?.length !== arity) {
        return false;
      }
      for (const arg of expression.args) {
        pending.push(arg);
      }
      continue;
    }

    if (
      (expression.tag === "var" || expression.tag === "linear" ||
        expression.tag === "rec_ref") && expression.name === name
    ) {
      return false;
    }

    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") {
        pending.push(child);
      }
    }
  }

  return true;
}
