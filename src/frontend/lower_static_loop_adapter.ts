import type { Env, FrontExpr, FrontType, Stmt } from "./ast.ts";
import {
  expand_for_collection as expand_for_collection_with_hooks,
  expand_for_range as expand_for_range_with_hooks,
  type StaticLoopHooks,
} from "./static_loop.ts";

export type FrontendStaticLoopApi = {
  eval_i32_expr: (expr: FrontExpr, env: Env, label: string) => number;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  infer_union_cases: (
    expr: FrontExpr,
    env: Env,
  ) => { name: string; type_name: string }[] | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { fields: { name: string; type_name: string }[] }
    | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  resolve_text_bytes: (expr: FrontExpr, env: Env) => number[] | undefined;
};

export type FrontendStaticLoop = {
  expand_for_collection: (
    stmt: Extract<Stmt, { tag: "for_collection" }>,
    env: Env,
  ) => Stmt[];
  expand_for_range: (
    stmt: Extract<Stmt, { tag: "for_range" }>,
    env: Env,
  ) => Stmt[];
};

export function create_frontend_static_loop(
  api: FrontendStaticLoopApi,
): FrontendStaticLoop {
  const static_loop_hooks = {
    eval_i32_expr: api.eval_i32_expr,
    infer_expr: api.infer_expr,
    infer_union_cases: api.infer_union_cases,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_static_i32_expr: api.resolve_static_i32_expr,
    resolve_runtime_struct_type: api.resolve_runtime_struct_type,
    resolve_struct_value: api.resolve_struct_value,
    resolve_union_value: api.resolve_union_value,
    resolve_text_bytes: api.resolve_text_bytes,
  } satisfies StaticLoopHooks;

  function expand_for_range(
    stmt: Extract<Stmt, { tag: "for_range" }>,
    env: Env,
  ): Stmt[] {
    return expand_for_range_with_hooks(stmt, env, static_loop_hooks);
  }

  function expand_for_collection(
    stmt: Extract<Stmt, { tag: "for_collection" }>,
    env: Env,
  ): Stmt[] {
    return expand_for_collection_with_hooks(stmt, env, static_loop_hooks);
  }

  return {
    expand_for_collection,
    expand_for_range,
  };
}
