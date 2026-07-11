import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import type { FrontExpr } from "./ast.ts";
import { capture_deferred_expr } from "./capture.ts";
import { create_env } from "./env.ts";
import { format_expr } from "./format.ts";
import { substitute_front_expr } from "./substitute.ts";

Deno.test("type declarations parse and format product and sum rows", () => {
  const source = Source.parse(`
type Vec2 = [.x = Int, .y = Int]
type Maybe a = .just = a | .nothing
type MaybeInt = Maybe Int
0
`);

  assert_equals(source.declarations, [
    {
      tag: "type",
      name: "Vec2",
      params: [],
      body: {
        tag: "product",
        fields: [
          { name: "x", type_name: "Int" },
          { name: "y", type_name: "Int" },
        ],
        positional: false,
      },
      recursive: false,
    },
    {
      tag: "type",
      name: "Maybe",
      params: ["a"],
      body: {
        tag: "sum",
        cases: [
          { name: "just", type_name: "a" },
          { name: "nothing", type_name: "Unit" },
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
    "type Vec2 = [.x = Int, .y = Int]\n" +
      "type Maybe a =\n" +
      "  | .just = a\n" +
      "  | .nothing\n" +
      "type MaybeInt = Maybe Int\n" +
      "0",
  );
});

Deno.test("type rows lower through existing struct and union layouts", () => {
  const wat = Source.wat(`
type Vec3 = [.x = Int, .y = Int, .z = Int]
type Pair = [Int, Int]
type Maybe a =
  | .just = a
  | .nothing
type MaybeInt = Maybe Int

let point: Vec3 = [.x = 40, .y = 1, .z = 1]
let pair: Pair = [point.x, point.y]
let by_name: Int = point.x + point.y + point.z
let by_index: Int = point[0] + point[1] + point[2]
let result: MaybeInt = .just(if by_name == by_index {
  pair[0] + pair[1] + point[2]
} else {
  0
})

if let .just(value) = result {
  value
} else {
  0
}
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.add");
});

Deno.test("named product fields alias declaration-order indexes", () => {
  const wat = Source.wat(`
type Vec3 = [.x = Int, .y = Int, .z = Int]
let point: Vec3 = [.x = 40, .y = 1, .z = 1]
let by_name: Int = point.x + point.y + point.z
let by_index: Int = point[0] + point[1] + point[2]
if by_name == by_index { by_index } else { 0 }
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 1");

  const artifact = Source.artifact(`
module (!init: Init) where

type Vec3 = [.x = Int, .y = Int, .z = Int]

declare effect Input {
  index: () => I32
}

type Init = [.input = Input]

let point: Vec3 = [.x = 40, .y = 1, .z = 1]
index <- Input.index()
let result: I32 = point[index]
return { result }
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

type ReadResult = .ok = Int | .err

declare effect Input {
  read: () => ReadResult
}

type Init = [.input = Input]

result <- Input.read()
let code: I32 = if let .ok(value) = result { value } else { 0 }
return { code }
`);
  const type = artifact.abi.types.ReadResult;

  assert_equals(type?.tag, "union");

  if (!type || type.tag !== "union") {
    throw new Error("Expected ReadResult ABI union");
  }

  assert_equals(type.cases, [
    { name: "ok", tag_value: 0, payload: { tag: "i32" } },
    { name: "err", tag_value: 1, payload: { tag: "unit" } },
  ]);
});

Deno.test("recursive type rows fail before Core lowering", () => {
  assert_throws(
    () =>
      Source.wat(`
type List a =
  | .nil
  | .cons = [a, List a]
0
`),
    "Recursive algebraic type declarations are not supported yet: List",
  );
  assert_throws(
    () => Source.wat("type A = B\ntype B = A\n0"),
    "Recursive algebraic type declarations are not supported yet: A -> B -> A",
  );
});

Deno.test("type rows reject mixed products and unsupported nested members", () => {
  assert_throws(
    () => Source.parse("type Bad = [.x = Int | .none]"),
    "Cannot mix product `,` and sum `|` entries",
  );
  assert_throws(
    () => Source.wat("type Bad = .pair = [Int, Int] | .none\n0"),
    "Nested and applied row member types are not supported yet: [Int, Int]",
  );
  assert_throws(
    () => Source.parse("let value = [.x = 1, 2]"),
    "Cannot mix named and positional product entries",
  );
  assert_throws(
    () => Source.parse("type Bad = [Int,]"),
    "Type products do not allow a trailing comma",
  );
});

Deno.test("type declarations share one namespace", () => {
  assert_throws(
    () => Source.parse("type Unit = [.value = Int]"),
    "Type declaration conflicts with builtin type: Unit",
  );
  assert_throws(
    () => Source.parse("declare Foo { value: Int }\ntype Foo = [.value = Int]"),
    "Duplicate declaration name: Foo",
  );
  assert_throws(
    () => Source.parse("type Foo = [.value = Int]\ndeclare Foo { value: Int }"),
    "Duplicate declaration name: Foo",
  );
});

Deno.test("type aliases are dependency ordered before lowering", () => {
  const wat = Source.wat(`
type Alias = Value
type Value = [.number = Int]
let value: Alias = [.number = 42]
value.number
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("bracket product formatting survives frontend transforms", () => {
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
