import { assert_equals, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import type { FrontExpr, Source as SourceNode } from "./ast.ts";

const core_route_message =
  "use Source.core, Source.mod, or Source.wat for structured Core/Wasm lowering";

Deno.test("IC route preserves host effect declarations", () => {
  assert_equals(
    Source.compile(`
declare effect Io { read: () => I32 }
42
`),
    { tag: "num", type: "i32", value: 42 },
  );
});

Deno.test("IC route rejects Ix-defined effect declarations", () => {
  assert_throws(
    () =>
      Source.compile(`
effect Counter { get: () => I32 }
42
`),
    "Cannot lower Ix-defined effect Counter through pure Ic",
  );
});

Deno.test("IC route rejects every local handler node", () => {
  assert_throws(
    () => Source.ic_mod(program({ tag: "unit" })),
    "Cannot lower unit value through pure Ic",
  );
  assert_throws(
    () => Source.ic_mod(program(handler_expr())),
    "Cannot lower handler through pure Ic",
  );
  assert_throws(
    () =>
      Source.ic_wat(program({
        tag: "try_with",
        body: { tag: "num", type: "i32", value: 42 },
        handler: handler_expr(),
      })),
    "Cannot lower try-with handler expression through pure Ic",
  );
  assert_throws(
    () =>
      Source.ic_mod({
        tag: "program",
        statements: [
          {
            tag: "resume_dup",
            left: "left",
            right: "right",
            value: { tag: "linear", name: "resume" },
          },
          {
            tag: "expr",
            expr: { tag: "num", type: "i32", value: 42 },
          },
        ],
      }),
    "Cannot lower resumption duplication through pure Ic",
  );
});

Deno.test("IC route rejects nested handlers before ordinary lowering", () => {
  const source: SourceNode = {
    tag: "program",
    statements: [{
      tag: "bind",
      kind: "let",
      name: "factory",
      is_linear: false,
      annotation: undefined,
      value: {
        tag: "lam",
        params: [],
        body: handler_expr(),
      },
    }, {
      tag: "expr",
      expr: { tag: "num", type: "i32", value: 42 },
    }],
  };

  assert_throws(() => Source.emit(source), core_route_message);
});

Deno.test("IC file route rejects Ix-defined effects", () => {
  const directory = Deno.makeTempDirSync();
  const path = directory + "/counter.ix";

  try {
    Deno.writeTextFileSync(
      path,
      `module () where
effect Counter { get: () => I32 }
return {}
`,
    );
    assert_throws(
      () => Source.compile_file(path),
      "Cannot lower Ix-defined effect Counter through pure Ic",
    );
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

function program(expr: FrontExpr): SourceNode {
  return {
    tag: "program",
    statements: [{ tag: "expr", expr }],
  };
}

function handler_expr(): Extract<
  FrontExpr,
  { tag: "handler" }
> {
  return {
    tag: "handler",
    effect: "Counter",
    state: [],
    clauses: [],
    return_clause: {
      param: {
        name: "value",
        is_const: false,
        is_linear: false,
        annotation: undefined,
      },
      body: { tag: "var", name: "value" },
    },
  };
}
