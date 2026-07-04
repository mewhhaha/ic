import type { BuiltinCallHooks } from "./builtin_call.ts";
import { lower_builtin_call, lower_method_app } from "./builtin_call.ts";
import type { CallSpecializeHooks } from "./call_specialize.ts";
import type { ExprLowerHooks } from "./expr_lower.ts";
import type { IfExprHooks } from "./if_expr.ts";
import type { IfLetHooks } from "./if_let.ts";
import type { IndexAssignmentHooks } from "./index_assignment.ts";
import {
  check_numeric_primitive_operands,
  type NumericOperandHooks,
} from "./numeric.ts";

type DirectExprLowerHooks = Omit<
  ExprLowerHooks,
  "check_numeric_primitive_operands" | "lower_builtin_call" | "lower_method_app"
>;

export type FrontendExpressionHooksApi =
  & BuiltinCallHooks
  & CallSpecializeHooks
  & IfExprHooks
  & IfLetHooks
  & IndexAssignmentHooks
  & NumericOperandHooks
  & DirectExprLowerHooks;

export type FrontendExpressionHooks = {
  call_specialize_hooks: CallSpecializeHooks;
  expr_lower_hooks: ExprLowerHooks;
  if_expr_hooks: IfExprHooks;
  if_let_hooks: IfLetHooks;
  index_assignment_hooks: IndexAssignmentHooks;
};

export function create_frontend_expression_hooks(
  api: FrontendExpressionHooksApi,
): FrontendExpressionHooks {
  const builtin_call_hooks = {
    capture_expr: api.capture_expr,
    eval_const_builtin: api.eval_const_builtin,
    eval_simple_front_block: api.eval_simple_front_block,
    infer_expr: api.infer_expr,
    lookup: api.lookup,
    lower_dynamic_index_access: api.lower_dynamic_index_access,
    lower_expr: api.lower_expr,
    lower_runtime_struct_index_access: api.lower_runtime_struct_index_access,
    lower_runtime_text_byte_index: api.lower_runtime_text_byte_index,
    lower_static_text_byte_index: api.lower_static_text_byte_index,
    lower_text_len: api.lower_text_len,
    resolve_index_expr: api.resolve_index_expr,
    resolve_runtime_struct_type: api.resolve_runtime_struct_type,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
    visible_text_value: api.visible_text_value,
  } satisfies BuiltinCallHooks;

  const call_specialize_hooks = {
    apply_annotation_context: api.apply_annotation_context,
    can_lower_dynamic_union_if_as_value:
      api.can_lower_dynamic_union_if_as_value,
    check_binding_annotation: api.check_binding_annotation,
    check_const_annotation: api.check_const_annotation,
    eval_front_value: api.eval_front_value,
    infer_expr: api.infer_expr,
    infer_union_cases: api.infer_union_cases,
    lower_app_as_front_type: api.lower_app_as_front_type,
    lower_expr: api.lower_expr,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_const_field_expr: api.resolve_const_field_expr,
    resolve_dynamic_if_let_struct_value:
      api.resolve_dynamic_if_let_struct_value,
    resolve_dynamic_union_if_target: api.resolve_dynamic_union_if_target,
    resolve_static_if_branch: api.resolve_static_if_branch,
    resolve_struct_value: api.resolve_struct_value,
    resolve_union_value: api.resolve_union_value,
    visible_text_value: api.visible_text_value,
  } satisfies CallSpecializeHooks;

  const if_let_hooks = {
    can_lower_dynamic_union_if_as_value:
      api.can_lower_dynamic_union_if_as_value,
    eval_simple_front_block: api.eval_simple_front_block,
    infer_expr: api.infer_expr,
    infer_union_cases: api.infer_union_cases,
    inline_deferred_const_call: api.inline_deferred_const_call,
    inline_specialized_call_expr: api.inline_specialized_call_expr,
    lower_expr: api.lower_expr,
    lower_struct_value: api.lower_struct_value,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_dynamic_if_let_struct_value:
      api.resolve_dynamic_if_let_struct_value,
    resolve_numeric_expr_type: api.resolve_numeric_expr_type,
    resolve_union_value: api.resolve_union_value,
  } satisfies IfLetHooks;

  const if_expr_hooks = {
    infer_expr: api.infer_expr,
    lower_dynamic_struct_if: api.lower_dynamic_struct_if,
    lower_dynamic_union_if: api.lower_dynamic_union_if,
    lower_expr: api.lower_expr,
    resolve_annotation_type: api.resolve_annotation_type,
  } satisfies IfExprHooks;

  const numeric_operand_hooks = {
    infer_expr: api.infer_expr,
    resolve_numeric_expr_type: api.resolve_numeric_expr_type,
  } satisfies NumericOperandHooks;

  const expr_lower_hooks = {
    apply_struct_update: api.apply_struct_update,
    can_lower_dynamic_union_if_as_value:
      api.can_lower_dynamic_union_if_as_value,
    check_dynamic_function_if_args: api.check_dynamic_function_if_args,
    check_numeric_primitive_operands: (expr, env) =>
      check_numeric_primitive_operands(expr, env, numeric_operand_hooks),
    check_text_concat_operand_visibility:
      api.check_text_concat_operand_visibility,
    declared_struct_field_type: api.declared_struct_field_type,
    declared_struct_index_type: api.declared_struct_index_type,
    lower_builtin_call: (expr, env) =>
      lower_builtin_call(expr, env, builtin_call_hooks),
    lower_dynamic_index_access: api.lower_dynamic_index_access,
    lower_dynamic_union_if: api.lower_dynamic_union_if,
    infer_expr: api.infer_expr,
    lower_expr_as_declared_type: api.lower_expr_as_declared_type,
    lower_if_expr: api.lower_if_expr,
    lower_if_let: api.lower_if_let,
    inline_runtime_call_expr: api.inline_runtime_call_expr,
    lower_method_app: (expr, env) =>
      lower_method_app(expr, env, builtin_call_hooks),
    lower_runtime_struct_field_access: api.lower_runtime_struct_field_access,
    lower_runtime_struct_index_access: api.lower_runtime_struct_index_access,
    lower_runtime_text_byte_index: api.lower_runtime_text_byte_index,
    lower_app_as_front_type: api.lower_app_as_front_type,
    lower_specialized_app: api.lower_specialized_app,
    lower_static_rec_app: api.lower_static_rec_app,
    lower_static_text_byte_index: api.lower_static_text_byte_index,
    lower_statements: api.lower_statements,
    lower_struct_value: api.lower_struct_value,
    lower_union_case_value: api.lower_union_case_value,
    requires_specialized_call: api.requires_specialized_call,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_const_field_expr: api.resolve_const_field_expr,
    resolve_index_expr: api.resolve_index_expr,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
    resolve_union_constructor_call: api.resolve_union_constructor_call,
    try_eval_all_const_call: api.try_eval_all_const_call,
    visible_text_value: api.visible_text_value,
  } satisfies ExprLowerHooks;

  const index_assignment_hooks = {
    capture_expr: api.capture_expr,
    indexed_result_type: api.indexed_result_type,
    indexed_values_are_text: api.indexed_values_are_text,
    infer_expr: api.infer_expr,
    prepare_runtime_value: api.prepare_runtime_value,
    resolve_numeric_expr_type: api.resolve_numeric_expr_type,
    resolve_runtime_struct_type: api.resolve_runtime_struct_type,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_value: api.resolve_struct_value,
    resolve_struct_value_type_fields: api.resolve_struct_value_type_fields,
    validate_struct_value: api.validate_struct_value,
  } satisfies IndexAssignmentHooks;

  return {
    call_specialize_hooks,
    expr_lower_hooks,
    if_expr_hooks,
    if_let_hooks,
    index_assignment_hooks,
  };
}
