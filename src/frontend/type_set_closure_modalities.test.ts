import { assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("atom singleton closure parameters use an unboxed i32", () => {
  const wat = Source.wat(`
let choice = 1 == 1
let identity = if choice {
  (value: #hello) => value
} else {
  (value: #hello) => value
}
identity(#hello)
`);

  assert_includes(wat, "call_indirect");
  assert_includes(wat, "i32.const");
});

Deno.test("shareable closure parameters reject until facts persist", () => {
  assert_throws(
    () => Source.wat("let length = (value: #Text) => @len(value)\n0"),
    "First-class closure ownership-qualified parameter annotations are not supported yet",
  );
});

Deno.test("binding signatures contextualize borrowed named function parameters", () => {
  const wat = Source.wat(`
let measure: &Bytes -> I32 = bytes => @len(bytes)
let bytes: Bytes = Bytes.empty
measure(&bytes)
`);

  assert_includes(wat, "i32.const 0");
});

Deno.test("closure parameters reject annotations with no runtime representation", () => {
  assert_throws(
    () => Source.wat("let identity = (value: Never) => value\nidentity(0)"),
    "Cannot check core first-class closure parameter annotation: Never",
  );
});

Deno.test("direct singleton closure calls validate their arguments", () => {
  assert_throws(
    () =>
      Source.wat("let identity = (value: #hello) => value\nidentity(#goodbye)"),
    "Core parameter annotation expects #hello",
  );
});

Deno.test("selected singleton closures retain their parameter constraints", () => {
  assert_throws(
    () =>
      Source.wat(`
let choice = 1 == 1
let identity = if choice {
  (value: #hello) => value
} else {
  (value: #hello) => value
}
identity(#goodbye)
`),
    "Core parameter annotation expects #hello",
  );
  assert_throws(
    () =>
      Source.wat(`
let choice = 1 == 1
let identity = if choice {
  (value: #hello) => value
} else {
  (value: #goodbye) => value
}
identity(#hello)
`),
    "Core closure if branch type mismatch",
  );
  assert_throws(
    () =>
      Source.wat(`
let choice = 1 == 1
let identity = if choice {
  (value: #hello) => value
} else {
  value => value
}
identity(#hello)
`),
    "parameter constraint requires an explicit annotation",
  );
});
