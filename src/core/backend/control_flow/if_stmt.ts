import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type {
  CoreBackendControlFlow,
  CoreBackendControlFlowApi,
} from "./types.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import {
  type CoreIfStmtHooks,
  emit_core_if_else_stmt,
  emit_core_if_stmt,
} from "../../if_stmt.ts";
import type { TempCtx } from "../../local_collect.ts";
import {
  merge_if_else_static_assignments
    as merge_if_else_static_assignments_with_hooks,
  type StaticMergeHooks,
} from "../../static_merge.ts";

export type CoreBackendControlFlowIfStmt = Pick<
  CoreBackendControlFlow,
  "emit_if_else_stmt" | "emit_if_stmt" | "merge_if_else_static_assignments"
>;

export function create_core_backend_control_flow_if_stmt(
  api: CoreBackendControlFlowApi,
): CoreBackendControlFlowIfStmt {
  const static_merge_hooks = {
    plan_static_struct_value: api.plan_static_struct_value,
  } satisfies StaticMergeHooks<TempCtx, CoreEmitCtx>;

  const if_stmt_hooks = {
    emit_expr: api.emit_expr,
    emit_stmt: api.emit_stmt,
    expr_type: api.expr_type,
    merge_if_else_static_assignments,
    plan_static_capture_expr: api.plan_static_capture_expr,
  } satisfies CoreIfStmtHooks<CoreEmitCtx>;

  function merge_if_else_static_assignments(
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: TempCtx,
    emit_ctx: CoreEmitCtx | undefined,
  ): Wat {
    return merge_if_else_static_assignments_with_hooks(
      stmt,
      cond,
      then_statics,
      else_statics,
      ctx,
      emit_ctx,
      static_merge_hooks,
    );
  }

  function emit_if_stmt(
    stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_core_if_stmt(stmt, ctx, if_stmt_hooks);
  }

  function emit_if_else_stmt(
    stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_core_if_else_stmt(stmt, ctx, if_stmt_hooks);
  }

  return {
    emit_if_else_stmt,
    emit_if_stmt,
    merge_if_else_static_assignments,
  };
}
