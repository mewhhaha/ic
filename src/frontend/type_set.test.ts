import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { instantiate_wat } from "../wasm_test_util.ts";

async function run_i32_source(source: string, name: string): Promise<number> {
  const instance = await instantiate_wat(Source.wat(source), name, {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for " + name);
  }

  const result = main();

  if (typeof result !== "number") {
    throw new Error("Expected i32 result for " + name);
  }

  return result;
}

Deno.test("type-set declarations format with canonical operator spacing", () => {
  assert_equals(
    Source.fmt(Source.parse("type Value=Int:|Text:-Never\n0")),
    "type Value = Int :| Text :- Never\n0",
  );
});

Deno.test("newtype declarations retain their nominal constructor", () => {
  assert_equals(
    Source.fmt(Source.parse("type Centimeter=newtype I32\n0")),
    "type Centimeter = newtype I32\n0",
  );
});

Deno.test("atom singleton annotations lower without allocation", () => {
  const wat = Source.wat(`
const value: #hello = #hello
if value == #hello { 42 } else { 0 }
`);

  assert_includes(wat, "i32.eq");
  assert_includes(wat, "i32.const");
});

Deno.test("literal singleton annotations accept their sole value", () => {
  const integer = Source.wat("const one: 1 = 1\none");
  const boolean = Source.wat(`
const ready: true = true
if ready { 1 } else { 0 }
`);
  const text = Source.wat('const method: "GET" = "GET"\n@len(method)');

  assert_includes(integer, "i32.const 1");
  assert_includes(boolean, "i32.const 1");
  assert_includes(text, "\\47\\45\\54");
});

Deno.test("literal singleton annotations reject every other value", () => {
  assert_throws(
    () => Source.wat("const value: 1 = 2\nvalue"),
    "annotation expects 1, got 2",
  );
  assert_throws(
    () => Source.wat("const value: true = false\nvalue"),
    "annotation expects true, got false",
  );
  assert_throws(
    () => Source.wat('const value: "GET" = "POST"\n@len(value)'),
    'annotation expects "GET", got "POST"',
  );
});

Deno.test("literal unions discriminate integer text and boolean members", async () => {
  const integer = await run_i32_source(
    `
type Bit = 0 :| 1
let bit: Bit = 1
if bit is 1 { 42 } else { 0 }
`,
    "integer_literal_union",
  );
  const text = await run_i32_source(
    `
type Method = "GET" :| "POST"
let method: Method = "POST"
if method is "POST" { 42 } else { 0 }
`,
    "text_literal_union",
  );
  const boolean = await run_i32_source(
    `
type Truth = true :| false
let truth: Truth = false
if truth is false { 42 } else { 0 }
`,
    "boolean_literal_union",
  );

  assert_equals(integer, 42);
  assert_equals(text, 42);
  assert_equals(boolean, 42);
});

Deno.test("finite atom and arbitrary type unions inject plain values", () => {
  const atoms = Source.wat(`
type Truth = #true :| #false
let value: Truth = #true
if let \`Set1 _ = value { 42 } else { 0 }
`);
  const scalar = Source.wat(`
type Scalar = Int :| Text
let value: Scalar = 42
if let \`Set0 number = value { number } else { 0 }
`);

  assert_includes(atoms, "i32.const 42");
  assert_includes(scalar, "i32.const 42");
});

Deno.test("Bool type sets reject known I32 values", () => {
  assert_throws(
    () =>
      Source.wat(`
type Scalar = Bool :| Text
let value: Scalar = 1
if value is Bool { 42 } else { 0 }
`),
    "Type-set binding annotation expects Scalar, got 1",
  );
});

Deno.test("I32 type sets reject known Bool values", () => {
  assert_throws(
    () =>
      Source.wat(`
type Scalar = I32 :| Text
let value: Scalar = true
if value is I32 { 42 } else { 0 }
`),
    "Type-set binding annotation expects Scalar, got true",
  );
});

Deno.test("Bool type-set bindings match Bool", async () => {
  const result = await run_i32_source(
    `
type Scalar = Bool :| Text
let value: Scalar = true
if value is Bool { 42 } else { 0 }
`,
    "type_set_bool_is_bool",
  );

  assert_equals(result, 42);
});

Deno.test("I32 type-set bindings match I32", async () => {
  const result = await run_i32_source(
    `
type Scalar = I32 :| Text
let value: Scalar = 1
if value is I32 { 42 } else { 0 }
`,
    "type_set_i32_is_i32",
  );

  assert_equals(result, 42);
});

Deno.test("Bool and I32 aliases retain distinct type-set members", async () => {
  const result = await run_i32_source(
    `
type Truth = Bool
type Count = I32
type Scalar = Truth :| Count
let value: Scalar = 1
if value is Truth { 42 } else { 0 }
`,
    "type_set_scalar_aliases",
  );

  assert_equals(result, 0);
});

Deno.test("singleton and set annotations reject values outside the set", () => {
  assert_throws(
    () => Source.wat("const value: #hello = #goodbye\n0"),
    "annotation expects #hello",
  );
  assert_throws(
    () =>
      Source.wat("type Truth = #true :| #false\nlet value: Truth = #other\n0"),
    "binding annotation expects Truth",
  );
});

Deno.test("is narrows tagged type sets in both branches", () => {
  const then_wat = Source.wat(`
type Scalar = Int :| Text
let value: Scalar = "hello"
if value is Text { @len(value) } else { 0 }
`);
  const else_wat = Source.wat(`
type Scalar = Int :| Text
let value: Scalar = 42
if value is Text { 0 } else { value + 0 }
`);

  assert_includes(then_wat, "i32.load");
  assert_includes(then_wat, "\\05\\00\\00\\00\\68\\65\\6c\\6c\\6f");
  assert_includes(else_wat, "i32.const 42");
});

Deno.test("is is an ordinary boolean expression for singleton atoms", () => {
  const wat = Source.wat(`
const value: #hello = #hello
let matches = value is #hello
if matches { 42 } else { 0 }
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("finite intersections and differences normalize to runtime types", () => {
  const difference = Source.wat(`
type Scalar = Int :| Text
type Number = Scalar :- Text
let value: Number = 42
value
`);
  const intersection = Source.wat(`
type Scalar = Int :| Text
type Number = Scalar :& Int
let value: Number = 42
value
`);

  assert_includes(difference, "i32.const 42");
  assert_includes(intersection, "i32.const 42");
  assert_throws(
    () =>
      Source.wat(`
type Scalar = Int :| Text
type Number = Scalar :- Text
let value: Number = "no"
0
`),
    "annotation expects Int",
  );
});

Deno.test("inline finite type sets lower without a named declaration", () => {
  const union = Source.wat(`
let value: Int :| Text = 42
if value is Int { value } else { 0 }
`);
  const intersection = Source.wat(`
let value: (Int :| Text) :& Int = 42
value
`);
  const difference = Source.wat(`
let value: (Int :| Text) :- Text = 42
value
`);

  assert_includes(union, "i32.const 42");
  assert_includes(intersection, "i32.const 42");
  assert_includes(difference, "i32.const 42");
});

Deno.test("singleton atom aliases retain the unboxed atom representation", () => {
  const wat = Source.wat(`
type Greeting = #hello
let value: Greeting = #hello
if value == #hello { 42 } else { 0 }
`);

  assert_includes(wat, "i32.eq");
  assert_equals(wat.includes("$__alloc"), false);
});

Deno.test("frozen, borrowed, top, and bottom aliases stay compile-time", () => {
  const frozen = Source.wat(`
type FrozenText = #Text
type Alias = FrozenText
let value: Alias = "hello"
@len(value)
`);
  const borrowed = Source.wat(`
type BorrowedText = &Text
let value = "hello"
let view: BorrowedText = &value
@len(view)
`);
  const top = Source.wat("type Any = _\nlet value: Any = 42\nvalue");

  assert_includes(frozen, "\\68\\65\\6c\\6c\\6f");
  assert_includes(borrowed, "i32.const 5");
  assert_includes(top, "i32.const 42");
  assert_throws(
    () => Source.wat("type Empty = Never\nlet value: Empty = 42\nvalue"),
    "annotation Never has no values",
  );
});

Deno.test("atom identities include atoms that appear only in type syntax", () => {
  assert_throws(
    () =>
      Source.wat(`
const value: #azc92ar11ir = #azc92ar11ir
if value is #a09ohszq57r { 42 } else { 0 }
`),
    "Atom identity collision between #azc92ar11ir and #a09ohszq57r",
  );
});

Deno.test("ownership-qualified members reject an unsound runtime envelope", () => {
  assert_throws(
    () => Source.wat("type Mixed = #Text :| Int\n0"),
    "Ownership-qualified runtime type-set members are not supported yet",
  );
});

Deno.test("negative is narrowing carries the remaining multi-case set", () => {
  const wat = Source.wat(`
type Three = Int :| Text :| I64
let value: Three = 9i64
if value is Int {
  0
} else if value is Text {
  @len(value)
} else {
  value + 0i64
}
`);

  assert_includes(wat, "i64.const 9");
  assert_includes(wat, "i64.add");
});

Deno.test("type-set parameters inject plain call arguments", () => {
  const named = Source.wat(`
type Choice = Int :| Text
let unwrap = (value: Choice) => if value is Int { value } else { 0 }
unwrap(42)
`);
  const inline = Source.wat(`
let unwrap = (value: Int :| Text) => if value is Int { value } else { 0 }
unwrap(42)
`);

  assert_includes(named, "i32.const 42");
  assert_includes(inline, "i32.const 42");
  assert_equals(named.includes("$__alloc"), false);
  assert_equals(inline.includes("$__alloc"), false);
});

Deno.test("type-set parameters forward their existing runtime envelope", () => {
  const named = Source.wat(`
type Choice = Int :| Text
let identity = (value: Choice) => value
let forward = (value: Choice) => identity(value)
forward(42)
`);
  const inline = Source.wat(`
let identity = (value: Int :| Text) => value
let forward = (value: Int :| Text) => identity(value)
forward(42)
`);

  assert_includes(named, "i32.const 42");
  assert_includes(inline, "i32.const 42");
});

Deno.test("selected type-set closures share an injected argument layout", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

const { struct } = import "duck:prelude" ()

declare effect Input { flag: () => I32 }
type Init = struct {.input = Input}
type Choice = Int :| Text

flag <- Input.flag()
let operation = if flag {
  (value: Choice) => if value is Int { value } else { 0 }
} else {
  (value: Choice) => if value is Text { @len(value) } else { 0 }
}
let result: I32 = operation(42)
return { .result = result }
`);

  assert_includes(artifact.wat, '"duck_effect" "Input.flag"');
  assert_includes(artifact.wat, "i32.const 42");
});

Deno.test("selected closures accept equivalent type-set aliases", () => {
  const alias = Source.wat(`
type A = Int :| Text
type B = A
let condition: I32 = 1
let operation = if condition { (value: A) => value } else { (value: B) => value }
operation(42)
`);
  const reordered = Source.wat(`
type A = Int :| Text
type B = Text :| Int
let condition: I32 = 1
let operation = if condition { (value: A) => value } else { (value: B) => value }
operation(42)
`);

  assert_includes(alias, "i32.const 42");
  assert_includes(reordered, "i32.const 42");
});

Deno.test("selected closures reject incompatible type-set aliases", () => {
  assert_throws(
    () =>
      Source.wat(`
type A = Int :| Text
type B = Int :| I64
let condition: I32 = 1
let operation = if condition { (value: A) => value } else { (value: B) => value }
operation(42)
`),
    "Core closure if branch type mismatch",
  );
  assert_throws(
    () =>
      Source.wat(`
type A = #left :| Text
type B = #right :| Text
let condition: I32 = 1
let operation = if condition { (value: A) => value } else { (value: B) => value }
operation(#left)
`),
    "binding annotation expects B",
  );
});

Deno.test("finite type sets retain a tagged managed ABI schema", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

const { struct } = import "duck:prelude" ()

type Read = Int :| Text
declare effect Input { read: () => Read }
type Init = struct {.input = Input}

value <- Input.read()
let result: I32 = if value is Int { value } else { @len(value) }
return { .result = result }
`);
  const read = artifact.abi.types.Read;

  assert_equals(read?.tag, "union");

  if (!read || read.tag !== "union") {
    throw new Error("Expected Read ABI union");
  }

  assert_equals(read.cases, [
    { name: "Set0", tag_value: 0, payload: { tag: "i32" } },
    { name: "Set1", tag_value: 1, payload: { tag: "text" } },
  ]);
});

Deno.test("generic type-set specializations retain their managed ABI schema", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

const { struct } = import "duck:prelude" ()

type Maybe a = a :| #nothing
type MaybeInt = Maybe Int
declare effect Input { value: () => MaybeInt }
type Init = struct {.input = Input}

value <- Input.value()
let result: I32 = if value is Int { value } else { 0 }
return { .result = result }
`);

  assert_equals(artifact.abi.effects.Input?.operations.value?.result, {
    type: { tag: "named", name: "MaybeInt" },
    ownership: "unique_heap",
  });
  assert_equals(artifact.abi.types.MaybeInt, {
    tag: "union",
    name: "MaybeInt",
    schema_id: 1,
    size: 8,
    align: 8,
    cases: [
      { name: "Set0", tag_value: 0, payload: { tag: "i32" } },
      { name: "Set1", tag_value: 1, payload: { tag: "i32" } },
    ],
  });
});

Deno.test("generic type sets specialize member facts", () => {
  const present = Source.wat(`
type Maybe a = a :| #nothing
type MaybeInt = Maybe Int
let value: MaybeInt = 42
if value is Int { value } else { 0 }
`);
  const absent = Source.wat(`
type Maybe a = a :| #nothing
type MaybeInt = Maybe Int
let value: MaybeInt = #nothing
if value is #nothing { 42 } else { 0 }
`);

  assert_includes(present, "i32.const 42");
  assert_includes(absent, "i32.const 42");
});

Deno.test("nested generic type sets specialize recursively", () => {
  const wat = Source.wat(`
type Maybe a = a :| #nothing
type Nested a = Maybe a
type NestedInt = Nested Int
let value: NestedInt = 42
if value is Int { value } else { 0 }
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("generic type sets resolve named scalar arguments", () => {
  const wat = Source.wat(`
type Number = Int
type Maybe a = a :| #nothing
type MaybeNumber = Maybe Number
let value: MaybeNumber = 42
if value is Int { value } else { 0 }
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("record intersections merge compatible fields", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type HasX = struct {.x = Int}
type HasY = struct {.y = Int}
type Point = HasX :& HasY
let point: Point = [.x = 40, .y = 2]
point.x + point.y
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});
