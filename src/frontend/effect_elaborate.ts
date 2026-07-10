import { expect } from "../expect.ts";
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
  RecordDeclaration,
  Source,
  Stmt,
} from "./ast.ts";
import {
  analyze_front_effects,
  type FrontEffectAnalysis,
} from "./effect_analysis.ts";
import { elaborate_front_handlers } from "./handler_elaborate.ts";
import { substitute_front_expr } from "./substitute.ts";

type EffectElaboration = {
  analysis: FrontEffectAnalysis;
  effects: Map<string, EffectDeclaration>;
  operations: Map<string, EffectRef[]>;
  records: Map<string, RecordDeclaration>;
  modules: Map<string, Extract<FrontExpr, { tag: "lam" }>>;
  effect_functions: Map<
    string,
    Extract<Stmt, { tag: "bind" }> & {
      value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
    }
  >;
};

export function elaborate_front_effects(source: Source): Source {
  const declarations = source.declarations || [];
  const elaboration = create_elaboration(source);
  const prefix: Stmt[] = [];

  for (const declaration of declarations) {
    if (declaration.tag === "record") {
      prefix.push(record_type_binding(declaration, elaboration.effects));
    } else if (declaration.implementation === "host") {
      for (const operation of declaration.operations) {
        prefix.push({
          tag: "host_import",
          value: effect_host_import(declaration, operation),
        });
      }
    }
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
        "Init field " + field.name + " cannot provide Ix effect " +
          effect.name,
      );
      const getter_name = "__ix_init_" + field.name;
      prefix.push({
        tag: "host_import",
        value: {
          name: getter_name,
          module: "ix_init",
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
  const statements = rewrite_statements(
    handler_source.statements,
    providers,
    undefined,
    elaboration,
  );
  materialize_module_result_type(statements, prefix);

  return { tag: "program", statements: [...prefix, ...statements] };
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
  const type_name = "ix_entry_result_type";
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
    return bindings.get(expr.name);
  }

  if (expr.tag === "prim") {
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

    if (expr.func.name === "len" || expr.func.name === "get") {
      return "I32";
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

  if (expr.tag === "if") {
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
  const effects = new Map<string, EffectDeclaration>();
  const operations = new Map<string, EffectRef[]>();
  const records = new Map<string, RecordDeclaration>();
  const modules = new Map<string, Extract<FrontExpr, { tag: "lam" }>>();
  const effect_functions = new Map<
    string,
    Extract<Stmt, { tag: "bind" }> & {
      value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
    }
  >();

  for (const declaration of source.declarations || []) {
    if (declaration.tag === "record") {
      records.set(declaration.name, declaration);
      continue;
    }

    effects.set(declaration.name, declaration);

    for (const operation of declaration.operations) {
      const refs = operations.get(operation.name);
      const ref = { effect: declaration.name, operation: operation.name };

      if (refs) {
        refs.push(ref);
      } else {
        operations.set(operation.name, [ref]);
      }
    }
  }

  for (const stmt of source.statements) {
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
  collect_effect_function_bindings(source.statements, effect_functions);

  return {
    analysis: analyze_front_effects(source),
    effects,
    operations,
    records,
    modules,
    effect_functions,
  };
}

function collect_effect_function_bindings(
  statements: Stmt[],
  result: EffectElaboration["effect_functions"],
): void {
  for (const stmt of statements) {
    if (
      stmt.tag === "bind" && stmt.effect_context &&
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
      collect_effect_function_bindings(stmt.value.body.statements, result);
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
): FrontHostImport {
  const args: FrontHostImportArgContract[] = [{ tag: "scalar" }];
  const params: ValType[] = ["i32"];

  for (const param of operation.params) {
    params.push(effect_value_type(param.type_name));
    args.push(effect_arg_contract(param));
  }

  return {
    name: effect_import_name(effect.name, operation.name),
    module: "ix_effect",
    field: effect.name + "." + operation.name,
    params,
    result: effect_value_type(operation.result.type_name),
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

  return { tag: "type_ref", name: type_name };
}

function effect_value_type(type_name: string): ValType {
  if (type_name === "I64") {
    return "i64";
  }

  return "i32";
}

function rewrite_statements(
  statements: Stmt[],
  providers: Map<string, FrontExpr>,
  context: string | undefined,
  elaboration: EffectElaboration,
): Stmt[] {
  const result: Stmt[] = [];
  let next_pattern = 0;

  for (const stmt of statements) {
    if (stmt.tag === "state_bind") {
      expect(context, "Effect state binding requires a function context");
      expect(
        stmt.context === context,
        "Effect state binding renews the wrong context: " + stmt.context,
      );
      const value = rewrite_expr(stmt.value, providers, context, elaboration);
      let annotation: string | undefined;

      if (stmt.value.tag === "app") {
        const operation_ref = effect_call(stmt.value, context, elaboration);

        if (operation_ref) {
          const effect = elaboration.effects.get(operation_ref.effect);
          const operation = effect?.operations.find((item) => {
            return item.name === operation_ref.operation;
          });

          if (operation && operation.result.type_name !== "Unit") {
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
            context,
            elaboration,
          ));

          for (const item of stmt.items) {
            const field = export_stmt.value.fields.find((candidate) => {
              return candidate.name === item.name;
            });
            expect(
              field,
              "Missing module export " + item.name + " from " +
                stmt.value.func.name,
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
                context,
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
        value: rewrite_expr(stmt.value, providers, context, elaboration),
      });

      for (const item of stmt.items) {
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
      if (elaboration.modules.has(stmt.name)) {
        continue;
      }

      if (
        stmt.effect_context &&
        (stmt.value.tag === "lam" || stmt.value.tag === "rec")
      ) {
        if (stmt.value.tag === "lam") {
          continue;
        }

        const function_fact = elaboration.analysis.functions[stmt.name];
        expect(function_fact, "Missing inferred effects for " + stmt.name);
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
          effect_context: undefined,
          value: {
            ...stmt.value,
            params: [...hidden, ...stmt.value.params],
            body: rewrite_expr(
              stmt.value.body,
              local_providers,
              stmt.effect_context.name,
              elaboration,
            ),
          },
        });
        continue;
      }

      result.push({
        ...stmt,
        effect_context: undefined,
        value: rewrite_expr(stmt.value, providers, context, elaboration),
      });
      continue;
    }

    result.push(rewrite_stmt(stmt, providers, context, elaboration));
  }

  return result;
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
  context: string | undefined,
  elaboration: EffectElaboration,
): Stmt {
  if (stmt.tag === "assign") {
    return {
      ...stmt,
      value: rewrite_expr(stmt.value, providers, context, elaboration),
    };
  }

  if (stmt.tag === "index_assign") {
    return {
      ...stmt,
      index: rewrite_expr(stmt.index, providers, context, elaboration),
      value: rewrite_expr(stmt.value, providers, context, elaboration),
    };
  }

  if (stmt.tag === "expr") {
    return {
      tag: "expr",
      expr: rewrite_expr(stmt.expr, providers, context, elaboration),
    };
  }

  if (stmt.tag === "return") {
    return {
      tag: "return",
      value: rewrite_expr(stmt.value, providers, context, elaboration),
    };
  }

  if (stmt.tag === "for_range") {
    return {
      ...stmt,
      start: rewrite_expr(stmt.start, providers, context, elaboration),
      end: rewrite_expr(stmt.end, providers, context, elaboration),
      step: rewrite_expr(stmt.step, providers, context, elaboration),
      body: rewrite_statements(stmt.body, providers, context, elaboration),
    };
  }

  if (stmt.tag === "for_collection") {
    return {
      ...stmt,
      collection: rewrite_expr(
        stmt.collection,
        providers,
        context,
        elaboration,
      ),
      body: rewrite_statements(stmt.body, providers, context, elaboration),
    };
  }

  if (stmt.tag === "if_stmt") {
    return {
      ...stmt,
      cond: rewrite_expr(stmt.cond, providers, context, elaboration),
      body: rewrite_statements(stmt.body, providers, context, elaboration),
    };
  }

  if (stmt.tag === "if_let_stmt") {
    return {
      ...stmt,
      target: rewrite_expr(stmt.target, providers, context, elaboration),
      body: rewrite_statements(stmt.body, providers, context, elaboration),
    };
  }

  if (stmt.tag === "type_check") {
    return {
      ...stmt,
      target: rewrite_expr(stmt.target, providers, context, elaboration),
    };
  }

  return stmt;
}

function rewrite_expr(
  expr: FrontExpr,
  providers: Map<string, FrontExpr>,
  context: string | undefined,
  elaboration: EffectElaboration,
): FrontExpr {
  if (expr.tag === "unit") {
    return { tag: "num", type: "i32", value: 0 };
  }

  if (expr.tag === "handler" || expr.tag === "try_with") {
    throw new Error("Ix handler must be elaborated before host effects");
  }

  if (expr.tag === "app") {
    const effect = effect_call(expr, context, elaboration);
    const args = expr.args.map((arg) => {
      return rewrite_expr(arg, providers, context, elaboration);
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

    const rewritten_func = rewrite_expr(
      expr.func,
      providers,
      context,
      elaboration,
    );

    if (expr.func.tag === "var") {
      const called = elaboration.analysis.functions[expr.func.name];

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

          const body = rewrite_expr(
            effect_function.value.body,
            local_providers,
            effect_function.effect_context?.name,
            elaboration,
          );
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
        context,
        elaboration,
      ),
    };
  }

  if (expr.tag === "prim") {
    return {
      ...expr,
      left: rewrite_expr(expr.left, providers, context, elaboration),
      right: rewrite_expr(expr.right, providers, context, elaboration),
    };
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return {
      ...expr,
      body: rewrite_expr(expr.body, providers, context, elaboration),
    };
  }

  if (expr.tag === "comptime") {
    return {
      ...expr,
      expr: rewrite_expr(expr.expr, providers, context, elaboration),
    };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, context, elaboration),
    };
  }

  if (expr.tag === "scratch") {
    return {
      ...expr,
      body: rewrite_expr(expr.body, providers, context, elaboration),
    };
  }

  if (expr.tag === "captured") {
    return {
      ...expr,
      expr: rewrite_expr(expr.expr, providers, context, elaboration),
    };
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    return {
      ...expr,
      base: rewrite_expr(expr.base, providers, context, elaboration),
      fields: rewrite_fields(expr.fields, providers, context, elaboration),
    };
  }

  if (expr.tag === "struct_value") {
    return {
      ...expr,
      type_expr: rewrite_expr(expr.type_expr, providers, context, elaboration),
      fields: rewrite_fields(expr.fields, providers, context, elaboration),
    };
  }

  if (expr.tag === "if") {
    return {
      ...expr,
      cond: rewrite_expr(expr.cond, providers, context, elaboration),
      then_branch: rewrite_expr(
        expr.then_branch,
        providers,
        context,
        elaboration,
      ),
      else_branch: rewrite_expr(
        expr.else_branch,
        providers,
        context,
        elaboration,
      ),
    };
  }

  if (expr.tag === "if_let") {
    return {
      ...expr,
      target: rewrite_expr(expr.target, providers, context, elaboration),
      then_branch: rewrite_expr(
        expr.then_branch,
        providers,
        context,
        elaboration,
      ),
      else_branch: rewrite_expr(
        expr.else_branch,
        providers,
        context,
        elaboration,
      ),
    };
  }

  if (expr.tag === "field") {
    return {
      ...expr,
      object: rewrite_expr(expr.object, providers, context, elaboration),
    };
  }

  if (expr.tag === "index") {
    return {
      ...expr,
      object: rewrite_expr(expr.object, providers, context, elaboration),
      index: rewrite_expr(expr.index, providers, context, elaboration),
    };
  }

  if (expr.tag === "union_case" && expr.value) {
    return {
      ...expr,
      value: rewrite_expr(expr.value, providers, context, elaboration),
    };
  }

  return expr;
}

function rewrite_fields(
  fields: Field[],
  providers: Map<string, FrontExpr>,
  context: string | undefined,
  elaboration: EffectElaboration,
): Field[] {
  return fields.map((field) => {
    return {
      ...field,
      value: rewrite_expr(field.value, providers, context, elaboration),
    };
  });
}

function effect_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  context: string | undefined,
  elaboration: EffectElaboration,
): EffectRef | undefined {
  if (!context || expr.func.tag !== "field") {
    return undefined;
  }

  if (expr.func.object.tag === "var" && expr.func.object.name === context) {
    const candidates = elaboration.operations.get(expr.func.name) || [];
    expect(
      candidates.length === 1,
      "Ambiguous effect operation: " + expr.func.name,
    );
    return candidates[0];
  }

  if (
    expr.func.object.tag === "field" &&
    expr.func.object.object.tag === "var" &&
    expr.func.object.object.name === context
  ) {
    return {
      effect: expr.func.object.name,
      operation: expr.func.name,
    };
  }

  return undefined;
}

function effect_import_name(effect: string, operation: string): string {
  return "__ix_effect_" + effect + "_" + operation;
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
