import { assert_equals } from "../assert.ts";
import type { Source, Stmt } from "./ast.ts";
import { parse_source } from "./parser.ts";
import { source_facts, type SourceFacts } from "./source_facts.ts";

function binding_type_name(
  statement: Stmt,
  facts: SourceFacts,
): string | undefined {
  return facts.definition_type_of.get(statement)?.get("name")?.name;
}

function variable_type_names(facts: SourceFacts): string[] {
  const names: string[] = [];

  for (const expression of facts.expressions) {
    if (expression.tag !== "var") {
      continue;
    }

    const type = facts.editor_type_of.get(expression);

    if (type !== undefined) {
      names.push(type.name);
    }
  }

  return names;
}

function analyze(text: string): { source: Source; facts: SourceFacts } {
  const source = parse_source(text);
  return { source, facts: source_facts(source) };
}

function binding_types(source: Source, facts: SourceFacts): string[] {
  const names: string[] = [];

  for (const statement of source.statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    const name = binding_type_name(statement, facts);

    if (name !== undefined) {
      names.push(name);
    }
  }

  return names;
}

Deno.test("source facts preserve named finite type sets for members", () => {
  const { source, facts } = analyze(`
type Scalar = Bool | Text
let value: Scalar = true
let copied: Scalar = value
copied
`);

  assert_equals(binding_types(source, facts), ["Scalar", "Scalar"]);
  assert_equals(variable_type_names(facts), ["Scalar", "Scalar"]);
});

Deno.test("source facts preserve inline finite type sets for members", () => {
  const { source, facts } = analyze(`
let value: Bool | Text = true
value
`);

  assert_equals(binding_types(source, facts), ["Bool :| Text"]);
  assert_equals(variable_type_names(facts), ["Bool :| Text"]);
});

Deno.test("source facts distinguish Bool and I32 type-set membership", () => {
  const { source, facts } = analyze(`
type Truth = Bool | Text
type Count = I32 | Text
let valid_truth: Truth = true
let invalid_truth: Truth = 1
let valid_count: Count = 1
let invalid_count: Count = false
valid_truth
invalid_truth
valid_count
invalid_count
`);

  assert_equals(
    binding_types(source, facts),
    ["Truth", "unknown", "Count", "unknown"],
  );
  assert_equals(
    variable_type_names(facts),
    ["Truth", "unknown", "Count", "unknown"],
  );
});

Deno.test("source facts specialize generic finite type-set applications", () => {
  const { source, facts } = analyze(`
type Maybe a = a | Unit
let present: Maybe Bool = true
let invalid: Maybe Bool = 1
present
invalid
`);

  assert_equals(binding_types(source, facts), ["Maybe Bool", "unknown"]);
  assert_equals(variable_type_names(facts), ["Maybe Bool", "unknown"]);
});

Deno.test("source facts evaluate finite intersections and differences", () => {
  const { source, facts } = analyze(`
type Scalar = Bool | Text
type Truth = Scalar \\ Text
type Textual = Scalar & Text
let truth: Truth = true
let not_truth: Truth = "no"
let textual: Textual = "yes"
let not_textual: Textual = false
truth
not_truth
textual
not_textual
`);

  assert_equals(
    binding_types(source, facts),
    ["Truth", "unknown", "Textual", "unknown"],
  );
  assert_equals(
    variable_type_names(facts),
    ["Truth", "unknown", "Textual", "unknown"],
  );
});
