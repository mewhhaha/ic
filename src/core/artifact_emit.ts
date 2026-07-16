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
import type { Core as CoreNode } from "./ast.ts";
import {
  closure_heap_global,
  closure_table_name,
  create_closure_emit_ctx,
} from "./closure_emit.ts";
import { emit_named_rec_functions } from "./named_rec_emit.ts";
import type { RuntimeTextHeap } from "./runtime_text.ts";
import { type CoreScratchHeap, scratch_heap_global } from "./scratch.ts";
import {
  allocator_free_head,
  runtime_allocator_funcs,
} from "./runtime_allocator.ts";
import { core_host_func_imports } from "./host_import.ts";
import {
  check_core_allocation_permits,
  create_core_allocation_permit_state,
} from "./allocation_emission.ts";
import type {
  CoreArtifactEmitCtx,
  CoreArtifactEmitHooks,
} from "./artifact_emit_contract.ts";

export type {
  CoreArtifactEmitCtx,
  CoreArtifactEmitHooks,
  CoreArtifactEmitInput,
} from "./artifact_emit_contract.ts";

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

export function emit_core_artifact<ctx extends CoreArtifactEmitCtx>(
  core: CoreNode,
  hooks: CoreArtifactEmitHooks<ctx>,
): CoreEmitArtifact {
  const allocation_permit_plan = core.allocation_permit_plan;
  expect(
    allocation_permit_plan,
    "Core emission requires an accepted allocation permit plan",
  );
  const allocation_permits = create_core_allocation_permit_state(
    allocation_permit_plan,
  );
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
    allocation_permits,
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
    allocation_permits,
  );
  const named_rec_funcs = emit_named_rec_functions(
    core,
    { text_layout, closures, heap, scratch, allocation_permits },
    {
      collect_core_ctx: hooks.collect_core_ctx,
      create_emit_ctx: hooks.create_emit_ctx,
      emit_stmt: hooks.emit_stmt,
      stmt_result_type: hooks.stmt_result_type,
    },
  );

  for (const func of named_rec_funcs) {
    funcs.push(func);
  }

  check_core_allocation_permits(allocation_permits);

  let table: Table | undefined;

  if (closures.table_elements.length > 0) {
    table = {
      name: closure_table_name,
      elements: closures.table_elements,
    };
  }

  const body = lines.join("\n");

  return {
    body,
    result: hooks.stmt_result_type(final_stmt, core_ctx),
    data: text_layout.data,
    funcs,
    imports: core_host_func_imports(core),
    types: Array.from(closures.types.values()),
    table,
    heap_start: text_layout.heap_start,
    needs_heap: heap.needed || table !== undefined ||
      body.includes("call $__free"),
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

  if (artifact.needs_heap) {
    Object.assign(funcs, runtime_allocator_funcs());
  }

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
    mod.memory = {
      name: "memory",
      pages: 1,
      export_name: "memory",
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
      [allocator_free_head]: {
        name: allocator_free_head,
        type: "i32",
        mutable: true,
        value: 0,
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
