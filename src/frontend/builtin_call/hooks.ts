import type { Ic as IcNode } from "../../ic.ts";
import type {
  Binding,
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "../ast.ts";

export type BuiltinCallHooks = {
  capture_expr: (expr: FrontExpr, env: Env) => FrontExpr;
  eval_const_builtin: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lookup: (env: Env, name: string) => Binding | undefined;
  lower_dynamic_index_access: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_runtime_struct_index_access: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_text_byte_index: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_static_text_byte_index: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_text_len: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => IcNode | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_const_expr_with_env: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};
