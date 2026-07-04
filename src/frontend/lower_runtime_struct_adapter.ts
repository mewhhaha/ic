import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import {
  lower_runtime_struct_field_access
    as lower_runtime_struct_field_access_with_hooks,
  lower_runtime_struct_index_access
    as lower_runtime_struct_index_access_with_hooks,
  lower_runtime_struct_projection as lower_runtime_struct_projection_with_hooks,
  resolve_runtime_struct_type as resolve_runtime_struct_type_with_hooks,
  type RuntimeStructHooks,
  type RuntimeStructTypeHooks,
} from "./runtime_struct.ts";

export type FrontendRuntimeStructApi = {
  fresh: (env: Env, name: string) => string;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_app_result_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_struct_value_type_fields: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => TypeField[] | undefined;
};

export type FrontendRuntimeStruct = {
  lower_runtime_struct_field_access: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_struct_index_access: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_struct_projection: (
    object: FrontExpr,
    field_index: number,
    fields: TypeField[],
    env: Env,
  ) => IcNode;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
};

export function create_frontend_runtime_struct(
  api: FrontendRuntimeStructApi,
): FrontendRuntimeStruct {
  const runtime_struct_type_hooks = {
    infer_expr: api.infer_expr,
    resolve_app_result_type: api.resolve_app_result_type,
    resolve_annotation_type: api.resolve_annotation_type,
    resolve_struct_value_type_fields: api.resolve_struct_value_type_fields,
  } satisfies RuntimeStructTypeHooks;

  const runtime_struct_hooks = {
    fresh: api.fresh,
    lower_expr: api.lower_expr,
    resolve_runtime_struct_type,
  } satisfies RuntimeStructHooks;

  function resolve_runtime_struct_type(
    expr: FrontExpr,
    env: Env,
  ): { fields: TypeField[] } | undefined {
    return resolve_runtime_struct_type_with_hooks(
      expr,
      env,
      runtime_struct_type_hooks,
    );
  }

  function lower_runtime_struct_index_access(
    object: FrontExpr,
    index: number,
    env: Env,
  ): IcNode | undefined {
    return lower_runtime_struct_index_access_with_hooks(
      object,
      index,
      env,
      runtime_struct_hooks,
    );
  }

  function lower_runtime_struct_field_access(
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ): IcNode | undefined {
    return lower_runtime_struct_field_access_with_hooks(
      expr,
      env,
      runtime_struct_hooks,
    );
  }

  function lower_runtime_struct_projection(
    object: FrontExpr,
    field_index: number,
    fields: TypeField[],
    env: Env,
  ): IcNode {
    return lower_runtime_struct_projection_with_hooks(
      object,
      field_index,
      fields,
      env,
      runtime_struct_hooks,
    );
  }

  return {
    lower_runtime_struct_field_access,
    lower_runtime_struct_index_access,
    lower_runtime_struct_projection,
    resolve_runtime_struct_type,
  };
}
