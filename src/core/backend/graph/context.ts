import type { Core as CoreNode } from "../../ast.ts";
import {
  clone_core_host_imports,
  core_host_import_map,
} from "../../host_import.ts";
import type { CoreCtx } from "../../local_collect.ts";
import {
  core_materialized_bindings,
  core_mutable_bindings,
} from "../../mutable_bindings.ts";

export function create_empty_core_ctx(core: CoreNode | undefined): CoreCtx {
  let host_imports;
  let materialized_bindings;
  let mutable_bindings;

  if (core) {
    host_imports = core_host_import_map(core);
    materialized_bindings = core_materialized_bindings(core);
    mutable_bindings = core_mutable_bindings(core);
  }

  return {
    locals: new Map(),
    static_capture_values: new Map(),
    statics: new Map(),
    fn_types: new Map(),
    text_locals: new Set(),
    struct_locals: new Map(),
    union_locals: new Map(),
    borrowed_locals: new Set(),
    frozen_locals: new Set(),
    host_imports,
    scratch_depth: 0,
    materialized_bindings,
    mutable_bindings,
    next_loop: 0,
    next_temp: 0,
  };
}

export function create_child_core_ctx(ctx: CoreCtx): CoreCtx {
  return {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
  };
}

export function create_scratch_core_ctx(ctx: CoreCtx): CoreCtx {
  const scratch_ctx = create_child_core_ctx(ctx);
  const scratch_depth = scratch_ctx.scratch_depth;
  if (scratch_depth === undefined) {
    scratch_ctx.scratch_depth = 1;
  } else {
    scratch_ctx.scratch_depth = scratch_depth + 1;
  }
  return scratch_ctx;
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function clone_optional_map<key, value>(
  value: Map<key, value> | undefined,
): Map<key, value> | undefined {
  if (!value) {
    return undefined;
  }

  return new Map(value);
}
