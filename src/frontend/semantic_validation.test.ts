import { assert_equals } from "../assert.ts";
import { parse_source } from "./parser.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";

const failures = [
  {
    name: "03_illegal_type_change",
    diagnostic: {
      code: "IX2301",
      severity: "error",
      message: "Assignment changes type for value",
      span: { start: 15, end: 34 },
    },
  },
  {
    name: "04_mixed_integer_widths",
    diagnostic: {
      code: "IX2302",
      severity: "error",
      message: "Mixed i32 and i64 operands for operator +",
      span: { start: 0, end: 12 },
    },
  },
  {
    name: "05_invalid_condition_type",
    diagnostic: {
      code: "IX2303",
      severity: "error",
      message: "If condition expects Bool or I32, got Text",
      span: { start: 3, end: 8 },
    },
  },
  {
    name: "06_missing_struct_field",
    diagnostic: {
      code: "IX2304",
      severity: "error",
      message: "Missing struct field: age",
      span: { start: 66, end: 74 },
    },
  },
  {
    name: "07_invalid_union_payload",
    diagnostic: {
      code: "IX2305",
      severity: "error",
      message: "Union case ok expects Int, got Text",
      span: { start: 51, end: 69 },
    },
  },
];

for (const failure of failures) {
  Deno.test("semantic validation reports " + failure.name, async () => {
    const text = await Deno.readTextFile(
      "examples/failures/compile/" + failure.name + ".ix",
    );

    assert_equals(validate_frontend_semantics(parse_source(text)), [
      failure.diagnostic,
    ]);
  });
}

Deno.test("semantic validation maps fail calls to their call span", () => {
  assert_equals(
    validate_frontend_semantics(parse_source('comptime fail("bad")')),
    [{
      code: "IX2102",
      severity: "error",
      message: "fail: bad",
      span: { start: 9, end: 20 },
    }],
  );
});

Deno.test("semantic validation ignores valid route-independent expressions", () => {
  assert_equals(
    validate_frontend_semantics(
      parse_source("let value = 40i64 + 2i64\nvalue"),
    ),
    [],
  );
});

Deno.test("semantic validation keeps nested width errors structured and singular", () => {
  assert_equals(
    validate_frontend_semantics(
      parse_source("let value = (1i32 + 2i64) + 3i64\nvalue"),
    ),
    [{
      code: "IX2302",
      severity: "error",
      message: "Mixed i32 and i64 operands for operator +",
      span: { start: 13, end: 24 },
    }],
  );
});

Deno.test("semantic validation does not re-infer an invalid indexed branch", () => {
  const source = parse_source(
    "let pair=[.a=true,.b=1]\nif true { pair[input] } else { 0 }",
  );

  assert_equals(validate_frontend_semantics(source), [{
    code: "IX2304",
    severity: "error",
    message: "Mixed Bool and numeric indexed values",
    span: { start: 34, end: 45 },
  }]);
});

Deno.test("semantic validation reuses constness checks with source spans", () => {
  const source = parse_source(
    "let runtime = 1\nconst invalid = runtime\ninvalid",
  );
  assert_equals(validate_frontend_semantics(source), [{
    code: "IX2101",
    severity: "error",
    message: "Const binding captures runtime value: runtime",
    span: { start: 32, end: 39 },
  }]);
});

Deno.test("semantic validation reports basic binding annotations", () => {
  const source = parse_source("let value: Text = 1\nvalue");
  assert_equals(validate_frontend_semantics(source), [{
    code: "IX2306",
    severity: "error",
    message: "Binding annotation expects Text, got I32",
    span: { start: 18, end: 19 },
  }]);
});

Deno.test("semantic validation scopes the Core gate to Bool representation errors", () => {
  const integer_source = parse_source("let value: Int = 1i64\nvalue");
  assert_equals(
    validate_frontend_semantics(integer_source, {
      scope: "bool-representation",
    }),
    [],
  );

  const bool_source = parse_source("let value: Bool = 1\nvalue");
  assert_equals(
    validate_frontend_semantics(bool_source, {
      scope: "bool-representation",
    }),
    [{
      code: "IX2306",
      severity: "error",
      message: "Binding annotation expects Bool, got I32",
      span: { start: 18, end: 19 },
    }],
  );
});

Deno.test("semantic validation optionally reports unused binding warnings", () => {
  const source = parse_source("let value = 1\n42");
  assert_equals(validate_frontend_semantics(source), []);
  assert_equals(validate_frontend_semantics(source, { warnings: true }), [{
    code: "IX2003",
    severity: "warning",
    message: "Unused runtime binding value",
    span: { start: 0, end: 13 },
  }]);
});

Deno.test("semantic validation scopes lambda binders and const parameters", () => {
  const source = parse_source(
    'let flag = "outer"\n' +
      "let constant = (const x) => comptime x + 1\n" +
      "let condition = flag => if flag { 1 } else { 0 }\n" +
      "constant(41) + condition(1)",
  );
  assert_equals(validate_frontend_semantics(source), []);
});

Deno.test("semantic validation accepts contextual Bytes literals", () => {
  const source = parse_source('let value: Bytes = "abc"\nlen(value)');
  assert_equals(validate_frontend_semantics(source), []);
});

Deno.test("semantic validation reports one const capture cause", () => {
  const source = parse_source(
    "let runtime = 1\nconst invalid = comptime comptime runtime\ninvalid",
  );
  const diagnostics = validate_frontend_semantics(source);
  assert_equals(diagnostics.length, 1);
  assert_equals(diagnostics[0]?.code, "IX2101");
});

Deno.test("semantic warning liveness traverses handlers and type tests", async () => {
  for (
    const path of [
      "examples/handlers/01_local_counter.ix",
      "examples/compile_time/10_extensions_and_protocols.ix",
      "examples/data/14_type_sets.ix",
    ]
  ) {
    const source = parse_source(await Deno.readTextFile(path));
    const diagnostics = validate_frontend_semantics(source, {
      warnings: true,
    });
    assert_equals(diagnostics, []);
  }
});
