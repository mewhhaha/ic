import { assert_equals } from "../assert.ts";
import { parse_source } from "./parser.ts";
import {
  ducklang_effects_prelude_text,
  ducklang_functional_prelude_text,
  ducklang_prelude_text,
  ducklang_runtime_prelude_text,
} from "./prelude.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";

const failures = [
  {
    name: "03_illegal_type_change",
    diagnostic: {
      code: "DUCK2301",
      severity: "error",
      message: "Assignment changes type for value",
      span: { start: 15, end: 34 },
    },
  },
  {
    name: "04_mixed_integer_widths",
    diagnostic: {
      code: "DUCK2302",
      severity: "error",
      message: "Mixed i32 and i64 operands for operator +",
      span: { start: 0, end: 12 },
    },
  },
  {
    name: "05_invalid_condition_type",
    diagnostic: {
      code: "DUCK2303",
      severity: "error",
      message: "If condition expects Bool, got Text",
      span: { start: 3, end: 8 },
    },
  },
  {
    name: "06_missing_struct_field",
    diagnostic: {
      code: "DUCK2304",
      severity: "error",
      message: "Missing struct field: age",
      span: { start: 127, end: 135 },
    },
  },
  {
    name: "07_invalid_union_payload",
    diagnostic: {
      code: "DUCK2305",
      severity: "error",
      message: "Union case ok expects Int, got Text",
      span: { start: 53, end: 71 },
    },
  },
];

for (const failure of failures) {
  Deno.test("semantic validation reports " + failure.name, async () => {
    const text = await Deno.readTextFile(
      "examples/failures/compile/" + failure.name + ".duck",
    );

    assert_equals(validate_frontend_semantics(parse_source(text)), [
      failure.diagnostic,
    ]);
  });
}

Deno.test("semantic validation maps fail calls to their call span", () => {
  assert_equals(
    validate_frontend_semantics(parse_source('comptime @fail("bad")')),
    [{
      code: "DUCK2102",
      severity: "error",
      message: "@fail: bad",
      span: { start: 9, end: 21 },
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
      code: "DUCK2302",
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
    code: "DUCK2304",
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
    code: "DUCK2101",
    severity: "error",
    message: "Const binding captures runtime value: runtime",
    span: { start: 32, end: 39 },
  }]);
});

Deno.test("semantic validation accepts every bundled source prelude", () => {
  for (
    const text of [
      ducklang_prelude_text,
      ducklang_functional_prelude_text,
      ducklang_effects_prelude_text,
      ducklang_runtime_prelude_text,
    ]
  ) {
    assert_equals(validate_frontend_semantics(parse_source(text)), []);
  }
});

Deno.test("semantic validation reports basic binding annotations", () => {
  const source = parse_source("let value: Text = 1\nvalue");
  assert_equals(validate_frontend_semantics(source), [{
    code: "DUCK2306",
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
      code: "DUCK2306",
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
    code: "DUCK2003",
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
      "constant(41) + condition(true)",
  );
  assert_equals(validate_frontend_semantics(source), []);
});

Deno.test("semantic validation requires explicit Text to Bytes conversion", () => {
  const source = parse_source('let value: Bytes = "abc"\nlen(value)');
  assert_equals(validate_frontend_semantics(source), [{
    code: "DUCK2306",
    severity: "error",
    message: "Binding annotation expects Bytes, got Text",
    span: { start: 19, end: 24 },
  }]);
});

Deno.test("semantic validation distinguishes Bytes.empty from Text", () => {
  const bytes = parse_source("let value: Bytes = Bytes.empty\nlen(value)");
  assert_equals(validate_frontend_semantics(bytes), []);

  const text = parse_source("let value: Text = Bytes.empty\nlen(value)");
  const diagnostics = validate_frontend_semantics(text);
  assert_equals(diagnostics.length, 1);
  assert_equals(
    diagnostics[0]?.message,
    "Binding annotation expects Text, got Bytes",
  );
});

Deno.test("semantic validation reports one const capture cause", () => {
  const source = parse_source(
    "let runtime = 1\nconst invalid = comptime comptime runtime\ninvalid",
  );
  const diagnostics = validate_frontend_semantics(source);
  assert_equals(diagnostics.length, 1);
  assert_equals(diagnostics[0]?.code, "DUCK2101");
});

Deno.test("value packs pass and return without becoming stored tuples", () => {
  const accepted = parse_source(`
let swap = (left, right) => (right, left)
let (first, second) = swap(1, 2)
[first, second]
`);
  assert_equals(validate_frontend_semantics(accepted), []);

  const stored = parse_source("let pair = (1, 2)\npair");
  assert_equals(
    validate_frontend_semantics(stored).map((diagnostic) => diagnostic.message),
    [
      "Value packs may only be passed, returned, or destructured immediately; use `[...]` to store a tuple",
    ],
  );
});

Deno.test("calls distinguish argument packs from tuple values", () => {
  const pack_call = parse_source(
    "let choose = (left, right) => left\nchoose([1, 2])",
  );
  assert_equals(
    validate_frontend_semantics(pack_call).map((diagnostic) =>
      diagnostic.message
    ),
    ["Call requires an argument pack written `f(a, b)`"],
  );

  const tuple_call = parse_source(
    "let choose = [left, right] => left\nchoose(1, 2)",
  );
  assert_equals(
    validate_frontend_semantics(tuple_call).map((diagnostic) =>
      diagnostic.message
    ),
    ["Call requires a tuple argument written `f([a, b])`"],
  );
});

Deno.test("semantic warning liveness traverses handlers and type tests", async () => {
  for (
    const path of [
      "examples/handlers/01_local_counter.duck",
      "examples/compile_time/10_extensions_and_protocols.duck",
      "examples/data/14_type_sets.duck",
    ]
  ) {
    const source = parse_source(await Deno.readTextFile(path));
    const diagnostics = validate_frontend_semantics(source, {
      warnings: true,
    });
    assert_equals(diagnostics, []);
  }
});
