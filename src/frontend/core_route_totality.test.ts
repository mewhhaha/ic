import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("Core analysis diagnoses an invalid generic Bool type-set binding", () => {
  const analysis = Source.analyze(
    "type Choice a = a | Text\nlet value: Choice Bool = 1",
    { route: "core" },
  );

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2306",
    severity: "error",
    message: "Type-set binding annotation expects Bool :| Text, got I32",
    span: { start: 50, end: 51 },
  }]);
});

Deno.test("Core analysis diagnoses an unspecialized generic closure annotation", () => {
  const analysis = Source.analyze(
    "type Flag a = a\nlet choose = (value: Flag) => value\nchoose(true)",
    { route: "core" },
  );

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2307",
    severity: "error",
    message: "Cannot check core first-class closure parameter annotation: Flag",
    span: { start: 30, end: 41 },
  }]);
});

Deno.test("Core analysis diagnoses a type alias with an unresolved target", () => {
  const analysis = Source.analyze(
    "type Alias = Missing\nlet value: Alias = 1\nvalue\n",
    { route: "core" },
  );

  assert_equals(analysis.diagnostics, [{
    code: "DUCK2290",
    severity: "error",
    message: "Type alias Alias references unknown type Missing",
    span: { start: 0, end: 20 },
  }]);
});
