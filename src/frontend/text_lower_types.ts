import type { Ic as IcNode } from "../ic.ts";
import type {
  Binding,
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import type { ResolvedUnionValue } from "./if_let_types.ts";

export type TextLowerHooks = {
  can_lower_dynamic_union_if_as_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => boolean;
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_union_cases: (
    expr: FrontExpr,
    env: Env,
  ) => TypeField[] | undefined;
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
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lookup: (env: Env, name: string) => Binding | undefined;
  lower_app_as_front_type?: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
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
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedUnionValue | undefined;
  try_eval_all_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
};
