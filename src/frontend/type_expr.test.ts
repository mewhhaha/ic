import { assert_equals, assert_throws } from "../assert.ts";
import { format_source } from "./format.ts";
import { resolve_effect_row } from "./effect_row.ts";
import { parse_source } from "./parser.ts";
import { tokenize } from "./tokenize.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";

Deno.test("type expressions compose with whitespace application and arrows", () => {
  const type = parse_type_expr(tokenize(
    "(List a, a -> <Stdin | Stdout | e> List b) -> <e> List b",
  ));

  assert_equals(type, {
    tag: "arrow",
    param: {
      tag: "tuple",
      items: [
        {
          tag: "apply",
          func: { tag: "name", name: "List" },
          arg: { tag: "name", name: "a" },
        },
        {
          tag: "arrow",
          param: { tag: "name", name: "a" },
          effects: {
            tag: "union",
            left: {
              tag: "union",
              left: { tag: "family", name: "Stdin" },
              right: { tag: "family", name: "Stdout" },
            },
            right: { tag: "variable", name: "e" },
          },
          result: {
            tag: "apply",
            func: { tag: "name", name: "List" },
            arg: { tag: "name", name: "b" },
          },
        },
      ],
    },
    effects: { tag: "variable", name: "e" },
    result: {
      tag: "apply",
      func: { tag: "name", name: "List" },
      arg: { tag: "name", name: "b" },
    },
  });
  assert_equals(
    format_type_expr(type),
    "(List a, a -> <Stdin | Stdout | e> List b) -> <e> List b",
  );
});

Deno.test("type expression arrows associate right and keep lambda arrows distinct", () => {
  const type = parse_type_expr(tokenize("a -> b -> c"));
  const no_args = parse_type_expr(tokenize("() -> <Stdin> Text"));

  assert_equals(format_type_expr(type), "a -> b -> c");
  assert_equals(format_type_expr(no_args), "() -> <Stdin> Text");
  assert_equals(parse_source("let id: a -> b = value").statements[0], {
    tag: "bind",
    kind: "let",
    name: "id",
    is_recursive: false,
    is_linear: false,
    annotation: "a -> b",
    type_annotation: {
      tag: "arrow",
      param: { tag: "name", name: "a" },
      effects: undefined,
      result: { tag: "name", name: "b" },
    },
    value: { tag: "var", name: "value" },
  });
});

Deno.test("surface annotations retain simple strings and format rich types canonically", () => {
  const source = parse_source(`
let map: ( List a , a -><e> b ) -><e> List b = value
let count: I32 = 0
`);
  const map = source.statements[0];
  const count = source.statements[1];

  if (!map || map.tag !== "bind") {
    throw new Error("Expected map binding");
  }

  if (!count || count.tag !== "bind") {
    throw new Error("Expected count binding");
  }

  assert_equals(map.annotation, "(List a, a -> <e> b) -> <e> List b");
  assert_equals(map.type_annotation?.tag, "arrow");
  assert_equals(count.type_annotation, undefined);
  assert_equals(
    format_source(source),
    "let map: (List a, a -> <e> b) -> <e> List b = value\n" +
      "let count: I32 = 0",
  );
});

Deno.test("type expression rows reject variables in closed effect resolution", () => {
  assert_throws(
    () => resolve_effect_row({ tag: "variable", name: "e" }, new Map()),
    "Cannot resolve effect row variable in closed context: e",
  );
});

Deno.test("type expressions parse the structured type surface", () => {
  const type = parse_type_expr(tokenize("#hello | #Text & &(List a) \\ Never"));

  assert_equals(type, {
    tag: "union",
    left: { tag: "atom", name: "hello" },
    right: {
      tag: "intersection",
      left: { tag: "frozen", value: { tag: "name", name: "Text" } },
      right: {
        tag: "difference",
        left: {
          tag: "borrow",
          value: {
            tag: "apply",
            func: { tag: "name", name: "List" },
            arg: { tag: "name", name: "a" },
          },
        },
        right: { tag: "never" },
      },
    },
  });
  assert_equals(format_type_expr(type), "#hello | #Text & &(List a) \\ Never");
});

Deno.test("type expression set operators bind tighter from union to difference", () => {
  const type = parse_type_expr(tokenize("A | B & C \\ D"));
  assert_equals(format_type_expr(type), "A | B & C \\ D");
  assert_equals(
    format_type_expr(parse_type_expr(tokenize("(A | B) & (C \\ D)"))),
    "(A | B) & C \\ D",
  );
});

Deno.test("structured type expressions round trip canonical syntax", () => {
  const source = "#(List a) -> <e> &(List a) | _";
  assert_equals(format_type_expr(parse_type_expr(tokenize(source))), source);
  assert_equals(format_type_expr(parse_type_expr(tokenize("#(a)"))), "#(a)");
});

Deno.test("structured type expressions reject malformed names", () => {
  assert_throws(
    () => parse_type_expr(tokenize("#Not-Snake")),
    "Unexpected token in type annotation",
  );
  assert_throws(
    () => parse_type_expr(tokenize("#123")),
    "Expected type after `#`",
  );
});
