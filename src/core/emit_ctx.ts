import type { CoreArtifactEmitInput } from "./artifact_emit.ts";
import type {
  ClosureEmitCtx,
  CoreClosureLiftedBodyInput,
} from "./closure_emit.ts";
import type { StaticCtx } from "./local_collect.ts";
import type { RuntimeTextHeap } from "./runtime_text.ts";
import type { CoreScratchHeap } from "./scratch.ts";
import type { RuntimeUnionMatchInfo } from "./runtime_union.ts";
import type { RuntimeUnionPayloadEmitBinding } from "./runtime_union_emit.ts";
import { bind_runtime_union_match_payload_temps } from "./runtime_union_match.ts";
import type { TextLayout } from "./text_layout.ts";
import { clone_core_host_imports } from "./host_import.ts";

export type CoreEmitCtx = StaticCtx & {
  text_layout: TextLayout;
  closures?: ClosureEmitCtx;
  heap: RuntimeTextHeap;
  scratch: CoreScratchHeap;
  allocation_permits:
    import("./allocation_emission.ts").CoreAllocationPermitState;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  break_value_type: import("../op.ts").ValType | undefined;
  continue_label: string | undefined;
};

export function create_core_artifact_emit_ctx(
  input: CoreArtifactEmitInput,
): CoreEmitCtx {
  return {
    locals: input.core_ctx.locals,
    statics: new Map(),
    fn_types: new Map(),
    static_capture_values: clone_optional_map(
      input.core_ctx.static_capture_values,
    ),
    text_locals: new Set(input.core_ctx.text_locals),
    struct_locals: new Map(input.core_ctx.struct_locals),
    union_locals: new Map(input.core_ctx.union_locals),
    borrowed_locals: clone_optional_set(input.core_ctx.borrowed_locals),
    frozen_locals: clone_optional_set(input.core_ctx.frozen_locals),
    materialized_bindings: clone_optional_set(
      input.core_ctx.materialized_bindings,
    ),
    mutable_bindings: clone_optional_set(input.core_ctx.mutable_bindings),
    host_imports: clone_core_host_imports(input.core_ctx.host_imports),
    text_layout: input.text_layout,
    closures: input.closures,
    heap: input.heap,
    scratch: input.scratch,
    allocation_permits: input.allocation_permits,
    scratch_loop_resets: [],
    scratch_return_resets: [],
    scratch_depth: input.core_ctx.scratch_depth,
    next_loop: 0,
    next_temp: 0,
    break_label: undefined,
    break_value_type: undefined,
    continue_label: undefined,
  };
}

export function create_core_lifted_closure_body_ctx(
  input: CoreClosureLiftedBodyInput,
): CoreEmitCtx {
  return {
    locals: input.locals,
    statics: new Map(input.lift.statics),
    fn_types: new Map(input.lift.fn_types),
    static_capture_values: new Map(),
    text_locals: input.text_locals,
    struct_locals: input.struct_locals,
    union_locals: input.union_locals,
    frozen_locals: clone_optional_set(input.frozen_locals),
    materialized_bindings: clone_optional_set(input.materialized_bindings),
    host_imports: clone_core_host_imports(input.host_imports),
    text_layout: input.text_layout,
    closures: input.closures,
    heap: input.heap,
    scratch: input.scratch,
    allocation_permits: input.allocation_permits,
    scratch_loop_resets: [],
    scratch_return_resets: [],
    scratch_depth: 0,
    next_loop: 0,
    next_temp: 0,
    break_label: undefined,
    break_value_type: undefined,
    continue_label: undefined,
  };
}

export function create_core_rec_body_emit_ctx(ctx: CoreEmitCtx): CoreEmitCtx {
  return {
    locals: ctx.locals,
    statics: ctx.statics,
    fn_types: ctx.fn_types,
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    text_locals: ctx.text_locals,
    struct_locals: ctx.struct_locals,
    union_locals: ctx.union_locals,
    borrowed_locals: ctx.borrowed_locals,
    frozen_locals: ctx.frozen_locals,
    materialized_bindings: ctx.materialized_bindings,
    mutable_bindings: ctx.mutable_bindings,
    host_imports: clone_core_host_imports(ctx.host_imports),
    text_layout: ctx.text_layout,
    heap: ctx.heap,
    scratch: ctx.scratch,
    allocation_permits: ctx.allocation_permits,
    scratch_loop_resets: [...ctx.scratch_loop_resets],
    scratch_return_resets: [...ctx.scratch_return_resets],
    scratch_depth: ctx.scratch_depth,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
    break_label: ctx.break_label,
    break_value_type: ctx.break_value_type,
    continue_label: ctx.continue_label,
  };
}

export function create_core_branch_emit_ctx(ctx: CoreEmitCtx): CoreEmitCtx {
  return {
    locals: ctx.locals,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
    host_imports: clone_core_host_imports(ctx.host_imports),
    text_layout: ctx.text_layout,
    closures: ctx.closures,
    heap: ctx.heap,
    scratch: ctx.scratch,
    allocation_permits: ctx.allocation_permits,
    scratch_loop_resets: [...ctx.scratch_loop_resets],
    scratch_return_resets: [...ctx.scratch_return_resets],
    scratch_depth: ctx.scratch_depth,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
    break_label: ctx.break_label,
    break_value_type: ctx.break_value_type,
    continue_label: ctx.continue_label,
  };
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function clone_optional_map(
  value: Map<string, import("./ast.ts").CoreExpr> | undefined,
): Map<string, import("./ast.ts").CoreExpr> | undefined {
  if (!value) {
    return undefined;
  }

  return new Map(value);
}

export function create_core_runtime_union_match_branch_ctx(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: CoreEmitCtx,
): RuntimeUnionPayloadEmitBinding<CoreEmitCtx> {
  const branch_ctx = create_core_branch_emit_ctx(ctx);
  const fields = bind_runtime_union_match_payload_temps(
    value_name,
    info,
    branch_ctx,
  );

  return { ctx: branch_ctx, fields };
}
