import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { Core } from "./core.ts";
import { parse_source } from "./frontend/parser.ts";
import { validate_frontend_semantics } from "./frontend/semantic_validation.ts";
import { source_facts } from "./frontend/source_facts.ts";
import { TestSource as Source } from "./frontend/test_source.ts";
import { instantiate_wat, wat_from_core_source } from "./wasm_test_util.ts";

Deno.test("UTF-8 and numeric format builtins expose explicit source types", () => {
  const source = parse_source(`
@Utf8.encode("Aλ🙂")
@Utf8.decode(Bytes.empty)
@format_i32(-2147483648)
@format_i64(9223372036854775807i64)
@format_f32(1.5f32, 2)
`);
  const facts = source_facts(source);
  const types = source.statements.map((statement) => {
    if (statement.tag !== "expr") {
      throw new Error("Expected builtin expression statement");
    }

    return facts.editor_type_of.get(statement.expr)?.name;
  });
  assert_equals(types, ["Bytes", "Text", "Text", "Text", "Text"]);
  assert_equals(validate_frontend_semantics(source), []);
});

Deno.test("Text and Bytes require explicit UTF-8 conversion at semantic boundaries", () => {
  const implicit_bytes = validate_frontend_semantics(parse_source(`
let bytes: Bytes = "text"
bytes
`));
  assert_equals(
    implicit_bytes.map((diagnostic) => diagnostic.message),
    ["Binding annotation expects Bytes, got Text"],
  );

  const text_write = validate_frontend_semantics(parse_source(`
let text: Text = "text"
text[0] = 65
text
`));
  assert_equals(
    text_write.map((diagnostic) => diagnostic.message),
    ["Cannot index-assign Text; convert it with Utf8.encode first"],
  );

  const wrong_conversions = validate_frontend_semantics(parse_source(`
@Utf8.encode(Bytes.empty)
@Utf8.decode("text")
@append(Bytes.empty, "text")
@format_f32(1, 2)
@format_f32(1.0f32, 2.0f32)
`));
  assert_equals(
    wrong_conversions.map((diagnostic) => diagnostic.message),
    [
      "@Utf8.encode expects Text, got Bytes",
      "@Utf8.decode expects Bytes, got Text",
      "append arguments must both be Text or both be Bytes",
      "@format_f32 expects F32, got I32",
      "format_f32 precision expects I32, got F32",
    ],
  );

  const function_boundaries = validate_frontend_semantics(parse_source(`
let consume = (bytes: Bytes) => @len(bytes)
consume("text")
let make: () -> Bytes = () => "text"
make()
`));
  assert_equals(
    function_boundaries.map((diagnostic) => diagnostic.message),
    [
      "Call to consume argument 1 for parameter bytes expects Bytes, got Text",
      "Function result expects Bytes, got Text",
    ],
  );

  assert_throws(
    () => Source.wat('let bytes: Bytes = "text"\nbytes'),
    "Binding annotation expects Bytes, got Text",
  );
  assert_throws(
    () => Source.wat('let text: Text = "text"\ntext[0] = 65\ntext'),
    "Cannot index-assign Text",
  );
  assert_throws(
    () =>
      Source.wat(
        'let consume = (bytes: Bytes) => @len(bytes)\nconsume("text")',
      ),
    "Call to consume argument 1",
  );
});

Deno.test("Utf8.encode and Utf8.decode copy valid UTF-8 buffers", async () => {
  const empty_instance = await instantiate_wat(
    wat_from_core_source("@Utf8.decode(Bytes.empty)"),
    "utf8_empty",
    {},
  );
  assert_equals(read_result_text(empty_instance), "");

  const wat = wat_from_core_source(`
let bytes: Bytes = @Utf8.encode("Aλ🙂")
bytes[0] = 66
@Utf8.decode(bytes)
`);
  assert_includes(wat, "utf8_validate_loop");
  assert_includes(wat, "i32.store8");
  const instance = await instantiate_wat(wat, "utf8_round_trip", {});
  assert_equals(read_result_text(instance), "Bλ🙂");
});

Deno.test("Utf8.decode traps deterministically for invalid UTF-8", async () => {
  const invalid_sources = [
    "@Bytes.generate(1, index => 255)",
    "@Bytes.generate(2, index => if index == 0 { 192 } else { 128 })",
    "@Bytes.generate(3, index => if index == 0 { 237 } else { 160 })",
    "@Bytes.generate(4, index => if index == 0 { 244 } else { 144 })",
  ];

  for (let index = 0; index < invalid_sources.length; index += 1) {
    const source = invalid_sources[index];

    if (source === undefined) {
      throw new Error("Missing invalid UTF-8 fixture");
    }

    const instance = await instantiate_wat(
      wat_from_core_source("@Utf8.decode(" + source + ")"),
      "invalid_utf8_" + index.toString(),
      {},
    );
    const main = instance.exports.main;

    if (typeof main !== "function") {
      throw new Error("Missing main export");
    }

    assert_throws(() => main(), "unreachable");
  }
});

Deno.test("format_i32 emits exact signed decimal boundaries", async () => {
  const cases = [
    { source: "@format_i32(0)", expected: "0" },
    { source: "@format_i32(-1)", expected: "-1" },
    { source: "@format_i32(2147483647)", expected: "2147483647" },
    { source: "@format_i32(-2147483648)", expected: "-2147483648" },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const test_case = cases[index];

    if (test_case === undefined) {
      throw new Error("Missing i32 format fixture");
    }

    const instance = await instantiate_wat(
      wat_from_core_source("@append(" + test_case.source + ', "")'),
      "format_i32_" + index.toString(),
      {},
    );
    assert_equals(read_result_text(instance), test_case.expected);
  }
});

Deno.test("format_i64 emits exact signed decimal boundaries", async () => {
  const cases = [
    { source: "@format_i64(0i64)", expected: "0" },
    {
      source: "@format_i64(9223372036854775807i64)",
      expected: "9223372036854775807",
    },
    {
      source: "@format_i64(-9223372036854775808i64)",
      expected: "-9223372036854775808",
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const test_case = cases[index];

    if (test_case === undefined) {
      throw new Error("Missing i64 format fixture");
    }

    const wat = wat_from_core_source("@append(" + test_case.source + ', "")');
    assert_includes(wat, "i32.wrap_i64");
    const instance = await instantiate_wat(
      wat,
      "format_i64_" + index.toString(),
      {},
    );
    assert_equals(read_result_text(instance), test_case.expected);
  }
});

Deno.test("format_f32 emits deterministic fixed-point decimal text", async () => {
  const cases = [
    { source: "@format_f32(0.0f32, 0)", expected: "0" },
    { source: "@format_f32(0.0f32 / -1.0f32, 2)", expected: "0.00" },
    { source: "@format_f32(-12.5f32, 3)", expected: "-12.500" },
    { source: "@format_f32(0.125f32, 3)", expected: "0.125" },
    { source: "@format_f32(1.25f32, 1)", expected: "1.3" },
    { source: "@format_f32(1.999f32, 2)", expected: "2.00" },
    { source: "@format_f32(12.5f32, 6)", expected: "12.500000" },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const test_case = cases[index];

    if (test_case === undefined) {
      throw new Error("Missing f32 format fixture");
    }

    const wat = wat_from_core_source("@append(" + test_case.source + ', "")');
    assert_includes(wat, "f32.mul");
    assert_includes(wat, "i64.trunc_f32_s");
    const instance = await instantiate_wat(
      wat,
      "format_f32_" + index.toString(),
      {},
    );
    assert_equals(read_result_text(instance), test_case.expected);
  }
});

Deno.test("format_f32 traps outside its precision and scaled-magnitude bounds", async () => {
  const invalid_calls = [
    "@format_f32(1.0f32, -1)",
    "@format_f32(1.0f32, 7)",
    "@format_f32(1e20f32, 0)",
  ];

  for (let index = 0; index < invalid_calls.length; index += 1) {
    const source = invalid_calls[index];

    if (source === undefined) {
      throw new Error("Missing invalid f32 format fixture");
    }

    const instance = await instantiate_wat(
      wat_from_core_source(source),
      "format_f32_invalid_" + index.toString(),
      {},
    );
    const main = instance.exports.main;

    if (typeof main !== "function") {
      throw new Error("Missing main export");
    }

    assert_throws(() => main(), "unreachable");
  }
});

Deno.test("UTF-8 conversion and integer formatting have allocation and drop proofs", () => {
  const core = Source.core(`
let bytes: Bytes = @Utf8.encode("x")
let text: Text = @Utf8.decode(bytes)
let number: Text = @format_i64(-9223372036854775808i64)
@len(text) + @len(number)
`);
  const proof = Core.proof(core);
  assert_equals(proof.ok, true);
  assert_equals(
    proof.allocations.facts.map((fact) => ({
      reason: fact.reason,
      layout: fact.layout,
      storage: fact.storage,
    })),
    [
      {
        reason: "runtime_bytes",
        layout: "runtime_bytes.length_prefixed_u8",
        storage: "persistent_unique_heap",
      },
      {
        reason: "runtime_text",
        layout: "runtime_text.length_prefixed_utf8",
        storage: "persistent_unique_heap",
      },
      {
        reason: "runtime_text",
        layout: "runtime_text.length_prefixed_utf8",
        storage: "persistent_unique_heap",
      },
    ],
  );
  assert_equals(
    proof.drops.steps.map((step) => step.ownership),
    [
      { tag: "unique_heap", reason: "text" },
      { tag: "unique_heap", reason: "text" },
      { tag: "unique_heap", reason: "bytes" },
    ],
  );
  Core.check_proof(core);
});

function read_result_text(instance: WebAssembly.Instance): string {
  const main = instance.exports.main;
  const memory = instance.exports.memory;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing memory export");
  }

  const pointer = main();

  if (typeof pointer !== "number") {
    throw new Error("Expected text pointer result");
  }

  const length = new DataView(memory.buffer).getUint32(pointer, true);
  const bytes = new Uint8Array(memory.buffer, pointer + 4, length);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
