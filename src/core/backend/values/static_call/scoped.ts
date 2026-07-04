import type { ValType } from "../../../../op.ts";
import type { Wat } from "../../../../wat.ts";
import type { CoreExpr, CoreFnType } from "../../../ast.ts";
import type { CoreEmitCtx } from "../../../emit_ctx.ts";
import type { CoreCtx, StaticCtx, TempCtx } from "../../../local_collect.ts";
import {
  collect_scoped_static_core_call_locals
    as collect_scoped_static_core_call_locals_with_hooks,
  emit_scoped_static_core_call as emit_scoped_static_core_call_with_hooks,
  scoped_static_core_call_fn_type as scoped_static_core_call_fn_type_with_hooks,
  scoped_static_core_call_type as scoped_static_core_call_type_with_hooks,
  scoped_static_core_call_value as scoped_static_core_call_value_with_hooks,
  type StaticCoreCallHooks,
} from "../../../static_call.ts";
import type { CoreBackendStaticCall } from "./types.ts";

export type CoreBackendStaticCallScoped = Pick<
  CoreBackendStaticCall,
  | "collect_scoped_static_core_call_locals"
  | "emit_scoped_static_core_call"
  | "scoped_static_core_call_fn_type"
  | "scoped_static_core_call_type"
  | "scoped_static_core_call_value"
>;

export function create_core_backend_static_call_scoped(
  hooks: StaticCoreCallHooks<StaticCtx, TempCtx, CoreCtx, CoreEmitCtx>,
): CoreBackendStaticCallScoped {
  function collect_scoped_static_core_call_locals(
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreCtx,
  ): void {
    collect_scoped_static_core_call_locals_with_hooks(
      expr,
      target,
      ctx,
      hooks,
    );
  }

  function emit_scoped_static_core_call(
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_scoped_static_core_call_with_hooks(
      expr,
      target,
      ctx,
      hooks,
    );
  }

  function scoped_static_core_call_type(
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ): ValType {
    return scoped_static_core_call_type_with_hooks(
      expr,
      target,
      ctx,
      hooks,
    );
  }

  function scoped_static_core_call_fn_type(
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ): CoreFnType | undefined {
    return scoped_static_core_call_fn_type_with_hooks(
      expr,
      target,
      ctx,
      hooks,
    );
  }

  function scoped_static_core_call_value(
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ): { value: CoreExpr; ctx: CoreCtx } {
    return scoped_static_core_call_value_with_hooks(
      expr,
      target,
      ctx,
      hooks,
    );
  }

  return {
    collect_scoped_static_core_call_locals,
    emit_scoped_static_core_call,
    scoped_static_core_call_fn_type,
    scoped_static_core_call_type,
    scoped_static_core_call_value,
  };
}
