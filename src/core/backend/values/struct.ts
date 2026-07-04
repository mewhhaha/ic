import type { CoreExpr, CoreField } from "../../ast.ts";
import type { StaticCtx } from "../../local_collect.ts";
import {
  static_collection_fields as static_collection_fields_with_hooks,
  static_struct_binding as static_struct_binding_with_hooks,
  static_struct_if_branches as static_struct_if_branches_with_hooks,
  static_struct_update_value as static_struct_update_value_with_hooks,
  static_struct_value as static_struct_value_with_hooks,
  type StaticStructHooks,
  type StaticStructIfBranches,
} from "../../struct_static.ts";
import type {
  CoreBackendStruct,
  CoreBackendStructApi,
} from "./struct/types.ts";

export type { CoreBackendStruct, CoreBackendStructApi };

export function create_core_backend_struct(
  api: CoreBackendStructApi,
): CoreBackendStruct {
  const struct_hooks = {
    expr_type: api.expr_type,
    runtime_aggregate_type_expr: api.runtime_aggregate_type_expr,
    static_core_call_value: api.static_core_call_value,
    static_core_call_target: api.static_core_call_target,
  } satisfies StaticStructHooks<StaticCtx>;

  function static_struct_value(
    expr: CoreExpr,
    ctx: StaticCtx,
  ): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
    return static_struct_value_with_hooks(expr, ctx, struct_hooks);
  }

  function static_struct_update_value(
    expr: Extract<CoreExpr, { tag: "struct_update" }>,
    ctx: StaticCtx,
  ): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
    return static_struct_update_value_with_hooks(expr, ctx, struct_hooks);
  }

  function static_struct_binding(
    name: string,
    ctx: StaticCtx,
  ): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
    return static_struct_binding_with_hooks(name, ctx, struct_hooks);
  }

  function static_struct_if_branches(
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: StaticCtx,
  ): StaticStructIfBranches | undefined {
    return static_struct_if_branches_with_hooks(expr, ctx, struct_hooks);
  }

  function static_collection_fields(
    expr: CoreExpr,
    ctx: StaticCtx,
  ): CoreField[] | undefined {
    return static_collection_fields_with_hooks(expr, ctx, struct_hooks);
  }

  return {
    static_collection_fields,
    static_struct_binding,
    static_struct_if_branches,
    static_struct_update_value,
    static_struct_value,
  };
}
