import type {
  Core,
  CoreExpr,
  CoreHostImport,
  CoreParam,
  CoreStmt,
} from "./ast.ts";
import {
  core_host_import_for_app,
  core_host_import_map,
} from "./host_import.ts";
import {
  core_expr_ownership,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";

export type CoreTransferEdge = {
  id: string;
  scope: string;
  owner: string;
  callee: string;
  argument: number;
};

export type CoreTransferValidationIssue =
  | {
    tag: "use_after_transfer";
    owner: string;
    transfer: CoreTransferEdge;
    use: string;
    message: string;
  }
  | {
    tag: "invalid_static_transfer_argument";
    owner: string;
    callee: string;
    argument: number;
    ownership: CoreOwnership | undefined;
    reason: string;
    message: string;
  }
  | {
    tag: "conditional_transfer_requires_cleanup";
    owner: string;
    transfer: CoreTransferEdge;
    message: string;
  };

export type CoreTransferValidation = {
  transfers: CoreTransferEdge[];
  issues: CoreTransferValidationIssue[];
};

type CoreTransferState<ctx> = {
  next_transfer: number;
  next_temporary: number;
  transfers: CoreTransferEdge[];
  issues: CoreTransferValidationIssue[];
  transferred: Map<string, CoreTransferEdge>;
  functions: Map<string, CoreTransferFunction>;
  aliases: Map<string, string>;
  alias_ownership: Map<string, CoreOwnership | undefined>;
  alias_rejection_reasons: Map<string, string>;
  active_functions: Set<string>;
  ctx: ctx;
  hooks: CoreTransferHooks<ctx>;
};

type CoreTransferHooks<ctx> = CoreOwnershipHooks<ctx> & {
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
};

type CoreTransferFunction =
  | { tag: "lam"; value: Extract<CoreExpr, { tag: "lam" }> }
  | { tag: "rec"; value: Extract<CoreExpr, { tag: "rec" }> }
  | {
    tag: "branch";
    kind: "if" | "if_let";
    then_target: CoreTransferFunction;
    else_target: CoreTransferFunction;
  };

export function core_transfer_validation<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreTransferHooks<ctx>,
): CoreTransferValidation {
  const state: CoreTransferState<ctx> = {
    next_transfer: 0,
    next_temporary: 0,
    transfers: [],
    issues: [],
    transferred: new Map(),
    functions: top_level_transfer_functions(core),
    aliases: new Map(),
    alias_ownership: new Map(),
    alias_rejection_reasons: new Map(),
    active_functions: new Set(),
    ctx,
    hooks,
  };
  const host_imports = core_host_import_map(core);

  scan_transfer_stmts(core.statements, "program#0", host_imports, state);

  return {
    transfers: state.transfers,
    issues: state.issues,
  };
}

function scan_transfer_stmts<ctx>(
  statements: CoreStmt[],
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  const previous_functions = state.functions;
  state.functions = new Map(previous_functions);

  try {
    for (const stmt of statements) {
      scan_transfer_stmt(stmt, scope, host_imports, state);
    }
  } finally {
    state.functions = previous_functions;
  }
}

function scan_transfer_stmt<ctx>(
  stmt: CoreStmt,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  switch (stmt.tag) {
    case "bind":
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      state.transferred.delete(stmt.name);
      bind_transfer_owner_alias(stmt.name, stmt.value, state);
      bind_transfer_function(stmt.name, stmt.value, state);
      return;

    case "assign":
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      state.transferred.delete(stmt.name);
      bind_transfer_owner_alias(stmt.name, stmt.value, state);
      bind_transfer_function(stmt.name, stmt.value, state);
      return;

    case "index_assign":
      record_transfer_use(stmt.name, "index assignment target", state);
      scan_transfer_expr(stmt.index, scope, host_imports, state);
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      return;

    case "range_loop": {
      scan_transfer_expr(stmt.start, scope, host_imports, state);
      scan_transfer_expr(stmt.end, scope, host_imports, state);
      scan_transfer_expr(stmt.step, scope, host_imports, state);
      const body = clone_transfer_state(state);
      scan_transfer_stmts(
        stmt.body,
        child_scope(scope, "loop"),
        host_imports,
        body,
      );
      merge_conditional_transfer_states(state, [body], 2);
      return;
    }

    case "collection_loop": {
      scan_transfer_expr(stmt.collection, scope, host_imports, state);
      const body = clone_transfer_state(state);
      scan_transfer_stmts(
        stmt.body,
        child_scope(scope, "loop"),
        host_imports,
        body,
      );
      merge_conditional_transfer_states(state, [body], 2);
      return;
    }

    case "if_stmt": {
      scan_transfer_expr(stmt.cond, scope, host_imports, state);
      const branch = clone_transfer_state(state);
      scan_transfer_stmts(
        stmt.body,
        child_scope(scope, "if"),
        host_imports,
        branch,
      );
      merge_conditional_transfer_states(state, [branch], 2);
      return;
    }

    case "if_else_stmt": {
      scan_transfer_expr(stmt.cond, scope, host_imports, state);
      const then_branch = clone_transfer_state(state);
      scan_transfer_stmts(
        stmt.then_body,
        child_scope(scope, "if_then"),
        host_imports,
        then_branch,
      );
      const else_branch = clone_transfer_state(state);
      else_branch.next_transfer = then_branch.next_transfer;
      scan_transfer_stmts(
        stmt.else_body,
        child_scope(scope, "if_else"),
        host_imports,
        else_branch,
      );
      merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
      return;
    }

    case "if_let_stmt": {
      scan_transfer_expr(stmt.target, scope, host_imports, state);
      const branch_context = transfer_if_let_stmt_branch_ctx(stmt, state);

      if (branch_context.tag === "skip") {
        return;
      }

      const branch = clone_transfer_state(state);

      if (branch_context.tag === "scan") {
        branch.ctx = branch_context.ctx;
      }

      scan_transfer_stmts(
        stmt.body,
        child_scope(scope, "if_let"),
        host_imports,
        branch,
      );
      merge_conditional_transfer_states(state, [branch], 2);
      return;
    }

    case "type_check":
      scan_transfer_expr(stmt.target, scope, host_imports, state);
      return;

    case "return":
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      return;

    case "expr":
      scan_transfer_expr(stmt.expr, scope, host_imports, state);
      return;

    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function transfer_if_let_stmt_branch_ctx<ctx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  state: CoreTransferState<ctx>,
): { tag: "scan"; ctx: ctx } | { tag: "skip" } | { tag: "unknown" } {
  const hooks = state.hooks;

  if (
    hooks.static_union_case &&
    hooks.if_let_branch_ctx &&
    hooks.bind_core_if_let_payload_fact
  ) {
    const union_case = hooks.static_union_case(stmt.target, state.ctx);

    if (union_case) {
      if (union_case.name !== stmt.case_name) {
        return { tag: "skip" };
      }

      const branch_ctx = hooks.if_let_branch_ctx(state.ctx);
      hooks.bind_core_if_let_payload_fact(
        stmt.value_name,
        union_case,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  if (
    hooks.dynamic_union_if &&
    hooks.if_let_branch_ctx &&
    hooks.bind_dynamic_if_let_payload
  ) {
    const dynamic_target = hooks.dynamic_union_if(stmt.target, state.ctx);

    if (dynamic_target) {
      if (
        dynamic_target.then_case.name !== stmt.case_name &&
        dynamic_target.else_case.name !== stmt.case_name
      ) {
        return { tag: "skip" };
      }

      const branch_ctx = hooks.if_let_branch_ctx(state.ctx);
      hooks.bind_dynamic_if_let_payload(
        stmt.case_name,
        stmt.value_name,
        dynamic_target,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  if (
    hooks.runtime_union_target &&
    hooks.runtime_union_match_info &&
    hooks.static_runtime_union_match_branch_ctx
  ) {
    const runtime_target = hooks.runtime_union_target(
      stmt.target,
      state.ctx,
    );

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        stmt.case_name,
        runtime_target,
        state.ctx,
      );
      const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
        stmt.value_name,
        info,
        state.ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }
  }

  return { tag: "unknown" };
}

function scan_transfer_expr<ctx>(
  expr: CoreExpr,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var":
      record_transfer_use(expr.name, "value use", state);
      return;

    case "prim":
      scan_transfer_exprs(expr.args, scope, host_imports, state);
      return;

    case "lam":
    case "rec": {
      const body = clone_transfer_state(state);
      const previous_ctx = body.ctx;

      if (body.hooks.closure_body_ctx) {
        const scoped_ctx = body.hooks.closure_body_ctx(expr, body.ctx);

        if (scoped_ctx) {
          body.ctx = scoped_ctx;
        }
      }

      try {
        scan_transfer_expr(
          expr.body,
          child_scope(scope, "closure"),
          host_imports,
          body,
        );
      } finally {
        body.ctx = previous_ctx;
      }
      merge_transfer_issues(state, body);
      return;
    }

    case "app":
      scan_transfer_app(expr, scope, host_imports, state);
      return;

    case "block": {
      const block = clone_transfer_state(state);
      scan_transfer_stmts(
        expr.statements,
        child_scope(scope, "block"),
        host_imports,
        block,
      );
      merge_transfer_state(state, block);
      return;
    }

    case "comptime":
      scan_transfer_expr(expr.expr, scope, host_imports, state);
      return;

    case "borrow":
    case "freeze":
      scan_transfer_expr(expr.value, scope, host_imports, state);
      return;

    case "scratch":
      scan_transfer_expr(expr.body, scope, host_imports, state);
      return;

    case "with":
      scan_transfer_expr(expr.base, scope, host_imports, state);
      scan_transfer_fields(expr.fields, scope, host_imports, state);
      return;

    case "struct_value":
      scan_transfer_expr(expr.type_expr, scope, host_imports, state);
      scan_transfer_fields(expr.fields, scope, host_imports, state);
      return;

    case "struct_update":
      scan_transfer_expr(expr.base, scope, host_imports, state);
      scan_transfer_fields(expr.fields, scope, host_imports, state);
      return;

    case "if":
      scan_transfer_expr(expr.cond, scope, host_imports, state);
      scan_transfer_if_expr(expr, scope, host_imports, state);
      return;

    case "if_let":
      scan_transfer_expr(expr.target, scope, host_imports, state);
      scan_transfer_if_let_expr(expr, scope, host_imports, state);
      return;

    case "field":
      scan_transfer_expr(expr.object, scope, host_imports, state);
      return;

    case "index":
      scan_transfer_expr(expr.object, scope, host_imports, state);
      scan_transfer_expr(expr.index, scope, host_imports, state);
      return;

    case "union_case":
      if (expr.value) {
        scan_transfer_expr(expr.value, scope, host_imports, state);
      }
      if (expr.type_expr) {
        scan_transfer_expr(expr.type_expr, scope, host_imports, state);
      }
      record_union_payload_transfer(expr, scope, state);
      return;
  }
}

function scan_transfer_app<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  scan_transfer_expr(expr.func, scope, host_imports, state);
  scan_transfer_exprs(expr.args, scope, host_imports, state);

  const host_import = core_host_import_for_app(expr, { host_imports });

  if (host_import) {
    for (let index = 0; index < expr.args.length; index += 1) {
      const contract = host_import.args[index];

      if (!contract) {
        continue;
      }

      if (contract.tag !== "ownership_transfer") {
        continue;
      }

      const arg = expr.args[index];
      if (!arg) {
        throw new Error("Missing host transfer argument " + index.toString());
      }

      if (arg.tag !== "var") {
        continue;
      }

      record_transfer(arg.name, scope, host_import.name, index, state);
    }
  }

  scan_static_transfer_call(expr, scope, host_imports, state);
  record_union_payload_transfer(expr, scope, state);
}

function scan_static_transfer_call<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  if (expr.func.tag !== "var") {
    return;
  }

  const name = expr.func.name;
  const target = state.functions.get(name);

  if (!target) {
    return;
  }

  if (state.active_functions.has(name)) {
    return;
  }

  const aliases = static_transfer_call_aliases(target, expr.args, state);

  if (!aliases) {
    return;
  }

  const function_aliases = static_transfer_call_function_aliases(
    target,
    expr.args,
    state,
  );
  const previous_aliases = state.aliases;
  const previous_alias_ownership = state.alias_ownership;
  const previous_alias_rejection_reasons = state.alias_rejection_reasons;
  const previous_functions = state.functions;
  state.aliases = new Map(previous_aliases);
  state.alias_ownership = new Map(previous_alias_ownership);
  state.alias_rejection_reasons = new Map(previous_alias_rejection_reasons);
  state.functions = new Map(previous_functions);

  for (const entry of aliases.entries()) {
    state.aliases.set(entry[0], entry[1]);
  }

  for (const entry of function_aliases.entries()) {
    state.functions.set(entry[0], entry[1]);
  }

  state.active_functions.add(name);

  try {
    scan_static_transfer_target(
      target,
      child_scope(scope, "static_call/" + name),
      host_imports,
      state,
    );
  } finally {
    state.active_functions.delete(name);
    state.aliases = previous_aliases;
    state.alias_ownership = previous_alias_ownership;
    state.alias_rejection_reasons = previous_alias_rejection_reasons;
    state.functions = previous_functions;
  }
}

function static_transfer_call_aliases<ctx>(
  target: CoreTransferFunction,
  args: CoreExpr[],
  state: CoreTransferState<ctx>,
): Map<string, string> | undefined {
  const params = static_transfer_function_params(target);

  if (!params) {
    return undefined;
  }

  if (params.length !== args.length) {
    return undefined;
  }

  const aliases = new Map<string, string>();

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static transfer call parameter");
    }

    if (!arg) {
      throw new Error("Missing static transfer call argument");
    }

    if (arg.tag !== "var") {
      const temporary = "temporary#" + state.next_temporary.toString();
      state.next_temporary += 1;
      aliases.set(param.name, temporary);
      bind_transfer_alias_ownership(param.name, temporary, arg, state);
      continue;
    }

    const owner = resolve_transfer_owner(arg.name, state);
    aliases.set(param.name, owner);
    bind_transfer_alias_ownership(param.name, owner, arg, state);
  }

  return aliases;
}

function static_transfer_call_function_aliases<ctx>(
  target: CoreTransferFunction,
  args: CoreExpr[],
  state: CoreTransferState<ctx>,
): Map<string, CoreTransferFunction> {
  const params = static_transfer_function_params(target);
  const aliases = new Map<string, CoreTransferFunction>();

  if (!params) {
    return aliases;
  }

  if (params.length !== args.length) {
    return aliases;
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static transfer call parameter");
    }

    if (!arg) {
      throw new Error("Missing static transfer call argument");
    }

    if (!param.is_const) {
      continue;
    }

    if (arg.tag !== "var") {
      continue;
    }

    const target_fn = state.functions.get(arg.name);

    if (!target_fn) {
      continue;
    }

    aliases.set(param.name, target_fn);
  }

  return aliases;
}

function bind_transfer_alias_ownership<ctx>(
  param: string,
  owner: string,
  arg: CoreExpr,
  state: CoreTransferState<ctx>,
): void {
  if (arg.tag === "var") {
    const existing = state.alias_ownership.get(arg.name);

    if (existing) {
      state.alias_ownership.set(param, existing);
      state.alias_ownership.set(owner, existing);
      state.alias_rejection_reasons.delete(param);
      state.alias_rejection_reasons.delete(owner);
      return;
    }

    const rejection = state.alias_rejection_reasons.get(arg.name);

    if (rejection) {
      state.alias_ownership.set(param, undefined);
      state.alias_ownership.set(owner, undefined);
      state.alias_rejection_reasons.set(param, rejection);
      state.alias_rejection_reasons.set(owner, rejection);
      return;
    }
  }

  try {
    const ownership = core_expr_ownership(arg, state.ctx, state.hooks);
    state.alias_ownership.set(param, ownership);
    state.alias_ownership.set(owner, ownership);
    state.alias_rejection_reasons.delete(param);
    state.alias_rejection_reasons.delete(owner);
  } catch (error) {
    let reason = "cannot prove argument ownership";

    if (error instanceof Error) {
      reason = error.message;
    }

    state.alias_ownership.set(param, undefined);
    state.alias_ownership.set(owner, undefined);
    state.alias_rejection_reasons.set(param, reason);
    state.alias_rejection_reasons.set(owner, reason);
  }
}

function scan_static_transfer_target<ctx>(
  target: CoreTransferFunction,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  if (target.tag === "lam" || target.tag === "rec") {
    const previous_ctx = state.ctx;

    if (state.hooks.closure_body_ctx) {
      const scoped_ctx = state.hooks.closure_body_ctx(target.value, state.ctx);

      if (scoped_ctx) {
        state.ctx = scoped_ctx;
      }
    }

    try {
      scan_transfer_expr(
        target.value.body,
        scope,
        host_imports,
        state,
      );
    } finally {
      state.ctx = previous_ctx;
    }
    return;
  }

  const then_branch = clone_transfer_state(state);
  scan_static_transfer_target(
    target.then_target,
    child_scope(scope, target.kind + "_then"),
    host_imports,
    then_branch,
  );

  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_static_transfer_target(
    target.else_target,
    child_scope(scope, target.kind + "_else"),
    host_imports,
    else_branch,
  );

  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

function static_transfer_function_params(
  target: CoreTransferFunction,
): CoreParam[] | undefined {
  if (target.tag === "lam" || target.tag === "rec") {
    return target.value.params;
  }

  const then_params = static_transfer_function_params(target.then_target);
  const else_params = static_transfer_function_params(target.else_target);

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

function scan_transfer_if_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  const then_branch = clone_transfer_state(state);
  scan_transfer_expr(
    expr.then_branch,
    child_scope(scope, "if_then"),
    host_imports,
    then_branch,
  );
  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_transfer_expr(
    expr.else_branch,
    child_scope(scope, "if_else"),
    host_imports,
    else_branch,
  );
  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

function scan_transfer_if_let_expr<ctx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  const then_branch = clone_transfer_state(state);
  scan_transfer_expr(
    expr.then_branch,
    child_scope(scope, "if_let_then"),
    host_imports,
    then_branch,
  );
  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_transfer_expr(
    expr.else_branch,
    child_scope(scope, "if_let_else"),
    host_imports,
    else_branch,
  );
  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}

function scan_transfer_exprs<ctx>(
  exprs: CoreExpr[],
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  for (const expr of exprs) {
    scan_transfer_expr(expr, scope, host_imports, state);
  }
}

function scan_transfer_fields<ctx>(
  fields: { value: CoreExpr }[],
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
): void {
  for (const field of fields) {
    scan_transfer_expr(field.value, scope, host_imports, state);
  }
}

function record_transfer<ctx>(
  owner: string,
  scope: string,
  callee: string,
  argument: number,
  state: CoreTransferState<ctx>,
): void {
  const resolved_owner = resolve_transfer_owner(owner, state);
  record_transfer_use(resolved_owner, "ownership-transfer argument", state);

  if (
    !static_transfer_argument_is_unique(
      resolved_owner,
      callee,
      argument,
      state,
    )
  ) {
    return;
  }

  const edge: CoreTransferEdge = {
    id: "transfer#" + state.next_transfer.toString(),
    scope,
    owner: resolved_owner,
    callee,
    argument,
  };
  state.next_transfer += 1;
  state.transfers.push(edge);
  state.transferred.set(resolved_owner, edge);
}

function record_union_payload_transfer<ctx>(
  expr: CoreExpr,
  scope: string,
  state: CoreTransferState<ctx>,
): void {
  if (!direct_union_payload_may_be_owner_transfer(expr)) {
    return;
  }

  const runtime_value = state.hooks.runtime_union_value(expr, state.ctx);
  if (!runtime_value) {
    return;
  }

  if (runtime_value.tag !== "union_case") {
    return;
  }

  if (!runtime_value.value) {
    return;
  }

  if (runtime_value.value.tag !== "var") {
    return;
  }

  if (!union_payload_transfers_owner(expr, state)) {
    return;
  }

  record_transfer(
    runtime_value.value.name,
    scope,
    "union_case." + runtime_value.name,
    0,
    state,
  );
}

function direct_union_payload_may_be_owner_transfer(expr: CoreExpr): boolean {
  if (expr.tag === "union_case") {
    if (!expr.value) {
      return false;
    }

    return expr.value.tag === "var";
  }

  if (expr.tag === "app" && expr.func.tag === "field") {
    const payload = expr.args[0];

    if (!payload) {
      return false;
    }

    return payload.tag === "var";
  }

  return true;
}

function union_payload_transfers_owner<ctx>(
  expr: CoreExpr,
  state: CoreTransferState<ctx>,
): boolean {
  let union_ownership: CoreOwnership;

  try {
    union_ownership = core_expr_ownership(expr, state.ctx, state.hooks);
  } catch {
    return false;
  }

  if (union_ownership.tag !== "unique_heap") {
    return false;
  }

  if (union_ownership.reason !== "runtime_union") {
    return false;
  }

  const runtime_value = state.hooks.runtime_union_value(expr, state.ctx);
  if (!runtime_value) {
    return false;
  }

  if (runtime_value.tag !== "union_case") {
    return false;
  }

  if (!runtime_value.value) {
    return false;
  }

  let payload_ownership: CoreOwnership;

  try {
    payload_ownership = core_expr_ownership(
      runtime_value.value,
      state.ctx,
      state.hooks,
    );
  } catch {
    return false;
  }

  if (payload_ownership.tag !== "unique_heap") {
    return false;
  }

  return payload_ownership.reason === "runtime_aggregate" ||
    payload_ownership.reason === "runtime_union";
}

function static_transfer_argument_is_unique<ctx>(
  owner: string,
  callee: string,
  argument: number,
  state: CoreTransferState<ctx>,
): boolean {
  const reason = state.alias_rejection_reasons.get(owner);

  if (reason) {
    record_invalid_static_transfer_argument(
      owner,
      callee,
      argument,
      undefined,
      reason,
      state,
    );
    return false;
  }

  const ownership = state.alias_ownership.get(owner);

  if (!ownership) {
    return true;
  }

  if (ownership.tag === "unique_heap") {
    return true;
  }

  record_invalid_static_transfer_argument(
    owner,
    callee,
    argument,
    ownership,
    "ownership-transfer wrapper argument " + owner +
      " must be unique_heap, got " + transfer_ownership_text(ownership),
    state,
  );
  return false;
}

function bind_transfer_owner_alias<ctx>(
  name: string,
  value: CoreExpr,
  state: CoreTransferState<ctx>,
): void {
  state.aliases.delete(name);
  state.alias_ownership.delete(name);
  state.alias_rejection_reasons.delete(name);

  if (value.tag !== "var") {
    return;
  }

  const owner = resolve_transfer_owner(value.name, state);
  if (owner === name) {
    return;
  }

  let ownership: CoreOwnership;

  try {
    ownership = core_expr_ownership(value, state.ctx, state.hooks);
  } catch {
    return;
  }

  if (ownership.tag !== "unique_heap") {
    return;
  }

  state.aliases.set(name, owner);
  state.alias_ownership.set(name, ownership);
}

function record_invalid_static_transfer_argument<ctx>(
  owner: string,
  callee: string,
  argument: number,
  ownership: CoreOwnership | undefined,
  reason: string,
  state: CoreTransferState<ctx>,
): void {
  state.issues.push({
    tag: "invalid_static_transfer_argument",
    owner,
    callee,
    argument,
    ownership,
    reason,
    message: "Rejected ownership-transfer wrapper argument " + owner +
      " for " + callee + " argument " + argument.toString() + ": " +
      reason,
  });
}

function record_conditional_transfer_requires_cleanup<ctx>(
  owner: string,
  transfer: CoreTransferEdge,
  state: CoreTransferState<ctx>,
): void {
  const message = "Conditional transfer of owner " + owner + " through " +
    transfer.id + " to " + transfer.callee +
    " requires conditional cleanup/drop facts";

  for (const issue of state.issues) {
    if (issue.message === message) {
      return;
    }
  }

  state.issues.push({
    tag: "conditional_transfer_requires_cleanup",
    owner,
    transfer,
    message,
  });
}

function transfer_ownership_text(ownership: CoreOwnership): string {
  switch (ownership.tag) {
    case "scalar_local":
      return "scalar_local " + ownership.type;

    case "unique_heap":
      return "unique_heap " + ownership.reason;

    case "frozen_shareable":
      return "frozen_shareable " + ownership.reason;

    case "borrow_view":
      return "borrow_view over " + transfer_ownership_text(ownership.source);

    case "scratch_backed":
      return "scratch_backed over " +
        transfer_ownership_text(ownership.source);
  }
}

function record_transfer_use<ctx>(
  owner: string,
  use: string,
  state: CoreTransferState<ctx>,
): void {
  const resolved_owner = resolve_transfer_owner(owner, state);
  const transfer = state.transferred.get(resolved_owner);

  if (!transfer) {
    return;
  }

  state.issues.push({
    tag: "use_after_transfer",
    owner: resolved_owner,
    transfer,
    use,
    message: "Use of transferred owner " + resolved_owner + " after " +
      transfer_edge_text(transfer) + " " + transfer.id + " to " +
      transfer.callee,
  });
}

function transfer_edge_text(edge: CoreTransferEdge): string {
  if (edge.callee.startsWith("union_case.")) {
    return "ownership transfer";
  }

  return "host/import transfer";
}

function clone_transfer_state<ctx>(
  state: CoreTransferState<ctx>,
): CoreTransferState<ctx> {
  return {
    next_transfer: state.next_transfer,
    next_temporary: state.next_temporary,
    transfers: state.transfers.slice(),
    issues: state.issues.slice(),
    transferred: new Map(state.transferred),
    functions: state.functions,
    aliases: new Map(state.aliases),
    alias_ownership: new Map(state.alias_ownership),
    alias_rejection_reasons: new Map(state.alias_rejection_reasons),
    active_functions: new Set(state.active_functions),
    ctx: state.ctx,
    hooks: state.hooks,
  };
}

function merge_transfer_state<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  merge_transfer_edges(target, source);
  merge_transfer_issues(target, source);
  target.next_transfer = source.next_transfer;
  target.next_temporary = source.next_temporary;

  for (const entry of source.transferred.entries()) {
    target.transferred.set(entry[0], entry[1]);
  }

  for (const entry of source.alias_ownership.entries()) {
    target.alias_ownership.set(entry[0], entry[1]);
  }

  for (const entry of source.alias_rejection_reasons.entries()) {
    target.alias_rejection_reasons.set(entry[0], entry[1]);
  }
}

function merge_conditional_transfer_states<ctx>(
  target: CoreTransferState<ctx>,
  sources: CoreTransferState<ctx>[],
  path_count: number,
): void {
  const base_transferred = new Map(target.transferred);

  record_conditional_transfer_issues(
    target,
    sources,
    path_count,
    base_transferred,
  );

  for (const source of sources) {
    merge_transfer_state(target, source);
  }
}

function record_conditional_transfer_issues<ctx>(
  target: CoreTransferState<ctx>,
  sources: CoreTransferState<ctx>[],
  path_count: number,
  base_transferred: Map<string, CoreTransferEdge>,
): void {
  const counts = new Map<string, {
    count: number;
    transfer: CoreTransferEdge;
  }>();

  for (const source of sources) {
    const seen = new Set<string>();

    for (const entry of source.transferred.entries()) {
      const owner = entry[0];
      const transfer = entry[1];

      if (seen.has(owner)) {
        continue;
      }

      if (owner.startsWith("temporary#")) {
        continue;
      }

      const base = base_transferred.get(owner);

      if (base && base.id === transfer.id) {
        continue;
      }

      seen.add(owner);
      const previous = counts.get(owner);

      if (previous) {
        previous.count += 1;
        continue;
      }

      counts.set(owner, {
        count: 1,
        transfer,
      });
    }
  }

  for (const entry of counts.entries()) {
    const owner = entry[0];
    const info = entry[1];

    if (info.count >= path_count) {
      continue;
    }

    record_conditional_transfer_requires_cleanup(
      owner,
      info.transfer,
      target,
    );
  }
}

function merge_transfer_issues<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  const seen = new Set<string>();

  for (const issue of target.issues) {
    seen.add(issue.message);
  }

  for (const issue of source.issues) {
    if (seen.has(issue.message)) {
      continue;
    }

    target.issues.push(issue);
    seen.add(issue.message);
  }
}

function merge_transfer_edges<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  const seen = new Set<string>();

  for (const edge of target.transfers) {
    seen.add(edge.id);
  }

  for (const edge of source.transfers) {
    if (seen.has(edge.id)) {
      continue;
    }

    target.transfers.push(edge);
    seen.add(edge.id);
  }
}

function child_scope(scope: string, kind: string): string {
  return scope + "/" + kind;
}

function top_level_transfer_functions(
  core: Core,
): Map<string, CoreTransferFunction> {
  const functions = new Map<string, CoreTransferFunction>();

  for (const stmt of core.statements) {
    if (stmt.tag !== "bind") {
      continue;
    }

    const fn = static_transfer_function(stmt.value);

    if (!fn) {
      continue;
    }

    functions.set(stmt.name, fn);
  }

  return functions;
}

function bind_transfer_function<ctx>(
  name: string,
  value: CoreExpr,
  state: CoreTransferState<ctx>,
): void {
  const fn = static_transfer_function_value(value, state);

  if (fn) {
    state.functions.set(name, fn);
    return;
  }

  state.functions.delete(name);
}

function static_transfer_function_value<ctx>(
  expr: CoreExpr,
  state: CoreTransferState<ctx>,
): CoreTransferFunction | undefined {
  const direct = static_transfer_function(expr);

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
      return static_transfer_function_value(final_stmt.expr, state);
    }

    if (final_stmt.tag === "return") {
      return static_transfer_function_value(final_stmt.value, state);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_transfer_function_value(expr.then_branch, state);
    const else_target = static_transfer_function_value(expr.else_branch, state);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
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
    const then_target = static_transfer_function_value(expr.then_branch, state);
    const else_target = static_transfer_function_value(expr.else_branch, state);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
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

function static_transfer_function(
  expr: CoreExpr,
): CoreTransferFunction | undefined {
  if (expr.tag === "lam") {
    return { tag: "lam", value: expr };
  }

  if (expr.tag === "rec") {
    return { tag: "rec", value: expr };
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return static_transfer_function(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return static_transfer_function(final_stmt.value);
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_target = static_transfer_function(expr.then_branch);
    const else_target = static_transfer_function(expr.else_branch);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
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
    const then_target = static_transfer_function(expr.then_branch);
    const else_target = static_transfer_function(expr.else_branch);

    if (!then_target) {
      return undefined;
    }

    if (!else_target) {
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

function resolve_transfer_owner<ctx>(
  owner: string,
  state: CoreTransferState<ctx>,
): string {
  const seen = new Set<string>();
  let current = owner;

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const next = state.aliases.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}
