import { assert_equals } from "../assert.ts";
import { success_examples } from "../../examples/manifest.ts";
import { Source } from "../frontend.ts";
import { ducklang_prelude_text } from "./prelude.ts";

Deno.test("Source.analyze reports reused fixture at its second consume", async () => {
  const text = await Deno.readTextFile(
    "examples/failures/compile/01_reused_linear_value.duck",
  );
  const analysis = Source.analyze(text);

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2201",
    severity: "error",
    message: "Linear value token was already consumed",
    span: { start: 26, end: 32 },
    related: [{
      message: "First consumed here",
      span: { start: 17, end: 23 },
    }, {
      message: "Linear value declared here",
      span: { start: 0, end: 16 },
    }],
  }]);
});

Deno.test("Source.analyze reports unused fixture at its declaration", async () => {
  const text = await Deno.readTextFile(
    "examples/failures/compile/02_unused_linear_value.duck",
  );
  const analysis = Source.analyze(text);

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2202",
    severity: "error",
    message: "Linear value token was not consumed",
    span: { start: 0, end: 16 },
  }]);
});

Deno.test("Source.analyze reports reused linear parameters with related spans", () => {
  const text = "let main = (!x) => !x + !x;\nmain(1)";
  const analysis = Source.analyze(text);

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2201",
    severity: "error",
    message: "Linear value x was already consumed",
    span: { start: 24, end: 26 },
    related: [{
      message: "First consumed here",
      span: { start: 19, end: 21 },
    }, {
      message: "Linear value declared here",
      span: { start: 12, end: 14 },
    }],
  }]);
});

Deno.test("Source.analyze accepts linear branches and closures with exact use", () => {
  const branch = Source.analyze(
    "let main = (!x, flag) => if flag { !x } else { !x };\nmain(1, true)",
  );
  const closure = Source.analyze(
    "let main = (!x) => {\n  let consume = () => !x;\n  consume()\n};\nmain(1)",
  );

  assert_equals(branch.diagnostics, []);
  assert_equals(closure.diagnostics, []);
});

Deno.test("Source.analyze returns compiler-owned syntax diagnostics", () => {
  const analysis = Source.analyze("let =");
  const diagnostic = analysis.diagnostics[0];

  assert_equals(diagnostic?.code, "DUCK1001");
  assert_equals(diagnostic?.severity, "error");
  assert_equals(diagnostic?.span.start === 0, false);
});

const failure_goldens = [
  {
    path: "examples/failures/compile/01_reused_linear_value.duck",
    code: "DUCK2201",
    message: "Linear value token was already consumed",
    span: { start: 26, end: 32 },
  },
  {
    path: "examples/failures/compile/02_unused_linear_value.duck",
    code: "DUCK2202",
    message: "Linear value token was not consumed",
    span: { start: 0, end: 16 },
  },
  {
    path: "examples/failures/compile/03_illegal_type_change.duck",
    code: "DUCK2301",
    message: "Assignment changes type for value",
    span: { start: 16, end: 35 },
  },
  {
    path: "examples/failures/compile/04_mixed_integer_widths.duck",
    code: "DUCK2302",
    message: "Mixed i32 and i64 operands for operator +",
    span: { start: 0, end: 12 },
  },
  {
    path: "examples/failures/compile/05_invalid_condition_type.duck",
    code: "DUCK2303",
    message: "If condition expects Bool, got Text",
    span: { start: 3, end: 8 },
  },
  {
    path: "examples/failures/compile/06_missing_struct_field.duck",
    code: "DUCK2304",
    message: "Missing struct field: age",
    span: { start: 121, end: 129 },
  },
  {
    path: "examples/failures/compile/07_invalid_union_payload.duck",
    code: "DUCK2305",
    message: "Union case Ok expects Int, got Text",
    span: { start: 49, end: 62 },
  },
  {
    path: "examples/failures/compile/12_missing_imported_export.duck",
    code: "DUCK2501",
    message: "Import ./missing_import_dependency.duck does not export missing",
    span: { start: 81, end: 88 },
  },
];

Deno.test("Source.analyze_file matches shared frontend failure goldens", () => {
  for (const expected of failure_goldens) {
    const analysis = Source.analyze_file(expected.path);
    assert_equals(analysis.diagnostics.length, 1);
    const diagnostic = analysis.diagnostics[0];

    if (diagnostic === undefined) {
      throw new Error("Missing diagnostic for " + expected.path);
    }

    assert_equals({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      span: diagnostic.span,
    }, {
      code: expected.code,
      message: expected.message,
      span: expected.span,
      severity: "error",
    });
  }
});

Deno.test("Source.analyze keeps every successful example route-agnostic", () => {
  for (const example of success_examples) {
    const analysis = Source.analyze_file(example.path);
    assert_equals(analysis.diagnostics, []);
  }
});

Deno.test("Source.analyze accepts compile-time-only source modules", () => {
  const analysis = Source.analyze(ducklang_prelude_text, {
    uri: "file:///prelude.duck",
    warnings: true,
  });

  assert_equals(analysis.diagnostics, []);
});

Deno.test("Source.analyze continues after a recovered parse statement", () => {
  const analysis = Source.analyze(
    "let =\nlet !token = 41;\n!token + !token;\n",
  );

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.code),
    ["DUCK1001", "DUCK2201"],
  );
});

Deno.test("Source.analyze stays within the largest-example latency budget", async () => {
  let largest = "";

  for (const example of success_examples) {
    const text = await Deno.readTextFile(example.path);

    if (text.length > largest.length) {
      largest = text;
    }
  }

  Source.analyze(largest);
  const start = performance.now();
  Source.analyze(largest);
  const elapsed = performance.now() - start;

  if (elapsed >= 100) {
    throw new Error(
      "Source analysis exceeded 100ms latency budget: " + elapsed.toString(),
    );
  }
});
