import {
  decoder,
  instantiate_wat,
  wat_from_core_source,
} from "./wasm_test_util.ts";

Deno.test("linear aggregate moves through a one-shot closure environment", async () => {
  const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
let make = (age: Int) => [.age = age] as user_type
let !user: user_type = make(41)
let flag = 1
let take_once = if flag { () => !user } else { () => !user }
user = take_once()
let marker = "x"
!user
`);
  const instance = await instantiate_wat(
    wat_text,
    "linear_aggregate_one_shot_closure",
    {},
  );

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("Missing main export");
  }

  const pointer = instance.exports.main();

  if (typeof pointer !== "number") {
    throw new Error("Expected aggregate pointer result");
  }

  const age = new DataView(instance.exports.memory.buffer).getInt32(
    pointer,
    true,
  );

  if (age !== 41) {
    throw new Error("Expected moved aggregate age 41, got " + age);
  }
});

Deno.test("linear union moves through a one-shot closure environment", async () => {
  const wat_text = wat_from_core_source(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let !result: result_type = result_type.ok(41)
let flag = 1
let take_once = if flag { () => !result } else { () => !result }
result = take_once()
let marker = "x"
!result
`);
  const instance = await instantiate_wat(
    wat_text,
    "linear_union_one_shot_closure",
    {},
  );

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("Missing main export");
  }

  const pointer = instance.exports.main();
  if (typeof pointer !== "number") {
    throw new Error("Expected union pointer result");
  }

  const view = new DataView(instance.exports.memory.buffer);
  const tag = view.getInt32(pointer, true);
  const payload = view.getInt32(pointer + 4, true);

  if (tag !== 0 || payload !== 41) {
    throw new Error(
      "Expected moved .ok(41), got tag=" + tag.toString() + " payload=" +
        payload.toString(),
    );
  }
});

Deno.test("no-else conditional payload transfers clean only fallthrough", async () => {
  const prefix = `
host_import branch_flag from "env.flag" () => I32
type GateType = | .go = Int | .stop = Int
const gate_type = GateType
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
const result_type = ResultType
let flag = branch_flag()
let gate: gate_type = if flag {
  gate_type.go(1)
} else {
  gate_type.stop(0)
}
let make = if flag {
  (age: Int) => [.age = age] as user_type
} else {
  (age: Int) => [.age = age + 1] as user_type
}
let user: user_type = make(40)
`;
  const suffix = `
let first: user_type = make(50)
let second: user_type = make(60)
first.age
`;
  const fixtures = [
    prefix + "if flag { result_type.ok(user) }\n" + suffix,
    prefix + "if let .go(value) = gate { result_type.ok(user) }\n" +
    suffix,
  ];

  for (
    let fixture_index = 0;
    fixture_index < fixtures.length;
    fixture_index += 1
  ) {
    const source = fixtures[fixture_index];
    if (!source) {
      throw new Error("Missing conditional cleanup fixture");
    }

    for (const flag of [0, 1]) {
      const instance = await instantiate_wat(
        wat_from_core_source(source),
        "no_else_conditional_cleanup_" + fixture_index.toString() + "_" +
          flag.toString(),
        { env: { flag: () => flag } },
      );
      if (typeof instance.exports.main !== "function") {
        throw new Error("Missing main export");
      }

      const result = instance.exports.main();
      const expected = 51 - flag;
      if (result !== expected) {
        throw new Error(
          "Expected first.age=" + expected.toString() +
            " from distinct post-cleanup allocations, got " + String(result),
        );
      }
    }
  }
});

Deno.test("frontend linked scope cleanup placeholder compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
let text: Text = @append("A", "da")
1
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_linked_scope_cleanup_placeholder",
    {},
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();
  if (result !== 1) {
    throw new Error("Expected cleanup placeholder main() -> 1, got " + result);
  }
});

Deno.test("frontend nested cleanup edges compile through WAT to Wasm", async () => {
  const cases = [
    {
      name: "frontend_cleanup_conditional_return",
      source: `
let f = (x: Int) => x
if 1 {
  return 7
}
0
`,
      expected: 7,
    },
    {
      name: "frontend_cleanup_return_stack_preservation",
      source: `
let text: Text = @append("A", "da")
if 1 {
  return @len(text)
}
0
`,
      expected: 3,
    },
    {
      name: "frontend_cleanup_loop_break",
      source: `
let result = 3
for i in 0..2 {
  let f = (x: Int) => x
  break
}
result
`,
      expected: 3,
    },
    {
      name: "frontend_cleanup_loop_continue",
      source: `
let result = 4
for i in 0..2 {
  let f = (x: Int) => x
  continue
}
result
`,
      expected: 4,
    },
  ];

  for (const item of cases) {
    const instance = await instantiate_wat(
      wat_from_core_source(item.source),
      item.name,
      {},
    );
    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }
    const result = instance.exports.main();
    if (result !== item.expected) {
      throw new Error(
        "Expected cleanup edge main() -> " + item.expected.toString() +
          ", got " + result,
      );
    }
  }
});

Deno.test("frontend persistent allocator reuses freed layout blocks", async () => {
  let wat = wat_from_core_source(`
let text: Text = @append("A", "da")
1
`);
  const module_end = wat.lastIndexOf("\n)");
  if (module_end < 0) {
    throw new Error("Missing WAT module terminator");
  }
  wat = wat.slice(0, module_end) +
    '\n  (export "alloc" (func $__alloc))' +
    '\n  (export "free" (func $__free))' +
    wat.slice(module_end);
  const instance = await instantiate_wat(
    wat,
    "frontend_persistent_allocator_reuse",
    {},
  );
  if (
    typeof instance.exports.alloc !== "function" ||
    typeof instance.exports.free !== "function"
  ) {
    throw new Error("allocator exports are not functions");
  }
  const alloc = instance.exports.alloc as (
    size: number,
    align: number,
  ) => number;
  const free = instance.exports.free as (ptr: number) => number;
  const text_address = alloc(20, 8);
  free(text_address);
  const union_address = alloc(8, 8);
  if (union_address !== text_address) {
    throw new Error("Expected union allocation to reuse freed Text block");
  }
  free(union_address);
  const aggregate_address = alloc(16, 8);
  if (aggregate_address !== text_address) {
    throw new Error("Expected aggregate allocation to reuse freed block");
  }

  async function scoped_text_heap(iterations: number): Promise<number> {
    let scoped_wat = wat_from_core_source(`
for i in 0..${iterations.toString()} {
  let text: Text = @append("A", "da")
  @len(text)
}
0
`);
    const end = scoped_wat.lastIndexOf("\n)");
    if (end < 0) {
      throw new Error("Missing scoped-allocation WAT module terminator");
    }
    scoped_wat = scoped_wat.slice(0, end) +
      '\n  (export "heap" (global $__closure_heap))' +
      scoped_wat.slice(end);
    const scoped = await instantiate_wat(
      scoped_wat,
      "frontend_scoped_text_reuse_" + iterations.toString(),
      {},
    );
    if (typeof scoped.exports.main !== "function") {
      throw new Error("main export is not a function");
    }
    scoped.exports.main();
    const heap = scoped.exports.heap;
    if (!(heap instanceof WebAssembly.Global)) {
      throw new Error("heap export is not a global");
    }
    return Number(heap.value);
  }

  const one_iteration_heap = await scoped_text_heap(1);
  const eight_iteration_heap = await scoped_text_heap(8);
  if (eight_iteration_heap !== one_iteration_heap) {
    throw new Error("Repeated scoped Text allocation did not reuse its block");
  }

  async function scoped_aggregate_heap(iterations: number): Promise<number> {
    let scoped_wat = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= Int }
let flag = 1
let make = if flag {
  (suffix: Text) => [.name = @append("A", suffix), .age = 40] as user_type
} else {
  (suffix: Text) => [.name = @append("B", suffix), .age = 5] as user_type
}
for i in 0..${iterations.toString()} {
  let user: user_type = make("da")
  @len(user.name) + user.age
}
0
`);
    const end = scoped_wat.lastIndexOf("\n)");
    if (end < 0) {
      throw new Error("Missing aggregate WAT module terminator");
    }
    scoped_wat = scoped_wat.slice(0, end) +
      '\n  (export "heap" (global $__closure_heap))' +
      scoped_wat.slice(end);
    const scoped = await instantiate_wat(
      scoped_wat,
      "frontend_scoped_aggregate_reuse_" + iterations.toString(),
      {},
    );
    if (typeof scoped.exports.main !== "function") {
      throw new Error("main export is not a function");
    }
    scoped.exports.main();
    const heap = scoped.exports.heap;
    if (!(heap instanceof WebAssembly.Global)) {
      throw new Error("heap export is not a global");
    }
    return Number(heap.value);
  }

  const one_aggregate_heap = await scoped_aggregate_heap(1);
  const eight_aggregate_heap = await scoped_aggregate_heap(8);
  if (eight_aggregate_heap !== one_aggregate_heap) {
    throw new Error(
      "Repeated aggregate Text child allocation did not reuse both blocks",
    );
  }
});

Deno.test("discarded compiler temporaries reuse allocator blocks", async () => {
  const fixtures = [
    {
      name: "text",
      discarded: `
let flag = 1
@append(if flag { "A" } else { "B" }, "!")
@append(if flag { "C" } else { "D" }, "?")
`,
      retained: `
let flag = 1
let held: Text = @append(if flag { "A" } else { "B" }, "!")
let result: Text = @append(if flag { "C" } else { "D" }, "?")
if flag { result } else { held }
`,
    },
    {
      name: "aggregate",
      discarded: `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
let flag = 1
let make = freeze ((age: Int) => [.age = age] as user_type)
make(flag)
make(flag + 1)
`,
      retained: `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
let flag = 1
let make = freeze ((age: Int) => [.age = age] as user_type)
let held: user_type = make(flag)
let result: user_type = make(flag + 1)
if flag { result } else { held }
`,
    },
    {
      name: "union",
      discarded: `
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let flag = 1
let make = freeze ((value: Int) => result_type.ok(value))
make(flag)
make(flag + 1)
`,
      retained: `
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let flag = 1
let make = freeze ((value: Int) => result_type.ok(value))
let held: result_type = make(flag)
let result: result_type = make(flag + 1)
if flag { result } else { held }
`,
    },
  ];

  for (const fixture of fixtures) {
    const discarded = await instantiate_wat(
      wat_from_core_source(fixture.discarded),
      "discarded_temporary_" + fixture.name,
      {},
    );
    const retained = await instantiate_wat(
      wat_from_core_source(fixture.retained),
      "retained_temporary_" + fixture.name,
      {},
    );
    if (
      typeof discarded.exports.main !== "function" ||
      typeof retained.exports.main !== "function"
    ) {
      throw new Error("Missing temporary cleanup main export");
    }

    const reused_pointer = discarded.exports.main();
    const retained_pointer = retained.exports.main();
    if (
      typeof reused_pointer !== "number" ||
      typeof retained_pointer !== "number"
    ) {
      throw new Error("Expected temporary cleanup pointer results");
    }
    if (reused_pointer >= retained_pointer) {
      throw new Error(
        "Expected discarded " + fixture.name +
          " block reuse before retained allocation, got " +
          reused_pointer.toString() + " and " + retained_pointer.toString(),
      );
    }
  }
});

Deno.test("core scratch scalar compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
scratch {
  let x = 40
  x + 2
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_scratch_scalar",
    {},
  );

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

Deno.test("core scratch aggregate temporary compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}
let flag = 1
let f = if flag {
  (x: Int) => x
} else {
  (x: Int) => x + 1
}

scratch {
  [.age = 41, .name = "Ada"] as user_type
  f(7)
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_scratch_aggregate_temporary",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 7) {
    throw new Error("Expected main() -> 7, got " + result);
  }
});

Deno.test("core scratch runtime text temporary compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let scratch_text = if flag {
  (message: Text) => scratch {
    message + "!"
    7
  }
} else {
  (message: Text) => scratch {
    "!" + message
    8
  }
}

scratch_text("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_scratch_runtime_text_temporary",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 7) {
    throw new Error("Expected main() -> 7, got " + result);
  }
});

Deno.test("core scratch runtime union temporary compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let flag = 1

scratch {
  if flag {
    result_type.ok(41)
  } else {
    result_type.err(5)
  }

  7
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_scratch_runtime_union_temporary",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 7) {
    throw new Error("Expected main() -> 7, got " + result);
  }
});

Deno.test("core scratch return compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
scratch {
  if 1 {
    return 42
  }

  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_scratch_return",
    {},
  );

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

Deno.test("core scratch break and continue compile through WAT to Wasm", async () => {
  const break_wat = wat_from_core_source(`
let total = 0

for i in 0..3 {
  total = scratch {
    if i == 1 {
      break
    }

    total + 10
  }
}

total
`);
  const break_instance = await instantiate_wat(
    break_wat,
    "core_scratch_break",
    {},
  );

  if (!("main" in break_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof break_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const break_result = break_instance.exports.main();

  if (break_result !== 10) {
    throw new Error("Expected main() -> 10, got " + break_result);
  }

  const continue_wat = wat_from_core_source(`
let total = 0

for i in 0..3 {
  scratch {
    if i == 1 {
      continue
    }

    total = total + 10
    0
  }

  total = total + 1
}

total
`);
  const continue_instance = await instantiate_wat(
    continue_wat,
    "core_scratch_continue",
    {},
  );

  if (!("main" in continue_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof continue_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const continue_result = continue_instance.exports.main();

  if (continue_result !== 22) {
    throw new Error("Expected main() -> 22, got " + continue_result);
  }
});

Deno.test("core one-sided union payload transfer cleans retained branch", async () => {
  const wat_text = wat_from_core_source(`
host_import branch_flag from "env.flag" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let flag = branch_flag()
let user: user_type = [.age = 40, .score = 2] as user_type
let result: result_type = result_type.err()
if flag {
  result = result_type.ok(user)
} else {
  result = result_type.err()
}
if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`);

  for (
    const fixture of [
      { flag: 1, expected: 42 },
      { flag: 0, expected: 0 },
    ]
  ) {
    const instance = await instantiate_wat(
      wat_text,
      "core_one_sided_union_payload_transfer_" + fixture.flag.toString(),
      {
        env: {
          flag: () => fixture.flag,
        },
      },
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== fixture.expected) {
      throw new Error(
        "Expected main() -> " + fixture.expected.toString() + ", got " +
          result,
      );
    }
  }
});

Deno.test("core single-exit loop payload transfer covers zero iterations", async () => {
  const wat_text = wat_from_core_source(`
host_import loop_limit from "env.limit" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
const result_type = ResultType
let limit = loop_limit()
let user: user_type = [.age = 40] as user_type
for index in 0..limit {
  result_type.ok(user)
  break
}
limit
`);

  for (
    const fixture of [
      { limit: 0, expected: 0 },
      { limit: 3, expected: 3 },
    ]
  ) {
    const instance = await instantiate_wat(
      wat_text,
      "core_single_exit_loop_payload_" + fixture.limit.toString(),
      {
        env: {
          limit: () => fixture.limit,
        },
      },
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== fixture.expected) {
      throw new Error(
        "Expected main() -> " + fixture.expected.toString() + ", got " +
          result,
      );
    }
  }
});

Deno.test(
  "frontend branch-selected linear closure alpha-renames params through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  (message: Text) => io.print(&message)
} else {
  (text: Text) => io.print(&text)
}
io = print_once("world")
io
`);
    let calls = 0;
    let printed = "";
    // Initialized after instantiation; host callbacks close over this binding.
    // deno-lint-ignore prefer-const
    let memory: WebAssembly.Memory | undefined;
    const instance = await instantiate_wat(
      wat,
      "frontend_branch_selected_linear_closure_alpha_params",
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
  "frontend if-let linear closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
let flag = 1
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let !base: I32 = 1
let result: result_type = if flag {
  .ok(40)
} else {
  .err(1)
}

let f = if let .ok(value) = result {
  () => !base + value + 1
} else {
  () => !base + 1
}

base = f()
base
`);
    const instance = await instantiate_wat(
      wat,
      "frontend_if_let_linear_closure",
      {},
    );

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== 42) {
      throw new Error("Expected main() -> 42, got " + result);
    }
  },
);

Deno.test(
  "frontend if-let Text payload linear closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 1
let result: result_type = if flag {
  result_type.ok("world")
} else {
  result_type.err("fallback")
}
let print_once = if let .ok(value) = result {
  () => io.print(&value)
} else {
  () => io.print("fallback")
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
      "frontend_if_let_text_payload_linear_closure",
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
      throw new Error("Expected matched payload to print world");
    }
  },
);

Deno.test("frontend runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  freeze @append(value, "!")
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected frozen text length byte 0 -> 3, got " + bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  scratch { freeze @append(value, "!") }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected scratch-frozen text length byte 0 -> 3, got " + bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected scratch-frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected scratch-frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected scratch-frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend bound scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  scratch {
    let temp: Text = @append(value, "!")
    freeze temp
  }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_bound_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected bound scratch-frozen text length byte 0 -> 3, got " + bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected bound scratch-frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected bound scratch-frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected bound scratch-frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend alias scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  scratch {
    let temp: Text = @append(value, "!")
    let alias: Text = temp
    freeze alias
  }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_alias_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected alias scratch-frozen text length byte 0 -> 3, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected alias scratch-frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected alias scratch-frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected alias scratch-frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend annotated scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  let result: Text = scratch {
    let temp: Text = @append(value, "!")
    freeze temp
  }
  @len(result)
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_annotated_scratch_runtime_text_freeze",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 3) {
    throw new Error("Expected main() -> 3, got " + result);
  }
});

Deno.test("frontend block scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  scratch {
    let temp: Text = {
      let inner: Text = @append(value, "!")
      inner
    }
    freeze temp
  }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_block_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected block scratch-frozen text length byte 0 -> 3, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected block scratch-frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected block scratch-frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected block scratch-frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend helper scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let add_bang = (value: Text) => {
  @append(value, "!")
}

let freeze_suffix = (value: Text) => {
  scratch {
    let temp: Text = add_bang(value)
    freeze temp
  }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_helper_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected helper scratch-frozen text length byte 0 -> 3, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected helper scratch-frozen text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected helper scratch-frozen text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected helper scratch-frozen text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend helper-returned scratch Text freeze persists through reset", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  freeze @append(value, "!")
}
let prefix: Text = @slice("Ada", 0, 3)
scratch { freeze_suffix(prefix) }
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_helper_returned_scratch_text_freeze",
    {},
  );

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("Missing main export");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const bytes = new Uint8Array(instance.exports.memory.buffer, result, 8);

  if (
    bytes[0] !== 4 || bytes[4] !== 65 || bytes[5] !== 100 ||
    bytes[6] !== 97 || bytes[7] !== 33
  ) {
    throw new Error("Expected helper-returned scratch Text to equal Ada!");
  }
});

Deno.test("promoted scratch Text survives in a stored closure environment", async () => {
  const wat_text = wat_from_core_source(`
let f = scratch {
  let message: Text = @append("he", "llo")
  let persistent: Text = freeze message
  freeze ((x: Int) => @len(persistent) + x)
}
f(1)
`);
  const instance = await instantiate_wat(
    wat_text,
    "promoted_scratch_text_closure_capture",
    {},
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("Missing main export");
  }

  const result = instance.exports.main();

  if (result !== 6) {
    throw new Error(
      "Expected promoted scratch Text closure main() -> 6, got " + result,
    );
  }
});

Deno.test("frontend branch scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected_suffix: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
let freeze_suffix = (flag: Int, value: Text) => {
  scratch {
    if flag {
      freeze @append(value, "!")
    } else {
      freeze @append(value, "?")
    }
  }
}

freeze_suffix(${flag}, "hi")
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error("Expected main() to return a text pointer");
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 7);

    if (bytes[0] !== 3) {
      throw new Error(
        "Expected branch scratch-frozen text length byte 0 -> 3, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== 104) {
      throw new Error(
        "Expected branch scratch-frozen text byte 0 -> 104, got " + bytes[4],
      );
    }

    if (bytes[5] !== 105) {
      throw new Error(
        "Expected branch scratch-frozen text byte 1 -> 105, got " + bytes[5],
      );
    }

    if (bytes[6] !== expected_suffix) {
      throw new Error(
        "Expected branch scratch-frozen text byte 2 -> " +
          expected_suffix.toString() + ", got " + bytes[6],
      );
    }
  }

  await check_branch(
    1,
    33,
    "frontend_branch_scratch_runtime_text_freeze_then",
  );
  await check_branch(
    0,
    63,
    "frontend_branch_scratch_runtime_text_freeze_else",
  );
});

Deno.test("frontend branch scratch aggregate freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let read_user = flag => {
  let user: user_type = scratch {
    let temp: user_type = if flag {
      [.name = @append("A", "da"), .age = 1] as user_type
    } else {
      [.name = @append("Gr", "ace"), .age = 2] as user_type
    }

    freeze temp
  }

  @len(user.name) + user.age
}

read_user(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== expected) {
      throw new Error(
        "Expected branch scratch-frozen aggregate result " +
          expected.toString() + ", got " + String(result),
      );
    }
  }

  await check_branch(
    1,
    4,
    "frontend_branch_scratch_aggregate_freeze_then",
  );
  await check_branch(
    0,
    7,
    "frontend_branch_scratch_aggregate_freeze_else",
  );
});

Deno.test("frontend chained-alias scratch aggregate freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type
let user: user_type = scratch {
  let first = existing
  let second = first
  freeze second
}

@len(user.name) + user.age
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_chained_alias_scratch_aggregate_freeze",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 43) {
    throw new Error(
      "Expected chained-alias scratch-frozen aggregate result 43, got " +
        String(result),
    );
  }
});

Deno.test("frontend branch-assigned scratch aggregate freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let read_user = flag => {
  let user: user_type = scratch {
    let temp: user_type = [.name = @append("n", "o"), .age = 0] as user_type

    if flag {
      temp = [.name = @append("A", "da"), .age = 1] as user_type
    } else {
      temp = [.name = @append("Gr", "ace"), .age = 2] as user_type
    }

    freeze temp
  }

  @len(user.name) + user.age
}

read_user(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== expected) {
      throw new Error(
        "Expected branch-assigned scratch-frozen aggregate result " +
          expected.toString() + ", got " + String(result),
      );
    }
  }

  await check_branch(
    1,
    4,
    "frontend_branch_assigned_scratch_aggregate_freeze_then",
  );
  await check_branch(
    0,
    7,
    "frontend_branch_assigned_scratch_aggregate_freeze_else",
  );
});

Deno.test("frontend branch-assigned scratch union freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

let read_result = flag => {
  let result: result_type = scratch {
    let temp: result_type = result_type.err(@append("n", "o"))

    if flag {
      temp = result_type.ok(@append("A", "da"))
    } else {
      temp = result_type.err(@append("Gr", "ace"))
    }

    freeze temp
  }

  if let .ok(value) = result {
    @len(value)
  } else {
    0
  }
}

read_result(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== expected) {
      throw new Error(
        "Expected branch-assigned scratch-frozen union result " +
          expected.toString() + ", got " + String(result),
      );
    }
  }

  await check_branch(
    1,
    3,
    "frontend_branch_assigned_scratch_union_freeze_then",
  );
  await check_branch(
    0,
    0,
    "frontend_branch_assigned_scratch_union_freeze_else",
  );
});

Deno.test("frontend branch-assigned scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected_suffix: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
let freeze_suffix = (flag: Int, value: Text) => {
  scratch {
    let temp: Text = @append(value, ".")
    if flag {
      temp = @append(value, "!")
    } else {
      temp = @append(value, "?")
    }
    freeze temp
  }
}

freeze_suffix(${flag}, "hi")
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error(
        "Expected branch-assigned main() to return a text pointer",
      );
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 7);

    if (bytes[0] !== 3) {
      throw new Error(
        "Expected branch-assigned scratch-frozen text length byte 0 -> 3, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== 104) {
      throw new Error(
        "Expected branch-assigned scratch-frozen text byte 0 -> 104, got " +
          bytes[4],
      );
    }

    if (bytes[5] !== 105) {
      throw new Error(
        "Expected branch-assigned scratch-frozen text byte 1 -> 105, got " +
          bytes[5],
      );
    }

    if (bytes[6] !== expected_suffix) {
      throw new Error(
        "Expected branch-assigned scratch-frozen text byte 2 -> " +
          expected_suffix.toString() + ", got " + bytes[6],
      );
    }
  }

  await check_branch(
    1,
    33,
    "frontend_branch_assigned_scratch_runtime_text_freeze_then",
  );
  await check_branch(
    0,
    63,
    "frontend_branch_assigned_scratch_runtime_text_freeze_else",
  );
});

Deno.test("frontend optional branch scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected_first: number,
    expected_second: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
let freeze_suffix = flag => {
  scratch {
    let temp: Text = @append("n", "o")
    if flag {
      temp = @append("h", "i")
    }
    freeze temp
  }
}

freeze_suffix(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error("Expected optional branch main() to return text pointer");
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 6);

    if (bytes[0] !== 2) {
      throw new Error(
        "Expected optional branch scratch-frozen text length byte 0 -> 2, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== expected_first) {
      throw new Error(
        "Expected optional branch scratch-frozen text byte 0 -> " +
          expected_first.toString() + ", got " + bytes[4],
      );
    }

    if (bytes[5] !== expected_second) {
      throw new Error(
        "Expected optional branch scratch-frozen text byte 1 -> " +
          expected_second.toString() + ", got " + bytes[5],
      );
    }
  }

  await check_branch(
    1,
    104,
    105,
    "frontend_optional_branch_scratch_runtime_text_freeze_then",
  );
  await check_branch(
    0,
    110,
    111,
    "frontend_optional_branch_scratch_runtime_text_freeze_fallback",
  );
});

Deno.test("frontend loop-assigned scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_loop(
    count: number,
    expected_suffix: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
let freeze_suffix = (count: Int, value: Text) => {
  scratch {
    let temp: Text = @append(value, ".")
    for i in 0..count {
      temp = @append(value, "!")
    }
    freeze temp
  }
}

freeze_suffix(${count}, "hi")
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error("Expected loop-assigned main() to return a text pointer");
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 7);

    if (bytes[0] !== 3) {
      throw new Error(
        "Expected loop-assigned scratch-frozen text length byte 0 -> 3, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== 104) {
      throw new Error(
        "Expected loop-assigned scratch-frozen text byte 0 -> 104, got " +
          bytes[4],
      );
    }

    if (bytes[5] !== 105) {
      throw new Error(
        "Expected loop-assigned scratch-frozen text byte 1 -> 105, got " +
          bytes[5],
      );
    }

    if (bytes[6] !== expected_suffix) {
      throw new Error(
        "Expected loop-assigned scratch-frozen text byte 2 -> " +
          expected_suffix.toString() + ", got " + bytes[6],
      );
    }
  }

  await check_loop(
    0,
    46,
    "frontend_loop_assigned_scratch_runtime_text_freeze_zero",
  );
  await check_loop(
    1,
    33,
    "frontend_loop_assigned_scratch_runtime_text_freeze_one",
  );
});

Deno.test("frontend collection-loop-assigned scratch runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const xs_type = struct {
  .first= Int,
  .second= Int
}

let freeze_suffix = (value: Text) => {
  let xs: xs_type = [.first = 1, .second = 2] as xs_type
  scratch {
    let temp: Text = @append(value, ".")
    for x in xs {
      temp = @append(value, "!")
    }
    freeze temp
  }
}

freeze_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_collection_loop_assigned_scratch_runtime_text_freeze",
    {},
  );

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

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error(
      "Expected collection-loop-assigned main() to return a text pointer",
    );
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected collection-loop-assigned scratch-frozen text length byte 0 -> 3, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected collection-loop-assigned scratch-frozen text byte 0 -> 104, got " +
        bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected collection-loop-assigned scratch-frozen text byte 1 -> 105, got " +
        bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected collection-loop-assigned scratch-frozen text byte 2 -> 33, got " +
        bytes[6],
    );
  }
});

Deno.test("frontend if let scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected_first: number,
    expected_second: number,
    expected_suffix: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

let freeze_result = (flag: Int) => {
  let result: result_type = if flag {
    .ok("hi")
  } else {
    .err("no")
  }

  scratch {
    if let .ok(value) = result {
      freeze @append(value, "!")
    } else {
      freeze @append("no", "?")
    }
  }
}

freeze_result(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error("Expected main() to return a text pointer");
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 7);

    if (bytes[0] !== 3) {
      throw new Error(
        "Expected if-let scratch-frozen text length byte 0 -> 3, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== expected_first) {
      throw new Error(
        "Expected if-let scratch-frozen text byte 0 -> " +
          expected_first.toString() + ", got " + bytes[4],
      );
    }

    if (bytes[5] !== expected_second) {
      throw new Error(
        "Expected if-let scratch-frozen text byte 1 -> " +
          expected_second.toString() + ", got " + bytes[5],
      );
    }

    if (bytes[6] !== expected_suffix) {
      throw new Error(
        "Expected if-let scratch-frozen text byte 2 -> " +
          expected_suffix.toString() + ", got " + bytes[6],
      );
    }
  }

  await check_branch(
    1,
    104,
    105,
    33,
    "frontend_if_let_scratch_runtime_text_freeze_then",
  );
  await check_branch(
    0,
    110,
    111,
    63,
    "frontend_if_let_scratch_runtime_text_freeze_else",
  );
});

Deno.test("frontend if-let-assigned scratch runtime text freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected_first: number,
    expected_second: number,
    expected_suffix: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

let freeze_result = (flag: Int) => {
  let result: result_type = if flag {
    .ok("hi")
  } else {
    .err("no")
  }

  scratch {
    let temp: Text = @append("no", ".")
    if let .ok(value) = result {
      temp = @append(value, "!")
    }
    if let .err(value) = result {
      temp = @append(value, "?")
    }
    freeze temp
  }
}

freeze_result(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

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

    const result = instance.exports.main();

    if (typeof result !== "number") {
      throw new Error("Expected if-let-assigned main() to return text pointer");
    }

    const memory = instance.exports.memory;
    const bytes = new Uint8Array(memory.buffer, result, 7);

    if (bytes[0] !== 3) {
      throw new Error(
        "Expected if-let-assigned scratch-frozen text length byte 0 -> 3, got " +
          bytes[0],
      );
    }

    if (bytes[4] !== expected_first) {
      throw new Error(
        "Expected if-let-assigned scratch-frozen text byte 0 -> " +
          expected_first.toString() + ", got " + bytes[4],
      );
    }

    if (bytes[5] !== expected_second) {
      throw new Error(
        "Expected if-let-assigned scratch-frozen text byte 1 -> " +
          expected_second.toString() + ", got " + bytes[5],
      );
    }

    if (bytes[6] !== expected_suffix) {
      throw new Error(
        "Expected if-let-assigned scratch-frozen text byte 2 -> " +
          expected_suffix.toString() + ", got " + bytes[6],
      );
    }
  }

  await check_branch(
    1,
    104,
    105,
    33,
    "frontend_if_let_assigned_scratch_runtime_text_freeze_then",
  );
  await check_branch(
    0,
    110,
    111,
    63,
    "frontend_if_let_assigned_scratch_runtime_text_freeze_else",
  );
});

Deno.test("frontend if-let-assigned scratch union freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
type OptionType = | .some = Text | .none
const option_type = OptionType

type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

let read_result = (flag: Int) => {
  let maybe: option_type = if flag {
    option_type.some("Ada")
  } else {
    option_type.none()
  }

  let result: result_type = scratch {
    let temp: result_type = result_type.err(@append("n", "o"))
    if let .some(name) = maybe {
      temp = result_type.ok(@append(name, "!"))
    }
    freeze temp
  }

  if let .ok(value) = result {
    @len(value)
  } else {
    0
  }
}

read_result(${flag})
`);
    const instance = await instantiate_wat(
      wat_text,
      name,
      {},
    );

    if (!("main" in instance.exports)) {
      throw new Error("Missing main export");
    }

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    const result = instance.exports.main();

    if (result !== expected) {
      throw new Error(
        "Expected if-let-assigned scratch union main() -> " +
          expected.toString() + ", got " + result,
      );
    }
  }

  await check_branch(
    1,
    4,
    "frontend_if_let_assigned_scratch_union_freeze_some",
  );
  await check_branch(
    0,
    0,
    "frontend_if_let_assigned_scratch_union_freeze_none",
  );
});

Deno.test("frontend emits branch-local materialized aggregate temporaries in source order", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let read_user = flag => {
  let user: user_type = scratch {
    let branch: user_type = if flag {
      let selected: user_type = [.name = @append("A", "da"), .age = 1] as user_type
      selected
    } else {
      let fallback: user_type = [.name = @append("Gr", "ace"), .age = 2] as user_type
      fallback
    }
    freeze branch
  }

  @len(user.name) + user.age
}

read_user(${flag})
`);
    const instance = await instantiate_wat(wat_text, name, {});

    if (typeof instance.exports.main !== "function") {
      throw new Error("Missing main export");
    }

    const result = instance.exports.main();

    if (result !== expected) {
      throw new Error(
        "Expected branch-local materialized aggregate result " +
          expected.toString() + ", got " + String(result),
      );
    }
  }

  await check_branch(
    1,
    4,
    "frontend_branch_local_materialized_aggregate_then",
  );
  await check_branch(
    0,
    7,
    "frontend_branch_local_materialized_aggregate_else",
  );
});
