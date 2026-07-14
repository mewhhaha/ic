import { assert_equals, assert_throws } from "../assert.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import { format_source } from "./format.ts";
import { parse_source } from "./parser.ts";

function binding_value(statement: Stmt | undefined): FrontExpr {
  if (!statement || statement.tag !== "bind") {
    throw new Error("Expected binding statement");
  }

  return statement.value;
}

Deno.test("source calls are unary, left associative, and tighter than infix", () => {
  const source = parse_source(`
let chained = f x y + g(z)
let packed = f(a, b)
let next = f
let separate = x
`);
  const chained = binding_value(source.statements[0]);
  const packed = binding_value(source.statements[1]);

  if (chained.tag !== "prim") {
    throw new Error("Expected infix expression");
  }

  if (chained.left.tag !== "app" || chained.left.func.tag !== "app") {
    throw new Error("Expected left-associated applications");
  }

  assert_equals(chained.left.func.arg, { tag: "var", name: "x" });
  assert_equals(chained.left.arg, { tag: "var", name: "y" });

  if (packed.tag !== "app" || packed.arg?.tag !== "product") {
    throw new Error("Expected one positional product argument");
  }

  assert_equals(packed.arg.entries.length, 2);
  assert_equals(packed.args, packed.arg.entries.map((entry) => entry.value));
  assert_equals(binding_value(source.statements[2]), {
    tag: "var",
    name: "f",
  });
  const formatted = format_source(source);
  assert_equals(
    formatted,
    "let chained = f x y + g z\n" +
      "let packed = f (a, b)\n" +
      "let next = f\n" +
      "let separate = x",
  );
  assert_equals(parse_source(formatted), source);
});

Deno.test("bindings and unary functions share recursive patterns", () => {
  const source = parse_source(`
const { add } = import "./math.ix"
let (left, .right = right) = pair
let [head, ...tail] = values
let choose = rec .some value => value
`);
  const record = source.statements[0];
  const product = source.statements[1];
  const array = source.statements[2];
  const choose = binding_value(source.statements[3]);

  if (record?.tag !== "bind" || product?.tag !== "bind") {
    throw new Error("Expected pattern bindings");
  }

  if (array?.tag !== "bind") {
    throw new Error("Expected array binding");
  }

  assert_equals(record.pattern?.tag, "record");
  assert_equals(product.pattern?.tag, "product");
  assert_equals(array.pattern?.tag, "array");

  if (choose.tag !== "rec" || choose.pattern?.tag !== "union_case") {
    throw new Error("Expected recursive union-pattern function");
  }

  assert_equals(choose.pattern.name, "some");
  assert_equals(
    format_source(source),
    'const { add } = import "./math.ix"\n' +
      "let (left, .right = right) = pair\n" +
      "let [head, ...tail] = values\n" +
      "let choose = rec .some value => value",
  );
});

Deno.test("products and fixed arrays use distinct delimiters", () => {
  const source = parse_source(`
type Pair = (.left = I32, .right = I32)
type Row = [I32; width * 2 + 1]
let pair = (.left = 1, .right = 2)
let values = [1, 2, ...tail]
  let zeros = [0; width + 1]
`);
  const pair = source.declarations?.[0];
  const row = source.declarations?.[1];

  if (pair?.tag !== "type" || row?.tag !== "type") {
    throw new Error("Expected type declarations");
  }

  assert_equals(pair.body.tag, "product");
  assert_equals(row.body, {
    tag: "alias",
    type_name: "[I32; width * 2 + 1]",
  });
  assert_equals(binding_value(source.statements[0]).tag, "product");
  assert_equals(binding_value(source.statements[1]).tag, "array");
  assert_equals(binding_value(source.statements[2]).tag, "array_repeat");
  assert_equals(parse_source(format_source(source)), source);

  assert_throws(
    () => parse_source("type OldPair = [I32, I32]\n"),
    "Expected `;` in fixed array type",
  );
});

Deno.test("imports casts and updates have one canonical expression form", () => {
  const source = parse_source(`
let dependency = import "./dependency.ix"
let narrowed = value as [I32; width]
let changed = value with { count: 1 }
`);

  assert_equals(binding_value(source.statements[0]), {
    tag: "import",
    path: "./dependency.ix",
  });
  assert_equals(binding_value(source.statements[1]).tag, "as");
  assert_equals(binding_value(source.statements[2]).tag, "struct_update");
  assert_equals(parse_source(format_source(source)), source);

  assert_throws(
    () => parse_source('import dependency from "./dependency.ix"\n'),
    "Expected import path literal",
  );
  assert_throws(
    () => parse_source("let changed = value { count: 1 }\n"),
    "Struct updates require `with { ... }`",
  );
});

Deno.test("match arms require leading pipes and preserve optional guards", () => {
  const source = parse_source(`
let picked = match choice {
  | .some value if value > 0 => value
  | .none => 0
}
`);
  const picked = binding_value(source.statements[0]);

  if (picked.tag !== "match") {
    throw new Error("Expected match expression");
  }

  assert_equals(picked.arms.length, 2);
  assert_equals(picked.arms[0]?.pattern.tag, "union_case");
  assert_equals(picked.arms[0]?.guard?.tag, "prim");
  assert_equals(picked.arms[1]?.guard, undefined);
  const formatted = format_source(source);
  assert_equals(
    formatted,
    "let picked = match choice { | .some value if value > 0 => value " +
      "| .none => 0 }",
  );
  assert_equals(parse_source(formatted), source);

  assert_throws(
    () => parse_source("let picked = match choice { _ => 0 }\n"),
    "Expected `|`",
  );
});
