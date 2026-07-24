import type { CoreExpr } from "../ast.ts";
import { collect_core_expr_captures } from "./scan.ts";
import type {
  CoreCaptureHooks,
  CoreCaptureInfo,
  CoreCaptureState,
  CoreCaptureStaticCtx,
} from "./types.ts";

export function core_lam_capture_names<ctx extends CoreCaptureStaticCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
  hooks: CoreCaptureHooks<ctx>,
): string[] | undefined {
  const info = core_lam_capture_info(expr, ctx, hooks);

  if (info.invalid_assignment) {
    return undefined;
  }

  return info.names;
}

export function core_lam_capture_info<ctx extends CoreCaptureStaticCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
  hooks: CoreCaptureHooks<ctx>,
): CoreCaptureInfo {
  const state: CoreCaptureState<ctx> = {
    ctx,
    locals: ctx.locals,
    bound: new Set(),
    names: [],
    seen: new Set(),
    static_seen: new Set(),
    invalid_assignment: false,
    hooks,
  };

  for (const param of expr.params) {
    state.bound.add(param.name);
  }

  collect_core_expr_captures(expr.body, state);
  return {
    names: state.names,
    invalid_assignment: state.invalid_assignment,
  };
}
