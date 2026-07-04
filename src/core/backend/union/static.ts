import type { CoreExpr } from "../../ast.ts";
import type { CoreBackendUnion, CoreBackendUnionApi } from "./types.ts";
import type { DynamicUnionIf } from "../../if_let.ts";
import type { StaticCtx } from "../../local_collect.ts";
import {
  bind_dynamic_if_let_payload as bind_dynamic_if_let_payload_with_hooks,
  type CoreUnionHooks,
  dynamic_union_if as dynamic_union_if_with_hooks,
  static_union_case as static_union_case_with_hooks,
} from "../../union_static.ts";

export type CoreBackendUnionStatic = Pick<
  CoreBackendUnion,
  "bind_dynamic_if_let_payload" | "dynamic_union_if" | "static_union_case"
>;

export function create_core_backend_union_static(
  api: CoreBackendUnionApi,
): CoreBackendUnionStatic {
  const union_hooks = {
    block_ctx: api.block_ctx,
    check_core_value_type_name: api.check_core_value_type_name,
    collect_stmt_locals: api.collect_stmt_locals,
    core_expr_is_text: api.core_expr_is_text,
    expr_type: api.expr_type,
    scoped_static_core_call_value: api.scoped_static_core_call_value,
    static_core_call_requires_scope: api.static_core_call_requires_scope,
    static_core_call_target: api.static_core_call_target,
    static_core_call_value: api.static_core_call_value,
    static_struct_value: api.static_struct_value,
    static_type_value: api.static_type_value,
  } satisfies CoreUnionHooks<StaticCtx>;

  function static_union_case(
    expr: CoreExpr,
    ctx: StaticCtx,
  ): Extract<CoreExpr, { tag: "union_case" }> | undefined {
    return static_union_case_with_hooks(expr, ctx, union_hooks);
  }

  function dynamic_union_if(
    expr: CoreExpr,
    ctx: StaticCtx,
  ): DynamicUnionIf | undefined {
    return dynamic_union_if_with_hooks(expr, ctx, union_hooks);
  }

  function bind_dynamic_if_let_payload(
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: StaticCtx,
  ): void {
    bind_dynamic_if_let_payload_with_hooks(
      case_name,
      value_name,
      target,
      ctx,
      union_hooks,
    );
  }

  return {
    bind_dynamic_if_let_payload,
    dynamic_union_if,
    static_union_case,
  };
}
