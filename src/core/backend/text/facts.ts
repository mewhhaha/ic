import type { CoreExpr } from "../../ast.ts";
import type { CoreBackendText, CoreBackendTextApi } from "./types.ts";
import type { CoreBackendTextStatic } from "./static.ts";
import type { StaticCtx } from "../../local_collect.ts";
import { create_rec_call_ctx } from "../../local_collect.ts";
import {
  core_expr_has_runtime_text_fact as core_expr_has_runtime_text_fact_with_hooks,
  core_expr_is_text as core_expr_is_text_with_hooks,
  core_runtime_text_concat_operands
    as core_runtime_text_concat_operands_with_hooks,
  core_runtime_text_eq_operands as core_runtime_text_eq_operands_with_hooks,
  type CoreTextFactHooks,
  type RuntimeTextEq,
} from "../../text_facts.ts";

export type CoreBackendTextFacts = Pick<
  CoreBackendText,
  | "core_expr_has_runtime_text_fact"
  | "core_expr_is_text"
  | "core_runtime_text_concat_operands"
  | "core_runtime_text_eq_operands"
>;

export function create_core_backend_text_facts(
  api: CoreBackendTextApi,
  static_text: CoreBackendTextStatic,
): CoreBackendTextFacts {
  const text_fact_hooks = {
    bind_core_assignment_struct_type: api.bind_core_assignment_struct_type,
    bind_core_assignment_union_type: api.bind_core_assignment_union_type,
    bind_core_fn_type: api.bind_core_fn_type,
    bind_core_struct_type: api.bind_core_struct_type,
    bind_core_union_type: api.bind_core_union_type,
    bind_core_if_let_payload_fact: api.bind_core_if_let_payload_fact,
    bind_dynamic_if_let_payload: api.bind_dynamic_if_let_payload,
    check_closure_call_args: api.check_closure_call_args,
    closure_fn_type: api.closure_fn_type,
    core_binding_value: api.core_binding_value,
    core_assignment_value: api.core_assignment_value,
    dynamic_union_if: api.dynamic_union_if,
    expr_type: api.expr_type,
    if_let_branch_ctx: create_rec_call_ctx,
    runtime_union_match_info: api.runtime_union_match_info,
    runtime_union_target: api.runtime_union_target,
    static_collection_fields: api.static_collection_fields,
    scoped_static_core_call_value: api.scoped_static_core_call_value,
    static_core_call_requires_scope: api.static_core_call_requires_scope,
    static_core_call_value: api.static_core_call_value,
    static_core_call_target: api.static_core_call_target,
    static_runtime_union_match_branch_ctx:
      api.static_runtime_union_match_branch_ctx,
    static_struct_value: api.static_struct_value,
    static_text_value: static_text.static_text_value,
    static_union_case: api.static_union_case,
  } satisfies CoreTextFactHooks<StaticCtx>;

  function core_expr_is_text(
    value: CoreExpr,
    ctx: StaticCtx,
  ): boolean {
    return core_expr_is_text_with_hooks(value, ctx, text_fact_hooks);
  }

  function core_expr_has_runtime_text_fact(
    value: CoreExpr,
    ctx: StaticCtx,
  ): boolean {
    return core_expr_has_runtime_text_fact_with_hooks(
      value,
      ctx,
      text_fact_hooks,
    );
  }

  function core_runtime_text_concat_operands(
    value: CoreExpr,
    ctx: StaticCtx,
  ): [CoreExpr, CoreExpr] | undefined {
    return core_runtime_text_concat_operands_with_hooks(
      value,
      ctx,
      text_fact_hooks,
    );
  }

  function core_runtime_text_eq_operands(
    value: CoreExpr,
    ctx: StaticCtx,
  ): RuntimeTextEq | undefined {
    return core_runtime_text_eq_operands_with_hooks(
      value,
      ctx,
      text_fact_hooks,
    );
  }

  return {
    core_expr_has_runtime_text_fact,
    core_expr_is_text,
    core_runtime_text_concat_operands,
    core_runtime_text_eq_operands,
  };
}
