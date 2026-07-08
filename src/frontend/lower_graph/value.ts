import type { Ic as IcNode } from "../../ic.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "../ast.ts";
import { create_frontend_dynamic_branch } from "../lower_dynamic_branch_adapter.ts";
import type { FrontendStructAccess } from "../lower_struct_access_adapter.ts";
import {
  create_frontend_value_graph as create_frontend_value_graph_with_hooks,
  type FrontendValueGraph,
} from "../lower_value_graph.ts";
import { resolve_extended_type_value } from "../type_patterns.ts";
import {
  resolve_struct_type_value,
  type StructValueHooks,
} from "../struct_values.ts";
import type { UnionInferHooks } from "../union_infer.ts";
import type { UnionValueHooks } from "../union_values.ts";

type LowerGraphTypePatternHooks = {
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
};

export type FrontendLowerGraphValueApi = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  infer_dynamic_if_let_cases: (
    expr: FrontExpr,
    env: Env,
  ) => TypeField[] | undefined;
  infer_dynamic_union_if_cases: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => TypeField[] | undefined;
  infer_union_cases: (
    expr: FrontExpr,
    env: Env,
  ) => TypeField[] | undefined;
  infer_untyped_union_case: (
    expr: Extract<FrontExpr, { tag: "union_case" }>,
    env: Env,
  ) => TypeField | undefined;
  inline_deferred_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_runtime_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_specialized_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_expr_as_declared_type: (
    expr: FrontExpr,
    env: Env,
    type_name: string | undefined,
  ) => IcNode;
  lower_struct_value: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => IcNode;
  lower_union_case_value: (
    expr: Extract<FrontExpr, { tag: "union_case" }>,
    env: Env,
  ) => IcNode;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
  resolve_dynamic_union_if_target: (
    expr: FrontExpr,
    env: Env,
  ) => { expr: Extract<FrontExpr, { tag: "if" }>; env: Env } | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_static_i32_expr: (expr: FrontExpr, env: Env) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_union_type_value: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "union_type" }> | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  type_pattern_hooks: LowerGraphTypePatternHooks;
};

export type FrontendLowerGraphValueHooks = {
  can_lower_dynamic_union_if_as_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => boolean;
  lower_dynamic_struct_if: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_dynamic_union_if: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode | undefined;
  resolve_dynamic_if_let_struct_value: (
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_dynamic_struct_if_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  create_value_graph: (
    struct_access: FrontendStructAccess,
  ) => FrontendValueGraph;
  struct_value_hooks: StructValueHooks;
};

export function create_frontend_lower_graph_value_hooks(
  api: FrontendLowerGraphValueApi,
): FrontendLowerGraphValueHooks {
  const union_value_hooks = {
    eval_simple_front_block: api.eval_simple_front_block,
    infer_expr: api.infer_expr,
    inline_deferred_const_call: api.inline_deferred_const_call,
    inline_runtime_call_expr: api.inline_runtime_call_expr,
    inline_specialized_call_expr: api.inline_specialized_call_expr,
    lower_expr: api.lower_expr,
    resolve_const_expr: api.resolve_const_expr,
    resolve_extended_type_value: (expr, env) =>
      resolve_extended_type_value(expr, env, api.type_pattern_hooks),
    resolve_index_expr: api.resolve_index_expr,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
  } satisfies UnionValueHooks;

  const union_infer_hooks = {
    eval_simple_front_block: api.eval_simple_front_block,
    infer_union_cases: api.infer_union_cases,
    infer_untyped_union_case: api.infer_untyped_union_case,
    inline_deferred_const_call: api.inline_deferred_const_call,
    inline_runtime_call_expr: api.inline_runtime_call_expr,
    inline_specialized_call_expr: api.inline_specialized_call_expr,
    resolve_dynamic_union_if_target: api.resolve_dynamic_union_if_target,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_union_type_value: api.resolve_union_type_value,
    resolve_union_value: api.resolve_union_value,
  } satisfies UnionInferHooks;

  const frontend_dynamic_branch = create_frontend_dynamic_branch({
    infer_dynamic_if_let_cases: api.infer_dynamic_if_let_cases,
    infer_dynamic_union_if_cases: api.infer_dynamic_union_if_cases,
    infer_expr: api.infer_expr,
    lower_expr: api.lower_expr,
    lower_struct_value: api.lower_struct_value,
    lower_union_case_value: api.lower_union_case_value,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_struct_type_value: (expr, env) =>
      resolve_struct_type_value(expr, env, struct_value_hooks),
    resolve_struct_value: api.resolve_struct_value,
    resolve_union_value: api.resolve_union_value,
  });

  const {
    can_lower_dynamic_union_if_as_value,
    lower_dynamic_struct_if,
    lower_dynamic_union_if,
    resolve_dynamic_if_let_struct_value,
    resolve_dynamic_struct_if_value,
  } = frontend_dynamic_branch;

  const struct_value_hooks: StructValueHooks = {
    capture_expr: api.capture_expr,
    eval_simple_front_block: api.eval_simple_front_block,
    infer_expr: api.infer_expr,
    inline_deferred_const_call: api.inline_deferred_const_call,
    inline_runtime_call_expr: api.inline_runtime_call_expr,
    inline_specialized_call_expr: api.inline_specialized_call_expr,
    lower_expr_as_declared_type: api.lower_expr_as_declared_type,
    lower_expr: api.lower_expr,
    resolve_const_expr: api.resolve_const_expr,
    resolve_dynamic_if_let_struct_value,
    resolve_dynamic_struct_if_value,
    resolve_extended_type_value: (expr, env) =>
      resolve_extended_type_value(expr, env, api.type_pattern_hooks),
    resolve_index_expr: api.resolve_index_expr,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
  } satisfies StructValueHooks;

  function create_value_graph(
    struct_access: FrontendStructAccess,
  ): FrontendValueGraph {
    return create_frontend_value_graph_with_hooks({
      struct_access,
      struct_value_hooks,
      union_infer_hooks,
      union_value_hooks,
    });
  }

  return {
    can_lower_dynamic_union_if_as_value,
    create_value_graph,
    lower_dynamic_struct_if,
    lower_dynamic_union_if,
    resolve_dynamic_if_let_struct_value,
    resolve_dynamic_struct_if_value,
    struct_value_hooks,
  };
}
