import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { Ic } from "../ic.ts";
import {
  elaborate_array_repeat_expr,
  elaborate_fixed_array_expr,
  elaborate_product_as_expr,
  elaborate_product_expr,
} from "./aggregate.ts";
import type { FrontExpr } from "./ast.ts";
import { substitute_front_expr } from "./substitute.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";

Deno.test("products elaborate to ordered object fields", () => {
  assert_equals(
    elaborate_product_expr({
      tag: "product",
      entries: [
        { value: { tag: "num", type: "i32", value: 1 } },
        {
          label: "right",
          value: { tag: "num", type: "i32", value: 2 },
        },
      ],
    }),
    {
      tag: "struct_value",
      type_expr: { tag: "var", name: "object_type" },
      fields: [
        { name: "item_0", value: { tag: "num", type: "i32", value: 1 } },
        {
          name: "right",
          value: { tag: "num", type: "i32", value: 2 },
        },
      ],
      bracketed: "positional",
    },
  );
});

Deno.test("fixed arrays elaborate to positional object fields", () => {
  assert_equals(
    elaborate_fixed_array_expr({
      tag: "array",
      items: [
        { tag: "num", type: "i32", value: 1 },
        { tag: "num", type: "i32", value: 2 },
      ],
      rest: undefined,
    }).fields.map((field) => field.name),
    ["item_0", "item_1"],
  );
});

Deno.test("named products retain named update behavior", () => {
  const wat = Source.wat(`
type Pair = (.left = I32, .right = I32)
let pair: Pair = (.left = 1, .right = 2)
let changed = pair with { left: 3 }
changed.left
`);
  assert_includes(wat, "i32.const 3");
});

Deno.test("array spreads fail at fixed aggregate elaboration", () => {
  assert_throws(
    () =>
      elaborate_fixed_array_expr({
        tag: "array",
        items: [],
        rest: { tag: "var", name: "tail" },
      }),
    "Cannot lower array spread to the fixed aggregate representation",
  );
});

Deno.test("product casts relabel only when ordered layouts agree", () => {
  assert_equals(
    elaborate_product_as_expr({
      tag: "as",
      value: {
        tag: "product",
        entries: [
          { value: { tag: "num", type: "i32", value: 1 } },
          { value: { tag: "num", type: "i64", value: 2n } },
        ],
      },
      type_expr: {
        tag: "product",
        entries: [
          { label: "left", type_expr: { tag: "name", name: "I32" } },
          { label: "right", type_expr: { tag: "name", name: "I64" } },
        ],
      },
    }),
    {
      tag: "product",
      entries: [
        {
          label: "left",
          value: { tag: "num", type: "i32", value: 1 },
        },
        {
          label: "right",
          value: { tag: "num", type: "i64", value: 2n },
        },
      ],
    },
  );
  assert_throws(
    () =>
      Source.compile(
        "(1, 2i64) as (.left = I32, .right = I32)",
      ),
    "product entry 1 has source layout i64 and target layout i32",
  );
});

Deno.test("array repeats bind one duplicable value before expansion", () => {
  assert_equals(
    elaborate_array_repeat_expr({
      tag: "array_repeat",
      value: {
        tag: "prim",
        prim: "i32.add",
        left: { tag: "num", type: "i32", value: 1 },
        right: { tag: "num", type: "i32", value: 2 },
      },
      length: { tag: "num", type: "i32", value: 3 },
    }, "repeated"),
    {
      tag: "app",
      func: {
        tag: "lam",
        params: [{
          name: "repeated",
          is_const: false,
          is_linear: false,
          annotation: undefined,
        }],
        body: {
          tag: "array",
          items: [
            { tag: "var", name: "repeated" },
            { tag: "var", name: "repeated" },
            { tag: "var", name: "repeated" },
          ],
          rest: undefined,
        },
      },
      args: [{
        tag: "prim",
        prim: "i32.add",
        left: { tag: "num", type: "i32", value: 1 },
        right: { tag: "num", type: "i32", value: 2 },
      }],
    },
  );
  assert_throws(
    () => Source.compile("[consume(); 2]"),
    "Array repeat value cannot be duplicated safely: app",
  );
});

Deno.test("match elaboration evaluates the target once and honors guards", () => {
  const source = elaborate_front_type_sets(
    Source.parse("match next() { | 1 if false => 10 | _ => 20 }"),
  );
  const statement = source.statements[0];

  if (statement?.tag !== "expr" || statement.expr.tag !== "block") {
    throw new Error("Expected elaborated match block");
  }

  const target_binding = statement.expr.statements[0];
  assert_equals(target_binding?.tag, "bind");
  if (target_binding?.tag !== "bind") {
    throw new Error("Expected match target binding");
  }
  assert_equals(target_binding.value.tag, "app");
  assert_equals(
    Ic.reduce(Source.compile("match 1 { | 1 if false => 10 | _ => 20 }")),
    { tag: "num", type: "i32", value: 20 },
  );
});

Deno.test("match coverage rejects duplicate and missing arms", () => {
  assert_throws(
    () => Source.compile("match 1 { | 1 => 10 | 1 => 20 | _ => 30 }"),
    "Unreachable duplicate match literal at arm 1",
  );
  assert_throws(
    () => Source.compile("match 1 { | 1 => 10 }"),
    "Non-exhaustive match requires a wildcard or binding arm",
  );
  assert_throws(
    () =>
      Source.core(`
type Result = .ok = I32 | .err
let result: Result = Result.ok(7)
match result { | .ok value => value }
`),
    "Non-exhaustive match, missing .err",
  );
});

Deno.test("shorthand union application becomes a payload constructor", () => {
  const core = Source.core(".some 7");
  const statement = core.statements[0];

  if (statement?.tag !== "expr") {
    throw new Error("Expected shorthand union expression");
  }

  assert_equals(statement.expr, {
    tag: "union_case",
    name: "some",
    value: { tag: "num", type: "i32", value: 7 },
    type_expr: undefined,
  });
});

Deno.test("substitution respects bindings in match guards and bodies", () => {
  const expr: FrontExpr = {
    tag: "match",
    target: { tag: "var", name: "source" },
    arms: [{
      pattern: {
        tag: "product",
        entries: [{
          pattern: {
            tag: "binding",
            name: "source",
            mode: "default",
            annotation: undefined,
          },
        }],
      },
      guard: { tag: "var", name: "source" },
      body: { tag: "var", name: "free" },
    }],
  };

  assert_equals(
    substitute_front_expr(
      expr,
      new Map([
        ["source", { tag: "num", type: "i32", value: 1 }],
        ["free", { tag: "num", type: "i32", value: 2 }],
      ]),
    ),
    {
      ...expr,
      target: { tag: "num", type: "i32", value: 1 },
      arms: [{
        ...expr.arms[0],
        guard: { tag: "var", name: "source" },
        body: { tag: "num", type: "i32", value: 2 },
      }],
    },
  );
});

Deno.test("product binding patterns project every ordered entry", () => {
  const wat = Source.wat(`
let (left, right) = (20, 22)
left + right
`);
  assert_includes(wat, "i32.add");
});

Deno.test("array binding rests retain the unconsumed suffix", () => {
  const wat = Source.wat(`
let values = [10, 20, 30]
let [head, ...tail] = values
head + tail[1]
`);
  assert_includes(wat, "i32.const 30");
});

Deno.test("record binding patterns support selected fields and rests", () => {
  const wat = Source.wat(`
type Pair = (.left = I32, .right = I32)
let pair: Pair = (.left = 20, .right = 22)
let { left, ...rest } = pair
left + rest.right
`);
  assert_includes(wat, "i32.add");
});

Deno.test("module export records bind through recursive patterns", () => {
  const wat = Source.wat(`
const exports = () => { return { add: 40, ignored: 2 } }
const { add } = exports()
add
`);
  assert_includes(wat, "i32.const 40");
});

Deno.test("module initializer results remain available as one binding", () => {
  const wat = Source.wat(`
const exports = () => { return { run: 42 } }
let application = exports()
application.run
`);
  assert_includes(wat, "i32.const 42");
});

Deno.test("product function patterns keep a unary source call", () => {
  const wat = Source.wat(`
let sum = (left, right) => left + right
sum(20, 22)
`);
  assert_includes(wat, "i32.add");
});

Deno.test("structural if-let patterns project fixed aggregate values", () => {
  const wat = Source.wat(`
if let [head, ...tail] = [1, 2, 3] {
  head + tail[1]
}
`);
  assert_includes(wat, "i32.add");
});

Deno.test("plain bindings reject refutable patterns", () => {
  assert_throws(
    () => Source.compile("let 1 = 1\n0"),
    "Refutable literal pattern is not allowed in a plain binding",
  );
});
