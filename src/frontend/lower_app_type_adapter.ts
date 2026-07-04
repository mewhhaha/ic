import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, ResolvedFrontExpr } from "./ast.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

const max_frontend_app_as_type_depth = 16;

export type FrontendAppTypeApi = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  infer_specialized_app_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  infer_static_rec_app_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  inline_runtime_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  inline_specialized_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  lower_static_rec_app_as_front_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export type FrontendAppType = {
  infer_app_result_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  lower_app_as_front_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
};

export function create_frontend_app_type(
  api: FrontendAppTypeApi,
): FrontendAppType {
  function lower_app_as_front_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
    depth = 0,
  ): IcNode | undefined {
    const rec_app = api.lower_static_rec_app_as_front_type(expr, type, env);

    if (rec_app) {
      return rec_app;
    }

    if (type.tag === "text") {
      return undefined;
    }

    if (depth >= max_frontend_app_as_type_depth) {
      return undefined;
    }

    const specialized = api.inline_specialized_call_expr(expr, env);

    if (specialized) {
      return lower_inlined_app_as_front_type(specialized, type, depth);
    }

    const runtime = api.inline_runtime_call_expr(expr, env);

    if (!runtime) {
      return undefined;
    }

    return lower_inlined_app_as_front_type(runtime, type, depth);
  }

  function lower_inlined_app_as_front_type(
    value: ResolvedFrontExpr,
    type: FrontType,
    depth: number,
  ): IcNode {
    return lower_expr_as_front_type(value.expr, type, value.env, {
      infer_expr: api.infer_expr,
      lower_app_as_front_type: (expr, nested_type, env) =>
        lower_app_as_front_type(
          expr,
          nested_type,
          env,
          depth + 1,
        ),
      lower_expr: api.lower_expr,
      resolve_annotation_type: api.resolve_annotation_type,
    });
  }

  function infer_app_result_type(
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
    depth = 0,
  ): FrontType | undefined {
    const rec_type = api.infer_static_rec_app_type(expr, env);

    if (rec_type) {
      return rec_type;
    }

    const specialized_type = api.infer_specialized_app_type(expr, env);

    if (specialized_type) {
      return specialized_type;
    }

    if (depth >= max_frontend_app_as_type_depth) {
      return undefined;
    }

    const specialized = api.inline_specialized_call_expr(expr, env);

    if (specialized) {
      return infer_resolved_app_result_type(specialized, depth);
    }

    const runtime = api.inline_runtime_call_expr(expr, env);

    if (!runtime) {
      return undefined;
    }

    return infer_resolved_app_result_type(runtime, depth);
  }

  function infer_resolved_app_result_type(
    value: ResolvedFrontExpr,
    depth: number,
  ): FrontType | undefined {
    const inferred = api.infer_expr(value.expr, value.env);

    if (inferred.tag !== "unknown") {
      return inferred;
    }

    if (value.expr.tag !== "app") {
      return undefined;
    }

    return infer_app_result_type(value.expr, value.env, depth + 1);
  }

  return {
    infer_app_result_type,
    lower_app_as_front_type,
  };
}
