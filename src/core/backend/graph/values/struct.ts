import type { CoreExpr } from "../../../ast.ts";
import type { StaticCtx } from "../../../local_collect.ts";
import { runtime_aggregate_type_expr } from "../../../runtime_aggregate.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";
import type { CoreBackendStaticCall } from "../../values/static_call/types.ts";
import { create_core_backend_struct } from "../../values/struct.ts";
import type { CoreBackendStruct } from "../../values/struct/types.ts";

export function create_core_backend_values_struct(
  deps: CoreBackendGraphDeps,
  static_call: CoreBackendStaticCall,
): CoreBackendStruct {
  return create_core_backend_struct({
    expr_type: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.expr_type().expr_type(expr, ctx),
    runtime_aggregate_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      runtime_aggregate_type_expr_for_static_collection(expr, ctx, deps),
    static_core_call_value: static_call.static_core_call_value,
    static_core_call_target: static_call.static_core_call_target,
  });
}

function runtime_aggregate_type_expr_for_static_collection(
  expr: CoreExpr,
  ctx: StaticCtx,
  deps: CoreBackendGraphDeps,
): CoreExpr | undefined {
  try {
    return runtime_aggregate_type_expr(expr, ctx, {
      check_closure_call_args: deps.closure().check_closure_call_args,
      closure_fn_type: deps.closure().closure_fn_type,
    });
  } catch (error) {
    if (runtime_aggregate_collection_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function runtime_aggregate_collection_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Core first-class closure parameter must use a scalar annotation:",
    )
  ) {
    return true;
  }

  if (
    error.message === "Core runtime aggregate requires a static struct type"
  ) {
    return true;
  }

  return false;
}
