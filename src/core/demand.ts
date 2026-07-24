import type { Core, CoreExpr, CoreField, CoreParam, CoreStmt } from "./ast.ts";
import { core_lam_capture_names } from "./closure_capture.ts";
import { core_name_use_count } from "./name_use_count.ts";
import { substitute_core_call_expr } from "./substitute.ts";

type DemandContext = {
  called_lambdas: WeakSet<Extract<CoreExpr, { tag: "lam" }>>;
  effectful_functions: Set<string>;
  external_type_metadata: unknown;
  next_shared_name: number;
  specialized_branch_bindings: Set<string>;
};

type BranchCallTarget = {
  branch: Extract<CoreExpr, { tag: "if" }>;
  dependencies: Set<string>;
};

type BranchCallContext = {
  bound_names: Set<string>;
  targets: Map<string, BranchCallTarget>;
  specialized_bindings: Set<string>;
};

export function analyze_core_demand(core: Core): Core {
  const specialized_branch_bindings = new Set<string>();
  const statements = specialize_capture_free_branch_calls(
    core.statements,
    specialized_branch_bindings,
  );
  const context: DemandContext = {
    called_lambdas: collect_called_lambdas(statements),
    effectful_functions: new Set(core.host_imports || []),
    external_type_metadata: [core.host_imports, core.recFunctions],
    next_shared_name: 0,
    specialized_branch_bindings,
  };
  collect_effectful_function_names(statements, context);
  return {
    ...core,
    statements: demanded_statements(statements, context),
  };
}

function demanded_statements(
  statements: CoreStmt[],
  parent: DemandContext,
): CoreStmt[] {
  const context: DemandContext = {
    called_lambdas: parent.called_lambdas,
    effectful_functions: new Set(parent.effectful_functions),
    external_type_metadata: parent.external_type_metadata,
    next_shared_name: parent.next_shared_name,
    specialized_branch_bindings: parent.specialized_branch_bindings,
  };
  collect_effectful_function_names(statements, context);
  const result: CoreStmt[] = [];

  for (let index = statements.length - 1; index >= 0; index -= 1) {
    const statement = statements[index];

    if (statement === undefined) {
      throw new Error("Missing Core statement " + index.toString());
    }

    const rewritten = demanded_statement(statement, context);

    if (
      rewritten.tag === "bind" && !rewritten.is_linear &&
      rewritten.annotation === undefined &&
      binding_is_erasable(rewritten, context) &&
      !binding_is_demanded(rewritten.name, result, context) &&
      !contains_sequenced_effect(rewritten.value, context, new WeakSet())
    ) {
      continue;
    }

    result.unshift(rewritten);
  }

  parent.next_shared_name = context.next_shared_name;
  return result;
}

function collect_called_lambdas(
  statements: CoreStmt[],
): WeakSet<Extract<CoreExpr, { tag: "lam" }>> {
  const bindings = new Map<
    string,
    Extract<CoreExpr, { tag: "lam" }> | undefined
  >();
  collect_lambda_bindings(statements, bindings, new WeakSet());
  const called = new WeakSet<Extract<CoreExpr, { tag: "lam" }>>();
  collect_lambda_calls(statements, bindings, called, new WeakSet());
  return called;
}

function collect_lambda_bindings(
  value: unknown,
  bindings: Map<string, Extract<CoreExpr, { tag: "lam" }> | undefined>,
  visited: WeakSet<object>,
): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }

  visited.add(value);

  if (
    "tag" in value && value.tag === "bind" && "name" in value &&
    typeof value.name === "string" && "value" in value &&
    value.value !== null && typeof value.value === "object" &&
    "tag" in value.value && value.value.tag === "lam"
  ) {
    const existing = bindings.get(value.name);

    if (existing === undefined && !bindings.has(value.name)) {
      bindings.set(
        value.name,
        value.value as Extract<CoreExpr, { tag: "lam" }>,
      );
    } else if (existing !== value.value) {
      bindings.set(value.name, undefined);
    }
  }

  for (const child of Object.values(value)) {
    collect_lambda_bindings(child, bindings, visited);
  }
}

function collect_lambda_calls(
  value: unknown,
  bindings: Map<string, Extract<CoreExpr, { tag: "lam" }> | undefined>,
  called: WeakSet<Extract<CoreExpr, { tag: "lam" }>>,
  visited: WeakSet<object>,
): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }

  visited.add(value);

  if (
    "tag" in value && value.tag === "app" && "func" in value &&
    value.func !== null && typeof value.func === "object" &&
    "tag" in value.func
  ) {
    const direct_target = transparent_branch_lam(value.func as CoreExpr);

    if (direct_target !== undefined) {
      called.add(direct_target);
    } else if (
      value.func.tag === "var" && "name" in value.func &&
      typeof value.func.name === "string"
    ) {
      const target = bindings.get(value.func.name);

      if (target !== undefined) {
        called.add(target);
      }
    }
  }

  for (const child of Object.values(value)) {
    collect_lambda_calls(child, bindings, called, visited);
  }
}

function binding_is_erasable(
  statement: Extract<CoreStmt, { tag: "bind" }>,
  context: DemandContext,
): boolean {
  if (context.specialized_branch_bindings.has(statement.name)) {
    return true;
  }

  switch (statement.value.tag) {
    case "num":
    case "type_name":
    case "struct_type":
    case "union_type":
      return true;

    default:
      return false;
  }
}

function specialize_capture_free_branch_calls(
  statements: CoreStmt[],
  specialized_bindings: Set<string>,
): CoreStmt[] {
  const context: BranchCallContext = {
    bound_names: new Set(),
    targets: new Map(),
    specialized_bindings,
  };
  return rewrite_branch_call_statements(statements, context);
}

function rewrite_branch_call_statements(
  statements: CoreStmt[],
  context: BranchCallContext,
): CoreStmt[] {
  const result: CoreStmt[] = [];

  for (const statement of statements) {
    const rewritten = rewrite_branch_call_statement(statement, context);
    result.push(rewritten);

    if (rewritten.tag === "bind") {
      invalidate_branch_call_targets(rewritten.name, context);
      const target = capture_free_branch_call_target(
        rewritten.value,
        context.bound_names,
      );

      if (target !== undefined) {
        context.targets.set(rewritten.name, target);
      }

      context.bound_names.add(rewritten.name);
      continue;
    }

    if (rewritten.tag === "assign") {
      invalidate_branch_call_targets(rewritten.name, context);
      continue;
    }

    if (
      rewritten.tag === "range_loop" || rewritten.tag === "collection_loop" ||
      rewritten.tag === "if_stmt" || rewritten.tag === "if_else_stmt" ||
      rewritten.tag === "if_let_stmt"
    ) {
      context.targets.clear();
    }
  }

  return result;
}

function rewrite_branch_call_statement(
  statement: CoreStmt,
  context: BranchCallContext,
): CoreStmt {
  switch (statement.tag) {
    case "continue":
    case "unsupported":
      return statement;

    case "bind":
    case "assign":
      return {
        ...statement,
        value: rewrite_branch_call_expr(statement.value, context),
      };

    case "index_assign":
      return {
        ...statement,
        index: rewrite_branch_call_expr(statement.index, context),
        value: rewrite_branch_call_expr(statement.value, context),
      };

    case "range_loop": {
      const body_context = nested_branch_call_context(context);
      body_context.bound_names.add(statement.index);
      return {
        ...statement,
        start: rewrite_branch_call_expr(statement.start, context),
        end: rewrite_branch_call_expr(statement.end, context),
        step: rewrite_branch_call_expr(statement.step, context),
        body: rewrite_branch_call_statements(statement.body, body_context),
      };
    }

    case "collection_loop": {
      const body_context = nested_branch_call_context(context);
      body_context.bound_names.add(statement.item);

      if (statement.index !== undefined) {
        body_context.bound_names.add(statement.index);
      }

      return {
        ...statement,
        collection: rewrite_branch_call_expr(statement.collection, context),
        body: rewrite_branch_call_statements(statement.body, body_context),
      };
    }

    case "if_stmt":
      return {
        ...statement,
        cond: rewrite_branch_call_expr(statement.cond, context),
        body: rewrite_branch_call_statements(
          statement.body,
          nested_branch_call_context(context),
        ),
      };

    case "if_else_stmt":
      return {
        ...statement,
        cond: rewrite_branch_call_expr(statement.cond, context),
        then_body: rewrite_branch_call_statements(
          statement.then_body,
          nested_branch_call_context(context),
        ),
        else_body: rewrite_branch_call_statements(
          statement.else_body,
          nested_branch_call_context(context),
        ),
      };

    case "if_let_stmt": {
      const body_context = nested_branch_call_context(context);

      if (statement.value_name !== undefined) {
        body_context.bound_names.add(statement.value_name);
      }

      return {
        ...statement,
        target: rewrite_branch_call_expr(statement.target, context),
        body: rewrite_branch_call_statements(statement.body, body_context),
      };
    }

    case "type_check":
      return {
        ...statement,
        target: rewrite_branch_call_expr(statement.target, context),
      };

    case "break":
      if (statement.value === undefined) {
        return statement;
      }

      return {
        ...statement,
        value: rewrite_branch_call_expr(statement.value, context),
      };

    case "return":
      return {
        ...statement,
        value: rewrite_branch_call_expr(statement.value, context),
      };

    case "expr":
      return {
        ...statement,
        expr: rewrite_branch_call_expr(statement.expr, context),
      };
  }
}

function rewrite_branch_call_expr(
  expr: CoreExpr,
  context: BranchCallContext,
): CoreExpr {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "rec_ref":
    case "unsupported":
    case "lam":
    case "rec":
      return expr;

    case "prim":
      return {
        ...expr,
        args: expr.args.map((arg) => rewrite_branch_call_expr(arg, context)),
      };

    case "app": {
      const func = rewrite_branch_call_expr(expr.func, context);
      const args = expr.args.map((arg) => {
        return rewrite_branch_call_expr(arg, context);
      });

      if (func.tag !== "var") {
        return { ...expr, func, args };
      }

      const target = context.targets.get(func.name);

      if (target === undefined) {
        return { ...expr, func, args };
      }

      context.specialized_bindings.add(func.name);
      const then_args = structuredClone(args);
      const else_args = structuredClone(args);
      return {
        tag: "if",
        cond: target.branch.cond,
        then_branch: {
          tag: "app",
          func: target.branch.then_branch,
          args: then_args,
        },
        else_branch: {
          tag: "app",
          func: target.branch.else_branch,
          args: else_args,
        },
      };
    }

    case "block":
      return {
        ...expr,
        statements: rewrite_branch_call_statements(
          expr.statements,
          nested_branch_call_context(context),
        ),
      };

    case "loop":
      return {
        ...expr,
        body: rewrite_branch_call_statements(
          expr.body,
          nested_branch_call_context(context),
        ),
      };

    case "comptime":
      return {
        ...expr,
        expr: rewrite_branch_call_expr(expr.expr, context),
      };

    case "borrow":
    case "freeze":
      return {
        ...expr,
        value: rewrite_branch_call_expr(expr.value, context),
      };

    case "scratch":
      return {
        ...expr,
        body: rewrite_branch_call_expr(expr.body, context),
      };

    case "with":
    case "struct_update":
      return {
        ...expr,
        base: rewrite_branch_call_expr(expr.base, context),
        fields: rewrite_branch_call_fields(expr.fields, context),
      };

    case "struct_value":
      return {
        ...expr,
        type_expr: rewrite_branch_call_expr(expr.type_expr, context),
        fields: rewrite_branch_call_fields(expr.fields, context),
      };

    case "if":
      return {
        ...expr,
        cond: rewrite_branch_call_expr(expr.cond, context),
        then_branch: rewrite_branch_call_expr(expr.then_branch, context),
        else_branch: rewrite_branch_call_expr(expr.else_branch, context),
      };

    case "if_let": {
      const then_context = nested_branch_call_context(context);

      if (expr.value_name !== undefined) {
        then_context.bound_names.add(expr.value_name);
      }

      return {
        ...expr,
        target: rewrite_branch_call_expr(expr.target, context),
        then_branch: rewrite_branch_call_expr(expr.then_branch, then_context),
        else_branch: rewrite_branch_call_expr(expr.else_branch, context),
      };
    }

    case "field":
      return {
        ...expr,
        object: rewrite_branch_call_expr(expr.object, context),
      };

    case "index":
      return {
        ...expr,
        object: rewrite_branch_call_expr(expr.object, context),
        index: rewrite_branch_call_expr(expr.index, context),
      };

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value !== undefined) {
        value = rewrite_branch_call_expr(expr.value, context);
      }

      if (expr.type_expr !== undefined) {
        type_expr = rewrite_branch_call_expr(expr.type_expr, context);
      }

      return { ...expr, value, type_expr };
    }
  }
}

function rewrite_branch_call_fields(
  fields: CoreField[],
  context: BranchCallContext,
): CoreField[] {
  return fields.map((field) => {
    return {
      ...field,
      value: rewrite_branch_call_expr(field.value, context),
    };
  });
}

function nested_branch_call_context(
  context: BranchCallContext,
): BranchCallContext {
  return {
    bound_names: new Set(context.bound_names),
    targets: new Map(context.targets),
    specialized_bindings: context.specialized_bindings,
  };
}

function invalidate_branch_call_targets(
  name: string,
  context: BranchCallContext,
): void {
  context.targets.delete(name);

  for (const [target_name, target] of context.targets) {
    if (target.dependencies.has(name)) {
      context.targets.delete(target_name);
    }
  }
}

function capture_free_branch_call_target(
  value: CoreExpr,
  bound_names: Set<string>,
): BranchCallTarget | undefined {
  if (value.tag !== "if") {
    return undefined;
  }

  const then_target = transparent_branch_lam(value.then_branch);
  const else_target = transparent_branch_lam(value.else_branch);

  if (then_target === undefined || else_target === undefined) {
    return undefined;
  }

  if (!branch_params_support_demand_specialization(then_target, else_target)) {
    return undefined;
  }

  const dependencies = stable_branch_condition_dependencies(value.cond);

  if (dependencies === undefined) {
    return undefined;
  }

  const locals = new Map<string, "i32">();

  for (const name of bound_names) {
    locals.set(name, "i32");
  }

  const capture_context = {
    locals,
    statics: new Map<string, CoreExpr>(),
    fn_types: new Map(),
    text_locals: new Set<string>(),
    struct_locals: new Map<string, CoreExpr>(),
    union_locals: new Map<string, CoreExpr>(),
  };
  const hooks = { static_struct_binding: () => undefined };
  const then_captures = core_lam_capture_names(
    then_target,
    capture_context,
    hooks,
  );
  const else_captures = core_lam_capture_names(
    else_target,
    capture_context,
    hooks,
  );

  if (
    then_captures === undefined || else_captures === undefined ||
    then_captures.length !== 0 || else_captures.length !== 0
  ) {
    return undefined;
  }

  return { branch: value, dependencies };
}

function branch_params_support_demand_specialization(
  then_target: Extract<CoreExpr, { tag: "lam" }>,
  else_target: Extract<CoreExpr, { tag: "lam" }>,
): boolean {
  if (then_target.params.length !== else_target.params.length) {
    return false;
  }

  const scalar_annotations = new Set([
    "Bool",
    "Char",
    "F32",
    "F64",
    "I32",
    "I64",
    "Int",
  ]);

  for (let index = 0; index < then_target.params.length; index += 1) {
    const then_param = then_target.params[index];
    const else_param = else_target.params[index];

    if (then_param === undefined || else_param === undefined) {
      return false;
    }

    if (
      then_param.annotation === undefined ||
      then_param.annotation !== else_param.annotation ||
      !scalar_annotations.has(then_param.annotation)
    ) {
      return false;
    }
  }

  return true;
}

function transparent_branch_lam(
  value: CoreExpr,
): Extract<CoreExpr, { tag: "lam" }> | undefined {
  if (value.tag === "lam") {
    return value;
  }

  if (value.tag !== "block" || value.statements.length !== 1) {
    return undefined;
  }

  const statement = value.statements[0];

  if (statement?.tag !== "expr") {
    return undefined;
  }

  return transparent_branch_lam(statement.expr);
}

function stable_branch_condition_dependencies(
  condition: CoreExpr,
): Set<string> | undefined {
  if (condition.tag === "num") {
    return new Set();
  }

  if (condition.tag === "var" || condition.tag === "linear") {
    return new Set([condition.name]);
  }

  return undefined;
}

function binding_is_demanded(
  name: string,
  statements: CoreStmt[],
  context: DemandContext,
): boolean {
  if (core_name_use_count({ tag: "block", statements }, name) > 0) {
    return true;
  }

  if (contains_type_reference(statements, name, new WeakSet())) {
    return true;
  }

  return contains_type_reference(
    context.external_type_metadata,
    name,
    new WeakSet(),
  );
}

function demanded_statement(
  statement: CoreStmt,
  context: DemandContext,
): CoreStmt {
  switch (statement.tag) {
    case "continue":
    case "unsupported":
      return statement;

    case "bind":
    case "assign":
      return {
        ...statement,
        value: demanded_expr(statement.value, context),
      };

    case "index_assign":
      return {
        ...statement,
        index: demanded_expr(statement.index, context),
        value: demanded_expr(statement.value, context),
      };

    case "range_loop":
      return {
        ...statement,
        start: demanded_expr(statement.start, context),
        end: demanded_expr(statement.end, context),
        step: demanded_expr(statement.step, context),
        body: demanded_statements(statement.body, context),
      };

    case "collection_loop":
      return {
        ...statement,
        collection: demanded_expr(statement.collection, context),
        body: demanded_statements(statement.body, context),
      };

    case "if_stmt":
      return {
        ...statement,
        cond: demanded_expr(statement.cond, context),
        body: demanded_statements(statement.body, context),
      };

    case "if_else_stmt":
      return {
        ...statement,
        cond: demanded_expr(statement.cond, context),
        then_body: demanded_statements(statement.then_body, context),
        else_body: demanded_statements(statement.else_body, context),
      };

    case "if_let_stmt":
      return {
        ...statement,
        target: demanded_expr(statement.target, context),
        body: demanded_statements(statement.body, context),
      };

    case "type_check":
      return {
        ...statement,
        target: demanded_expr(statement.target, context),
      };

    case "break":
      if (statement.value === undefined) {
        return statement;
      }

      return {
        ...statement,
        value: demanded_expr(statement.value, context),
      };

    case "return":
      return {
        ...statement,
        value: demanded_expr(statement.value, context),
      };

    case "expr":
      return {
        ...statement,
        expr: demanded_expr(statement.expr, context),
      };
  }
}

function demanded_expr(expr: CoreExpr, context: DemandContext): CoreExpr {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "rec_ref":
    case "unsupported":
      return expr;

    case "prim":
      return {
        ...expr,
        args: expr.args.map((arg) => demanded_expr(arg, context)),
      };

    case "lam": {
      let body = demanded_expr(expr.body, context);

      if (!context.called_lambdas.has(expr)) {
        return { ...expr, body };
      }

      for (const param of expr.params) {
        if (
          param.is_linear || param.annotation?.startsWith("&") ||
          param.annotation?.startsWith("^")
        ) {
          continue;
        }

        if (core_name_use_count(body, param.name) > 1) {
          body = share_parameter_in_demand_region(body, param, context);
        }
      }

      return { ...expr, body };
    }

    case "rec":
      return { ...expr, body: demanded_expr(expr.body, context) };

    case "app":
      return {
        ...expr,
        func: demanded_expr(expr.func, context),
        args: expr.args.map((arg) => demanded_expr(arg, context)),
      };

    case "block":
      return {
        ...expr,
        statements: demanded_statements(expr.statements, context),
      };

    case "loop":
      return {
        ...expr,
        body: demanded_statements(expr.body, context),
      };

    case "comptime":
      return { ...expr, expr: demanded_expr(expr.expr, context) };

    case "borrow":
    case "freeze":
      return { ...expr, value: demanded_expr(expr.value, context) };

    case "scratch":
      return { ...expr, body: demanded_expr(expr.body, context) };

    case "with":
    case "struct_update":
      return {
        ...expr,
        base: demanded_expr(expr.base, context),
        fields: demanded_fields(expr.fields, context),
      };

    case "struct_value":
      return {
        ...expr,
        type_expr: demanded_expr(expr.type_expr, context),
        fields: demanded_fields(expr.fields, context),
      };

    case "if":
      return {
        ...expr,
        cond: demanded_expr(expr.cond, context),
        then_branch: demanded_expr(expr.then_branch, context),
        else_branch: demanded_expr(expr.else_branch, context),
      };

    case "if_let":
      return {
        ...expr,
        target: demanded_expr(expr.target, context),
        then_branch: demanded_expr(expr.then_branch, context),
        else_branch: demanded_expr(expr.else_branch, context),
      };

    case "field":
      return { ...expr, object: demanded_expr(expr.object, context) };

    case "index":
      return {
        ...expr,
        object: demanded_expr(expr.object, context),
        index: demanded_expr(expr.index, context),
      };

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value !== undefined) {
        value = demanded_expr(expr.value, context);
      }

      if (expr.type_expr !== undefined) {
        type_expr = demanded_expr(expr.type_expr, context);
      }

      return { ...expr, value, type_expr };
    }
  }
}

function demanded_fields(
  fields: CoreField[],
  context: DemandContext,
): CoreField[] {
  return fields.map((field) => ({
    ...field,
    value: demanded_expr(field.value, context),
  }));
}

function share_parameter_in_demand_region(
  body: CoreExpr,
  param: CoreParam,
  context: DemandContext,
): CoreExpr {
  if (body.tag === "if" && core_name_use_count(body.cond, param.name) === 0) {
    return {
      ...body,
      then_branch: share_parameter_if_repeated(
        body.then_branch,
        param,
        context,
      ),
      else_branch: share_parameter_if_repeated(
        body.else_branch,
        param,
        context,
      ),
    };
  }

  if (
    body.tag === "if_let" &&
    core_name_use_count(body.target, param.name) === 0
  ) {
    return {
      ...body,
      then_branch: share_parameter_if_repeated(
        body.then_branch,
        param,
        context,
      ),
      else_branch: share_parameter_if_repeated(
        body.else_branch,
        param,
        context,
      ),
    };
  }

  if (body.tag === "block") {
    let demanding_index: number | undefined;

    for (let index = 0; index < body.statements.length; index += 1) {
      const statement = body.statements[index];

      if (statement === undefined) {
        throw new Error("Missing demand-region statement " + index.toString());
      }

      if (
        core_name_use_count(
          { tag: "block", statements: [statement] },
          param.name,
        ) === 0
      ) {
        continue;
      }

      if (demanding_index !== undefined) {
        return shared_parameter_wrapper(body, param, context);
      }

      demanding_index = index;
    }

    if (demanding_index !== undefined) {
      const statement = body.statements[demanding_index];

      if (statement === undefined) {
        throw new Error("Missing selected demand-region statement");
      }

      const rewritten = share_parameter_in_statement(
        statement,
        param,
        context,
      );

      if (rewritten === undefined) {
        return shared_parameter_wrapper(body, param, context);
      }

      const statements = [...body.statements];
      statements[demanding_index] = rewritten;
      return { ...body, statements };
    }
  }

  return shared_parameter_wrapper(body, param, context);
}

function share_parameter_if_repeated(
  expr: CoreExpr,
  param: CoreParam,
  context: DemandContext,
): CoreExpr {
  if (core_name_use_count(expr, param.name) <= 1) {
    return expr;
  }

  return share_parameter_in_demand_region(expr, param, context);
}

function share_parameter_in_statement(
  statement: CoreStmt,
  param: CoreParam,
  context: DemandContext,
): CoreStmt | undefined {
  if (statement.tag === "bind" || statement.tag === "assign") {
    return {
      ...statement,
      value: share_parameter_in_demand_region(statement.value, param, context),
    };
  }

  if (statement.tag === "expr") {
    return {
      ...statement,
      expr: share_parameter_in_demand_region(statement.expr, param, context),
    };
  }

  if (statement.tag === "return" || statement.tag === "break") {
    if (statement.value === undefined) {
      return statement;
    }

    return {
      ...statement,
      value: share_parameter_in_demand_region(statement.value, param, context),
    };
  }

  return undefined;
}

function shared_parameter_wrapper(
  body: CoreExpr,
  param: CoreParam,
  context: DemandContext,
): CoreExpr {
  const shared_name = "_demand#" + context.next_shared_name.toString();
  context.next_shared_name += 1;
  const replacements = new Map<string, CoreExpr>([[
    param.name,
    { tag: "var", name: shared_name },
  ]]);
  const shared_body = substitute_core_call_expr(body, replacements);

  const binding: CoreStmt = {
    tag: "bind",
    kind: "let",
    name: shared_name,
    is_linear: false,
    annotation: param.annotation,
    value: { tag: "var", name: param.name },
  };

  if (shared_body.tag === "block") {
    return {
      ...shared_body,
      statements: [binding, ...shared_body.statements],
    };
  }

  return {
    tag: "block",
    statements: [binding, {
      tag: "expr",
      expr: shared_body,
    }],
  };
}

function collect_effectful_function_names(
  statements: CoreStmt[],
  context: DemandContext,
): void {
  const functions = statements.filter((statement) => {
    return statement.tag === "bind" &&
      (statement.value.tag === "lam" || statement.value.tag === "rec");
  });

  for (const statement of functions) {
    if (statement.tag === "bind") {
      context.effectful_functions.delete(statement.name);
    }
  }

  let changed = true;

  while (changed) {
    changed = false;

    for (const statement of functions) {
      if (
        statement.tag !== "bind" ||
        context.effectful_functions.has(statement.name)
      ) {
        continue;
      }

      if (contains_sequenced_effect(statement.value, context, new WeakSet())) {
        context.effectful_functions.add(statement.name);
        changed = true;
      }
    }
  }
}

function contains_sequenced_effect(
  value: unknown,
  context: DemandContext,
  visited: WeakSet<object>,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (visited.has(value)) {
    return false;
  }

  visited.add(value);

  if (
    "tag" in value && value.tag === "app" && "func" in value &&
    value.func !== null && typeof value.func === "object" &&
    "tag" in value.func && value.func.tag === "var" &&
    "name" in value.func && typeof value.func.name === "string" &&
    context.effectful_functions.has(value.func.name)
  ) {
    return true;
  }

  for (const child of Object.values(value)) {
    if (contains_sequenced_effect(child, context, visited)) {
      return true;
    }
  }

  return false;
}

function contains_type_reference(
  value: unknown,
  name: string,
  visited: WeakSet<object>,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (visited.has(value)) {
    return false;
  }

  visited.add(value);

  if (
    "tag" in value && value.tag === "var" && "name" in value &&
    value.name === name
  ) {
    return true;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "annotation" || key === "type_name") &&
      typeof child === "string" && type_text_references_name(child, name)
    ) {
      return true;
    }

    if (contains_type_reference(child, name, visited)) {
      return true;
    }
  }

  return false;
}

function type_text_references_name(text: string, name: string): boolean {
  return text.split(/[^A-Za-z0-9_]+/).includes(name);
}
