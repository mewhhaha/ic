import type { CoreExpr, CoreHostImport, CoreParam } from "../ast.ts";
import type { CoreHostImportCtx } from "../host_import.ts";
import type { CoreOwnership, CoreOwnershipHooks } from "../ownership.ts";
import type { StaticCoreCallCtx } from "../static_call.ts";

export type CoreHostBoundaryDecision =
  | {
    tag: "allowed";
    reason: string;
  }
  | {
    tag: "rejected";
    reason: string;
  };

export type CoreHostBoundaryArg = {
  index: number;
  ownership: CoreOwnership;
  decision: CoreHostBoundaryDecision;
};

export type CoreHostBoundaryEdge = {
  id: string;
  callee: string;
  signature: CoreHostImport | undefined;
  args: CoreHostBoundaryArg[];
  decision: CoreHostBoundaryDecision;
};

export type CoreHostBoundaryPlan = {
  edges: CoreHostBoundaryEdge[];
};

export type CoreHostBoundaryClosureCtx<ctx> =
  | {
    tag: "scan";
    ctx: ctx;
  }
  | {
    tag: "skip";
  };

export type CoreHostBoundaryHooks<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
> =
  & CoreOwnershipHooks<ctx>
  & {
    closure_body_ctx: (
      expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
      ctx: ctx,
    ) => CoreHostBoundaryClosureCtx<ctx>;
    if_let_stmt_branch_ctx: (
      case_name: string,
      value_name: string | undefined,
      target: CoreExpr,
      ctx: ctx,
    ) =>
      | { tag: "scan"; ctx: ctx }
      | { tag: "skip" }
      | { tag: "unknown" };
    static_core_call_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
    static_core_call_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
    static_core_rec_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "rec" }> | undefined;
  };

export type CoreHostBoundaryState = {
  next_host: number;
  edges: CoreHostBoundaryEdge[];
  scratch_depth: number;
  scratch_locals: Map<string, CoreOwnership>;
  aliases: Map<string, CoreExpr>;
  functions: Map<string, StaticHostBoundaryTarget>;
  active_static_calls: Set<string>;
  static_wrapper_depth: number;
};

export type StaticHostBoundaryFunction = Extract<
  CoreExpr,
  { tag: "lam" | "rec" }
>;

export type StaticHostBoundaryTarget =
  | StaticHostBoundaryFunction
  | {
    tag: "branch";
    kind: "if" | "if_let";
    then_target: StaticHostBoundaryTarget;
    else_target: StaticHostBoundaryTarget;
  };

export function static_host_boundary_target_params(
  target: StaticHostBoundaryTarget,
): CoreParam[] | undefined {
  if (target.tag === "lam" || target.tag === "rec") {
    return target.params;
  }

  const then_params = static_host_boundary_target_params(target.then_target);
  const else_params = static_host_boundary_target_params(target.else_target);

  if (!then_params) {
    return undefined;
  }

  if (!else_params) {
    return undefined;
  }

  if (then_params.length !== else_params.length) {
    return undefined;
  }

  return then_params;
}
