import type { CoreExpr } from "../../../ast.ts";
import type { CoreEmitCtx as EmitCtx } from "../../../emit_ctx.ts";
import {
  type CoreCtx,
  create_core_block_ctx,
  type StaticCtx,
  type TempCtx,
} from "../../../local_collect.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";
import type { CoreBackendText } from "../../text/types.ts";
import type { CoreBackendStaticCall } from "../../values/static_call/types.ts";
import { create_core_backend_static_value } from "../../values/static_value.ts";
import type { CoreBackendStaticValue } from "../../values/static_value/types.ts";
import type { CoreBackendStruct } from "../../values/struct/types.ts";
import { runtime_aggregate_type_expr } from "../../../runtime_aggregate.ts";

export function create_core_backend_values_static_value(
  deps: CoreBackendGraphDeps,
  static_call: CoreBackendStaticCall,
  struct: CoreBackendStruct,
  get_text: () => CoreBackendText,
): CoreBackendStaticValue {
  return create_core_backend_static_value({
    block_ctx: create_core_block_ctx,
    closure_fn_type: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.closure().closure_fn_type(expr, ctx),
    collect_expr_locals: (expr: CoreExpr, ctx: TempCtx) => {
      if (!has_core_loop_state(ctx)) {
        throw new Error("Static value local collection requires loop state");
      }

      deps.local_collect().collect_expr_locals(expr, ctx);
    },
    collect_stmt_locals: (stmt, ctx) =>
      deps.local_collect().collect_stmt_locals(stmt, ctx as CoreCtx),
    core_expr_is_text: (expr: CoreExpr, ctx: StaticCtx) =>
      get_text().core_expr_is_text(expr, ctx),
    dynamic_union_if: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().dynamic_union_if(expr, ctx),
    emit_expr: (expr: CoreExpr, ctx: EmitCtx) =>
      deps.expr_emit().emit_expr(expr, ctx),
    emit_stmt: (stmt, ctx, is_final) =>
      deps.stmt_emit().emit_stmt(stmt, ctx, is_final),
    expr_type: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.expr_type().expr_type(expr, ctx),
    runtime_union_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().runtime_union_type_expr(expr, ctx),
    runtime_aggregate_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      runtime_aggregate_type_expr(expr, ctx, {
        check_closure_call_args: deps.closure().check_closure_call_args,
        closure_fn_type: deps.closure().closure_fn_type,
      }),
    static_core_call_value: static_call.static_core_call_value,
    static_struct_if_branches: (
      expr: Extract<CoreExpr, { tag: "if" }>,
      ctx: TempCtx,
    ) => struct.static_struct_if_branches(expr, ctx),
    static_struct_update_value: (
      expr: Extract<CoreExpr, { tag: "struct_update" }>,
      ctx: TempCtx,
    ) => struct.static_struct_update_value(expr, ctx),
    static_struct_value: (expr: CoreExpr, ctx: StaticCtx) =>
      struct.static_struct_value(expr, ctx),
    static_text_if_branches: (
      expr: Extract<CoreExpr, { tag: "if" }>,
      ctx: TempCtx,
    ) => get_text().static_text_if_branches(expr, ctx),
    static_text_value: (expr: CoreExpr, ctx: StaticCtx) =>
      get_text().static_text_value(expr, ctx),
    static_union_case: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().static_union_case(expr, ctx),
  });
}

function has_core_loop_state(
  ctx: TempCtx,
): ctx is TempCtx & { next_loop: number } {
  if (!("next_loop" in ctx)) {
    return false;
  }

  if (typeof ctx.next_loop !== "number") {
    return false;
  }

  return true;
}
