import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import { source_facts } from "../frontend/source_facts.ts";
import { analysis_diagnostics, parse_diagnostics } from "./diagnostics.ts";

Deno.test("parse diagnostics use scanner offsets instead of error text positions", () => {
  const diagnostics = parse_diagnostics("let = 1\n");

  assert_equals(diagnostics, [{
    range: {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 5 },
    },
    severity: 1,
    source: "ix",
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
    source: "ix",
    message: "Unexpected character: 😀",
  }]);
});

Deno.test("semantic warnings retain code and map to LSP warning severity", () => {
  const text = "let value = 1\n";
  const parsed = Source.parse_with_diagnostics(text);
  const diagnostics = analysis_diagnostics(
    {
      source: parsed.source,
      facts: source_facts(parsed.source),
      syntax: parsed.syntax,
      syntax_diagnostics: [],
      diagnostics: [{
        code: "IX2003",
        severity: "warning",
        message: "Unused runtime binding value",
        span: { start: 0, end: 13 },
      }],
    },
    "file:///warning.ix",
    "utf-16",
  );

  assert_equals(diagnostics, [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 13 },
    },
    severity: 2,
    source: "ix",
    code: "IX2003",
    message: "Unused runtime binding value",
  }]);
});

Deno.test("semantic diagnostics carry same-document related information", () => {
  const uri = "file:///linear.ix";
  const diagnostics = analysis_diagnostics(
    Source.analyze("let !token = 41\n!token + !token\n", { uri }),
    uri,
    "utf-16",
  );
  const diagnostic = diagnostics[0];

  if (diagnostic === undefined) {
    throw new Error("Missing linear diagnostic");
  }

  assert_equals(diagnostic.code, "IX2201");
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
