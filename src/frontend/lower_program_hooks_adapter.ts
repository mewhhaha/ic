import type { FrontEvalHooks } from "./eval.ts";
import type { InferHooks } from "./infer.ts";
import type { FrontPrepareHooks } from "./prepare.ts";
import type { StatementLowerHooks } from "./stmt.ts";

export type FrontendProgramHooksApi =
  & FrontPrepareHooks
  & FrontEvalHooks
  & StatementLowerHooks
  & InferHooks;

export type FrontendProgramHooks = {
  prepare_hooks: FrontPrepareHooks;
  eval_hooks: FrontEvalHooks;
  statement_lower_hooks: StatementLowerHooks;
  infer_hooks: InferHooks;
};

export function create_frontend_program_hooks(
  api: FrontendProgramHooksApi,
): FrontendProgramHooks {
  const prepare_hooks = {
    apply_struct_update: api.apply_struct_update,
    capture_const_ref: api.capture_const_ref,
    capture_expr: api.capture_expr,
    inline_deferred_const_call: api.inline_deferred_const_call,
    resolve_union_constructor_call: api.resolve_union_constructor_call,
    try_eval_all_const_call: api.try_eval_all_const_call,
    validate_struct_value: api.validate_struct_value,
  } satisfies FrontPrepareHooks;

  const eval_hooks = {
    apply_annotation_context: api.apply_annotation_context,
    apply_index_assignment: api.apply_index_assignment,
    apply_runtime_binding_annotation: api.apply_runtime_binding_annotation,
    check_binding_annotation: api.check_binding_annotation,
    check_type_pattern: api.check_type_pattern,
    eval_const_call: api.eval_const_call,
    eval_i32_expr: api.eval_i32_expr,
    expand_for_collection: api.expand_for_collection,
    expand_for_range: api.expand_for_range,
    infer_expr: api.infer_expr,
    inline_deferred_const_call: api.inline_deferred_const_call,
    prepare_const_value: api.prepare_const_value,
    resolve_const_field_expr: api.resolve_const_field_expr,
    resolve_index_expr: api.resolve_index_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
    resolve_union_constructor_call: api.resolve_union_constructor_call,
    resolve_union_value: api.resolve_union_value,
    visible_text_value: api.visible_text_value,
  } satisfies FrontEvalHooks;

  const statement_lower_hooks = {
    apply_annotation_context: api.apply_annotation_context,
    apply_index_assignment: api.apply_index_assignment,
    apply_runtime_binding_annotation: api.apply_runtime_binding_annotation,
    assignment_type: api.assignment_type,
    check_binding_annotation: api.check_binding_annotation,
    check_type_pattern: api.check_type_pattern,
    expand_for_collection: api.expand_for_collection,
    expand_for_range: api.expand_for_range,
    infer_dynamic_if_let_cases: api.infer_dynamic_if_let_cases,
    infer_expr: api.infer_expr,
    is_deferred_frontend_value: api.is_deferred_frontend_value,
    lower_app_as_front_type: api.lower_app_as_front_type,
    lower_dynamic_union_if: api.lower_dynamic_union_if,
    lower_expr: api.lower_expr,
    prepare_const_value: api.prepare_const_value,
    prepare_runtime_value: api.prepare_runtime_value,
    requires_specialized_call: api.requires_specialized_call,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_union_value: api.resolve_union_value,
  } satisfies StatementLowerHooks;

  const infer_hooks = {
    check_text_concat_operand_visibility:
      api.check_text_concat_operand_visibility,
    infer_call_union_result_type: api.infer_call_union_result_type,
    infer_dynamic_union_if_cases: api.infer_dynamic_union_if_cases,
    infer_specialized_app_type: api.infer_specialized_app_type,
    infer_static_rec_app_type: api.infer_static_rec_app_type,
    infer_union_cases: api.infer_union_cases,
    maybe_struct_type_value: api.maybe_struct_type_value,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_index_expr: api.resolve_index_expr,
    resolve_runtime_struct_type: api.resolve_runtime_struct_type,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
    resolve_struct_value: api.resolve_struct_value,
    resolve_struct_value_type_fields: api.resolve_struct_value_type_fields,
    resolve_union_constructor_call: api.resolve_union_constructor_call,
    resolve_union_type_value: api.resolve_union_type_value,
    visible_text_value: api.visible_text_value,
  } satisfies InferHooks;

  return {
    eval_hooks,
    infer_hooks,
    prepare_hooks,
    statement_lower_hooks,
  };
}
