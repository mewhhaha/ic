import { assert_equals, assert_includes } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("direct generic type-set binding annotations retain their envelope", () => {
  const wat = Source.wat(`
type Maybe a = a | #nothing
let value: Maybe Int = 42
if value is Int { value } else { 0 }
`);

  assert_includes(wat, "i32.const 42");
  assert_equals(wat.includes("$__alloc"), false);
});

Deno.test("direct generic type-set closure parameters inject call arguments", () => {
  const wat = Source.wat(`
type Maybe a = a | #nothing
let unwrap = (value: Maybe Int) => if value is Int { value } else { 0 }
unwrap(42)
`);

  assert_includes(wat, "i32.const 42");
  assert_equals(wat.includes("$__alloc"), false);
});
