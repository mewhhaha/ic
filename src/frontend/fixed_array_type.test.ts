import { assert_equals, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { fixed_array_length } from "./fixed_array_type.ts";

Deno.test("fixed array lengths require non-negative integer literals", () => {
  assert_equals(fixed_array_length({ tag: "number", value: 3 }), 3);

  assert_throws(
    () => fixed_array_length({ tag: "name", name: "width" }),
    "Fixed array length must be a non-negative integer literal",
  );
});

Deno.test("semantic validation checks fixed array literal annotations", () => {
  const analysis = Source.analyze(`
let values: [Int; 2] = [1, 2i64]
`);

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Binding annotation [Int; 2] item 1 expects I32, got I64"],
  );
});

Deno.test("semantic validation rejects nonliteral fixed array lengths", () => {
  const analysis = Source.analyze(`
let width = 2
let values: [Int; width] = [1, 2]
`);

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Fixed array length must be a non-negative integer literal"],
  );
});
