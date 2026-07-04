import type {
  Core,
  CoreExpr,
  CoreHostImport,
  CoreParam,
  CoreStmt,
} from "./ast.ts";
import {
  core_host_import_arg_decision,
  core_host_import_for_app,
  type CoreHostImportCtx,
} from "./host_import.ts";
import {
  core_expr_ownership,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";
import {
  static_core_call_branch_app,
  type StaticCoreCallCtx,
} from "./static_call.ts";

export type CoreHostBoundaryDecision =
  | {
    tag: "allowed";
    reason: string;
  }
  | {
    tag: "rejected";
    reason: string;
  };

export type CoreHostBoundaryArg = {
  index: number;
  ownership: CoreOwnership;
  decision: CoreHostBoundaryDecision;
};

export type CoreHostBoundaryEdge = {
  id: string;
  callee: string;
  signature: CoreHostImport | undefined;
  args: CoreHostBoundaryArg[];
  decision: CoreHostBoundaryDecision;
};

export type CoreHostBoundaryPlan = {
  edges: CoreHostBoundaryEdge[];
};

export type CoreHostBoundaryClosureCtx<ctx> =
  | {
    tag: "scan";
    ctx: ctx;
  }
  | {
    tag: "skip";
  };

export type CoreHostBoundaryHooks<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
> =
  & CoreOwnershipHooks<ctx>
  & {
    closure_body_ctx: (
      expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
      ctx: ctx,
    ) => CoreHostBoundaryClosureCtx<ctx>;
    static_core_call_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
    static_core_call_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
    static_core_rec_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "rec" }> | undefined;
  };

type CoreHostBoundaryState = {
  next_host: number;
  edges: CoreHostBoundaryEdge[];
  scratch_depth: number;
  scratch_locals: Map<string, CoreOwnership>;
  aliases: Map<string, CoreExpr>;
  functions: Map<string, StaticHostBoundaryTarget>;
  active_static_calls: Set<string>;
  static_wrapper_depth: number;
};

type StaticHostBoundaryFunction = Extract<
  CoreExpr,
  { tag: "lam" | "rec" }
>;

type StaticHostBoundaryTarget =
  | StaticHostBoundaryFunction
  | {
    tag: "branch";
    kind: "if" | "if_let";
    then_target: StaticHostBoundaryTarget;
    else_target: StaticHostBoundaryTarget;
  };

export function core_host_boundary_plan<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  core: Core,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
): CoreHostBoundaryPlan {
  const state: CoreHostBoundaryState = {
    next_host: 0,
    edges: [],
    scratch_depth: 0,
    scratch_locals: new Map(),
    aliases: new Map(),
    functions: new Map(),
    active_static_calls: new Set(),
    static_wrapper_depth: 0,
  };

  scan_host_boundary_stmts(core.statements, ctx, hooks, state);

  return {
    edges: state.edges,
  };
}

function scan_host_boundary_stmts<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  for (const stmt of statements) {
    scan_host_boundary_stmt(stmt, ctx, hooks, state);
    collect_host_boundary_stmt_locals(stmt, ctx, hooks, state);
  }
}

function scan_host_boundary_stmt<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  switch (stmt.tag) {
    case "bind":
    case "assign":
      if (
        scan_static_host_boundary_wrapper_definition(
          stmt.value,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }

      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "index_assign":
      scan_host_boundary_expr(stmt.index, ctx, hooks, state);
      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "range_loop":
      scan_host_boundary_expr(stmt.start, ctx, hooks, state);
      scan_host_boundary_expr(stmt.end, ctx, hooks, state);
      scan_host_boundary_expr(stmt.step, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_host_boundary_expr(stmt.collection, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_stmt":
      scan_host_boundary_expr(stmt.cond, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "if_else_stmt":
      scan_host_boundary_expr(stmt.cond, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.then_body, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.else_body, ctx, hooks, state);
      return;

    case "if_let_stmt":
      scan_host_boundary_expr(stmt.target, ctx, hooks, state);
      scan_host_boundary_stmts(stmt.body, ctx, hooks, state);
      return;

    case "type_check":
      scan_host_boundary_expr(stmt.target, ctx, hooks, state);
      return;

    case "return":
      scan_host_boundary_expr(stmt.value, ctx, hooks, state);
      return;

    case "expr":
      scan_host_boundary_expr(stmt.expr, ctx, hooks, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_host_boundary_expr<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_host_boundary_expr(arg, ctx, hooks, state);
      }
      return;

    case "lam":
    case "rec": {
      if (host_boundary_closure_has_const_params(expr)) {
        return;
      }

      const closure = hooks.closure_body_ctx(expr, ctx);

      if (closure.tag === "scan") {
        scan_host_boundary_with_shadowed_aliases(
          expr.params,
          state,
          () => scan_host_boundary_expr(expr.body, closure.ctx, hooks, state),
        );
      }
      return;
    }

    case "app":
      scan_host_boundary_app(expr, ctx, hooks, state);
      return;

    case "block":
      scan_host_boundary_stmts(expr.statements, ctx, hooks, state);
      return;

    case "comptime":
      scan_host_boundary_expr(expr.expr, ctx, hooks, state);
      return;

    case "borrow":
    case "freeze":
      scan_host_boundary_expr(expr.value, ctx, hooks, state);
      return;

    case "scratch": {
      const scratch_locals = state.scratch_locals;
      state.scratch_locals = new Map(scratch_locals);
      state.scratch_depth += 1;
      scan_host_boundary_expr(expr.body, ctx, hooks, state);
      state.scratch_depth -= 1;
      state.scratch_locals = scratch_locals;
      return;
    }

    case "with":
      scan_host_boundary_expr(expr.base, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "struct_value":
      scan_host_boundary_expr(expr.type_expr, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "struct_update":
      scan_host_boundary_expr(expr.base, ctx, hooks, state);
      for (const field of expr.fields) {
        scan_host_boundary_expr(field.value, ctx, hooks, state);
      }
      return;

    case "if":
      scan_host_boundary_expr(expr.cond, ctx, hooks, state);
      scan_host_boundary_expr(expr.then_branch, ctx, hooks, state);
      scan_host_boundary_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "if_let":
      scan_host_boundary_expr(expr.target, ctx, hooks, state);
      scan_host_boundary_expr(expr.then_branch, ctx, hooks, state);
      scan_host_boundary_expr(expr.else_branch, ctx, hooks, state);
      return;

    case "field":
      scan_host_boundary_expr(expr.object, ctx, hooks, state);
      return;

    case "index":
      scan_host_boundary_expr(expr.object, ctx, hooks, state);
      scan_host_boundary_expr(expr.index, ctx, hooks, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_host_boundary_expr(expr.value, ctx, hooks, state);
      }
      if (expr.type_expr) {
        scan_host_boundary_expr(expr.type_expr, ctx, hooks, state);
      }
      return;
  }
}

function host_boundary_closure_has_const_params(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
): boolean {
  for (const param of expr.params) {
    if (param.is_const) {
      return true;
    }
  }

  return false;
}

function scan_host_boundary_app<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  const app = host_boundary_app_with_func_alias(expr, state);
  const branch_static_call = static_core_call_branch_app(app, ctx, hooks);

  if (branch_static_call) {
    scan_host_boundary_expr(branch_static_call, ctx, hooks, state);
    return;
  }

  scan_host_boundary_expr(expr.func, ctx, hooks, state);

  for (const arg of expr.args) {
    scan_host_boundary_expr(arg, ctx, hooks, state);
  }

  const state_target = static_host_boundary_app_target(app, state);

  if (
    state_target &&
    scan_static_host_boundary_call(app, state_target, ctx, hooks, state)
  ) {
    return;
  }

  const target = hooks.static_core_call_target(app.func, ctx);

  if (
    target && scan_static_host_boundary_call(app, target, ctx, hooks, state)
  ) {
    return;
  }

  const rec_target = hooks.static_core_rec_target(app.func, ctx);

  if (
    rec_target &&
    scan_static_host_boundary_call(app, rec_target, ctx, hooks, state)
  ) {
    return;
  }

  const signature = core_host_import_for_app(app, ctx);

  if (
    signature &&
    state.static_wrapper_depth > 0 &&
    host_import_has_ownership_transfer(signature)
  ) {
    return;
  }

  if (core_app_is_known(app, ctx, hooks, signature)) {
    return;
  }

  if (app.func.tag !== "var") {
    return;
  }

  const args = host_boundary_args(app, ctx, hooks, signature, state);
  const decision = host_boundary_decision(app.func.name, args, signature);
  const id = "host#" + state.next_host.toString();
  state.next_host += 1;

  state.edges.push({
    id,
    callee: app.func.name,
    signature,
    args,
    decision,
  });
}

function host_boundary_app_with_func_alias(
  expr: Extract<CoreExpr, { tag: "app" }>,
  state: CoreHostBoundaryState,
): Extract<CoreExpr, { tag: "app" }> {
  if (expr.func.tag !== "var") {
    return expr;
  }

  const alias = host_boundary_arg_alias(expr.func, state);

  if (!alias) {
    return expr;
  }

  return {
    ...expr,
    func: alias,
  };
}

function core_app_is_known<ctx extends CoreHostImportCtx & StaticCoreCallCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  signature: CoreHostImport | undefined,
): boolean {
  if (expr.func.tag === "var" && expr.func.name === "rec") {
    return true;
  }

  if (expr.func.tag === "var" && core_builtin_app_name(expr.func.name)) {
    return true;
  }

  if (signature) {
    return false;
  }

  if (hooks.static_core_rec_target(expr.func, ctx)) {
    return true;
  }

  if (hooks.static_core_call_value(expr, ctx)) {
    return true;
  }

  if (hooks.static_core_call_target(expr.func, ctx)) {
    return true;
  }

  if (hooks.closure_fn_type(expr.func, ctx)) {
    return true;
  }

  return false;
}

function core_builtin_app_name(name: string): boolean {
  if (name === "len") {
    return true;
  }

  if (name === "get") {
    return true;
  }

  if (name === "slice") {
    return true;
  }

  if (name === "panic") {
    return true;
  }

  if (name === "append") {
    return true;
  }

  return false;
}

function collect_host_boundary_stmt_locals<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  record_host_boundary_stmt_alias(stmt, state);
  bind_host_boundary_stmt_function(stmt, state);

  if (!hooks.collect_stmt_locals) {
    return;
  }

  try {
    hooks.collect_stmt_locals(stmt, ctx);
  } catch (_error) {
    return;
  }

  if (state.scratch_depth === 0) {
    return;
  }

  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return;
  }

  record_host_boundary_scratch_local(stmt.name, stmt.value, ctx, hooks, state);
}

function record_host_boundary_stmt_alias(
  stmt: CoreStmt,
  state: CoreHostBoundaryState,
): void {
  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return;
  }

  if (stmt.value.tag === "var") {
    state.aliases.set(stmt.name, stmt.value);
    return;
  }

  if (stmt.value.tag === "borrow" && stmt.value.value.tag === "var") {
    state.aliases.set(stmt.name, stmt.value);
    return;
  }

  state.aliases.delete(stmt.name);
}

function bind_host_boundary_stmt_function(
  stmt: CoreStmt,
  state: CoreHostBoundaryState,
): void {
  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return;
  }

  const target = static_host_boundary_function_value(stmt.value, state);

  if (target) {
    state.functions.set(stmt.name, target);
    return;
  }

  state.functions.delete(stmt.name);
}

function host_boundary_args<ctx extends CoreHostImportCtx & StaticCoreCallCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  signature: CoreHostImport | undefined,
  state: CoreHostBoundaryState,
): CoreHostBoundaryArg[] {
  const args: CoreHostBoundaryArg[] = [];

  for (let index = 0; index < expr.args.length; index += 1) {
    const arg = expr.args[index];

    if (!arg) {
      throw new Error("Missing host/import argument " + index.toString());
    }

    const ownership = host_boundary_arg_ownership(arg, ctx, hooks, state);

    args.push({
      index,
      ownership,
      decision: host_boundary_arg_decision(ownership, signature, index),
    });
  }

  return args;
}

function host_boundary_arg_ownership<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  arg: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): CoreOwnership {
  if (arg.tag === "var") {
    const alias = host_boundary_arg_alias(arg, state);

    if (alias) {
      return host_boundary_arg_ownership(alias, ctx, hooks, state);
    }

    const scratch_local = state.scratch_locals.get(arg.name);

    if (scratch_local) {
      return scratch_local;
    }
  }

  if (arg.tag === "borrow" && arg.value.tag === "var") {
    const alias = host_boundary_arg_alias(arg.value, state);

    if (alias) {
      return host_boundary_arg_ownership(
        {
          tag: "borrow",
          value: alias,
        },
        ctx,
        hooks,
        state,
      );
    }

    const scratch_local = state.scratch_locals.get(arg.value.name);

    if (scratch_local) {
      return {
        tag: "borrow_view",
        source: scratch_local,
      };
    }
  }

  const ownership = core_expr_ownership(arg, ctx, hooks);

  if (ownership.tag === "scratch_backed") {
    return ownership;
  }

  if (state.scratch_depth === 0) {
    return ownership;
  }

  if (ownership.tag !== "unique_heap") {
    return ownership;
  }

  if (!host_boundary_expr_allocates_in_scratch(arg, ctx, hooks)) {
    return ownership;
  }

  return {
    tag: "scratch_backed",
    source: ownership,
  };
}

function record_host_boundary_scratch_local<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  if (!host_boundary_expr_allocates_in_scratch(value, ctx, hooks)) {
    state.scratch_locals.delete(name);
    return;
  }

  const ownership = core_expr_ownership(value, ctx, hooks);

  if (ownership.tag !== "unique_heap") {
    state.scratch_locals.delete(name);
    return;
  }

  state.scratch_locals.set(name, {
    tag: "scratch_backed",
    source: ownership,
  });
}

function host_boundary_expr_allocates_in_scratch<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
): boolean {
  if (expr.tag === "app") {
    if (core_host_import_for_app(expr, ctx)) {
      return false;
    }

    if (expr.func.tag === "var" && expr.func.name === "append") {
      if (!hooks.closure_fn_type(expr.func, ctx)) {
        return true;
      }
    }

    if (expr.func.tag === "var" && expr.func.name === "slice") {
      return true;
    }

    return false;
  }

  if (expr.tag === "struct_value") {
    return true;
  }

  if (expr.tag === "union_case") {
    return true;
  }

  if (expr.tag === "lam") {
    return hooks.closure_fn_type(expr, ctx) !== undefined;
  }

  if (expr.tag === "block") {
    const last = expr.statements[expr.statements.length - 1];

    if (!last) {
      return false;
    }

    if (last.tag === "expr") {
      return host_boundary_expr_allocates_in_scratch(last.expr, ctx, hooks);
    }

    if (last.tag === "return") {
      return host_boundary_expr_allocates_in_scratch(last.value, ctx, hooks);
    }

    return false;
  }

  return false;
}

function scan_static_host_boundary_call<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: StaticHostBoundaryTarget,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): boolean {
  const params = static_host_boundary_target_params(target);

  if (!params) {
    return false;
  }

  if (params.length !== expr.args.length) {
    return false;
  }

  let call_name: string | undefined;

  if (expr.func.tag === "var") {
    call_name = expr.func.name;

    if (state.active_static_calls.has(call_name)) {
      return true;
    }
  }

  const previous_aliases = state.aliases;
  state.aliases = new Map(previous_aliases);

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = expr.args[index];

    if (!param) {
      throw new Error("Missing host boundary wrapper parameter");
    }

    if (!arg) {
      throw new Error("Missing host boundary wrapper argument");
    }

    state.aliases.set(param.name, arg);
  }

  if (!static_host_boundary_wrapper_target(target, ctx, hooks, state)) {
    state.aliases = previous_aliases;
    return false;
  }

  if (call_name) {
    state.active_static_calls.add(call_name);
  }

  state.static_wrapper_depth += 1;

  try {
    scan_static_host_boundary_target_call(
      target,
      expr.args,
      ctx,
      hooks,
      state,
    );
  } finally {
    state.static_wrapper_depth -= 1;

    if (call_name) {
      state.active_static_calls.delete(call_name);
    }

    state.aliases = previous_aliases;
  }

  return true;
}

function static_host_boundary_wrapper_target<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  target: StaticHostBoundaryTarget,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): boolean {
  if (target.tag === "branch") {
    return static_host_boundary_wrapper_target(
      target.then_target,
      ctx,
      hooks,
      state,
    ) &&
      static_host_boundary_wrapper_target(
        target.else_target,
        ctx,
        hooks,
        state,
      );
  }

  return static_host_boundary_wrapper_body(target.body, ctx, hooks, state);
}

function scan_static_host_boundary_target_call<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  target: StaticHostBoundaryTarget,
  args: CoreExpr[],
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  if (target.tag === "lam" || target.tag === "rec") {
    let body_ctx = ctx;
    const closure = hooks.closure_body_ctx(target, ctx);

    if (closure.tag === "scan") {
      body_ctx = closure.ctx;
    }

    const previous_aliases = state.aliases;
    state.aliases = new Map(previous_aliases);

    for (let index = 0; index < target.params.length; index += 1) {
      const param = target.params[index];
      const arg = args[index];

      if (!param) {
        throw new Error("Missing host boundary target parameter");
      }

      if (!arg) {
        throw new Error("Missing host boundary target argument");
      }

      state.aliases.set(param.name, arg);
    }

    try {
      scan_host_boundary_expr(target.body, body_ctx, hooks, state);
    } finally {
      state.aliases = previous_aliases;
    }
    return;
  }

  scan_static_host_boundary_target_call(
    target.then_target,
    args,
    ctx,
    hooks,
    state,
  );
  scan_static_host_boundary_target_call(
    target.else_target,
    args,
    ctx,
    hooks,
    state,
  );
}

function static_host_boundary_target_params(
  target: StaticHostBoundaryTarget,
): CoreParam[] | undefined {
  if (target.tag === "lam" || target.tag === "rec") {
    return target.params;
  }

  const then_params = static_host_boundary_target_params(target.then_target);
  const else_params = static_host_boundary_target_params(target.else_target);

  if (!then_params) {
    return undefined;
  }

  if (!else_params) {
    return undefined;
  }

  if (then_params.length !== else_params.length) {
    return undefined;
  }

  return then_params;
}

function scan_static_host_boundary_wrapper_definition<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): boolean {
  const target = static_host_boundary_function_value(expr, state);

  if (!target) {
    return false;
  }

  if (!static_host_boundary_wrapper_target(target, ctx, hooks, state)) {
    return false;
  }

  scan_static_host_boundary_wrapper_definition_conditions(
    expr,
    ctx,
    hooks,
    state,
  );
  return true;
}

function scan_static_host_boundary_wrapper_definition_conditions<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): void {
  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return;
    }

    if (final_stmt.tag === "expr") {
      scan_static_host_boundary_wrapper_definition_conditions(
        final_stmt.expr,
        ctx,
        hooks,
        state,
      );
      return;
    }

    if (final_stmt.tag === "return") {
      scan_static_host_boundary_wrapper_definition_conditions(
        final_stmt.value,
        ctx,
        hooks,
        state,
      );
    }

    return;
  }

  if (expr.tag === "if") {
    scan_host_boundary_expr(expr.cond, ctx, hooks, state);
    return;
  }

  if (expr.tag === "if_let") {
    scan_host_boundary_expr(expr.target, ctx, hooks, state);
  }
}

function static_host_boundary_app_target(
  expr: Extract<CoreExpr, { tag: "app" }>,
  state: CoreHostBoundaryState,
): StaticHostBoundaryTarget | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  const direct = state.functions.get(expr.func.name);

  if (direct) {
    return direct;
  }

  const alias = host_boundary_arg_alias(expr.func, state);

  if (!alias || alias.tag !== "var") {
    return undefined;
  }

  return state.functions.get(alias.name);
}

function static_host_boundary_function_value(
  expr: CoreExpr,
  state: CoreHostBoundaryState,
): StaticHostBoundaryTarget | undefined {
  const direct = static_host_boundary_function(expr);

  if (direct) {
    return direct;
  }

  if (expr.tag === "var") {
    return state.functions.get(expr.name);
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return static_host_boundary_function_value(final_stmt.expr, state);
    }

    if (final_stmt.tag === "return") {
      return static_host_boundary_function_value(final_stmt.value, state);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_host_boundary_function_value(
      expr.then_branch,
      state,
    );
    const else_target = static_host_boundary_function_value(
      expr.else_branch,
      state,
    );

    if (!then_target || !else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if",
      then_target,
      else_target,
    };
  }

  if (expr.tag === "if_let") {
    const then_target = static_host_boundary_function_value(
      expr.then_branch,
      state,
    );
    const else_target = static_host_boundary_function_value(
      expr.else_branch,
      state,
    );

    if (!then_target || !else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if_let",
      then_target,
      else_target,
    };
  }

  return undefined;
}

function static_host_boundary_function(
  expr: CoreExpr,
): StaticHostBoundaryTarget | undefined {
  if (expr.tag === "lam" || expr.tag === "rec") {
    return expr;
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return static_host_boundary_function(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return static_host_boundary_function(final_stmt.value);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_host_boundary_function(expr.then_branch);
    const else_target = static_host_boundary_function(expr.else_branch);

    if (!then_target || !else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if",
      then_target,
      else_target,
    };
  }

  if (expr.tag === "if_let") {
    const then_target = static_host_boundary_function(expr.then_branch);
    const else_target = static_host_boundary_function(expr.else_branch);

    if (!then_target || !else_target) {
      return undefined;
    }

    return {
      tag: "branch",
      kind: "if_let",
      then_target,
      else_target,
    };
  }

  return undefined;
}

function static_host_boundary_wrapper_body<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): boolean {
  if (expr.tag === "app") {
    return static_host_boundary_wrapper_app(expr, ctx, hooks, state);
  }

  if (expr.tag === "block") {
    if (expr.statements.length === 0) {
      return false;
    }

    const previous_aliases = state.aliases;
    state.aliases = new Map(previous_aliases);

    try {
      for (let index = 0; index + 1 < expr.statements.length; index += 1) {
        const stmt = expr.statements[index];

        if (!stmt) {
          throw new Error("Missing host boundary wrapper statement");
        }

        if (!static_host_boundary_wrapper_prefix_stmt(stmt)) {
          return false;
        }

        record_host_boundary_stmt_alias(stmt, state);
      }

      const final_stmt = expr.statements[expr.statements.length - 1];

      if (!final_stmt) {
        throw new Error("Missing host boundary wrapper final statement");
      }

      if (final_stmt.tag === "expr") {
        return static_host_boundary_wrapper_body(
          final_stmt.expr,
          ctx,
          hooks,
          state,
        );
      }

      if (final_stmt.tag === "return") {
        return static_host_boundary_wrapper_body(
          final_stmt.value,
          ctx,
          hooks,
          state,
        );
      }
    } finally {
      state.aliases = previous_aliases;
    }
  }

  return false;
}

function static_host_boundary_wrapper_prefix_stmt(stmt: CoreStmt): boolean {
  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return false;
  }

  if (stmt.value.tag === "var") {
    return true;
  }

  if (stmt.value.tag === "borrow" && stmt.value.value.tag === "var") {
    return true;
  }

  return false;
}

function static_host_boundary_wrapper_app<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
): boolean {
  const app = host_boundary_app_with_func_alias(expr, state);
  const signature = core_host_import_for_app(app, ctx);

  if (signature) {
    return !host_import_has_ownership_transfer(signature);
  }

  const state_target = static_host_boundary_app_target(app, state);

  if (state_target) {
    return static_host_boundary_wrapper_target(
      state_target,
      ctx,
      hooks,
      state,
    );
  }

  const target = hooks.static_core_call_target(app.func, ctx);

  if (!target) {
    return false;
  }

  return static_host_boundary_wrapper_target(target, ctx, hooks, state);
}

function host_import_has_ownership_transfer(
  signature: CoreHostImport,
): boolean {
  for (const arg of signature.args) {
    if (arg.tag === "ownership_transfer") {
      return true;
    }
  }

  return false;
}

function scan_host_boundary_with_shadowed_aliases(
  params: CoreParam[],
  state: CoreHostBoundaryState,
  scan: () => void,
): void {
  const previous_aliases = state.aliases;
  state.aliases = new Map(previous_aliases);

  for (const param of params) {
    state.aliases.delete(param.name);
  }

  try {
    scan();
  } finally {
    state.aliases = previous_aliases;
  }
}

function host_boundary_arg_alias(
  arg: Extract<CoreExpr, { tag: "var" }>,
  state: CoreHostBoundaryState,
): CoreExpr | undefined {
  const seen = new Set<string>();
  let current = arg.name;
  let resolved = false;

  while (true) {
    if (seen.has(current)) {
      return undefined;
    }

    seen.add(current);
    const alias = state.aliases.get(current);

    if (!alias) {
      if (resolved) {
        return { tag: "var", name: current };
      }

      return undefined;
    }

    if (alias.tag !== "var") {
      return alias;
    }

    resolved = true;
    current = alias.name;
  }
}

function host_boundary_arg_decision(
  ownership: CoreOwnership,
  signature: CoreHostImport | undefined,
  index: number,
): CoreHostBoundaryDecision {
  if (signature) {
    const contract = signature.args[index];

    if (!contract) {
      return {
        tag: "rejected",
        reason: "missing host/import ownership contract for argument " +
          index.toString(),
      };
    }

    return core_host_import_arg_decision(contract, ownership);
  }

  if (ownership.tag === "scalar_local") {
    return {
      tag: "allowed",
      reason: "scalar host/import arguments do not carry ownership",
    };
  }

  if (ownership.tag === "frozen_shareable") {
    return {
      tag: "allowed",
      reason: "frozen/shareable host/import arguments can be read without " +
        "ownership transfer",
    };
  }

  return {
    tag: "rejected",
    reason: "unknown host/import boundary would let " +
      core_ownership_result_text(ownership) +
      " escape without a bounded-borrow or ownership-transfer signature",
  };
}

function host_boundary_decision(
  callee: string,
  args: CoreHostBoundaryArg[],
  signature: CoreHostImport | undefined,
): CoreHostBoundaryDecision {
  if (signature) {
    if (signature.params.length !== args.length) {
      return {
        tag: "rejected",
        reason: "host/import signature for " + callee + " expects " +
          signature.params.length.toString() + " arguments, got " +
          args.length.toString(),
      };
    }

    if (signature.args.length !== args.length) {
      return {
        tag: "rejected",
        reason: "host/import signature for " + callee + " declares " +
          signature.args.length.toString() + " ownership contracts, got " +
          args.length.toString() + " arguments",
      };
    }
  }

  for (const arg of args) {
    if (arg.decision.tag === "allowed") {
      continue;
    }

    return {
      tag: "rejected",
      reason: "argument " + arg.index.toString() + " to " + callee + ": " +
        arg.decision.reason,
    };
  }

  if (signature) {
    return {
      tag: "allowed",
      reason: "host/import signature for " + callee +
        " satisfies ownership boundary checks",
    };
  }

  return {
    tag: "rejected",
    reason: "missing host/import signature for " + callee,
  };
}
