import type { CoreExpr } from "../../../ast.ts";
import type { StaticCtx } from "../../../local_collect.ts";
import {
  runtime_aggregate_type_expr,
  same_runtime_aggregate_type_expr,
} from "../../../runtime_aggregate.ts";
import { same_runtime_union_type_expr } from "../../../runtime_union.ts";
import { static_type_value } from "../../../type_static.ts";
import type { CoreBackendLocalFacts } from "../../analysis/local_facts.ts";
import { create_core_backend_local_facts } from "../../analysis/local_facts.ts";
import type { CoreBackendGraphDeps } from "../../graph_deps.ts";

export function create_core_backend_graph_local_facts(
  deps: CoreBackendGraphDeps,
): CoreBackendLocalFacts {
  return create_core_backend_local_facts({
    closure_fn_type: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.closure().closure_fn_type(expr, ctx),
    runtime_aggregate_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      inferred_runtime_aggregate_type_expr(expr, ctx, deps),
    runtime_union_type_expr: (expr: CoreExpr, ctx: StaticCtx) =>
      deps.union().runtime_union_type_expr(expr, ctx),
    same_runtime_aggregate_type_expr,
    same_runtime_union_type_expr,
    static_type_value,
  });
}

function inferred_runtime_aggregate_type_expr(
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
    if (
      error instanceof Error &&
      error.message.startsWith(
        "First-class closure ownership-qualified parameter annotations are " +
          "not supported yet:",
      )
    ) {
      return undefined;
    }

    throw error;
  }
}
