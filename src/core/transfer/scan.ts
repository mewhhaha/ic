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
import { bind_transfer_owner_alias } from "./ownership.ts";
import { record_transfer, record_transfer_use } from "./record.ts";
import {
  child_scope,
  clone_transfer_state,
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

// Ownership probes such as union-payload discovery consult local type
// facts, so annotated binds contribute their facts to a scan-local child
// ctx for the statements after them. Unannotated binds are skipped to
// keep the scan from re-collecting large inlined block values.
function observe_transfer_stmt_facts<ctx>(
  stmt: CoreStmt,
  state: CoreTransferState<ctx>,
): void {
  const hooks = state.hooks;

  if (!hooks.collect_stmt_locals || !hooks.block_ctx) {
    return;
  }

  if (stmt.tag !== "bind" || !stmt.annotation) {
    return;
  }

  const scan_ctx = hooks.block_ctx(state.ctx);

  try {
    hooks.collect_stmt_locals(stmt, scan_ctx);
    state.ctx = scan_ctx;
  } catch (_error) {
    // A statement whose facts cannot be collected leaves them unknown
    // for later probes; the statement itself is still validated by the
    // ordinary analysis passes.
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
