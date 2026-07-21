import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { build_binding_index } from "./binding_index.ts";
import { format_source } from "./format.ts";
import { parse_source, parse_source_with_diagnostics } from "./parser.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";
import { Source } from "./source.ts";

Deno.test("attributes preserve stacked groups and multiline layout", () => {
  const source = parse_source(
    "@[test]\n" +
      "@[\n" +
      "  derive(I32, Text),\n" +
      "  #slow,\n" +
      "]\n" +
      "const answer = 42\n",
  );
  const binding = source.statements[0];

  if (binding === undefined || binding.tag !== "bind") {
    throw new Error("Expected attributed binding");
  }

  assert_equals(binding.attribute_groups?.length, 2);
  assert_equals(binding.attribute_groups?.[0]?.multiline, undefined);
  assert_equals(binding.attribute_groups?.[1]?.multiline, true);
  assert_equals(
    format_source(source),
    "@[test]\n" +
      "@[\n" +
      "  derive (I32, Text),\n" +
      "  #slow,\n" +
      "]\n" +
      "const answer = 42",
  );
});

Deno.test("attributes annotate declarations", () => {
  const source = parse_source("@[derive(I32)]\ntype Answer = I32\n");
  const declaration = source.declarations?.[0];

  if (declaration === undefined) {
    throw new Error("Expected attributed declaration");
  }

  assert_equals(declaration.attribute_groups?.length, 1);
  assert_equals(
    format_source(source),
    "@[derive I32]\ntype Answer = I32",
  );
});

Deno.test("attribute groups cannot be empty", () => {
  assert_throws(
    () => parse_source("@[]\nconst answer = 42\n"),
    "Attribute groups cannot be empty",
  );
});

Deno.test("attributes only annotate bindings and declarations", () => {
  assert_throws(
    () => parse_source("@[test]\n42\n"),
    "Attributes can only annotate named bindings and declarations",
  );
});

Deno.test("attributes accept source const expressions and count their references", () => {
  const source = parse_source(
    "const test = #test\n" +
      "@[test]\n" +
      "const answer = 42\n" +
      "answer\n",
  );

  assert_equals(validate_frontend_semantics(source, { warnings: true }), []);
});

Deno.test("attributes reject runtime captures", () => {
  const source = parse_source(
    "let runtime_tag = #tag\n" +
      "@[runtime_tag]\n" +
      "const answer = 42\n" +
      "answer\n",
  );

  assert_equals(
    validate_frontend_semantics(source).map((diagnostic) => diagnostic.message),
    ["Attribute captures runtime value: runtime_tag"],
  );
});

Deno.test("binding index resolves names used by attributes", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "const test = #test\n" +
      "@[test]\n" +
      "const answer = 42\n" +
      "answer\n",
  ));
  const test_occurrences = [...indexed.occurrences.values()].filter(
    (occurrence) => occurrence.name === "test",
  );

  assert_equals(
    test_occurrences.map((occurrence) => occurrence.role),
    ["definition", "reference"],
  );
  assert_equals(test_occurrences[0]?.entity, test_occurrences[1]?.entity);
});

Deno.test("attributes execute const handlers during lowering", () => {
  const wat = Source.wat(
    "const keep = (const target) => `Keep ()\n" +
      "@[keep]\n" +
      "const answer = 42\n" +
      "answer\n",
  );

  assert_equals(wat.includes("i32.const 42"), true);
});

Deno.test("attribute handlers run sequentially", () => {
  const wat = Source.wat(
    "const increment = (const target) => `Replace (target + 1)\n" +
      "@[increment, increment]\n" +
      "const answer = 40\n" +
      "answer\n",
  );

  assert_includes(wat, "i32.const 42");
});

Deno.test("import.meta exposes deterministic and supplied host constants", () => {
  const source =
    "const configured = (const target) => if import.meta.enabled {\n" +
    "  `Replace 42\n" +
    "} else {\n" +
    "  `Replace target\n" +
    "}\n" +
    "@[configured]\n" +
    "const answer = 0\n" +
    "answer\n";
  const artifact = Source.artifact(source, {
    import_meta: { enabled: true },
  });

  assert_includes(artifact.wat, "i32.const 42");
  assert_equals(
    format_source(parse_source("const mode = import.meta.mode")),
    "const mode = import.meta.mode",
  );
});

Deno.test("the source test attribute drops builds and exports tests", () => {
  const source = 'const { test } = import "duck:prelude/attributes" ()\n' +
    "@[test]\n" +
    "const checked: I32 -> I32 = value => value + 1\n" +
    "0\n";
  const build = Source.artifact(source);
  const test = Source.artifact(source, {
    import_meta: { mode: { atom: "test" } },
  });

  assert_equals(build.abi.callables, {});

  if (test.abi.callables === undefined) {
    throw new Error("Expected test callable export");
  }

  assert_equals(Object.keys(test.abi.callables), ["checked"]);
  assert_includes(test.wat, '(export "__duck_abi_call_checked"');
  assert_equals(
    Source.analyze(source, {
      import_meta: { mode: { atom: "test" } },
      warnings: true,
    }).diagnostics,
    [],
  );
});

Deno.test("the source derive attribute extends a declared type", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude/types" ()
const { derive } = import "duck:prelude/attributes" ()
const answer = (const target) => comptime { .answer = value => 42 }
const identity = (const target) => comptime { .identity = value => value }

@[derive(answer, identity)]
type Derived = struct { .value = I32 }

Derived.answer(0)
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("attributes reject unknown actions", () => {
  const analysis = Source.analyze(
    "const invalid = (const target) => `Unknown ()\n" +
      "@[invalid]\n" +
      "const answer = 42\n" +
      "answer\n",
  );

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Unknown attribute action Unknown for answer"],
  );
});
