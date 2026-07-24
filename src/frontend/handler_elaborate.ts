import { expect } from "../expect.ts";
import type {
  EffectDeclaration,
  EffectOperation,
  EffectRef,
  FrontExpr,
  ResumeSignature,
  Source,
  Stmt,
} from "./ast.ts";
import type { FrontEffectAnalysis } from "./effect_analysis.ts";
import { specialize_effect_operation } from "./effect_operation.ts";
import { substitute_front_expr } from "./substitute.ts";
import { prim_returns_bool } from "./numeric.ts";
import { format_type_expr, function_type_expr } from "./type_expr.ts";

type HandlerExpr = Extract<FrontExpr, { tag: "handler" }>;

type EffectIndex = {
  effects: Map<string, EffectDeclaration>;
};

type EffectFunction = {
  name: string;
  value: Extract<FrontExpr, { tag: "lam" | "rec" }>;
};

type HandlerRecipe = {
  key: string;
  handler: HandlerExpr;
  prefix: Stmt[];
  affine: boolean;
};

type ActiveHandler = {
  id: number;
  recipe: HandlerRecipe;
  effect: EffectDeclaration;
  state_names: Set<string>;
  output_type: string | undefined;
  outer_ctx: CompileCtx;
  continue_after: CpsCont;
};

type ValueKind =
  | "scalar"
  | "frozen"
  | "unique"
  | "borrow"
  | "scratch"
  | "resource"
  | "resume"
  | "unknown";

type ResumeSpec = {
  name: string;
  input_type: string;
  output_type: string | undefined;
  handler_id: number;
  captured_handlers: ActiveHandler[];
  continue_with: (value: FrontExpr) => CpsResult;
  captures: Map<string, ValueKind>;
  used: boolean;
};

type EscapedResume = {
  signature: ResumeSignature;
  used: boolean;
};

type HandlerUse = {
  count: number;
};

type CompileCtx = {
  active: ActiveHandler[];
  delimiters: ActiveHandler[];
  resumptions: Map<string, ResumeSpec>;
  resume_cases: Map<string, Map<string, ResumeSignature>>;
  resume_fields: Map<string, Map<string, ResumeSignature>>;
  escaped_resumptions: Map<string, EscapedResume>;
  unavailable_state: Set<number>;
  values: Map<string, ValueKind>;
  functions: Map<string, EffectFunction | undefined>;
  active_calls: Set<string>;
};

type CpsResult = {
  expr: FrontExpr;
  target: number | undefined;
  ctx: CompileCtx;
};

type CpsCont = (value: FrontExpr, ctx: CompileCtx) => CpsResult;

export type HandlerElaborationOptions = {
  providers: Map<string, FrontExpr>;
  analysis: FrontEffectAnalysis;
};

type Elaboration = {
  source: Source;
  index: EffectIndex;
  analysis: FrontEffectAnalysis;
  providers: Map<string, FrontExpr>;
  functions: Map<string, EffectFunction>;
  static_names: Set<string>;
  handlers: Map<string, HandlerRecipe>;
  handler_uses: Map<string, HandlerUse>;
  resume_value_signatures: WeakMap<object, ResumeSignature>;
  next_handler: number;
  next_resume: number;
  next_factory: number;
  next_loop: number;
  effect_loops: WeakSet<object>;
};

export function elaborate_front_handlers(
  source: Source,
  options: HandlerElaborationOptions,
): Source {
  if (!has_duck_effects(source) && !source_contains_handlers(source)) {
    return source;
  }

  const elaboration = create_elaboration(source, options);
  collect_top_level_facts(source.statements, elaboration);
  const ctx = create_compile_ctx(source, elaboration);
  const statements = rewrite_top_level_statements(
    source.statements,
    ctx,
    elaboration,
  );
  validate_handler_uses(elaboration);
  return { ...source, statements };
}

function has_duck_effects(source: Source): boolean {
  for (const declaration of source.declarations || []) {
    if (
      declaration.tag === "effect" && declaration.implementation === "duck"
    ) {
      return true;
    }
  }

  return false;
}

function source_contains_handlers(source: Source): boolean {
  for (const stmt of source.statements) {
    if (stmt_contains_handler(stmt)) {
      return true;
    }
  }

  return false;
}

function stmt_contains_handler(stmt: Stmt): boolean {
  if (stmt.tag === "bind") {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "resume_dup") {
    return true;
  }

  if (stmt.tag === "assign") {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "index_assign") {
    return expr_contains_handler(stmt.index) ||
      expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "for_range") {
    if (
      expr_contains_handler(stmt.start) || expr_contains_handler(stmt.end) ||
      expr_contains_handler(stmt.step)
    ) {
      return true;
    }

    return stmt.body.some(stmt_contains_handler);
  }

  if (stmt.tag === "for_collection") {
    return expr_contains_handler(stmt.collection) ||
      stmt.body.some(stmt_contains_handler);
  }

  if (stmt.tag === "if_stmt") {
    return expr_contains_handler(stmt.cond) ||
      stmt.body.some(stmt_contains_handler);
  }

  if (stmt.tag === "if_let_stmt") {
    return expr_contains_handler(stmt.target) ||
      stmt.body.some(stmt_contains_handler);
  }

  if (stmt.tag === "type_check") {
    return expr_contains_handler(stmt.target);
  }

  if (stmt.tag === "return") {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "break" && stmt.value) {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "expr") {
    return expr_contains_handler(stmt.expr);
  }

  return false;
}

function expr_contains_handler(expr: FrontExpr): boolean {
  if (expr.tag === "handler" || expr.tag === "try_with") {
    return true;
  }

  if (expr.tag === "prim") {
    return expr_contains_handler(expr.left) ||
      expr_contains_handler(expr.right);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return expr_contains_handler(expr.body);
  }

  if (expr.tag === "app") {
    if (expr_contains_handler(expr.func)) {
      return true;
    }

    return expr.args.some(expr_contains_handler);
  }

  if (expr.tag === "block") {
    return expr.statements.some(stmt_contains_handler);
  }

  if (expr.tag === "comptime") {
    return expr_contains_handler(expr.expr);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return expr_contains_handler(expr.value);
  }

  if (expr.tag === "scratch") {
    return expr_contains_handler(expr.body);
  }

  if (expr.tag === "loop") {
    return expr.body.some(stmt_contains_handler);
  }

  if (expr.tag === "captured") {
    return expr_contains_handler(expr.expr);
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    if (expr_contains_handler(expr.base)) {
      return true;
    }

    return expr.fields.some((field) => expr_contains_handler(field.value));
  }

  if (expr.tag === "struct_value") {
    if (expr_contains_handler(expr.type_expr)) {
      return true;
    }

    return expr.fields.some((field) => expr_contains_handler(field.value));
  }

  if (expr.tag === "if") {
    return expr_contains_handler(expr.cond) ||
      expr_contains_handler(expr.then_branch) ||
      expr_contains_handler(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return expr_contains_handler(expr.target) ||
      expr_contains_handler(expr.then_branch) ||
      expr_contains_handler(expr.else_branch);
  }

  if (expr.tag === "field") {
    return expr_contains_handler(expr.object);
  }

  if (expr.tag === "index") {
    return expr_contains_handler(expr.object) ||
      expr_contains_handler(expr.index);
  }

  if (expr.tag === "union_case") {
    if (expr.value && expr_contains_handler(expr.value)) {
      return true;
    }

    if (expr.type_expr && expr_contains_handler(expr.type_expr)) {
      return true;
    }
  }

  return false;
}

function create_elaboration(
  source: Source,
  options: HandlerElaborationOptions,
): Elaboration {
  const effects = new Map<string, EffectDeclaration>();

  for (const declaration of source.declarations || []) {
    if (declaration.tag !== "effect") {
      continue;
    }

    effects.set(declaration.name, declaration);
  }

  return {
    source,
    index: { effects },
    analysis: options.analysis,
    providers: options.providers,
    functions: new Map(),
    static_names: new Set(),
    handlers: new Map(),
    handler_uses: new Map(),
    resume_value_signatures: new WeakMap(),
    next_handler: 0,
    next_resume: 0,
    next_factory: 0,
    next_loop: 0,
    effect_loops: new WeakSet(),
  };
}

function collect_top_level_facts(
  statements: Stmt[],
  elaboration: Elaboration,
): void {
  for (const stmt of statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    elaboration.static_names.add(stmt.name);

    if (
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      function_binding_has_duck_effects(stmt.name, stmt.value, elaboration)
    ) {
      elaboration.functions.set(stmt.name, {
        name: stmt.name,
        value: stmt.value,
      });
    }
  }

  for (const stmt of statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    const recipe = handler_recipe_from_expr(
      stmt.value,
      stmt.name,
      elaboration,
      new Set(),
    );

    if (!recipe) {
      continue;
    }

    elaboration.handlers.set(stmt.name, recipe);
    elaboration.handler_uses.set(recipe.key, { count: 0 });
  }
}

function create_compile_ctx(
  source: Source,
  elaboration: Elaboration,
): CompileCtx {
  const values = new Map<string, ValueKind>();

  if (source.module) {
    for (const param of source.module.params) {
      if (param.annotation === "Init") {
        values.set(param.name, "resource");
      } else {
        values.set(param.name, kind_from_type_name(param.annotation));
      }
    }
  }

  for (const name of elaboration.static_names) {
    if (!values.has(name)) {
      values.set(name, "frozen");
    }
  }

  return {
    active: [],
    delimiters: [],
    resumptions: new Map(),
    resume_cases: new Map(),
    resume_fields: new Map(),
    escaped_resumptions: new Map(),
    unavailable_state: new Set(),
    values,
    functions: new Map(),
    active_calls: new Set(),
  };
}

function rewrite_top_level_statements(
  statements: Stmt[],
  input_ctx: CompileCtx,
  elaboration: Elaboration,
): Stmt[] {
  const result: Stmt[] = [];
  let ctx = clone_compile_ctx(input_ctx);

  for (const stmt of statements) {
    if (stmt.tag === "bind" && elaboration.handlers.has(stmt.name)) {
      continue;
    }

    if (
      stmt.tag === "bind" &&
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      handler_result_expr(stmt.value.body)
    ) {
      continue;
    }

    if (
      stmt.tag === "bind" &&
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      stmt.value.params.some((param) => param.annotation === "Resume")
    ) {
      continue;
    }

    if (stmt.tag === "resume_dup") {
      throw new Error(
        "Resumption duplication is only valid inside a handler clause",
      );
    }

    if (stmt.tag === "bind") {
      if (
        (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
        function_binding_has_duck_effects(stmt.name, stmt.value, elaboration)
      ) {
        continue;
      }

      const compiled = compile_expr(
        stmt.value,
        ctx,
        (value, next_ctx) => normal_result(value, next_ctx),
        elaboration,
      );
      expect(
        compiled.target === undefined,
        "Local handler escape reached a top-level binding",
      );
      result.push({ ...stmt, value: compiled.expr });
      ctx = clone_compile_ctx(compiled.ctx);
      ctx.values.set(stmt.name, kind_from_expr(compiled.expr, ctx));
      record_resume_case_binding(
        stmt.name,
        compiled.expr,
        stmt.annotation,
        ctx,
        elaboration,
      );
      continue;
    }

    const compiled = compile_top_level_stmt(stmt, ctx, elaboration);
    result.push(compiled.stmt);
    ctx = compiled.ctx;
  }

  return result;
}

function compile_top_level_stmt(
  stmt: Exclude<Stmt, { tag: "bind" | "resume_dup" }>,
  ctx: CompileCtx,
  elaboration: Elaboration,
): { stmt: Stmt; ctx: CompileCtx } {
  if (stmt.tag === "state_bind") {
    const operation = operation_from_state_bind(stmt, elaboration.index);
    const effect = elaboration.index.effects.get(operation.effect);
    expect(effect, "Missing effect declaration: " + operation.effect);
    if (effect.implementation === "host") {
      return { stmt, ctx };
    }
    throw new Error(
      "Effect operation at module root must be inside an effect function",
    );
  }

  if (stmt.tag === "bind_pattern") {
    const compiled = compile_expr(
      stmt.value,
      ctx,
      (value, next_ctx) => normal_result(value, next_ctx),
      elaboration,
    );
    expect(compiled.target === undefined, "Handler escape in binding pattern");
    return { stmt: { ...stmt, value: compiled.expr }, ctx: compiled.ctx };
  }

  if (stmt.tag === "assign") {
    const compiled = compile_expr(
      stmt.value,
      ctx,
      (value, next_ctx) => normal_result(value, next_ctx),
      elaboration,
    );
    expect(compiled.target === undefined, "Handler escape in assignment");
    const next_ctx = clone_compile_ctx(compiled.ctx);
    next_ctx.values.set(stmt.name, kind_from_expr(compiled.expr, next_ctx));
    record_resume_case_binding(
      stmt.name,
      compiled.expr,
      undefined,
      next_ctx,
      elaboration,
    );
    return { stmt: { ...stmt, value: compiled.expr }, ctx: next_ctx };
  }

  if (stmt.tag === "index_assign") {
    return {
      stmt: {
        ...stmt,
        index: rewrite_pure_expr(stmt.index, ctx, elaboration),
        value: rewrite_pure_expr(stmt.value, ctx, elaboration),
      },
      ctx,
    };
  }

  if (stmt.tag === "return" || stmt.tag === "expr") {
    const value = stmt.tag === "return" ? stmt.value : stmt.expr;
    const compiled = compile_expr(
      value,
      ctx,
      (item, next_ctx) => normal_result(item, next_ctx),
      elaboration,
    );
    expect(compiled.target === undefined, "Uncaught local handler escape");

    if (stmt.tag === "return") {
      return {
        stmt: { tag: "return", value: compiled.expr },
        ctx: compiled.ctx,
      };
    }

    return { stmt: { tag: "expr", expr: compiled.expr }, ctx: compiled.ctx };
  }

  if (stmt.tag === "if_stmt") {
    return {
      stmt: {
        ...stmt,
        cond: rewrite_pure_expr(stmt.cond, ctx, elaboration),
        body: rewrite_top_level_statements(
          stmt.body,
          clone_compile_ctx(ctx),
          elaboration,
        ),
      },
      ctx,
    };
  }

  if (stmt.tag === "if_let_stmt") {
    return {
      stmt: {
        ...stmt,
        target: rewrite_pure_expr(stmt.target, ctx, elaboration),
        body: rewrite_top_level_statements(
          stmt.body,
          clone_compile_ctx(ctx),
          elaboration,
        ),
      },
      ctx,
    };
  }

  if (stmt.tag === "for_range") {
    return {
      stmt: {
        ...stmt,
        start: rewrite_pure_expr(stmt.start, ctx, elaboration),
        end: rewrite_pure_expr(stmt.end, ctx, elaboration),
        step: rewrite_pure_expr(stmt.step, ctx, elaboration),
        body: rewrite_top_level_statements(
          stmt.body,
          clone_compile_ctx(ctx),
          elaboration,
        ),
      },
      ctx,
    };
  }

  if (stmt.tag === "for_collection") {
    return {
      stmt: {
        ...stmt,
        collection: rewrite_pure_expr(stmt.collection, ctx, elaboration),
        body: rewrite_top_level_statements(
          stmt.body,
          clone_compile_ctx(ctx),
          elaboration,
        ),
      },
      ctx,
    };
  }

  if (stmt.tag === "type_check") {
    return {
      stmt: {
        ...stmt,
        target: rewrite_pure_expr(stmt.target, ctx, elaboration),
      },
      ctx,
    };
  }

  return { stmt, ctx };
}

function compile_expr(
  expr: FrontExpr,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  assert_available_state(expr, ctx);

  if (expr.tag === "unit") {
    return cont(unit_value(), ctx);
  }

  if (expr.tag === "handler") {
    throw new Error("Handler value must be consumed by `try ... with ...`");
  }

  if (expr.tag === "try_with") {
    return compile_try_with(expr, ctx, cont, elaboration);
  }

  if (expr.tag === "block") {
    return compile_statements(expr.statements, ctx, cont, elaboration);
  }

  if (
    expr.tag === "loop" &&
    (elaboration.effect_loops.has(expr) ||
      expr.body.some((stmt) => {
        return statement_has_direct_duck_effects(stmt, elaboration) ||
          stmt_calls_duck_function(stmt, ctx, elaboration);
      }))
  ) {
    return compile_effectful_loop(expr, ctx, cont, elaboration);
  }

  if (expr.tag === "app") {
    const resume = resumption_call(expr, ctx);

    if (resume) {
      return compile_resume_call(expr, resume, ctx, cont, elaboration);
    }

    const escaped_resume = escaped_resumption_call(expr, ctx, elaboration);

    if (escaped_resume) {
      return compile_escaped_resume_call(
        expr,
        escaped_resume,
        ctx,
        cont,
        elaboration,
      );
    }

    const cps_function = cps_function_call(expr, ctx, elaboration);

    if (cps_function) {
      return compile_cps_function_call(
        expr,
        cps_function,
        ctx,
        cont,
        elaboration,
      );
    }

    const application = application_parts(expr);
    const inline_callback = application.func;

    if (inline_callback.tag === "lam") {
      expect(
        inline_callback.params.length === application.args.length,
        "Inline resume callback argument count mismatch",
      );
      return compile_expr_list(
        application.args,
        ctx,
        [],
        (args, args_ctx) => {
          const replacements = new Map<string, FrontExpr>();

          for (
            let index = 0;
            index < inline_callback.params.length;
            index += 1
          ) {
            const param = inline_callback.params[index];
            const arg = args[index];
            expect(param, "Missing inline resume callback parameter");
            expect(arg, "Missing inline resume callback argument");
            replacements.set(param.name, arg);
          }

          const body = substitute_front_expr(
            inline_callback.body,
            replacements,
          );
          return compile_expr(body, args_ctx, cont, elaboration);
        },
        elaboration,
      );
    }

    if (
      application.func.tag === "var" &&
      duck_function_for_name(application.func.name, ctx, elaboration)
    ) {
      return compile_duck_function_call(expr, ctx, cont, elaboration);
    }

    return compile_expr_list(
      expr.args,
      ctx,
      [],
      (args, next_ctx) => {
        const func = rewrite_pure_expr(expr.func, next_ctx, elaboration);
        const app: Extract<FrontExpr, { tag: "app" }> = {
          ...expr,
          func,
          args,
        };

        if (expr.arg !== undefined && args.length === 1) {
          const arg = args[0];
          expect(arg, "Missing compiled application argument");
          app.arg = arg;
        }

        if (func.tag === "field") {
          for (const arg of args) {
            if (resume_value_signature(arg, elaboration)) {
              app.resume_payload = true;
              break;
            }
          }
        }

        return cont(app, next_ctx);
      },
      elaboration,
    );
  }

  if (expr.tag === "linear") {
    const resume = ctx.resumptions.get(expr.name);

    if (resume) {
      const closure = consume_resume_value(resume, ctx, elaboration);
      return cont(closure.expr, closure.ctx);
    }

    return cont(expr, ctx);
  }

  if (expr.tag === "prim") {
    return compile_expr(
      expr.left,
      ctx,
      (left, left_ctx) => {
        return compile_expr(
          expr.right,
          left_ctx,
          (right, right_ctx) => {
            return cont({ ...expr, left, right }, right_ctx);
          },
          elaboration,
        );
      },
      elaboration,
    );
  }

  if (expr.tag === "struct_value") {
    return compile_expr_list(
      expr.fields.map((field) => field.value),
      ctx,
      [],
      (values, next_ctx) => {
        return cont({
          ...expr,
          type_expr: rewrite_pure_expr(expr.type_expr, next_ctx, elaboration),
          fields: expr.fields.map((field, index) => {
            const value = values[index];
            expect(value, "Missing compiled struct field " + field.name);
            return { ...field, value };
          }),
        }, next_ctx);
      },
      elaboration,
    );
  }

  if (expr.tag === "product" || expr.tag === "shape") {
    return compile_expr_list(
      expr.entries.map((entry) => entry.value),
      ctx,
      [],
      (values, next_ctx) => {
        return cont({
          ...expr,
          entries: expr.entries.map((entry, index) => {
            const value = values[index];
            expect(value, "Missing compiled product entry " + index);
            return { ...entry, value };
          }),
        }, next_ctx);
      },
      elaboration,
    );
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    return compile_expr(
      expr.base,
      ctx,
      (base, base_ctx) => {
        return compile_expr_list(
          expr.fields.map((field) => field.value),
          base_ctx,
          [],
          (values, next_ctx) => {
            return cont({
              ...expr,
              base,
              fields: expr.fields.map((field, index) => {
                const value = values[index];
                expect(value, "Missing compiled updated field " + field.name);
                return { ...field, value };
              }),
            }, next_ctx);
          },
          elaboration,
        );
      },
      elaboration,
    );
  }

  if (expr.tag === "union_case") {
    if (!expr.value || expr.value.tag === "unit") {
      return cont(expr, ctx);
    }

    return compile_expr(
      expr.value,
      ctx,
      (value, next_ctx) => {
        let type_expr: FrontExpr | undefined;

        if (expr.type_expr) {
          type_expr = rewrite_pure_expr(expr.type_expr, next_ctx, elaboration);
        } else {
          const declarations = elaboration.source.declarations;
          let inferred: string | undefined;

          if (declarations !== undefined) {
            for (const declaration of declarations) {
              if (
                declaration.tag !== "type" ||
                declaration.body.tag !== "sum" ||
                !declaration.body.cases.some((item) => item.name === expr.name)
              ) {
                continue;
              }

              if (inferred !== undefined) {
                inferred = undefined;
                break;
              }

              inferred = declaration.name;
            }
          }

          if (inferred !== undefined) {
            type_expr = { tag: "var", name: inferred };
          }
        }

        return cont({ ...expr, value, type_expr }, next_ctx);
      },
      elaboration,
    );
  }

  if (expr.tag === "field") {
    return compile_expr(
      expr.object,
      ctx,
      (object, next_ctx) => {
        const signature = resume_field_signature(
          expr.object,
          expr.name,
          next_ctx,
          elaboration,
        );
        let value: FrontExpr = { ...expr, object };

        if (signature) {
          value = { ...expr, object, resume_signature: signature };
          elaboration.resume_value_signatures.set(value, signature);
        }

        return cont(value, next_ctx);
      },
      elaboration,
    );
  }

  if (expr.tag === "if") {
    const cond = rewrite_pure_expr(expr.cond, ctx, elaboration);
    const then_result = compile_expr(
      expr.then_branch,
      clone_compile_ctx(ctx),
      cont,
      elaboration,
    );
    const else_result = compile_expr(
      expr.else_branch,
      clone_compile_ctx(ctx),
      cont,
      elaboration,
    );
    expect(
      then_result.target === else_result.target,
      "Handler branches escape different delimiters",
    );
    return {
      expr: {
        ...expr,
        cond,
        then_branch: then_result.expr,
        else_branch: else_result.expr,
      },
      target: then_result.target,
      ctx: merge_branch_ctx(then_result.ctx, else_result.ctx),
    };
  }

  if (expr.tag === "if_let") {
    const target = rewrite_pure_expr(expr.target, ctx, elaboration);
    const then_ctx = clone_compile_ctx(ctx);

    if (expr.value_name) {
      bind_matched_resume(
        expr.value_name,
        expr.case_name,
        expr.target,
        then_ctx,
        elaboration,
      );
    }

    const then_result = compile_expr(
      expr.then_branch,
      then_ctx,
      cont,
      elaboration,
    );
    const else_result = compile_expr(
      expr.else_branch,
      clone_compile_ctx(ctx),
      cont,
      elaboration,
    );
    expect(
      then_result.target === else_result.target,
      "Handler union branches escape different delimiters",
    );
    return {
      expr: {
        ...expr,
        target,
        then_branch: then_result.expr,
        else_branch: else_result.expr,
      },
      target: then_result.target,
      ctx: merge_branch_ctx(then_result.ctx, else_result.ctx),
    };
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const body_ctx = clone_compile_ctx(ctx);

    for (const param of expr.params) {
      body_ctx.values.set(param.name, kind_from_type_name(param.annotation));
      body_ctx.resumptions.delete(param.name);
    }

    if (expr_contains_handler(expr.body)) {
      const compiled_body = compile_expr(
        expr.body,
        body_ctx,
        (value, next_ctx) => normal_result(value, next_ctx),
        elaboration,
      );
      expect(
        compiled_body.target === undefined,
        "Function-local handler escaped its function body",
      );
      return cont({ ...expr, body: compiled_body.expr }, ctx);
    }

    const body = rewrite_pure_expr(expr.body, body_ctx, elaboration);
    return cont({ ...expr, body }, ctx);
  }

  return cont(rewrite_pure_expr(expr, ctx, elaboration), ctx);
}

function compile_try_with(
  expr: Extract<FrontExpr, { tag: "try_with" }>,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const recipe = resolve_handler_recipe(expr.handler, elaboration, new Set());
  expect(recipe, "`try ... with ...` requires a statically known handler");
  const declaration = elaboration.index.effects.get(recipe.handler.effect);
  expect(declaration, "Unknown handled effect: " + recipe.handler.effect);
  expect(
    declaration.implementation === "duck",
    "Cannot handle host-declared effect: " + declaration.name,
  );
  consume_handler_recipe(recipe, elaboration);
  let output_type: string | undefined;

  if (declaration.name === "Do") {
    output_type = expr.handler_output_type;
  }

  if (output_type === undefined) {
    output_type = handler_use_output_type(
      expr.body,
      recipe.handler,
      elaboration,
    );
  }

  const frame: ActiveHandler = {
    id: elaboration.next_handler,
    recipe,
    effect: declaration,
    state_names: new Set(recipe.handler.state.map((state) => state.name)),
    output_type,
    outer_ctx: clone_compile_ctx(ctx),
    continue_after: cont,
  };
  elaboration.next_handler += 1;
  const body_ctx = clone_compile_ctx(ctx);
  body_ctx.active.push(frame);
  body_ctx.delimiters.push(frame);
  const state_statements: Stmt[] = [];

  for (const stmt of recipe.prefix) {
    state_statements.push(rewrite_pure_stmt(stmt, body_ctx, elaboration));
    record_stmt_value_kind(stmt, body_ctx);
  }

  for (const state of recipe.handler.state) {
    const value = rewrite_pure_expr(state.value, body_ctx, elaboration);
    state_statements.push({
      tag: "bind",
      kind: "let",
      name: state.name,
      is_linear: false,
      annotation: state.annotation,
      value,
    });
    body_ctx.values.set(state.name, kind_from_expr(value, body_ctx));
  }

  const body_result = compile_expr(
    expr.body,
    body_ctx,
    (value, return_ctx) => {
      return compile_handler_return(
        frame,
        value,
        return_ctx,
        elaboration,
      );
    },
    elaboration,
  );
  const handled: FrontExpr = {
    tag: "block",
    statements: append_result_statements(state_statements, body_result.expr),
  };

  if (body_result.target !== frame.id) {
    expect(
      body_result.target !== undefined,
      "Handled computation did not reach its return clause",
    );
    return {
      expr: handled,
      target: body_result.target,
      ctx: body_result.ctx,
    };
  }

  return cont(handled, ctx);
}

function compile_handler_return(
  frame: ActiveHandler,
  value: FrontExpr,
  ctx: CompileCtx,
  elaboration: Elaboration,
): CpsResult {
  const clause = frame.recipe.handler.return_clause;
  const input_type = simple_expr_type_name(value, new Map(), elaboration);

  if (clause.param.annotation && input_type) {
    expect(
      same_handler_type(clause.param.annotation, input_type, elaboration),
      "Handler return parameter " + clause.param.name + " expects " +
        clause.param.annotation + ", got " + input_type,
    );
  }
  const clause_ctx = handler_clause_ctx(frame, ctx);
  const parameter_name = "__duck_handler_return_" + frame.id.toString() + "_" +
    elaboration.next_resume.toString();
  elaboration.next_resume += 1;
  clause_ctx.values.set(
    parameter_name,
    kind_from_expr(value, clause_ctx),
  );
  const replacements = new Map<string, FrontExpr>();
  replacements.set(clause.param.name, { tag: "var", name: parameter_name });
  let clause_body = substitute_front_expr(clause.body, replacements);

  if (frame.effect.name === "Do" && frame.output_type !== undefined) {
    clause_body = contextualize_handler_result(
      clause_body,
      frame.output_type,
      elaboration,
    );
  }
  const output_type = simple_expr_type_name(
    clause_body,
    new Map(),
    elaboration,
  );

  if (frame.output_type && output_type) {
    expect(
      same_handler_type(frame.output_type, output_type, elaboration),
      "Handler return clause produces " + output_type + ", expected " +
        frame.output_type,
    );
  } else if (output_type) {
    frame.output_type = output_type;
  }
  const body_result = compile_expr(
    clause_body,
    clause_ctx,
    (output, output_ctx) => targeted_result(output, frame.id, output_ctx),
    elaboration,
  );
  const bind: Stmt = {
    tag: "bind",
    kind: "let",
    name: parameter_name,
    is_linear: clause.param.is_linear,
    annotation: clause.param.annotation,
    value,
  };
  return prepend_stmt_result(bind, body_result);
}

function compile_statements(
  statements: Stmt[],
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  expect(statements.length > 0, "Effectful block must produce a value");
  return compile_statement_at(statements, 0, ctx, cont, elaboration);
}

function compile_effectful_loop(
  expr: Extract<FrontExpr, { tag: "loop" }>,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const loop_name = "__duck_effect_loop_" + elaboration.next_loop.toString();
  elaboration.next_loop += 1;
  const parameters = effect_loop_parameters(expr.body, ctx, elaboration);
  const recursive_call: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: loop_name },
    args: parameters.map((param) => ({ tag: "var", name: param.name })),
  };
  const after = cont(unit_value(), clone_compile_ctx(ctx));
  const body = rewrite_effect_loop_control(
    expr.body,
    after.expr,
    recursive_call,
  );
  body.push({ tag: "expr", expr: recursive_call });
  const body_ctx = clone_compile_ctx(ctx);
  body_ctx.values.set(loop_name, "unknown");
  const compiled_body = compile_statements(
    body,
    body_ctx,
    (value, next_ctx) => {
      if (after.target === undefined) {
        return normal_result(value, next_ctx);
      }

      return targeted_result(value, after.target, next_ctx);
    },
    elaboration,
  );
  expect(
    compiled_body.target === after.target,
    "Effect loop crossed an incompatible handler delimiter",
  );
  const loop: Extract<FrontExpr, { tag: "lam" }> = {
    tag: "lam",
    params: parameters,
    body: compiled_body.expr,
  };
  const initial_call: FrontExpr = {
    tag: "app",
    func: { tag: "var", name: loop_name },
    args: parameters.map((param) => ({ tag: "var", name: param.name })),
  };
  const statements: Stmt[] = [
    {
      tag: "bind",
      kind: "let",
      name: loop_name,
      is_linear: false,
      is_recursive: true,
      annotation: undefined,
      value: loop,
    },
    { tag: "expr", expr: initial_call },
  ];
  return {
    expr: { tag: "block", statements },
    target: after.target,
    ctx: merge_branch_ctx(after.ctx, compiled_body.ctx),
  };
}

function effect_loop_parameters(
  statements: Stmt[],
  ctx: CompileCtx,
  elaboration: Elaboration,
): {
  name: string;
  is_const: false;
  is_linear: false;
  annotation: string | undefined;
}[] {
  const names = assigned_loop_names(statements);

  for (const frame of ctx.delimiters) {
    for (const name of frame.state_names) {
      names.add(name);
    }
  }

  const parameters: {
    name: string;
    is_const: false;
    is_linear: false;
    annotation: string | undefined;
  }[] = [];

  for (const name of names) {
    let annotation: string | undefined;

    if (name.startsWith("__duck_effect_range_")) {
      annotation = "I32";
    } else {
      for (const frame of ctx.delimiters) {
        const state = frame.recipe.handler.state.find((candidate) => {
          return candidate.name === name;
        });

        if (state !== undefined) {
          annotation = state.annotation;

          if (annotation === undefined) {
            annotation = simple_expr_type_name(
              state.value,
              new Map(),
              elaboration,
            );
          }

          if (annotation !== undefined) {
            break;
          }
        }

        const prefix_binding = frame.recipe.prefix.find((candidate) => {
          return candidate.tag === "bind" && candidate.name === name;
        });

        if (prefix_binding?.tag === "bind") {
          annotation = prefix_binding.annotation;

          if (annotation === undefined) {
            annotation = simple_expr_type_name(
              prefix_binding.value,
              new Map(),
              elaboration,
            );
          }

          if (annotation !== undefined) {
            break;
          }
        }
      }

      if (annotation === undefined) {
        for (const statement of elaboration.source.statements) {
          if (statement.tag !== "bind" || statement.name !== name) {
            continue;
          }

          annotation = statement.annotation;

          if (annotation === undefined) {
            annotation = simple_expr_type_name(
              statement.value,
              new Map(),
              elaboration,
            );
          }

          break;
        }
      }
    }

    parameters.push({
      name,
      is_const: false,
      is_linear: false,
      annotation,
    });
  }

  return parameters;
}

function assigned_loop_names(statements: Stmt[]): Set<string> {
  const names = new Set<string>();
  collect_assigned_loop_names(statements, names);
  return names;
}

function collect_assigned_loop_names(
  value: unknown,
  names: Set<string>,
): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (
    "tag" in value &&
    (value.tag === "assign" || value.tag === "index_assign") &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    names.add(value.name);
    return;
  }

  if (
    "tag" in value &&
    (value.tag === "lam" || value.tag === "rec" || value.tag === "handler")
  ) {
    return;
  }

  for (const child of Object.values(value)) {
    collect_assigned_loop_names(child, names);
  }
}

function rewrite_effect_loop_control(
  statements: Stmt[],
  break_value: FrontExpr,
  continue_value: FrontExpr,
): Stmt[] {
  return statements.map((stmt) => {
    if (stmt.tag === "break") {
      expect(
        stmt.value === undefined,
        "Effectful loops do not yet support break values",
      );
      return { tag: "return", value: break_value };
    }

    if (stmt.tag === "continue") {
      return { tag: "return", value: continue_value };
    }

    if (stmt.tag === "if_stmt") {
      return {
        ...stmt,
        body: rewrite_effect_loop_control(
          stmt.body,
          break_value,
          continue_value,
        ),
      };
    }

    if (stmt.tag === "if_let_stmt") {
      return {
        ...stmt,
        body: rewrite_effect_loop_control(
          stmt.body,
          break_value,
          continue_value,
        ),
      };
    }

    if (stmt.tag === "expr") {
      return {
        ...stmt,
        expr: rewrite_effect_loop_control_expr(
          stmt.expr,
          break_value,
          continue_value,
        ),
      };
    }

    return stmt;
  });
}

function rewrite_effect_loop_control_expr(
  expr: FrontExpr,
  break_value: FrontExpr,
  continue_value: FrontExpr,
): FrontExpr {
  if (expr.tag === "block") {
    return {
      ...expr,
      statements: rewrite_effect_loop_control(
        expr.statements,
        break_value,
        continue_value,
      ),
    };
  }

  if (expr.tag === "if") {
    return {
      ...expr,
      then_branch: rewrite_effect_loop_control_expr(
        expr.then_branch,
        break_value,
        continue_value,
      ),
      else_branch: rewrite_effect_loop_control_expr(
        expr.else_branch,
        break_value,
        continue_value,
      ),
    };
  }

  if (expr.tag === "if_let") {
    return {
      ...expr,
      then_branch: rewrite_effect_loop_control_expr(
        expr.then_branch,
        break_value,
        continue_value,
      ),
      else_branch: rewrite_effect_loop_control_expr(
        expr.else_branch,
        break_value,
        continue_value,
      ),
    };
  }

  return expr;
}

function effectful_range_block(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  elaboration: Elaboration,
): FrontExpr {
  expect(
    !statements_continue_current_loop(stmt.body),
    "Effectful range loops do not yet support continue",
  );
  const suffix = elaboration.next_loop.toString();
  const end_name = "__duck_effect_range_end_" + suffix;
  const step_name = "__duck_effect_range_step_" + suffix;
  const index_name = "__duck_effect_range_index_" + suffix;
  const step = static_range_step(stmt.step);
  const comparison = range_comparison_primitive(step, stmt.end_bound);
  const condition: FrontExpr = {
    tag: "prim",
    prim: comparison,
    left: { tag: "var", name: index_name },
    right: { tag: "var", name: end_name },
  };
  const done: FrontExpr = {
    tag: "prim",
    prim: "i32.eq",
    left: condition,
    right: { tag: "bool", value: false },
  };
  const body: Stmt[] = [
    { tag: "if_stmt", cond: done, body: [{ tag: "break" }] },
    {
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: "I32",
      value: { tag: "var", name: index_name },
    },
    ...stmt.body,
    {
      tag: "assign",
      name: index_name,
      mode: "same",
      value: {
        tag: "prim",
        prim: "i32.add",
        left: { tag: "var", name: index_name },
        right: { tag: "var", name: step_name },
      },
    },
  ];
  const loop: Extract<FrontExpr, { tag: "loop" }> = {
    tag: "loop",
    body,
  };
  elaboration.effect_loops.add(loop);
  return {
    tag: "block",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: end_name,
        is_linear: false,
        annotation: "I32",
        value: stmt.end,
      },
      {
        tag: "bind",
        kind: "let",
        name: step_name,
        is_linear: false,
        annotation: "I32",
        value: stmt.step,
      },
      {
        tag: "bind",
        kind: "let",
        name: index_name,
        is_linear: false,
        annotation: "I32",
        value: stmt.start,
      },
      { tag: "expr", expr: loop },
    ],
  };
}

function static_range_step(step: FrontExpr): number {
  expect(
    step.tag === "num" && step.type === "i32" &&
      typeof step.value === "number" && step.value !== 0,
    "Effectful range loop step must be a nonzero compile-time I32",
  );
  return step.value;
}

function range_comparison_primitive(
  step: number,
  end_bound: "exclusive" | "inclusive",
): "i32.lt_s" | "i32.le_s" | "i32.gt_s" | "i32.ge_s" {
  if (step > 0) {
    if (end_bound === "inclusive") {
      return "i32.le_s";
    }

    return "i32.lt_s";
  }

  if (end_bound === "inclusive") {
    return "i32.ge_s";
  }

  return "i32.gt_s";
}

function statements_continue_current_loop(statements: Stmt[]): boolean {
  for (const stmt of statements) {
    if (stmt.tag === "continue") {
      return true;
    }

    if (
      stmt.tag === "if_stmt" &&
      statements_continue_current_loop(stmt.body)
    ) {
      return true;
    }

    if (
      stmt.tag === "if_let_stmt" &&
      statements_continue_current_loop(stmt.body)
    ) {
      return true;
    }
  }

  return false;
}

function compile_statement_at(
  statements: Stmt[],
  index: number,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const stmt = statements[index];
  expect(stmt, "Missing handler statement " + index.toString());
  const is_final = index + 1 >= statements.length;

  function rest(next_ctx: CompileCtx): CpsResult {
    if (is_final) {
      return cont(unit_value(), next_ctx);
    }
    return compile_statement_at(
      statements,
      index + 1,
      next_ctx,
      cont,
      elaboration,
    );
  }

  if (stmt.tag === "state_bind") {
    return compile_effect_statement(
      stmt,
      ctx,
      (value, next_ctx) => {
        if (!stmt.value_name) {
          return rest(next_ctx);
        }

        const rest_ctx = clone_compile_ctx(next_ctx);
        const operation = operation_from_state_bind(stmt, elaboration.index);
        const declaration = elaboration.index.effects.get(operation.effect);
        expect(declaration, "Missing effect declaration: " + operation.effect);
        const declared_operation = find_operation(
          declaration,
          operation.operation,
        );
        expect(
          stmt.value.tag === "app",
          "Effect state binding must contain a call",
        );
        const operation_decl = specialize_effect_operation(
          declared_operation,
          stmt.value,
        );
        rest_ctx.values.set(
          stmt.value_name,
          kind_from_type_name(operation_decl.result.type_name),
        );
        const next = rest(rest_ctx);
        return prepend_stmt_result({
          tag: "bind",
          kind: "let",
          name: stmt.value_name,
          is_linear: false,
          annotation: operation_decl.result.type_name,
          value,
        }, next);
      },
      elaboration,
    );
  }

  if (stmt.tag === "resume_dup") {
    return compile_resume_dup(stmt, statements, index, ctx, cont, elaboration);
  }

  if (stmt.tag === "bind") {
    const alias = direct_resume_ref(stmt.value, ctx);

    if (alias) {
      expect(stmt.is_linear, "A resumption alias must be affine");
      expect(!alias.used, "Resumption " + alias.name + " was already consumed");
      alias.used = true;
      const next_ctx = clone_compile_ctx(ctx);
      next_ctx.resumptions.set(stmt.name, {
        ...alias,
        name: stmt.name,
        used: false,
      });
      next_ctx.values.set(stmt.name, "resume");
      return rest(next_ctx);
    }

    let binding_ctx = ctx;

    if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
      binding_ctx = clone_compile_ctx(ctx);

      if (
        nested_function_has_duck_effects(
          stmt.name,
          stmt.value,
          ctx,
          elaboration,
        )
      ) {
        binding_ctx.functions.set(stmt.name, {
          name: stmt.name,
          value: stmt.value,
        });
        return rest(binding_ctx);
      }

      // Remember ordinary nested functions too: they shadow an effectful
      // function with the same outer name for the rest of this lexical block.
      binding_ctx.functions.set(stmt.name, undefined);
    }

    return compile_expr(
      stmt.value,
      binding_ctx,
      (value, next_ctx) => {
        const rest_ctx = clone_compile_ctx(next_ctx);
        rest_ctx.values.set(stmt.name, kind_from_expr(value, rest_ctx));
        record_resume_case_binding(
          stmt.name,
          value,
          stmt.annotation,
          rest_ctx,
          elaboration,
        );
        const next = rest(rest_ctx);
        return prepend_stmt_result({ ...stmt, value }, next);
      },
      elaboration,
    );
  }

  if (stmt.tag === "assign") {
    return compile_expr(
      stmt.value,
      ctx,
      (value, next_ctx) => {
        const rest_ctx = clone_compile_ctx(next_ctx);
        rest_ctx.values.set(stmt.name, kind_from_expr(value, rest_ctx));
        record_resume_case_binding(
          stmt.name,
          value,
          undefined,
          rest_ctx,
          elaboration,
        );
        const next = rest(rest_ctx);
        return prepend_stmt_result({ ...stmt, value }, next);
      },
      elaboration,
    );
  }

  if (stmt.tag === "expr") {
    if (is_final) {
      return compile_expr(stmt.expr, ctx, cont, elaboration);
    }

    return compile_expr(
      stmt.expr,
      ctx,
      (value, next_ctx) => {
        const next = rest(next_ctx);
        return prepend_stmt_result({ tag: "expr", expr: value }, next);
      },
      elaboration,
    );
  }

  if (stmt.tag === "return") {
    return compile_expr(stmt.value, ctx, cont, elaboration);
  }

  if (stmt.tag === "if_stmt") {
    const cond = rewrite_pure_expr(stmt.cond, ctx, elaboration);
    const then_statements = [...stmt.body];
    const remaining = statements.slice(index + 1);
    then_statements.push(...remaining);
    const then_result = compile_statements(
      then_statements,
      clone_compile_ctx(ctx),
      cont,
      elaboration,
    );
    const else_result = rest(clone_compile_ctx(ctx));
    expect(
      then_result.target === else_result.target,
      "Handler statement branches escape different delimiters",
    );
    return {
      expr: {
        tag: "if",
        cond,
        then_branch: then_result.expr,
        else_branch: else_result.expr,
      },
      target: then_result.target,
      ctx: merge_branch_ctx(then_result.ctx, else_result.ctx),
    };
  }

  if (stmt.tag === "if_let_stmt") {
    const target = rewrite_pure_expr(stmt.target, ctx, elaboration);
    const then_ctx = clone_compile_ctx(ctx);

    if (stmt.value_name) {
      bind_matched_resume(
        stmt.value_name,
        stmt.case_name,
        stmt.target,
        then_ctx,
        elaboration,
      );
    }

    const then_result = compile_statements(
      [...stmt.body, ...statements.slice(index + 1)],
      then_ctx,
      cont,
      elaboration,
    );
    const else_result = rest(clone_compile_ctx(ctx));
    expect(
      then_result.target === else_result.target,
      "Handler union branches escape different delimiters",
    );
    return {
      expr: {
        tag: "if_let",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target,
        then_branch: then_result.expr,
        else_branch: else_result.expr,
      },
      target: then_result.target,
      ctx: merge_branch_ctx(then_result.ctx, else_result.ctx),
    };
  }

  if (stmt.tag === "for_range" || stmt.tag === "for_collection") {
    if (
      stmt.body.some((body_statement) => {
        return statement_has_direct_duck_effects(
          body_statement,
          elaboration,
        ) ||
          stmt_calls_duck_function(body_statement, ctx, elaboration);
      })
    ) {
      expect(
        stmt.tag === "for_range",
        "Local effects in collection loops require iterator CPS lowering",
      );
      return compile_expr(
        effectful_range_block(stmt, elaboration),
        ctx,
        (_value, next_ctx) => rest(next_ctx),
        elaboration,
      );
    }

    const next = rest(ctx);
    return prepend_stmt_result(rewrite_pure_stmt(stmt, ctx, elaboration), next);
  }

  if (stmt.tag === "index_assign" || stmt.tag === "type_check") {
    const next = rest(ctx);
    return prepend_stmt_result(rewrite_pure_stmt(stmt, ctx, elaboration), next);
  }

  if (stmt.tag === "bind_pattern") {
    const value = rewrite_pure_expr(stmt.value, ctx, elaboration);
    const next_ctx = clone_compile_ctx(ctx);

    for (const item of stmt.items) {
      next_ctx.values.set(item.name, "unknown");
    }

    const next = rest(next_ctx);
    return prepend_stmt_result({ ...stmt, value }, next);
  }

  if (stmt.tag === "break" || stmt.tag === "continue") {
    throw new Error("Cannot cross a handler delimiter with " + stmt.tag);
  }

  if (stmt.tag === "import" || stmt.tag === "host_import") {
    const next = rest(ctx);
    return prepend_stmt_result(stmt, next);
  }

  throw new Error("Cannot lower handler statement: " + stmt.tag);
}

function compile_effect_statement(
  stmt: Extract<Stmt, { tag: "state_bind" }>,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const ref = operation_from_state_bind(stmt, elaboration.index);
  const declaration = elaboration.index.effects.get(ref.effect);
  expect(declaration, "Missing effect declaration: " + ref.effect);
  const declared_operation = find_operation(declaration, ref.operation);
  expect(stmt.value.tag === "app", "Effect state binding must contain a call");
  const operation = specialize_effect_operation(declared_operation, stmt.value);
  const application = application_parts(stmt.value);

  if (declaration.implementation === "host") {
    return compile_host_operation(
      ref,
      operation,
      application.args,
      ctx,
      cont,
      elaboration,
    );
  }

  return compile_local_operation(
    ref,
    operation,
    application.args,
    ctx,
    cont,
    elaboration,
  );
}

function compile_host_operation(
  ref: EffectRef,
  operation: EffectOperation,
  args: FrontExpr[],
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const provider = elaboration.providers.get(ref.effect);
  expect(provider, "Missing lexical provider for effect " + ref.effect);
  expect(
    args.length === operation.params.length,
    "Effect operation argument count mismatch: " + effect_text(ref),
  );
  return compile_expr_list(
    args,
    ctx,
    [],
    (values, next_ctx) => {
      return cont({
        tag: "app",
        func: {
          tag: "var",
          name: effect_import_name(ref.effect, ref.operation),
        },
        arg: {
          tag: "product",
          entries: [provider, ...values].map((value) => ({ value })),
        },
        args: [provider, ...values],
      }, next_ctx);
    },
    elaboration,
  );
}

function compile_local_operation(
  ref: EffectRef,
  operation: EffectOperation,
  args: FrontExpr[],
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  expect(
    args.length === operation.params.length,
    "Effect operation argument count mismatch: " + effect_text(ref),
  );
  const match = matching_handler(ref, ctx.active);
  expect(match, "Unresolved Duck effect operation: " + effect_text(ref));
  return compile_expr_list(
    args,
    ctx,
    [],
    (values, next_ctx) => {
      return invoke_handler_clause(
        match.frame,
        match.index,
        ref,
        operation,
        values,
        next_ctx,
        cont,
        elaboration,
      );
    },
    elaboration,
  );
}

function invoke_handler_clause(
  frame: ActiveHandler,
  frame_index: number,
  ref: EffectRef,
  operation: EffectOperation,
  args: FrontExpr[],
  operation_ctx: CompileCtx,
  continuation: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const clause = frame.recipe.handler.clauses.find((item) => {
    return item.name === ref.operation;
  });
  expect(clause, "Missing selected handler clause: " + effect_text(ref));
  expect(
    clause.params.length === operation.params.length + 1,
    "Handler clause arity mismatch: " + effect_text(ref),
  );
  const resume_param = clause.params[clause.params.length - 1];
  expect(resume_param, "Missing resumption parameter: " + effect_text(ref));
  const resume_name = resume_param.name;
  const resume_spec: ResumeSpec = {
    name: resume_name,
    input_type: operation.result.type_name,
    output_type: frame.output_type,
    handler_id: frame.id,
    captured_handlers: [...operation_ctx.delimiters],
    continue_with(value) {
      const continuation_ctx = clone_compile_ctx(operation_ctx);

      if (value.tag === "var" || value.tag === "linear") {
        continuation_ctx.values.set(
          value.name,
          kind_from_type_name(operation.result.type_name),
        );
      }

      return continuation(value, continuation_ctx);
    },
    captures: new Map(operation_ctx.values),
    used: false,
  };
  const clause_ctx = handler_clause_ctx(frame, operation_ctx);
  clause_ctx.active = operation_ctx.active.slice(0, frame_index);
  const param_stmts: Stmt[] = [];

  if (resume_param.is_linear) {
    clause_ctx.resumptions.set(resume_name, resume_spec);
    clause_ctx.values.set(resume_name, "resume");
  } else {
    const reusable_resume = reusable_resume_value(resume_spec, elaboration);
    resume_spec.used = true;
    clause_ctx.unavailable_state.add(resume_spec.handler_id);
    clause_ctx.values.set(resume_name, "frozen");
    param_stmts.push({
      tag: "bind",
      kind: "let",
      name: resume_name,
      is_linear: false,
      annotation: undefined,
      value: reusable_resume,
    });
  }

  for (let index = 0; index < operation.params.length; index += 1) {
    const declared = operation.params[index];
    const param = clause.params[index];
    const arg = args[index];
    expect(declared, "Missing operation parameter");
    expect(param, "Missing handler clause parameter");
    expect(arg, "Missing operation argument");
    clause_ctx.values.set(param.name, kind_from_type_name(declared.type_name));
    param_stmts.push({
      tag: "bind",
      kind: "let",
      name: param.name,
      is_linear: param.is_linear,
      annotation: declared.type_name,
      value: arg,
    });
  }

  let clause_body = clause.body;

  if (frame.effect.name === "Do" && frame.output_type !== undefined) {
    clause_body = contextualize_handler_result(
      clause_body,
      frame.output_type,
      elaboration,
    );
  }

  const clause_result = compile_expr(
    clause_body,
    clause_ctx,
    (output, output_ctx) => targeted_result(output, frame.id, output_ctx),
    elaboration,
  );
  const clause_output_type = simple_expr_type_name(
    clause_result.expr,
    new Map(),
    elaboration,
  );

  if (frame.output_type && clause_output_type) {
    expect(
      same_handler_type(frame.output_type, clause_output_type, elaboration),
      "Handler clause " + ref.effect + "." + ref.operation + " produces " +
        clause_output_type + ", expected " + frame.output_type,
    );
  } else if (clause_output_type) {
    frame.output_type = clause_output_type;
  }
  return {
    expr: {
      tag: "block",
      statements: append_result_statements(param_stmts, clause_result.expr),
    },
    target: clause_result.target,
    ctx: clause_result.ctx,
  };
}

function compile_resume_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  resume: ResumeSpec,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  let arg = expr.arg;

  if (arg === undefined) {
    expect(
      expr.args.length === 1,
      "Resumption " + resume.name + " expects exactly one argument",
    );
    arg = expr.args[0];
  }

  expect(arg, "Missing resumption argument");
  return compile_expr(
    arg,
    ctx,
    (value, arg_ctx) => {
      expect(
        !resume.used,
        "Resumption " + resume.name + " was already consumed",
      );
      resume.used = true;
      const next_ctx = clone_compile_ctx(arg_ctx);
      next_ctx.unavailable_state.add(resume.handler_id);
      const body_result = resume_continuation_result(resume, value);

      if (body_result.target !== resume.handler_id) {
        expect(
          body_result.target !== undefined,
          "Resumption crossed an incompatible handler delimiter",
        );
        return targeted_result(
          body_result.expr,
          body_result.target,
          next_ctx,
        );
      }

      return cont(body_result.expr, next_ctx);
    },
    elaboration,
  );
}

function consume_resume_value(
  resume: ResumeSpec,
  ctx: CompileCtx,
  elaboration: Elaboration,
): { expr: FrontExpr; target: number | undefined; ctx: CompileCtx } {
  expect(!resume.used, "Resumption " + resume.name + " was already consumed");
  resume.used = true;
  const next_ctx = clone_compile_ctx(ctx);
  next_ctx.unavailable_state.add(resume.handler_id);
  const parameter_name = "__duck_resume_value_" +
    elaboration.next_resume.toString();
  elaboration.next_resume += 1;
  const body_result = resume_continuation_result(resume, {
    tag: "var",
    name: parameter_name,
  });
  const output_type = resume.output_type ||
    simple_expr_type_name(body_result.expr, new Map());
  expect(
    output_type,
    "Missing exact output type for escaped resumption " + resume.name,
  );
  let target: number | undefined;

  if (body_result.target !== resume.handler_id) {
    target = body_result.target;
  }

  const signature = {
    input_type: resume.input_type,
    output_type,
  };
  const closure: FrontExpr = {
    tag: "lam",
    params: [{
      name: parameter_name,
      is_const: false,
      is_linear: false,
      annotation: runtime_annotation(resume.input_type),
    }],
    body: body_result.expr,
  };
  elaboration.resume_value_signatures.set(closure, signature);
  return {
    expr: closure,
    target,
    ctx: next_ctx,
  };
}

function compile_escaped_resume_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  resume: EscapedResume,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  expect(
    expr.args.length === 1,
    "Escaped resumption expects exactly one argument",
  );
  expect(!resume.used, "Escaped resumption was already consumed");
  const arg = expr.args[0];
  expect(arg, "Missing escaped resumption argument");
  return compile_expr(
    arg,
    ctx,
    (value, next_ctx) => {
      expect(!resume.used, "Escaped resumption was already consumed");
      resume.used = true;
      expect(
        expr.func.tag === "linear" || expr.func.tag === "var" ||
          expr.func.tag === "field",
        "Escaped resumption call requires an affine value",
      );
      return cont({
        tag: "app",
        func: { ...expr.func, resume_signature: resume.signature },
        arg: value,
        args: [value],
      }, next_ctx);
    },
    elaboration,
  );
}

function resume_continuation_result(
  resume: ResumeSpec,
  value: FrontExpr,
): CpsResult {
  let body_result = resume.continue_with(value);
  const handler_index = resume.captured_handlers.findIndex((frame) => {
    return frame.id === resume.handler_id;
  });
  expect(handler_index >= 0, "Missing resumption handler delimiter");

  while (body_result.target !== resume.handler_id) {
    expect(
      body_result.target !== undefined,
      "Resumption crossed an incompatible handler delimiter",
    );
    const target_index = resume.captured_handlers.findIndex((frame) => {
      return frame.id === body_result.target;
    });
    expect(
      target_index >= 0,
      "Resumption crossed an incompatible handler delimiter",
    );

    if (target_index < handler_index) {
      break;
    }

    expect(
      target_index > handler_index,
      "Resumption crossed an incompatible handler delimiter",
    );
    const target_frame = resume.captured_handlers[target_index];
    expect(target_frame, "Missing captured handler delimiter");
    body_result = target_frame.continue_after(
      body_result.expr,
      clone_compile_ctx(target_frame.outer_ctx),
    );
  }
  return body_result;
}

function compile_resume_dup(
  stmt: Extract<Stmt, { tag: "resume_dup" }>,
  statements: Stmt[],
  index: number,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const resume = direct_resume_ref(stmt.value, ctx);
  expect(resume, "Checked dup requires a resumption value");
  expect(!resume.used, "Resumption " + resume.name + " was already consumed");
  assert_resume_duplicable(resume, elaboration);
  resume.used = true;
  const next_ctx = clone_compile_ctx(ctx);
  next_ctx.unavailable_state.add(resume.handler_id);
  next_ctx.resumptions.set(
    stmt.left,
    duplicated_resume_spec(resume, stmt.left),
  );
  next_ctx.resumptions.set(
    stmt.right,
    duplicated_resume_spec(resume, stmt.right),
  );
  next_ctx.values.set(stmt.left, "resume");
  next_ctx.values.set(stmt.right, "resume");
  expect(
    index + 1 < statements.length,
    "Handler dup must be followed by a result",
  );
  return compile_statement_at(
    statements,
    index + 1,
    next_ctx,
    cont,
    elaboration,
  );
}

function duplicated_resume_spec(
  resume: ResumeSpec,
  name: string,
): ResumeSpec {
  const state = duplicated_handler_state(resume);
  return {
    ...resume,
    name,
    used: false,
    captures: new Map(resume.captures),
    continue_with(value) {
      const result = resume.continue_with(value);

      if (state.length === 0) {
        return result;
      }

      const snapshots: Stmt[] = state.map((item) => ({
        tag: "bind",
        kind: "let",
        name: item.name,
        is_linear: false,
        annotation: item.annotation,
        value: { tag: "var", name: item.name },
      }));
      return {
        ...result,
        expr: {
          tag: "block",
          statements: append_result_statements(snapshots, result.expr),
        },
      };
    },
  };
}

function reusable_resume_value(
  resume: ResumeSpec,
  elaboration: Elaboration,
): FrontExpr {
  const branch = duplicated_resume_spec(resume, resume.name);
  const parameter_name = "__duck_multi_resume_value_" +
    elaboration.next_resume.toString();
  elaboration.next_resume += 1;
  const body_result = resume_continuation_result(branch, {
    tag: "var",
    name: parameter_name,
  });
  assert_reusable_resume_duplicable(resume, body_result.expr, elaboration);
  expect(
    body_result.target === resume.handler_id,
    "Multi-shot resumption crossed an incompatible handler delimiter",
  );
  return {
    tag: "lam",
    params: [{
      name: parameter_name,
      is_const: false,
      is_linear: false,
      annotation: runtime_annotation(resume.input_type),
    }],
    body: body_result.expr,
  };
}

function assert_reusable_resume_duplicable(
  resume: ResumeSpec,
  continuation: FrontExpr,
  elaboration: Elaboration,
): void {
  const handler_state = new Set(
    duplicated_handler_state(resume).map((state) => state.name),
  );

  for (const [name, kind] of resume.captures) {
    if (!handler_state.has(name) && !expr_uses_name(continuation, name)) {
      continue;
    }

    if (elaboration.static_names.has(name)) {
      continue;
    }

    if (kind === "scalar" || kind === "frozen") {
      continue;
    }

    throw new Error(
      "Cannot duplicate resumption " + resume.name + ": capture " + name +
        " is " + kind,
    );
  }
}

function duplicated_handler_state(
  resume: ResumeSpec,
): { name: string; annotation: string | undefined }[] {
  const delimiter = resume.captured_handlers.findIndex((frame) => {
    return frame.id === resume.handler_id;
  });
  expect(delimiter >= 0, "Missing duplicated resumption delimiter");
  const result: { name: string; annotation: string | undefined }[] = [];
  const names = new Set<string>();

  for (
    let index = delimiter;
    index < resume.captured_handlers.length;
    index += 1
  ) {
    const frame = resume.captured_handlers[index];
    expect(frame, "Missing captured handler for resumption duplication");

    for (const item of frame.recipe.handler.state) {
      if (names.has(item.name)) {
        continue;
      }

      names.add(item.name);
      result.push({ name: item.name, annotation: item.annotation });
    }
  }

  return result;
}

function assert_resume_duplicable(
  resume: ResumeSpec,
  elaboration: Elaboration,
): void {
  for (const [name, kind] of resume.captures) {
    if (elaboration.static_names.has(name)) {
      continue;
    }

    if (kind === "scalar" || kind === "frozen") {
      continue;
    }

    throw new Error(
      "Cannot duplicate resumption " + resume.name + ": capture " + name +
        " is " + kind,
    );
  }
}

function compile_duck_function_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const application = application_parts(expr);
  expect(application.func.tag === "var", "Expected named Duck effect function");
  const binding = duck_function_for_name(
    application.func.name,
    ctx,
    elaboration,
  );
  expect(binding, "Missing Duck effect function: " + application.func.name);
  expect(
    binding.value.tag === "lam",
    "Recursive Duck effect CPS is not supported",
  );
  expect(
    !ctx.active_calls.has(binding.name),
    "Recursive Duck effect CPS is not supported: " + binding.name,
  );
  expect(
    binding.value.params.length === application.args.length,
    "Effect function argument count mismatch: " + binding.name,
  );
  return compile_expr_list(
    application.args,
    ctx,
    [],
    (args, args_ctx) => {
      const replacements = new Map<string, FrontExpr>();
      const body_ctx = clone_compile_ctx(args_ctx);

      for (let index = 0; index < binding.value.params.length; index += 1) {
        const param = binding.value.params[index];
        const arg = args[index];
        expect(param, "Missing effect function parameter");
        expect(arg, "Missing effect function argument");
        replacements.set(param.name, arg);
        body_ctx.values.set(param.name, kind_from_type_name(param.annotation));
      }

      body_ctx.active_calls.add(binding.name);
      const body = substitute_front_expr(binding.value.body, replacements);
      return compile_expr(
        body,
        body_ctx,
        (value, next_ctx) => {
          next_ctx.active_calls.delete(binding.name);
          return cont(value, next_ctx);
        },
        elaboration,
      );
    },
    elaboration,
  );
}

function compile_cps_function_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  binding: EffectFunction,
  ctx: CompileCtx,
  cont: CpsCont,
  elaboration: Elaboration,
): CpsResult {
  const application = application_parts(expr);
  expect(binding.value.tag === "lam", "CPS helper cannot be recursive");
  expect(
    binding.value.params.length === application.args.length,
    "CPS helper argument count mismatch: " + binding.name,
  );
  expect(
    !ctx.active_calls.has(binding.name),
    "Recursive CPS helper is not supported: " + binding.name,
  );
  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < binding.value.params.length; index += 1) {
    const param = binding.value.params[index];
    const arg = application.args[index];
    expect(param, "Missing Resume helper parameter");
    expect(arg, "Missing Resume helper argument");

    if (param.annotation === "Resume") {
      expect(param.is_linear, "Resume helper parameters must be affine");
    }

    replacements.set(param.name, arg);
  }

  const body_ctx = clone_compile_ctx(ctx);
  body_ctx.active_calls.add(binding.name);
  let body = substitute_front_expr(binding.value.body, replacements);

  if (binding.name.startsWith("_duck_extension#")) {
    let active: ActiveHandler | undefined = body_ctx.active[0];

    if (active === undefined) {
      active = body_ctx.delimiters.at(-1);
    }

    if (active?.output_type !== undefined) {
      body = contextualize_handler_result(
        body,
        active.output_type,
        elaboration,
      );
    }
  }

  return compile_expr(
    body,
    body_ctx,
    (value, next_ctx) => {
      next_ctx.active_calls.delete(binding.name);
      return cont(value, next_ctx);
    },
    elaboration,
  );
}

function compile_expr_list(
  values: FrontExpr[],
  ctx: CompileCtx,
  compiled: FrontExpr[],
  done: (values: FrontExpr[], ctx: CompileCtx) => CpsResult,
  elaboration: Elaboration,
): CpsResult {
  if (compiled.length >= values.length) {
    return done(compiled, ctx);
  }

  const value = values[compiled.length];
  expect(value, "Missing expression list value");
  return compile_expr(
    value,
    ctx,
    (item, next_ctx) => {
      return compile_expr_list(
        values,
        next_ctx,
        [...compiled, item],
        done,
        elaboration,
      );
    },
    elaboration,
  );
}

function application_parts(
  expr: Extract<FrontExpr, { tag: "app" }>,
): { func: FrontExpr; args: FrontExpr[] } {
  const args: FrontExpr[] = [];
  let current: FrontExpr = expr;

  while (current.tag === "app") {
    args.unshift(...current.args);
    current = current.func;
  }

  return { func: current, args };
}

function rewrite_pure_expr(
  expr: FrontExpr,
  ctx: CompileCtx,
  elaboration: Elaboration,
): FrontExpr {
  assert_available_state(expr, ctx);

  if (expr.tag === "unit") {
    return unit_value();
  }

  if (expr.tag === "handler" || expr.tag === "try_with") {
    throw new Error("Handler expression requires CPS elaboration");
  }

  if (expr.tag === "linear") {
    const resume = ctx.resumptions.get(expr.name);
    expect(!resume, "Resumption value requires affine CPS elaboration");
    return expr;
  }

  if (expr.tag === "prim") {
    return {
      ...expr,
      left: rewrite_pure_expr(expr.left, ctx, elaboration),
      right: rewrite_pure_expr(expr.right, ctx, elaboration),
    };
  }

  if (expr.tag === "app") {
    expect(
      !resumption_call(expr, ctx),
      "Resumption call requires CPS elaboration",
    );
    expect(
      !(expr.func.tag === "var" &&
        duck_function_for_name(expr.func.name, ctx, elaboration)),
      "Duck effect function call requires CPS elaboration",
    );
    const application = application_parts(expr);

    if (application.func.tag === "lam") {
      expect(
        application.func.params.length === application.args.length,
        "Inline callback argument count mismatch",
      );
      const replacements = new Map<string, FrontExpr>();

      for (let index = 0; index < application.func.params.length; index += 1) {
        const param = application.func.params[index];
        const arg = application.args[index];
        expect(param, "Missing inline callback parameter");
        expect(arg, "Missing inline callback argument");
        replacements.set(param.name, rewrite_pure_expr(arg, ctx, elaboration));
      }

      const body = substitute_front_expr(
        application.func.body,
        replacements,
      );
      return rewrite_pure_expr(body, ctx, elaboration);
    }
    const extension = cps_function_call(expr, ctx, elaboration);

    if (
      extension !== undefined &&
      extension.name.startsWith("_duck_extension#") &&
      !ctx.active_calls.has(extension.name)
    ) {
      const application = application_parts(expr);
      expect(extension.value.tag === "lam", "Extension cannot be recursive");
      expect(
        extension.value.params.length === application.args.length,
        "Extension argument count mismatch: " + extension.name,
      );
      const replacements = new Map<string, FrontExpr>();

      for (let index = 0; index < extension.value.params.length; index += 1) {
        const param = extension.value.params[index];
        const arg = application.args[index];
        expect(param, "Missing extension parameter");
        expect(arg, "Missing extension argument");
        replacements.set(param.name, rewrite_pure_expr(arg, ctx, elaboration));
      }

      const body_ctx = clone_compile_ctx(ctx);
      body_ctx.active_calls.add(extension.name);
      const body = substitute_front_expr(extension.value.body, replacements);
      return rewrite_pure_expr(body, body_ctx, elaboration);
    }

    return {
      ...expr,
      func: rewrite_pure_expr(expr.func, ctx, elaboration),
      args: expr.args.map((arg) => rewrite_pure_expr(arg, ctx, elaboration)),
    };
  }

  if (expr.tag === "block") {
    return {
      tag: "block",
      statements: expr.statements.map((stmt) => {
        return rewrite_pure_stmt(stmt, ctx, elaboration);
      }),
    };
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const body_ctx = clone_compile_ctx(ctx);

    for (const param of expr.params) {
      body_ctx.resumptions.delete(param.name);
      body_ctx.values.set(param.name, kind_from_type_name(param.annotation));
    }

    return {
      ...expr,
      body: rewrite_pure_expr(expr.body, body_ctx, elaboration),
    };
  }

  if (expr.tag === "comptime") {
    return {
      ...expr,
      expr: rewrite_pure_expr(expr.expr, ctx, elaboration),
    };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return {
      ...expr,
      value: rewrite_pure_expr(expr.value, ctx, elaboration),
    };
  }

  if (expr.tag === "scratch") {
    return {
      ...expr,
      body: rewrite_pure_expr(expr.body, ctx, elaboration),
    };
  }

  if (expr.tag === "loop") {
    expect(
      !expr.body.some((stmt) => {
        return statement_has_direct_duck_effects(stmt, elaboration) ||
          stmt_calls_duck_function(stmt, ctx, elaboration);
      }),
      "Local effects inside runtime loops require recursive CPS lowering",
    );
    return {
      tag: "loop",
      body: expr.body.map((stmt) => rewrite_pure_stmt(stmt, ctx, elaboration)),
    };
  }

  if (expr.tag === "captured") {
    return {
      ...expr,
      expr: rewrite_pure_expr(expr.expr, ctx, elaboration),
    };
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    return {
      ...expr,
      base: rewrite_pure_expr(expr.base, ctx, elaboration),
      fields: expr.fields.map((field) => ({
        ...field,
        value: rewrite_pure_expr(field.value, ctx, elaboration),
      })),
    };
  }

  if (expr.tag === "struct_value") {
    return {
      ...expr,
      type_expr: rewrite_pure_expr(expr.type_expr, ctx, elaboration),
      fields: expr.fields.map((field) => ({
        ...field,
        value: rewrite_pure_expr(field.value, ctx, elaboration),
      })),
    };
  }

  if (expr.tag === "if") {
    return {
      ...expr,
      cond: rewrite_pure_expr(expr.cond, ctx, elaboration),
      then_branch: rewrite_pure_expr(expr.then_branch, ctx, elaboration),
      else_branch: rewrite_pure_expr(expr.else_branch, ctx, elaboration),
    };
  }

  if (expr.tag === "if_let") {
    return {
      ...expr,
      target: rewrite_pure_expr(expr.target, ctx, elaboration),
      then_branch: rewrite_pure_expr(expr.then_branch, ctx, elaboration),
      else_branch: rewrite_pure_expr(expr.else_branch, ctx, elaboration),
    };
  }

  if (expr.tag === "field") {
    return {
      ...expr,
      object: rewrite_pure_expr(expr.object, ctx, elaboration),
    };
  }

  if (expr.tag === "index") {
    return {
      ...expr,
      object: rewrite_pure_expr(expr.object, ctx, elaboration),
      index: rewrite_pure_expr(expr.index, ctx, elaboration),
    };
  }

  if (expr.tag === "union_case") {
    let value: FrontExpr | undefined;
    let type_expr: FrontExpr | undefined;

    if (expr.value?.tag === "unit") {
      value = expr.value;
    } else if (expr.value) {
      value = rewrite_pure_expr(expr.value, ctx, elaboration);
    }

    if (expr.type_expr) {
      type_expr = rewrite_pure_expr(expr.type_expr, ctx, elaboration);
    } else {
      const declarations = elaboration.source.declarations;
      let inferred: string | undefined;

      if (declarations !== undefined) {
        for (const declaration of declarations) {
          if (
            declaration.tag !== "type" || declaration.body.tag !== "sum" ||
            !declaration.body.cases.some((item) => item.name === expr.name)
          ) {
            continue;
          }

          if (inferred !== undefined) {
            inferred = undefined;
            break;
          }

          inferred = declaration.name;
        }
      }

      if (inferred !== undefined) {
        type_expr = { tag: "var", name: inferred };
      }
    }

    return { ...expr, value, type_expr };
  }

  return expr;
}

function rewrite_pure_stmt(
  stmt: Stmt,
  ctx: CompileCtx,
  elaboration: Elaboration,
): Stmt {
  if (stmt.tag === "bind") {
    return {
      ...stmt,
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "state_bind") {
    const operation = operation_from_state_bind(stmt, elaboration.index);
    const effect = elaboration.index.effects.get(operation.effect);
    expect(effect, "Missing effect declaration: " + operation.effect);
    if (effect.implementation === "host") {
      return {
        ...stmt,
        value: rewrite_pure_expr(stmt.value, ctx, elaboration),
      };
    }
    throw new Error("Effect operation requires CPS elaboration");
  }

  if (stmt.tag === "resume_dup") {
    throw new Error("Resumption duplication requires CPS elaboration");
  }

  if (stmt.tag === "bind_pattern") {
    return {
      ...stmt,
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "assign") {
    return {
      ...stmt,
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "index_assign") {
    return {
      ...stmt,
      index: rewrite_pure_expr(stmt.index, ctx, elaboration),
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "for_range") {
    return {
      ...stmt,
      start: rewrite_pure_expr(stmt.start, ctx, elaboration),
      end: rewrite_pure_expr(stmt.end, ctx, elaboration),
      step: rewrite_pure_expr(stmt.step, ctx, elaboration),
      body: stmt.body.map((item) => rewrite_pure_stmt(item, ctx, elaboration)),
    };
  }

  if (stmt.tag === "for_collection") {
    return {
      ...stmt,
      collection: rewrite_pure_expr(stmt.collection, ctx, elaboration),
      body: stmt.body.map((item) => rewrite_pure_stmt(item, ctx, elaboration)),
    };
  }

  if (stmt.tag === "if_stmt") {
    return {
      ...stmt,
      cond: rewrite_pure_expr(stmt.cond, ctx, elaboration),
      body: stmt.body.map((item) => rewrite_pure_stmt(item, ctx, elaboration)),
    };
  }

  if (stmt.tag === "if_let_stmt") {
    return {
      ...stmt,
      target: rewrite_pure_expr(stmt.target, ctx, elaboration),
      body: stmt.body.map((item) => rewrite_pure_stmt(item, ctx, elaboration)),
    };
  }

  if (stmt.tag === "type_check") {
    return {
      ...stmt,
      target: rewrite_pure_expr(stmt.target, ctx, elaboration),
    };
  }

  if (stmt.tag === "break" && stmt.value) {
    return {
      tag: "break",
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "return") {
    return {
      ...stmt,
      value: rewrite_pure_expr(stmt.value, ctx, elaboration),
    };
  }

  if (stmt.tag === "expr") {
    return {
      ...stmt,
      expr: rewrite_pure_expr(stmt.expr, ctx, elaboration),
    };
  }

  return stmt;
}

function handler_recipe_from_expr(
  expr: FrontExpr,
  key: string,
  elaboration: Elaboration,
  seen: Set<string>,
): HandlerRecipe | undefined {
  if (expr.tag === "handler") {
    return {
      key,
      handler: expr,
      prefix: [],
      affine: true,
    };
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    if (seen.has(expr.name)) {
      throw new Error("Recursive handler alias: " + expr.name);
    }

    seen.add(expr.name);
    return elaboration.handlers.get(expr.name);
  }

  if (expr.tag !== "app") {
    return undefined;
  }

  let factory: EffectFunction | undefined;

  if (expr.func.tag === "var") {
    factory = find_handler_factory(expr.func.name, elaboration);
  } else if (expr.func.tag === "lam") {
    factory = {
      name: "DefaultHandler.make",
      value: expr.func,
    };
  }

  if (!factory) {
    return undefined;
  }

  expect(
    factory.value.tag === "lam",
    "Handler factory cannot be recursive: " + factory.name,
  );
  expect(
    factory.value.params.length === expr.args.length,
    "Handler factory argument count mismatch: " + factory.name,
  );
  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < factory.value.params.length; index += 1) {
    const param = factory.value.params[index];
    const arg = expr.args[index];
    expect(param, "Missing handler factory parameter");
    expect(arg, "Missing handler factory argument");
    replacements.set(param.name, arg);
  }

  const body = substitute_front_expr(factory.value.body, replacements);
  const result = handler_result_expr(body);

  if (!result) {
    if (expr.func.tag === "lam") {
      const recipe = handler_recipe_from_expr(
        body,
        "__factory_" + elaboration.next_factory.toString(),
        elaboration,
        seen,
      );
      elaboration.next_factory += 1;

      if (!recipe) {
        return undefined;
      }

      return { ...recipe, affine: false };
    }

    return undefined;
  }

  const prefix = handler_result_prefix(body);
  const recipe = handler_recipe_from_expr(
    result,
    "__factory_" + elaboration.next_factory.toString(),
    elaboration,
    seen,
  );
  elaboration.next_factory += 1;

  if (!recipe) {
    return undefined;
  }

  return { ...recipe, prefix: [...prefix, ...recipe.prefix], affine: false };
}

function resolve_handler_recipe(
  expr: FrontExpr,
  elaboration: Elaboration,
  seen: Set<string>,
): HandlerRecipe | undefined {
  if (expr.tag === "var" || expr.tag === "linear") {
    const recipe = elaboration.handlers.get(expr.name);

    if (recipe) {
      return recipe;
    }
  }

  return handler_recipe_from_expr(
    expr,
    "__inline_handler_" + elaboration.next_handler.toString(),
    elaboration,
    seen,
  );
}

function find_handler_factory(
  name: string,
  elaboration: Elaboration,
): EffectFunction | undefined {
  const existing = elaboration.functions.get(name);

  if (existing && handler_result_expr(existing.value.body)) {
    return existing;
  }

  for (const stmt of elaboration.source.statements) {
    if (
      stmt.tag === "bind" && stmt.name === name &&
      (stmt.value.tag === "lam" || stmt.value.tag === "rec") &&
      handler_result_expr(stmt.value.body)
    ) {
      return {
        name,
        value: stmt.value,
      };
    }
  }

  return undefined;
}

function handler_result_expr(expr: FrontExpr): FrontExpr | undefined {
  if (expr.tag === "handler") {
    return expr;
  }

  if (expr.tag !== "block") {
    return undefined;
  }

  const final_stmt = expr.statements[expr.statements.length - 1];

  if (final_stmt && final_stmt.tag === "return") {
    return handler_result_expr(final_stmt.value);
  }

  if (final_stmt && final_stmt.tag === "expr") {
    return handler_result_expr(final_stmt.expr);
  }

  return undefined;
}

function handler_result_prefix(expr: FrontExpr): Stmt[] {
  if (expr.tag !== "block") {
    return [];
  }

  return expr.statements.slice(0, -1);
}

function consume_handler_recipe(
  recipe: HandlerRecipe,
  elaboration: Elaboration,
): void {
  if (!recipe.affine) {
    return;
  }

  let use = elaboration.handler_uses.get(recipe.key);

  if (!use) {
    use = { count: 0 };
    elaboration.handler_uses.set(recipe.key, use);
  }

  use.count += 1;
  expect(use.count <= 1, "Handler " + recipe.key + " was already consumed");
}

function validate_handler_uses(elaboration: Elaboration): void {
  for (const [key, use] of elaboration.handler_uses) {
    expect(use.count <= 1, "Handler " + key + " was consumed more than once");
  }
}

function function_has_duck_effects(
  name: string,
  elaboration: Elaboration,
): boolean {
  const fact = elaboration.analysis.functions[name];

  if (!fact) {
    return false;
  }

  for (const ref of fact.effects) {
    const effect = elaboration.index.effects.get(ref.effect);

    if (effect && effect.implementation === "duck") {
      return true;
    }
  }

  return false;
}

function function_binding_has_duck_effects(
  name: string,
  value: Extract<FrontExpr, { tag: "lam" | "rec" }>,
  elaboration: Elaboration,
): boolean {
  if (expr_contains_handler(value.body)) {
    return function_has_duck_effects(name, elaboration);
  }

  if (function_body_has_direct_duck_effects(value.body, elaboration)) {
    return true;
  }

  return function_has_duck_effects(name, elaboration);
}

function nested_function_has_duck_effects(
  name: string,
  value: Extract<FrontExpr, { tag: "lam" | "rec" }>,
  ctx: CompileCtx,
  elaboration: Elaboration,
): boolean {
  if (function_body_has_direct_duck_effects(value.body, elaboration)) {
    return true;
  }

  if (function_body_calls_duck_function(value.body, ctx, elaboration)) {
    return true;
  }

  if (elaboration.functions.has(name)) {
    return false;
  }

  return function_has_duck_effects(name, elaboration);
}

function function_body_has_direct_duck_effects(
  body: FrontExpr,
  elaboration: Elaboration,
): boolean {
  if (body.tag !== "block") {
    return false;
  }

  return body.statements.some((stmt) => {
    return statement_has_direct_duck_effects(stmt, elaboration);
  });
}

function function_body_calls_duck_function(
  body: FrontExpr,
  ctx: CompileCtx,
  elaboration: Elaboration,
): boolean {
  if (body.tag !== "block") {
    return expr_calls_duck_function(body, ctx, elaboration);
  }

  return body.statements.some((stmt) => {
    return stmt_calls_duck_function(stmt, ctx, elaboration);
  });
}

function stmt_calls_duck_function(
  stmt: Stmt,
  ctx: CompileCtx,
  elaboration: Elaboration,
): boolean {
  if (stmt.tag === "bind") {
    if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
      return false;
    }

    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "resume_dup") {
    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "assign") {
    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "index_assign") {
    return expr_calls_duck_function(stmt.index, ctx, elaboration) ||
      expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "for_range") {
    return expr_calls_duck_function(stmt.start, ctx, elaboration) ||
      expr_calls_duck_function(stmt.end, ctx, elaboration) ||
      expr_calls_duck_function(stmt.step, ctx, elaboration) ||
      stmt.body.some((item) =>
        stmt_calls_duck_function(item, ctx, elaboration)
      );
  }

  if (stmt.tag === "for_collection") {
    return expr_calls_duck_function(stmt.collection, ctx, elaboration) ||
      stmt.body.some((item) =>
        stmt_calls_duck_function(item, ctx, elaboration)
      );
  }

  if (stmt.tag === "if_stmt") {
    return expr_calls_duck_function(stmt.cond, ctx, elaboration) ||
      stmt.body.some((item) =>
        stmt_calls_duck_function(item, ctx, elaboration)
      );
  }

  if (stmt.tag === "if_let_stmt") {
    return expr_calls_duck_function(stmt.target, ctx, elaboration) ||
      stmt.body.some((item) =>
        stmt_calls_duck_function(item, ctx, elaboration)
      );
  }

  if (stmt.tag === "type_check") {
    return expr_calls_duck_function(stmt.target, ctx, elaboration);
  }

  if (stmt.tag === "return") {
    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "break" && stmt.value) {
    return expr_calls_duck_function(stmt.value, ctx, elaboration);
  }

  if (stmt.tag === "expr") {
    return expr_calls_duck_function(stmt.expr, ctx, elaboration);
  }

  return false;
}

function expr_calls_duck_function(
  expr: FrontExpr,
  ctx: CompileCtx,
  elaboration: Elaboration,
): boolean {
  if (expr.tag === "app") {
    if (
      expr.func.tag === "var" &&
      duck_function_for_name(expr.func.name, ctx, elaboration)
    ) {
      return true;
    }

    if (expr_calls_duck_function(expr.func, ctx, elaboration)) {
      return true;
    }

    return expr.args.some((arg) => {
      return expr_calls_duck_function(arg, ctx, elaboration);
    });
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return false;
  }

  if (expr.tag === "prim") {
    return expr_calls_duck_function(expr.left, ctx, elaboration) ||
      expr_calls_duck_function(expr.right, ctx, elaboration);
  }

  if (expr.tag === "block") {
    return expr.statements.some((stmt) => {
      return stmt_calls_duck_function(stmt, ctx, elaboration);
    });
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    return expr_calls_duck_function(expr.expr, ctx, elaboration);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return expr_calls_duck_function(expr.value, ctx, elaboration);
  }

  if (expr.tag === "scratch") {
    return expr_calls_duck_function(expr.body, ctx, elaboration);
  }

  if (expr.tag === "loop") {
    return expr.body.some((stmt) => {
      return stmt_calls_duck_function(stmt, ctx, elaboration);
    });
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    if (expr_calls_duck_function(expr.base, ctx, elaboration)) {
      return true;
    }

    return expr.fields.some((field) => {
      return expr_calls_duck_function(field.value, ctx, elaboration);
    });
  }

  if (expr.tag === "struct_value") {
    if (expr_calls_duck_function(expr.type_expr, ctx, elaboration)) {
      return true;
    }

    return expr.fields.some((field) => {
      return expr_calls_duck_function(field.value, ctx, elaboration);
    });
  }

  if (expr.tag === "if") {
    return expr_calls_duck_function(expr.cond, ctx, elaboration) ||
      expr_calls_duck_function(expr.then_branch, ctx, elaboration) ||
      expr_calls_duck_function(expr.else_branch, ctx, elaboration);
  }

  if (expr.tag === "if_let") {
    return expr_calls_duck_function(expr.target, ctx, elaboration) ||
      expr_calls_duck_function(expr.then_branch, ctx, elaboration) ||
      expr_calls_duck_function(expr.else_branch, ctx, elaboration);
  }

  if (expr.tag === "field") {
    return expr_calls_duck_function(expr.object, ctx, elaboration);
  }

  if (expr.tag === "index") {
    return expr_calls_duck_function(expr.object, ctx, elaboration) ||
      expr_calls_duck_function(expr.index, ctx, elaboration);
  }

  if (expr.tag === "union_case") {
    if (expr.value && expr_calls_duck_function(expr.value, ctx, elaboration)) {
      return true;
    }

    if (
      expr.type_expr &&
      expr_calls_duck_function(expr.type_expr, ctx, elaboration)
    ) {
      return true;
    }
  }

  return false;
}

function statement_has_direct_duck_effects(
  stmt: Stmt,
  elaboration: Elaboration,
): boolean {
  if (stmt.tag === "state_bind") {
    const operation = operation_from_state_bind(stmt, elaboration.index);
    const effect = elaboration.index.effects.get(operation.effect);
    expect(effect, "Missing effect declaration: " + operation.effect);
    return effect.implementation === "duck";
  }

  if (stmt.tag === "if_stmt" || stmt.tag === "if_let_stmt") {
    return stmt.body.some((item) => {
      return statement_has_direct_duck_effects(item, elaboration);
    });
  }

  return false;
}

function duck_function_for_name(
  name: string,
  ctx: CompileCtx,
  elaboration: Elaboration,
): EffectFunction | undefined {
  if (ctx.functions.has(name)) {
    return ctx.functions.get(name);
  }

  return elaboration.functions.get(name);
}

function cps_function_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CompileCtx,
  elaboration: Elaboration,
): EffectFunction | undefined {
  const application = application_parts(expr);

  if (application.func.tag !== "var") {
    return undefined;
  }

  let binding: Extract<Stmt, { tag: "bind" }> | undefined;

  for (const stmt of elaboration.source.statements) {
    if (stmt.tag === "bind" && stmt.name === application.func.name) {
      binding = stmt;
      break;
    }
  }

  if (
    !binding ||
    (binding.value.tag !== "lam" && binding.value.tag !== "rec")
  ) {
    return undefined;
  }

  if (binding.name.startsWith("_duck_extension#")) {
    return {
      name: binding.name,
      value: binding.value,
    };
  }

  let carries_resume = false;

  for (let index = 0; index < binding.value.params.length; index += 1) {
    const param = binding.value.params[index];
    const arg = application.args[index];

    if (arg !== undefined && expression_calls_resumption(arg, ctx)) {
      carries_resume = true;
      break;
    }

    if (!param || param.annotation !== "Resume" || !arg) {
      continue;
    }

    if (direct_resume_ref(arg, ctx)) {
      carries_resume = true;
      break;
    }

    if (
      (arg.tag === "var" || arg.tag === "linear") &&
      ctx.escaped_resumptions.has(arg.name)
    ) {
      carries_resume = true;
      break;
    }

    if (
      arg.tag === "field" &&
      resume_field_signature(
        arg.object,
        arg.name,
        ctx,
        elaboration,
      )
    ) {
      carries_resume = true;
      break;
    }
  }

  if (!carries_resume) {
    return undefined;
  }

  return {
    name: binding.name,
    value: binding.value,
  };
}

function expression_calls_resumption(
  value: unknown,
  ctx: CompileCtx,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => expression_calls_resumption(entry, ctx, seen));
  }

  const node = value as Record<string, unknown>;

  if (
    node.tag === "app" &&
    resumption_call(node as Extract<FrontExpr, { tag: "app" }>, ctx) !==
      undefined
  ) {
    return true;
  }

  return Object.values(node).some((child) => {
    return expression_calls_resumption(child, ctx, seen);
  });
}

function operation_from_state_bind(
  stmt: Extract<Stmt, { tag: "state_bind" }>,
  index: EffectIndex,
): EffectRef {
  expect(stmt.value.tag === "app", "Effect state binding requires a call");
  const application = application_parts(stmt.value);
  const func = application.func;
  expect(func.tag === "field", "Effect state binding requires a method call");
  const object = func.object;

  if (object.tag === "var") {
    const effect = index.effects.get(object.name);
    expect(effect, "Unknown effect: " + object.name);
    find_operation(effect, func.name);
    return { effect: effect.name, operation: func.name };
  }

  throw new Error(
    "Effect bind must call a declared effect operation",
  );
}

function find_operation(
  effect: EffectDeclaration,
  name: string,
): EffectOperation {
  const operation = effect.operations.find((item) => item.name === name);
  expect(operation, "Unknown effect operation: " + effect.name + "." + name);
  return operation;
}

function matching_handler(
  ref: EffectRef,
  active: ActiveHandler[],
): { frame: ActiveHandler; index: number } | undefined {
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const frame = active[index];
    expect(frame, "Missing active handler frame");

    if (frame.effect.name !== ref.effect) {
      continue;
    }

    const implemented = frame.recipe.handler.clauses.some((clause) => {
      return clause.name === ref.operation;
    });

    if (implemented) {
      return { frame, index };
    }
  }

  return undefined;
}

function handler_clause_ctx(
  frame: ActiveHandler,
  ctx: CompileCtx,
): CompileCtx {
  const result = clone_compile_ctx(ctx);
  const active_index = result.active.findIndex((item) => item.id === frame.id);

  if (active_index >= 0) {
    result.active = result.active.slice(0, active_index);
  }

  result.unavailable_state.delete(frame.id);
  return result;
}

function resumption_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CompileCtx,
): ResumeSpec | undefined {
  if (expr.func.tag !== "linear" && expr.func.tag !== "var") {
    return undefined;
  }

  return ctx.resumptions.get(expr.func.name);
}

function escaped_resumption_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CompileCtx,
  elaboration: Elaboration,
): EscapedResume | undefined {
  if (expr.func.tag === "linear" || expr.func.tag === "var") {
    return ctx.escaped_resumptions.get(expr.func.name);
  }

  if (expr.func.tag === "field") {
    const signature = resume_field_signature(
      expr.func.object,
      expr.func.name,
      ctx,
      elaboration,
    );

    if (signature) {
      return { signature, used: false };
    }
  }

  return undefined;
}

function direct_resume_ref(
  expr: FrontExpr,
  ctx: CompileCtx,
): ResumeSpec | undefined {
  if (expr.tag !== "linear" && expr.tag !== "var") {
    return undefined;
  }

  return ctx.resumptions.get(expr.name);
}

function prepend_stmt_result(stmt: Stmt, result: CpsResult): CpsResult {
  return {
    expr: {
      tag: "block",
      statements: append_result_statements([stmt], result.expr),
    },
    target: result.target,
    ctx: result.ctx,
  };
}

function append_result_statements(
  prefix: Stmt[],
  result: FrontExpr,
): Stmt[] {
  if (result.tag === "block") {
    return [...prefix, ...result.statements];
  }

  return [...prefix, { tag: "expr", expr: result }];
}

function normal_result(expr: FrontExpr, ctx: CompileCtx): CpsResult {
  return { expr, target: undefined, ctx };
}

function targeted_result(
  expr: FrontExpr,
  target: number,
  ctx: CompileCtx,
): CpsResult {
  return { expr, target, ctx };
}

function clone_compile_ctx(ctx: CompileCtx): CompileCtx {
  const resumptions = new Map<string, ResumeSpec>();

  for (const [name, resume] of ctx.resumptions) {
    resumptions.set(name, {
      ...resume,
      captures: new Map(resume.captures),
    });
  }

  const escaped_resumptions = new Map<string, EscapedResume>();

  for (const [name, resume] of ctx.escaped_resumptions) {
    escaped_resumptions.set(name, {
      signature: resume.signature,
      used: resume.used,
    });
  }

  return {
    active: [...ctx.active],
    delimiters: [...ctx.delimiters],
    resumptions,
    resume_cases: clone_resume_cases(ctx.resume_cases),
    resume_fields: clone_resume_cases(ctx.resume_fields),
    escaped_resumptions,
    unavailable_state: new Set(ctx.unavailable_state),
    values: new Map(ctx.values),
    functions: new Map(ctx.functions),
    active_calls: new Set(ctx.active_calls),
  };
}

function clone_resume_cases(
  source: Map<string, Map<string, ResumeSignature>>,
): Map<string, Map<string, ResumeSignature>> {
  const result = new Map<string, Map<string, ResumeSignature>>();

  for (const [name, cases] of source) {
    result.set(name, new Map(cases));
  }

  return result;
}

function record_resume_case_binding(
  name: string,
  value: FrontExpr,
  annotation: string | undefined,
  ctx: CompileCtx,
  elaboration: Elaboration,
): void {
  const direct = resume_value_signature(value, elaboration);

  if (direct) {
    ctx.values.set(name, "resume");
    ctx.escaped_resumptions.set(name, { signature: direct, used: false });
  } else {
    ctx.escaped_resumptions.delete(name);
  }

  const cases = resume_cases_from_expr(value, annotation, elaboration);

  if (cases.size === 0) {
    ctx.resume_cases.delete(name);
  } else {
    ctx.resume_cases.set(name, cases);
  }

  const fields = resume_fields_from_expr(value, elaboration);

  if (fields.size === 0) {
    ctx.resume_fields.delete(name);
  } else {
    ctx.resume_fields.set(name, fields);
  }
}

function bind_matched_resume(
  name: string,
  case_name: string,
  target: FrontExpr,
  ctx: CompileCtx,
  elaboration: Elaboration,
): void {
  let signature: ResumeSignature | undefined;

  if (target.tag === "var" || target.tag === "linear") {
    signature = ctx.resume_cases.get(target.name)?.get(case_name);
  }

  if (!signature) {
    signature = resume_cases_from_expr(target, undefined, elaboration).get(
      case_name,
    );
  }

  if (!signature) {
    ctx.values.set(name, "unknown");
    ctx.escaped_resumptions.delete(name);
    return;
  }

  ctx.values.set(name, "resume");
  ctx.escaped_resumptions.set(name, { signature, used: false });
}

function resume_cases_from_expr(
  expr: FrontExpr,
  annotation: string | undefined,
  elaboration: Elaboration,
): Map<string, ResumeSignature> {
  const result = new Map<string, ResumeSignature>();

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return resume_cases_from_expr(final_stmt.expr, annotation, elaboration);
    }

    if (final_stmt && final_stmt.tag === "return") {
      return resume_cases_from_expr(final_stmt.value, annotation, elaboration);
    }

    return result;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resume_cases_from_expr(expr.value, annotation, elaboration);
  }

  if (expr.tag === "scratch") {
    return resume_cases_from_expr(expr.body, annotation, elaboration);
  }

  if (expr.tag === "captured") {
    return resume_cases_from_expr(expr.expr, annotation, elaboration);
  }

  if (expr.tag === "if") {
    const left = resume_cases_from_expr(
      expr.then_branch,
      annotation,
      elaboration,
    );
    const right = resume_cases_from_expr(
      expr.else_branch,
      annotation,
      elaboration,
    );

    for (const [case_name, signature] of left) {
      result.set(case_name, signature);
    }

    for (const [case_name, signature] of right) {
      const existing = result.get(case_name);

      if (existing) {
        expect(
          existing.input_type === signature.input_type &&
            existing.output_type === signature.output_type,
          "Conflicting escaped resumption signatures for case " + case_name,
        );
      }

      result.set(case_name, signature);
    }

    return result;
  }

  if (expr.tag === "union_case") {
    if (!expr.value) {
      return result;
    }

    const signature = resume_value_signature(expr.value, elaboration);

    if (signature) {
      result.set(expr.name, signature);
    }

    return result;
  }

  if (
    expr.tag === "app" && expr.func.tag === "field" &&
    expr.args.length === 1
  ) {
    const value = expr.args[0];
    expect(value, "Missing union constructor payload");
    const signature = resume_value_signature(value, elaboration);

    if (signature) {
      const object = expr.func.object;

      if (
        object.tag === "var" || object.tag === "linear" ||
        object.tag === "type_name"
      ) {
        result.set(expr.func.name, signature);
      } else if (annotation) {
        result.set(expr.func.name, signature);
      }
    }
  }

  return result;
}

function resume_value_signature(
  expr: FrontExpr,
  elaboration: Elaboration,
): ResumeSignature | undefined {
  const direct = elaboration.resume_value_signatures.get(expr);

  if (direct) {
    return direct;
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return resume_value_signature(final_stmt.expr, elaboration);
    }

    if (final_stmt && final_stmt.tag === "return") {
      return resume_value_signature(final_stmt.value, elaboration);
    }
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resume_value_signature(expr.value, elaboration);
  }

  if (expr.tag === "scratch") {
    return resume_value_signature(expr.body, elaboration);
  }

  return undefined;
}

function resume_fields_from_expr(
  expr: FrontExpr,
  elaboration: Elaboration,
): Map<string, ResumeSignature> {
  const result = new Map<string, ResumeSignature>();

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return resume_fields_from_expr(final_stmt.expr, elaboration);
    }

    if (final_stmt && final_stmt.tag === "return") {
      return resume_fields_from_expr(final_stmt.value, elaboration);
    }

    return result;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resume_fields_from_expr(expr.value, elaboration);
  }

  if (expr.tag === "scratch") {
    return resume_fields_from_expr(expr.body, elaboration);
  }

  if (expr.tag === "captured") {
    return resume_fields_from_expr(expr.expr, elaboration);
  }

  if (expr.tag === "if") {
    const left = resume_fields_from_expr(expr.then_branch, elaboration);
    const right = resume_fields_from_expr(expr.else_branch, elaboration);

    for (const [name, signature] of left) {
      result.set(name, signature);
    }

    for (const [name, signature] of right) {
      const existing = result.get(name);

      if (existing) {
        expect(
          existing.input_type === signature.input_type &&
            existing.output_type === signature.output_type,
          "Conflicting escaped resumption signatures for field " + name,
        );
      }

      result.set(name, signature);
    }

    return result;
  }

  if (expr.tag === "struct_value") {
    for (const field of expr.fields) {
      const signature = resume_value_signature(field.value, elaboration);

      if (signature) {
        result.set(field.name, signature);
      }
    }

    return result;
  }

  if (expr.tag === "product" || expr.tag === "shape") {
    for (let index = 0; index < expr.entries.length; index += 1) {
      const entry = expr.entries[index];
      expect(entry, "Missing resumption product entry " + index);
      const signature = resume_value_signature(entry.value, elaboration);

      if (signature) {
        let name = entry.label;

        if (name === undefined) {
          name = "item_" + index;
        }

        result.set(name, signature);
      }
    }

    return result;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    const base = resume_fields_from_expr(expr.base, elaboration);

    for (const [name, signature] of base) {
      result.set(name, signature);
    }

    for (const field of expr.fields) {
      result.delete(field.name);
      const signature = resume_value_signature(field.value, elaboration);

      if (signature) {
        result.set(field.name, signature);
      }
    }
  }

  return result;
}

function resume_field_signature(
  object: FrontExpr,
  name: string,
  ctx: CompileCtx,
  elaboration: Elaboration,
): ResumeSignature | undefined {
  if (object.tag === "var" || object.tag === "linear") {
    const signature = ctx.resume_fields.get(object.name)?.get(name);

    if (signature) {
      return signature;
    }
  }

  return resume_fields_from_expr(object, elaboration).get(name);
}

function merge_branch_ctx(left: CompileCtx, right: CompileCtx): CompileCtx {
  const result = clone_compile_ctx(left);

  for (const [name, left_resume] of left.resumptions) {
    const right_resume = right.resumptions.get(name);

    if (!right_resume) {
      result.resumptions.delete(name);
      continue;
    }

    const merged_resume = result.resumptions.get(name);
    expect(merged_resume, "Missing merged resumption " + name);
    merged_resume.used = left_resume.used || right_resume.used;
  }

  for (const id of right.unavailable_state) {
    result.unavailable_state.add(id);
  }

  for (const [name, left_resume] of left.escaped_resumptions) {
    const right_resume = right.escaped_resumptions.get(name);

    if (!right_resume) {
      result.escaped_resumptions.delete(name);
      continue;
    }

    const merged_resume = result.escaped_resumptions.get(name);
    expect(merged_resume, "Missing merged escaped resumption " + name);
    merged_resume.used = left_resume.used || right_resume.used;
  }

  return result;
}

function assert_available_state(expr: FrontExpr, ctx: CompileCtx): void {
  if (ctx.unavailable_state.size === 0) {
    return;
  }

  for (const frame of ctx.delimiters) {
    if (!ctx.unavailable_state.has(frame.id)) {
      continue;
    }

    for (const name of frame.state_names) {
      if (expr_uses_name(expr, name)) {
        throw new Error(
          "Handler state " + name +
            " is unavailable after consuming its resumption",
        );
      }
    }
  }
}

function expr_uses_name(expr: FrontExpr, name: string): boolean {
  if (expr.tag === "var" || expr.tag === "linear") {
    return expr.name === name;
  }

  if (expr.tag === "prim") {
    return expr_uses_name(expr.left, name) || expr_uses_name(expr.right, name);
  }

  if (expr.tag === "app") {
    if (expr_uses_name(expr.func, name)) {
      return true;
    }

    return expr.args.some((arg) => expr_uses_name(arg, name));
  }

  if (expr.tag === "block") {
    return expr.statements.some((stmt) => stmt_uses_name(stmt, name));
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    if (expr.params.some((param) => param.name === name)) {
      return false;
    }

    return expr_uses_name(expr.body, name);
  }

  if (expr.tag === "comptime") {
    return expr_uses_name(expr.expr, name);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return expr_uses_name(expr.value, name);
  }

  if (expr.tag === "scratch") {
    return expr_uses_name(expr.body, name);
  }

  if (expr.tag === "captured") {
    return expr_uses_name(expr.expr, name);
  }

  if (expr.tag === "handler") {
    return false;
  }

  if (expr.tag === "try_with") {
    return expr_uses_name(expr.body, name) ||
      expr_uses_name(expr.handler, name);
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    if (expr_uses_name(expr.base, name)) {
      return true;
    }

    return expr.fields.some((field) => expr_uses_name(field.value, name));
  }

  if (expr.tag === "struct_value") {
    if (expr_uses_name(expr.type_expr, name)) {
      return true;
    }

    return expr.fields.some((field) => expr_uses_name(field.value, name));
  }

  if (expr.tag === "if") {
    return expr_uses_name(expr.cond, name) ||
      expr_uses_name(expr.then_branch, name) ||
      expr_uses_name(expr.else_branch, name);
  }

  if (expr.tag === "if_let") {
    return expr_uses_name(expr.target, name) ||
      expr_uses_name(expr.then_branch, name) ||
      expr_uses_name(expr.else_branch, name);
  }

  if (expr.tag === "field") {
    return expr_uses_name(expr.object, name);
  }

  if (expr.tag === "index") {
    return expr_uses_name(expr.object, name) ||
      expr_uses_name(expr.index, name);
  }

  if (expr.tag === "union_case") {
    if (expr.value && expr_uses_name(expr.value, name)) {
      return true;
    }

    if (expr.type_expr && expr_uses_name(expr.type_expr, name)) {
      return true;
    }
  }

  return false;
}

function stmt_uses_name(stmt: Stmt, name: string): boolean {
  if (stmt.tag === "bind") {
    return expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
    return expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "resume_dup") {
    return expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "assign") {
    return stmt.name === name || expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "index_assign") {
    return stmt.name === name || expr_uses_name(stmt.index, name) ||
      expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "for_range") {
    return expr_uses_name(stmt.start, name) ||
      expr_uses_name(stmt.end, name) || expr_uses_name(stmt.step, name) ||
      stmt.body.some((item) => stmt_uses_name(item, name));
  }

  if (stmt.tag === "for_collection") {
    return expr_uses_name(stmt.collection, name) ||
      stmt.body.some((item) => stmt_uses_name(item, name));
  }

  if (stmt.tag === "if_stmt") {
    return expr_uses_name(stmt.cond, name) ||
      stmt.body.some((item) => stmt_uses_name(item, name));
  }

  if (stmt.tag === "if_let_stmt") {
    return expr_uses_name(stmt.target, name) ||
      stmt.body.some((item) => stmt_uses_name(item, name));
  }

  if (stmt.tag === "type_check") {
    return expr_uses_name(stmt.target, name);
  }

  if (stmt.tag === "return") {
    return expr_uses_name(stmt.value, name);
  }

  if (stmt.tag === "expr") {
    return expr_uses_name(stmt.expr, name);
  }

  return false;
}

function stmt_has_duck_operation(stmt: Stmt): boolean {
  if (stmt.tag === "state_bind" || stmt.tag === "resume_dup") {
    return true;
  }

  if (stmt.tag === "bind") {
    return expr_contains_handler(stmt.value);
  }

  if (stmt.tag === "if_stmt" || stmt.tag === "if_let_stmt") {
    return stmt.body.some(stmt_has_duck_operation);
  }

  if (stmt.tag === "for_range" || stmt.tag === "for_collection") {
    return stmt.body.some(stmt_has_duck_operation);
  }

  return false;
}

function record_stmt_value_kind(stmt: Stmt, ctx: CompileCtx): void {
  if (stmt.tag === "bind") {
    ctx.values.set(stmt.name, kind_from_expr(stmt.value, ctx));
  }

  if (stmt.tag === "assign") {
    ctx.values.set(stmt.name, kind_from_expr(stmt.value, ctx));
  }
}

function kind_from_expr(expr: FrontExpr, ctx: CompileCtx): ValueKind {
  if (
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "unit" ||
    expr.tag === "prim"
  ) {
    return "scalar";
  }

  if (expr.tag === "text") {
    return "frozen";
  }

  if (expr.tag === "freeze") {
    return "frozen";
  }

  if (expr.tag === "borrow") {
    return "borrow";
  }

  if (expr.tag === "scratch") {
    return "scratch";
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return "unique";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    return ctx.values.get(expr.name) || "unknown";
  }

  if (expr.tag === "app") {
    return "unknown";
  }

  if (expr.tag === "struct_value" || expr.tag === "union_case") {
    return "unique";
  }

  return "unknown";
}

function kind_from_type_name(name: string | undefined): ValueKind {
  if (!name) {
    return "unknown";
  }

  if (
    name === "Unit" || name === "Bool" || name === "Char" ||
    name === "Int" || name === "I32" || name === "U32" || name === "I64"
  ) {
    return "scalar";
  }

  return "unique";
}

function handler_use_output_type(
  body: FrontExpr,
  handler: HandlerExpr,
  elaboration: Elaboration,
): string | undefined {
  const input_type = simple_expr_type_name(body, new Map(), elaboration);
  const types = new Map<string, string>();

  if (handler.return_clause.param.annotation) {
    types.set(
      handler.return_clause.param.name,
      handler.return_clause.param.annotation,
    );
  } else if (input_type) {
    types.set(handler.return_clause.param.name, input_type);
  }

  return simple_expr_type_name(
    handler.return_clause.body,
    types,
    elaboration,
  );
}

function simple_expr_type_name(
  expr: FrontExpr,
  types: Map<string, string>,
  elaboration?: Elaboration,
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

    return "I32";
  }

  if (expr.tag === "text") {
    return "Text";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    return types.get(expr.name);
  }

  if (expr.tag === "prim") {
    if (prim_returns_bool(expr.prim)) {
      return "Bool";
    }

    if (expr.prim.startsWith("i64.")) {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return simple_expr_type_name(expr.value, types, elaboration);
  }

  if (expr.tag === "scratch") {
    return simple_expr_type_name(expr.body, types, elaboration);
  }

  if (expr.tag === "struct_value") {
    if (expr.type_expr.tag === "var" || expr.type_expr.tag === "type_name") {
      return expr.type_expr.name;
    }

    return undefined;
  }

  if (expr.tag === "union_case") {
    if (
      expr.type_expr &&
      (expr.type_expr.tag === "var" || expr.type_expr.tag === "type_name")
    ) {
      return expr.type_expr.name;
    }

    if (elaboration) {
      const declarations = elaboration.source.declarations;

      if (declarations === undefined) {
        return undefined;
      }

      let inferred: string | undefined;

      for (const declaration of declarations) {
        if (declaration.tag !== "type" || declaration.body.tag !== "sum") {
          continue;
        }

        if (!declaration.body.cases.some((item) => item.name === expr.name)) {
          continue;
        }

        if (inferred !== undefined) {
          return undefined;
        }

        inferred = declaration.name;
      }

      return inferred;
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

  if (
    expr.tag === "app" &&
    (expr.func.tag === "var" || expr.func.tag === "linear" ||
      expr.func.tag === "field") &&
    expr.func.resume_signature
  ) {
    return expr.func.resume_signature.output_type;
  }

  if (expr.tag === "app" && expr.func.tag === "var" && elaboration) {
    for (const stmt of elaboration.source.statements) {
      if (
        stmt.tag !== "bind" || stmt.name !== expr.func.name ||
        (stmt.value.tag !== "lam" && stmt.value.tag !== "rec")
      ) {
        continue;
      }

      const function_type = function_type_expr(stmt.type_annotation);

      if (function_type !== undefined) {
        return format_type_expr(function_type.result);
      }

      const call_types = new Map<string, string>();

      for (let index = 0; index < stmt.value.params.length; index += 1) {
        const param = stmt.value.params[index];
        const arg = expr.args[index];
        expect(param, "Missing typed function parameter");
        expect(arg, "Missing typed function argument");
        const type = param.annotation ||
          simple_expr_type_name(arg, types, elaboration);

        if (type) {
          call_types.set(param.name, type);
        }
      }

      return simple_expr_type_name(
        stmt.value.body,
        call_types,
        elaboration,
      );
    }
  }

  if (expr.tag === "block") {
    const local = new Map(types);

    for (const stmt of expr.statements) {
      if (stmt.tag === "bind") {
        const type = stmt.annotation ||
          simple_expr_type_name(stmt.value, local, elaboration);

        if (type) {
          local.set(stmt.name, type);
        }
      }

      if (stmt.tag === "assign") {
        const type = simple_expr_type_name(stmt.value, local, elaboration);

        if (type) {
          local.set(stmt.name, type);
        }
      }

      if (stmt.tag === "state_bind" && stmt.value_name && elaboration) {
        const ref = operation_from_state_bind(stmt, elaboration.index);
        const effect = elaboration.index.effects.get(ref.effect);
        expect(effect, "Missing typed effect: " + ref.effect);
        const declared_operation = find_operation(effect, ref.operation);
        expect(
          stmt.value.tag === "app",
          "Effect state binding must contain a call",
        );
        const operation = specialize_effect_operation(
          declared_operation,
          stmt.value,
        );
        local.set(stmt.value_name, operation.result.type_name);
      }
    }

    const final_stmt = expr.statements[expr.statements.length - 1];

    if (final_stmt && final_stmt.tag === "expr") {
      return simple_expr_type_name(final_stmt.expr, local, elaboration);
    }

    if (final_stmt && final_stmt.tag === "return") {
      return simple_expr_type_name(final_stmt.value, local, elaboration);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const left = simple_expr_type_name(
      expr.then_branch,
      new Map(types),
      elaboration,
    );
    const right = simple_expr_type_name(
      expr.else_branch,
      new Map(types),
      elaboration,
    );

    if (left === right) {
      return left;
    }
  }

  return undefined;
}

function same_handler_type(
  left: string,
  right: string,
  elaboration: Elaboration,
): boolean {
  if (left === right) {
    return true;
  }

  const i32_names = new Set(["Int", "I32", "U32"]);

  if (i32_names.has(left) && i32_names.has(right)) {
    return true;
  }

  const resolved_left = resolve_handler_alias(left, elaboration);
  const resolved_right = resolve_handler_alias(right, elaboration);

  if (resolved_left === resolved_right) {
    return true;
  }

  if (
    resolved_right === handler_type_constructor(resolved_left) &&
    !resolved_right.includes(" ")
  ) {
    return true;
  }

  return resolved_left === handler_type_constructor(resolved_right) &&
    !resolved_left.includes(" ");
}

function contextualize_handler_result(
  expr: FrontExpr,
  type_name: string,
  elaboration: Elaboration,
): FrontExpr {
  if (expr.tag === "union_case" && expr.type_expr === undefined) {
    const name = "__duck_handler_result_" +
      elaboration.next_resume.toString();
    elaboration.next_resume += 1;
    let value = expr.value;

    if (value?.tag === "unit") {
      value = undefined;
    }

    return {
      tag: "block",
      statements: [
        {
          tag: "bind",
          kind: "let",
          name,
          is_linear: false,
          annotation: type_name,
          value: { ...expr, value },
        },
        { tag: "expr", expr: { tag: "var", name } },
      ],
    };
  }

  if (expr.tag === "if" || expr.tag === "if_let") {
    return {
      ...expr,
      then_branch: contextualize_handler_result(
        expr.then_branch,
        type_name,
        elaboration,
      ),
      else_branch: contextualize_handler_result(
        expr.else_branch,
        type_name,
        elaboration,
      ),
    };
  }

  if (expr.tag === "block") {
    const statements = [...expr.statements];
    const final = statements[statements.length - 1];

    if (final?.tag === "expr") {
      statements[statements.length - 1] = {
        ...final,
        expr: contextualize_handler_result(
          final.expr,
          type_name,
          elaboration,
        ),
      };
    } else if (final?.tag === "return") {
      statements[statements.length - 1] = {
        ...final,
        value: contextualize_handler_result(
          final.value,
          type_name,
          elaboration,
        ),
      };
    }

    return { ...expr, statements };
  }

  if (expr.tag === "scratch") {
    return {
      ...expr,
      body: contextualize_handler_result(expr.body, type_name, elaboration),
    };
  }

  return expr;
}

function resolve_handler_alias(
  name: string,
  elaboration: Elaboration,
): string {
  const declaration = elaboration.source.declarations?.find((candidate) => {
    return candidate.tag === "type" && candidate.name === name;
  });

  if (
    declaration === undefined || declaration.tag !== "type" ||
    declaration.body.tag !== "alias" || declaration.body.opaque
  ) {
    return name;
  }

  return declaration.body.type_name;
}

function handler_type_constructor(name: string): string {
  const match = name.match(/[A-Za-z_][A-Za-z0-9_]*/);
  expect(match, "Invalid handler type name: " + name);
  return match[0];
}

function runtime_annotation(name: string): string {
  if (name === "Unit") {
    return "I32";
  }

  return name;
}

function unit_value(): FrontExpr {
  return { tag: "num", type: "i32", value: 0 };
}

function effect_import_name(effect: string, operation: string): string {
  return "__duck_effect_" + effect + "_" + operation;
}

function effect_text(effect: EffectRef): string {
  return effect.effect + "." + effect.operation;
}
