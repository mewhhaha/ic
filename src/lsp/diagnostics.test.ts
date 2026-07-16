import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import { analysis_diagnostics, parse_diagnostics } from "./diagnostics.ts";

Deno.test("parse diagnostics use scanner offsets instead of error text positions", () => {
  const diagnostics = parse_diagnostics("let = 1\n");

  assert_equals(diagnostics, [{
    range: {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 5 },
    },
    severity: 1,
    source: "duck",
    message: "Expected pattern binding at 1:5",
  }]);
});

Deno.test("parse diagnostics report one range for an invalid Unicode scalar", () => {
  const diagnostics = parse_diagnostics("😀\nlet value = 1\n");

  assert_equals(diagnostics, [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 2 },
    },
    severity: 1,
    source: "duck",
    message: "Unexpected character: 😀",
  }]);
});

Deno.test("semantic warnings retain code and map to LSP warning severity", () => {
  const text = "let value = 1\n";
  const parsed = Source.parse_with_diagnostics(text);
  const diagnostics = analysis_diagnostics(
    {
      source: parsed.source,
      syntax: parsed.syntax,
      syntax_diagnostics: [],
      diagnostics: [{
        code: "DUCK2003",
        severity: "warning",
        message: "Unused runtime binding value",
        span: { start: 0, end: 13 },
      }],
    },
    "file:///warning.duck",
    "utf-16",
  );

  assert_equals(diagnostics, [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 13 },
    },
    severity: 2,
    source: "duck",
    code: "DUCK2003",
    message: "Unused runtime binding value",
  }]);
});

Deno.test("semantic diagnostics carry same-document related information", () => {
  const uri = "file:///linear.duck";
  const diagnostics = analysis_diagnostics(
    Source.analyze("let !token = 41\n!token + !token\n", { uri }),
    uri,
    "utf-16",
  );
  const diagnostic = diagnostics[0];

  if (diagnostic === undefined) {
    throw new Error("Missing linear diagnostic");
  }

  assert_equals(diagnostic.code, "DUCK2201");
  assert_equals(diagnostic.range, {
    start: { line: 1, character: 9 },
    end: { line: 1, character: 15 },
  });
  assert_equals(diagnostic.relatedInformation, [{
    location: {
      uri,
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 6 },
      },
    },
    message: "First consumed here",
  }, {
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 15 },
      },
    },
    message: "Linear value declared here",
  }]);
});

Deno.test("LSP preserves the compiler diagnostic sequence and identities", () => {
  const text = "let unused = 1\nlet !token = 2\n!token + !token\n";
  const analysis = Source.analyze(text, { warnings: true });
  const diagnostics = analysis_diagnostics(
    analysis,
    "file:///sequence.duck",
    "utf-16",
  );

  assert_equals(
    diagnostics.map((diagnostic) => {
      let severity = "error";

      if (diagnostic.severity === 2) {
        severity = "warning";
      }

      return {
        code: diagnostic.code,
        severity,
        message: diagnostic.message,
      };
    }),
    analysis.diagnostics.map((diagnostic) => {
      return {
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
      };
    }),
  );
});
