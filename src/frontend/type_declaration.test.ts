import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { Source } from "../frontend.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import type { FrontExpr } from "./ast.ts";
import { capture_deferred_expr } from "./capture.ts";
import { create_env } from "./env.ts";
import { format_expr } from "./format.ts";
import { substitute_front_expr } from "./substitute.ts";

Deno.test("type declarations parse and format product and sum rows", () => {
  const source = Source.parse(`
type Vec2 = struct {.x = Int, .y = Int}
type Maybe a = | \`Just a | \`Nothing Unit
type MaybeInt = Maybe Int
0
`);

  const vec2 = source.declarations?.[0];
  assert_equals(vec2?.tag, "type");

  if (vec2?.tag !== "type" || vec2.body.tag !== "product") {
    throw new Error("Expected Vec2 struct declaration");
  }

  assert_equals(vec2.body.fields, [
    { name: "x", type_name: "Int" },
    { name: "y", type_name: "Int" },
  ]);
  assert_equals(vec2.body.positional, false);
  assert_equals(vec2.body.initializer?.tag, "app");
  assert_equals(source.declarations?.slice(1), [
    {
      tag: "type",
      name: "Maybe",
      params: ["a"],
      body: {
        tag: "sum",
        cases: [
          { name: "Just", type_name: "a" },
          { name: "Nothing", type_name: "Unit" },
        ],
      },
      recursive: false,
    },
    {
      tag: "type",
      name: "MaybeInt",
      params: [],
      body: { tag: "alias", type_name: "Maybe Int" },
      recursive: false,
    },
  ]);
  assert_equals(
    Source.fmt(source),
    "type Vec2 = struct { .x = Int, .y = Int }\n" +
      "type Maybe a =\n  | `Just a\n  | `Nothing Unit\n" +
      "type MaybeInt = Maybe Int\n" +
      "0",
  );
});

Deno.test("type rows lower through existing struct and union layouts", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Vec3 = struct {.x = Int, .y = Int, .z = Int}
type Pair = [Int, Int]
type Maybe a = | \`Just a | \`Nothing Unit
type MaybeInt = Maybe Int

let point: Vec3 = [.x = 40, .y = 1, .z = 1]
let pair: Pair = [point.x, point.y]
let by_name: Int = point.x + point.y + point.z
let by_index: Int = point[0] + point[1] + point[2]
let result: MaybeInt = \`Just (if by_name == by_index {
  pair[0] + pair[1] + point[2]
} else {
  0
})

if let \`Just value = result {
  value
} else {
  0
}
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.add");
});

Deno.test("declared product types construct values with their declared name", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Point = struct {.x = I32, .y = I32}
let point: Point = [40, 2]
point.x + point.y
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("declared product fields preserve applied generic unions through scratch", async () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Metadata = struct {.branch = FieldPatch Text}
type MetadataAlias = Metadata

let metadata: MetadataAlias = scratch { [\`Set "main"] }
if let \`Set branch = metadata.branch { @len(branch) } else { 0 }
`);
  const instance = await instantiate_wat(
    wat,
    "applied_generic_product_field",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Applied generic product field test omitted main");
  }

  assert_equals(main(), 4);
});

Deno.test("declared product fields materialize applied generic unions with dynamic payloads", async () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Metadata = struct {.branch = FieldPatch Text}

let branch_length = (branch: Text) => {
  let metadata: Metadata = [\`Set branch]
  if let \`Set value = metadata.branch { @len(value) } else { 0 }
}

branch_length("main")
`);
  const instance = await instantiate_wat(
    wat,
    "dynamic_applied_generic_product_field",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Dynamic applied generic product field test omitted main");
  }

  assert_equals(main(), 4);
});

Deno.test("annotated functions preserve aggregate results assembled from locals", async () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type ParserState = struct {.pending = Text, .active = Bool}
type ParserStep = [ParserState, Text]

let push: [ParserState, Text] -> ParserStep =
  (parser: ParserState, chunk: Text) => {
    let active = parser.active
    let pending = @append(parser.pending, chunk)
    let next: ParserState = [.pending = pending, .active = active]
    let visible: Text = ""
    [next, visible]
  }

let initial: ParserState = [.pending = "hel", .active = false]
let [next, visible] = push(initial, "lo")
@len(next.pending) * 10 + @len(visible)
`);
  const instance = await instantiate_wat(
    wat,
    "aggregate_function_result",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Aggregate function result test omitted main");
  }

  assert_equals(main(), 50);
});

Deno.test("named product fields alias declaration-order indexes", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Vec3 = struct {.x = Int, .y = Int, .z = Int}
let point: Vec3 = [.x = 40, .y = 1, .z = 1]
let by_name: Int = point.x + point.y + point.z
let by_index: Int = point[0] + point[1] + point[2]
if by_name == by_index { by_index } else { 0 }
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 1");

  const artifact = Source.artifact(`
module (!init: Init) where

const { struct } = import "duck:prelude" ()

type Vec3 = struct {.x = Int, .y = Int, .z = Int}

declare effect Input {
  index: () => I32
}

type Init = struct {.input = Input}

let point: Vec3 = [.x = 40, .y = 1, .z = 1]
index <- Input.index()
let result: I32 = point[index]
return { .result = result }
`);

  assert_includes(
    artifact.wat,
    "local.get $index\n    i32.const 0\n    i32.eq",
  );
  assert_includes(
    artifact.wat,
    "local.get $index\n        i32.const 2\n        i32.eq",
  );
});

Deno.test("type row sums retain the managed ABI tagged-union layout", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

const { struct } = import "duck:prelude" ()

type ReadResult = | \`Ok Int | \`Err Unit

declare effect Input {
  read: () => ReadResult
}

type Init = struct {.input = Input}

result <- Input.read()
let code: I32 = if let \`Ok value = result { value } else { 0 }
return { .code = code }
`);
  const type = artifact.abi.types.ReadResult;

  assert_equals(type?.tag, "union");

  if (!type || type.tag !== "union") {
    throw new Error("Expected ReadResult ABI union");
  }

  assert_equals(type.cases, [
    { name: "Ok", tag_value: 0, payload: { tag: "i32" } },
    { name: "Err", tag_value: 1, payload: { tag: "unit" } },
  ]);
});

Deno.test("recursive type rows require an indirect sum edge", () => {
  assert_throws(
    () => Source.wat("type Loop = struct {.next = Loop}\n0"),
    "Recursive type requires an indirect sum edge: Loop -> Loop",
  );
  assert_throws(
    () => Source.wat("type A = B\ntype B = A\n0"),
    "Recursive type requires an indirect sum edge: A -> B -> A",
  );
});

Deno.test("indirect recursive type rows specialize generic payloads", () => {
  const wat = Source.wat(`
type List value = | \`Nil Unit | \`Cons ListNode value
type ListNode value = [value, List value]
type IntList = List I32
let empty: IntList = \`Nil ()
let values: IntList = \`Cons [42, empty]
if let \`Cons node = values {
  let [head, _] = node
  head
} else {
  0
}
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("literal product indexes retain the selected recursive field type", () => {
  const wat = Source.wat(`
type Option = | \`None Unit | \`Some I32
type Pair = [I32, Option]
let none: Option = \`None ()
let pair: Pair = [42, none]
pair[0]
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("named bracket types are rejected in favor of struct", () => {
  assert_throws(
    () => Source.parse("type Bad = [.x = Int]"),
    "Named product types use `struct { .field = Type }`",
  );
  assert_throws(
    () =>
      Source.wat(
        'const { struct } = import "duck:prelude" ()\n' +
          "type Bad = struct { .new = Int }\n0",
      ),
    "Duplicate type namespace member: new",
  );
  assert_throws(
    () =>
      Source.wat(
        'const { struct } = import "duck:prelude" ()\n' +
          "type Bad = struct { .shape = Int }\n0",
      ),
    "Duplicate type namespace member: shape",
  );
});

Deno.test("type rows reject unsupported nested members", () => {
  assert_throws(
    () => Source.parse("type Bad = struct {.x = Int | `None ()}"),
    "Unexpected token in type annotation",
  );
  assert_throws(
    () =>
      Source.wat(
        "type Bad = | `Pair [Int, Int] | `None Unit\n0",
      ),
    "Anonymous product row members are not supported yet: [Int, Int]",
  );
  assert_throws(
    () => Source.parse("type Bad = [Int,]"),
    "Type products do not allow a trailing comma",
  );
});

Deno.test("type declarations share one namespace", () => {
  assert_throws(
    () => Source.parse("type Unit = struct {.value = Int}"),
    "Type declaration conflicts with builtin type: Unit",
  );
  assert_throws(
    () =>
      Source.parse(
        "declare Foo { value: Int }\ntype Foo = struct {.value = Int}",
      ),
    "Duplicate declaration name: Foo",
  );
  assert_throws(
    () =>
      Source.parse(
        "type Foo = struct {.value = Int}\ndeclare Foo { value: Int }",
      ),
    "Duplicate declaration name: Foo",
  );
});

Deno.test("type aliases are dependency ordered before lowering", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Alias = Value
type Value = struct {.number = Int}
let value: Alias = [.number = 42]
value.number
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("prelude structs attach a named shape constructor", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Point = struct { .x = I32, .y = I32 }
let point = Point.new { .y = 2, .x = 40 }
point.x + point.y
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("prelude struct constructors reorder runtime fields", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Point = struct { .x = I32, .y = I32 }
let make_point = x => Point.new { .y = 2, .x = x }
let point = make_point(40)
point.x + point.y
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("prelude struct constructors retain runtime-owned fields", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type Piece = struct { .bytes = Bytes, .start = I32 }
let piece = Piece.new { .start = 1, .bytes = @Utf8.encode("abc") }
@len(piece.bytes) + piece.start
`);

  assert_includes(Core.fmt(core), "struct { bytes: Bytes, start: I32 }");
  assert_includes(Core.fmt(core), "{ bytes: @Utf8.encode");
});

Deno.test("struct declarations retain their const layout shape", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
const point_type = struct { .x = I32, .y = I64 }
const point_shape = point_type.shape
const x_type = point_shape.x
let value: x_type = 42
value
`);

  assert_includes(wat, "i32.const 42");

  const generic_wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Box value = struct { .value = value }
const field_type = (const target) => target.shape.value
const value_type = comptime field_type(Box I64)
let value: value_type = 42i64
value
`);

  assert_includes(generic_wat, "i64.const 42");

  assert_throws(
    () =>
      Source.wat(`
const { struct } = import "duck:prelude" ()
const bad_type = struct { .shape = I32 }
0
`),
    "Duplicate type namespace member: shape",
  );
});

Deno.test("prelude struct constructors are first-class const functions", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Point = struct { .x = I32, .y = I32 }
const make_point = Point.new
let point = make_point { .y = 2, .x = 40 }
point.x + point.y
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");

  assert_throws(
    () =>
      Source.wat(`
const { struct } = import "duck:prelude" ()
type Point = struct { .x = I32, .y = I32 }
const make_point = Point.new
let point = make_point { .x = "wrong", .y = 20 }
point.x
`),
    "product entry 0 has source layout text and target layout i32",
  );
});

Deno.test("prelude struct constructors require the declared shape", () => {
  const prefix = `
const { struct } = import "duck:prelude" ()
type Point = struct { .x = I32, .y = I32 }
`;

  assert_throws(
    () => Source.wat(prefix + "let point = Point.new { .x = 1 }\npoint.x"),
    "product arity differs, source has 3 entries and target has 2",
  );
  assert_throws(
    () =>
      Source.wat(
        prefix + "let point = Point.new { .x = 1, .y = 2, .z = 3 }\npoint.x",
      ),
    "product arity differs, source has 4 entries and target has 2",
  );
  assert_throws(
    () => Source.wat(prefix + "let point = Point.new [1, 2]\npoint.x"),
    "Compile-time product spread requires a fixed product value, got if",
  );
  assert_throws(
    () =>
      Source.wat(
        prefix +
          "const make_point = Point.new\n" +
          "let point = make_point { .x = 1 }\npoint.x",
      ),
    "product arity differs, source has 3 entries and target has 2",
  );
});

Deno.test("generic prelude structs attach constructors after specialization", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Box value = struct { .value = value }
const make_box = (Box I32).new
let box = make_box { .value = 42 }
box.value
`);

  assert_includes(wat, "i32.const 42");

  assert_throws(
    () =>
      Source.wat(`
const { struct } = import "duck:prelude" ()
type Box value = struct { .value = value }
const make_box = (Box I32).new
let box = make_box { .value = "wrong" }
box.value
`),
    "product entry 0 has source layout text and target layout i32",
  );
});

Deno.test("aggregate formatting survives frontend transforms", () => {
  const examples = ["[.value = 1]", "[1, 2]", "[]"];

  for (const example of examples) {
    const parsed = Source.parse("let value = " + example);
    const stmt = parsed.statements[0];

    if (!stmt || stmt.tag !== "bind") {
      throw new Error("Expected bracket product binding");
    }

    const replacements = new Map<string, FrontExpr>();
    assert_equals(
      format_expr(substitute_front_expr(stmt.value, replacements)),
      example,
    );
    assert_equals(
      format_expr(capture_deferred_expr(stmt.value, create_env())),
      example,
    );
  }
});
