import { assert_equals } from "../assert.ts";
import { name_sites } from "./name_site.ts";
import { parse_source, parse_source_with_diagnostics } from "./parser.ts";

Deno.test("name sites retain distinct repeated binding and reference spellings", () => {
  const text = "let x = 0\nx = x + 1\n";
  const source = parse_source(text);
  const assignment = source.statements[1];

  if (assignment === undefined || assignment.tag !== "assign") {
    throw new Error("Expected assignment");
  }
  if (assignment.value.tag !== "prim" || assignment.value.left.tag !== "var") {
    throw new Error("Expected assignment reference");
  }

  assert_equals(name_sites(assignment), [{
    slot: "name",
    index: undefined,
    name: "x",
    span: { start: 10, end: 11 },
  }]);
  assert_equals(name_sites(assignment.value.left), [{
    slot: "name",
    index: undefined,
    name: "x",
    span: { start: 14, end: 15 },
  }]);
  assert_equals(
    text.slice(
      name_sites(assignment.value.left)[0]?.span.start,
      name_sites(assignment.value.left)[0]?.span.end,
    ),
    "x",
  );
});

Deno.test("name sites cover declarations, members, parameters, and annotations", () => {
  const text =
    "type Pair item = struct {.left = Item}\neffect Io result { read: (Item) => result }\nlet value: Pair Item = Io.read ()\n";
  const source = parse_source(text);
  const declaration = source.declarations?.[0];
  const effect = source.declarations?.[1];
  const binding = source.statements[0];

  if (declaration === undefined || declaration.tag !== "type") {
    throw new Error("Expected type declaration");
  }
  if (effect === undefined || effect.tag !== "effect") {
    throw new Error("Expected effect declaration");
  }
  if (binding === undefined || binding.tag !== "bind") {
    throw new Error("Expected binding");
  }
  if (binding.value.tag !== "app" || binding.value.func.tag !== "field") {
    throw new Error("Expected effect operation call");
  }

  assert_equals(
    name_sites(declaration).map((site) => site.slot + ":" + site.name),
    [
      "name:Pair",
      "params:item",
    ],
  );
  assert_equals(name_sites(effect).map((site) => site.slot + ":" + site.name), [
    "name:Io",
    "params:result",
  ]);
  assert_equals(name_sites(effect.operations[0]!).map((site) => site.name), [
    "read",
  ]);
  assert_equals(name_sites(binding).map((site) => site.name), [
    "Pair",
    "Item",
    "value",
  ]);
  assert_equals(name_sites(binding.value.func).map((site) => site.name), [
    "read",
  ]);
});

Deno.test("recovery intervals exclude discarded sites and retain later syntax", () => {
  const parsed = parse_source_with_diagnostics("let = bad\nlet kept = kept\n");
  const binding = parsed.source.statements[0];

  if (
    binding === undefined || binding.tag !== "bind" ||
    binding.value.tag !== "var"
  ) {
    throw new Error("Expected recovered binding");
  }

  assert_equals(parsed.recovery_intervals.length, 1);
  assert_equals(parsed.recovery_intervals[0]?.skipped, { start: 0, end: 10 });
  assert_equals(name_sites(binding)[0]?.name, "kept");
  assert_equals(name_sites(binding.value)[0]?.name, "kept");
});

Deno.test("postfix member sites remain distinct across repeated member names", () => {
  const text = "let output = object.value.value\n";
  const source = parse_source(text);
  const binding = source.statements[0];

  if (
    binding === undefined || binding.tag !== "bind" ||
    binding.value.tag !== "field" || binding.value.object.tag !== "field"
  ) {
    throw new Error("Expected nested field access");
  }

  assert_equals(name_sites(binding.value.object), [{
    slot: "name",
    index: undefined,
    name: "value",
    span: { start: 20, end: 25 },
  }]);
  assert_equals(name_sites(binding.value), [{
    slot: "name",
    index: undefined,
    name: "value",
    span: { start: 26, end: 31 },
  }]);
});

Deno.test("synthetic handler state and final conditional retain source sites", () => {
  const text = [
    "effect Counter { get: () => I32 }",
    "let counter = {",
    "  let initial = 0",
    "  Counter {",
    "    get: (!resume) => !resume(initial),",
    "    return: value => value,",
    "  }",
    "}",
    "let result = { if condition { 1 } }",
    "",
  ].join("\n");
  const source = parse_source(text);
  const counter = source.statements[0];
  const result = source.statements[1];

  if (
    counter === undefined || counter.tag !== "bind" ||
    counter.value.tag !== "handler" || result === undefined ||
    result.tag !== "bind" || result.value.tag !== "block"
  ) {
    throw new Error("Expected rewritten handler and conditional block");
  }

  const final = result.value.statements[0];
  if (final === undefined || final.tag !== "expr" || final.expr.tag !== "if") {
    throw new Error("Expected rewritten final conditional");
  }

  assert_equals(name_sites(counter.value.state[0]!), [{
    slot: "name",
    index: undefined,
    name: "initial",
    span: { start: 56, end: 63 },
  }]);
  assert_equals(name_sites(final.expr.cond), [{
    slot: "name",
    index: undefined,
    name: "condition",
    span: { start: 172, end: 181 },
  }]);
});

Deno.test("prefixed type field annotations retain their identifier site", () => {
  const source = parse_source("declare Record { text: #Text }\n");
  const declaration = source.declarations?.[0];

  if (declaration === undefined || declaration.tag !== "record") {
    throw new Error("Expected record declaration");
  }

  assert_equals(name_sites(declaration.fields[0]!), [
    {
      slot: "name",
      index: undefined,
      name: "text",
      span: { start: 17, end: 21 },
    },
    {
      slot: "type_name",
      index: 0,
      name: "Text",
      span: { start: 24, end: 28 },
    },
  ]);
});

Deno.test("recovery diagnostics point at the discarded syntax before synchronization", () => {
  const parsed = parse_source_with_diagnostics(
    "let broken = [1,, 2]\nlet valid = 3\n",
  );

  assert_equals(parsed.diagnostics[0]?.span, { start: 16, end: 17 });
  assert_equals(parsed.recovery_intervals[0]?.skipped, { start: 0, end: 21 });
});
