import type { Func } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreFnType,
  CoreStmt,
} from "./ast.ts";
import type { CoreAllocationPermitState } from "./allocation_emission.ts";
import type { ClosureEmitCtx } from "./closure_emit.ts";
import type { CoreCtx } from "./local_collect.ts";
import type { RuntimeTextHeap } from "./runtime_text.ts";
import type { CoreScratchHeap } from "./scratch.ts";
import type { TextLayout } from "./text_layout.ts";

export type CoreArtifactEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  mutable_bindings?: Set<string>;
  text_layout: TextLayout;
  closures?: ClosureEmitCtx;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  continue_label: string | undefined;
};

export type CoreArtifactEmitInput = {
  core_ctx: CoreCtx;
  text_layout: TextLayout;
  closures: ClosureEmitCtx;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  allocation_permits: CoreAllocationPermitState;
};

export type CoreArtifactEmitHooks<ctx extends CoreArtifactEmitCtx> = {
  build_text_layout: (core: CoreNode, core_ctx: CoreCtx) => TextLayout;
  collect_core_ctx: (core: CoreNode) => CoreCtx;
  create_emit_ctx: (input: CoreArtifactEmitInput) => ctx;
  emit_lifted_closure_funcs: (
    text_layout: TextLayout,
    closures: ClosureEmitCtx,
    heap: RuntimeTextHeap,
    scratch: CoreScratchHeap,
    allocation_permits: CoreAllocationPermitState,
  ) => Func[];
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  stmt_result_type: (stmt: CoreStmt, ctx: CoreCtx) => ValType;
};
