import { TestSource as Source } from "./frontend/test_source.ts";
import { Ic } from "./ic.ts";
import {
  instantiate_wat,
  log_error,
  wat_from_core_source,
} from "./wasm_test_util.ts";

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

Deno.test("open Ic numeric input compiles through WAT to Wasm", async () => {
  const doubled_wat = Ic.wat(Source.compile("input + input"));
  const doubled = await instantiate_wat(doubled_wat, "open_ic_double", {});

  if (!("main" in doubled.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof doubled.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const doubled_result = doubled.exports.main(21);

  if (doubled_result !== 42) {
    throw new Error(
      "Expected open Ic main(21) -> 42, got " + doubled_result,
    );
  }

  const branch_wat = Ic.wat(Source.compile(`
if input {
  40
} else {
  2
}
`));
  const branch = await instantiate_wat(branch_wat, "open_ic_branch", {});

  if (!("main" in branch.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof branch.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const then_result = branch.exports.main(1);
  const else_result = branch.exports.main(0);

  if (then_result !== 40) {
    throw new Error("Expected open Ic main(1) -> 40, got " + then_result);
  }

  if (else_result !== 2) {
    throw new Error("Expected open Ic main(0) -> 2, got " + else_result);
  }
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
