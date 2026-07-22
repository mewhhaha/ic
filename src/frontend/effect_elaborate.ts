import { expect } from "../expect.ts";
import { specialize_effect_operation } from "./effect_operation.ts";
import type { ValType } from "../op.ts";
import type {
  EffectDeclaration,
  EffectParam,
  EffectRef,
  EffectResult,
  Field,
  FrontExpr,
  FrontHostImport,
  FrontHostImportArgContract,
  FrontHostImportOwnerReason,
  Param,
  Pattern,
  RecordDeclaration,
  Source,
  Stmt,
  TypeExpr,
} from "./ast.ts";
import {
  analyze_front_effects,
  front_scalar_type_aliases,
  type FrontEffectAnalysis,
  type FrontEffectFunction,
  normalize_front_effect_scalar_alias_ownership,
} from "./effect_analysis.ts";
import { scope_inlined_returns } from "./effect_inline_return.ts";
import { is_builtin_type_name } from "./types.ts";
import { elaborate_front_handlers } from "./handler_elaborate.ts";
import { is_no_demand_name } from "./names.ts";
import { substitute_front_expr } from "./substitute.ts";
import { type_declaration_bindings } from "./type_declaration.ts";
import { prim_returns_bool } from "./numeric.ts";
import { format_type_expr, function_type_expr } from "./type_expr.ts";
import { pattern_bindings } from "./pattern.ts";
import {
  const_i32_value,
  expanded_type_product_entries,
} from "./fixed_array_type.ts";

type EffectElaboration = {
  analysis: FrontEffectAnalysis;
  effects: Map<string, EffectDeclaration>;
  records: Map<string, RecordDeclaration>;
  scalar_type_aliases: Map<string, string>;
  type_names: Set<string>;
  modules: Map<string, Extract<FrontExpr, { tag: "lam" }>>;
  effect_functions: Map<
    string,
    Extract<Stmt, { tag: "bind" }> & {
      value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
    }
  >;
  const_values: Map<string, FrontExpr>;
};

export function elaborate_front_effects(source: Source): Source {
  const declarations = source.declarations || [];
  const elaboration = create_elaboration(source);
  const prefix: Stmt[] = [];
  const type_extensions: Stmt[] = [];

  for (const declaration of declarations) {
    if (declaration.tag === "record") {
      prefix.push(record_type_binding(declaration, elaboration.effects));
    } else if (declaration.tag !== "effect") {
      continue;
    } else if (declaration.implementation === "host") {
      for (const operation of declaration.operations) {
        prefix.push({
          tag: "host_import",
          value: effect_host_import(
            declaration,
            operation,
            elaboration.scalar_type_aliases,
          ),
        });
      }
    }
  }
  const declaration_prefix_length = prefix.length;

  for (const declaration of declarations) {
    if (declaration.tag !== "extend") {
      continue;
    }

    const generic_target = declarations.find((candidate) => {
      return candidate.tag === "type" &&
        candidate.name === declaration.type_name &&
        candidate.params.length > 0;
    });

    if (generic_target !== undefined) {
      continue;
    }

    let fields = declaration.fields;

    if (is_builtin_type_name(declaration.type_name)) {
      fields = fields.filter((field) => {
        return field.value.tag !== "lam" && field.value.tag !== "rec";
      });
    }

    if (fields.length === 0) {
      continue;
    }

    type_extensions.push({
      tag: "bind",
      kind: "const",
      name: declaration.type_name,
      is_linear: false,
      annotation: undefined,
      value: {
        tag: "struct_update",
        base: { tag: "var", name: declaration.type_name },
        fields,
      },
    });
  }

  const providers = new Map<string, FrontExpr>();

  if (source.module && source.module.params.length > 0) {
    expect(
      source.module.params.length === 1,
      "Entry file module currently accepts exactly one Init parameter",
    );
    const init_param = source.module.params[0];
    expect(init_param, "Missing entry Init parameter");
    expect(
      init_param.annotation,
      "Entry Init parameter requires an annotation",
    );
    const init_record = elaboration.records.get(init_param.annotation);
    expect(
      init_record,
      "Missing entry Init declaration: " + init_param.annotation,
    );
    const fields: Field[] = [];

    for (const field of init_record.fields) {
      const effect = elaboration.effects.get(field.type_name);
      expect(
        effect,
        "Init field " + field.name + " must name a declared effect",
      );
      expect(
        effect.implementation === "host",
        "Init field " + field.name + " cannot provide Duck effect " +
          effect.name,
      );
      const getter_name = "__duck_init_" + field.name;
      prefix.push({
        tag: "host_import",
        value: {
          name: getter_name,
          module: "duck_init",
          field: field.name,
          params: [],
          result: "i32",
          args: [],
          result_owner: undefined,
        },
      });
      fields.push({
        name: field.name,
        value: {
          tag: "app",
          func: { tag: "var", name: getter_name },
          args: [],
        },
      });
      providers.set(effect.name, {
        tag: "field",
        object: { tag: "var", name: init_param.name },
        name: field.name,
      });
    }

    prefix.push({
      tag: "bind",
      kind: "let",
      name: init_param.name,
      is_linear: false,
      annotation: init_param.annotation,
      value: {
        tag: "struct_value",
        type_expr: { tag: "var", name: init_param.annotation },
        fields,
      },
    });
  }

  const handler_source = elaborate_front_handlers(source, {
    providers,
    analysis: elaboration.analysis,
  });
  const rewritten_statements = rewrite_statements(
    handler_source.statements,
    providers,
    elaboration,
  );
  const initializer_names = type_initializer_names(declarations);
  const initializer_bindings: Stmt[] = [];
  const statements: Stmt[] = [];

  for (const statement of rewritten_statements) {
    if (binds_type_initializer(statement, initializer_names)) {
      initializer_bindings.push(statement);
    } else {
      statements.push(statement);
    }
  }

  const module_prefix = prefix.splice(declaration_prefix_length);
  prefix.push(...initializer_bindings);
  prefix.push(...type_declaration_bindings(declarations, elaboration.effects));
  prefix.push(...type_extensions);
  prefix.push(...module_prefix);
  materialize_module_result_type(statements, prefix);

  return { tag: "program", statements: [...prefix, ...statements] };
}

function type_initializer_names(
  declarations: NonNullable<Source["declarations"]>,
): Set<string> {
  const names = new Set<string>();

  for (const declaration of declarations) {
    if (
      declaration.tag !== "type" || declaration.body.tag !== "product" ||
      declaration.body.initializer?.tag !== "app" ||
      declaration.body.initializer.func.tag !== "var"
    ) {
      continue;
    }

    names.add(declaration.body.initializer.func.name);
  }

  return names;
}

function binds_type_initializer(
  statement: Stmt,
  initializer_names: Set<string>,
): boolean {
  if (
    initializer_names.size === 0 || statement.tag !== "bind" ||
    statement.kind !== "const"
  ) {
    return false;
  }

  if (statement.pattern === undefined) {
    return initializer_names.has(statement.name);
  }

  return pattern_bindings(statement.pattern).some((binding) =>
    initializer_names.has(binding.name)
  );
}

function materialize_module_result_type(
  statements: Stmt[],
  prefix: Stmt[],
): void {
  const final_stmt = statements[statements.length - 1];

  if (
    !final_stmt || final_stmt.tag !== "return" ||
    final_stmt.value.tag !== "struct_value" ||
    final_stmt.value.type_expr.tag !== "var" ||
    final_stmt.value.type_expr.name !== "object_type"
  ) {
    return;
  }

  const bindings = new Map<string, string>();
  const functions = new Map<string, string>();
  const imports = new Map<string, string>();

  for (const stmt of [...prefix, ...statements]) {
    if (stmt.tag === "host_import") {
      imports.set(stmt.value.name, host_result_type_name(stmt.value));
      continue;
    }

    if (stmt.tag !== "bind") {
      continue;
    }

    if (stmt.annotation) {
      bindings.set(stmt.name, stmt.annotation);
    }

    if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
      const function_type = function_type_expr(stmt.type_annotation);

      if (
        function_type && function_type.result.tag === "name"
      ) {
        functions.set(stmt.name, function_type.result.name);
        continue;
      }

      const result = infer_result_type(
        stmt.value.body,
        bindings,
        functions,
        imports,
      );

      if (result) {
        functions.set(stmt.name, result);
      }

      continue;
    }

    const type_name = infer_result_type(
      stmt.value,
      bindings,
      functions,
      imports,
    );

    if (type_name) {
      bindings.set(stmt.name, type_name);
    }
  }

  const fields = final_stmt.value.fields.map((field) => {
    const type_name = infer_result_type(
      field.value,
      bindings,
      functions,
      imports,
    );
    expect(
      type_name,
      "Cannot infer module return field type: " + field.name,
    );
    return { name: field.name, type_name };
  });
  const type_name = "duck_entry_result_type";
  prefix.push({
    tag: "bind",
    kind: "const",
    name: type_name,
    is_linear: false,
    annotation: undefined,
    value: { tag: "struct_type", fields },
  });
  final_stmt.value.type_expr = { tag: "var", name: type_name };
}

function host_result_type_name(value: FrontHostImport): string {
  if (value.result_owner && value.result_owner.tag !== "scalar") {
    const reason = value.result_owner.reason;

    if (reason === "text") {
      return "Text";
    }

    if (reason === "bytes") {
      return "Bytes";
    }

    if (typeof reason !== "string") {
      return reason.name;
    }
  }

  if (value.result === "i64") {
    return "I64";
  }

  return "I32";
}

function infer_result_type(
  expr: FrontExpr,
  bindings: Map<string, string>,
  functions: Map<string, string>,
  imports: Map<string, string>,
): string | undefined {
  if (expr.tag === "bool" || expr.tag === "is") {
    return "Bool";
  }

  if (expr.tag === "num") {
    if (expr.character !== undefined) {
      return "Char";
    }

    if (expr.type === "i64") {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "text") {
    return "Text";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    return bindings.get(expr.name);
  }

  if (expr.tag === "prim") {
    if (prim_returns_bool(expr.prim)) {
      return "Bool";
    }

    return infer_result_type(expr.left, bindings, functions, imports);
  }

  if (expr.tag === "app" && expr.func.tag === "var") {
    const function_result = functions.get(expr.func.name);

    if (function_result) {
      return function_result;
    }

    const import_result = imports.get(expr.func.name);

    if (import_result) {
      return import_result;
    }

    if (expr.func.name === "@len" || expr.func.name === "@get") {
      return "I32";
    }

    if (expr.func.name === "@Bytes.generate") {
      return "Bytes";
    }

    if (expr.func.name === "@Utf8.encode") {
      return "Bytes";
    }

    if (
      expr.func.name === "@Utf8.decode" || expr.func.name === "@format_i32" ||
      expr.func.name === "@format_i64" || expr.func.name === "@format_f32"
    ) {
      return "Text";
    }
  }

  if (expr.tag === "block") {
    const local_bindings = new Map(bindings);
    const local_functions = new Map(functions);

    for (const stmt of expr.statements) {
      if (stmt.tag !== "bind") {
        continue;
      }

      if (stmt.annotation) {
        local_bindings.set(stmt.name, stmt.annotation);
      }

      if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
        const function_result = infer_result_type(
          stmt.value.body,
          local_bindings,
          local_functions,
          imports,
        );

        if (function_result) {
          local_functions.set(stmt.name, function_result);
        }
      } else {
        const binding_result = infer_result_type(
          stmt.value,
          local_bindings,
          local_functions,
          imports,
        );

        if (binding_result) {
          local_bindings.set(stmt.name, binding_result);
        }
      }
    }

    const last = expr.statements[expr.statements.length - 1];

    if (last && last.tag === "expr") {
      return infer_result_type(
        last.expr,
        local_bindings,
        local_functions,
        imports,
      );
    }

    if (last && last.tag === "return") {
      return infer_result_type(
        last.value,
        local_bindings,
        local_functions,
        imports,
      );
    }
  }

  if (expr.tag === "if" || expr.tag === "if_let") {
    const left = infer_result_type(
      expr.then_branch,
      bindings,
      functions,
      imports,
    );
    const right = infer_result_type(
      expr.else_branch,
      bindings,
      functions,
      imports,
    );

    if (left === right) {
      return left;
    }

    // Branch agreement is checked by the Core type passes; when only one
    // branch is locally inferable (for example the other ends in an
    // if let payload binder), its type names the shared result.
    if (left && !right) {
      return left;
    }

    if (right && !left) {
      return right;
    }
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return infer_result_type(expr.value, bindings, functions, imports);
  }

  if (expr.tag === "struct_value" && expr.type_expr.tag === "var") {
    if (expr.type_expr.name !== "object_type") {
      return expr.type_expr.name;
    }
  }

  return undefined;
}

function create_elaboration(source: Source): EffectElaboration {
  const scalar_type_aliases = front_scalar_type_aliases(source);
  normalize_front_effect_scalar_alias_ownership(
    source,
    scalar_type_aliases,
  );
  const analysis = analyze_front_effects(source);
  const effects = new Map<string, EffectDeclaration>();
  const records = new Map<string, RecordDeclaration>();
  const type_names = new Set<string>();
  const modules = new Map<string, Extract<FrontExpr, { tag: "lam" }>>();
  const effect_functions = new Map<
    string,
    Extract<Stmt, { tag: "bind" }> & {
      value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
    }
  >();
  const const_values = new Map<string, FrontExpr>();

  for (const declaration of source.declarations || []) {
    if (declaration.tag === "record") {
      records.set(declaration.name, declaration);
      type_names.add(declaration.name);
      continue;
    }

    if (declaration.tag === "type") {
      type_names.add(declaration.name);
      if (
        declaration.params.length === 0 &&
        declaration.body.tag === "product" &&
        !declaration.body.positional
      ) {
        records.set(declaration.name, {
          tag: "record",
          name: declaration.name,
          fields: declaration.body.fields,
        });
      }

      continue;
    }

    if (declaration.tag === "effect") {
      effects.set(declaration.name, declaration);
    }
  }

  for (const stmt of source.statements) {
    if (stmt.tag === "bind" && stmt.kind === "const") {
      const_values.set(stmt.name, stmt.value);
    }

    if (
      stmt.tag === "bind" && stmt.kind === "const" &&
      front_expr_is_type_constructor(stmt.value)
    ) {
      type_names.add(stmt.name);
    }

    if (
      stmt.tag === "bind" && stmt.kind === "const" &&
      stmt.value.tag === "lam" && stmt.value.body.tag === "block"
    ) {
      const final_stmt = stmt.value.body.statements[
        stmt.value.body.statements.length - 1
      ];

      if (
        final_stmt && final_stmt.tag === "return" &&
        final_stmt.value.tag === "struct_value"
      ) {
        modules.set(stmt.name, stmt.value);
      }
    }
  }
  collect_effect_function_bindings(
    source.statements,
    effect_functions,
    analysis,
  );

  return {
    analysis,
    effects,
    records,
    scalar_type_aliases,
    type_names,
    modules,
    effect_functions,
    const_values,
  };
}

function collect_effect_function_bindings(
  statements: Stmt[],
  result: EffectElaboration["effect_functions"],
  analysis: FrontEffectAnalysis,
): void {
  for (const stmt of statements) {
    if (
      stmt.tag === "bind" && analysis.functions[stmt.name] &&
      (stmt.value.tag === "lam" || stmt.value.tag === "rec")
    ) {
      result.set(
        stmt.name,
        stmt as Extract<Stmt, { tag: "bind" }> & {
          value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
        },
      );
    }

    if (
      stmt.tag === "bind" &&
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      stmt.value.body.tag === "block"
    ) {
      collect_effect_function_bindings(
        stmt.value.body.statements,
        result,
        analysis,
      );
    }
  }
}

function record_type_binding(
  declaration: RecordDeclaration,
  effects: Map<string, EffectDeclaration>,
): Stmt {
  return {
    tag: "bind",
    kind: "const",
    name: declaration.name,
    is_linear: false,
    annotation: undefined,
    value: {
      tag: "struct_type",
      fields: declaration.fields.map((field) => {
        if (effects.has(field.type_name)) {
          return { name: field.name, type_name: "I32" };
        }

        return field;
      }),
    },
  };
}

function effect_host_import(
  effect: EffectDeclaration,
  operation: EffectDeclaration["operations"][number],
  scalar_type_aliases: Map<string, string>,
): FrontHostImport {
  const args: FrontHostImportArgContract[] = [{ tag: "scalar" }];
  const params: ValType[] = ["i32"];

  for (const param of operation.params) {
    params.push(effect_value_type(param.type_name, scalar_type_aliases));
    args.push(effect_arg_contract(param));
  }

  return {
    name: effect_import_name(effect.name, operation.name),
    module: "duck_effect",
    field: effect.name + "." + operation.name,
    params,
    result: effect_value_type(
      operation.result.type_name,
      scalar_type_aliases,
    ),
    args,
    result_owner: effect_result_contract(operation.result),
  };
}

function effect_arg_contract(param: EffectParam): FrontHostImportArgContract {
  if (param.ownership === "scalar") {
    return { tag: "scalar" };
  }

  return {
    tag: param.ownership,
    reason: effect_owner_reason(param.type_name),
  };
}

function effect_result_contract(
  result: EffectResult,
): FrontHostImport["result_owner"] {
  if (result.ownership === "scalar") {
    return undefined;
  }

  return {
    tag: result.ownership,
    reason: effect_owner_reason(result.type_name),
  };
}

function effect_owner_reason(type_name: string): FrontHostImportOwnerReason {
  if (type_name === "Text") {
    return "text";
  }

  if (type_name === "Bytes") {
    return "bytes";
  }

  return { tag: "type_ref", name: type_name };
}

function effect_value_type(
  type_name: string,
  scalar_type_aliases: Map<string, string>,
): ValType {
  let resolved = type_name;
  const scalar_alias = scalar_type_aliases.get(type_name);

  if (scalar_alias) {
    resolved = scalar_alias;
  }

  if (resolved === "I64") {
    return "i64";
  }

  if (resolved === "F32") {
    return "f32";
  }

  if (resolved === "F64") {
    return "f64";
  }

  return "i32";
}

function rewrite_statements(
  statements: Stmt[],
  providers: Map<string, FrontExpr>,
  elaboration: EffectElaboration,
): Stmt[] {
  const result: Stmt[] = [];
  let next_pattern = 0;

  for (const stmt of statements) {
    if (stmt.tag === "state_bind") {
      const value = rewrite_expr(stmt.value, providers, elaboration);
      let annotation: string | undefined;

      if (stmt.value.tag === "app") {
        const operation_ref = effect_call(stmt.value, elaboration);

        if (operation_ref) {
          const effect = elaboration.effects.get(operation_ref.effect);
          const declared_operation = effect?.operations.find((item) => {
            return item.name === operation_ref.operation;
          });
          let operation;

          if (declared_operation !== undefined) {
            operation = specialize_effect_operation(
              declared_operation,
              stmt.value,
            );
          }

          if (
            operation !== undefined && operation.result.type_name !== "Unit"
          ) {
            annotation = operation.result.type_name;
          }
        }
      }

      if (stmt.value_name) {
        result.push({
          tag: "bind",
          kind: "let",
          name: stmt.value_name,
          is_linear: false,
          annotation,
          value,
        });
      } else {
        result.push({ tag: "expr", expr: value });
      }

      continue;
    }

    if (stmt.tag === "bind_pattern") {
      if (stmt.value.tag === "app" && stmt.value.func.tag === "var") {
        const module = elaboration.modules.get(stmt.value.func.name);

        if (module) {
          expect(
            module.params.length === stmt.value.args.length,
            "Module argument count mismatch: " + stmt.value.func.name,
          );
          const replacements = new Map<string, FrontExpr>();

          for (let index = 0; index < module.params.length; index += 1) {
            const param = module.params[index];
            const arg = stmt.value.args[index];
            expect(param, "Missing module parameter");
            expect(arg, "Missing module argument");
            replacements.set(param.name, arg);
          }

          const body = substitute_front_expr(module.body, replacements);
          expect(
            body.tag === "block",
            "Module initializer body must be a block",
          );
          const body_statements = [...body.statements];
          const export_stmt = body_statements.pop();
          expect(
            export_stmt && export_stmt.tag === "return" &&
              export_stmt.value.tag === "struct_value",
            "Module initializer must return an export record",
          );
          result.push(...rewrite_statements(
            body_statements,
            providers,
            elaboration,
          ));

          for (const item of stmt.items) {
            if (is_no_demand_name(item.name)) {
              continue;
            }

            const field = export_stmt.value.fields.find((candidate) => {
              return candidate.name === item.name;
            });
            expect(
              field,
              "Module " + stmt.value.func.name + " does not export " +
                item.name,
            );

            if (
              field.value.tag === "var" && field.value.name === item.name &&
              elaboration.effect_functions.has(item.name)
            ) {
              continue;
            }

            result.push({
              tag: "bind",
              kind: stmt.kind,
              name: item.name,
              is_linear: item.is_linear,
              annotation: undefined,
              value: rewrite_expr(
                field.value,
                providers,
                elaboration,
              ),
            });
          }

          continue;
        }
      }

      const temp = "module_exports_" + next_pattern.toString();
      next_pattern += 1;
      result.push({
        tag: "bind",
        kind: stmt.kind,
        name: temp,
        is_linear: false,
        annotation: undefined,
        value: rewrite_expr(stmt.value, providers, elaboration),
      });

      for (const item of stmt.items) {
        if (is_no_demand_name(item.name)) {
          continue;
        }

        result.push({
          tag: "bind",
          kind: stmt.kind,
          name: item.name,
          is_linear: item.is_linear,
          annotation: undefined,
          value: {
            tag: "field",
            object: { tag: "var", name: temp },
            name: item.name,
          },
        });
      }

      continue;
    }

    if (stmt.tag === "bind") {
      if (
        stmt.value.tag === "app" && stmt.value.func.tag === "var"
      ) {
        const module = elaboration.modules.get(stmt.value.func.name);

        if (module) {
          expect(
            module.params.length === stmt.value.args.length,
            "Module argument count mismatch: " + stmt.value.func.name,
          );
          const replacements = new Map<string, FrontExpr>();

          for (let index = 0; index < module.params.length; index += 1) {
            const param = module.params[index];
            const arg = stmt.value.args[index];
            expect(param, "Missing module parameter");
            expect(arg, "Missing module argument");
            replacements.set(param.name, arg);
          }

          const body = substitute_front_expr(module.body, replacements);
          expect(
            body.tag === "block",
            "Module initializer body must be a block",
          );
          const body_statements = [...body.statements];
          const export_stmt = body_statements.pop();
          expect(
            export_stmt && export_stmt.tag === "return" &&
              export_stmt.value.tag === "struct_value",
            "Module initializer must return an export record",
          );
          result.push(...rewrite_statements(
            body_statements,
            providers,
            elaboration,
          ));

          let field_patterns:
            | Array<{ name: string; pattern: Pattern }>
            | undefined;
          let rest_pattern: Pattern | undefined;

          if (stmt.pattern?.tag === "record") {
            field_patterns = stmt.pattern.fields;
            rest_pattern = stmt.pattern.rest;
          } else if (stmt.pattern?.tag === "product") {
            field_patterns = [];

            for (const entry of stmt.pattern.entries) {
              if (entry.label === undefined) {
                field_patterns = undefined;
                break;
              }

              field_patterns.push({
                name: entry.label,
                pattern: entry.pattern,
              });
            }
          }

          if (field_patterns === undefined) {
            result.push({
              ...stmt,
              value: rewrite_expr(
                export_stmt.value,
                providers,
                elaboration,
              ),
            });
            continue;
          }

          const selected_names = new Set<string>();

          for (const field_pattern of field_patterns) {
            selected_names.add(field_pattern.name);
            const field = export_stmt.value.fields.find((candidate) => {
              return candidate.name === field_pattern.name;
            });
            expect(
              field,
              "Module " + stmt.value.func.name + " does not export " +
                field_pattern.name,
            );

            if (
              field_pattern.pattern.tag === "binding" &&
              field.value.tag === "var" &&
              field.value.name === field_pattern.pattern.name &&
              elaboration.effect_functions.has(field_pattern.pattern.name)
            ) {
              continue;
            }

            let name = "@no_demand_module_pattern_" + next_pattern.toString();
            let is_linear = false;
            let annotation: string | undefined;
            let type_annotation: TypeExpr | undefined;
            next_pattern += 1;

            if (field_pattern.pattern.tag === "binding") {
              name = field_pattern.pattern.name;
              is_linear = field_pattern.pattern.mode === "linear";
              annotation = field_pattern.pattern.annotation;
              type_annotation = field_pattern.pattern.type_annotation;
            }

            result.push({
              tag: "bind",
              kind: stmt.kind,
              pattern: field_pattern.pattern,
              name,
              is_recursive: false,
              is_linear,
              annotation,
              type_annotation,
              value: rewrite_expr(field.value, providers, elaboration),
            });
          }

          if (rest_pattern !== undefined && rest_pattern.tag !== "wildcard") {
            const rest_fields = export_stmt.value.fields.filter((field) => {
              return !selected_names.has(field.name);
            }).map((field) => {
              return {
                ...field,
                value: rewrite_expr(field.value, providers, elaboration),
              };
            });
            let name = "@no_demand_module_pattern_" + next_pattern.toString();
            let is_linear = false;
            let annotation: string | undefined;
            let type_annotation: TypeExpr | undefined;
            next_pattern += 1;

            if (rest_pattern.tag === "binding") {
              name = rest_pattern.name;
              is_linear = rest_pattern.mode === "linear";
              annotation = rest_pattern.annotation;
              type_annotation = rest_pattern.type_annotation;
            }

            result.push({
              tag: "bind",
              kind: stmt.kind,
              pattern: rest_pattern,
              name,
              is_recursive: false,
              is_linear,
              annotation,
              type_annotation,
              value: {
                tag: "struct_value",
                type_expr: { tag: "var", name: "object_type" },
                fields: rest_fields,
              },
            });
          }

          continue;
        }
      }

      if (elaboration.modules.has(stmt.name)) {
        continue;
      }

      const function_fact = elaboration.analysis.functions[stmt.name];

      if (
        function_fact &&
        (stmt.value.tag === "lam" || stmt.value.tag === "rec")
      ) {
        if (stmt.value.tag === "lam") {
          continue;
        }

        const hidden = hidden_effect_params(function_fact.effects);
        const local_providers = new Map<string, FrontExpr>();

        for (const effect of function_fact.effects) {
          if (local_providers.has(effect.effect)) {
            continue;
          }

          const param_name = "fx_" + pascal_to_snake(effect.effect);
          local_providers.set(effect.effect, { tag: "var", name: param_name });
        }

        result.push({
          ...stmt,
          annotation: undefined,
          type_annotation: undefined,
          effectful: undefined,
          value: {
            ...stmt.value,
            params: [
              ...hidden,
              ...apply_function_parameter_types(
                stmt.value.params,
                stmt.type_annotation,
                elaboration,
              ),
            ],
            body: rewrite_expr(
              stmt.value.body,
              local_providers,
              elaboration,
            ),
          },
        });
        continue;
      }

      let annotation = stmt.annotation;
      let type_annotation: TypeExpr | undefined;

      if (function_type_expr(stmt.type_annotation)) {
        expect(
          stmt.value.tag === "lam" || stmt.value.tag === "rec",
          "Function type annotation requires a function value: " + stmt.name,
        );
        annotation = undefined;
        type_annotation = stmt.type_annotation;
      } else if (
        stmt.type_annotation?.tag === "apply" &&
        !elaboration.type_names.has(
          type_application_root_name(stmt.type_annotation),
        )
      ) {
        throw new Error(
          "Rich type annotation is not lowered yet on " + stmt.name,
        );
      } else if (
        stmt.type_annotation?.tag === "tuple" ||
        stmt.type_annotation?.tag === "product"
      ) {
        throw new Error(
          "Rich type annotation is not lowered yet on " + stmt.name,
        );
      }

      result.push({
        ...stmt,
        annotation,
        type_annotation,
        effectful: undefined,
        value: rewrite_expr(
          apply_binding_function_type(
            stmt.value,
            stmt.type_annotation,
            elaboration,
          ),
          providers,
          elaboration,
        ),
      });
      continue;
    }

    result.push(rewrite_stmt(stmt, providers, elaboration));
  }

  return result;
}

function type_application_root_name(type: TypeExpr): string {
  let current = type;

  while (current.tag === "apply") {
    current = current.func;
  }

  if (current.tag !== "name") {
    return "";
  }

  return current.name;
}

function front_expr_is_type_constructor(value: FrontExpr): boolean {
  if (value.tag === "captured" || value.tag === "comptime") {
    return front_expr_is_type_constructor(value.expr);
  }

  if (value.tag === "lam") {
    return front_expr_is_type_constructor(value.body);
  }

  return value.tag === "struct_type" || value.tag === "union_type" ||
    value.tag === "set_type";
}

function apply_binding_function_type(
  value: FrontExpr,
  type: TypeExpr | undefined,
  elaboration: EffectElaboration,
): FrontExpr {
  if (
    !type || type.tag !== "arrow" ||
    (value.tag !== "lam" && value.tag !== "rec")
  ) {
    return value;
  }

  return {
    ...value,
    params: apply_function_parameter_types(value.params, type, elaboration),
  };
}

function apply_function_parameter_types(
  params: Param[],
  type: TypeExpr | undefined,
  elaboration: EffectElaboration,
): Param[] {
  if (!type || type.tag !== "arrow") {
    return params;
  }

  let types: TypeExpr[] = [type.param];

  if (type.param.tag === "tuple") {
    types = type.param.items;
  }

  if (type.param.tag === "product") {
    types = expanded_type_product_entries(
      type.param,
      (name) =>
        effect_elaboration_const_i32_name(
          name,
          elaboration,
          new Set(),
        ),
    ).map((entry) => entry.type_expr);
  }

  return params.map((param, index) => {
    const param_type = types[index];
    expect(param_type, "Missing function parameter type " + index.toString());

    if (param.annotation || param.type_annotation) {
      return param;
    }

    return {
      ...param,
      annotation: format_type_expr(param_type),
      type_annotation: param_type,
    };
  });
}

function effect_elaboration_const_i32_name(
  name: string,
  elaboration: EffectElaboration,
  resolving: Set<string>,
): number | undefined {
  if (resolving.has(name)) {
    return undefined;
  }

  const value = elaboration.const_values.get(name);

  if (value === undefined) {
    return undefined;
  }

  const next = new Set(resolving);
  next.add(name);
  return const_i32_value(
    value,
    (nested_name) =>
      effect_elaboration_const_i32_name(nested_name, elaboration, next),
  );
}

function hidden_effect_params(effects: EffectRef[]): Param[] {
  const names = new Set<string>();
  const params: Param[] = [];

  for (const effect of effects) {
    if (names.has(effect.effect)) {
      continue;
    }

    names.add(effect.effect);
    params.push({
      name: "fx_" + pascal_to_snake(effect.effect),
      is_const: false,
      is_linear: false,
      annotation: "I32",
    });
  }

  return params;
}

function rewrite_stmt(
  stmt: Stmt,
  providers: Map<string, FrontExpr>,
  elaboration: EffectElaboration,
): Stmt {
  if (stmt.tag === "assign") {
    return {
      ...stmt,
      value: rewrite_expr(stmt.value, providers, elaboration),
    };
  }

  if (stmt.tag === "index_assign") {
    return {
      ...stmt,
      index: rewrite_expr(stmt.index, providers, elaboration),
      value: rewrite_expr(stmt.value, providers, elaboration),
    };
  }

  if (stmt.tag === "expr") {
    return {
      tag: "expr",
      expr: rewrite_expr(stmt.expr, providers, elaboration),
    };
  }

  if (stmt.tag === "return") {
    return {
      tag: "return",
      value: rewrite_expr(stmt.value, providers, elaboration),
    };
  }

  if (stmt.tag === "break" && stmt.value) {
    return {
      tag: "break",
      value: rewrite_expr(stmt.value, providers, elaboration),
    };
  }

  if (stmt.tag === "for_range") {
    return {
      ...stmt,
      start: rewrite_expr(stmt.start, providers, elaboration),
      end: rewrite_expr(stmt.end, providers, elaboration),
      step: rewrite_expr(stmt.step, providers, elaboration),
      body: rewrite_statements(stmt.body, providers, elaboration),
    };
  }

  if (stmt.tag === "for_collection") {
    return {
      ...stmt,
      collection: rewrite_expr(
        stmt.collection,
        providers,
        elaboration,
      ),
      body: rewrite_statements(stmt.body, providers, elaboration),
    };
  }

  if (stmt.tag === "if_stmt") {
    return {
      ...stmt,
      cond: rewrite_expr(stmt.cond, providers, elaboration),
      body: rewrite_statements(stmt.body, providers, elaboration),
    };
  }

  if (stmt.tag === "if_let_stmt") {
    return {
      ...stmt,
      target: rewrite_expr(stmt.target, providers, elaboration),
      body: rewrite_statements(stmt.body, providers, elaboration),
    };
  }

  if (stmt.tag === "type_check") {
    return {
      ...stmt,
      target: rewrite_expr(stmt.target, providers, elaboration),
    };
  }

  return stmt;
}

function rewrite_expr(
  expr: FrontExpr,
  providers: Map<string, FrontExpr>,
  elaboration: EffectElaboration,
): FrontExpr {
  if (expr.tag === "unit") {
    return { tag: "num", type: "i32", value: 0 };
  }

  if (expr.tag === "handler" || expr.tag === "try_with") {
    throw new Error("Duck handler must be elaborated before host effects");
  }

  if (expr.tag === "app") {
    const effect = effect_call(expr, elaboration);
    const args = expr.args.map((arg) => {
      const rewritten = rewrite_expr(arg, providers, elaboration);

      if (rewritten.tag === "lam") {
        return {
          ...rewritten,
          body: scope_inlined_returns(rewritten.body),
        };
      }

      return rewritten;
    });

    if (effect) {
      const provider = providers.get(effect.effect);
      expect(
        provider,
        "Missing lexical provider for effect " + effect.effect,
      );
      return {
        tag: "app",
        func: {
          tag: "var",
          name: effect_import_name(effect.effect, effect.operation),
        },
        args: [provider, ...args],
      };
    }

    let called: FrontEffectFunction | undefined;

    if (expr.func.tag === "var") {
      called = elaboration.analysis.functions[expr.func.name];
    }

    let rewritten_func = expr.func;

    if (!called) {
      rewritten_func = rewrite_expr(
        expr.func,
        providers,
        elaboration,
      );
    }

    if (expr.func.tag === "var") {
      if (called) {
        const hidden_args: FrontExpr[] = [];
        const seen = new Set<string>();

        for (const called_effect of called.effects) {
          if (seen.has(called_effect.effect)) {
            continue;
          }

          seen.add(called_effect.effect);
          const provider = providers.get(called_effect.effect);
          expect(
            provider,
            "Missing lexical provider for effect " + called_effect.effect +
              " while calling " + called.name,
          );
          hidden_args.push(provider);
        }

        const call_args = [...hidden_args, ...args];
        const effect_function = elaboration.effect_functions.get(
          expr.func.name,
        );

        if (effect_function && effect_function.value.tag === "lam") {
          const fact = elaboration.analysis.functions[expr.func.name];
          expect(fact, "Missing effect function analysis: " + expr.func.name);
          const local_providers = new Map<string, FrontExpr>();

          for (const effect of fact.effects) {
            if (!local_providers.has(effect.effect)) {
              local_providers.set(effect.effect, {
                tag: "var",
                name: "fx_" + pascal_to_snake(effect.effect),
              });
            }
          }

          const hidden_params = hidden_effect_params(fact.effects);
          const params = [...hidden_params, ...effect_function.value.params];
          expect(
            params.length === call_args.length,
            "Effect function argument count mismatch: " + expr.func.name,
          );
          const replacements = new Map<string, FrontExpr>();

          for (let index = 0; index < params.length; index += 1) {
            const param = params[index];
            const arg = call_args[index];
            expect(param, "Missing effect function parameter");
            expect(arg, "Missing effect function argument");
            replacements.set(param.name, arg);
          }

          const body = scope_inlined_returns(rewrite_expr(
            effect_function.value.body,
            local_providers,
            elaboration,
          ));
          return substitute_front_expr(body, replacements);
        }

        return { ...expr, func: rewritten_func, args: call_args };
      }
    }

    return { ...expr, func: rewritten_func, args };
  }

  if (expr.tag === "block") {
    return {
      tag: "block",
      statements: rewrite_statements(
        expr.statements,
        providers,
        elaboration,
      ),
    };
  }

  if (expr.tag === "prim") {
    return {
      ...expr,
      left: rewrite_expr(expr.left, providers, elaboration),
      right: rewrite_expr(expr.right, providers, elaboration),
    };
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return {
      ...expr,
      body: rewrite_expr(expr.body, providers, elaboration),
    };
  }

  if (expr.tag === "comptime") {
    return {
      ...expr,
      expr: rewrite_expr(expr.expr, providers, elaboration),
    };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, elaboration),
    };
  }

  if (expr.tag === "scratch") {
    return {
      ...expr,
      body: rewrite_expr(expr.body, providers, elaboration),
    };
  }

  if (expr.tag === "loop") {
    return {
      tag: "loop",
      body: rewrite_statements(expr.body, providers, elaboration),
    };
  }

  if (expr.tag === "captured") {
    return {
      ...expr,
      expr: rewrite_expr(expr.expr, providers, elaboration),
    };
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    return {
      ...expr,
      base: rewrite_expr(expr.base, providers, elaboration),
      fields: rewrite_fields(expr.fields, providers, elaboration),
    };
  }

  if (expr.tag === "type_with") {
    return {
      ...expr,
      base: rewrite_expr(expr.base, providers, elaboration),
      members: expr.members.map((member) => ({
        name: rewrite_expr(member.name, providers, elaboration),
        value: rewrite_expr(member.value, providers, elaboration),
      })),
    };
  }

  if (expr.tag === "struct_value") {
    return {
      ...expr,
      type_expr: rewrite_expr(expr.type_expr, providers, elaboration),
      fields: rewrite_fields(expr.fields, providers, elaboration),
    };
  }

  if (expr.tag === "product" || expr.tag === "shape") {
    return {
      ...expr,
      entries: expr.entries.map((entry) => ({
        ...entry,
        value: rewrite_expr(entry.value, providers, elaboration),
      })),
    };
  }

  if (expr.tag === "array") {
    let rest = expr.rest;

    if (rest !== undefined) {
      rest = rewrite_expr(rest, providers, elaboration);
    }

    return {
      ...expr,
      items: expr.items.map((item) =>
        rewrite_expr(item, providers, elaboration)
      ),
      rest,
    };
  }

  if (expr.tag === "array_repeat") {
    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, elaboration),
      length: rewrite_expr(expr.length, providers, elaboration),
    };
  }

  if (expr.tag === "as") {
    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, elaboration),
    };
  }

  if (expr.tag === "if") {
    return {
      ...expr,
      cond: rewrite_expr(expr.cond, providers, elaboration),
      then_branch: rewrite_expr(
        expr.then_branch,
        providers,
        elaboration,
      ),
      else_branch: rewrite_expr(
        expr.else_branch,
        providers,
        elaboration,
      ),
    };
  }

  if (expr.tag === "if_let") {
    return {
      ...expr,
      target: rewrite_expr(expr.target, providers, elaboration),
      then_branch: rewrite_expr(
        expr.then_branch,
        providers,
        elaboration,
      ),
      else_branch: rewrite_expr(
        expr.else_branch,
        providers,
        elaboration,
      ),
    };
  }

  if (expr.tag === "match") {
    return {
      ...expr,
      target: rewrite_expr(expr.target, providers, elaboration),
      arms: expr.arms.map((arm) => {
        let guard = arm.guard;

        if (guard !== undefined) {
          guard = rewrite_expr(guard, providers, elaboration);
        }

        return {
          ...arm,
          guard,
          body: rewrite_expr(arm.body, providers, elaboration),
        };
      }),
    };
  }

  if (expr.tag === "field") {
    return {
      ...expr,
      object: rewrite_expr(expr.object, providers, elaboration),
    };
  }

  if (expr.tag === "index") {
    return {
      ...expr,
      object: rewrite_expr(expr.object, providers, elaboration),
      index: rewrite_expr(expr.index, providers, elaboration),
    };
  }

  if (expr.tag === "union_case" && expr.value) {
    if (expr.value.tag === "unit") {
      return expr;
    }

    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, elaboration),
    };
  }

  if (expr.tag === "var") {
    const fact = elaboration.analysis.functions[expr.name];

    if (fact) {
      throw new Error(
        "Effectful named function " + expr.name +
          " cannot be used as a value yet; wrap it in an anonymous callback",
      );
    }
  }

  return expr;
}

function rewrite_fields(
  fields: Field[],
  providers: Map<string, FrontExpr>,
  elaboration: EffectElaboration,
): Field[] {
  return fields.map((field) => {
    return {
      ...field,
      value: rewrite_expr(field.value, providers, elaboration),
    };
  });
}

function effect_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  elaboration: EffectElaboration,
): EffectRef | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  if (expr.func.object.tag === "var") {
    const effect = elaboration.effects.get(expr.func.object.name);

    if (effect) {
      const operation_name = expr.func.name;
      const operation = effect.operations.find((item) => {
        return item.name === operation_name;
      });
      expect(
        operation,
        "Unknown effect operation: " + effect.name + "." + operation_name,
      );
      return { effect: effect.name, operation: operation.name };
    }
  }

  return undefined;
}

function effect_import_name(effect: string, operation: string): string {
  return "__duck_effect_" + effect + "_" + operation;
}

function pascal_to_snake(name: string): string {
  let result = "";

  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];
    expect(character, "Missing effect name character");

    if (index > 0 && character >= "A" && character <= "Z") {
      result += "_";
    }

    result += character.toLowerCase();
  }

  return result;
}
