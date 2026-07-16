import { assert_equals } from "../assert.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import { parse_source } from "./parser.ts";
import {
  source_facts,
  source_inference_diagnostics,
  type SourceFacts,
  type SourceTypeFact,
} from "./source_facts.ts";

function recorded_type(
  facts: SourceFacts,
  expression: FrontExpr,
): SourceTypeFact | undefined {
  return facts.editor_type_of.get(expression);
}

function expression_type_names(text: string, tag: FrontExpr["tag"]): string[] {
  const source = parse_source(text);
  const facts = source_facts(source);
  return facts.expressions.filter((expression) => expression.tag === tag).map(
    (expression) => recorded_type(facts, expression)?.name || "missing",
  );
}

function binding_type_name(statement: Stmt, facts: SourceFacts): string {
  return facts.definition_type_of.get(statement)?.get("name")?.name ||
    "missing";
}

function definition_type_name(
  owner: object,
  slot: string,
  facts: SourceFacts,
): string {
  return facts.definition_type_of.get(owner)?.get(slot)?.name || "missing";
}

Deno.test("source facts expose canonical types as semantic evidence", () => {
  const source = parse_source("let value: Bool = true\nvalue");
  const facts = source_facts(source);
  const fact = facts.definition_type_of.get(source.statements[0]!)?.get("name");

  assert_equals(fact?.canonical_type(), { tag: "scalar", name: "Bool" });
});

Deno.test("@as accepts only representation-identical target types", () => {
  const valid = parse_source(`
type UserId = I32
let value: UserId = 41
@as(value, I32)
`);
  const valid_facts = source_facts(valid);
  const valid_call = valid_facts.expressions.find((expression) =>
    expression.tag === "app"
  );

  if (valid_call === undefined) {
    throw new Error("Missing checked cast call");
  }

  assert_equals(recorded_type(valid_facts, valid_call)?.name, "I32");
  assert_equals(source_inference_diagnostics(valid, valid_facts), []);

  const invalid = parse_source("@as(1, I64)");
  const invalid_facts = source_facts(invalid);
  assert_equals(
    source_inference_diagnostics(invalid, invalid_facts).map((diagnostic) =>
      diagnostic.message
    ),
    ["@as cannot cast I32 to I64 because their runtime representations differ"],
  );
});

Deno.test("source facts specialize generic product aliases recursively", () => {
  const source = parse_source(`
type Box a = [.value = a]
type Alias a = Box a
type Nested a = Alias a
let box: Nested Bool = [.value = true]
box.value
`);
  const facts = source_facts(source);
  const fields = facts.expressions.filter((expression) =>
    expression.tag === "field"
  );

  assert_equals(recorded_type(facts, fields[0]!)?.name, "Bool");

  const cyclic = parse_source(`
type Left a = Right a
type Right a = Left a
  let value: Left Bool = missing
value
`);
  const cyclic_facts = source_facts(cyclic);
  assert_equals(
    binding_type_name(cyclic.statements[0]!, cyclic_facts),
    "unknown",
  );
});

Deno.test("source facts preserve names across the i32 runtime family", () => {
  const source = parse_source(
    "let signed: Int = 1\nlet sum = signed + 1\n" +
      "let unsigned: U32 = 2\nlet next = unsigned + 1\n",
  );
  const facts = source_facts(source);

  assert_equals(
    source.statements.map((statement) => binding_type_name(statement, facts)),
    ["Int", "Int", "U32", "U32"],
  );
});

Deno.test("source facts expose Bytes.empty as Bytes", () => {
  assert_equals(expression_type_names("Bytes.empty", "text"), ["Bytes"]);
});

Deno.test("source facts traverse unreachable expressions without changing returns", () => {
  assert_equals(
    expression_type_names("let f = () => { return true; 1 }\nf()", "num"),
    ["I32"],
  );
  assert_equals(
    expression_type_names("let f = () => { return true; 1 }\nf()", "app"),
    ["Bool"],
  );
  assert_equals(
    expression_type_names(
      "let f = () => { { return true }; 1 }\nlet out = f()",
      "app",
    ),
    ["Bool"],
  );
  assert_equals(
    expression_type_names(
      "let f = () => { scratch { return true }; 1 }\nlet out = f()",
      "app",
    ),
    ["Bool"],
  );
});

Deno.test("source facts infer each untyped call independently", () => {
  assert_equals(
    expression_type_names(
      "let identity = value => value\nidentity(true)\nidentity(1)",
      "app",
    ),
    ["Bool", "I32"],
  );
  assert_equals(
    expression_type_names(
      "let make = () => value => value\nmake()(true)\nmake()(1)",
      "app",
    ).filter((name) => name !== "function"),
    ["Bool", "I32"],
  );
  assert_equals(
    expression_type_names(
      "let apply = (f, value) => f(value)\n" +
        "let identity = value => value\napply(identity, true)",
      "app",
    ),
    ["unknown", "Bool"],
  );
});

Deno.test("source facts apply consistent call types inside untyped functions", () => {
  const source = parse_source(`
let suffix = (bytes, pattern) => {
  let tail = @slice(bytes, 0, @len(bytes))
  let width = @len(pattern)
  @slice(tail, 0, width)
}
let bytes: Bytes = Bytes.empty
suffix(bytes, "")
`);
  const facts = source_facts(source);
  const suffix = source.statements[0];

  if (
    suffix === undefined || suffix.tag !== "bind" ||
    suffix.value.tag !== "lam" || suffix.value.body.tag !== "block"
  ) {
    throw new Error("Missing inferred suffix closure");
  }

  assert_equals(
    suffix.value.params.map((param) =>
      definition_type_name(param, "name", facts)
    ),
    ["Bytes", "Text"],
  );
  assert_equals(
    suffix.value.body.statements.slice(0, 2).map((statement) =>
      binding_type_name(statement, facts)
    ),
    ["Bytes", "I32"],
  );

  const conflicting = parse_source(
    "let identity = value => value\nidentity(true)\nidentity(1)",
  );
  const conflicting_facts = source_facts(conflicting);
  const identity = conflicting.statements[0];

  if (
    identity === undefined || identity.tag !== "bind" ||
    identity.value.tag !== "lam"
  ) {
    throw new Error("Missing independently inferred identity closure");
  }

  assert_equals(
    definition_type_name(identity.value.params[0]!, "name", conflicting_facts),
    "unknown",
  );

  const aliases = parse_source(`
let identity = value => value
let int_value: Int = 1
let i32_value: I32 = 2
identity(int_value)
identity(i32_value)
`);
  const alias_facts = source_facts(aliases);
  const alias_identity = aliases.statements[0];

  if (
    alias_identity === undefined || alias_identity.tag !== "bind" ||
    alias_identity.value.tag !== "lam"
  ) {
    throw new Error("Missing alias-sensitive identity closure");
  }

  assert_equals(
    definition_type_name(alias_identity.value.params[0]!, "name", alias_facts),
    "unknown",
  );

  const invalid_call = parse_source(
    "let identity = value => value\nidentity(1, 2)",
  );
  const invalid_call_facts = source_facts(invalid_call);
  const invalid_identity = invalid_call.statements[0];

  if (
    invalid_identity === undefined || invalid_identity.tag !== "bind" ||
    invalid_identity.value.tag !== "lam"
  ) {
    throw new Error("Missing invalid-call identity closure");
  }

  assert_equals(
    definition_type_name(
      invalid_identity.value.params[0]!,
      "name",
      invalid_call_facts,
    ),
    "unknown",
  );
});

Deno.test("source facts reject invalid annotations and same assignments", () => {
  for (
    const text of [
      'let f: (I32) -> Bool = value => "bad"\nf(1)',
      "let f: (I32) -> Bool = (value: Bool) => true\nf(1)",
      "let f: (I32) -> Bool = (left, right) => true\nf(1)",
    ]
  ) {
    const source = parse_source(text);
    const facts = source_facts(source);
    assert_equals(binding_type_name(source.statements[0]!, facts), "unknown");
    assert_equals(expression_type_names(text, "app"), ["unknown"]);
  }

  const assigned = parse_source("let ready = true\nready = 1\nready");
  const assigned_facts = source_facts(assigned);
  assert_equals(
    binding_type_name(assigned.statements[1]!, assigned_facts),
    "unknown",
  );
  assert_equals(
    recorded_type(
      assigned_facts,
      assigned_facts.expressions.at(-1)!,
    )?.name,
    "Bool",
  );
});

Deno.test("source facts require known indexes and valid loop binders", () => {
  assert_equals(expression_type_names('"abc"[index]', "index"), ["unknown"]);
  assert_equals(
    expression_type_names('for byte in "abc" { byte }; 0', "var"),
    ["I32"],
  );
  assert_equals(
    expression_type_names("for value in true..2 { value }; 0", "var"),
    ["unknown"],
  );
  assert_equals(
    expression_type_names('let out = loop { break "x" }\nout', "loop"),
    ["unknown"],
  );
});

Deno.test("source facts validate text builtins and runtime type tests", () => {
  assert_equals(
    expression_type_names(
      '@len("abc")\n@get("abc", 0)\n@slice("abc", 0, 1)\n@append("a", "b")',
      "app",
    ),
    ["I32", "I32", "Text", "Text"],
  );
  assert_equals(expression_type_names("1 is Missing", "is"), ["unknown"]);
  assert_equals(expression_type_names("1 is I32", "is"), ["Bool"]);
});

Deno.test("source facts invalidate malformed aggregates and handlers", () => {
  const duplicate = parse_source(`
type Pair = [.ready = Bool, .wide = I64]
let pair: Pair = [.ready = true, .ready = false]
pair.ready
`);
  const duplicate_facts = source_facts(duplicate);
  assert_equals(
    binding_type_name(duplicate.statements[0]!, duplicate_facts),
    "unknown",
  );

  const handler_prefix = "effect Check { test: () => Bool }\n";
  assert_equals(
    expression_type_names(
      handler_prefix +
        "let good = Check { test: (!resume) => !resume(true), " +
        "return: value => true }\ntry true with good",
      "try_with",
    ),
    ["Bool"],
  );
  assert_equals(
    expression_type_names(
      handler_prefix +
        "let bad = Check { test: (!resume) => !resume(1), " +
        "return: value => true }\ntry true with bad",
      "try_with",
    ),
    ["unknown"],
  );
  assert_equals(
    expression_type_names(
      handler_prefix +
        "let bad = Check { missing: (!resume) => !resume(true), " +
        "return: value => true }\ntry true with bad",
      "try_with",
    ),
    ["unknown"],
  );
});

Deno.test("source facts validate handler inputs against handled values", () => {
  const prefix = "effect Check { test: () => Bool }\n";

  assert_equals(
    expression_type_names(
      prefix +
        "let checker = Check { test: (!resume) => !resume(true), " +
        "return: (value: Bool) => value }\n" +
        "try 1 with checker",
      "try_with",
    ),
    ["unknown"],
  );
  assert_equals(
    expression_type_names(
      prefix +
        "let checker = Check { test: (!resume) => !resume(true), " +
        "return: value => value }\n" +
        "try true with checker",
      "try_with",
    ),
    ["Bool"],
  );
});

Deno.test("source facts do not infer annotated updates from unknown bases", () => {
  const source = parse_source(`
type Pair = [.ready = Bool]
let bad: Pair = missing with { .ready = false }
bad.ready
`);
  const facts = source_facts(source);

  assert_equals(binding_type_name(source.statements[0]!, facts), "unknown");
  assert_equals(
    facts.expressions.filter((expression) => expression.tag === "field").map(
      (expression) => recorded_type(facts, expression)?.name,
    ),
    ["unknown"],
  );
});

Deno.test("source facts distinguish labeled and positional destructuring", () => {
  const named = parse_source(`
let { .missing = missing } = { .present = true }
missing
`);
  const named_facts = source_facts(named);
  const named_pattern = named.statements[0];

  if (
    named_pattern === undefined || named_pattern.tag !== "bind" ||
    named_pattern.pattern?.tag !== "product"
  ) {
    throw new Error("Missing named binding pattern");
  }

  const named_binding = named_pattern.pattern.entries[0]?.pattern;

  if (named_binding?.tag !== "binding") {
    throw new Error("Missing named record binding");
  }

  assert_equals(
    definition_type_name(named_binding, "name", named_facts),
    "unknown",
  );
  assert_equals(
    recorded_type(named_facts, named_facts.expressions.at(-1)!)?.name,
    "unknown",
  );

  const positional = parse_source(`
type Pair = [Bool, I32]
let pair: Pair = (true, 1)
let (left, right) = pair
left
right
`);
  const positional_facts = source_facts(positional);
  const positional_pattern = positional.statements[1];

  if (
    positional_pattern === undefined ||
    positional_pattern.tag !== "bind" ||
    positional_pattern.pattern?.tag !== "product"
  ) {
    throw new Error("Missing positional binding pattern");
  }

  const positional_bindings = positional_pattern.pattern.entries.map(
    (entry) => entry.pattern,
  );

  assert_equals(
    positional_bindings.map((binding) =>
      definition_type_name(binding, "name", positional_facts)
    ),
    ["Bool", "I32"],
  );
});

Deno.test("source facts require valid runtime type targets", () => {
  const invalid = [
    "effect Check { test: () => Bool }\n1 is Check",
    "type Alias = missing_type\n1 is Alias",
    "type Box a = [.value = a]\n1 is Box",
    "type Box a = [.value = a]\n1 is Box Bool Bool",
    "1 is missing_type",
    "1 is (I32 -> <missing_effect> Bool)",
    "1 is (I32 -> <effect_row> Bool)",
    "effect Io { read: () => Bool }\n" +
    "1 is (I32 -> <Io.missing> Bool)",
    "effect Broken { run: (missing_type) => Bool }\n" +
    "1 is (I32 -> <Broken> Bool)",
  ];

  for (const text of invalid) {
    assert_equals(expression_type_names(text, "is"), ["unknown"]);
  }

  assert_equals(
    expression_type_names(
      "type Box a = [.value = a]\n1 is Box Bool",
      "is",
    ),
    ["Bool"],
  );
});

Deno.test("source facts expose unresolved declared types only as unknown", () => {
  const source = parse_source(`
type Alias = missing_type
type Broken = [.value = missing_type]
effect Bad { run: (missing_type) => Bool }
let identity = (value: Alias) => value
Broken.value
Bad.run
`);
  const facts = source_facts(source);
  const identity = source.statements[0];

  if (
    identity === undefined || identity.tag !== "bind" ||
    identity.value.tag !== "lam"
  ) {
    throw new Error("Missing unresolved-type closure");
  }

  assert_equals(binding_type_name(identity, facts), "unknown");
  assert_equals(
    definition_type_name(identity.value.params[0]!, "name", facts),
    "unknown",
  );
  assert_equals(
    facts.expressions.filter((expression) => expression.tag === "field").map(
      (expression) => recorded_type(facts, expression)?.name,
    ),
    ["unknown", "unknown"],
  );
});

Deno.test("source facts poison every parameter after handler arity errors", () => {
  const source = parse_source(`
effect Check { test: (I32) => Bool }
let checker = Check {
  test: (value, !resume, extra) => true,
  return: value => value,
}
try true with checker
`);
  const facts = source_facts(source);
  const checker = source.statements[0];

  if (
    checker === undefined || checker.tag !== "bind" ||
    checker.value.tag !== "handler"
  ) {
    throw new Error("Missing malformed handler");
  }

  assert_equals(
    checker.value.clauses[0]!.params.map((param) =>
      definition_type_name(param, "name", facts)
    ),
    ["unknown", "unknown", "unknown"],
  );
  assert_equals(
    expression_type_names(
      `
effect Check { test: (I32) => Bool }
let checker = Check {
  test: (value, !resume, extra) => true,
  return: value => value,
}
try true with checker
`,
      "try_with",
    ),
    ["unknown"],
  );
});

Deno.test("source facts poison contextual parameters after arity errors", () => {
  const source = parse_source(
    "let f: (I32) -> Bool = (left, right) => true\nf",
  );
  const facts = source_facts(source);
  const binding = source.statements[0];

  if (
    binding === undefined || binding.tag !== "bind" ||
    binding.value.tag !== "lam"
  ) {
    throw new Error("Missing contextual closure");
  }

  assert_equals(
    binding.value.params.map((param) =>
      definition_type_name(param, "name", facts)
    ),
    ["unknown", "unknown"],
  );
  assert_equals(binding_type_name(binding, facts), "unknown");
});

Deno.test("source facts resolve canonical labeled product fields", () => {
  const valid = parse_source(`
const { struct } = comptime (import "duck:prelude")()
type Flags = struct { .ready = Bool }
let flags: Flags = [true]
flags.ready
`);
  const valid_facts = source_facts(valid);

  assert_equals(
    binding_type_name(valid.statements[1]!, valid_facts),
    "Flags",
  );
  assert_equals(
    expression_type_names(
      `
const { struct } = comptime (import "duck:prelude")()
type Flags = struct { .ready = Bool }
let flags: Flags = [true]
flags.ready
`,
      "field",
    ),
    ["Bool"],
  );
});

Deno.test("source facts preserve declared sum constructors", () => {
  const text = `
type ResultType = | .ok = Int | .err = Int
let constructor = ResultType.ok
let qualified = constructor(40)
let result: ResultType = .ok(41)
if let .ok(value) = result { value } else { 0 }
`;
  const source = parse_source(text);
  const facts = source_facts(source);
  const conditional = source.statements[3];

  assert_equals(
    source.statements.slice(0, 3).map((statement) =>
      binding_type_name(statement, facts)
    ),
    ["(Int) -> ResultType", "ResultType", "ResultType"],
  );
  assert_equals(expression_type_names(text, "union_case"), ["ResultType"]);

  if (
    conditional === undefined || conditional.tag !== "expr" ||
    conditional.expr.tag !== "if_let"
  ) {
    throw new Error("Missing union conditional");
  }

  assert_equals(
    definition_type_name(conditional.expr, "value_name", facts),
    "Int",
  );

  for (const value of [".ok(true)", ".missing(1)"]) {
    assert_equals(
      expression_type_names(
        "type ResultType = | .ok = Int | .err = Int\n" +
          "const result_type = ResultType\n" +
          "let result: result_type = " + value,
        "union_case",
      ),
      ["unknown"],
    );
  }
});

Deno.test("source facts do not unify poisoned call arguments", () => {
  const text = "let bad: Bool = 1\n" +
    "let f: (I32) -> Bool = x => true\n" +
    "f(bad)";

  assert_equals(expression_type_names(text, "app"), ["unknown"]);
  assert_equals(
    expression_type_names(
      "let identity = value => value\nidentity(true)\nidentity(1)",
      "app",
    ),
    ["Bool", "I32"],
  );
});
