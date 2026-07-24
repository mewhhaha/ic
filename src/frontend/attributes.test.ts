import { assert_equals, assert_throws } from "../assert.ts";
import { build_binding_index } from "./binding_index.ts";
import { format_source } from "./format.ts";
import { parse_source, parse_source_with_diagnostics } from "./parser.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";

Deno.test("attributes preserve stacked groups and multiline layout", () => {
  const source = parse_source(
    "@[test]\n" +
      "@[\n" +
      "  derive(I32, Text),\n" +
      "  #slow,\n" +
      "]\n" +
      "const answer = 42;\n",
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
      "const answer = 42;",
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
    () => parse_source("@[]\nconst answer = 42;\n"),
    "Attribute groups cannot be empty",
  );
});

Deno.test("attributes only annotate bindings and declarations", () => {
  assert_throws(
    () => parse_source("@[test]\n42\n"),
    "Attributes can only annotate named bindings and declarations",
  );
});

Deno.test("attributes accept source const expressions", () => {
  const source = parse_source(
    "const test = #test;\n" +
      "@[test]\n" +
      "const answer = 42;\n" +
      "answer\n",
  );

  assert_equals(validate_frontend_semantics(source, { warnings: true }), []);
});

Deno.test("attributes reject runtime captures", () => {
  const source = parse_source(
    "let runtime_tag = #tag;\n" +
      "@[runtime_tag]\n" +
      "const answer = 42;\n" +
      "answer\n",
  );

  assert_equals(
    validate_frontend_semantics(source).map((diagnostic) => diagnostic.message),
    ["Attribute captures runtime value: runtime_tag"],
  );
});

Deno.test("binding index resolves names used by attributes", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "const test = #test;\n" +
      "@[test]\n" +
      "const answer = 42;\n" +
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
