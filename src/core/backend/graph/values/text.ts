import type { CoreExpr, CoreStmt } from "../../../ast.ts";
import type { CoreEmitCtx as EmitCtx } from "../../../emit_ctx.ts";
import type { StaticCtx } from "../../../local_collect.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";
import { type CoreBackendText, create_core_backend_text } from "../../text.ts";
import type { CoreBackendStaticCall } from "../../values/static_call/types.ts";
import type { CoreBackendStruct } from "../../values/struct/types.ts";
import { runtime_aggregate_type_expr } from "../../../runtime_aggregate.ts";

export function create_core_backend_values_text(
  deps: CoreBackendGraphDeps,
  static_call: CoreBackendStaticCall,
  struct: CoreBackendStruct,
): CoreBackendText {
  return create_core_backend_text({
    bind_core_assignment_struct_type:
      deps.local_facts().bind_core_assignment_struct_type,
    bind_core_assignment_union_type:
      deps.local_facts().bind_core_assignment_union_type,
    bind_core_fn_type: deps.local_facts().bind_core_fn_type,
    bind_core_struct_type: deps.local_facts().bind_core_struct_type,
    bind_core_union_type: deps.local_facts().bind_core_union_type,
    core_binding_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      ctx: StaticCtx,
    ) => deps.type_check().core_binding_value(stmt, ctx),
    core_assignment_value: (
      stmt: Extract<CoreStmt, { tag: "assign" }>,
      ctx: StaticCtx,
    ) => deps.type_check().core_assignment_value(stmt, ctx),
    core_type_const_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      value: CoreExpr,
      ctx: StaticCtx,
    ) => deps.type_check().core_type_const_value(stmt, value, ctx),
    check_closure_call_args: (
      expr: Extract<CoreExpr, { tag: "app" }>,
      fn_type,
      ctx: StaticCtx,
    ) => deps.closure().check_closure_call_args(expr, fn_type, ctx),
    bind_core_if_let_payload_fact: (
      value_name: string | undefined,
      union_case: Extract<CoreExpr, { tag: "union_case" }>,
      ctx: StaticCtx,
    ) =>
      deps.control_flow().bind_core_if_let_payload_fact(
        value_name,
        union_case,
        ctx,
      ),
    bind_dynamic_if_let_payload: (
      case_name: string,
      value_name: string | undefined,
      target,
      ctx: StaticCtx,
    ) =>
      deps.union().bind_dynamic_if_let_payload(
        case_name,
        value_name,
        target,
        ctx,
      ),
    closure_fn_type: (expr: CoreExpr, ctx: StaticCtx) =>
      optional_closure_fn_type(expr, ctx, deps),
    dynamic_union_if: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().dynamic_union_if(expr, ctx),
    runtime_union_match_info: (case_name, target, ctx) =>
      deps.union().runtime_union_match_info(case_name, target, ctx),
    runtime_union_target: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().runtime_union_target(expr, ctx),
    runtime_union_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().runtime_union_type_expr(expr, ctx),
    runtime_aggregate_type_expr: (expr: CoreExpr, ctx: StaticCtx) => {
      return runtime_aggregate_type_expr(expr, ctx, {
        check_closure_call_args: deps.closure().check_closure_call_args,
        closure_fn_type: (value, closure_ctx) =>
          optional_closure_fn_type(value, closure_ctx, deps),
      });
    },
    emit_expr: (expr: CoreExpr, ctx: EmitCtx) =>
      deps.expr_emit().emit_expr(expr, ctx),
    expr_type: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.expr_type().expr_type(expr, ctx),
    static_runtime_union_match_branch_ctx: (value_name, info, ctx) =>
      deps.union().static_runtime_union_match_branch_ctx(
        value_name,
        info,
        ctx,
      ),
    static_collection_fields: struct.static_collection_fields,
    scoped_static_core_call_value: static_call.scoped_static_core_call_value,
    static_core_call_requires_scope:
      static_call.static_core_call_requires_scope,
    static_core_call_value: static_call.static_core_call_value,
    static_core_call_target: static_call.static_core_call_target,
    static_struct_value: struct.static_struct_value,
    static_union_case: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().static_union_case(expr, ctx),
  });
}

function optional_closure_fn_type(
  expr: CoreExpr,
  ctx: StaticCtx,
  deps: CoreBackendGraphDeps,
) {
  try {
    return deps.closure().closure_fn_type(expr, ctx);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "First-class closure ownership-qualified parameter annotations " +
          "are not supported yet:",
      )
    ) {
      return undefined;
    }

    throw error;
  }
}
