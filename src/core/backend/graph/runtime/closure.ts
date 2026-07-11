import type { CoreExpr } from "../../../ast.ts";
import { create_core_backend_closure } from "../../closure.ts";
import type { CoreBackendClosure } from "../../closure/types.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";
import type { CoreBackendUnion } from "../../union/types.ts";
import {
  create_core_branch_emit_ctx,
  create_core_lifted_closure_body_ctx,
  create_core_runtime_union_match_branch_ctx,
} from "../../../emit_ctx.ts";
import type { StaticCtx } from "../../../local_collect.ts";

export function create_core_backend_runtime_closure(
  deps: CoreBackendGraphDeps,
  get_union: () => CoreBackendUnion,
): CoreBackendClosure {
  return create_core_backend_closure({
    apply_core_parameter_annotation: (param, value, ctx) =>
      deps.type_check().apply_core_parameter_annotation(param, value, ctx),
    branch_payload_ctx: create_core_branch_emit_ctx,
    clear_core_local_facts: (name, ctx) =>
      deps.local_facts().clear_core_local_facts(name, ctx),
    collect_stmt_locals: (stmt, ctx) =>
      deps.local_collect().collect_stmt_locals(stmt, ctx),
    core_expr_is_text: (expr, ctx) => deps.text().core_expr_is_text(expr, ctx),
    collect_expr_locals: (expr, ctx) =>
      deps.local_collect().collect_expr_locals(expr, ctx),
    create_lifted_body_ctx: create_core_lifted_closure_body_ctx,
    dynamic_union_if: (expr, ctx) => get_union().dynamic_union_if(expr, ctx),
    emit_expr: (expr, ctx) => deps.expr_emit().emit_expr(expr, ctx),
    emit_stmt: (stmt, ctx, is_final) =>
      deps.stmt_emit().emit_stmt(stmt, ctx, is_final),
    expr_type: (expr, ctx) => deps.expr_type().expr_type(expr, ctx),
    match_branch_ctx: create_core_runtime_union_match_branch_ctx,
    runtime_union_match_info: (case_name, target, ctx) =>
      get_union().runtime_union_match_info(case_name, target, ctx),
    runtime_union_target: (expr, ctx) =>
      get_union().runtime_union_target(expr, ctx),
    runtime_union_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      get_union().runtime_union_type_expr(expr, ctx),
    scoped_static_core_call_fn_type: (expr, target, ctx) =>
      deps.static_call().scoped_static_core_call_fn_type(expr, target, ctx),
    static_annotation_type_value: (annotation: string, ctx: StaticCtx) =>
      deps.type_check().static_annotation_type_value(annotation, ctx),
    static_core_call_requires_scope: (target) =>
      deps.static_call().static_core_call_requires_scope(target),
    static_core_call_target: (expr, ctx) =>
      deps.static_call().static_core_call_target(expr, ctx),
    static_core_call_value: (expr, ctx) =>
      deps.static_call().static_core_call_value(expr, ctx),
    static_runtime_union_match_branch_ctx: (value_name, info, ctx) =>
      get_union().static_runtime_union_match_branch_ctx(
        value_name,
        info,
        ctx,
      ),
    static_struct_binding: (name, ctx) =>
      deps.struct().static_struct_binding(name, ctx),
    static_struct_value: (expr, ctx) =>
      deps.struct().static_struct_value(expr, ctx),
    static_union_case: (expr, ctx) => get_union().static_union_case(expr, ctx),
  });
}
