import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { Core } from "./core.ts";
import { parse_source } from "./frontend/parser.ts";
import { validate_frontend_semantics } from "./frontend/semantic_validation.ts";
import { source_facts } from "./frontend/source_facts.ts";
import { TestSource as Source } from "./frontend/test_source.ts";
import { instantiate_wat, wat_from_core_source } from "./wasm_test_util.ts";

Deno.test("Bytes.generate is inferred as immutable Bytes", () => {
  const source = parse_source("@Bytes.generate(4, index => index + 1)");
  const facts = source_facts(source);
  const source_expr = source.statements[0];

  if (!source_expr || source_expr.tag !== "expr") {
    throw new Error("Expected Bytes.generate expression");
  }

  assert_equals(facts.editor_type_of.get(source_expr.expr)?.name, "Bytes");
  assert_equals(facts.type_of.get(source_expr.expr), {
    tag: "text",
    encoding: "bytes",
  });
  assert_equals(validate_frontend_semantics(source), []);
});

Deno.test("Bytes.generate rejects non-I32 boundaries", () => {
  assert_equals(
    validate_frontend_semantics(
      parse_source("@Bytes.generate(4i64, index => index)"),
    ),
    [{
      code: "DUCK2307",
      severity: "error",
      message: "Bytes.generate length expects I32, got I64",
      span: { start: 16, end: 20 },
    }],
  );
  assert_equals(
    validate_frontend_semantics(
      parse_source("@Bytes.generate(4, index => true)"),
    ),
    [{
      code: "DUCK2307",
      severity: "error",
      message: "Bytes.generate callback result expects I32, got Bool",
      span: { start: 19, end: 32 },
    }],
  );
});

Deno.test("Bytes.generate fills a fresh buffer through a captured callback", async () => {
  const wat = wat_from_core_source(`
let factor = 100
let flag = 1
let generator = if flag {
  (index: I32) => index * factor
} else {
  (index: I32) => index + factor
}
let bytes = @Bytes.generate(4, generator)
@get(bytes, 3)
`);
  assert_includes(wat, "call_indirect");
  assert_includes(wat, "i32.store8");
  const instance = await instantiate_wat(
    wat,
    "core_bytes_generate_captured_callback",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  assert_equals(main(), 44);
});

Deno.test("Bytes.generate does not call its callback for an empty buffer", async () => {
  const wat = wat_from_core_source(`
let bytes = @Bytes.generate(0, index => @panic("unexpected callback"))
@len(bytes)
`);
  const instance = await instantiate_wat(
    wat,
    "core_bytes_generate_empty",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  assert_equals(main(), 0);
});

Deno.test("Bytes.generate traps before allocating a negative length", async () => {
  const wat = wat_from_core_source(`
let bytes = @Bytes.generate(-1, index => index)
@len(bytes)
`);
  const instance = await instantiate_wat(
    wat,
    "core_bytes_generate_negative_length",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  assert_throws(() => main(), "unreachable");
});

Deno.test("Bytes.generate owns one byte allocation that cleanup frees", () => {
  const core = Source.core(`
let bytes = @Bytes.generate(4, index => index + 1)
@get(bytes, 3)
`);
  const proof = Core.proof(core);
  assert_equals(proof.ok, true);
  assert_equals(
    proof.allocations.facts.map((fact) => ({
      reason: fact.reason,
      layout: fact.layout,
      ownership: fact.ownership,
      storage: fact.storage,
    })),
    [{
      reason: "runtime_bytes",
      layout: "runtime_bytes.length_prefixed_u8",
      ownership: { tag: "unique_heap", reason: "bytes" },
      storage: "persistent_unique_heap",
    }],
  );
  assert_equals(
    proof.drops.steps.map((step) => ({
      edge: step.edge,
      ownership: step.ownership,
      runtime: step.runtime,
    })),
    [{
      edge: "scope_exit",
      ownership: { tag: "unique_heap", reason: "bytes" },
      runtime: "reusable_free_list_allocator",
    }],
  );
});
