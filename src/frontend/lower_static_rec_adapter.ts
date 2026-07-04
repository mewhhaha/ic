import type {
  Binding,
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  Stmt,
  TypePattern,
} from "./ast.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";

export type FrontendStaticRecApi = {
  apply_index_assignment: (
    stmt: Extract<Stmt, { tag: "index_assign" }>,
    env: Env,
  ) => FrontExpr;
  apply_runtime_binding_annotation: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => { value: FrontExpr; type: FrontType };
  assignment_type: (
    previous: FrontType,
    value_type: FrontType,
    mode: "same" | "change",
  ) => FrontType;
  capture_const_ref: (expr: FrontExpr, env: Env) => FrontExpr;
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  check_const_annotation: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => void;
  check_type_pattern: (
    pattern: TypePattern,
    target: FrontExpr,
    env: Env,
  ) => void;
  clone_env: (env: Env) => Env;
  eval_i32_expr: (expr: FrontExpr, env: Env, label: string) => number;
  expand_for_collection: (
    stmt: Extract<Stmt, { tag: "for_collection" }>,
    env: Env,
  ) => Stmt[];
  expand_for_range: (
    stmt: Extract<Stmt, { tag: "for_range" }>,
    env: Env,
  ) => Stmt[];
  fresh: (env: Env, name: string) => string;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
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
  lookup: (env: Env, name: string) => Binding | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_static_expr: (
    expr: FrontExpr,
    env: Env,
    in_progress: Set<Binding>,
  ) => IcNode | undefined;
  prepare_const_value: (expr: FrontExpr, env: Env) => FrontExpr;
  prepare_runtime_value: (expr: FrontExpr, env: Env) => FrontExpr;
  push_binding: (env: Env, binding: Binding) => void;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_type_value: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "struct_type" }> | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  same_type: (left: FrontType, right: FrontType) => boolean;
  validate_const_expr: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
    message: string,
  ) => void;
};

export function create_frontend_static_rec_hooks(
  api: FrontendStaticRecApi,
): StaticRecHooks {
  return {
    apply_index_assignment: api.apply_index_assignment,
    apply_runtime_binding_annotation: api.apply_runtime_binding_annotation,
    assignment_type: api.assignment_type,
    capture_const_ref: api.capture_const_ref,
    capture_expr: api.capture_expr,
    check_const_annotation: api.check_const_annotation,
    check_type_pattern: api.check_type_pattern,
    clone_env: api.clone_env,
    eval_i32_expr: api.eval_i32_expr,
    expand_for_collection: api.expand_for_collection,
    expand_for_range: api.expand_for_range,
    fresh: api.fresh,
    infer_expr: api.infer_expr,
    inline_deferred_const_call: api.inline_deferred_const_call,
    inline_runtime_call_expr: api.inline_runtime_call_expr,
    inline_specialized_call_expr: api.inline_specialized_call_expr,
    lookup: api.lookup,
    lower_expr: api.lower_expr,
    lower_static_expr: api.lower_static_expr,
    prepare_const_value: api.prepare_const_value,
    prepare_runtime_value: api.prepare_runtime_value,
    push_binding: api.push_binding,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_index_expr: api.resolve_index_expr,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_struct_type_value: api.resolve_struct_type_value,
    resolve_struct_field_expr: api.resolve_struct_field_expr,
    resolve_union_value: api.resolve_union_value,
    same_type: api.same_type,
    validate_const_expr: api.validate_const_expr,
  };
}
