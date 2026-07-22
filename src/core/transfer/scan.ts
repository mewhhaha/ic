import type { CoreExpr, CoreHostImport, CoreStmt } from "../ast.ts";
import {
  scan_transfer_collection_loop_stmt,
  scan_transfer_if_else_stmt,
  scan_transfer_if_expr,
  scan_transfer_if_let_expr,
  scan_transfer_if_let_stmt,
  scan_transfer_if_stmt,
  scan_transfer_range_loop_stmt,
} from "./branch.ts";
import { scan_host_transfer_call } from "./host_call.ts";
import {
  bind_transfer_alias_ownership,
  bind_transfer_owner_alias,
  resolve_transfer_owner,
} from "./ownership.ts";
import { core_expr_ownership } from "../ownership.ts";
import { record_transfer, record_transfer_use } from "./record.ts";
import {
  child_scope,
  clone_transfer_state,
  merge_conditional_transfer_states,
  merge_transfer_issues,
  merge_transfer_state,
} from "./state.ts";
import { scan_static_transfer_call } from "./static_call.ts";
import { bind_transfer_function } from "./static_function.ts";
import { record_union_payload_transfer } from "./union_payload.ts";
import type { CoreTransferState } from "./types.ts";

export function scan_transfer_stmts<ctx>(
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
      observe_transfer_stmt_facts(stmt, state);
    }
  } finally {
    state.functions = previous_functions;
  }
}

// Ownership probes such as union-payload discovery consult local type facts.
// Keep annotations, inferred text, and destructured projections in a
// scan-local context so later transfer edges can prove the value they consume.
function observe_transfer_stmt_facts<ctx>(
  stmt: CoreStmt,
  state: CoreTransferState<ctx>,
): void {
  if (!state.collect_local_facts) {
    return;
  }

  const hooks = state.hooks;

  if (!hooks.collect_stmt_locals || !hooks.block_ctx) {
    return;
  }

  if (stmt.tag !== "bind") {
    return;
  }

  if (
    stmt.annotation !== undefined && hooks.bind_annotation_fact !== undefined
  ) {
    const scan_ctx = hooks.block_ctx(state.ctx);
    hooks.bind_annotation_fact(stmt.name, stmt.annotation, scan_ctx);
    state.ctx = scan_ctx;
    return;
  }

  let destructured_projection = false;
  let struct_alias = false;
  const inferred_text = hooks.core_expr_is_text(stmt.value, state.ctx);

  if (
    stmt.value.tag === "index" && hooks.runtime_aggregate_type_expr
  ) {
    destructured_projection = hooks.runtime_aggregate_type_expr(
      stmt.value.object,
      state.ctx,
    ) !== undefined;
  }

  if (
    (stmt.value.tag === "var" || stmt.value.tag === "linear") &&
    hooks.runtime_aggregate_type_expr
  ) {
    struct_alias = hooks.runtime_aggregate_type_expr(
      stmt.value,
      state.ctx,
    ) !== undefined;
  }

  if (
    !destructured_projection &&
    !struct_alias &&
    !inferred_text &&
    stmt.value.tag !== "app" &&
    stmt.value.tag !== "struct_update" &&
    (stmt.value.tag !== "struct_value" ||
      stmt.value.type_expr.tag !== "app")
  ) {
    return;
  }

  const scan_ctx = hooks.block_ctx(state.ctx);
  hooks.collect_stmt_locals(stmt, scan_ctx);
  state.ctx = scan_ctx;
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
      state.declared_owners.add(stmt.name);
      bind_transfer_owner_alias(stmt.name, stmt.value, state);
      bind_transfer_function(stmt.name, stmt.value, state);
      return;

    case "assign": {
      const replaced_owner = resolve_transfer_owner(stmt.name, state);
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      state.transferred.delete(stmt.name);
      state.transferred.delete(replaced_owner);
      bind_transfer_owner_alias(stmt.name, stmt.value, state);
      bind_transfer_function(stmt.name, stmt.value, state);
      return;
    }

    case "index_assign":
      record_transfer_use(stmt.name, "index assignment target", state);
      scan_transfer_expr(stmt.index, scope, host_imports, state);
      scan_transfer_expr(stmt.value, scope, host_imports, state);
      return;

    case "range_loop": {
      scan_transfer_range_loop_stmt(
        stmt,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
        scan_transfer_stmts,
      );
      return;
    }

    case "collection_loop": {
      scan_transfer_collection_loop_stmt(
        stmt,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
        scan_transfer_stmts,
      );
      return;
    }

    case "if_stmt": {
      scan_transfer_if_stmt(
        stmt,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
        scan_transfer_stmts,
      );
      return;
    }

    case "if_else_stmt": {
      scan_transfer_if_else_stmt(
        stmt,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
        scan_transfer_stmts,
      );
      return;
    }

    case "if_let_stmt": {
      scan_transfer_if_let_stmt(
        stmt,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
        scan_transfer_stmts,
      );
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
      if (stmt.value) {
        scan_transfer_expr(stmt.value, scope, host_imports, state);
      }
      return;
    case "continue":
    case "unsupported":
      return;
  }
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
    case "rec_ref":
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

      for (const param of expr.params) {
        body.declared_owners.add(param.name);
      }

      if (body.hooks.closure_body_ctx) {
        const scoped_ctx = body.hooks.closure_body_ctx(expr, body.ctx);

        if (scoped_ctx) {
          body.ctx = scoped_ctx;
        } else {
          body.collect_local_facts = false;
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

    case "loop": {
      const body = clone_transfer_state(state);
      scan_transfer_stmts(
        expr.body,
        child_scope(scope, "loop"),
        host_imports,
        body,
      );
      merge_conditional_transfer_states(state, [body], 2);
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
      scan_transfer_if_expr(
        expr,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
      );
      return;

    case "if_let":
      scan_transfer_expr(expr.target, scope, host_imports, state);
      scan_transfer_if_let_expr(
        expr,
        scope,
        host_imports,
        state,
        scan_transfer_expr,
      );
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
      record_union_payload_transfer(expr, scope, state, record_transfer);
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
  scan_host_transfer_call(expr, scope, host_imports, state, record_transfer);

  scan_static_transfer_call(
    expr,
    scope,
    host_imports,
    state,
    scan_transfer_expr,
  );
  if (expr.func.tag === "rec_ref") {
    if (expr.func.params.length !== expr.args.length) {
      throw new Error(
        "Named function " + expr.func.name + " expects " +
          expr.func.params.length.toString() + " arguments, got " +
          expr.args.length.toString(),
      );
    }

    for (let index = 0; index < expr.func.params.length; index += 1) {
      const param = expr.func.params[index];
      const arg = expr.args[index];
      if (!param || !arg) {
        throw new Error("Missing named function transfer argument");
      }
      if (
        param.is_const || param.annotation?.startsWith("&") ||
        param.annotation?.startsWith("^") || arg.tag === "borrow" ||
        arg.tag === "freeze"
      ) {
        continue;
      }
      if (
        param.annotation === "Bool" || param.annotation === "Char" ||
        param.annotation === "Int" || param.annotation === "I32" ||
        param.annotation === "U32" || param.annotation === "I64" ||
        param.annotation === "F32" || param.annotation === "F64" ||
        param.annotation === "F32x4" || param.annotation === "Unit" ||
        param.annotation === "Type" || param.annotation === "Resume"
      ) {
        continue;
      }

      let ownership;
      if (
        (arg.tag === "var" || arg.tag === "linear") &&
        state.alias_ownership.has(arg.name)
      ) {
        ownership = state.alias_ownership.get(arg.name);
      } else {
        ownership = core_expr_ownership(arg, state.ctx, state.hooks);
      }
      if (!ownership || ownership.tag !== "unique_heap") {
        continue;
      }

      if (arg.tag === "var" || arg.tag === "linear") {
        record_transfer(
          arg.name,
          scope,
          expr.func.name,
          index,
          arg,
          state,
        );
        continue;
      }

      const temporary = "temporary#" + state.next_temporary.toString();
      state.next_temporary += 1;
      bind_transfer_alias_ownership(temporary, temporary, arg, state);
      record_transfer(
        temporary,
        scope,
        expr.func.name,
        index,
        arg,
        state,
      );
    }
  }
  record_union_payload_transfer(expr, scope, state, record_transfer);
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
