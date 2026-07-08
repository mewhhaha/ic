import { expect } from "../expect.ts";
import type {
  DataSegment,
  Func,
  FuncImport,
  FuncType,
  Mod,
  Table,
} from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreFnType,
  CoreStmt,
} from "./ast.ts";
import {
  closure_heap_global,
  closure_table_name,
  type ClosureEmitCtx,
  create_closure_emit_ctx,
} from "./closure_emit.ts";
import { emit_named_rec_functions } from "./named_rec_emit.ts";
import type { CoreCtx } from "./local_collect.ts";
import type { RuntimeTextHeap } from "./runtime_text.ts";
import { type CoreScratchHeap, scratch_heap_global } from "./scratch.ts";
import type { TextLayout } from "./text_layout.ts";
import { core_host_func_imports } from "./host_import.ts";

export type CoreEmitArtifact = {
  body: Wat;
  result: ValType;
  data: DataSegment[];
  funcs: Func[];
  imports: FuncImport[];
  types: FuncType[];
  table: Table | undefined;
  heap_start: number;
  needs_heap: boolean;
  needs_scratch: boolean;
};

export type CoreArtifactEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
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
  ) => Func[];
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  stmt_result_type: (stmt: CoreStmt, ctx: CoreCtx) => ValType;
};

export function emit_core_artifact<ctx extends CoreArtifactEmitCtx>(
  core: CoreNode,
  hooks: CoreArtifactEmitHooks<ctx>,
): CoreEmitArtifact {
  const core_ctx = hooks.collect_core_ctx(core);
  const text_layout = hooks.build_text_layout(core, core_ctx);
  const closures = create_closure_emit_ctx();
  const heap: RuntimeTextHeap = { needed: false };
  const scratch: CoreScratchHeap = { needed: false };
  const ctx = hooks.create_emit_ctx({
    core_ctx,
    text_layout,
    closures,
    heap,
    scratch,
  });
  const lines: string[] = [];

  for (const [name, type] of core_ctx.locals) {
    lines.push("(local $" + name + " " + type + ")");
  }

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];
    expect(stmt, "Missing core statement " + index);
    const is_final = index + 1 >= core.statements.length;
    lines.push(hooks.emit_stmt(stmt, ctx, is_final));
  }

  const final_stmt = core.statements[core.statements.length - 1];
  expect(final_stmt, "Core program has no result statement");
  const funcs = hooks.emit_lifted_closure_funcs(
    text_layout,
    closures,
    heap,
    scratch,
  );

  // Named rec functions using real emit hooks + child ctx (per restructure)
  const namedRecFuncs = emit_named_rec_functions(core, ctx, {
    emit_stmt: hooks.emit_stmt,
    stmt_result_type: hooks.stmt_result_type,
    coreCtxForType: core_ctx,
  });
  for (const f of namedRecFuncs) {
    funcs.push(f);
  }

  let table: Table | undefined;

  if (closures.table_elements.length > 0) {
    table = {
      name: closure_table_name,
      elements: closures.table_elements,
    };
  }

  return {
    body: lines.join("\n"),
    result: hooks.stmt_result_type(final_stmt, core_ctx),
    data: text_layout.data,
    funcs,
    imports: core_host_func_imports(core),
    types: Array.from(closures.types.values()),
    table,
    heap_start: text_layout.heap_start,
    needs_heap: heap.needed || table !== undefined,
    needs_scratch: scratch.needed,
  };
}

export function core_data_segments<ctx extends CoreArtifactEmitCtx>(
  core: CoreNode,
  hooks: CoreArtifactEmitHooks<ctx>,
): DataSegment[] {
  const core_ctx = hooks.collect_core_ctx(core);
  return hooks.build_text_layout(core, core_ctx).data;
}

export function core_mod_from_artifact(
  artifact: CoreEmitArtifact,
  name = "main",
): Mod {
  const funcs: Record<string, Func> = {};
  const imports: Record<string, FuncImport> = {};

  for (const host_import of artifact.imports) {
    imports[host_import.name] = host_import;
  }

  for (const func of artifact.funcs) {
    funcs[func.name] = func;
  }

  funcs[name] = {
    name,
    result: artifact.result,
    body: artifact.body,
  };

  const mod: Mod = {
    imports,
    funcs,
    exports: [name],
  };

  if (artifact.imports.length === 0) {
    delete mod.imports;
  }

  if (artifact.types.length > 0) {
    mod.types = {};

    for (const type of artifact.types) {
      mod.types[type.name] = type;
    }
  }

  if (artifact.table) {
    mod.table = artifact.table;
  }

  if (
    artifact.data.length > 0 || artifact.table || artifact.needs_heap ||
    artifact.needs_scratch
  ) {
    let export_name: string | undefined;

    if (artifact.data.length > 0) {
      export_name = "memory";
    }

    mod.memory = {
      name: "memory",
      pages: 1,
      export_name,
    };
  }

  if (artifact.needs_heap) {
    mod.globals = {
      [closure_heap_global]: {
        name: closure_heap_global,
        type: "i32",
        mutable: true,
        value: artifact.heap_start,
      },
    };
  }

  if (artifact.needs_scratch) {
    if (!mod.globals) {
      mod.globals = {};
    }

    mod.globals[scratch_heap_global] = {
      name: scratch_heap_global,
      type: "i32",
      mutable: true,
      value: scratch_heap_start(artifact),
    };
  }

  if (artifact.data.length > 0) {
    mod.data = artifact.data;
  }

  return mod;
}

function scratch_heap_start(artifact: CoreEmitArtifact): number {
  if (!artifact.needs_heap) {
    return artifact.heap_start;
  }

  if (artifact.heap_start > 32768) {
    return artifact.heap_start;
  }

  return 32768;
}
