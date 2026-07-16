import { assert_equals } from "../assert.ts";
import { CompilerDiagnosticError } from "../diagnostic.ts";
import { Source } from "../frontend/source.ts";
import { Core } from "./backend/core.ts";

Deno.test("Core proof maps ownership fixtures to ranged diagnostics", () => {
  const fixtures = [
    {
      text: `let escape = (message: Text) => {
  &message
}

let message: Text = @append("a", "b")
escape(message)`,
      code: "DUCK2401",
      span: { start: 86, end: 101 },
    },
    {
      text: `let message: Text = @append("a", "b")
let view = &message
let frozen = freeze message

@len(view) + @len(frozen)`,
      code: "DUCK2402",
      span: { start: 71, end: 85 },
    },
    {
      text: `scratch {
  @append("a", "b")
}`,
      code: "DUCK2403",
      span: { start: 0, end: 31 },
    },
    {
      text: `let message: Bytes = freeze @Utf8.encode("ab")
message[0] = 65
@len(message)`,
      code: "DUCK2404",
      span: { start: 47, end: 62 },
    },
  ];

  for (const fixture of fixtures) {
    const core = Core.from_source(Source.parse(fixture.text));

    try {
      Core.check_proof(core);
    } catch (error) {
      if (!(error instanceof CompilerDiagnosticError)) {
        throw error;
      }

      assert_equals(error.diagnostic.code, fixture.code);
      assert_equals(error.diagnostic.span, fixture.span);
      continue;
    }

    throw new Error("Expected Core proof diagnostic: " + fixture.code);
  }
});

Deno.test("Core source origins do not change structural Core values", () => {
  const core = Core.from_source(Source.parse("1"));

  assert_equals(core, {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: { tag: "num", type: "i32", value: 1 },
    }],
  });

  assert_equals(Source.core("1"), core);
});

Deno.test("Core proof rows keep diagnostic subjects out of public shapes", () => {
  const borrowed = Core.proof(
    Core.from_source(Source.parse(`let message: Text = @append("a", "b")
&message`)),
  );
  const frozen = Core.proof(
    Core.from_source(Source.parse(`let message: Text = @append("a", "b")
freeze message`)),
  );
  const scratch = Core.proof(Core.from_source(Source.parse(`scratch {
  @append("a", "b")
}`)));

  const borrow = borrowed.borrow_view_rows[0];
  const freeze = frozen.freeze_edges[0];
  const cleanup = scratch.cleanup.steps[0];

  if (!borrow || !freeze || !cleanup) {
    throw new Error("Expected Core proof rows");
  }

  assert_equals(Object.keys(borrow).includes("subject"), false);
  assert_equals(Object.keys(freeze).includes("subject"), false);
  assert_equals(Object.keys(cleanup).includes("subject"), false);
});
