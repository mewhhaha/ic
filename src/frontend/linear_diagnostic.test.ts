import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import type { SourceDiagnostic } from "./semantic_diagnostic.ts";

function linear_diagnostics(text: string): SourceDiagnostic[] {
  return Source.analyze(text).diagnostics.filter((diagnostic) => {
    return diagnostic.code.startsWith("DUCK22");
  });
}

Deno.test("linear scalar ownership example remains valid", async () => {
  const text = await Deno.readTextFile(
    "examples/ownership_modules/01_linear_scalar.duck",
  );

  assert_equals(Source.analyze(text).diagnostics, []);
});

Deno.test("linear consumption without rebinding reports the consumed expression", () => {
  const diagnostics = linear_diagnostics("let !x = 1;\n!x\n42");

  assert_equals(diagnostics, [{
    code: "DUCK2203",
    severity: "error",
    message: "Linear value x is consumed but not rebound",
    span: { start: 12, end: 14 },
    related: [{
      message: "First consumed here",
      span: { start: 12, end: 14 },
    }, {
      message: "Linear value declared here",
      span: { start: 0, end: 11 },
    }],
  }]);
});

Deno.test("linear branch mismatch reports the complete conditional", () => {
  const diagnostics = linear_diagnostics(
    "let main = (!x, flag) => if flag { !x } else { 0 };\nmain(1, 1)",
  );

  assert_equals(diagnostics, [{
    code: "DUCK2205",
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
    "let bad = (!x) => {\n  if true {\n    !x\n  }\n  x\n};\nbad(41)",
  );

  assert_equals(diagnostics, [{
    code: "DUCK2205",
    severity: "error",
    message: "Linear loop if fallthrough changes carried values",
    span: { start: 22, end: 42 },
    related: [{
      message: "First consumed here",
      span: { start: 36, end: 38 },
    }, {
      message: "Linear value declared here",
      span: { start: 11, end: 13 },
    }],
  }]);
});

Deno.test("linear closure reuse reports both calls and its declaration", () => {
  const diagnostics = linear_diagnostics(
    "let !x = 1;\nlet take = () => !x + 1;\nx = take()\nx = take()\nx",
  );

  assert_equals(diagnostics, [{
    code: "DUCK2206",
    severity: "error",
    message: "Linear closure take was already consumed",
    span: { start: 52, end: 58 },
    related: [{
      message: "Linear closure first consumed here",
      span: { start: 41, end: 47 },
    }, {
      message: "Linear closure declared here",
      span: { start: 12, end: 36 },
    }],
  }]);
});

Deno.test("static conditions select linear closures for Bool and I32 literals", () => {
  const static_linear_closures = [
    `let main = (!x) => {
  let consume = if true { () => !x } else { () => 0 };
  consume()
};
main(1)`,
    `let main = (!x) => {
  let consume = if false { () => 0 } else { () => !x };
  consume()
};
main(1)`,
    `let main = (!x) => {
  let consume = if true { () => !x } else { () => 0 };
  consume()
};
main(1)`,
    `let main = (!x) => {
  let consume = if false { () => 0 } else { () => !x };
  consume()
};
main(1)`,
  ];

  for (const source of static_linear_closures) {
    assert_equals(linear_diagnostics(source), []);
  }
});

Deno.test("linear diagnostics retain spans through synthesized closure branches", () => {
  const diagnostics = linear_diagnostics(
    `let main = (!x, flag) => {
  let f = if flag {
    () => !x
  } else {
    () => 0
  };
  f()
};
main(1, 1)`,
  );

  assert_equals(diagnostics, [{
    code: "DUCK2205",
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
    "let main = (!x) => {\n  for i in 0..2 {\n    let !y = !x;\n  }\n  !x\n};\nmain(1)",
  );

  assert_equals(diagnostics, [{
    code: "DUCK2205",
    severity: "error",
    message: "Linear loop fallthrough changes carried values",
    span: { start: 23, end: 59 },
    related: [{
      message: "First consumed here",
      span: { start: 52, end: 54 },
    }, {
      message: "Linear value declared here",
      span: { start: 12, end: 14 },
    }],
  }]);
});

Deno.test("linear match loop arms validate terminal and fallthrough paths", () => {
  const valid = linear_diagnostics(`
let main = (!x, flag) => {
  for i in 0..2 {
    match flag {
      | 1 => { x = !x + 1; break; }
      | _ => { x = !x + 1 }
    }
  }
  x
};
main(40, 1)
`);

  assert_equals(valid, []);

  const invalid = linear_diagnostics(`
let main = (!x, flag) => {
  for i in 0..2 {
    match flag {
      | 1 => { !x; break; }
      | _ => { x = !x + 1 }
    }
  }
  x
};
main(40, 1)
`);

  assert_equals(invalid.map((diagnostic) => diagnostic.message), [
    "Linear value x is consumed but not rebound",
  ]);
});

Deno.test("linear rebind without consumption reports the assignment", () => {
  const diagnostics = linear_diagnostics("let !x = 1;\nx = 2\n!x");

  assert_equals(diagnostics, [{
    code: "DUCK2207",
    severity: "error",
    message: "Linear value x was rebound without being consumed",
    span: { start: 12, end: 17 },
    related: [{
      message: "Linear value declared here",
      span: { start: 0, end: 11 },
    }],
  }]);
});

Deno.test("implicit linear use reports the exact variable reference", () => {
  const diagnostics = linear_diagnostics("let !x = 1;\nx + 1");

  assert_equals(diagnostics, [{
    code: "DUCK2204",
    severity: "error",
    message: "Linear value x used without explicit consumption",
    span: { start: 12, end: 13 },
    related: [{
      message: "Linear value declared here",
      span: { start: 0, end: 11 },
    }],
  }]);
});

Deno.test("recursive linear closure validation reports the recursive call", () => {
  const diagnostics = linear_diagnostics(
    `let main = (!x) => {
  let recurse = () => recurse();
  recurse()
  !x
};
main(1)`,
  );

  assert_equals(diagnostics, [{
    code: "DUCK2290",
    severity: "error",
    message: "Cannot validate recursive linear closure call yet: recurse",
    span: { start: 43, end: 52 },
  }]);
});

Deno.test("record patterns preserve linear validation", () => {
  const diagnostics = linear_diagnostics(
    "let !x = 1;\nlet { .a, .b } = pair;\n!x",
  );

  assert_equals(diagnostics, []);
});
