import { assert_equals } from "../assert.ts";
import {
  compile_failure_examples,
  success_examples,
} from "../../examples/manifest.ts";
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
    span: { start: 25, end: 31 },
    related: [{
      message: "First consumed here",
      span: { start: 16, end: 22 },
    }, {
      message: "Linear value declared here",
      span: { start: 0, end: 15 },
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
    span: { start: 0, end: 15 },
  }]);
});

Deno.test("Source.analyze reports reused linear parameters with related spans", () => {
  const text = "let main = (!x) => !x + !x\nmain(1)";
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
    "let main = (!x, flag) => if flag { !x } else { !x }\nmain(1, 1)",
  );
  const closure = Source.analyze(
    "let main = (!x) => {\n  let consume = () => !x\n  consume()\n}\nmain(1)",
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
    code: "DUCK2201",
    message: "Linear value token was already consumed",
    span: { start: 25, end: 31 },
  },
  {
    code: "DUCK2202",
    message: "Linear value token was not consumed",
    span: { start: 0, end: 15 },
  },
  {
    code: "DUCK2301",
    message: "Assignment changes type for value",
    span: { start: 15, end: 34 },
  },
  {
    code: "DUCK2302",
    message: "Mixed i32 and i64 operands for operator +",
    span: { start: 0, end: 12 },
  },
  {
    code: "DUCK2303",
    message: "If condition expects Bool or I32, got Text",
    span: { start: 3, end: 8 },
  },
  {
    code: "DUCK2304",
    message: "Missing struct field: age",
    span: { start: 127, end: 135 },
  },
  {
    code: "DUCK2305",
    message: "Union case ok expects Int, got Text",
    span: { start: 53, end: 71 },
  },
  {
    code: "DUCK2401",
    message: "Rejected borrow borrow#0 in block#0: borrow over unique_heap " +
      "text needs lexical lifetime tracking before the owner can be protected",
    span: { start: 79, end: 94 },
  },
  {
    code: "DUCK2402",
    message: "Cannot freeze borrowed owner message in program#0 while " +
      "borrow#0 is active",
    span: { start: 64, end: 78 },
  },
  {
    code: "DUCK2403",
    message: "Rejected baseline proof scratch#0 scratch_return: unique_heap " +
      "text cannot leave scratch without freeze or explicit promotion",
    span: { start: 0, end: 24 },
  },
  {
    code: "DUCK2404",
    message: "Cannot mutate frozen/shareable core binding: message",
    span: { start: 47, end: 62 },
  },
  {
    code: "DUCK2501",
    message: "Import ./missing_import_dependency.duck does not export missing",
    span: { start: 80, end: 87 },
  },
];

Deno.test("Source.analyze_file matches every compile-failure golden", () => {
  assert_equals(compile_failure_examples.length, failure_goldens.length);

  for (let index = 0; index < compile_failure_examples.length; index += 1) {
    const fixture = compile_failure_examples[index];
    const expected = failure_goldens[index];

    if (fixture === undefined || expected === undefined) {
      throw new Error("Missing compile-failure diagnostic golden");
    }

    const analysis = Source.analyze_file(fixture.path, {
      route: fixture.route,
    });
    assert_equals(analysis.diagnostics.length, 1);
    const diagnostic = analysis.diagnostics[0];

    if (diagnostic === undefined) {
      throw new Error("Missing diagnostic for " + fixture.path);
    }

    assert_equals({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      span: diagnostic.span,
    }, {
      ...expected,
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
    route: "core",
    uri: "file:///prelude.duck",
    warnings: true,
  });

  assert_equals(analysis.diagnostics, []);
});

Deno.test("Source.analyze continues after a recovered parse statement", () => {
  const analysis = Source.analyze(
    "let =\nlet !token = 41\n!token + !token\n",
  );

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.code),
    ["DUCK1001", "DUCK2201"],
  );
});

Deno.test("Source.analyze gates pure Ic route diagnostics behind options", () => {
  const text = "effect Counter { get: () => I32 }\n42\n";
  assert_equals(Source.analyze(text).diagnostics, []);
  const analysis = Source.analyze(text, { route: "ic" });
  const diagnostic = analysis.diagnostics[0];

  if (diagnostic === undefined) {
    throw new Error("Missing pure Ic route diagnostic");
  }

  assert_equals(diagnostic.code, "DUCK2901");
  assert_equals(
    text.slice(diagnostic.span.start, diagnostic.span.end),
    "effect Counter { get: () => I32 }",
  );
});

Deno.test("Source.analyze keeps Core diagnostics enabled with imports", async () => {
  const scratch = await Deno.readTextFile(
    "examples/failures/compile/10_scratch_heap_escape.duck",
  );
  const text = 'const available = import "./dep.duck"\n' + scratch;
  const analysis = Source.analyze(text, {
    route: "core",
    uri: "file:///main.duck",
    resolve_import: (uri) => {
      if (uri === "file:///dep.duck") {
        return "module () where\nreturn { .available = 1 }";
      }

      return undefined;
    },
  });

  assert_equals(analysis.diagnostics.length, 1);
  assert_equals(analysis.diagnostics[0]?.code, "DUCK2403");
  assert_equals(
    analysis.diagnostics[0]?.span,
    { start: 38, end: 62 },
  );
});

Deno.test("Source.analyze reports every escaping scratch result", () => {
  const text = 'scratch { @append("a", "b") }\n' +
    'scratch { @append("c", "d") }';
  const diagnostics = Source.analyze(text, { route: "core" }).diagnostics;

  assert_equals(diagnostics.length, 2);
  assert_equals(diagnostics[0]?.code, "DUCK2403");
  assert_equals(diagnostics[1]?.code, "DUCK2403");
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
