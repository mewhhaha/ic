import type { Wat } from "../../../../wat.ts";
import type { CoreExpr, CoreStmt } from "../../../ast.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { CoreCtx } from "../../../local_collect.ts";
import type { RuntimeUnionTarget } from "../../../runtime_union.ts";
import {
  collect_runtime_union_value_locals
    as collect_runtime_union_value_locals_with_hooks,
  emit_runtime_union_if_let_expr as emit_runtime_union_if_let_expr_with_hooks,
  emit_runtime_union_if_let_stmt as emit_runtime_union_if_let_stmt_with_hooks,
  emit_runtime_union_value as emit_runtime_union_value_with_hooks,
  type RuntimeUnionEmitHooks,
  type RuntimeUnionIfLetHooks,
  type RuntimeUnionLocalHooks,
} from "../../../runtime_union_emit.ts";
import type { CoreBackendUnionApi } from "../types.ts";
import type {
  CoreBackendUnionRuntimeEmit,
  CoreBackendUnionRuntimeInfo,
} from "./types.ts";

export function create_core_backend_union_runtime_emit(
  api: CoreBackendUnionApi,
  runtime_info: CoreBackendUnionRuntimeInfo,
): CoreBackendUnionRuntimeEmit {
  const runtime_union_local_hooks = {
    collect_expr_locals: api.collect_expr_locals,
    core_runtime_union_value: runtime_info.core_runtime_union_value,
    runtime_union_case_info: runtime_info.runtime_union_case_info,
    static_struct_value: api.static_struct_value,
  } satisfies RuntimeUnionLocalHooks<CoreCtx>;

  const runtime_union_emit_hooks = {
    core_runtime_union_value: runtime_info.core_runtime_union_value,
    emit_expr: api.emit_expr,
    expr_type: api.expr_type,
    runtime_union_case_info: runtime_info.runtime_union_case_info,
    static_struct_value: api.static_struct_value,
  } satisfies RuntimeUnionEmitHooks<CoreEmitCtx>;

  const runtime_union_if_let_hooks = {
    core_expr_is_text: api.core_expr_is_text,
    emit_expr: api.emit_expr,
    emit_stmt: api.emit_stmt,
    expr_type: api.expr_type,
    match_branch_ctx: api.match_branch_ctx,
    merge_if_else_static_assignments: api.merge_if_else_static_assignments,
    runtime_union_match_info: runtime_info.runtime_union_match_info,
  } satisfies RuntimeUnionIfLetHooks<CoreEmitCtx>;

  function collect_runtime_union_value_locals(
    expr: CoreExpr,
    ctx: CoreCtx,
  ): boolean {
    return collect_runtime_union_value_locals_with_hooks(
      expr,
      ctx,
      runtime_union_local_hooks,
    );
  }

  function emit_runtime_union_value(
    expr: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_union_value_with_hooks(
      expr,
      ctx,
      runtime_union_emit_hooks,
    );
  }

  function emit_runtime_union_if_let_stmt(
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_union_if_let_stmt_with_hooks(
      stmt,
      target,
      ctx,
      runtime_union_if_let_hooks,
    );
  }

  function emit_runtime_union_if_let_expr(
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_union_if_let_expr_with_hooks(
      expr,
      target,
      ctx,
      runtime_union_if_let_hooks,
    );
  }

  return {
    collect_runtime_union_value_locals,
    emit_runtime_union_if_let_expr,
    emit_runtime_union_if_let_stmt,
    emit_runtime_union_value,
  };
}
