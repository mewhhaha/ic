import { assert_equals, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { fixed_array_length } from "./fixed_array_type.ts";

Deno.test("fixed array lengths evaluate compile-time natural expressions", () => {
  assert_equals(fixed_array_length({ tag: "number", value: 3 }), 3);
  assert_equals(
    fixed_array_length(
      {
        tag: "binary",
        op: "*",
        left: { tag: "name", name: "width" },
        right: {
          tag: "binary",
          op: "+",
          left: { tag: "number", value: 1 },
          right: { tag: "number", value: 1 },
        },
      },
      (name) => {
        if (name === "width") {
          return 2;
        }

        return undefined;
      },
    ),
    4,
  );

  assert_throws(
    () => fixed_array_length({ tag: "name", name: "width" }),
    "Fixed array length requires a compile-time natural: width",
  );
  assert_throws(
    () =>
      fixed_array_length({
        tag: "binary",
        op: "-",
        left: { tag: "number", value: 1 },
        right: { tag: "number", value: 2 },
      }),
    "Fixed array length must be a non-negative safe integer, got -1",
  );
  assert_throws(
    () =>
      fixed_array_length({
        tag: "binary",
        op: "/",
        left: { tag: "number", value: 2 },
        right: { tag: "number", value: 0 },
      }),
    "Fixed array length divides by zero",
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

Deno.test("semantic validation resolves const fixed array lengths", () => {
  const analysis = Source.analyze(`
const width = 1 + 1
let values: [Int; width * 2] = [1, 2, 3, 4]
values
`);

  assert_equals(analysis.diagnostics, []);
});

Deno.test("fixed array lowering receives resolved const lengths", () => {
  const wat = Source.wat(`
const width = 1 + 1
let values: [Int; width + 1] = [20, 1, 21]
values[0] + values[2]
`);

  if (!wat.includes("i32.const 20") || !wat.includes("i32.const 21")) {
    throw new Error("Expected resolved fixed array values in WAT");
  }
});

Deno.test("semantic validation rejects runtime fixed array lengths", () => {
  const analysis = Source.analyze(`
let width = 2
let values: [Int; width] = [1, 2]
`);

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Fixed array length requires a compile-time natural: width"],
  );
});

Deno.test("repeated value packs resolve const lengths at function boundaries", async () => {
  const source = `
const width = 1 + 2
let sum: (I32; width) -> I32 = (a, b, c) => a + b + c
sum(10, 20, 12)
`;

  assert_equals(Source.analyze(source).diagnostics, []);

  const instance = await instantiate_wat(
    Source.wat(source),
    "repeated_value_pack",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing repeated value-pack main export");
  }

  assert_equals(main(), 42);
});

Deno.test("repeated value packs reject runtime lengths", () => {
  const analysis = Source.analyze(`
let width = 2
let sum: (I32; width) -> I32 = (a, b) => a + b
sum(20, 22)
`);

  assert_equals(
    analysis.diagnostics.map((diagnostic) => diagnostic.message),
    ["Value-pack length requires a compile-time natural: width"],
  );
});

Deno.test("repeated value packs cover empty, unary, and returned packs", () => {
  const analysis = Source.analyze(`
let answer: (I32; 0) -> I32 = () => 42
let identity: (I32; 1) -> I32 = value => value
let swap: (I32; 2) -> (I32; 2) = (left, right) => (right, left)
let (first, second) = swap(identity(20), answer())
first + second
`);

  assert_equals(analysis.diagnostics, []);
});
