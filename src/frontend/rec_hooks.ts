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

export type StaticRecHooks = {
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
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
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
