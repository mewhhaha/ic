import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import {
  type AbiManifest,
  IxAbiError,
  IxHost,
  type IxHostHandler,
  Source,
} from "./frontend.ts";
import { build_abi_manifest } from "./abi.ts";

Deno.test("managed ABI describes declared effects and opaque Init fields", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    declarations: [
      {
        tag: "effect",
        implementation: "host",
        name: "Io",
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
      import: "__ix_init_io",
    }],
  });
  assert_equals(manifest.effects.Io.operations.print, {
    name: "print",
    import: "__ix_effect_Io_print",
    params: [{ type: { tag: "text" }, ownership: "bounded_borrow" }],
    result: { type: { tag: "unit" }, ownership: "scalar" },
  });
  assert_equals(manifest.imports.__ix_effect_Io_print.effect, {
    name: "Io",
    operation: "print",
    resource_param: 0,
  });
  assert_equals(manifest.imports.__ix_init_io, {
    name: "__ix_init_io",
    module: "ix_init",
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
let Fx read_name = () => {
  let (!Fx, name) = Fx.read()
  name
}
read_name
`);
  const manifest = build_abi_manifest(source);

  assert_equals(manifest.requirements, {
    module: [],
    functions: {
      read_name: {
        context: "Fx",
        effects: [{ effect: "Io", operation: "read" }],
      },
    },
  });
});

Deno.test("managed ABI excludes Ix effects and local handler requirements", () => {
  const source = Source.parse(`
declare effect Io { print: (bounded_borrow Text) => Unit }
effect Counter { get: () => I32 }

let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  value
}

let (Fx :: { Io.print }) counter = () => Counter {
    get: (!resume) => {
      let (!Fx, ()) = Fx.Io.print(borrow "get")
      !resume(0)
    },
    return: (value) => value
}

try run() with counter()
`);
  const manifest = build_abi_manifest(source);

  assert_equals(Object.keys(manifest.effects), ["Io"]);
  assert_equals(
    manifest.imports.__ix_effect_Counter_get,
    undefined,
  );
  assert_equals(manifest.requirements, {
    module: [{ effect: "Io", operation: "print" }],
    functions: {},
  });
});

Deno.test("managed ABI rejects Ix effects in Init", () => {
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
return { answer: 42 }
`);
  const compiled = Source.parse(`
const ix_entry_result_type = struct { answer: I32 }
return ix_entry_result_type { answer: 42 }
`);
  const manifest = build_abi_manifest(original, compiled);

  assert_equals(manifest.entry, {
    params: [],
    result: {
      type: { tag: "named", name: "ix_entry_result_type" },
      ownership: "unique_heap",
    },
  });
  assert_equals(manifest.types.ix_entry_result_type, {
    tag: "struct",
    name: "ix_entry_result_type",
    schema_id: 1,
    size: 4,
    align: 4,
    fields: [{ name: "answer", type: { tag: "i32" }, offset: 0 }],
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
    abi_name: "ix-js",
    abi_version: "ix-js-1",
    target: {
      profile: "core-3-browser",
      pointer: "wasm32",
      endianness: "little",
      i64_js: "bigint",
    },
    frame: { byte_size_offset: 0, schema_id_offset: 4, root_offset: 8 },
    types: {},
    imports: {
      __ix_effect_Io_read: {
        name: "__ix_effect_Io_read",
        module: "ix_effect",
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
            import: "__ix_effect_Io_read",
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
        import: "__ix_init_io",
      }],
    },
    entry: {
      params: [{ tag: "resource", effect: "Io" }],
      result: { type: result_type, ownership: result_ownership },
    },
    exports: {
      memory: "memory",
      alloc: "__ix_abi_alloc",
      free: "__ix_abi_free",
      main: "__ix_abi_main",
    },
  };
}

function effect_wat(): string {
  return `(module
  (import "ix_effect" "Io.read"
    (func $__ix_effect_Io_read (param i32) (result i32)))
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))
  (global $free_count (export "free_count") (mut i32) (i32.const 0))
  (func (export "__ix_abi_alloc") (param $size i32) (param $align i32)
    (result i32)
    (local $ptr i32)
    global.get $heap
    local.tee $ptr
    local.get $size
    i32.add
    global.set $heap
    local.get $ptr)
  (func (export "__ix_abi_free") (param i32) (result i32)
    global.get $free_count
    i32.const 1
    i32.add
    global.set $free_count
    i32.const 0)
  (func (export "__ix_abi_main") (param $io i32) (result i32)
    local.get $io
    call $__ix_effect_Io_read)
  (func (export "probe") (param $io i32) (result i32)
    local.get $io
    call $__ix_effect_Io_read))`;
}

function getter_effect_manifest(): AbiManifest {
  const manifest = effect_manifest("i32");
  manifest.imports.__ix_init_io = {
    name: "__ix_init_io",
    module: "ix_init",
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
  (import "ix_init" "io" (func $__ix_init_io (result i32)))
  (import "ix_effect" "Io.read"
    (func $__ix_effect_Io_read (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "__ix_abi_alloc") (param i32) (param i32) (result i32)
    i32.const 1024)
  (func (export "__ix_abi_free") (param i32) (result i32)
    i32.const 0)
  (func (export "__ix_abi_main") (result i32)
    call $__ix_init_io
    call $__ix_effect_Io_read))`;
}

Deno.test("managed ABI exposes Init resources through getter imports", async () => {
  const wasm = await wasm_from_wat(getter_effect_wat());
  const host = await IxHost.instantiate(wasm, getter_effect_manifest());

  assert_equals(host.run({ io: { read: () => 73 } }), 73);
});

Deno.test("managed ABI registers Init effects only for one run", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await IxHost.instantiate(wasm, effect_manifest("i32"));
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
    if (!(error instanceof IxAbiError)) {
      throw error;
    }

    assert_equals(error.code, "unknown_resource");
  }
});

Deno.test("managed ABI validates required effect methods", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await IxHost.instantiate(wasm, effect_manifest("i32"));

  try {
    host.run({ io: {} });
    throw new Error("Expected missing effect method");
  } catch (error) {
    if (!(error instanceof IxAbiError)) {
      throw error;
    }

    assert_equals(error.code, "missing_method");
    assert_equals(error.path, "init.io.read");
  }
});

Deno.test("managed ABI rejects Promise effect results", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await IxHost.instantiate(wasm, effect_manifest("i32"));
  const read = (() => Promise.resolve(1)) as unknown as IxHostHandler;

  try {
    host.run({ io: { read } });
    throw new Error("Expected async handler rejection");
  } catch (error) {
    if (!(error instanceof IxAbiError)) {
      throw error;
    }

    assert_equals(error.code, "async_handler");
    assert_equals(error.path, "__ix_effect_Io_read");
  }
});

Deno.test("managed ABI decodes rich effect entry results and frees them", async () => {
  const wasm = await wasm_from_wat(effect_wat());
  const host = await IxHost.instantiate(wasm, effect_manifest("text"));

  assert_equals(host.run({ io: { read: () => "hello 🦀" } }), "hello 🦀");

  const free_count = host.instance.exports.free_count;

  if (!(free_count instanceof WebAssembly.Global)) {
    throw new Error("Missing free counter export");
  }

  assert_equals(free_count.value, 1);
});

Deno.test("managed ABI runs declared effects through Init end to end", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Io {
  read: () => Text
  print: (bounded_borrow Text) => Unit
}

declare Init { io: Io }

let Fx greet = () => {
  let (!Fx, name) = Fx.read()
  let (!Fx, ()) = Fx.print(borrow name)
  name
}

let result = greet()
return { result }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  let printed = "";
  const host = await IxHost.instantiate(wasm, artifact.abi);
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

  assert_equals(result, { result: "Ada 🦀" });
  assert_equals(printed, "Ada 🦀");
  assert_equals(artifact.abi.requirements, {
    module: [
      { effect: "Io", operation: "print" },
      { effect: "Io", operation: "read" },
    ],
    functions: {
      greet: {
        context: "Fx",
        effects: [
          { effect: "Io", operation: "print" },
          { effect: "Io", operation: "read" },
        ],
      },
    },
  });
});

Deno.test("Ix handlers can use rich host effects without exposing local effects", async () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Io {
  decorate: (bounded_borrow Text) => Text
}

effect Local {
  ask: () => Text
}

declare Init { io: Io }

let Fx run = () => {
  let (!Fx, value) = Fx.Local.ask()
  value
}

let (Fx :: { Io.decorate }) make_local = () => Local {
  ask: (!resume) => {
    let (!Fx, decorated) = Fx.Io.decorate(borrow "hello")
    !resume(decorated)
  },
  return: value => value,
}

let result: Text = try run() with make_local()
return { result }
`);
  assert_equals(Object.keys(artifact.abi.effects), ["Io"]);
  assert_equals(
    artifact.abi.imports.__ix_effect_Local_ask,
    undefined,
  );
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await IxHost.instantiate(wasm, artifact.abi);
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
  assert_equals(result, { result: "hello!" });
});

Deno.test("managed ABI emits a versioned manifest and runtime exports", () => {
  const artifact = Source.artifact(`
host_import measure from "env.measure" (bounded_borrow Text) => I32
measure(borrow "hello")
`);

  assert_equals(artifact.abi.abi_version, "ix-js-1");
  assert_equals(artifact.abi.target.profile, "core-3-browser");
  assert_equals(artifact.abi.imports.measure, {
    name: "measure",
    module: "env",
    field: "measure",
    params: [{ type: { tag: "text" }, ownership: "bounded_borrow" }],
    result: { type: { tag: "i32" }, ownership: "scalar" },
  });
  assert_includes(artifact.wat, '(export "memory" (memory $memory))');
  assert_includes(artifact.wat, '(export "__ix_abi_alloc"');
  assert_includes(artifact.wat, "memory.grow");
});

Deno.test("managed ABI decodes Text arguments for JS", async () => {
  const artifact = Source.artifact(`
host_import measure from "env.measure" (bounded_borrow Text) => I32
measure(borrow "Zażółć 🦀")
`);
  const wasm = await wasm_from_wat(artifact.wat);
  let received = "";
  const host = await IxHost.instantiate(wasm, artifact.abi, {
    env: {
      measure(value) {
        if (typeof value !== "string") {
          throw new Error("Expected JS string");
        }

        received = value;
        return value.length;
      },
    },
  });

  assert_equals(host.run(), "Zażółć 🦀".length);
  assert_equals(received, "Zażółć 🦀");
  host.dispose();
  assert_throws(() => host.run(), "disposed");
});

Deno.test("managed ABI encodes JS structs containing Text", async () => {
  const source = `
const user_type = struct { name: Text, age: Int }
host_import make_user from "env.make_user" () => unique_heap user_type
let user: user_type = make_user()
len(user.name) + user.age
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await IxHost.instantiate(wasm, artifact.abi, {
    env: {
      make_user() {
        return { name: "x".repeat(200_000), age: 36 };
      },
    },
  });

  assert_equals(artifact.abi.types.user_type.tag, "struct");
  assert_equals(host.run(), 200_036);
});

Deno.test("managed ABI encodes tagged JS unions", async () => {
  const source = `
const result_type = union { ok: Text, err: Int }
host_import make_result from "env.make_result" () => unique_heap result_type
let result: result_type = make_result()
if let .ok(value) = result { len(value) } else { 0 }
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const host = await IxHost.instantiate(wasm, artifact.abi, {
    env: {
      make_result() {
        return { tag: "ok", value: "hello" };
      },
    },
  });

  assert_equals(host.run(), 5);
});

Deno.test("managed ABI grows memory for large host results", async () => {
  const source = `
host_import make_text from "env.make_text" () => unique_heap Text
len(make_text())
`;
  const artifact = Source.artifact(source);
  const wasm = await wasm_from_wat(artifact.wat);
  const text = "x".repeat(200_000);
  const host = await IxHost.instantiate(wasm, artifact.abi, {
    env: {
      make_text() {
        return text;
      },
    },
  });

  assert_equals(host.run(), 200_000);
  const memory = host.instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  assert_equals(memory.buffer.byteLength >= 200_000, true);
});

Deno.test("managed ABI reports missing handlers with a stable error", async () => {
  const artifact = Source.artifact(`
host_import read from "env.read" () => I32
read()
`);
  const wasm = await wasm_from_wat(artifact.wat);

  try {
    await IxHost.instantiate(wasm, artifact.abi, {});
    throw new Error("Expected IxAbiError");
  } catch (error) {
    if (!(error instanceof IxAbiError)) {
      throw error;
    }

    assert_equals(error.code, "missing_handler");
    assert_equals(error.path, "env.read");
  }
});

Deno.test("managed ABI wires a narrowed multi-file effect module", async () => {
  const artifact = Source.artifact_file(
    "examples/effects/multi_file/main.ix",
    { host_interface: "examples/effects/multi_file/host.ix" },
  );
  const wasm = await wasm_from_wat(artifact.wat);
  const messages: string[] = [];
  const host = await IxHost.instantiate(wasm, artifact.abi);
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

  assert_equals(result, {});
  assert_equals(messages, ["hello from Ix"]);
  assert_equals(artifact.abi.requirements.module, [
    { effect: "Io", operation: "print" },
  ]);
});
