import { assert_equals, assert_includes } from "../assert.ts";
import { Source } from "../frontend.ts";
import { named_rec_function_core } from "./named_rec.ts";

Deno.test("named function parameters shadow top-level bindings", () => {
  const core = Source.core(`
let increment: I32 -> I32 = value => value + 1
let value = 41
increment(1)
`);
  const definition = core.recFunctions?.increment;

  if (definition === undefined) {
    throw new Error("Expected increment to lower as a named function");
  }

  const function_core = named_rec_function_core(core, definition);
  const shadowing_binding = function_core.statements.find((statement) => {
    return statement.tag === "bind" && statement.name === "value";
  });

  assert_equals(shadowing_binding, undefined);
});

Deno.test("named function parameter layout shadows a differently typed local", () => {
  const wat = Source.wat(Source.parse(`
let render: I64 -> Text = (value: I64) => {
  if value == 0i64 { "zero" } else { "other" }
}
let value = 1
render(0i64)
`));

  assert_includes(wat, "(param $value i64)");
});

Deno.test("runtime functions may accept borrowed parameters", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type Pair = struct { .left = I32, .right = I32 }

let sum: &Pair -> I32 = (pair: &Pair) => pair.left + pair.right
let pair = Pair.new { .left = 20, .right = 22 }
sum(&pair)
`);
  const definition = core.recFunctions?.sum;

  if (definition === undefined) {
    throw new Error("Expected sum to lower as a named function");
  }

  assert_equals(definition.params[0]?.annotation, "&Pair");
});
