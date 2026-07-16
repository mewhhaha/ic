import type { FuncType } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreHostImport } from "./ast.ts";
import type { RuntimeTextHeap } from "./runtime_text/types.ts";
import type { CoreScratchHeap } from "./scratch.ts";
import type { TextLayout } from "./text_layout/types.ts";

export const closure_heap_global = "__closure_heap";
export const closure_table_name = "__closure_table";
export const closure_env_param = "__env";

export type ClosureCapture = {
  source_name: string;
  local_name: string;
  type: ValType;
  fn_type: CoreFnType | undefined;
  struct_type: CoreExpr | undefined;
  union_type: CoreExpr | undefined;
  is_text: boolean;
  is_frozen: boolean;
  offset: number;
};

export type LiftedClosure = {
  id: number;
  lam: Extract<CoreExpr, { tag: "lam" }>;
  func_name: string;
  table_index: number;
  type_name: string;
  fn_type: CoreFnType;
  captures: ClosureCapture[];
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  materialized_bindings?: Set<string>;
  host_imports?: Map<string, CoreHostImport>;
};

export type ClosureEmitCtx = {
  next_lift: number;
  by_lam: WeakMap<Extract<CoreExpr, { tag: "lam" }>, LiftedClosure>;
  lifts: LiftedClosure[];
  types: Map<string, FuncType>;
  table_elements: string[];
};

export type CoreClosureEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  materialized_bindings?: Set<string>;
  host_imports?: Map<string, CoreHostImport>;
  closures?: ClosureEmitCtx;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  allocation_permits:
    import("./allocation_emission.ts").CoreAllocationPermitState;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  next_loop: number;
  next_temp: number;
};

export type CoreClosureLiftedBodyInput = {
  lift: LiftedClosure;
  locals: Map<string, ValType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  materialized_bindings?: Set<string>;
  host_imports?: Map<string, CoreHostImport>;
  text_layout: TextLayout;
  closures: ClosureEmitCtx;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  allocation_permits:
    import("./allocation_emission.ts").CoreAllocationPermitState;
};

export type CoreClosureEmitHooks<ctx extends CoreClosureEmitCtx> = {
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: ctx) => void;
  core_lam_capture_names: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => string[] | undefined;
  create_lifted_body_ctx: (input: CoreClosureLiftedBodyInput) => ctx;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
};

export function create_closure_emit_ctx(): ClosureEmitCtx {
  return {
    next_lift: 0,
    by_lam: new WeakMap(),
    lifts: [],
    types: new Map(),
    table_elements: [],
  };
}
