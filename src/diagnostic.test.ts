import { assert_equals } from "./assert.ts";
import {
  compiler_diagnostic,
  diagnostic_codes,
  diagnostic_sequence,
  registered_diagnostic,
} from "./diagnostic.ts";

Deno.test("diagnostic sequence assigns registry metadata and orders root causes", () => {
  const type_error = compiler_diagnostic(
    diagnostic_codes.annotation_type_mismatch,
    "Binding annotation expects Bool, got I32",
    { start: 20, end: 25 },
    [{ message: "Value inferred here", span: { start: 10, end: 11 } }, {
      message: "Value inferred here",
      span: { start: 10, end: 11 },
    }],
  );
  const warning = compiler_diagnostic(
    diagnostic_codes.unused_binding,
    "Unused runtime binding value",
    { start: 0, end: 9 },
  );
  const sequence = diagnostic_sequence(
    [type_error, warning, type_error],
    "file:///fixture.duck",
  );

  assert_equals(
    sequence.map((diagnostic) => {
      const definition = registered_diagnostic(diagnostic.code);
      return {
        category: definition.category,
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        span: diagnostic.span,
        uri: diagnostic.uri,
        related: diagnostic.related,
      };
    }),
    [{
      category: "names_and_liveness",
      code: "DUCK2003",
      severity: "warning",
      message: "Unused runtime binding value",
      span: { start: 0, end: 9 },
      uri: "file:///fixture.duck",
      related: undefined,
    }, {
      category: "types_and_effects",
      code: "DUCK2306",
      severity: "error",
      message: "Binding annotation expects Bool, got I32",
      span: { start: 20, end: 25 },
      uri: "file:///fixture.duck",
      related: [{
        message: "Value inferred here",
        span: { start: 10, end: 11 },
        uri: "file:///fixture.duck",
      }],
    }],
  );
});
