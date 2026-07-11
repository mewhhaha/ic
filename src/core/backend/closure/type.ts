import type { CoreExpr, CoreFnType } from "../../ast.ts";
import type { CoreBackendClosure, CoreBackendClosureApi } from "./types.ts";
import type { CoreBackendClosureCapture } from "./capture.ts";
import {
  check_closure_call_args as check_closure_call_args_with_hooks,
  closure_fn_type as closure_fn_type_with_hooks,
  closure_fn_type_with_expected as closure_fn_type_with_expected_with_hooks,
  type CoreClosureTypeHooks,
} from "../../closure_type.ts";
import type { StaticCtx } from "../../local_collect.ts";

export type CoreBackendClosureType = Pick<
  CoreBackendClosure,
  | "check_closure_call_args"
  | "closure_fn_type"
  | "closure_fn_type_with_expected"
>;

export function create_core_backend_closure_type(
  api: CoreBackendClosureApi,
  capture: CoreBackendClosureCapture,
): CoreBackendClosureType {
  const closure_type_hooks = {
    apply_core_parameter_annotation: api.apply_core_parameter_annotation,
    clear_core_local_facts: api.clear_core_local_facts,
    collect_stmt_locals: api.collect_stmt_locals,
    core_expr_is_text: api.core_expr_is_text,
    core_lam_capture_names: capture.core_lam_capture_names,
    dynamic_union_if: api.dynamic_union_if,
    expr_type: api.expr_type,
    runtime_union_match_info: api.runtime_union_match_info,
    runtime_union_target: api.runtime_union_target,
    runtime_union_type_expr: api.runtime_union_type_expr,
    scoped_static_core_call_fn_type: api.scoped_static_core_call_fn_type,
    static_annotation_type_value: api.static_annotation_type_value,
    static_core_call_requires_scope: api.static_core_call_requires_scope,
    static_core_call_target: api.static_core_call_target,
    static_core_call_value: api.static_core_call_value,
    static_runtime_union_match_branch_ctx:
      api.static_runtime_union_match_branch_ctx,
    static_struct_value: api.static_struct_value,
    static_union_case: api.static_union_case,
  } satisfies CoreClosureTypeHooks;

  function closure_fn_type(
    expr: CoreExpr,
    ctx: StaticCtx,
  ): CoreFnType | undefined {
    return closure_fn_type_with_hooks(expr, ctx, closure_type_hooks);
  }

  function closure_fn_type_with_expected(
    expr: CoreExpr,
    expected: CoreFnType,
    ctx: StaticCtx,
  ): CoreFnType | undefined {
    return closure_fn_type_with_expected_with_hooks(
      expr,
      expected,
      ctx,
      closure_type_hooks,
    );
  }

  function check_closure_call_args(
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: StaticCtx,
  ): void {
    check_closure_call_args_with_hooks(
      expr,
      fn_type,
      ctx,
      closure_type_hooks,
    );
  }

  return {
    check_closure_call_args,
    closure_fn_type,
    closure_fn_type_with_expected,
  };
}
