import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { Ic } from "../ic.ts";

Deno.test("Bool literals parse as Bool and preserve their spelling", () => {
  const parsed = Source.parse("true\nfalse");

  assert_equals(parsed, {
    tag: "program",
    statements: [
      { tag: "expr", expr: { tag: "bool", value: true } },
      { tag: "expr", expr: { tag: "bool", value: false } },
    ],
  });
  assert_equals(Source.fmt(parsed), "true\nfalse");
});

Deno.test("Bool annotations lower to the i32 runtime representation", () => {
  const source = "let ready: Bool = true\nready";

  assert_equals(Source.analyze(source).diagnostics, []);
  assert_equals(Ic.reduce(Source.compile(source)), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const wat = Source.wat(source);
  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 1");
});

Deno.test("Bool and I32 annotations reject values of the other type", () => {
  const bool_as_i32 = Source.analyze("let value: I32 = true\nvalue");
  const i32_as_bool = Source.analyze("let value: Bool = 1\nvalue");

  assert_equals(
    bool_as_i32.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2306", message: "Binding annotation expects I32, got Bool" }],
  );
  assert_equals(
    i32_as_bool.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2306", message: "Binding annotation expects Bool, got I32" }],
  );
});

Deno.test("explicit checked casts convert i32-family numbers to Bool", () => {
  const truthy = "if @cast(2, Bool) { 1 } else { 0 }";
  const falsy = "if @cast(0, Bool) { 1 } else { 0 }";

  assert_equals(Source.analyze(truthy).diagnostics, []);
  assert_equals(Source.analyze(falsy).diagnostics, []);
  assert_equals(Ic.reduce(Source.compile(truthy)), {
    tag: "num",
    type: "i32",
    value: 1,
  });
  assert_equals(Ic.reduce(Source.compile(falsy)), {
    tag: "num",
    type: "i32",
    value: 0,
  });
});

Deno.test("the removed @as intrinsic does not compile", () => {
  assert_throws(
    () => Source.wat("@as(1, I32)"),
    "Unbound core value: @as",
  );
});

Deno.test("Bool values cannot enter arithmetic or mixed equality", () => {
  const arithmetic = Source.analyze("true + 1");
  const mixed_equality = Source.analyze("true == 1");

  assert_equals(
    arithmetic.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2302",
      message: "Primitive i32.add expects numeric operands, got Bool",
    }],
  );
  assert_equals(
    mixed_equality.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2302", message: "Boolean equality requires Bool operands" }],
  );
});

Deno.test("comparisons, logical operators, and is expressions infer Bool", () => {
  const bool_annotations = `
let comparison: Bool = 1 < 2
let logical: Bool = true && false
let checked: Bool = 1 is Int
checked
`;

  assert_equals(Source.analyze(bool_annotations).diagnostics, []);
  assert_equals(Ic.reduce(Source.compile(bool_annotations)), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const i32_annotations = Source.analyze(`
let comparison: I32 = 1 < 2
let logical: I32 = true && false
let checked: I32 = 1 is Int
0
`);
  assert_equals(
    i32_annotations.diagnostics.map(({ code, message }) => ({ code, message })),
    [
      { code: "DUCK2306", message: "Binding annotation expects I32, got Bool" },
      { code: "DUCK2306", message: "Binding annotation expects I32, got Bool" },
      { code: "DUCK2306", message: "Binding annotation expects I32, got Bool" },
    ],
  );
});

Deno.test("conditions require Bool", () => {
  const bool_condition = "if true { 42 } else { 0 }";
  const i32_condition = "if 2 { 42 } else { 0 }";

  assert_equals(Source.analyze(bool_condition).diagnostics, []);
  assert_equals(Ic.reduce(Source.compile(bool_condition)), {
    tag: "num",
    type: "i32",
    value: 42,
  });
  assert_equals(
    Source.analyze(i32_condition).diagnostics.map(({ code, message }) => ({
      code,
      message,
    })),
    [{ code: "DUCK2303", message: "If condition expects Bool, got I32" }],
  );
});

Deno.test("dynamic Bool struct indexes retain Bool semantics over i32", () => {
  const dynamic_read = `
let pair = [.first = true, .second = false]
pair[input]
`;
  const dynamic_update = `
let pair = [.first = true, .second = false]
pair[input] = true
pair[input]
`;

  assert_equals(Source.analyze(dynamic_read).diagnostics, []);
  assert_includes(
    Ic.fmt(Ic.reduce(Source.compile(dynamic_read))),
    "then 1:i32",
  );
  assert_includes(
    Ic.fmt(Ic.reduce(Source.compile(dynamic_update))),
    "then 1:i32",
  );
});

Deno.test("dynamic Bool struct indexes reject numeric use and mixed fields", () => {
  const static_bool = `
let pair = [.first = true, .second = 2]
pair[0]
`;
  const arithmetic = `
let pair = [.first = true, .second = false]
pair[input] + 1
`;
  const numeric_update = `
let pair = [.first = true, .second = false]
pair[input] = 1
pair[input]
`;
  const mixed_read = `
let pair = [.first = true, .second = 2]
pair[input]
`;
  const mixed_update = `
let pair = [.first = true, .second = 2]
pair[input] = true
pair[input]
`;

  assert_equals(Ic.reduce(Source.compile(static_bool)), {
    tag: "num",
    type: "i32",
    value: 1,
  });
  assert_throws(
    () => Source.compile(arithmetic),
    "Primitive i32.add expects numeric operands, got Bool",
  );
  assert_throws(
    () => Source.compile(numeric_update),
    "Bool index update requires Bool value",
  );
  assert_throws(
    () => Source.compile(mixed_read),
    "Mixed Bool and numeric indexed values",
  );
  assert_throws(
    () => Source.compile(mixed_update),
    "Mixed Bool and numeric indexed values",
  );
});
