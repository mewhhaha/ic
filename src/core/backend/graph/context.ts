import type { Core as CoreNode } from "../../ast.ts";
import {
  clone_core_host_imports,
  core_host_import_map,
} from "../../host_import.ts";
import type { CoreCtx } from "../../local_collect.ts";

export function create_empty_core_ctx(core: CoreNode | undefined): CoreCtx {
  let host_imports;

  if (core) {
    host_imports = core_host_import_map(core);
  }

  return {
    locals: new Map(),
    statics: new Map(),
    fn_types: new Map(),
    text_locals: new Set(),
    struct_locals: new Map(),
    union_locals: new Map(),
    frozen_locals: new Set(),
    host_imports,
    scratch_depth: 0,
    next_loop: 0,
    next_temp: 0,
  };
}

export function create_child_core_ctx(ctx: CoreCtx): CoreCtx {
  return {
    locals: new Map(ctx.locals),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
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
