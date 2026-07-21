import type { Func } from "../../../mod.ts";
import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreFnType } from "../../ast.ts";
import type { CoreBackendClosure, CoreBackendClosureApi } from "./types.ts";
import type { CoreBackendClosureCapture } from "./capture.ts";
import type { CoreBackendClosureType } from "./type.ts";
import {
  type ClosureEmitCtx,
  type CoreClosureEmitHooks,
  emit_dynamic_closure_call as emit_dynamic_closure_call_with_hooks,
  emit_lifted_closure_funcs as emit_lifted_closure_funcs_with_hooks,
  emit_runtime_closure as emit_runtime_closure_with_hooks,
  emit_runtime_closure_with_type as emit_runtime_closure_with_type_with_hooks,
} from "../../closure_emit.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import type { RuntimeTextHeap } from "../../runtime_text.ts";
import type { CoreScratchHeap } from "../../scratch.ts";
import type { TextLayout } from "../../text_layout.ts";

export type CoreBackendClosureEmit = Pick<
  CoreBackendClosure,
  | "emit_dynamic_closure_call"
  | "emit_lifted_closure_funcs"
  | "emit_runtime_closure"
  | "emit_runtime_closure_with_type"
>;

export function create_core_backend_closure_emit(
  api: CoreBackendClosureApi,
  capture: CoreBackendClosureCapture,
  closure_type: CoreBackendClosureType,
): CoreBackendClosureEmit {
  const closure_emit_hooks = {
    check_closure_call_args: closure_type.check_closure_call_args,
    closure_fn_type: closure_type.closure_fn_type,
    closure_fn_type_with_expected: closure_type.closure_fn_type_with_expected,
    collect_expr_locals: api.collect_expr_locals,
    core_lam_capture_names: capture.core_lam_capture_names,
    create_lifted_body_ctx: api.create_lifted_body_ctx,
    emit_expr: api.emit_expr,
  } satisfies CoreClosureEmitHooks<CoreEmitCtx>;

  function emit_runtime_closure(
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_closure_with_hooks(expr, ctx, closure_emit_hooks);
  }

  function emit_runtime_closure_with_type(
    expr: Extract<CoreExpr, { tag: "lam" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_closure_with_type_with_hooks(
      expr,
      fn_type,
      ctx,
      closure_emit_hooks,
    );
  }

  function emit_dynamic_closure_call(
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_dynamic_closure_call_with_hooks(
      expr,
      fn_type,
      ctx,
      closure_emit_hooks,
    );
  }

  function emit_lifted_closure_funcs(
    text_layout: TextLayout,
    closures: ClosureEmitCtx,
    heap: RuntimeTextHeap,
    scratch: CoreScratchHeap,
    allocation_permits:
      import("../../allocation_emission.ts").CoreAllocationPermitState,
  ): Func[] {
    return emit_lifted_closure_funcs_with_hooks(
      text_layout,
      closures,
      heap,
      scratch,
      allocation_permits,
      closure_emit_hooks,
    );
  }

  return {
    emit_dynamic_closure_call,
    emit_lifted_closure_funcs,
    emit_runtime_closure,
    emit_runtime_closure_with_type,
  };
}
