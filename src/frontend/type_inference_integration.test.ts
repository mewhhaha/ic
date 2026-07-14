import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("source analysis applies exact inferred call constraints to facts", () => {
  const analysis = Source.analyze(`
let choose = (value: (.x = I32)) => value
choose(.y = 1)
`);
  const call = analysis.facts.expressions.find((expression) =>
    expression.tag === "app"
  );

  if (call === undefined) {
    throw new Error("Missing analyzed call expression");
  }

  assert_equals(
    analysis.diagnostics.map((diagnostic) => {
      return { code: diagnostic.code, message: diagnostic.message };
    }),
    [{
      code: "IX2310",
      message:
        "call argument 1: cannot unify (.x = I32) with I32: type constructors differ",
    }],
  );
  assert_equals(analysis.facts.editor_type_of.get(call)?.name, "unknown");
});

Deno.test("source analysis reports unresolved explicit annotation variables", () => {
  const unresolved = Source.analyze("let value: missing = 1");

  assert_equals(
    unresolved.diagnostics.map((diagnostic) => {
      return { code: diagnostic.code, message: diagnostic.message };
    }),
    [{
      code: "IX2311",
      message:
        "binding value: unresolved inference variables ?0(missing) in ?0(missing)",
    }],
  );

  const generic = Source.analyze(`
let identity = value => value
identity(true)
identity(1)
`);

  assert_equals(generic.diagnostics, []);
});
