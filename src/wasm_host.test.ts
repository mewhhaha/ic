import { Core, type Core as CoreNode } from "./core.ts";
import { TestSource as Source } from "./frontend/test_source.ts";
import { Mod } from "./mod.ts";
import { Emit } from "./trait.ts";
import {
  decoder,
  instantiate_wat,
  wat_from_core_source,
} from "./wasm_test_util.ts";

Deno.test("module imports compile through WAT to Wasm", async () => {
  const mod: Mod = {
    imports: {
      host_add: {
        name: "host_add",
        module: "env",
        field: "add",
        params: ["i32", "i32"],
        result: "i32",
      },
    },
    funcs: {
      main: {
        name: "main",
        result: "i32",
        body: "i32.const 20\ni32.const 22\ncall $host_add",
      },
    },
    exports: ["main"],
  };
  const instance = await instantiate_wat(Emit.emit(Mod, mod), "import", {
    env: {
      add(left: number, right: number): number {
        return left + right;
      },
    },
  });

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected main() -> 42, got " + result);
  }
});

Deno.test("frontend host import contracts compile through WAT to Wasm", async () => {
  const wat = Source.wat(`
host_import host_read from "env.read" (&Text) => I32

let message: Text = @append("he", "llo")
host_read(&message)
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_host_import_contracts",
    {
      env: {
        read(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero text pointer");
          }

          return 35;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 35) {
    throw new Error("Expected main() -> 35, got " + result);
  }
});

Deno.test("frontend host capability method compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
io = io.print("hello")
io
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_host_capability_method",
    {
      env: {
        print(token: number, ptr: number): number {
          if (ptr < 0) {
            throw new Error("expected text pointer");
          }

          return token + 41;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected main() -> 42, got " + result);
  }
});

Deno.test("frontend narrowed capability method table compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32
host_import read from "env.read" (I32) => I32

const output = [.print = print]
let !io: I32 = 1
io = output.print(!io, "hello")
io
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_narrowed_capability_method_table",
    {
      env: {
        print(token: number, ptr: number): number {
          if (ptr < 0) {
            throw new Error("expected text pointer");
          }

          return token + 41;
        },
        read(token: number): number {
          return token + 1000;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected narrowed capability main() -> 42, got " + result);
  }
});

Deno.test("frontend runtime capability table compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import consume from "env.consume" (Text) => I32
let flag = 1
let output = if flag {
  [.marker = @runtime_i32_slice(1, 7), .consume = consume]
} else {
  [.marker = @runtime_i32_slice(1, 8), .consume = consume]
}
output.consume(@append("A", "da"))
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_runtime_capability_table",
    {
      env: {
        consume(ptr: number): number {
          return new DataView(memory.buffer).getUint32(ptr, true);
        },
      },
    },
  );
  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a memory");
  }
  const memory = instance.exports.memory;
  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }
  const result = instance.exports.main();
  if (result !== 3) {
    throw new Error("Expected runtime capability main() -> 3, got " + result);
  }
});

Deno.test(
  "frontend captured linear capability closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let print_once = () => io.print("hello")
io = print_once()
io
`);
    let calls = 0;
    const instance = await instantiate_wat(
      wat,
      "frontend_captured_linear_capability_closure",
      {
        env: {
          print(token: number, ptr: number): number {
            if (ptr < 0) {
              throw new Error("expected text pointer");
            }

            calls = calls + 1;
            return token + 41;
          },
        },
      },
    );

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== 42) {
      throw new Error("Expected main() -> 42, got " + result);
    }

    if (calls !== 1) {
      throw new Error("Expected one host print call");
    }
  },
);

Deno.test(
  "frontend branch-selected linear capability closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  () => io.print("hello")
} else {
  () => io.print("world")
}
io = print_once()
io
`);
    let calls = 0;
    let printed = "";
    // Initialized after instantiation; host callbacks close over this binding.
    // deno-lint-ignore prefer-const
    let memory: WebAssembly.Memory | undefined;
    const instance = await instantiate_wat(
      wat,
      "frontend_branch_selected_linear_capability_closure",
      {
        env: {
          print(token: number, ptr: number): number {
            if (ptr < 0) {
              throw new Error("expected text pointer");
            }

            if (!memory) {
              throw new Error("memory export is not available");
            }

            const view = new DataView(memory.buffer);
            const length = view.getUint32(ptr, true);
            const bytes = new Uint8Array(memory.buffer, ptr + 4, length);
            printed = decoder.decode(bytes);
            calls = calls + 1;
            return token + 41;
          },
        },
      },
    );

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    if (!("memory" in instance.exports)) {
      throw new Error("Missing memory export");
    }

    if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
      throw new Error("memory export is not a WebAssembly.Memory");
    }

    memory = instance.exports.memory;
    const result = instance.exports.main();

    if (result !== 42) {
      throw new Error("Expected main() -> 42, got " + result);
    }

    if (calls !== 1) {
      throw new Error("Expected one host print call");
    }

    if (printed !== "world") {
      throw new Error("Expected selected branch to print world");
    }
  },
);

Deno.test(
  "frontend first-class linear capability closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32

const main = (!io: I32) => {
  let print_once = () => io.print("hello")
  io = print_once()
  io
}

let flag = 1
let run = if flag { main } else { main }
let !io: I32 = 1
io = run(!io)
io
`);
    let calls = 0;
    const instance = await instantiate_wat(
      wat,
      "frontend_first_class_linear_capability_closure",
      {
        env: {
          print(token: number, ptr: number): number {
            if (ptr < 0) {
              throw new Error("expected text pointer");
            }

            calls = calls + 1;
            return token + 41;
          },
        },
      },
    );

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== 42) {
      throw new Error("Expected main() -> 42, got " + result);
    }

    if (calls !== 1) {
      throw new Error("Expected one host print call");
    }
  },
);

Deno.test("core bounded-borrow host import compiles through WAT to Wasm", async () => {
  const core: CoreNode = {
    tag: "program",
    host_imports: {
      host_read: {
        name: "host_read",
        module: "env",
        field: "read",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "bounded_borrow" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "@append" },
          args: [
            { tag: "text", value: "he" },
            { tag: "text", value: "llo" },
          ],
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_read" },
          args: [
            {
              tag: "borrow",
              value: { tag: "var", name: "message" },
            },
          ],
        },
      },
    ],
  };
  const instance = await instantiate_wat(
    Emit.emit(Mod, Core.mod(core)),
    "core_bounded_borrow_import",
    {
      env: {
        read(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero text pointer");
          }

          return 37;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 37) {
    throw new Error("Expected main() -> 37, got " + result);
  }
});

Deno.test("core scratch bounded-borrow host import compiles through WAT to Wasm", async () => {
  const core: CoreNode = {
    tag: "program",
    host_imports: {
      host_read: {
        name: "host_read",
        module: "env",
        field: "read",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "bounded_borrow" }],
      },
    },
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "scratch",
          body: {
            tag: "block",
            statements: [
              {
                tag: "bind",
                kind: "let",
                name: "message",
                is_linear: false,
                annotation: "Text",
                value: {
                  tag: "app",
                  func: { tag: "var", name: "@append" },
                  args: [
                    { tag: "text", value: "he" },
                    { tag: "text", value: "llo" },
                  ],
                },
              },
              {
                tag: "expr",
                expr: {
                  tag: "app",
                  func: { tag: "var", name: "host_read" },
                  args: [
                    {
                      tag: "borrow",
                      value: { tag: "var", name: "message" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  };
  const instance = await instantiate_wat(
    Emit.emit(Mod, Core.mod(core)),
    "core_scratch_bounded_borrow_import",
    {
      env: {
        read(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero scratch text pointer");
          }

          return 36;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 36) {
    throw new Error("Expected main() -> 36, got " + result);
  }
});

Deno.test("core frozen-shareable host import compiles through WAT to Wasm", async () => {
  const core: CoreNode = {
    tag: "program",
    host_imports: {
      host_read: {
        name: "host_read",
        module: "env",
        field: "read",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "frozen_shareable" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "freeze",
          value: {
            tag: "app",
            func: { tag: "var", name: "@append" },
            args: [
              { tag: "text", value: "he" },
              { tag: "text", value: "llo" },
            ],
          },
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_read" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const instance = await instantiate_wat(
    Emit.emit(Mod, Core.mod(core)),
    "core_frozen_shareable_import",
    {
      env: {
        read(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero frozen text pointer");
          }

          return 38;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 38) {
    throw new Error("Expected main() -> 38, got " + result);
  }
});

Deno.test("core ownership-transfer host import compiles through WAT to Wasm", async () => {
  const core: CoreNode = {
    tag: "program",
    host_imports: {
      host_take: {
        name: "host_take",
        module: "env",
        field: "take",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "ownership_transfer" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "@append" },
          args: [
            { tag: "text", value: "he" },
            { tag: "text", value: "llo" },
          ],
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_take" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const instance = await instantiate_wat(
    Emit.emit(Mod, Core.mod(core)),
    "core_ownership_transfer_import",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 39;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 39) {
    throw new Error("Expected main() -> 39, got " + result);
  }
});

Deno.test("core branch-selected ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let flag = 0
let send = if flag {
  (msg: Text) => host_take(msg)
} else {
  (msg: Text) => host_take(msg)
}
let message: Text = @append("he", "llo")
send(message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_branch_selected_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 40;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 40) {
    throw new Error("Expected main() -> 40, got " + result);
  }
});

Deno.test("core temporary ownership-transfer wrapper argument compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = msg => host_take(msg)
send(@append("he", "llo"))
`);
  const instance = await instantiate_wat(
    wat,
    "core_temporary_ownership_transfer_wrapper_arg",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 41;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 41) {
    throw new Error("Expected main() -> 41, got " + result);
  }
});

Deno.test("core expression temporary ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = (msg: Text) => host_take(@append(msg, "!"))
let message: Text = @append("he", "llo")
send(message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_expression_temporary_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 44;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 44) {
    throw new Error("Expected main() -> 44, got " + result);
  }
});

Deno.test("core branch temporary ownership-transfer wrapper argument compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = msg => host_take(msg)
let flag = 0
send(if flag { @append("he", "llo") } else { @append("wo", "rld") })
`);
  const instance = await instantiate_wat(
    wat,
    "core_branch_temporary_ownership_transfer_wrapper_arg",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 42;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected main() -> 42, got " + result);
  }
});

Deno.test("core branch-local ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let flag = 1
let message: Text = @append("he", "llo")
if flag {
  let send = msg => host_take(msg)
  send(message)
} else {
  host_take(message)
}
`);
  const instance = await instantiate_wat(
    wat,
    "core_branch_local_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 43;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 43) {
    throw new Error("Expected main() -> 43, got " + result);
  }
});

Deno.test("core rec ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = rec (msg: Text) => host_take(msg)
let message: Text = @append("he", "llo")
send(message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_rec_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 44;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 44) {
    throw new Error("Expected main() -> 44, got " + result);
  }
});

Deno.test("core higher-order ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => f(msg)
let message: Text = @append("he", "llo")
relay(send, message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_higher_order_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 45;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 45) {
    throw new Error("Expected main() -> 45, got " + result);
  }
});

Deno.test("core higher-order expression temporary ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = (msg: Text) => host_take(msg)
let relay = (const f, msg: Text) => f(@append(msg, "!"))
let message: Text = @append("he", "llo")
relay(send, message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_higher_order_expression_temporary_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 47;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 47) {
    throw new Error("Expected main() -> 47, got " + result);
  }
});

Deno.test("core higher-order alias ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => {
  let g = f
  g(msg)
}
let message: Text = @append("he", "llo")
relay(send, message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_higher_order_alias_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 46;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 46) {
    throw new Error("Expected main() -> 46, got " + result);
  }
});

Deno.test("core branch higher-order alias temporary ownership-transfer wrapper compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
host_import host_take from "env.take" (Text) => I32

let send = (msg: Text) => host_take(msg)
let flag = 1
let relay = if flag {
  (const f, msg: Text) => {
    let g = f
    g(@append(msg, "!"))
  }
} else {
  (const f, msg: Text) => {
    let g = f
    g(@append(msg, "?"))
  }
}
let message: Text = @append("he", "llo")
relay(send, message)
`);
  const instance = await instantiate_wat(
    wat,
    "core_branch_higher_order_alias_temporary_ownership_transfer_wrapper",
    {
      env: {
        take(ptr: number): number {
          if (ptr <= 0) {
            throw new Error("expected non-zero transferred text pointer");
          }

          return 48;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 48) {
    throw new Error("Expected main() -> 48, got " + result);
  }
});

Deno.test("core host-returned owner import compiles through WAT to Wasm", async () => {
  const core: CoreNode = {
    tag: "program",
    host_imports: {
      host_make: {
        name: "host_make",
        module: "env",
        field: "make",
        params: [],
        result: "i32",
        args: [],
        result_owner: { tag: "unique_heap", reason: "text" },
      },
    },
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_make" },
          args: [],
        },
      },
    ],
  };
  const instance = await instantiate_wat(
    Emit.emit(Mod, Core.mod(core)),
    "core_host_returned_owner_import",
    {
      env: {
        make(): number {
          return 41;
        },
      },
    },
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 41) {
    throw new Error("Expected main() -> 41, got " + result);
  }
});

Deno.test("module memory and data compile through WAT to Wasm", async () => {
  const mod: Mod = {
    memory: {
      name: "memory",
      pages: 1,
      export_name: "memory",
    },
    data: [
      {
        offset: 0,
        bytes: [104, 105],
      },
    ],
    funcs: {
      main: {
        name: "main",
        result: "i32",
        body: "i32.const 0\ni32.load8_u",
      },
    },
    exports: ["main"],
  };
  const instance = await instantiate_wat(Emit.emit(Mod, mod), "memory", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 2);

  if (bytes[0] !== 104) {
    throw new Error("Expected memory[0] -> 104, got " + bytes[0]);
  }

  if (bytes[1] !== 105) {
    throw new Error("Expected memory[1] -> 105, got " + bytes[1]);
  }

  const result = instance.exports.main();

  if (result !== 104) {
    throw new Error("Expected main() -> 104, got " + result);
  }
});
