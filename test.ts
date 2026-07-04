import { Core, type Core as CoreNode } from "./src/core.ts";
import { Expr, type Expr as ExprNode } from "./src/expr.ts";
import { Source } from "./src/frontend.ts";
import { Ic } from "./src/ic.ts";
import { Mod } from "./src/mod.ts";
import { Data, Emit, Typed } from "./src/trait.ts";

const decoder = new TextDecoder();

function log_error(label: string, bytes: Uint8Array): void {
  if (bytes.length > 0) {
    console.error(`${label}:\n${decoder.decode(bytes)}`);
  }
}

function wat_from_expr(expr: ExprNode): string {
  const data = Data.data(Expr, expr);
  const mod: Mod = {
    funcs: {
      main: {
        name: "main",
        result: Typed.type(Expr, expr),
        body: Emit.emit(Expr, expr),
      },
    },
    exports: ["main"],
  };

  if (data.length > 0) {
    mod.memory = {
      name: "memory",
      pages: 1,
      export_name: "memory",
    };
    mod.data = data;
  }

  return Emit.emit(Mod, mod);
}

function wat_from_source(text: string): string {
  const ic = Source.compile(text);
  const expr = Emit.emit(Ic, ic);
  return wat_from_expr(expr);
}

function wat_from_core_source(text: string): string {
  return Source.wat(text);
}

async function instantiate_wat(
  wat_text: string,
  name: string,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const dir = await Deno.makeTempDir();
  const wat_file = dir + "/" + name + ".wat";
  const wasm_file = dir + "/" + name + ".wasm";

  try {
    await Deno.writeTextFile(wat_file, wat_text);

    const compile = await new Deno.Command("wat2wasm", {
      args: [wat_file, "-o", wasm_file],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (compile.stderr.length > 0) {
      log_error("wat2wasm stderr", compile.stderr);
    }

    if (!compile.success) {
      throw new Error("wat2wasm failed");
    }

    const wasm_bytes = await Deno.readFile(wasm_file);
    const { instance } = await WebAssembly.instantiate(wasm_bytes, imports);
    return instance;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("main writes WAT that compiles and instantiates", async () => {
  const wat_file = "build/out.wat";
  const wasm_file = "build/out.wasm";

  await Deno.mkdir("build", { recursive: true });

  const run_main = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", "main.ts"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!run_main.success) {
    log_error("main.ts failed", run_main.stderr);
    throw new Error("main.ts failed");
  }

  try {
    await Deno.stat(wat_file);
  } catch {
    throw new Error("main.ts did not write " + wat_file);
  }

  const compile = await new Deno.Command("wat2wasm", {
    args: [wat_file, "-o", wasm_file],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (compile.stderr.length > 0) {
    log_error("wat2wasm stderr", compile.stderr);
  }

  if (!compile.success) {
    throw new Error("wat2wasm failed");
  }

  const wasm_bytes = await Deno.readFile(wasm_file);
  const { instance } = await WebAssembly.instantiate(wasm_bytes, {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 33) {
    throw new Error("Expected main() -> 33, got " + result);
  }
});

Deno.test("frontend static range loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let sum = 0

for i in 0..5 {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(wat_text, "range_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("frontend dynamic i64 closure branch compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let flag = 0
let factor: I64 = 2i64
let choose = if flag {
  (x: I64) => x + factor
} else {
  (x: I64) => x + factor + 1i64
}

choose(40i64)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_i64_closure_branch",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 43n) {
    throw new Error("Expected main() -> 43n, got " + result);
  }
});

Deno.test("frontend visible update closure compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let birthday = user => {
  user {
    age: user.age + 1
  }
}

birthday({
  name: "Ada",
  age: 41
}).age
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_visible_update_closure",
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

Deno.test("frontend dynamic visible text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let rename = value => {
  value {
    second: "Grace"
  }
}

let flag = 1
let input = if flag {
  1
} else {
  0
}

get(rename({
  first: "Ada",
  second: "Eve"
})[input], 1)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_visible_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 114) {
    throw new Error("Expected main() -> 114, got " + result);
  }
});

Deno.test("frontend static text collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let total = 0

for byte in "Ada" {
  total = total + byte
}

total
`);
  const instance = await instantiate_wat(wat_text, "text_collection_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 262) {
    throw new Error("Expected main() -> 262, got " + result);
  }

  const runtime_arg_wat = wat_from_source(`
let sum_text = (value: Text) => {
  let total = 0

  for i, byte in value {
    total = total + i + byte
  }

  total
}

sum_text("Ada")
`);
  const runtime_arg_instance = await instantiate_wat(
    runtime_arg_wat,
    "frontend_text_collection_runtime_arg",
    {},
  );

  if (!("main" in runtime_arg_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof runtime_arg_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const runtime_arg_result = runtime_arg_instance.exports.main();

  if (runtime_arg_result !== 265) {
    throw new Error(
      "Expected main() -> 265, got " + runtime_arg_result,
    );
  }
});

Deno.test("frontend same-case shorthand union compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let input = 1
let result = if input {
  .ok(40)
} else {
  .ok(1)
}

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_same_case_shorthand_union",
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

Deno.test("core dynamic range loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(wat_text, "core_range_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("core dynamic range step compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 6
let step = 2
let sum = 0

for i in 0..n by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 6) {
    throw new Error("Expected main() -> 6, got " + result);
  }
});

Deno.test("core negative dynamic range step compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let start = 5
let stop = 0
let step = -2
let sum = 0

for i in start..stop by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_negative_dynamic_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 9) {
    throw new Error("Expected main() -> 9, got " + result);
  }
});

Deno.test("core dynamic zero range step traps through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let step = 0
let sum = 0

for i in 0..n by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_zero_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for dynamic zero range step");
});

Deno.test("core panic traps through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source('panic("boom")');
  const instance = await instantiate_wat(wat_text, "core_panic", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for panic");
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
const user_type = struct {
  age: Int,
  name: Text
}
let flag = 1
let f = if flag {
  (x: Int) => x
} else {
  (x: Int) => x + 1
}

scratch {
  user_type { age: 41, name: "Ada" }
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
const result_type = union {
  ok: Int,
  err: Int
}

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

Deno.test("core range loop break and continue compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let sum = 0

for i in 0..n {
  if i == 3 {
    break
  }

  if i == 1 {
    continue
  }

  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_range_loop_edges",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2) {
    throw new Error("Expected main() -> 2, got " + result);
  }
});

Deno.test("core dynamic tail recursion compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum_down = rec (n, total) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

let input = 4
sum_down(input, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_tail_rec",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("frontend annotated dynamic tail recursion compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum_down = rec (n: Int, total: Int) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

sum_down(5, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_annotated_dynamic_tail_rec",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 15) {
    throw new Error("Expected main() -> 15, got " + result);
  }
});

Deno.test("core type-changing shadowing compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let x = 1
x := 42i64
x
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_type_changing_shadow",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42n) {
    throw new Error("Expected main() -> 42n, got " + result);
  }

  const closure_wat = wat_from_core_source(`
let choose = flag => {
  let value = 1
  value := 42i64
  if flag {
    value
  } else {
    7i64
  }
}

choose(1)
`);
  const closure_instance = await instantiate_wat(
    closure_wat,
    "core_closure_type_changing_shadow",
    {},
  );

  if (!("main" in closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const closure_result = closure_instance.exports.main();

  if (closure_result !== 42n) {
    throw new Error("Expected main() -> 42n, got " + closure_result);
  }
});

Deno.test("core annotated i64 arithmetic compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor
}

add_factor(40i64)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_annotated_i64_arithmetic",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42n) {
    throw new Error("Expected main() -> 42n, got " + result);
  }

  const chained_wat = wat_from_core_source(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor + 1i64
}

add_factor(40i64)
`);
  const chained_instance = await instantiate_wat(
    chained_wat,
    "core_annotated_i64_chained_arithmetic",
    {},
  );

  if (!("main" in chained_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof chained_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const chained_result = chained_instance.exports.main();

  if (chained_result !== 43n) {
    throw new Error("Expected main() -> 43n, got " + chained_result);
  }

  const dynamic_branch_wat = wat_from_core_source(`
let flag = 0
let factor: I64 = 2i64
let choose = (x: I64) => {
  if flag {
    x + factor
  } else {
    x + factor + 1i64
  }
}

choose(40i64)
`);
  const dynamic_branch_instance = await instantiate_wat(
    dynamic_branch_wat,
    "core_annotated_i64_dynamic_branch_arithmetic",
    {},
  );

  if (!("main" in dynamic_branch_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_branch_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_branch_result = dynamic_branch_instance.exports.main();

  if (dynamic_branch_result !== 43n) {
    throw new Error(
      "Expected main() -> 43n, got " + dynamic_branch_result,
    );
  }

  const implicit_wide_fallback_wat = wat_from_core_source(`
let input = 0
let value = if input {
  42i64
}

value
`);
  const implicit_wide_fallback_instance = await instantiate_wat(
    implicit_wide_fallback_wat,
    "core_annotated_i64_implicit_fallback",
    {},
  );

  if (!("main" in implicit_wide_fallback_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof implicit_wide_fallback_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const implicit_wide_fallback_result = implicit_wide_fallback_instance.exports
    .main();

  if (implicit_wide_fallback_result !== 0n) {
    throw new Error(
      "Expected main() -> 0n, got " + implicit_wide_fallback_result,
    );
  }

  const cmp_wat = wat_from_core_source(`
let limit: I64 = 5i64
let below = (x: I64) => {
  x < limit
}

below(3i64)
`);
  const cmp_instance = await instantiate_wat(
    cmp_wat,
    "core_annotated_i64_comparison",
    {},
  );

  if (!("main" in cmp_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof cmp_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const cmp_result = cmp_instance.exports.main();

  if (cmp_result !== 1) {
    throw new Error("Expected main() -> 1, got " + cmp_result);
  }
});

Deno.test("core static collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum = 0

for i, x in { first: 10, second: 32, third: 7 } {
  if i == 1 {
    continue
  }

  if x == 7 {
    break
  }

  sum = sum + i + x
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("core visible text collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let total = 0

for i, byte in "Ada" {
  if i == 1 {
    continue
  }

  if byte == 97 {
    break
  }

  total = total + byte
}

total
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 65) {
    throw new Error("Expected main() -> 65, got " + result);
  }

  const closure_wat = wat_from_core_source(`
let sum_text = (value: Text) => {
  let total = 0

  for byte in value {
    total = total + byte
  }

  total
}

sum_text("Ada")
`);
  const closure_instance = await instantiate_wat(
    closure_wat,
    "core_text_collection_let_closure",
    {},
  );

  if (!("main" in closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const closure_result = closure_instance.exports.main();

  if (closure_result !== 262) {
    throw new Error("Expected main() -> 262, got " + closure_result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let sum_text = if flag {
  (value: Text) => {
    let total = 0

    for i, byte in value {
      total = total + i + byte
    }

    total
  }
} else {
  (value: Text) => len(value)
}

sum_text("Ada")
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_first_class_text_collection_loop",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 265) {
    throw new Error("Expected main() -> 265, got " + first_class_result);
  }

  const capture_wat = wat_from_core_source(`
let factor = 2
let scale = x => x + factor
factor = 3
scale(10)
`);
  const capture_instance = await instantiate_wat(
    capture_wat,
    "core_runtime_capture_let_closure",
    {},
  );

  if (!("main" in capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const capture_result = capture_instance.exports.main();

  if (capture_result !== 12) {
    throw new Error("Expected main() -> 12, got " + capture_result);
  }

  const param_assign_wat = wat_from_core_source(`
let inc = x => {
  x = x + 1
  x
}

inc(41)
`);
  const param_assign_instance = await instantiate_wat(
    param_assign_wat,
    "core_closure_parameter_assignment",
    {},
  );

  if (!("main" in param_assign_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof param_assign_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const param_assign_result = param_assign_instance.exports.main();

  if (param_assign_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + param_assign_result,
    );
  }

  const local_shadow_wat = wat_from_core_source(`
let factor = 2
let f = x => {
  let factor = x
  factor
}

f(10) + factor
`);
  const local_shadow_instance = await instantiate_wat(
    local_shadow_wat,
    "core_closure_local_shadow",
    {},
  );

  if (!("main" in local_shadow_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof local_shadow_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const local_shadow_result = local_shadow_instance.exports.main();

  if (local_shadow_result !== 12) {
    throw new Error("Expected main() -> 12, got " + local_shadow_result);
  }

  const assigned_capture_wat = wat_from_core_source(`
let factor = 2
let f = x => {
  factor = factor + x
  factor
}

factor = 100
f(10) + f(20) + factor
`);
  const assigned_capture_instance = await instantiate_wat(
    assigned_capture_wat,
    "core_static_closure_assigned_capture",
    {},
  );

  if (!("main" in assigned_capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof assigned_capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const assigned_capture_result = assigned_capture_instance.exports.main();

  if (assigned_capture_result !== 134) {
    throw new Error(
      "Expected main() -> 134, got " + assigned_capture_result,
    );
  }
});

Deno.test("core first-class closures compile through WAT to Wasm", async () => {
  const dynamic_wat = wat_from_core_source(`
let flag = 1
let f = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

f(40)
`);
  const dynamic_instance = await instantiate_wat(
    dynamic_wat,
    "core_first_class_closure_dynamic",
    {},
  );

  if (!("main" in dynamic_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_result = dynamic_instance.exports.main();

  if (dynamic_result !== 41) {
    throw new Error("Expected main() -> 41, got " + dynamic_result);
  }

  const frozen_wat = wat_from_core_source(`
let f = freeze ((x: Int) => x + 1)
f(41)
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_first_class_closure_freeze",
    {},
  );

  if (!("main" in frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const frozen_result = frozen_instance.exports.main();

  if (frozen_result !== 42) {
    throw new Error("Expected frozen main() -> 42, got " + frozen_result);
  }

  const scratch_frozen_wat = wat_from_core_source(`
let f = scratch { freeze ((x: Int) => x + 1) }
f(41)
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_first_class_closure_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 42) {
    throw new Error(
      "Expected scratch frozen main() -> 42, got " + scratch_frozen_result,
    );
  }

  const block_scratch_frozen_wat = wat_from_core_source(`
let f = scratch {
  let inner = (x: Int) => x + 1
  freeze inner
}
f(41)
`);
  const block_scratch_frozen_instance = await instantiate_wat(
    block_scratch_frozen_wat,
    "core_first_class_closure_block_scratch_freeze",
    {},
  );

  if (!("main" in block_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof block_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const block_scratch_frozen_result = block_scratch_frozen_instance.exports
    .main();

  if (block_scratch_frozen_result !== 42) {
    throw new Error(
      "Expected block scratch frozen main() -> 42, got " +
        block_scratch_frozen_result,
    );
  }

  const branch_scratch_frozen_wat = wat_from_core_source(`
let flag = 0
let f = scratch {
  if flag {
    freeze ((x: Int) => x + 1)
  } else {
    freeze ((x: Int) => x + 2)
  }
}
f(41)
`);
  const branch_scratch_frozen_instance = await instantiate_wat(
    branch_scratch_frozen_wat,
    "core_first_class_closure_branch_scratch_freeze",
    {},
  );

  if (!("main" in branch_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof branch_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const branch_scratch_frozen_result = branch_scratch_frozen_instance.exports
    .main();

  if (branch_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected branch scratch frozen main() -> 43, got " +
        branch_scratch_frozen_result,
    );
  }

  const if_let_matching_wat = wat_from_core_source(`
let flag = 1
const result_type = union {
  ok: Int,
  err: Int
}

let result: result_type = if flag {
  .ok(40)
} else {
  .err(1)
}

let f = if let .ok(value) = result {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`);
  const if_let_matching_instance = await instantiate_wat(
    if_let_matching_wat,
    "core_first_class_closure_if_let_matching",
    {},
  );

  if (!("main" in if_let_matching_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof if_let_matching_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const if_let_matching_result = if_let_matching_instance.exports.main();

  if (if_let_matching_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + if_let_matching_result,
    );
  }

  const if_let_fallback_wat = wat_from_core_source(`
let flag = 0
const result_type = union {
  ok: Int,
  err: Int
}

let result: result_type = if flag {
  .ok(40)
} else {
  .err(1)
}

let f = if let .ok(value) = result {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`);
  const if_let_fallback_instance = await instantiate_wat(
    if_let_fallback_wat,
    "core_first_class_closure_if_let_fallback",
    {},
  );

  if (!("main" in if_let_fallback_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof if_let_fallback_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const if_let_fallback_result = if_let_fallback_instance.exports.main();

  if (if_let_fallback_result !== 3) {
    throw new Error(
      "Expected main() -> 3, got " + if_let_fallback_result,
    );
  }

  const capture_wat = wat_from_core_source(`
let flag = 0
let n = 2
let f = if flag {
  (x: Int) => x + n
} else {
  (x: Int) => x + n + 1
}

n = 100
f(40)
`);
  const capture_instance = await instantiate_wat(
    capture_wat,
    "core_first_class_closure_capture",
    {},
  );

  if (!("main" in capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const capture_result = capture_instance.exports.main();

  if (capture_result !== 43) {
    throw new Error("Expected main() -> 43, got " + capture_result);
  }

  const dynamic_text_capture_wat = wat_from_core_source(`
let flag = 1
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let make = (value: Text) => {
  if flag {
    (x: Int) => len(value) + x
  } else {
    (x: Int) => x
  }
}

let f = make(message)
f(1)
`);
  const dynamic_text_capture_instance = await instantiate_wat(
    dynamic_text_capture_wat,
    "core_first_class_closure_dynamic_text_capture",
    {},
  );

  if (!("main" in dynamic_text_capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_text_capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_text_capture_result = dynamic_text_capture_instance.exports
    .main();

  if (dynamic_text_capture_result !== 4) {
    throw new Error(
      "Expected main() -> 4, got " + dynamic_text_capture_result,
    );
  }

  const captured_text_assign_wat = wat_from_core_source(`
let run = (text: Text, flag: Int) => {
  let f = if flag {
    (byte: Int) => {
      text[0] = byte
      text[0]
    }
  } else {
    (byte: Int) => text[0]
  }

  f(90)
}

run("Ada", 1)
`);
  const captured_text_assign_instance = await instantiate_wat(
    captured_text_assign_wat,
    "core_first_class_closure_captured_text_assign",
    {},
  );

  if (!("main" in captured_text_assign_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_text_assign_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_text_assign_result = captured_text_assign_instance.exports
    .main();

  if (captured_text_assign_result !== 90) {
    throw new Error(
      "Expected main() -> 90, got " + captured_text_assign_result,
    );
  }

  const captured_closure_wat = wat_from_core_source(`
let flag = 1
let add = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}
let run = (y: Int) => add(y) + 10

run(30)
`);
  const captured_closure_instance = await instantiate_wat(
    captured_closure_wat,
    "core_first_class_closure_captures_closure",
    {},
  );

  if (!("main" in captured_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_closure_result = captured_closure_instance.exports.main();

  if (captured_closure_result !== 41) {
    throw new Error(
      "Expected main() -> 41, got " + captured_closure_result,
    );
  }

  const assigned_capture_wat = wat_from_core_source(`
let flag = 1
let factor = 2
let f = if flag {
  (x: Int) => {
    factor = factor + x
    factor
  }
} else {
  (x: Int) => {
    factor = factor + x + 1
    factor
  }
}

factor = 100
f(10) + f(20) + factor
`);
  const assigned_capture_instance = await instantiate_wat(
    assigned_capture_wat,
    "core_first_class_closure_assigned_capture",
    {},
  );

  if (!("main" in assigned_capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof assigned_capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const assigned_capture_result = assigned_capture_instance.exports.main();

  if (assigned_capture_result !== 134) {
    throw new Error(
      "Expected main() -> 134, got " + assigned_capture_result,
    );
  }

  const returned_closure_wat = wat_from_core_source(`
let make = n => {
  let offset = n + 1
  (x: Int) => x + offset
}

let f = make(1)
f(40)
`);
  const returned_closure_instance = await instantiate_wat(
    returned_closure_wat,
    "core_first_class_closure_returned_from_static_call",
    {},
  );

  if (!("main" in returned_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof returned_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const returned_closure_result = returned_closure_instance.exports.main();

  if (returned_closure_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + returned_closure_result,
    );
  }

  const returned_wide_closure_wat = wat_from_core_source(`
let make = (n: I64) => {
  let offset: I64 = n + 1i64
  (x: I64) => x + offset
}

let f = make(1i64)
f(40i64)
`);
  const returned_wide_closure_instance = await instantiate_wat(
    returned_wide_closure_wat,
    "core_first_class_wide_closure_returned_from_static_call",
    {},
  );

  if (!("main" in returned_wide_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof returned_wide_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const returned_wide_closure_result = returned_wide_closure_instance.exports
    .main();

  if (returned_wide_closure_result !== 42n) {
    throw new Error(
      "Expected main() -> 42n, got " + returned_wide_closure_result,
    );
  }
});

Deno.test("core static-call block collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

const sum = (pair: pair_type) => {
  let total = 0

  for i, x in pair {
    total = total + i + x
  }

  total
}

sum({
  first: 10,
  second: 31
})
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_call_block_collection_loop",
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

Deno.test("core dynamic shaped collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let sum = 0

for i, x in if flag {
  { first: 10, second: 20 }
} else {
  { first: 1, second: 2 }
} {
  sum = sum + i + x
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_shaped_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 31) {
    throw new Error("Expected main() -> 31, got " + result);
  }

  const const_call_wat = wat_from_core_source(`
let flag = 1
let sum = 0

const make_xs = active => {
  if active {
    { first: 10, second: 20 }
  } else {
    { first: 1, second: 2 }
  }
}

for i, x in make_xs(flag) {
  sum = sum + i + x
}

sum
`);
  const const_call = await instantiate_wat(
    const_call_wat,
    "core_const_call_shaped_collection_loop",
    {},
  );

  if (!("main" in const_call.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof const_call.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const const_call_result = const_call.exports.main();

  if (const_call_result !== 31) {
    throw new Error("Expected main() -> 31, got " + const_call_result);
  }
});

Deno.test("core static aggregate bindings compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let user = { name: 1, age: 41 }
let total = 0

for i, x in xs {
  total = total + i + x
}

total + xs[1] + user.age
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_aggregate_bindings",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 92) {
    throw new Error("Expected main() -> 92, got " + result);
  }

  const scratch_free_wat = wat_from_core_source(`
let x = 40
let user = scratch { { age: x + 1, bonus: 1 } }
user.age + user.bonus
`);
  const scratch_free_instance = await instantiate_wat(
    scratch_free_wat,
    "core_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_free_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_free_result = scratch_free_instance.exports.main();

  if (scratch_free_result !== 42) {
    throw new Error(
      "Expected scratch-free main() -> 42, got " + scratch_free_result,
    );
  }

  const annotated_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: "Ada" }
}
user.age + len(user.name)
`);
  const annotated_scratch_free_instance = await instantiate_wat(
    annotated_scratch_free_wat,
    "core_annotated_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in annotated_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof annotated_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const annotated_scratch_free_result = annotated_scratch_free_instance.exports
    .main();

  if (annotated_scratch_free_result !== 44) {
    throw new Error(
      "Expected annotated scratch-free main() -> 44, got " +
        annotated_scratch_free_result,
    );
  }

  const block_setup_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let temp: Text = freeze append("Ada", "!")
  user_type { age: 40, name: temp }
}
user.age + len(user.name)
`);
  const block_setup_scratch_free_instance = await instantiate_wat(
    block_setup_scratch_free_wat,
    "core_block_setup_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in block_setup_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof block_setup_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const block_setup_scratch_free_result = block_setup_scratch_free_instance
    .exports.main();

  if (block_setup_scratch_free_result !== 44) {
    throw new Error(
      "Expected block setup scratch-free main() -> 44, got " +
        block_setup_scratch_free_result,
    );
  }

  const block_alias_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let name: Text = freeze append("Ada", "!")
  let temp: user_type = user_type { age: 40, name: name }
  temp
}
user.age + len(user.name)
`);
  const block_alias_scratch_free_instance = await instantiate_wat(
    block_alias_scratch_free_wat,
    "core_block_alias_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in block_alias_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof block_alias_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const block_alias_scratch_free_result = block_alias_scratch_free_instance
    .exports.main();

  if (block_alias_scratch_free_result !== 44) {
    throw new Error(
      "Expected block alias scratch-free main() -> 44, got " +
        block_alias_scratch_free_result,
    );
  }
});

Deno.test("core dynamic aggregate index expression compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 32 }
let i = 1

xs[i]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_aggregate_index_expr",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 32) {
    throw new Error("Expected main() -> 32, got " + result);
  }
});

Deno.test("core aggregate len and get compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 32 }
let i = 1

len(xs) + get(xs, i) + get(xs, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_aggregate_len_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 44) {
    throw new Error("Expected main() -> 44, got " + result);
  }
});

Deno.test("core runtime aggregate collection facts compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let i = 1
let total = 0

for index, value in pair {
  total = total + index + value
}

len(pair) * 1000 + get(pair, i) * 100 + pair[0] * 10 + total
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_collection_facts",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5242) {
    throw new Error("Expected main() -> 5242, got " + result);
  }

  const nested_wat = wat_from_core_source(`
const scores_type = struct {
  first: Int,
  second: Int
}
const user_type = struct {
  scores: scores_type,
  bonus: Int
}

let flag = 1
let make_scores = if flag {
  () => scores_type { first: 10, second: 20 }
} else {
  () => scores_type { first: 1, second: 2 }
}
let scores: scores_type = make_scores()
let make_user = if flag {
  () => user_type { scores: scores, bonus: 1 }
} else {
  () => user_type { scores: scores, bonus: 2 }
}
let user: user_type = make_user()
let total = 0

for index, score in user.scores {
  total = total + index + score
}

total + user.bonus
`);
  const nested_instance = await instantiate_wat(
    nested_wat,
    "core_runtime_aggregate_nested_collection_facts",
    {},
  );

  if (!("main" in nested_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested_instance.exports.main();

  if (nested_result !== 32) {
    throw new Error("Expected nested main() -> 32, got " + nested_result);
  }

  const control_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let total = 0

for index, value in pair {
  if index == 0 {
    continue
  }

  total = total + value

  if index == 1 {
    break
  }

  total = total + 100
}

total
`);
  const control_instance = await instantiate_wat(
    control_wat,
    "core_runtime_aggregate_collection_control",
    {},
  );

  if (!("main" in control_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof control_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const control_result = control_instance.exports.main();

  if (control_result !== 31) {
    throw new Error(
      "Expected control main() -> 31, got " + control_result,
    );
  }
});

Deno.test("core runtime aggregate scalar index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
pair[0] = 40
let i = 1
pair[i] = 2
pair.first + pair.second
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_scalar_index_assignment",
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

  const trap_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let i = 2
pair[i] = 99
pair.first
`);
  const trap_instance = await instantiate_wat(
    trap_wat,
    "core_runtime_aggregate_scalar_index_assignment_oob",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error(
    "Expected main() to trap for runtime aggregate index assignment",
  );
});

Deno.test("core runtime aggregate Text index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
names[0] = "Edsger"
let i = 1
names[i] = names.first + " Hopper"
len(names.first) * 100 + len(names.second)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_text_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 613) {
    throw new Error("Expected main() -> 613, got " + result);
  }
});

Deno.test("core runtime aggregate union index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

const slots_type = struct {
  first: result_type,
  second: result_type
}

let keep = "x"
let flag = 1
let make_slots = if flag {
  (first: Int, second: Int) => slots_type {
    first: result_type.ok(first),
    second: result_type.err(second)
  }
} else {
  (first: Int, second: Int) => slots_type {
    first: result_type.err(first),
    second: result_type.ok(second)
  }
}
let slots: slots_type = make_slots(1, 2)
slots[0] = result_type.err(40)
let i = 1
slots[i] = result_type.ok(2)
slots
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_union_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return an aggregate pointer");
  }

  const view = new DataView(instance.exports.memory.buffer);
  const first = view.getInt32(result, true);
  const second = view.getInt32(result + 4, true);

  if (view.getInt32(first, true) !== 1) {
    throw new Error("Expected first union tag -> 1");
  }

  if (view.getInt32(first + 4, true) !== 40) {
    throw new Error("Expected first union payload -> 40");
  }

  if (view.getInt32(second, true) !== 0) {
    throw new Error("Expected second union tag -> 0");
  }

  if (view.getInt32(second + 4, true) !== 2) {
    throw new Error("Expected second union payload -> 2");
  }
});

Deno.test("core captured runtime aggregate union index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

const slots_type = struct {
  first: result_type,
  second: result_type
}

let keep = "x"
let flag = 1
let make_slots = if flag {
  (first: Int, second: Int) => slots_type {
    first: result_type.ok(first),
    second: result_type.err(second)
  }
} else {
  (first: Int, second: Int) => slots_type {
    first: result_type.err(first),
    second: result_type.ok(second)
  }
}
let slots: slots_type = make_slots(1, 2)
let write = if flag {
  (i: Int, value: Int) => {
    slots[i] = result_type.ok(value)
    0
  }
} else {
  (i: Int, value: Int) => {
    slots[i] = result_type.err(value)
    0
  }
}

write(1, 2)
slots
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_captured_runtime_aggregate_union_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return an aggregate pointer");
  }

  const view = new DataView(instance.exports.memory.buffer);
  const first = view.getInt32(result, true);
  const second = view.getInt32(result + 4, true);

  if (view.getInt32(first, true) !== 0) {
    throw new Error("Expected first union tag -> 0");
  }

  if (view.getInt32(first + 4, true) !== 1) {
    throw new Error("Expected first union payload -> 1");
  }

  if (view.getInt32(second, true) !== 0) {
    throw new Error("Expected second union tag -> 0");
  }

  if (view.getInt32(second + 4, true) !== 2) {
    throw new Error("Expected second union payload -> 2");
  }
});

Deno.test("core runtime aggregate nested index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
slots[0] = pair_type { left: 10, right: 20 }
let i = 1
slots[i] = pair_type { left: 5, right: 7 }
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_nested_index_assignment",
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

Deno.test("core captured runtime aggregate nested index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
let write = if flag {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: left, right: right }
    0
  }
} else {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: right, right: left }
    0
  }
}

write(1, 5, 7)
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_captured_runtime_aggregate_nested_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 15) {
    throw new Error("Expected main() -> 15, got " + result);
  }
});

Deno.test("core captured runtime aggregate Text index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let write = if flag {
  (i: Int, suffix: Text) => {
    names[i] = names.first + suffix
    len(names.second)
  }
} else {
  (i: Int, suffix: Text) => {
    names[i] = suffix
    len(names.second)
  }
}

write(1, " Hopper")
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_captured_runtime_aggregate_text_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("core captured runtime aggregate scalar index assignment compiles through WAT to Wasm", async () => {
  const static_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = (i: Int, value: Int) => {
  pair[i] = value
  pair.first + pair.second
}

write(0, 40) + write(1, 2)
`);
  const static_instance = await instantiate_wat(
    static_wat,
    "core_captured_runtime_aggregate_static_index_assignment",
    {},
  );

  if (!("main" in static_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof static_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const static_result = static_instance.exports.main();

  if (static_result !== 113) {
    throw new Error("Expected main() -> 113, got " + static_result);
  }

  const first_class_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = if flag {
  (i: Int, value: Int) => {
    pair[i] = value
    pair.first + pair.second
  }
} else {
  (i: Int, value: Int) => {
    pair[i] = value + 1
    pair.first + pair.second
  }
}

write(0, 40) + write(1, 2)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_captured_runtime_aggregate_first_class_index_assignment",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 113) {
    throw new Error(
      "Expected main() -> 113, got " + first_class_result,
    );
  }
});

Deno.test("core runtime aggregate text collection facts compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let i = 1
let picked: Text = get(names, i)
let first: Text = names[0]
let view: Text = ""
let total = 0

for index, name in names {
  view = borrow name
  total = total + index + len(name)
}

len(names) * 1000 + len(picked) * 100 + len(first) * 10 + total + len(view)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_text_collection_facts",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2544) {
    throw new Error("Expected main() -> 2544, got " + result);
  }
});

Deno.test("core static aggregate runtime captures compile through WAT to Wasm", async () => {
  const struct_wat = wat_from_core_source(`
let a = 1
let xs = { first: a, second: 2 }
a = 9
xs[0] + xs[1]
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_static_aggregate_struct_capture",
    {},
  );

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (struct_result !== 3) {
    throw new Error("Expected main() -> 3, got " + struct_result);
  }

  const union_wat = wat_from_core_source(`
let payload = 41
let result = .ok(payload)
payload = 1
if let .ok(x) = result {
  x
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_static_aggregate_union_capture",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 41) {
    throw new Error("Expected main() -> 41, got " + union_result);
  }
});

Deno.test("core runtime aggregate field loads compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")

len(user.name) + user.age
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_field_loads",
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
    throw new Error("Expected main() -> 43, got " + result);
  }

  const frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let frozen: user_type = freeze user

len(frozen.name) + frozen.age
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_runtime_aggregate_freeze",
    {},
  );

  if (!("main" in frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const frozen_result = frozen_instance.exports.main();

  if (frozen_result !== 43) {
    throw new Error("Expected frozen main() -> 43, got " + frozen_result);
  }

  const scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let user: user_type = scratch {
  freeze user_type { name: append(prefix, "da"), age: 40 }
}

len(user.name) + user.age
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_runtime_aggregate_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 43) {
    throw new Error(
      "Expected scratch frozen main() -> 43, got " + scratch_frozen_result,
    );
  }

  const bound_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let user: user_type = scratch {
  let temp: user_type = user_type { name: append(prefix, "da"), age: 40 }
  freeze temp
}

len(user.name) + user.age
`);
  const bound_scratch_frozen_instance = await instantiate_wat(
    bound_scratch_frozen_wat,
    "core_runtime_aggregate_bound_scratch_freeze",
    {},
  );

  if (!("main" in bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof bound_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const bound_scratch_frozen_result = bound_scratch_frozen_instance.exports
    .main();

  if (bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected bound scratch frozen main() -> 43, got " +
        bound_scratch_frozen_result,
    );
  }

  const existing_alias_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

len(user.name) + user.age
`);
  const existing_alias_scratch_frozen_instance = await instantiate_wat(
    existing_alias_scratch_frozen_wat,
    "core_runtime_aggregate_existing_alias_scratch_freeze",
    {},
  );

  if (!("main" in existing_alias_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof existing_alias_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const existing_alias_scratch_frozen_result =
    existing_alias_scratch_frozen_instance.exports.main();

  if (existing_alias_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected existing alias scratch frozen main() -> 43, got " +
        existing_alias_scratch_frozen_result,
    );
  }

  const branch_assignment_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }
if flag {
  existing = user_type { name: append(prefix, "!"), age: 41 }
} else {
  existing = user_type { name: append(prefix, "?"), age: 42 }
}
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

len(user.name) + user.age
`);
  const branch_assignment_scratch_frozen_instance = await instantiate_wat(
    branch_assignment_scratch_frozen_wat,
    "core_runtime_aggregate_branch_assignment_scratch_freeze",
    {},
  );

  if (!("main" in branch_assignment_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof branch_assignment_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const branch_assignment_scratch_frozen_result =
    branch_assignment_scratch_frozen_instance.exports.main();

  if (branch_assignment_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected branch assignment scratch frozen main() -> 43, got " +
        branch_assignment_scratch_frozen_result,
    );
  }

  const nested_wat = wat_from_core_source(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  age: Int,
  name: name_type
}

let flag = 1
let make = if flag {
  (first: Text) => user_type {
    age: 40,
    name: name_type { first: first, last: "Lovelace" }
  }
} else {
  (first: Text) => user_type {
    age: 5,
    name: name_type { first: first, last: "Hopper" }
  }
}
let user: user_type = make("Ada")
let name: name_type = user.name

len(name.first) + len(name.last) + user.age
`);
  const nested_instance = await instantiate_wat(
    nested_wat,
    "core_runtime_aggregate_nested_field_alias",
    {},
  );

  if (!("main" in nested_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested_instance.exports.main();

  if (nested_result !== 51) {
    throw new Error("Expected main() -> 51, got " + nested_result);
  }

  const captured_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 41 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let get_age = if flag {
  () => user.age
} else {
  () => user.age + 1
}

get_age()
`);
  const captured_instance = await instantiate_wat(
    captured_wat,
    "core_runtime_aggregate_closure_capture",
    {},
  );

  if (!("main" in captured_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_result = captured_instance.exports.main();

  if (captured_result !== 41) {
    throw new Error("Expected main() -> 41, got " + captured_result);
  }
});

Deno.test("core runtime scalar Text and struct union values compile through WAT to Wasm memory", async () => {
  const direct_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let keep = "x"

result_type.ok(41)
`);
  const direct_instance = await instantiate_wat(
    direct_wat,
    "core_runtime_union_direct",
    {},
  );

  if (!("memory" in direct_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(direct_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in direct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof direct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const direct_result = direct_instance.exports.main();

  if (typeof direct_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const direct_view = new DataView(direct_instance.exports.memory.buffer);

  if (direct_view.getInt32(direct_result, true) !== 0) {
    throw new Error("Expected direct union tag -> 0");
  }

  if (direct_view.getInt32(direct_result + 4, true) !== 41) {
    throw new Error("Expected direct union payload -> 41");
  }

  const frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let result: result_type = freeze result_type.ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_runtime_union_freeze",
    {},
  );

  if (!("main" in frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const frozen_result = frozen_instance.exports.main();

  if (frozen_result !== 42) {
    throw new Error("Expected frozen main() -> 42, got " + frozen_result);
  }

  const scratch_frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let result: result_type = scratch {
  freeze result_type.ok(append(prefix, "da"))
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_runtime_union_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 3) {
    throw new Error(
      "Expected scratch frozen main() -> 3, got " + scratch_frozen_result,
    );
  }

  const bound_scratch_frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let result: result_type = scratch {
  let temp = result_type.ok(append(prefix, "da"))
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const bound_scratch_frozen_instance = await instantiate_wat(
    bound_scratch_frozen_wat,
    "core_runtime_union_bound_scratch_freeze",
    {},
  );

  if (!("main" in bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof bound_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const bound_scratch_frozen_result = bound_scratch_frozen_instance.exports
    .main();

  if (bound_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected bound scratch frozen main() -> 3, got " +
        bound_scratch_frozen_result,
    );
  }

  const branch_alias_scratch_frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: result_type = if flag {
  result_type.ok(append(prefix, "da"))
} else {
  result_type.err(5)
}
let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const branch_alias_scratch_frozen_instance = await instantiate_wat(
    branch_alias_scratch_frozen_wat,
    "core_runtime_union_branch_alias_scratch_freeze",
    {},
  );

  if (!("main" in branch_alias_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof branch_alias_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const branch_alias_scratch_frozen_result =
    branch_alias_scratch_frozen_instance.exports.main();

  if (branch_alias_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected branch alias scratch frozen main() -> 3, got " +
        branch_alias_scratch_frozen_result,
    );
  }

  const branch_assignment_scratch_frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: result_type = result_type.err(5)

if flag {
  existing = result_type.ok(append(prefix, "da"))
} else {
  existing = result_type.err(7)
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const branch_assignment_scratch_frozen_instance = await instantiate_wat(
    branch_assignment_scratch_frozen_wat,
    "core_runtime_union_branch_assignment_scratch_freeze",
    {},
  );

  if (!("main" in branch_assignment_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof branch_assignment_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const branch_assignment_scratch_frozen_result =
    branch_assignment_scratch_frozen_instance.exports.main();

  if (branch_assignment_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected branch assignment scratch frozen main() -> 3, got " +
        branch_assignment_scratch_frozen_result,
    );
  }

  const aggregate_bound_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let result: result_type = scratch {
  let temp = result_type.ok(user_type { name: append(prefix, "da"), age: 40 })
  freeze temp
}

if let .ok(user) = result {
  len(user.name) + user.age
} else {
  0
}
`);
  const aggregate_bound_scratch_frozen_instance = await instantiate_wat(
    aggregate_bound_scratch_frozen_wat,
    "core_runtime_union_aggregate_bound_scratch_freeze",
    {},
  );

  if (!("main" in aggregate_bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof aggregate_bound_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const aggregate_bound_scratch_frozen_result =
    aggregate_bound_scratch_frozen_instance.exports.main();

  if (aggregate_bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected aggregate bound scratch frozen main() -> 43, got " +
        aggregate_bound_scratch_frozen_result,
    );
  }

  const union_payload_bound_scratch_frozen_wat = wat_from_core_source(`
const inner_type = union {
  some: Text,
  none: Unit
}
const outer_type = union {
  ok: inner_type,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let result: outer_type = scratch {
  let temp = outer_type.ok(inner_type.some(append(prefix, "da")))
  freeze temp
}

if let .ok(inner) = result {
  if let .some(value) = inner {
    len(value)
  } else {
    0
  }
} else {
  0
}
`);
  const union_payload_bound_scratch_frozen_instance = await instantiate_wat(
    union_payload_bound_scratch_frozen_wat,
    "core_runtime_union_payload_bound_scratch_freeze",
    {},
  );

  if (!("main" in union_payload_bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof union_payload_bound_scratch_frozen_instance.exports.main !==
      "function"
  ) {
    throw new Error("main export is not a function");
  }

  const union_payload_bound_scratch_frozen_result =
    union_payload_bound_scratch_frozen_instance.exports.main();

  if (union_payload_bound_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected union payload bound scratch frozen main() -> 3, got " +
        union_payload_bound_scratch_frozen_result,
    );
  }

  const aggregate_union_field_bound_scratch_frozen_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}
const box_type = struct {
  result: result_type,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let box: box_type = scratch {
  let temp = box_type { result: result_type.ok(append(prefix, "da")), age: 40 }
  freeze temp
}

if let .ok(value) = box.result {
  len(value) + box.age
} else {
  0
}
`);
  const aggregate_union_field_bound_scratch_frozen_instance =
    await instantiate_wat(
      aggregate_union_field_bound_scratch_frozen_wat,
      "core_runtime_aggregate_union_field_bound_scratch_freeze",
      {},
    );

  if (
    !("main" in aggregate_union_field_bound_scratch_frozen_instance.exports)
  ) {
    throw new Error("Missing main export");
  }

  if (
    typeof aggregate_union_field_bound_scratch_frozen_instance.exports.main !==
      "function"
  ) {
    throw new Error("main export is not a function");
  }

  const aggregate_union_field_bound_scratch_frozen_result =
    aggregate_union_field_bound_scratch_frozen_instance.exports.main();

  if (aggregate_union_field_bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected aggregate union field bound scratch frozen main() -> 43, got " +
        aggregate_union_field_bound_scratch_frozen_result,
    );
  }

  const dynamic_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let keep = "x"
let flag = 0

if flag {
  result_type.ok(41)
} else {
  result_type.err(7)
}
`);
  const dynamic_instance = await instantiate_wat(
    dynamic_wat,
    "core_runtime_union_dynamic",
    {},
  );

  if (!("memory" in dynamic_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(dynamic_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in dynamic_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_result = dynamic_instance.exports.main();

  if (typeof dynamic_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const dynamic_view = new DataView(dynamic_instance.exports.memory.buffer);

  if (dynamic_view.getInt32(dynamic_result, true) !== 1) {
    throw new Error("Expected dynamic union tag -> 1");
  }

  if (dynamic_view.getInt32(dynamic_result + 4, true) !== 7) {
    throw new Error("Expected dynamic union payload -> 7");
  }

  const wide_wat = wat_from_core_source(`
const result_type = union {
  ok: I64,
  err: Unit
}

let keep = "x"

result_type.ok(41i64)
`);
  const wide_instance = await instantiate_wat(
    wide_wat,
    "core_runtime_union_i64",
    {},
  );

  if (!("memory" in wide_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(wide_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in wide_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof wide_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const wide_result = wide_instance.exports.main();

  if (typeof wide_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const wide_view = new DataView(wide_instance.exports.memory.buffer);

  if (wide_view.getInt32(wide_result, true) !== 0) {
    throw new Error("Expected wide union tag -> 0");
  }

  if (wide_view.getBigInt64(wide_result + 4, true) !== 41n) {
    throw new Error("Expected wide union payload -> 41");
  }

  const text_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}

let keep = "x"

result_type.ok("Ada")
`);
  const text_instance = await instantiate_wat(
    text_wat,
    "core_runtime_union_text",
    {},
  );

  if (!("memory" in text_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(text_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text_instance.exports.main();

  if (typeof text_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const text_view = new DataView(text_instance.exports.memory.buffer);

  if (text_view.getInt32(text_result, true) !== 0) {
    throw new Error("Expected text union tag -> 0");
  }

  const text_payload = text_view.getInt32(text_result + 4, true);

  if (text_view.getInt32(text_payload, true) !== 3) {
    throw new Error("Expected text union payload length -> 3");
  }

  const struct_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let keep = "x"

result_type.ok(user_type { age: 40, score: 2 })
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_runtime_union_struct",
    {},
  );

  if (!("memory" in struct_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(struct_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (typeof struct_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const struct_view = new DataView(struct_instance.exports.memory.buffer);

  if (struct_view.getInt32(struct_result, true) !== 0) {
    throw new Error("Expected struct union tag -> 0");
  }

  const struct_payload = struct_view.getInt32(struct_result + 4, true);

  if (struct_view.getInt32(struct_payload, true) !== 40) {
    throw new Error("Expected struct union age -> 40");
  }

  if (struct_view.getInt32(struct_payload + 4, true) !== 2) {
    throw new Error("Expected struct union score -> 2");
  }
});

Deno.test("core stored runtime union pointer if let compiles through WAT to Wasm", async () => {
  const matching_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1
let make = if flag {
  (x: Int) => result_type.ok(x)
} else {
  (x: Int) => result_type.err(x)
}
let result: result_type = make(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);
  const matching = await instantiate_wat(
    matching_wat,
    "core_stored_runtime_union_match",
    {},
  );

  if (!("main" in matching.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof matching.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const matching_result = matching.exports.main();

  if (matching_result !== 42) {
    throw new Error("Expected main() -> 42, got " + matching_result);
  }

  const fallback_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 0
let make = if flag {
  (x: Int) => result_type.ok(x)
} else {
  (x: Int) => result_type.err(x)
}
let result: result_type = make(7)

if let .ok(value) = result {
  value + 1
} else {
  5
}
`);
  const fallback = await instantiate_wat(
    fallback_wat,
    "core_stored_runtime_union_fallback",
    {},
  );

  if (!("main" in fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const fallback_result = fallback.exports.main();

  if (fallback_result !== 5) {
    throw new Error("Expected main() -> 5, got " + fallback_result);
  }

  const captured_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1
let make = if flag {
  (x: Int) => result_type.ok(x)
} else {
  (x: Int) => result_type.err(x)
}
let result: result_type = make(41)
let read_result = if flag {
  (x: Int) => {
    if let .ok(value) = result {
      value + x
    } else {
      x
    }
  }
} else {
  (x: Int) => x
}

read_result(1)
`);
  const captured = await instantiate_wat(
    captured_wat,
    "core_captured_runtime_union",
    {},
  );

  if (!("main" in captured.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_result = captured.exports.main();

  if (captured_result !== 42) {
    throw new Error("Expected main() -> 42, got " + captured_result);
  }

  const text_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}

let flag = 1
let make = if flag {
  (x: Text) => result_type.ok(x)
} else {
  (x: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const text = await instantiate_wat(
    text_wat,
    "core_stored_runtime_union_text",
    {},
  );

  if (!("main" in text.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text.exports.main();

  if (text_result !== 3) {
    throw new Error("Expected main() -> 3, got " + text_result);
  }

  const struct_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (name: Text) => result_type.ok(user_type { name: name, age: 40 })
} else {
  (name: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(user) = result {
  len(user.name) + user.age
} else {
  0
}
`);
  const struct = await instantiate_wat(
    struct_wat,
    "core_stored_runtime_union_struct",
    {},
  );

  if (!("main" in struct.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct.exports.main();

  if (struct_result !== 43) {
    throw new Error("Expected main() -> 43, got " + struct_result);
  }

  const nested_wat = wat_from_core_source(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  name: name_type,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (first: Text) => result_type.ok(user_type {
    name: name_type { first: first, last: "Lovelace" },
    age: 40
  })
} else {
  (first: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(user) = result {
  len(user.name.first) + len(user.name.last) + user.age
} else {
  0
}
`);
  const nested = await instantiate_wat(
    nested_wat,
    "core_stored_runtime_union_nested_struct",
    {},
  );

  if (!("main" in nested.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested.exports.main();

  if (nested_result !== 51) {
    throw new Error("Expected main() -> 51, got " + nested_result);
  }

  const aggregate_pointer_payload_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = result_type.ok(user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`);
  const aggregate_pointer_payload = await instantiate_wat(
    aggregate_pointer_payload_wat,
    "core_stored_runtime_union_aggregate_pointer_payload",
    {},
  );

  if (!("main" in aggregate_pointer_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof aggregate_pointer_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const aggregate_pointer_payload_result = aggregate_pointer_payload.exports
    .main();

  if (aggregate_pointer_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + aggregate_pointer_payload_result,
    );
  }

  const union_payload_wat = wat_from_core_source(`
const inner_type = union {
  some: Int,
  none: Unit
}
const outer_type = union {
  ok: inner_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (value: Int) => outer_type.ok(inner_type.some(value))
} else {
  (value: Int) => outer_type.err()
}
let result: outer_type = make(41)

if let .ok(inner) = result {
  if let .some(value) = inner {
    value + 1
  } else {
    0
  }
} else {
  0
}
`);
  const union_payload = await instantiate_wat(
    union_payload_wat,
    "core_stored_runtime_union_union_payload",
    {},
  );

  if (!("main" in union_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_payload_result = union_payload.exports.main();

  if (union_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + union_payload_result,
    );
  }

  const nested_union_wat = wat_from_core_source(`
const inner_type = union {
  some: Int,
  none: Unit
}
const box_type = struct {
  inner: inner_type,
  bonus: Int
}
const result_type = union {
  ok: box_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (value: Int) => result_type.ok(box_type {
    inner: inner_type.some(value),
    bonus: 1
  })
} else {
  (value: Int) => result_type.err()
}
let result: result_type = make(41)

if let .ok(box) = result {
  if let .some(value) = box.inner {
    value + box.bonus
  } else {
    0
  }
} else {
  0
}
`);
  const nested_union = await instantiate_wat(
    nested_union_wat,
    "core_stored_runtime_union_nested_union_field",
    {},
  );

  if (!("main" in nested_union.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_union.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_union_result = nested_union.exports.main();

  if (nested_union_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + nested_union_result,
    );
  }
});

Deno.test("core struct update compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let user = { age: 40, score: 2 }
let next = 41
let updated = user { age: next }
next = 1
updated.age + user.age + updated.score
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_struct_update",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 83) {
    throw new Error("Expected main() -> 83, got " + result);
  }
});

Deno.test("core dynamic aggregate if bindings compile through WAT to Wasm", async () => {
  const struct_wat = wat_from_core_source(`
let flag = 0
let user = if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}

flag = 1
user.age + user.score
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_dynamic_struct_if_binding",
    {},
  );

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (struct_result !== 42) {
    throw new Error("Expected main() -> 42, got " + struct_result);
  }

  const union_wat = wat_from_core_source(`
let flag = 1
let payload = 41
let result = if flag {
  .ok(payload)
} else {
  .err(7)
}

flag = 0
payload = 1
if let .ok(value) = result {
  value + 1
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_dynamic_union_if_binding",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 42) {
    throw new Error("Expected main() -> 42, got " + union_result);
  }
});

Deno.test("core direct dynamic aggregate if access compiles through WAT to Wasm", async () => {
  const field_wat = wat_from_core_source(`
let flag = 0

(if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}).age
`);
  const field_instance = await instantiate_wat(
    field_wat,
    "core_direct_dynamic_struct_if_field",
    {},
  );

  if (!("main" in field_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof field_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const field_result = field_instance.exports.main();

  if (field_result !== 32) {
    throw new Error("Expected main() -> 32, got " + field_result);
  }

  const index_wat = wat_from_core_source(`
let flag = 0
let i = 1

(if flag {
  { first: 41, second: 1 }
} else {
  { first: 32, second: 10 }
})[i]
`);
  const index_instance = await instantiate_wat(
    index_wat,
    "core_direct_dynamic_struct_if_index",
    {},
  );

  if (!("main" in index_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof index_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const index_result = index_instance.exports.main();

  if (index_result !== 10) {
    throw new Error("Expected main() -> 10, got " + index_result);
  }

  const union_wat = wat_from_core_source(`
let flag = 0
let left = 41
let right = 32
let result = if flag {
  .ok(left)
} else {
  .ok(right)
}

left = 1
right = 2
if let .ok(value) = result {
  value
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_same_case_dynamic_union_if",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 32) {
    throw new Error("Expected main() -> 32, got " + union_result);
  }
});

Deno.test("core if else statements compile through WAT to Wasm", async () => {
  const then_wat = wat_from_core_source(`
let flag = 1
let value = 0

if flag {
  value = 10
} else {
  value = 20
}

value
`);
  const then_instance = await instantiate_wat(
    then_wat,
    "core_if_else_statement_then",
    {},
  );

  if (!("main" in then_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof then_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const then_result = then_instance.exports.main();

  if (then_result !== 10) {
    throw new Error("Expected main() -> 10, got " + then_result);
  }

  const else_wat = wat_from_core_source(`
let flag = 0
let value = 0

if flag {
  value = 10
} else {
  value = 20
}

value
`);
  const else_instance = await instantiate_wat(
    else_wat,
    "core_if_else_statement_else",
    {},
  );

  if (!("main" in else_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof else_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const else_result = else_instance.exports.main();

  if (else_result !== 20) {
    throw new Error("Expected main() -> 20, got " + else_result);
  }

  const aggregate_wat = wat_from_core_source(`
let flag = 1
let user = { age: 0, score: 0 }

if flag {
  user = { age: 41, score: 1 }
} else {
  user = { age: 32, score: 9 }
}

flag = 0
user.age + user.score
`);
  const aggregate_instance = await instantiate_wat(
    aggregate_wat,
    "core_if_else_static_aggregate_assign",
    {},
  );

  if (!("main" in aggregate_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof aggregate_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const aggregate_result = aggregate_instance.exports.main();

  if (aggregate_result !== 42) {
    throw new Error("Expected main() -> 42, got " + aggregate_result);
  }

  const text_wat = wat_from_core_source(`
let flag = 1
let message = ""

if flag {
  message = "hi"
} else {
  message = "world"
}

flag = 0
len(message)
`);
  const text_instance = await instantiate_wat(
    text_wat,
    "core_if_else_static_text_assign",
    {},
  );

  if (!("main" in text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text_instance.exports.main();

  if (text_result !== 2) {
    throw new Error("Expected main() -> 2, got " + text_result);
  }
});

Deno.test("core static aggregate index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let value = 32

xs[1] = value
xs[0] + xs[1]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_aggregate_index_assign",
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

  const captured_closure_wat = wat_from_core_source(`
let pair = { first: 1, second: 2 }
let f = i => {
  pair[i] = 40
  pair[0] + pair[1]
}

let a = f(0)
let b = f(1)
a + b + pair[0] + pair[1]
`);
  const captured_closure_instance = await instantiate_wat(
    captured_closure_wat,
    "core_captured_static_aggregate_index_assign",
    {},
  );

  if (!("main" in captured_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_closure_result = captured_closure_instance.exports.main();

  if (captured_closure_result !== 86) {
    throw new Error(
      "Expected main() -> 86, got " + captured_closure_result,
    );
  }

  const param_closure_wat = wat_from_core_source(`
let update = xs => {
  xs[0] = 40
  xs[0] + xs[1]
}

let pair = { first: 1, second: 2 }
update(pair) + pair[0] + pair[1]
`);
  const param_closure_instance = await instantiate_wat(
    param_closure_wat,
    "core_static_aggregate_param_index_assign",
    {},
  );

  if (!("main" in param_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof param_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const param_closure_result = param_closure_instance.exports.main();

  if (param_closure_result !== 45) {
    throw new Error("Expected main() -> 45, got " + param_closure_result);
  }
});

Deno.test("core dynamic aggregate index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let i = 0
let value = 32

xs[i] = value
xs[0] + xs[1]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_aggregate_index_assign",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 52) {
    throw new Error("Expected main() -> 52, got " + result);
  }

  const text_wat = wat_from_core_source(`
let messages = { first: "Ada", second: "Grace" }
let i = 1
let next = "Edsger"

messages[i] = next
next = "Nope"
len(messages[1])
`);
  const text_instance = await instantiate_wat(
    text_wat,
    "core_dynamic_text_index_assign",
    {},
  );

  if (!("main" in text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text_instance.exports.main();

  if (text_result !== 6) {
    throw new Error("Expected main() -> 6, got " + text_result);
  }
});

Deno.test("core static if let compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let result = 0
const result_type = union {
  ok: Int,
  err: Int
}
const option_type = union {
  some: Int,
  none: Unit
}
let typed_result = result_type.ok(1)
let none_result = option_type.none()

if let .ok(x) = .ok(41) {
  result = x + 1
}

if let .ok(y) = .err(9) {
  result = y
}

if let .ok(z) = typed_result {
  result = result + z
}

if let .none = none_result {
  result = result + 1
}

result
`);
  const instance = await instantiate_wat(wat_text, "core_static_if_let", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 44) {
    throw new Error("Expected main() -> 44, got " + result);
  }

  const scratch_union_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}
let value = scratch { result_type.ok(41) }
if let .ok(x) = value { x + 1 } else { 0 }
`);
  const scratch_union_instance = await instantiate_wat(
    scratch_union_wat,
    "core_scratch_static_union",
    {},
  );

  if (!("main" in scratch_union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_result = scratch_union_instance.exports.main();

  if (scratch_union_result !== 42) {
    throw new Error(
      "Expected scratch union main() -> 42, got " + scratch_union_result,
    );
  }

  const scratch_union_block_setup_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Int
}
let result: result_type = scratch {
  let temp: Text = freeze append("Ada", "!")
  result_type.ok(temp)
}
if let .ok(value) = result { len(value) } else { 0 }
`);
  const scratch_union_block_setup_instance = await instantiate_wat(
    scratch_union_block_setup_wat,
    "core_scratch_static_union_block_setup",
    {},
  );

  if (!("main" in scratch_union_block_setup_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_block_setup_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_block_setup_result = scratch_union_block_setup_instance
    .exports.main();

  if (scratch_union_block_setup_result !== 4) {
    throw new Error(
      "Expected scratch union block setup main() -> 4, got " +
        scratch_union_block_setup_result,
    );
  }

  const scratch_union_block_alias_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Int
}
let result: result_type = scratch {
  let name: Text = freeze append("Ada", "!")
  let temp: result_type = result_type.ok(name)
  temp
}
if let .ok(value) = result { len(value) } else { 0 }
`);
  const scratch_union_block_alias_instance = await instantiate_wat(
    scratch_union_block_alias_wat,
    "core_scratch_static_union_block_alias",
    {},
  );

  if (!("main" in scratch_union_block_alias_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_block_alias_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_block_alias_result = scratch_union_block_alias_instance
    .exports.main();

  if (scratch_union_block_alias_result !== 4) {
    throw new Error(
      "Expected scratch union block alias main() -> 4, got " +
        scratch_union_block_alias_result,
    );
  }

  const scratch_dynamic_union_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}
let flag = 1
let value = scratch {
  if flag {
    result_type.ok(41)
  } else {
    result_type.err(9)
  }
}
if let .ok(x) = value { x + 1 } else { 0 }
`);
  const scratch_dynamic_union_instance = await instantiate_wat(
    scratch_dynamic_union_wat,
    "core_scratch_dynamic_static_union",
    {},
  );

  if (!("main" in scratch_dynamic_union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_dynamic_union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_dynamic_union_result = scratch_dynamic_union_instance.exports
    .main();

  if (scratch_dynamic_union_result !== 42) {
    throw new Error(
      "Expected scratch dynamic union main() -> 42, got " +
        scratch_dynamic_union_result,
    );
  }
});

Deno.test("core generic type constructors compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const option_type = t => union {
  some: t,
  none: Unit
}

const result_type = e => t => union {
  ok: t,
  err: e
}

const parse_result_type = result_type(Text)(Int)

let direct = option_type(Int).some(40)
let typed: parse_result_type = .ok(1)

let total = if let .some(x) = direct {
  x
} else {
  0
}

if let .ok(value) = typed {
  total + value + 1
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_generic_type_constructor",
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

Deno.test("core static if let expressions compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let result = if let .ok(x) = .ok(41) {
  x + 1
} else {
  0
}

let fallback = if let .ok(y) = .err(9) {
  y
} else {
  5
}

result + fallback
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_if_let_expr",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 47) {
    throw new Error("Expected main() -> 47, got " + result);
  }

  const wide_fallback_wat = wat_from_core_source(`
const result_type = union {
  ok: I64,
  err: I64
}

let result: result_type = .err(1i64)
let value = if let .ok(found) = result {
  found + 1i64
}

value
`);
  const wide_fallback = await instantiate_wat(
    wide_fallback_wat,
    "core_static_i64_if_let_implicit_fallback",
    {},
  );

  if (!("main" in wide_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof wide_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const wide_fallback_result = wide_fallback.exports.main();

  if (wide_fallback_result !== 0n) {
    throw new Error("Expected main() -> 0n, got " + wide_fallback_result);
  }

  const text_if_fallback_wat = wat_from_core_source(`
let flag = 0
let selected: Text = if flag {
  "Ada"
}

len(selected)
`);
  const text_if_fallback = await instantiate_wat(
    text_if_fallback_wat,
    "core_static_text_if_implicit_fallback",
    {},
  );

  if (!("main" in text_if_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_if_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_if_fallback_result = text_if_fallback.exports.main();

  if (text_if_fallback_result !== 0) {
    throw new Error(
      "Expected main() -> 0, got " + text_if_fallback_result,
    );
  }

  const text_if_let_fallback_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Text
}

let result: result_type = .err("no")
let selected: Text = if let .ok(value) = result {
  value
}

len(selected)
`);
  const text_if_let_fallback = await instantiate_wat(
    text_if_let_fallback_wat,
    "core_static_text_if_let_implicit_fallback",
    {},
  );

  if (!("main" in text_if_let_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_if_let_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_if_let_fallback_result = text_if_let_fallback.exports.main();

  if (text_if_let_fallback_result !== 0) {
    throw new Error(
      "Expected main() -> 0, got " + text_if_let_fallback_result,
    );
  }
});

Deno.test("core dynamic union-if if let compiles through WAT to Wasm", async () => {
  const matching_wat = wat_from_core_source(`
let input = 1
let value = if let .ok(x) = if input {
  .ok(41)
} else {
  .err(7)
} {
  x + 1
} else {
  5
}

value
`);
  const matching = await instantiate_wat(
    matching_wat,
    "core_dynamic_union_if_let_matching",
    {},
  );

  if (!("main" in matching.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof matching.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const matching_result = matching.exports.main();

  if (matching_result !== 42) {
    throw new Error("Expected main() -> 42, got " + matching_result);
  }

  const fallback_wat = wat_from_core_source(`
let input = 0
let value = if let .ok(x) = if input {
  .ok(41)
} else {
  .err(7)
} {
  x + 1
} else {
  5
}

value
`);
  const fallback = await instantiate_wat(
    fallback_wat,
    "core_dynamic_union_if_let_fallback",
    {},
  );

  if (!("main" in fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const fallback_result = fallback.exports.main();

  if (fallback_result !== 5) {
    throw new Error("Expected main() -> 5, got " + fallback_result);
  }

  const typed_wat = wat_from_core_source(`
let input = 1
const result_type = union {
  ok: Int,
  err: Int
}

let result = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
}

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const typed = await instantiate_wat(
    typed_wat,
    "core_dynamic_typed_union_if_let",
    {},
  );

  if (!("main" in typed.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_result = typed.exports.main();

  if (typed_result !== 42) {
    throw new Error("Expected main() -> 42, got " + typed_result);
  }

  const typed_struct_payload_wat = wat_from_core_source(`
let input = 1
const user_type = struct {
  age: Int,
  score: Int
}

const result_type = union {
  ok: user_type,
  err: user_type
}

let result: result_type = if input {
  .ok(user_type {
    age: 40,
    score: 2
  })
} else {
  .err(user_type {
    age: 5,
    score: 1
  })
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);
  const typed_struct_payload = await instantiate_wat(
    typed_struct_payload_wat,
    "core_dynamic_typed_struct_payload_union_if_let",
    {},
  );

  if (!("main" in typed_struct_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_struct_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_struct_payload_result = typed_struct_payload.exports.main();

  if (typed_struct_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + typed_struct_payload_result,
    );
  }

  const typed_wide_wat = wat_from_core_source(`
let input = 0
const result_type = union {
  ok: I64,
  err: I64
}

let result: result_type = if input {
  .ok(40i64)
} else {
  .err(1i64)
}

let selected = if let .ok(value) = result {
  value + 2i64
}

selected
`);
  const typed_wide = await instantiate_wat(
    typed_wide_wat,
    "core_dynamic_typed_i64_union_if_let_implicit_fallback",
    {},
  );

  if (!("main" in typed_wide.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_wide.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_wide_result = typed_wide.exports.main();

  if (typed_wide_result !== 0n) {
    throw new Error("Expected main() -> 0n, got " + typed_wide_result);
  }

  const typed_text_wat = wat_from_core_source(`
let input = 0
const result_type = union {
  ok: Text,
  err: Text
}

let result: result_type = if input {
  .ok("Ada")
} else {
  .err("Grace")
}

let selected: Text = if let .ok(value) = result {
  value
}

len(selected)
`);
  const typed_text = await instantiate_wat(
    typed_text_wat,
    "core_dynamic_typed_text_union_if_let_implicit_fallback",
    {},
  );

  if (!("main" in typed_text.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_text.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_text_result = typed_text.exports.main();

  if (typed_text_result !== 0) {
    throw new Error("Expected main() -> 0, got " + typed_text_result);
  }

  const const_call_wat = wat_from_core_source(`
let input = 1

const result_type = union {
  ok: Int,
  err: Int
}

const make_result = flag => {
  if flag {
    result_type.ok(40)
  } else {
    result_type.err(1)
  }
}

let result = make_result(input)

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const const_call = await instantiate_wat(
    const_call_wat,
    "core_dynamic_const_call_union_if_let",
    {},
  );

  if (!("main" in const_call.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof const_call.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const const_call_result = const_call.exports.main();

  if (const_call_result !== 42) {
    throw new Error("Expected main() -> 42, got " + const_call_result);
  }
});

Deno.test("core type checks compile away through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let struct { age: Int, .. } = user_type

41
`);
  const instance = await instantiate_wat(wat_text, "core_type_check", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 41) {
    throw new Error("Expected main() -> 41, got " + result);
  }
});

Deno.test("core binding annotations compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let x: Int = 40
let label: Text = "ok"

x + len(label)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_binding_annotations",
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

Deno.test("core direct type annotations compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const int_type = Int

const result_type = union {
  ok: int_type,
  err: Int
}

const alias_type = result_type

let result: alias_type = .ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_direct_type_annotations",
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

  const dynamic_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

let input = 0
let result: result_type = if input {
  result_type.ok(40)
} else {
  result_type.err(7)
}

if let .ok(value) = result {
  value + 1
} else {
  5
}
`);
  const dynamic_instance = await instantiate_wat(
    dynamic_wat,
    "core_dynamic_direct_union_annotation",
    {},
  );

  if (!("main" in dynamic_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_result = dynamic_instance.exports.main();

  if (dynamic_result !== 5) {
    throw new Error("Expected main() -> 5, got " + dynamic_result);
  }

  const dynamic_text_wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Text
}

let input = 1
let left = "Ada"
let right = "Grace"
let result: result_type = if input {
  result_type.ok(left)
} else {
  result_type.err(right)
}

input = 0
left = "Zoe"
right = "Ida"

let value = if let .ok(text) = result {
  text
} else {
  ""
}

len(value)
`);
  const dynamic_text_instance = await instantiate_wat(
    dynamic_text_wat,
    "core_dynamic_direct_union_text_annotation",
    {},
  );

  if (!("main" in dynamic_text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_text_result = dynamic_text_instance.exports.main();

  if (dynamic_text_result !== 3) {
    throw new Error(
      "Expected main() -> 3, got " + dynamic_text_result,
    );
  }
});

Deno.test("core direct parameter annotations compile through WAT to Wasm", async () => {
  const struct_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

const sum_pair = (pair: pair_type) => {
  pair.first + pair.second
}

sum_pair({
  first: 40,
  second: 2
})
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_direct_parameter_struct_annotation",
    {},
  );

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (struct_result !== 42) {
    throw new Error("Expected main() -> 42, got " + struct_result);
  }

  const union_wat = wat_from_core_source(`
const result_type = union {
  ok: Int,
  err: Int
}

const unwrap = (result: result_type) => {
  if let .ok(value) = result {
    value + 1
  } else {
    0
  }
}

unwrap(.ok(41))
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_direct_parameter_union_annotation",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 42) {
    throw new Error("Expected main() -> 42, got " + union_result);
  }
});

Deno.test("core text literal compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source('"hi"');
  const instance = await instantiate_wat(wat_text, "core_text_literal", {});

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

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 6);

  if (bytes[0] !== 2) {
    throw new Error("Expected core text length byte 0 -> 2, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected core text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected core text byte 1 -> 105, got " + bytes[5]);
  }
});

Deno.test("core text concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source('"hi" + "!"');
  const instance = await instantiate_wat(wat_text, "core_text_concat", {});

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

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 7);

  if (bytes[0] !== 3) {
    throw new Error("Expected core text length byte 0 -> 3, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected core text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected core text byte 1 -> 105, got " + bytes[5]);
  }

  if (bytes[6] !== 33) {
    throw new Error("Expected core text byte 2 -> 33, got " + bytes[6]);
  }

  const runtime_wat = wat_from_core_source(`
let flag = 1
let append = if flag {
  (left: Text, right: Text) => left + right
} else {
  (left: Text, right: Text) => right + left
}

append("hi", "!")
`);
  const runtime_instance = await instantiate_wat(
    runtime_wat,
    "core_runtime_text_concat",
    {},
  );

  if (!("memory" in runtime_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(runtime_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in runtime_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof runtime_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const runtime_result = runtime_instance.exports.main();

  if (typeof runtime_result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const runtime_memory = runtime_instance.exports.memory;
  const runtime_bytes = new Uint8Array(
    runtime_memory.buffer,
    runtime_result,
    7,
  );

  if (runtime_bytes[0] !== 3) {
    throw new Error(
      "Expected runtime text length byte 0 -> 3, got " + runtime_bytes[0],
    );
  }

  if (runtime_bytes[4] !== 104) {
    throw new Error(
      "Expected runtime text byte 0 -> 104, got " + runtime_bytes[4],
    );
  }

  if (runtime_bytes[5] !== 105) {
    throw new Error(
      "Expected runtime text byte 1 -> 105, got " + runtime_bytes[5],
    );
  }

  if (runtime_bytes[6] !== 33) {
    throw new Error(
      "Expected runtime text byte 2 -> 33, got " + runtime_bytes[6],
    );
  }
});

Deno.test("core visible text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let message = if flag {
  "hi"
} else {
  "world"
}

flag = 0
len(message)
`);
  const instance = await instantiate_wat(wat_text, "core_text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2) {
    throw new Error("Expected main() -> 2, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let byte_len = if flag {
  (value: Text) => len(value)
} else {
  (value: Text) => len(value) + 1
}

byte_len("Ada")
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_runtime_text_len",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 3) {
    throw new Error("Expected main() -> 3, got " + first_class_result);
  }
});

Deno.test("core dynamic text index compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source(`
let messages = {
  first: "Ada",
  second: "Grace"
}

let i = if 1 {
  1
} else {
  0
}

messages[i]
`);
  const instance = await instantiate_wat(wat_text, "core_text_index", {});

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

  if (result !== 8) {
    throw new Error("Expected main() -> 8, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 8, 9);

  if (bytes[0] !== 5) {
    throw new Error(
      "Expected selected text length byte 0 -> 5, got " + bytes[0],
    );
  }

  if (bytes[4] !== 71) {
    throw new Error("Expected selected text byte 0 -> 71, got " + bytes[4]);
  }

  if (bytes[8] !== 101) {
    throw new Error("Expected selected text byte 4 -> 101, got " + bytes[8]);
  }
});

Deno.test("core dynamic text index concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source(`
let messages = {
  first: "Ada",
  second: "Grace"
}

let i = if 1 {
  1
} else {
  0
}

messages[i] + "!"
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_index_concat",
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
    throw new Error("Expected main() to return a pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 10);

  if (bytes[0] !== 6) {
    throw new Error(
      "Expected selected concatenated text length byte 0 -> 6, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 71) {
    throw new Error(
      "Expected selected concatenated text byte 0 -> 71, got " + bytes[4],
    );
  }

  if (bytes[9] !== 33) {
    throw new Error(
      "Expected selected concatenated text byte 5 -> 33, got " + bytes[9],
    );
  }
});

Deno.test("core dynamic text index len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let messages = {
  first: "Ada",
  second: "Grace"
}

let i = if 1 {
  1
} else {
  0
}

len(messages[i])
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_index_len",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("core dynamic text byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = if 1 {
  2
} else {
  0
}

message[i]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let byte_at = if flag {
  (value: Text, i: Int) => value[i]
} else {
  (value: Text, i: Int) => get(value, i)
}

byte_at("Ada", 2)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_runtime_text_byte_index",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 97) {
    throw new Error("Expected main() -> 97, got " + first_class_result);
  }
});

Deno.test("core runtime text byte assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let write_byte = (message: Text, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte("Ada", 1, 111)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_text_byte_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 111) {
    throw new Error("Expected main() -> 111, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let write_byte = if flag {
  (message: Text, i: Int, value: Int) => {
    message[i] = value
    message[i]
  }
} else {
  (message: Text, i: Int, value: Int) => {
    message[i] = value + 1
    message[i]
  }
}

write_byte("Ada", 1, 111)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_first_class_text_byte_assignment",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 111) {
    throw new Error(
      "Expected main() -> 111, got " + first_class_result,
    );
  }

  const trap_wat = wat_from_core_source(`
let write_byte = (message: Text, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte("Ada", 3, 111)
`);
  const trap_instance = await instantiate_wat(
    trap_wat,
    "core_runtime_text_byte_assignment_oob",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text byte assignment");
});

Deno.test("core dynamic text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = if 1 {
  1
} else {
  0
}

get(message, i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 100) {
    throw new Error("Expected main() -> 100, got " + result);
  }
});

Deno.test("core dynamic text get traps out of bounds", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = 3

get(message, i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_get_trap",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for out-of-bounds text get");
});

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
host_import host_read from "env.read" (bounded_borrow Text) => I32

let message: Text = append("he", "llo")
host_read(borrow message)
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
host_import print from "env.print" (I32, bounded_borrow Text) => I32

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

Deno.test(
  "frontend captured linear capability closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

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
host_import print from "env.print" (I32, bounded_borrow Text) => I32

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
  "frontend branch-selected linear closure alpha-renames params through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  (message: Text) => io.print(borrow message)
} else {
  (text: Text) => io.print(borrow text)
}
io = print_once("world")
io
`);
    let calls = 0;
    let printed = "";
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
const result_type = union {
  ok: Int,
  err: Int
}

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
const result_type = union {
  ok: Text,
  err: Text
}

host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 1
let result: result_type = if flag {
  result_type.ok("world")
} else {
  result_type.err("fallback")
}
let print_once = if let .ok(value) = result {
  () => io.print(borrow value)
} else {
  () => io.print("fallback")
}
io = print_once()
io
`);
    let calls = 0;
    let printed = "";
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

Deno.test(
  "frontend runtime-union Text payload closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
const result_type = union {
  ok: Text,
  err: Unit
}

host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 1
let make = if flag {
  (x: Text) => result_type.ok(x)
} else {
  (x: Text) => result_type.err()
}
let result: result_type = make("world")
let print_once = if let .ok(value) = result {
  () => io.print(borrow value)
} else {
  () => io.print("fallback")
}
io = print_once()
io
`);
    let calls = 0;
    let printed = "";
    let memory: WebAssembly.Memory | undefined;
    const instance = await instantiate_wat(
      wat,
      "frontend_runtime_union_text_payload_closure",
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
      throw new Error("Expected runtime union payload to print world");
    }
  },
);

Deno.test(
  "frontend first-class linear capability closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

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
          func: { tag: "var", name: "append" },
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
                  func: { tag: "var", name: "append" },
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
            func: { tag: "var", name: "append" },
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
          func: { tag: "var", name: "append" },
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 0
let send = if flag {
  (msg: Text) => host_take(msg)
} else {
  (msg: Text) => host_take(msg)
}
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
send(append("he", "llo"))
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(append(msg, "!"))
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let flag = 0
send(if flag { append("he", "llo") } else { append("wo", "rld") })
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 1
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = rec (msg: Text) => host_take(msg)
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => f(msg)
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(msg)
let relay = (const f, msg: Text) => f(append(msg, "!"))
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => {
  let g = f
  g(msg)
}
let message: Text = append("he", "llo")
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
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(msg)
let flag = 1
let relay = if flag {
  (const f, msg: Text) => {
    let g = f
    g(append(msg, "!"))
  }
} else {
  (const f, msg: Text) => {
    let g = f
    g(append(msg, "?"))
  }
}
let message: Text = append("he", "llo")
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

Deno.test("frontend text literal compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_source('"hi"');
  const instance = await instantiate_wat(wat_text, "text_literal", {});

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

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 6);

  if (bytes[0] !== 2) {
    throw new Error("Expected text length byte 0 -> 2, got " + bytes[0]);
  }

  if (bytes[1] !== 0) {
    throw new Error("Expected text length byte 1 -> 0, got " + bytes[1]);
  }

  if (bytes[2] !== 0) {
    throw new Error("Expected text length byte 2 -> 0, got " + bytes[2]);
  }

  if (bytes[3] !== 0) {
    throw new Error("Expected text length byte 3 -> 0, got " + bytes[3]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected text byte 1 -> 105, got " + bytes[5]);
  }
});

Deno.test("frontend text concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_source('"hi" + "!"');
  const instance = await instantiate_wat(wat_text, "text_concat", {});

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

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 7);

  if (bytes[0] !== 3) {
    throw new Error("Expected text length byte 0 -> 3, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected text byte 1 -> 105, got " + bytes[5]);
  }

  if (bytes[6] !== 33) {
    throw new Error("Expected text byte 2 -> 33, got " + bytes[6]);
  }
});

Deno.test("frontend text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let message = "hello"
len(message)
`);
  const instance = await instantiate_wat(wat_text, "text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("frontend no-else text fallback compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let flag = 0
let message = if flag {
  "hello"
}

len(message)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_no_else_text",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }
});

Deno.test("frontend runtime text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_len = (value: Text) => {
  len(value)
}

byte_len("hello")
`);
  const instance = await instantiate_wat(wat_text, "runtime_text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("frontend runtime text append compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let add_suffix = (value: Text) => {
  append(value, "!")
}

add_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_runtime_text_append",
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
      "Expected appended text length byte 0 -> 3, got " + bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected appended text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected appended text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected appended text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend runtime text freeze compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let freeze_suffix = (value: Text) => {
  freeze append(value, "!")
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
  scratch { freeze append(value, "!") }
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
    let temp: Text = append(value, "!")
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
    let temp: Text = append(value, "!")
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
    let temp: Text = append(value, "!")
    freeze temp
  }
  len(result)
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
      let inner: Text = append(value, "!")
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
  append(value, "!")
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
      freeze append(value, "!")
    } else {
      freeze append(value, "?")
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
const user_type = struct {
  name: Text,
  age: Int
}

let read_user = flag => {
  let user: user_type = scratch {
    let temp: user_type = if flag {
      user_type {
        name: append("A", "da"),
        age: 1
      }
    } else {
      user_type {
        name: append("Gr", "ace"),
        age: 2
      }
    }

    freeze temp
  }

  len(user.name) + user.age
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

Deno.test("frontend branch-assigned scratch aggregate freeze compiles through WAT to Wasm", async () => {
  async function check_branch(
    flag: number,
    expected: number,
    name: string,
  ): Promise<void> {
    const wat_text = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let read_user = flag => {
  let user: user_type = scratch {
    let temp: user_type = user_type {
      name: append("n", "o"),
      age: 0
    }

    if flag {
      temp = user_type {
        name: append("A", "da"),
        age: 1
      }
    } else {
      temp = user_type {
        name: append("Gr", "ace"),
        age: 2
      }
    }

    freeze temp
  }

  len(user.name) + user.age
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
const result_type = union {
  ok: Text,
  err: Text
}

let read_result = flag => {
  let result: result_type = scratch {
    let temp: result_type = result_type.err(append("n", "o"))

    if flag {
      temp = result_type.ok(append("A", "da"))
    } else {
      temp = result_type.err(append("Gr", "ace"))
    }

    freeze temp
  }

  if let .ok(value) = result {
    len(value)
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
    let temp: Text = append(value, ".")
    if flag {
      temp = append(value, "!")
    } else {
      temp = append(value, "?")
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
    let temp: Text = append("n", "o")
    if flag {
      temp = append("h", "i")
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
    let temp: Text = append(value, ".")
    for i in 0..count {
      temp = append(value, "!")
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
const xs_type = struct {
  first: Int,
  second: Int
}

let freeze_suffix = (value: Text) => {
  let xs: xs_type = xs_type { first: 1, second: 2 }
  scratch {
    let temp: Text = append(value, ".")
    for x in xs {
      temp = append(value, "!")
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
const result_type = union {
  ok: Text,
  err: Text
}

let freeze_result = (flag: Int) => {
  let result: result_type = if flag {
    .ok("hi")
  } else {
    .err("no")
  }

  scratch {
    if let .ok(value) = result {
      freeze append(value, "!")
    } else {
      freeze append("no", "?")
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
const result_type = union {
  ok: Text,
  err: Text
}

let freeze_result = (flag: Int) => {
  let result: result_type = if flag {
    .ok("hi")
  } else {
    .err("no")
  }

  scratch {
    let temp: Text = append("no", ".")
    if let .ok(value) = result {
      temp = append(value, "!")
    }
    if let .err(value) = result {
      temp = append(value, "?")
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
const option_type = union {
  some: Text,
  none: Unit
}

const result_type = union {
  ok: Text,
  err: Text
}

let read_result = (flag: Int) => {
  let maybe: option_type = if flag {
    option_type.some("Ada")
  } else {
    option_type.none()
  }

  let result: result_type = scratch {
    let temp: result_type = result_type.err(append("n", "o"))
    if let .some(name) = maybe {
      temp = result_type.ok(append(name, "!"))
    }
    freeze temp
  }

  if let .ok(value) = result {
    len(value)
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

Deno.test("frontend runtime text equality compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let same = if flag {
  (left: Text, right: Text) => left == right
} else {
  (left: Text, right: Text) => left != right
}
let different = if flag {
  (left: Text, right: Text) => left != right
} else {
  (left: Text, right: Text) => left == right
}

let same_result = same("Ada", "Ada")
let byte_mismatch = same("Ada", "Adb") * 10
let length_mismatch = different("Ada", "Grace") * 100
let not_same_result = different("Ada", "Ada") * 1000

same_result + byte_mismatch + length_mismatch + not_same_result
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_equality",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 101) {
    throw new Error("Expected main() -> 101, got " + result);
  }
});

Deno.test("frontend runtime text slice compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let slicer = if flag {
  (value: Text, start: Int, end: Int) => slice(value, start, end)
} else {
  (value: Text, start: Int, end: Int) => slice(value, start, end)
}

let part: Text = slicer("Grace", 1, 4)
len(part) * 1000 + get(part, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_slice",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 3114) {
    throw new Error("Expected main() -> 3114, got " + result);
  }
});

Deno.test("frontend runtime text slice traps out of bounds", async () => {
  const wat_text = wat_from_core_source(`
let part: Text = slice("Ada", 1, 4)
len(part)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_slice_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text slice");
});

Deno.test("frontend dynamic union text payload len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const result_type = union {
  ok: Text,
  err: Text
}

let flag = 1
let result = if flag {
  result_type.ok("Ada")
} else {
  result_type.err("Grace")
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_text_payload_len",
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

Deno.test("frontend dynamic union struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const user_type = struct {
  age: Int,
  score: Int
}

const result_type = union {
  ok: user_type,
  err: user_type
}

let flag = 1
let result: result_type = if flag {
  .ok(user_type {
    age: 40,
    score: 2
  })
} else {
  .err(user_type {
    age: 5,
    score: 1
  })
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_struct_payload",
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

Deno.test("frontend dynamic union nested struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const name_type = struct {
  first: Text,
  last: Text
}

const user_type = struct {
  name: name_type,
  age: Int
}

const result_type = union {
  ok: user_type,
  err: user_type
}

let flag = 1
let result: result_type = if flag {
  .ok(user_type {
    name: name_type {
      first: "Ada",
      last: "Lovelace"
    },
    age: 40
  })
} else {
  .err(user_type {
    name: name_type {
      first: "Grace",
      last: "Hopper"
    },
    age: 5
  })
}

if let .ok(user) = result {
  len(user.name.first) + len(user.name.last) + user.age
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_nested_struct_payload",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 51) {
    throw new Error("Expected main() -> 51, got " + result);
  }
});

Deno.test("frontend dynamic union shorthand struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const user_type = struct {
  age: Int,
  score: Int
}

const result_type = union {
  ok: user_type,
  err: user_type
}

let flag = 1
let result: result_type = if flag {
  .ok({
    age: 40,
    score: 2
  })
} else {
  .err({
    age: 5,
    score: 1
  })
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_shorthand_struct_payload",
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

Deno.test("frontend runtime text byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 2)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }
});

Deno.test("frontend visible text argument byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value, i) => {
  value[i]
}

let i = 1

byte_at("Ada", i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "visible_text_argument_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 100) {
    throw new Error("Expected main() -> 100, got " + result);
  }
});

Deno.test("frontend text branch byte index traps only selected branch", async () => {
  const ok_wat_text = wat_from_source(`
let flag = 0
let message = if flag {
  "A"
} else {
  "BC"
}

message[1]
`);
  const ok_instance = await instantiate_wat(
    ok_wat_text,
    "visible_text_branch_byte_index_ok",
    {},
  );

  if (!("main" in ok_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof ok_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = ok_instance.exports.main();

  if (result !== 67) {
    throw new Error("Expected main() -> 67, got " + result);
  }

  const trap_wat_text = wat_from_source(`
let flag = 1
let message = if flag {
  "A"
} else {
  "BC"
}

message[1]
`);
  const trap_instance = await instantiate_wat(
    trap_wat_text,
    "visible_text_branch_byte_index_trap",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for selected short text branch");
});

Deno.test("frontend runtime text byte index traps out of bounds", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 3)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_byte_index_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text byte index");
});

Deno.test("frontend runtime text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  get(value, i)
}

byte_at("Ada", 2)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }
});

Deno.test("frontend runtime text get traps out of bounds", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  get(value, i)
}

byte_at("Ada", 3)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_get_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text get");
});

Deno.test("text pointer select compiles through WAT to Wasm memory", async () => {
  const expr: ExprNode = {
    tag: "let",
    name: "flag",
    value: { tag: "num", type: "i32", value: 0 },
    body: {
      tag: "prim",
      type: "i32",
      prim: "i32.select",
      args: [
        { tag: "text", value: "yes" },
        { tag: "text", value: "no" },
        { tag: "var", type: "i32", name: "flag" },
      ],
    },
  };
  const instance = await instantiate_wat(
    wat_from_expr(expr),
    "text_select",
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

  if (result !== 8) {
    throw new Error("Expected main() -> 8, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 8, 6);

  if (bytes[0] !== 2) {
    throw new Error(
      "Expected selected text length byte 0 -> 2, got " + bytes[0],
    );
  }

  if (bytes[4] !== 110) {
    throw new Error("Expected selected text byte 0 -> 110, got " + bytes[4]);
  }

  if (bytes[5] !== 111) {
    throw new Error("Expected selected text byte 1 -> 111, got " + bytes[5]);
  }
});
