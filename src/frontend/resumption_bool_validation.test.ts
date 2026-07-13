import { assert_equals } from "../assert.ts";
import { Source, SourceDiagnosticError } from "../frontend.ts";

function assert_resumption_input_diagnostic(
  source: string,
  resumption_name: string,
  expected_type: string,
  actual_type: string,
  call_text: string,
  argument_text: string,
): void {
  const call_start = source.indexOf(call_text);
  const argument_start = call_start + call_text.indexOf(argument_text);
  const diagnostic = {
    code: "IX2307",
    severity: "error" as const,
    message: "Resumption " + resumption_name + " expects " + expected_type +
      ", got " + actual_type,
    span: {
      start: argument_start,
      end: argument_start + argument_text.length,
    },
  };

  assert_equals(
    Source.analyze(source, { route: "core" }).diagnostics,
    [diagnostic],
  );

  try {
    Source.core(source);
  } catch (error) {
    if (!(error instanceof SourceDiagnosticError)) {
      throw error;
    }

    assert_equals(error.diagnostic, diagnostic);
    return;
  }

  throw new Error("Expected Source.core to reject the resumption call");
}

Deno.test("resumption aliases retain Bool input types", () => {
  const source = `effect E { op: () => Bool }
let run = () => { value <- E.op(); value }
let h = E {
  op: (!resume) => { let !later = !resume; !later(1) },
  return: value => value,
}
try run() with h`;

  assert_resumption_input_diagnostic(
    source,
    "later",
    "Bool",
    "I32",
    "!later(1)",
    "1",
  );
});

Deno.test("resumption aliases retain I32 input types", () => {
  const source = `effect E { op: () => I32 }
let run = () => { value <- E.op(); value }
let h = E {
  op: (!resume) => { let !later = !resume; !later(true) },
  return: value => value,
}
try run() with h`;

  assert_resumption_input_diagnostic(
    source,
    "later",
    "I32",
    "Bool",
    "!later(true)",
    "true",
  );
});

Deno.test("duplicated resumptions retain Bool input types", () => {
  const source = `effect E { op: () => Bool }
let run = () => { value <- E.op(); value }
let h = E {
  op: (!resume) => {
    let (!left, !right) = dup !resume
    !left(1)
    !right(true)
  },
  return: value => value,
}
try run() with h`;

  assert_resumption_input_diagnostic(
    source,
    "left",
    "Bool",
    "I32",
    "!left(1)",
    "1",
  );
});

Deno.test("duplicated resumptions retain I32 input types", () => {
  const source = `effect E { op: () => I32 }
let run = () => { value <- E.op(); value }
let h = E {
  op: (!resume) => {
    let (!left, !right) = dup !resume
    !left(true)
    !right(1)
  },
  return: value => value,
}
try run() with h`;

  assert_resumption_input_diagnostic(
    source,
    "left",
    "I32",
    "Bool",
    "!left(true)",
    "true",
  );
});
