import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import type { SourceDiagnostic } from "./semantic_diagnostic.ts";

function linear_diagnostics(text: string): SourceDiagnostic[] {
  return Source.analyze(text).diagnostics.filter((diagnostic) => {
    return diagnostic.code.startsWith("IX22");
  });
}

Deno.test("linear scalar ownership example remains valid", async () => {
  const text = await Deno.readTextFile(
    "examples/ownership_modules/01_linear_scalar.ix",
  );

  assert_equals(Source.analyze(text).diagnostics, []);
});

Deno.test("linear consumption without rebinding reports the consumed expression", () => {
  const diagnostics = linear_diagnostics("let !x = 1\n!x\n42");

  assert_equals(diagnostics, [{
    code: "IX2203",
    severity: "error",
    message: "Linear value x is consumed but not rebound",
    span: { start: 11, end: 13 },
    related: [{
      message: "First consumed here",
      span: { start: 11, end: 13 },
    }, {
      message: "Linear value declared here",
      span: { start: 0, end: 10 },
    }],
  }]);
});

Deno.test("linear branch mismatch reports the complete conditional", () => {
  const diagnostics = linear_diagnostics(
    "let main = (!x, flag) => if flag { !x } else { 0 }\nmain(1, 1)",
  );

  assert_equals(diagnostics, [{
    code: "IX2205",
    severity: "error",
    message: "Linear branches must consume the same values",
    span: { start: 25, end: 50 },
    related: [{
      message: "First consumed here",
      span: { start: 35, end: 37 },
    }, {
      message: "Linear value declared here",
      span: { start: 12, end: 14 },
    }],
  }]);
});

Deno.test("linear fallthrough mismatch reports the branch statement", () => {
  const diagnostics = linear_diagnostics(
    "let bad = (!x) => {\n  if 1 {\n    !x\n  }\n  x\n}\nbad(41)",
  );

  assert_equals(diagnostics, [{
    code: "IX2205",
    severity: "error",
    message: "Linear loop if fallthrough changes carried values",
    span: { start: 22, end: 39 },
    related: [{
      message: "First consumed here",
      span: { start: 33, end: 35 },
    }, {
      message: "Linear value declared here",
      span: { start: 11, end: 13 },
    }],
  }]);
});

Deno.test("linear closure reuse reports both calls and its declaration", () => {
  const diagnostics = linear_diagnostics(
    "let !x = 1\nlet take = () => !x + 1\nx = take()\nx = take()\nx",
  );

  assert_equals(diagnostics, [{
    code: "IX2206",
    severity: "error",
    message: "Linear closure take was already consumed",
    span: { start: 50, end: 56 },
    related: [{
      message: "Linear closure first consumed here",
      span: { start: 39, end: 45 },
    }, {
      message: "Linear closure declared here",
      span: { start: 11, end: 34 },
    }],
  }]);
});

Deno.test("static conditions select linear closures for Bool and I32 literals", () => {
  const static_linear_closures = [
    "let main = (!x) => {\n" +
    "  let consume = if true { () => !x } else { () => 0 }\n" +
    "  consume()\n" +
    "}\n" +
    "main(1)",
    "let main = (!x) => {\n" +
    "  let consume = if false { () => 0 } else { () => !x }\n" +
    "  consume()\n" +
    "}\n" +
    "main(1)",
    "let main = (!x) => {\n" +
    "  let consume = if 1 { () => !x } else { () => 0 }\n" +
    "  consume()\n" +
    "}\n" +
    "main(1)",
    "let main = (!x) => {\n" +
    "  let consume = if 0 { () => 0 } else { () => !x }\n" +
    "  consume()\n" +
    "}\n" +
    "main(1)",
  ];

  for (const source of static_linear_closures) {
    assert_equals(linear_diagnostics(source), []);
  }
});

Deno.test("linear diagnostics retain spans through synthesized closure branches", () => {
  const diagnostics = linear_diagnostics(
    "let main = (!x, flag) => {\n" +
      "  let f = if flag {\n" +
      "    () => !x\n" +
      "  } else {\n" +
      "    () => 0\n" +
      "  }\n" +
      "  f()\n" +
      "}\n" +
      "main(1, 1)",
  );

  assert_equals(diagnostics, [{
    code: "IX2205",
    severity: "error",
    message: "Linear branches must consume the same values",
    span: { start: 37, end: 86 },
    related: [{
      message: "First consumed here",
      span: { start: 57, end: 59 },
    }, {
      message: "Linear value declared here",
      span: { start: 12, end: 14 },
    }],
  }]);
});

Deno.test("linear loop state mismatch reports the loop and moved declaration", () => {
  const diagnostics = linear_diagnostics(
    "let main = (!x) => {\n  for i in 0..2 {\n    let !y = !x\n  }\n  !x\n}\nmain(1)",
  );

  assert_equals(diagnostics, [{
    code: "IX2205",
    severity: "error",
    message: "Linear loop fallthrough changes carried values",
    span: { start: 23, end: 58 },
    related: [{
      message: "First consumed here",
      span: { start: 52, end: 54 },
    }, {
      message: "Linear value declared here",
      span: { start: 12, end: 14 },
    }],
  }]);
});

Deno.test("linear rebind without consumption reports the assignment", () => {
  const diagnostics = linear_diagnostics("let !x = 1\nx = 2\n!x");

  assert_equals(diagnostics, [{
    code: "IX2207",
    severity: "error",
    message: "Linear value x was rebound without being consumed",
    span: { start: 11, end: 16 },
    related: [{
      message: "Linear value declared here",
      span: { start: 0, end: 10 },
    }],
  }]);
});

Deno.test("implicit linear use reports the exact variable reference", () => {
  const diagnostics = linear_diagnostics("let !x = 1\nx + 1");

  assert_equals(diagnostics, [{
    code: "IX2204",
    severity: "error",
    message: "Linear value x used without explicit consumption",
    span: { start: 11, end: 12 },
    related: [{
      message: "Linear value declared here",
      span: { start: 0, end: 10 },
    }],
  }]);
});

Deno.test("recursive linear closure validation reports the recursive call", () => {
  const diagnostics = linear_diagnostics(
    "let main = (!x) => {\n" +
      "  let recurse = () => recurse()\n" +
      "  recurse()\n" +
      "  !x\n" +
      "}\n" +
      "main(1)",
  );

  assert_equals(diagnostics, [{
    code: "IX2290",
    severity: "error",
    message: "Cannot validate recursive linear closure call yet: recurse",
    span: { start: 43, end: 52 },
  }]);
});

Deno.test("record patterns preserve linear validation", () => {
  const diagnostics = linear_diagnostics(
    "let !x = 1\nlet { a, b } = pair\n!x",
  );

  assert_equals(diagnostics, []);
});
