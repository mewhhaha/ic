import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, Source as SourceNode, Stmt } from "./ast.ts";
import { assignment_type } from "./annotations.ts";
import { create_frontend_expression_hooks } from "./lower_expression_hooks_adapter.ts";
import { capture_const_ref, capture_expr } from "./capture.ts";
import { is_const_builtin_name, validate_const_expr } from "./constness.ts";
import { clone_env, create_env, fresh, lookup, push_binding } from "./env.ts";
import type { FrontEvalHooks } from "./eval.ts";
import { format_expr } from "./format.ts";
import { share_free_variables } from "./ic_share.ts";
import type { IfLetHooks } from "./if_let.ts";
import type { IfExprHooks } from "./if_expr.ts";
import type { ExprLowerHooks } from "./expr_lower.ts";
import type { InferHooks } from "./infer.ts";
import { create_frontend_annotation } from "./lower_annotation_adapter.ts";
import { create_frontend_call_facade } from "./lower_call_facade.ts";
import {
  create_frontend_call_graph,
  type FrontendCallGraph,
} from "./lower_call_graph.ts";
import { create_frontend_const_resolve } from "./lower_const_resolve_adapter.ts";
import { create_frontend_dynamic_branch } from "./lower_dynamic_branch_adapter.ts";
import { create_frontend_lower_graph_bridge } from "./lower_graph/bridge.ts";
import { create_frontend_static_expr } from "./lower_static_expr_adapter.ts";
import { create_frontend_static_loop } from "./lower_static_loop_adapter.ts";
import { create_frontend_static_rec_hooks } from "./lower_static_rec_adapter.ts";
import { create_frontend_struct_access } from "./lower_struct_access_adapter.ts";
import { create_frontend_text_lower } from "./lower_text_adapter.ts";
import { create_frontend_program_hooks } from "./lower_program_hooks_adapter.ts";
import { apply_index_assignment } from "./index_assignment.ts";
import type { FrontPrepareHooks } from "./prepare.ts";
import {
  infer_static_rec_app_type,
  lower_static_rec_app,
  lower_static_rec_app_as_front_type,
} from "./rec.ts";
import { create_frontend_app_type } from "./lower_app_type_adapter.ts";
import { create_frontend_runtime_struct } from "./lower_runtime_struct_adapter.ts";
import type { StatementLowerHooks } from "./stmt.ts";
import {
  apply_struct_update,
  check_struct_fields,
  maybe_struct_type_value,
  resolve_struct_type_value,
  type StructValueHooks,
  type StructValueTarget,
  validate_struct_value,
} from "./struct_values.ts";
import {
  check_type_pattern,
  resolve_extended_type_value,
} from "./type_patterns.ts";
import { type UnionValueHooks } from "./union_values.ts";
import { type UnionInferHooks } from "./union_infer.ts";
import {
  create_frontend_value_graph,
  type FrontendValueGraph,
} from "./lower_value_graph.ts";
import { create_frontend_value_facade } from "./lower_value_facade.ts";
import { same_type } from "./types.ts";

export function lower_program(source: SourceNode): IcNode {
  const env = create_env();
  return share_free_variables(lower_statements(source.statements, 0, env));
}

let frontend_call_graph: FrontendCallGraph;
let frontend_value_graph: FrontendValueGraph;
let eval_hooks: FrontEvalHooks;
let expr_lower_hooks: ExprLowerHooks;
let if_expr_hooks: IfExprHooks;
let if_let_hooks: IfLetHooks;
let infer_hooks: InferHooks;
let prepare_hooks: FrontPrepareHooks;
let statement_lower_hooks: StatementLowerHooks;

const {
  check_dynamic_function_if_args,
  eval_const_call,
  infer_call_union_result_type,
  infer_specialized_app_type,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  is_deferred_frontend_value,
  lower_specialized_app,
  requires_specialized_call,
  resolve_call_target,
  resolve_deferred_frontend_value,
  try_eval_all_const_call,
} = create_frontend_call_facade(() => frontend_call_graph);

const {
  check_union_case_value,
  declared_struct_field_type,
  declared_struct_index_type,
  indexed_result_type,
  indexed_values_are_text,
  infer_dynamic_if_let_cases,
  infer_dynamic_union_if_cases,
  infer_union_cases,
  infer_untyped_union_case,
  lower_dynamic_index_access,
  lower_expr_as_declared_type,
  lower_struct_value,
  lower_union_case_value,
  resolve_index_expr,
  resolve_struct_field_expr,
  resolve_struct_value,
  resolve_struct_value_type_fields,
  resolve_union_constructor_call,
  resolve_union_type_value,
  resolve_union_value,
  validate_union_payload_type,
} = create_frontend_value_facade(() => frontend_value_graph);

const {
  eval_front_block,
  eval_front_value,
  eval_simple_front_block,
  infer_expr,
  lower_expr,
  lower_if_expr,
  lower_if_let,
  lower_statements,
  prepare_const_value,
  prepare_runtime_value,
  resolve_dynamic_union_if_target,
  resolve_static_if_branch,
} = create_frontend_lower_graph_bridge({
  eval_hooks: () => eval_hooks,
  expr_lower_hooks: () => expr_lower_hooks,
  if_expr_hooks: () => if_expr_hooks,
  if_let_hooks: () => if_let_hooks,
  infer_hooks: () => infer_hooks,
  prepare_hooks: () => prepare_hooks,
  resolve_static_i32_expr: (expr, env) => resolve_static_i32_expr(expr, env),
  statement_lower_hooks: () => statement_lower_hooks,
});

const frontend_static_expr = create_frontend_static_expr({
  lookup,
  lower_expr,
  resolve_index_expr,
  resolve_struct_field_expr,
});

const {
  eval_i32_expr,
  lower_static_expr,
  resolve_static_i32_expr,
} = frontend_static_expr;

const {
  infer_app_result_type: infer_frontend_app_result_type,
  lower_app_as_front_type: lower_frontend_app_as_front_type,
} = create_frontend_app_type({
  infer_expr,
  infer_specialized_app_type,
  infer_static_rec_app_type: (expr, env) =>
    infer_static_rec_app_type(expr, env, static_rec_hooks),
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lower_expr,
  lower_static_rec_app_as_front_type: (expr, type, env) =>
    lower_static_rec_app_as_front_type(
      expr,
      type,
      env,
      static_rec_hooks,
    ),
  resolve_annotation_type: (annotation, env) =>
    resolve_annotation_type(annotation, env),
});

const frontend_text_lower = create_frontend_text_lower({
  can_lower_dynamic_union_if_as_value: (expr, env) =>
    can_lower_dynamic_union_if_as_value(expr, env),
  eval_simple_front_block,
  infer_expr,
  infer_union_cases,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lookup,
  lower_app_as_front_type: lower_frontend_app_as_front_type,
  lower_expr,
  resolve_annotation_type: (annotation, env) =>
    resolve_annotation_type(annotation, env),
  resolve_index_expr,
  resolve_static_i32_expr,
  resolve_struct_field_expr,
  resolve_struct_value,
  resolve_union_value,
  try_eval_all_const_call,
});

const {
  check_text_concat_operand_visibility,
  lower_runtime_text_byte_index,
  lower_static_text_byte_index,
  lower_text_len,
  resolve_text_bytes,
  visible_text_value,
} = frontend_text_lower;

const frontend_static_loop = create_frontend_static_loop({
  eval_i32_expr,
  infer_expr,
  infer_union_cases,
  resolve_annotation_type: (annotation, env) =>
    resolve_annotation_type(annotation, env),
  resolve_static_i32_expr,
  resolve_runtime_struct_type: (expr, env) =>
    resolve_runtime_struct_type(expr, env),
  resolve_struct_value,
  resolve_union_value,
  resolve_text_bytes,
});

const {
  expand_for_collection,
  expand_for_range,
} = frontend_static_loop;

const frontend_const_resolve = create_frontend_const_resolve({
  capture_expr,
  eval_simple_front_block,
  lookup,
  resolve_extended_type_value: (expr, env) =>
    resolve_extended_type_value(expr, env, type_pattern_hooks),
  resolve_index_expr,
  resolve_static_i32_expr,
  resolve_struct_value,
  try_eval_all_const_call,
});

const {
  eval_const_builtin,
  lookup_const_field,
  resolve_const_expr,
  resolve_const_expr_with_env,
  resolve_const_field_expr,
} = frontend_const_resolve;

const type_pattern_hooks = {
  resolve_const_expr,
};

const union_value_hooks = {
  eval_simple_front_block,
  infer_expr,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lower_expr,
  resolve_const_expr,
  resolve_extended_type_value: (expr, env) =>
    resolve_extended_type_value(expr, env, type_pattern_hooks),
  resolve_index_expr,
  resolve_static_i32_expr,
  resolve_struct_field_expr,
} satisfies UnionValueHooks;

const union_infer_hooks = {
  eval_simple_front_block,
  infer_union_cases,
  infer_untyped_union_case,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  resolve_dynamic_union_if_target,
  resolve_annotation_type: (annotation, env) =>
    resolve_annotation_type(annotation, env),
  resolve_union_type_value,
  resolve_union_value,
} satisfies UnionInferHooks;

const frontend_dynamic_branch = create_frontend_dynamic_branch({
  infer_dynamic_if_let_cases,
  infer_dynamic_union_if_cases,
  infer_expr,
  lower_expr,
  lower_struct_value,
  lower_union_case_value,
  resolve_annotation_type: (annotation, env) =>
    resolve_annotation_type(annotation, env),
  resolve_struct_type_value: (expr, env) =>
    resolve_struct_type_value(expr, env, struct_value_hooks),
  resolve_struct_value,
  resolve_union_value,
});

const {
  can_lower_dynamic_union_if_as_value,
  lower_dynamic_struct_if,
  lower_dynamic_union_if,
  resolve_dynamic_if_let_struct_value,
  resolve_dynamic_struct_if_value,
} = frontend_dynamic_branch;

const struct_value_hooks = {
  capture_expr,
  eval_simple_front_block,
  infer_expr,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lower_expr_as_declared_type,
  lower_expr,
  resolve_const_expr,
  resolve_dynamic_if_let_struct_value,
  resolve_dynamic_struct_if_value,
  resolve_extended_type_value: (expr, env) =>
    resolve_extended_type_value(expr, env, type_pattern_hooks),
  resolve_index_expr,
  resolve_static_i32_expr,
  resolve_struct_field_expr,
} satisfies StructValueHooks;

const frontend_annotation = create_frontend_annotation({
  capture_const_ref,
  capture_expr,
  check_const_annotation,
  check_struct_fields: (type_value, fields, env) =>
    check_struct_fields(type_value, fields, env, struct_value_hooks),
  check_union_case_value,
  infer_expr,
  lower_static_expr,
  resolve_const_expr,
  resolve_deferred_frontend_value,
  resolve_struct_value,
  resolve_union_value,
  visible_text_value,
});

const {
  apply_annotation_context,
  apply_runtime_binding_annotation,
  check_binding_annotation,
  resolve_annotation_type,
  resolve_numeric_expr_type,
} = frontend_annotation;

const frontend_runtime_struct = create_frontend_runtime_struct({
  fresh,
  infer_expr,
  lower_expr,
  resolve_app_result_type: (expr, env) =>
    infer_frontend_app_result_type(expr, env),
  resolve_annotation_type,
  resolve_struct_value_type_fields,
});

const {
  lower_runtime_struct_field_access,
  lower_runtime_struct_index_access,
  lower_runtime_struct_projection,
  resolve_runtime_struct_type,
} = frontend_runtime_struct;

const frontend_struct_access = create_frontend_struct_access({
  eval_i32_expr,
  infer_expr,
  lower_expr,
  lower_runtime_struct_projection,
  lower_static_expr,
  resolve_runtime_struct_type,
  resolve_struct_value,
  resolve_struct_value_type_fields,
});

frontend_value_graph = create_frontend_value_graph({
  struct_access: frontend_struct_access,
  struct_value_hooks,
  union_infer_hooks,
  union_value_hooks,
});

const frontend_expression_hooks = create_frontend_expression_hooks({
  apply_annotation_context,
  apply_struct_update: (expr, env) =>
    apply_struct_update(expr, env, struct_value_hooks),
  can_lower_dynamic_union_if_as_value,
  capture_expr,
  check_binding_annotation,
  check_const_annotation,
  check_dynamic_function_if_args: (expr, env) =>
    check_dynamic_function_if_args(expr, env),
  check_text_concat_operand_visibility,
  declared_struct_field_type,
  declared_struct_index_type,
  eval_const_builtin,
  eval_simple_front_block,
  eval_front_value,
  indexed_result_type,
  indexed_values_are_text,
  infer_expr,
  infer_union_cases,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lookup,
  lower_dynamic_index_access,
  lower_dynamic_struct_if,
  lower_dynamic_union_if,
  lower_expr,
  lower_expr_as_declared_type,
  lower_if_expr,
  lower_if_let,
  lower_runtime_struct_field_access: (expr, env) =>
    lower_runtime_struct_field_access(expr, env),
  lower_runtime_struct_index_access: (object, index, env) =>
    lower_runtime_struct_index_access(object, index, env),
  lower_runtime_text_byte_index,
  lower_app_as_front_type: lower_frontend_app_as_front_type,
  lower_specialized_app,
  lower_static_rec_app: (expr, env) =>
    lower_static_rec_app(expr, env, static_rec_hooks),
  lower_static_text_byte_index,
  lower_statements,
  lower_struct_value,
  lower_text_len,
  lower_union_case_value,
  prepare_runtime_value,
  requires_specialized_call,
  resolve_annotation_type,
  resolve_const_field_expr,
  resolve_dynamic_if_let_struct_value,
  resolve_dynamic_union_if_target,
  resolve_index_expr,
  resolve_numeric_expr_type,
  resolve_runtime_struct_type,
  resolve_static_i32_expr,
  resolve_static_if_branch,
  resolve_struct_field_expr,
  resolve_struct_value,
  resolve_struct_value_type_fields,
  resolve_union_constructor_call,
  resolve_union_value,
  try_eval_all_const_call,
  validate_struct_value: (value, env) =>
    validate_struct_value(value, env, struct_value_hooks),
  visible_text_value,
});

const {
  call_specialize_hooks,
  index_assignment_hooks,
} = frontend_expression_hooks;

expr_lower_hooks = frontend_expression_hooks.expr_lower_hooks;
if_expr_hooks = frontend_expression_hooks.if_expr_hooks;
if_let_hooks = frontend_expression_hooks.if_let_hooks;

frontend_call_graph = create_frontend_call_graph(call_specialize_hooks);

const frontend_program_hooks = create_frontend_program_hooks({
  apply_struct_update: (expr, env) =>
    apply_struct_update(expr, env, struct_value_hooks),
  apply_annotation_context,
  apply_index_assignment: (stmt, env) =>
    apply_index_assignment(stmt, env, index_assignment_hooks),
  apply_runtime_binding_annotation,
  assignment_type,
  capture_const_ref,
  capture_expr,
  check_binding_annotation,
  check_type_pattern: (stmt, env) =>
    check_type_pattern(stmt.pattern, stmt.target, env, type_pattern_hooks),
  check_text_concat_operand_visibility,
  eval_const_call,
  eval_i32_expr,
  expand_for_collection,
  expand_for_range,
  infer_call_union_result_type,
  infer_dynamic_if_let_cases,
  infer_dynamic_union_if_cases,
  infer_union_cases,
  infer_specialized_app_type,
  infer_static_rec_app_type: (expr, env) =>
    infer_static_rec_app_type(expr, env, static_rec_hooks),
  infer_expr,
  inline_deferred_const_call,
  is_deferred_frontend_value,
  lower_app_as_front_type: lower_frontend_app_as_front_type,
  lower_dynamic_union_if,
  lower_expr,
  maybe_struct_type_value: (expr: FrontExpr, env: Env) =>
    maybe_struct_type_value(expr, env, struct_value_hooks),
  prepare_const_value,
  prepare_runtime_value,
  requires_specialized_call,
  resolve_annotation_type,
  resolve_const_field_expr,
  resolve_index_expr,
  resolve_runtime_struct_type,
  resolve_static_i32_expr,
  resolve_struct_field_expr,
  resolve_struct_value,
  resolve_struct_value_type_fields,
  resolve_union_constructor_call,
  resolve_union_type_value,
  resolve_union_value,
  try_eval_all_const_call,
  validate_struct_value: (value, env) =>
    validate_struct_value(value, env, struct_value_hooks),
  visible_text_value,
});

eval_hooks = frontend_program_hooks.eval_hooks;
infer_hooks = frontend_program_hooks.infer_hooks;
prepare_hooks = frontend_program_hooks.prepare_hooks;
statement_lower_hooks = frontend_program_hooks.statement_lower_hooks;

const static_rec_hooks = create_frontend_static_rec_hooks({
  apply_index_assignment: (
    stmt: Extract<Stmt, { tag: "index_assign" }>,
    env: Env,
  ) => apply_index_assignment(stmt, env, index_assignment_hooks),
  apply_runtime_binding_annotation: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => apply_runtime_binding_annotation(annotation, value, env),
  assignment_type,
  capture_const_ref,
  capture_expr,
  check_const_annotation,
  check_type_pattern: (pattern, target, env) =>
    check_type_pattern(pattern, target, env, type_pattern_hooks),
  clone_env,
  eval_i32_expr,
  expand_for_collection,
  expand_for_range,
  fresh,
  infer_expr,
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
  lookup,
  lower_expr,
  lower_static_expr,
  prepare_const_value,
  prepare_runtime_value,
  push_binding,
  resolve_annotation_type,
  resolve_index_expr,
  resolve_static_i32_expr,
  resolve_struct_type_value: (expr, env) =>
    resolve_struct_type_value(expr, env, struct_value_hooks),
  resolve_struct_field_expr,
  resolve_union_value,
  same_type,
  validate_const_expr,
});

function check_const_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
): void {
  const checker = resolve_call_target({ tag: "var", name: annotation }, env);
  expect(checker, "Missing fact checker: " + annotation);
  const result = eval_const_call(
    {
      tag: "app",
      func: { tag: "var", name: annotation },
      args: [value],
    },
    env,
    true,
  );
  expect(result, "Fact checker did not produce a value: " + annotation);
}
