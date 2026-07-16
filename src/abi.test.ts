import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import {
  type AbiManifest,
  DuckAbiError,
  DuckHost,
  type DuckHostHandler,
  Source,
} from "./frontend.ts";
import { abi_fixed_array_schema_name, build_abi_manifest } from "./abi.ts";
import { Core } from "./core.ts";
import { resolve_bundled_source_imports } from "./frontend/load.ts";
import { elaborate_front_type_sets } from "./frontend/type_set_elaborate.ts";

Deno.test("managed ABI describes declared effects and opaque Init fields", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    declarations: [
      {
        tag: "effect",
        implementation: "host",
        name: "Io",
        params: [],
        operations: [{
          name: "print",
          params: [{ type_name: "Text", ownership: "bounded_borrow" }],
          result: { type_name: "Unit", ownership: "scalar" },
        }],
      },
      {
        tag: "record",
        name: "Init",
        fields: [{ name: "io", type_name: "Io" }],
      },
    ],
    statements: [],
  });

  assert_equals(manifest.init, {
    name: "Init",
    fields: [{
      name: "io",
      type: { tag: "resource", effect: "Io" },
      import: "__duck_init_io",
    }],
  });
  assert_equals(manifest.effects.Io.operations.print, {
    name: "print",
    import: "__duck_effect_Io_print",
    params: [{ type: { tag: "text" }, ownership: "bounded_borrow" }],
    result: { type: { tag: "unit" }, ownership: "scalar" },
  });
  assert_equals(manifest.imports.__duck_effect_Io_print.effect, {
    name: "Io",
    operation: "print",
    resource_param: 0,
  });
  assert_equals(manifest.imports.__duck_init_io, {
    name: "__duck_init_io",
    module: "duck_init",
    field: "io",
    params: [],
    result: {
      type: { tag: "resource", effect: "Io" },
      ownership: "scalar",
    },
    init: { field: "io", effect: "Io" },
  });
  assert_equals(manifest.requirements, { module: [], functions: {} });
});

Deno.test("managed ABI records inferred operation requirements", () => {
  const source = Source.parse(`
declare effect Io { read: () => Text }
let read_name = () => {
  name <- Io.read()
  name
}
read_name
`);
  const manifest = build_abi_manifest(source);

  assert_equals(manifest.requirements, {
    module: [],
    functions: {
      read_name: {
        effects: [{ effect: "Io", operation: "read" }],
      },
    },
  });
});

Deno.test("managed ABI uses inferred typed effect requirements", () => {
  const source = Source.parse(`
declare effect Io { read: () => Text }
let read_name: () -> <Io.read> Text = () => {
  name <- Io.read()
  name
}
read_name
`);
  const manifest = build_abi_manifest(source);

  assert_equals(manifest.requirements, {
    module: [],
    functions: {
      read_name: {
        effects: [{ effect: "Io", operation: "read" }],
      },
    },
  });
});

Deno.test("managed ABI excludes Duck effects and local handler requirements", () => {
  const source = Source.parse(`
declare effect Io { print: (&Text) => Unit }
effect Counter { get: () => I32 }

let run = () => {
  value <- Counter.get()
  value
}

let counter = () => Counter {
    get: (!resume) => {
      _ <- Io.print(&"get")
      !resume(0)
    },
    return: (value) => value
}

try run() with counter()
`);
  const manifest = build_abi_manifest(source);

  assert_equals(Object.keys(manifest.effects), ["Io"]);
  assert_equals(
    manifest.imports.__duck_effect_Counter_get,
    undefined,
  );
  assert_equals(manifest.requirements, {
    module: [{ effect: "Io", operation: "print" }],
    functions: {},
  });
});

Deno.test("managed ABI rejects Duck effects in Init", () => {
  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
effect Counter { get: () => I32 }
declare Init { counter: Counter }
return {}
`)),
    "Init field must name a declared effect: counter: Counter",
  );
});

Deno.test("managed ABI records the elaborated module result schema", () => {
  const original = Source.parse(`
module () where
return { .answer = 42 }
`);
  const compiled = elaborate_front_type_sets(resolve_bundled_source_imports(
    Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const duck_entry_result_type = struct { .answer= I32 }
return [.answer = 42] as duck_entry_result_type
`),
  ));
  const manifest = build_abi_manifest(original, compiled);

  assert_equals(manifest.entry, {
    params: [],
    result: {
      type: { tag: "named", name: "duck_entry_result_type" },
      ownership: "unique_heap",
    },
  });
  assert_equals(manifest.types.duck_entry_result_type, {
    tag: "struct",
    name: "duck_entry_result_type",
    schema_id: 1,
    size: 4,
    align: 4,
    fields: [{ name: "answer", type: { tag: "i32" }, offset: 0 }],
  });
});

Deno.test("managed ABI builds deterministic schemas for source fixed arrays", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    declarations: [
      {
        tag: "record",
        name: "pair",
        fields: [{ name: "values", type_name: "[I32; 2]" }],
      },
      {
        tag: "effect",
        implementation: "host",
        name: "Host",
        params: [],
        operations: [{
          name: "read",
          params: [],
          result: { type_name: "pair", ownership: "unique_heap" },
        }],
      },
    ],
    statements: [],
  });
  const array_name = abi_fixed_array_schema_name({ tag: "i32" }, 2);

  assert_equals(manifest.types[array_name], {
    tag: "array",
    name: array_name,
    schema_id: 1,
    element: { tag: "i32" },
    length: 2,
    stride: 4,
    size: 8,
    align: 4,
  });
  assert_equals(manifest.types.pair, {
    tag: "struct",
    name: "pair",
    schema_id: 2,
    size: 8,
    align: 4,
    fields: [{
      name: "values",
      type: { tag: "named", name: array_name },
      offset: 0,
    }],
  });
});

Deno.test("managed ABI records scalar F32 effect contracts", () => {
  const manifest = build_abi_manifest(Source.parse(`
declare effect FloatMath { scale: (F32) => F32 }
return {}
`));

  assert_equals(manifest.effects.FloatMath?.operations.scale, {
    name: "scale",
    import: "__duck_effect_FloatMath_scale",
    params: [{ type: { tag: "f32" }, ownership: "scalar" }],
    result: { type: { tag: "f32" }, ownership: "scalar" },
  });
});

async function wasm_from_wat(wat: string): Promise<Uint8Array> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(wat));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }

  return output.stdout;
}

function effect_manifest(result: "i32" | "text"): AbiManifest {
  let result_type: { tag: "i32" } | { tag: "text" } = { tag: "i32" };
  let result_ownership: "scalar" | "unique_heap" = "scalar";

  if (result === "text") {
    result_type = { tag: "text" };
    result_ownership = "unique_heap";
  }

  return {
    abi_name: "duck-js",
    abi_version: "duck-js-1",
    target: {
      profile: "core-3-nonweb",
      pointer: "wasm32",
      endianness: "little",
      i64_js: "bigint",
    },
    frame: { byte_size_offset: 0, schema_id_offset: 4, root_offset: 8 },
    types: {},
    imports: {
      __duck_effect_Io_read: {
        name: "__duck_effect_Io_read",
        module: "duck_effect",
        field: "Io.read",
        params: [{
          type: { tag: "resource", effect: "Io" },
          ownership: "scalar",
        }],
        result: { type: result_type, ownership: result_ownership },
        effect: { name: "Io", operation: "read", resource_param: 0 },
      },
    },
    effects: {
      Io: {
        name: "Io",
        operations: {
          read: {
            name: "read",
            import: "__duck_effect_Io_read",
            params: [],
            result: { type: result_type, ownership: result_ownership },
          },
        },
      },
    },
    requirements: { module: [], functions: {} },
    init: {
      name: "Init",
      fields: [{
        name: "io",
        type: { tag: "resource", effect: "Io" },
        import: "__duck_init_io",
      }],
    },
    entry: {
      params: [{ tag: "resource", effect: "Io" }],
      result: { type: result_type, ownership: result_ownership },
    },
    exports: {
      memory: "memory",
      alloc: "__duck_abi_alloc",
      free: "__duck_abi_free",
      main: "__duck_abi_main",
    },
  };
}

Deno.test("managed ABI rejects unsupported manifest versions", async () => {
  for (const abi_version of ["duck-js-2", "ix-js-1"]) {
    const unsupported_manifest = {
      ...effect_manifest("i32"),
      abi_version,
    } as unknown as AbiManifest;

    try {
      await DuckHost.instantiate(new Uint8Array(), unsupported_manifest);
      throw new Error("Expected ABI version rejection: " + abi_version);
    } catch (error) {
      if (!(error instanceof DuckAbiError)) {
        throw error;
      }

      assert_equals(error.code, "version_mismatch");
      assert_equals(error.path, "abi_version");
      assert_includes(error.message, "Expected duck-js-1");
    }
  }
});

Deno.test("managed ABI rejects a mismatched target profile", async () => {
  const browser_manifest = {
    ...effect_manifest("i32"),
    target: {
      ...effect_manifest("i32").target,
      profile: "core-3-browser",
    },
  } as unknown as AbiManifest;

  try {
    await DuckHost.instantiate(new Uint8Array(), browser_manifest);
    throw new Error("Expected target profile rejection");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "target_mismatch");
    assert_equals(error.path, "target.profile");
    assert_includes(error.message, "Expected core-3-nonweb");
  }
});

Deno.test("managed ABI rejects imports outside effects and Init", async () => {
  const manifest = effect_manifest("i32");
  manifest.imports.legacy = {
    name: "legacy",
    module: "env",
    field: "legacy",
    params: [],
    result: { type: { tag: "i32" }, ownership: "scalar" },
  };

  try {
    await DuckHost.instantiate(new Uint8Array(), manifest);
    throw new Error("Expected raw import rejection");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "invalid_manifest");
    assert_equals(error.path, "imports.legacy");
    assert_includes(error.message, "exactly one effect or Init field");
  }
});

function effect_wat(): string {
  return `(module
  (import "duck_effect" "Io.read"
    (func $__duck_effect_Io_read (param i32) (result i32)))
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))
  (global $free_count (export "free_count") (mut i32) (i32.const 0))
  (func (export "__duck_abi_alloc") (param $size i32) (param $align i32)
    (result i32)
    (local $ptr i32)
    global.get $heap
    local.tee $ptr
    local.get $size
    i32.add
    global.set $heap
    local.get $ptr)
  (func (export "__duck_abi_free") (param i32) (result i32)
    global.get $free_count
    i32.const 1
    i32.add
    global.set $free_count
    i32.const 0)
  (func (export "__duck_abi_main") (param $io i32) (result i32)
    local.get $io
    call $__duck_effect_Io_read)
  (func (export "probe") (param $io i32) (result i32)
    local.get $io
    call $__duck_effect_Io_read))`;
}

function state_manifest(): AbiManifest {
  const manifest = effect_manifest("i32");
  manifest.imports = {};
  manifest.effects = {};
  manifest.requirements = { module: [], functions: {} };
  manifest.init = undefined;
  manifest.entry = undefined;
  manifest.callables = {
    create: {
      name: "create",
      export: "__duck_abi_call_create",
      params: [{ type: { tag: "i32" }, ownership: "scalar" }],
      result: { type: { tag: "bytes" }, ownership: "move" },
    },
    step: {
      name: "step",
      export: "__duck_abi_call_step",
      params: [
        { type: { tag: "bytes" }, ownership: "move" },
        { type: { tag: "i32" }, ownership: "scalar" },
      ],
      result: { type: { tag: "bytes" }, ownership: "move" },
    },
    finish: {
      name: "finish",
      export: "__duck_abi_call_finish",
      params: [{ type: { tag: "bytes" }, ownership: "move" }],
      result: { type: { tag: "i32" }, ownership: "scalar" },
    },
    trap: {
      name: "trap",
      export: "__duck_abi_call_trap",
      params: [{ type: { tag: "bytes" }, ownership: "move" }],
      result: { type: { tag: "bytes" }, ownership: "move" },
    },
  };
  return manifest;
}

function state_wat(): string {
  return `(module
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))
  (global $free_count (export "free_count") (mut i32) (i32.const 0))
  (func (export "__duck_abi_alloc") (param $size i32) (param $align i32)
    (result i32)
    (local $ptr i32)
    global.get $heap
    local.tee $ptr
    local.get $size
    i32.add
    global.set $heap
    local.get $ptr)
  (func $__duck_abi_free_impl (param i32) (result i32)
    global.get $free_count
    i32.const 1
    i32.add
    global.set $free_count
    i32.const 0)
  (export "__duck_abi_free" (func $__duck_abi_free_impl))
  (func (export "__duck_abi_main") (result i32) i32.const 0)
  (func (export "__duck_abi_call_create") (param $initial i32) (result i32)
    (local $ptr i32)
    i32.const 5
    i32.const 8
    call 0
    local.tee $ptr
    i32.const 1
    i32.store
    local.get $ptr
    i32.const 4
    i32.add
    local.get $initial
    i32.store8
    local.get $ptr)
  (func (export "__duck_abi_call_step")
    (param $state i32) (param $delta i32) (result i32)
    local.get $state
    i32.const 4
    i32.add
    local.get $state
    i32.const 4
    i32.add
    i32.load8_u
    local.get $delta
    i32.add
    i32.store8
    local.get $state)
  (func (export "__duck_abi_call_finish") (param $state i32) (result i32)
    (local $value i32)
    local.get $state
    i32.const 4
    i32.add
    i32.load8_u
    local.set $value
    local.get $state
    call $__duck_abi_free_impl
    drop
    local.get $value)
  (func (export "__duck_abi_call_trap") (param i32) (result i32)
    unreachable))`;
}

Deno.test("managed callable state moves without structural JS copies", async () => {
  const wasm = await wasm_from_wat(state_wat());
  const host = await DuckHost.instantiate(wasm, state_manifest());
  const first = host.call("create", 7);
  const second = host.call("step", [first, 5]);

  assert_throws(
    () => host.call("step", [first, 1]),
    "State token is no longer live",
  );
  assert_equals(host.call("finish", second), 12);
  assert_throws(
    () => host.call("finish", second),
    "State token is no longer live",
  );
  assert_equals(
    (host.instance.exports.free_count as WebAssembly.Global).value,
    1,
  );
});

Deno.test("managed callable frees a fresh bootstrap value after a trap", async () => {
  const wasm = await wasm_from_wat(state_wat());
  const host = await DuckHost.instantiate(wasm, state_manifest());

  assert_throws(
    () => host.call("trap", new Uint8Array([7])),
    "unreachable",
  );
  assert_equals(
    (host.instance.exports.free_count as WebAssembly.Global).value,
    1,
  );
});

Deno.test("managed callable state frees a consumed token after a trap", async () => {
  const wasm = await wasm_from_wat(state_wat());
  const host = await DuckHost.instantiate(wasm, state_manifest());
  const state = host.call("create", 7);

  assert_throws(() => host.call("trap", state), "unreachable");
  assert_throws(
    () => host.call("finish", state),
    "State token is no longer live",
  );
  assert_equals(
    (host.instance.exports.free_count as WebAssembly.Global).value,
    1,
  );
});

Deno.test("managed callable tokens are instance-bound and disposable", async () => {
  const wasm = await wasm_from_wat(state_wat());
  const first_host = await DuckHost.instantiate(wasm, state_manifest());
  const second_host = await DuckHost.instantiate(wasm, state_manifest());
  const state = first_host.call("create", 9);

  if (
    typeof state !== "object" || state === null || !("dispose" in state) ||
    typeof state.dispose !== "function"
  ) {
    throw new Error("Managed create callable must return a state token");
  }
  const dispose = state.dispose;

  assert_throws(
    () => second_host.call("finish", state),
    "State token does not belong to this Duck host instance",
  );
  dispose();
  assert_throws(() => dispose(), "State token is no longer live");
  assert_equals(
    (first_host.instance.exports.free_count as WebAssembly.Global).value,
    1,
  );
});

Deno.test("source managed callables strip functions from main and move Bytes state", async () => {
  const artifact = Source.artifact(`
module () where

let step: Bytes -> Bytes = (state: Bytes) => state
let finish: Bytes -> I32 = (state: Bytes) => len(state)
return { .step = step, .finish = finish, .answer = 42 }
`);

  assert_equals(artifact.abi.callables, {
    step: {
      name: "step",
      export: "__duck_abi_call_step",
      params: [{ type: { tag: "bytes" }, ownership: "move" }],
      result: { type: { tag: "bytes" }, ownership: "move" },
    },
    finish: {
      name: "finish",
      export: "__duck_abi_call_finish",
      params: [{ type: { tag: "bytes" }, ownership: "move" }],
      result: { type: { tag: "i32" }, ownership: "scalar" },
    },
  });

  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  assert_equals(host.run(), [42]);
  const first = host.call("step", new Uint8Array([1, 2, 3]));
  const second = host.call("step", first);

  assert_throws(
    () => host.call("finish", first),
    "State token is no longer live",
  );
  assert_equals(host.call("finish", second), 3);
});

Deno.test("source managed callable trap releases a bootstrapped Bytes value", async () => {
  const artifact = Source.artifact(`
module () where

let fail: Bytes -> Bytes = (state: Bytes) => panic("fail")
return { .fail = fail }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const alloc = host.instance.exports.__duck_abi_alloc;
  const free = host.instance.exports.__duck_abi_free;

  if (typeof alloc !== "function" || typeof free !== "function") {
    throw new Error("Managed ABI allocator exports are missing");
  }

  const initial = alloc(7, 8);
  free(initial);
  const reusable = alloc(7, 8);
  free(reusable);
  assert_throws(
    () => host.call("fail", new Uint8Array([1, 2, 3])),
    "unreachable",
  );
  assert_equals(alloc(7, 8), reusable);
});

Deno.test("source managed product callables keep one source argument", async () => {
  const artifact = Source.artifact(`
module () where

let add: (I32, I32) -> I32 = (left, right) => left + right
const sum_to: I32 -> I32 = rec (value: I32) => {
  if value == 0 { 0 } else { value + rec(value - 1) }
}
return { .add = add, .sum_to = sum_to }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  assert_equals(host.call("add", [20, 22]), 42);
  assert_throws(
    () => host.call("add", 20, 22),
    "Managed callable expects one product source argument",
  );
  assert_equals(host.call("sum_to", 6), 21);
});

Deno.test("source managed callables expose F32 as a scalar", async () => {
  const artifact = Source.artifact(`
module () where

let add_half: F32 -> F32 = (value: F32) => value + 0.5f32
return { .add_half = add_half }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  assert_equals(artifact.abi.callables?.add_half?.params, [{
    type: { tag: "f32" },
    ownership: "scalar",
  }]);
  assert_equals(host.call("add_half", 1.25), 1.75);
});

Deno.test("source managed callables bootstrap named aggregate state", async () => {
  const artifact = Source.artifact(`
module () where

type State = [.count = I32]
let step: State -> State = (state: State) => state
let count: State -> I32 = (state: State) => state.count
return { .step = step, .count = count }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const state = host.call("step", [42]);

  assert_equals(host.call("count", state), 42);
});

Deno.test("source managed callable diagnostics reject unsafe contracts", () => {
  assert_throws(
    () =>
      Source.artifact(`
let step: &Bytes -> Bytes = (state: &Bytes) => state
return { .step = step }
`),
    "Managed callable cannot expose borrowed or frozen values",
  );
  assert_throws(
    () =>
      Source.artifact(`
let step: F32x4 -> F32x4 = (state: F32x4) => state
return { .step = step }
`),
    "Managed callable cannot expose F32x4",
  );
  assert_throws(
    () =>
      Source.artifact(`
let invoke: (I32 -> I32) -> I32 = callback => callback(0)
return { .invoke = invoke }
`),
    "Managed callable cannot expose function values",
  );
  assert_throws(
    () =>
      Source.artifact(`
let keep: Resume -> Resume = (value: Resume) => value
return { .keep = keep }
`),
    "Managed ABI cannot expose Resume values",
  );
  assert_throws(
    () =>
      Source.artifact(`
declare effect Io { read: () => I32 }
let read: () -> <Io.read> I32 = () => {
  value <- Io.read()
  value
}
return { .read = read }
`),
    "Managed callable exports cannot use effects yet: read",
  );
});

function fixed_array_effect_manifest(): {
  manifest: AbiManifest;
  root_array: string;
} {
  const i32_pair = abi_fixed_array_schema_name({ tag: "i32" }, 2);
  const root_array = abi_fixed_array_schema_name(
    { tag: "named", name: "row" },
    2,
  );

  return {
    root_array,
    manifest: {
      abi_name: "duck-js",
      abi_version: "duck-js-1",
      target: {
        profile: "core-3-nonweb",
        pointer: "wasm32",
        endianness: "little",
        i64_js: "bigint",
      },
      frame: { byte_size_offset: 0, schema_id_offset: 4, root_offset: 8 },
      types: {
        [i32_pair]: {
          tag: "array",
          name: i32_pair,
          schema_id: 1,
          element: { tag: "i32" },
          length: 2,
          stride: 4,
          size: 8,
          align: 4,
        },
        result: {
          tag: "union",
          name: "result",
          schema_id: 2,
          size: 8,
          align: 8,
          cases: [{ name: "ok", tag_value: 0, payload: { tag: "text" } }],
        },
        row: {
          tag: "struct",
          name: "row",
          schema_id: 3,
          size: 24,
          align: 8,
          fields: [
            { name: "count", type: { tag: "i64" }, offset: 0 },
            { name: "label", type: { tag: "text" }, offset: 8 },
            {
              name: "pair",
              type: { tag: "named", name: i32_pair },
              offset: 12,
            },
            {
              name: "outcome",
              type: { tag: "named", name: "result" },
              offset: 20,
            },
          ],
        },
        [root_array]: {
          tag: "array",
          name: root_array,
          schema_id: 4,
          element: { tag: "named", name: "row" },
          length: 2,
          stride: 24,
          size: 48,
          align: 8,
        },
      },
      imports: {
        __duck_effect_Host_read: {
          name: "__duck_effect_Host_read",
          module: "duck_effect",
          field: "Host.read",
          params: [{
            type: { tag: "resource", effect: "Host" },
            ownership: "scalar",
          }],
          result: {
            type: { tag: "named", name: root_array },
            ownership: "unique_heap",
          },
          effect: { name: "Host", operation: "read", resource_param: 0 },
        },
      },
      effects: {
        Host: {
          name: "Host",
          operations: {
            read: {
              name: "read",
              import: "__duck_effect_Host_read",
              params: [],
              result: {
                type: { tag: "named", name: root_array },
                ownership: "unique_heap",
              },
            },
          },
        },
      },
      requirements: { module: [], functions: {} },
      init: {
        name: "Init",
        fields: [{
          name: "host",
          type: { tag: "resource", effect: "Host" },
          import: "__duck_init_host",
        }],
      },
      entry: {
        params: [{ tag: "resource", effect: "Host" }],
        result: {
          type: { tag: "named", name: root_array },
          ownership: "unique_heap",
        },
      },
      exports: {
        memory: "memory",
        alloc: "__duck_abi_alloc",
        free: "__duck_abi_free",
        main: "__duck_abi_main",
      },
    },
  };
}

function fixed_array_effect_wat(): string {
  return `(module
  (import "duck_effect" "Host.read"
    (func $__duck_effect_Host_read (param i32) (result i32)))
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))
  (global $free_count (export "free_count") (mut i32) (i32.const 0))
  (func (export "__duck_abi_alloc") (param $size i32) (param i32) (result i32)
    (local $ptr i32)
    global.get $heap
    local.tee $ptr
    local.get $size
    i32.add
    global.set $heap
    local.get $ptr)
  (func (export "__duck_abi_free") (param i32) (result i32)
    global.get $free_count
    i32.const 1
    i32.add
    global.set $free_count
    i32.const 0)
  (func (export "__duck_abi_main") (param $host i32) (result i32)
    local.get $host
    call $__duck_effect_Host_read))`;
}

function getter_effect_manifest(): AbiManifest {
  const manifest = effect_manifest("i32");
  manifest.imports.__duck_init_io = {
    name: "__duck_init_io",
    module: "duck_init",
    field: "io",
    params: [],
    result: {
      type: { tag: "resource", effect: "Io" },
      ownership: "scalar",
    },
    init: { field: "io", effect: "Io" },
  };

  if (!manifest.entry) {
    throw new Error("Missing test entry manifest");
  }

  manifest.entry.params = [];
  return manifest;
}

function getter_effect_wat(): string {
  return `(module
  (import "duck_init" "io" (func $__duck_init_io (result i32)))
  (import "duck_effect" "Io.read"
    (func $__duck_effect_Io_read (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "__duck_abi_alloc") (param i32) (param i32) (result i32)
    i32.const 1024)
  (func (export "__duck_abi_free") (param i32) (result i32)
    i32.const 0)
  (func (export "__duck_abi_main") (result i32)
    call $__duck_init_io
    call $__duck_effect_Io_read))`;
}

Deno.test("managed ABI exposes Init resources through getter imports", async () => {
  const wasm = await wasm_from_wat(getter_effect_wat());
  const host = await DuckHost.instantiate(wasm, getter_effect_manifest());

  assert_equals(host.run({ io: { read: () => 73 } }), 73);
});

Deno.test("managed ABI registers Init effects only for one run", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await DuckHost.instantiate(wasm, effect_manifest("i32"));
  let calls = 0;

  assert_equals(
    host.run({
      io: {
        read() {
          calls += 1;
          return 41;
        },
      },
    }),
    41,
  );
  assert_equals(calls, 1);

  const probe = host.instance.exports.probe;

  if (typeof probe !== "function") {
    throw new Error("Missing probe export");
  }

  try {
    probe(1);
    throw new Error("Expected expired resource handle");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "unknown_resource");
  }
});

Deno.test("managed ABI validates required effect methods", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await DuckHost.instantiate(wasm, effect_manifest("i32"));

  try {
    host.run({ io: {} });
    throw new Error("Expected missing effect method");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "missing_method");
    assert_equals(error.path, "init.io.read");
  }
});

Deno.test("managed ABI rejects Promise effect results", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await DuckHost.instantiate(wasm, effect_manifest("i32"));
  const read = (() => Promise.resolve(1)) as unknown as DuckHostHandler;

  try {
    host.run({ io: { read } });
    throw new Error("Expected async handler rejection");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "async_handler");
    assert_equals(error.path, "__duck_effect_Io_read");
  }
});

Deno.test("managed ABI decodes rich effect entry results and frees them", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await DuckHost.instantiate(wasm, effect_manifest("text"));

  assert_equals(host.run({ io: { read: () => "hello 🦀" } }), "hello 🦀");

  const free_count = host.instance.exports.free_count;

  if (!(free_count instanceof WebAssembly.Global)) {
    throw new Error("Missing free counter export");
  }

  assert_equals(free_count.value, 1);
});

Deno.test("managed ABI round trips nested fixed arrays and frees owned children", async () => {
  const fixture = fixed_array_effect_manifest();
  const wasm = await wasm_from_wat(fixed_array_effect_wat());
  const host = await DuckHost.instantiate(wasm, fixture.manifest);

  const result = host.run({
    host: {
      read() {
        return [
          [21n, "first", [1, 2], { tag: "ok", value: "ready" }],
          [-9n, "second", [-3, 5], { tag: "ok", value: "done" }],
        ];
      },
    },
  });

  assert_equals(result, [
    [21n, "first", [1, 2], { tag: "ok", value: "ready" }],
    [-9n, "second", [-3, 5], { tag: "ok", value: "done" }],
  ]);
  const free_count = host.instance.exports.free_count;

  if (!(free_count instanceof WebAssembly.Global)) {
    throw new Error("Missing free counter export");
  }

  assert_equals(free_count.value, 7);
});

Deno.test("managed ABI requires exact fixed-array lengths", async () => {
  const fixture = fixed_array_effect_manifest();
  const wasm = await wasm_from_wat(fixed_array_effect_wat());
  const host = await DuckHost.instantiate(wasm, fixture.manifest);

  try {
    host.run({
      host: {
        read() {
          return [[
            1n,
            "only row",
            [1, 2],
            { tag: "ok", value: "nope" },
          ]];
        },
      },
    });
    throw new Error("Expected array length mismatch");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "array_length_mismatch");
    assert_equals(error.path, "__duck_effect_Host_read.result");
  }
});

Deno.test("managed ABI validates fixed-array structural schema names", async () => {
  const fixture = fixed_array_effect_manifest();
  const schema = fixture.manifest.types[fixture.root_array];

  if (!schema || schema.tag !== "array") {
    throw new Error("Missing root fixed-array schema");
  }

  schema.name = "incorrect_array_schema_name";

  try {
    await DuckHost.instantiate(new Uint8Array(), fixture.manifest);
    throw new Error("Expected array schema validation failure");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "invalid_manifest");
    assert_equals(error.path, "types." + fixture.root_array + ".name");
  }
});

Deno.test("managed ABI runs declared effects through Init end to end", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Io {
  read: () => Text
  print: (&Text) => Unit
}

declare Init { io: Io }

let greet = () => {
  name <- Io.read()
  _ <- Io.print(&name)
  name
}

result <- greet()
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  let printed = "";
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    io: {
      read() {
        return "Ada 🦀";
      },
      print(value) {
        if (typeof value !== "string") {
          throw new Error("Expected Text");
        }

        printed = value;
        return undefined;
      },
    },
  });

  assert_equals(result, ["Ada 🦀"]);
  assert_equals(printed, "Ada 🦀");
  assert_equals(artifact.abi.requirements, {
    module: [
      { effect: "Io", operation: "print" },
      { effect: "Io", operation: "read" },
    ],
    functions: {
      greet: {
        effects: [
          { effect: "Io", operation: "print" },
          { effect: "Io", operation: "read" },
        ],
      },
    },
  });
});

Deno.test("managed ABI runs an inferred anonymous effect callback", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Io { read: () => I32 }
declare Init { io: Io }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

let forward: (I32 -> <f> I32, I32) -> <f> I32 =
  (const callback, value) => {
    result <- apply(callback, value)
    result
  }

value <- forward(item => {
  input <- Io.read()
  input + item
}, 1)
let result: I32 = value
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  assert_equals(host.run({ io: { read: () => 41 } }), [42]);
  assert_equals(artifact.abi.requirements.functions.apply, undefined);
  assert_equals(artifact.abi.requirements.functions.forward, undefined);
});

Deno.test("Duck handlers can use rich host effects without exposing local effects", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Io {
  decorate: (&Text) => Text
}

effect Local {
  ask: () => Text
}

declare Init { io: Io }

let run = () => {
  value <- Local.ask()
  value
}

let make_local = () => Local {
  ask: (!resume) => {
    decorated <- Io.decorate(&"hello")
    !resume(decorated)
  },
  return: value => value,
}

result <- try run() with make_local()
return { .result = result }
`);
  assert_equals(Object.keys(artifact.abi.effects), ["Io"]);
  assert_equals(
    artifact.abi.imports.__duck_effect_Local_ask,
    undefined,
  );
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    io: {
      decorate(value) {
        if (typeof value !== "string") {
          throw new Error("Expected Text host argument");
        }

        return value + "!";
      },
    },
  });
  assert_equals(result, ["hello!"]);
});

Deno.test("managed ABI emits a versioned manifest and runtime exports", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Measure { text: (&Text) => I32 }
declare Init { measure: Measure }

result <- Measure.text(&"hello")
return { .result = result }
`);

  assert_equals(artifact.abi.abi_version, "duck-js-1");
  assert_equals(artifact.abi.target.profile, "core-3-nonweb");
  assert_equals(artifact.abi.imports.__duck_effect_Measure_text, {
    name: "__duck_effect_Measure_text",
    module: "duck_effect",
    field: "Measure.text",
    params: [
      { type: { tag: "resource", effect: "Measure" }, ownership: "scalar" },
      { type: { tag: "text" }, ownership: "bounded_borrow" },
    ],
    result: { type: { tag: "i32" }, ownership: "scalar" },
    effect: { name: "Measure", operation: "text", resource_param: 0 },
  });
  assert_includes(artifact.wat, '(export "memory" (memory $memory))');
  assert_includes(artifact.wat, '(export "__duck_abi_alloc"');
  assert_includes(artifact.wat, "memory.grow");
});

Deno.test("managed ABI decodes Text arguments for JS", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Measure { text: (&Text) => I32 }
declare Init { measure: Measure }

result <- Measure.text(&"Zażółć 🦀")
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  let received = "";
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    measure: {
      text(value) {
        if (typeof value !== "string") {
          throw new Error("Expected JS string");
        }

        received = value;
        return value.length;
      },
    },
  });

  assert_equals(result, ["Zażółć 🦀".length]);
  assert_equals(received, "Zażółć 🦀");
  host.dispose();
  assert_throws(() => host.run(), "disposed");
});

Deno.test("managed ABI encodes JS structs containing Text", async () => {
  const source = `
module (!init: Init) where

const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= Int }
declare effect Host { make_user: () => user_type }
declare Init { host: Host }

user <- Host.make_user()
let result: I32 = len(user.name) + user.age
return { .result = result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    host: {
      make_user() {
        return ["x".repeat(200_000), 36];
      },
    },
  });

  assert_equals(artifact.abi.types.user_type.tag, "struct");
  assert_equals(result, [200_036]);
});

Deno.test("managed ABI encodes tagged JS unions", async () => {
  const source = `
module (!init: Init) where

type ResultType = | .ok = Text | .err = Int
const result_type = ResultType
declare effect Host { make_result: () => result_type }
declare Init { host: Host }

outcome <- Host.make_result()
let result: I32 = if let .ok(value) = outcome { len(value) } else { 0 }
return { .result = result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    host: {
      make_result() {
        return { tag: "ok", value: "hello" };
      },
    },
  });

  assert_equals(result, [5]);
});

Deno.test("managed ABI drops discarded owned effect results", async () => {
  const source = `
module (!init: Init) where

type ResultType = | .chunk = Bytes | .eof
const result_type = ResultType
declare effect Host { read: () => result_type }
declare Init { host: Host }

_ <- Host.read()
return { .result = 1 }
`;
  const artifact = Source.artifact(source);
  const proof = Core.proof(Source.core(source));
  const discarded = proof.cleanup_rows.filter((row) => {
    return row.tag === "heap_drop" && row.edge === "discarded_expr";
  });
  assert_equals(discarded.length, 1);
  assert_includes(artifact.wat, "local.set $_cleanup_drop#0");
  assert_includes(artifact.wat, "call $__free");

  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    let reads = 0;
    const result = host.run({
      host: {
        read() {
          reads += 1;
          return { tag: "chunk", value: new Uint8Array([7, 0, 255]) };
        },
      },
    });

    assert_equals(result, [1]);
    assert_equals(reads, 1);
  } finally {
    host.dispose();
  }
});

Deno.test("managed ABI drops discarded scalar effect-function results", async () => {
  const source = `
module (!init: Init) where

declare effect Host { read: () => I32 }
declare Init { host: Host }

let read: () -> <Host.read> I32 = () => {
  value <- Host.read()
  value
}

_ <- read()
return { .result = 1 }
`;
  const artifact = Source.artifact(source);
  assert_includes(artifact.wat, "local.get $value\n    drop");

  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    let reads = 0;
    const result = host.run({
      host: {
        read() {
          reads += 1;
          return 99;
        },
      },
    });

    assert_equals(result, [1]);
    assert_equals(reads, 1);
  } finally {
    host.dispose();
  }
});

Deno.test("managed ABI encodes duck-js-1 named struct union payloads indirectly", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type User = [.age = I32, .score = I32]
type ReadResult = | .ok = User | .err

declare effect Host {
  read: () => ReadResult
}

declare Init { host: Host }

outcome <- Host.read()
let total: I32 = if let .ok(user) = outcome {
  user.age + user.score
} else {
  0
}
return { .total = total }
`);
  const read_result = artifact.abi.types.ReadResult;

  assert_equals(artifact.abi.abi_version, "duck-js-1");

  if (!read_result || read_result.tag !== "union") {
    throw new Error("Expected ReadResult ABI union");
  }

  assert_equals(read_result.cases, [
    {
      name: "ok",
      tag_value: 0,
      payload: { tag: "named", name: "User", indirect: true },
    },
    { name: "err", tag_value: 1, payload: { tag: "unit" } },
  ]);

  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    assert_equals(
      host.run({
        host: {
          read() {
            return { tag: "ok", value: [40, 2] };
          },
        },
      }),
      [42],
    );
  } finally {
    host.dispose();
  }
});

Deno.test("managed ABI round trips Bytes through a typed effect result", async () => {
  const source = `
module (!init: Init) where

type ReadResultType = | .chunk = Bytes | .eof | .err = Text
const read_result_type = ReadResultType

declare effect Host {
  read: () => read_result_type
  write: (&Bytes) => Unit
}

declare Init { host: Host }

outcome <- Host.read()
result <- if let .chunk(bytes) = outcome {
  _ <- Host.write(&bytes)
  len(bytes) + get(bytes, 0)
} else {
  0
}
let final_result: I32 = result
return { .result = final_result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const input = new Uint8Array([7, 0, 255]);
  let written: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    const result = host.run({
      host: {
        read() {
          return { tag: "chunk", value: input };
        },
        write(value) {
          if (!(value instanceof Uint8Array)) {
            throw new Error("Expected Bytes host argument");
          }

          written = value;
          return undefined;
        },
      },
    });

    assert_equals(result, [10]);
    assert_equals(Array.from(written), [7, 0, 255]);
    assert_equals(
      artifact.abi.effects.Host.operations.read.result,
      {
        type: { tag: "named", name: "read_result_type" },
        ownership: "unique_heap",
      },
    );
    assert_equals(
      artifact.abi.effects.Host.operations.write.params,
      [{ type: { tag: "bytes" }, ownership: "bounded_borrow" }],
    );
    const read_result = artifact.abi.types.read_result_type;
    assert_equals(read_result.tag, "union");

    if (read_result.tag !== "union") {
      throw new Error("Expected read_result_type union ABI");
    }

    assert_equals(read_result.cases[0]?.payload, { tag: "bytes" });
  } finally {
    host.dispose();
  }
});

Deno.test("managed ABI handles Bytes unions in effectful dynamic loops", async () => {
  const source = `
module (!init: Init) where

type ResultType = | .chunk = Bytes | .skip
const result_type = ResultType

declare effect Host {
  count: () => I32
  read: () => result_type
  write: (&Bytes) => Unit
}

declare Init { host: Host }

length <- Host.count()
for index in 0..length {
  outcome <- Host.read()
  if let .chunk(bytes) = outcome {
    let prefix = slice(bytes, 0, 1)
    let doubled = append(prefix, prefix)
    let marker: Text = append("loop", "!")
    freeze marker
    _ <- Host.write(&doubled)
  }
}

return { .result = length }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const input = new Uint8Array([7, 0, 255]);
  const written: number[][] = [];
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    const result = host.run({
      host: {
        count() {
          return 2;
        },
        read() {
          return { tag: "chunk", value: input };
        },
        write(value) {
          if (!(value instanceof Uint8Array)) {
            throw new Error("Expected Bytes host argument");
          }

          written.push(Array.from(value));
          return undefined;
        },
      },
    });

    assert_equals(result, [2]);
    assert_equals(written, [[7, 7], [7, 7]]);
  } finally {
    host.dispose();
  }
});

Deno.test("literal patterns compare runtime Text effect results", async () => {
  const source = `
module (!init: Init) where

declare effect Input {
  read: () => Text
}

declare Init { input: Input }

value <- Input.read()
let result = 0
if (let "ready" = value) {
  result = 42
}
return { .result = result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    const result = host.run({
      input: {
        read() {
          return "ready";
        },
      },
    });

    assert_equals(result, [42]);
  } finally {
    host.dispose();
  }
});

Deno.test("else-if expressions compose and select branch effects", async () => {
  const source = `
module (!init: Init) where

declare effect Input {
  choose: () => I32
  first: () => I32
  second: () => I32
}

declare Init { input: Input }

choice <- Input.choose()
result <- if choice == 1 {
  value <- Input.first()
  value
} else if choice == 2 {
  value <- Input.second()
  value
} else {
  0
}
return { .result = result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  let first_calls = 0;
  let second_calls = 0;

  try {
    const result = host.run({
      input: {
        choose() {
          return 2;
        },
        first() {
          first_calls += 1;
          return 1;
        },
        second() {
          second_calls += 1;
          return 42;
        },
      },
    });

    assert_equals(result, [42]);
    assert_equals(first_calls, 0);
    assert_equals(second_calls, 1);
  } finally {
    host.dispose();
  }
});

Deno.test("managed ABI grows memory for large host results", async () => {
  const source = `
module (!init: Init) where

declare effect Host { make_text: () => Text }
declare Init { host: Host }

text <- Host.make_text()
let result: I32 = len(text)
return { .result = result }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const text = "x".repeat(200_000);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    host: {
      make_text() {
        return text;
      },
    },
  });

  assert_equals(result, [200_000]);
  const memory = host.instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  assert_equals(memory.buffer.byteLength >= 200_000, true);
});

Deno.test("managed ABI reports missing effect methods with a stable error", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Host { read: () => I32 }
declare Init { host: Host }

result <- Host.read()
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    host.run({ host: {} });
    throw new Error("Expected DuckAbiError");
  } catch (error) {
    if (!(error instanceof DuckAbiError)) {
      throw error;
    }

    assert_equals(error.code, "missing_method");
    assert_equals(error.path, "init.host.read");
  }
});

Deno.test("managed ABI wires a narrowed multi-file effect module", async () => {
  const artifact = Source.artifact_file(
    "examples/effects/multi_file/main.duck",
    { host_interface: "examples/effects/multi_file/host.duck" },
  );
  const wasm = await wasm_from_wat(artifact.wat);
  const messages: string[] = [];
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    io: {
      print(value) {
        if (typeof value !== "string") {
          throw new Error("Expected effect Text argument");
        }

        messages.push(value);
        return undefined;
      },
    },
  });

  assert_equals(result, []);
  assert_equals(messages, ["hello from Duck"]);
  assert_equals(artifact.abi.requirements.module, [
    { effect: "Io", operation: "print" },
  ]);
});

Deno.test("effectful helper early return exits the helper, not the module", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type OpenResult = | .ok | .err = I32

declare effect Host {
  open: () => OpenResult
  touch: () => I32
}

declare Init { host: Host }

let check: () -> <Host.open | Host.touch> I32 = () => {
  opened <- Host.open()

  if let .err(code) = opened {
    return code
  }

  bump <- Host.touch()
  bump
}

result <- check()
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);

  const err_host = await DuckHost.instantiate(wasm, artifact.abi);
  let err_touches = 0;
  const err_result = err_host.run({
    host: {
      open() {
        return { tag: "err", value: 9 };
      },
      touch() {
        err_touches += 1;
        return 41;
      },
    },
  });
  assert_equals(err_result, [9]);
  assert_equals(err_touches, 0);

  const ok_host = await DuckHost.instantiate(wasm, artifact.abi);
  let ok_touches = 0;
  const ok_result = ok_host.run({
    host: {
      open() {
        return { tag: "ok" };
      },
      touch() {
        ok_touches += 1;
        return 41;
      },
    },
  });
  assert_equals(ok_result, [41]);
  assert_equals(ok_touches, 1);
});

Deno.test("effectful bracket closes after callback-local early return", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type OpenResult = | .ok | .err

declare effect FileReader {
  open: (&Text) => OpenResult
  read: () => I32
  close: () => Unit
}

declare Init { file_reader: FileReader }

let with_file: (Text, () -> <e> I32) -> <FileReader.open | FileReader.close | e> I32 =
  (path, const action) => {
    open_result <- FileReader.open(&path)

    match open_result {
      | .ok => {
        code <- action()
        _ <- FileReader.close()
        code
      }
      | .err => 2
    }
  }

raw_result <- with_file("input", () => {
  _ <- FileReader.read()
  return 42
})
let result: I32 = raw_result
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const events: string[] = [];
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    file_reader: {
      open() {
        events.push("open");
        return { tag: "ok" };
      },
      read() {
        events.push("read");
        return 41;
      },
      close() {
        events.push("close");
        return undefined;
      },
    },
  });

  assert_equals(result, [42]);
  assert_equals(events, ["open", "read", "close"]);

  const failed_events: string[] = [];
  const failed_host = await DuckHost.instantiate(wasm, artifact.abi);
  const failed_result = failed_host.run({
    file_reader: {
      open() {
        failed_events.push("open");
        return { tag: "err" };
      },
      read() {
        failed_events.push("read");
        return 0;
      },
      close() {
        failed_events.push("close");
        return undefined;
      },
    },
  });

  assert_equals(failed_result, [2]);
  assert_equals(failed_events, ["open"]);
});

Deno.test("Bytes.empty crosses a borrowed host boundary as an empty array", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Host { length: (&Bytes) => I32 }
declare Init { host: Host }

let bytes: Bytes = Bytes.empty
result <- Host.length(&bytes)
return { .result = result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const result = host.run({
    host: {
      length(value) {
        if (!(value instanceof Uint8Array)) {
          throw new Error("Expected Bytes host argument");
        }

        return value.length;
      },
    },
  });

  assert_equals(result, [0]);
});

Deno.test("const call conditions with effectful branches compile through loops and if let payloads", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type FetchResult = | .chunk = Bytes | .none

declare effect Host {
  fetch: () => FetchResult
  put: (&Bytes) => I32
}

declare Init { host: Host }

const has_bytes = (bytes: Bytes, limit: I32) => {
  let total = 0
  let byte_count = len(bytes)

  for index in 0..limit {
    if index < byte_count {
      total = total + 1
    }
  }

  total
}

fetched <- Host.fetch()
let hits = 0

if let .chunk(first_bytes) = fetched {
  let pending: Bytes = first_bytes
  let flag = 1
  loop_total <- loop {
    if flag == 1 && has_bytes(pending, 2) > 0 {
      let line: Bytes = slice(pending, 0, 1)
      wrote <- Host.put(&line)
      hits = hits + wrote
    }

    break hits
  }

  hits = loop_total
  ()
} else {
  hits = 0
  ()
}

return { .hits = hits }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await DuckHost.instantiate(wasm, artifact.abi);
  const written: number[] = [];
  const result = host.run({
    host: {
      fetch() {
        return { tag: "chunk", value: new Uint8Array([7, 8, 9]) };
      },
      put(value) {
        if (!(value instanceof Uint8Array)) {
          throw new Error("Expected effect Bytes argument");
        }

        written.push(value.length);
        return 5;
      },
    },
  });

  assert_equals(result, [5]);
  assert_equals(written, [1]);
});
