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
let packed = f [a, b]
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
  assert_equals(packed.args, [packed.arg]);
  assert_equals(binding_value(source.statements[2]), {
    tag: "var",
    name: "f",
  });
  const formatted = format_source(source);
  assert_equals(
    formatted,
    "let chained = f x y + g z\n" +
      "let packed = f [a, b]\n" +
      "let next = f\n" +
      "let separate = x",
  );
  assert_equals(parse_source(formatted), source);
});

Deno.test("prelude operators retain their source operand order", () => {
  const text = "let applied = transform $ value\n" +
    "let piped = value |> transform\n" +
    "let mapped = transform <$> wrapped\n" +
    "let combined = left <> right\n" +
    "let bound = wrapped >>= next\n" +
    "let shifted = bits << amount";

  assert_equals(format_source(parse_source(text)), text);
});

Deno.test("bindings and unary functions share recursive patterns", () => {
  const source = parse_source(`
const { add, .subtract = subtract_numbers } = import "./math.duck"
let { .left = left, .right = right } = pair
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

  assert_equals(record.pattern?.tag, "product");
  assert_equals(product.pattern?.tag, "product");
  assert_equals(array.pattern?.tag, "array");

  if (choose.tag !== "rec" || choose.pattern?.tag !== "union_case") {
    throw new Error("Expected recursive union-pattern function");
  }

  assert_equals(choose.pattern.name, "some");
  assert_equals(
    format_source(source),
    'const { add, .subtract = subtract_numbers } = import "./math.duck"\n' +
      "let { left, right } = pair\n" +
      "let [head, ...tail] = values\n" +
      "let choose = rec .some value => value",
  );
});

Deno.test("shape values use shorthand fields and dotted explicit names", () => {
  const source = parse_source(`
const code = 42
const renamed = 7
return { code, .status = renamed }
`);
  const returned = source.statements[2];

  if (returned?.tag !== "return" || returned.value.tag !== "struct_value") {
    throw new Error("Expected exported shape value");
  }

  assert_equals(
    returned.value.fields.map((field) => field.name),
    ["code", "status"],
  );
  assert_equals(
    format_source(source),
    "const code = 42\n" +
      "const renamed = 7\n" +
      "return { code, .status = renamed }",
  );
  assert_equals(parse_source(format_source(source)), source);

  const update = parse_source("let changed = value with { code }");
  assert_equals(format_source(update), "let changed = value with { code }");
  assert_equals(parse_source(format_source(update)), update);
});

Deno.test("products and compact repeats share canonical brackets", () => {
  const source = parse_source(`
type Pair = struct { .left = I32, .right = I32 }
type Row = [I32; width * 2 + 1]
let pair = [.left = 1, .right = 2]
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

  const positional = parse_source("type Positional = [I32, I32]\n");
  const positional_declaration = positional.declarations?.[0];

  if (positional_declaration?.tag !== "type") {
    throw new Error("Missing positional product declaration");
  }

  assert_equals(positional_declaration.body.tag, "product");
});

Deno.test("imports casts and updates have one canonical expression form", () => {
  const source = parse_source(`
let dependency = import "./dependency.duck"
let narrowed = value as [I32; width]
let changed = value with { .count = 1 }
`);

  assert_equals(binding_value(source.statements[0]), {
    tag: "import",
    path: "./dependency.duck",
  });
  assert_equals(binding_value(source.statements[1]).tag, "as");
  assert_equals(binding_value(source.statements[2]).tag, "struct_update");
  assert_equals(parse_source(format_source(source)), source);

  assert_throws(
    () => parse_source('import dependency from "./dependency.duck"\n'),
    "Expected import path literal",
  );
  assert_throws(
    () => parse_source("let changed = value { count: 1 }\n"),
    "Runtime products use contextual `[...]` values",
  );
});

Deno.test("import invocation formats without redundant parentheses", () => {
  const source = parse_source(
    'let dependency = (import "./dependency.duck")()\n',
  );

  assert_equals(
    format_source(source),
    'let dependency = import "./dependency.duck" ()',
  );
  assert_equals(parse_source(format_source(source)), source);
});

Deno.test("compiler functions retain their intrinsic prefix", () => {
  const source = parse_source(
    "let append = [left, right] => left\n" +
      'let compiler_value = @append("a", "b")\n' +
      'let user_value = append("a", "b")\n',
  );
  const compiler_value = binding_value(source.statements[1]);
  const user_value = binding_value(source.statements[2]);

  if (compiler_value.tag !== "app" || compiler_value.func.tag !== "var") {
    throw new Error("Expected compiler function application");
  }

  if (user_value.tag !== "app" || user_value.func.tag !== "var") {
    throw new Error("Expected user function application");
  }

  assert_equals(compiler_value.func.name, "@append");
  assert_equals(user_value.func.name, "append");
  assert_equals(
    format_source(source),
    "let append = [left, right] => left\n" +
      'let compiler_value = @append ["a", "b"]\n' +
      'let user_value = append ["a", "b"]',
  );
});

Deno.test("computed type members round trip with leading product spreads", () => {
  const source = parse_source(`
let accumulated = [...product_type, field.value]
let enriched = product_type with {
  .[field.name] = value => value[index]
}
`);
  const accumulated = binding_value(source.statements[0]);
  const enriched = binding_value(source.statements[1]);

  if (accumulated.tag !== "array" || enriched.tag !== "type_with") {
    throw new Error("Expected compile-time product type construction");
  }

  assert_equals(accumulated.leading_rest, true);
  assert_equals(accumulated.rest, { tag: "var", name: "product_type" });
  assert_equals(enriched.members.length, 1);
  assert_equals(parse_source(format_source(source)), source);
});

Deno.test("legacy aggregate spellings are rejected", () => {
  assert_throws(
    () => parse_source("let pair = (.left = 1, .right = 2)"),
    "Product values use `[...]`",
  );
  assert_throws(
    () => parse_source("type Pair = (.left = I32, .right = I32)"),
    "Product types use `[...]`",
  );
  assert_throws(
    () => parse_source("type Maybe = .some = I32 | .none"),
    "Sum types require a leading `|`",
  );
  assert_throws(
    () => parse_source("const maybe_type = union { .some = I32 }"),
    "Sum types use `type Name = | ...`",
  );
  assert_throws(
    () =>
      parse_source(
        "const pair_type = struct { left: I32, right: I32 }",
      ),
    "Runtime products use contextual `[...]` values",
  );
  assert_throws(
    () => parse_source("let point = pair_type { left: 1, right: 2 }"),
    "Runtime products use contextual `[...]` values",
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

Deno.test("numeric literals carry explicit integer and f32 widths", () => {
  const source = parse_source(`
let byte_mask = 0xff
let wide_mask = 0x100000000i64
let ratio = 1.5f32
let exponent = 1e2f32
`);

  assert_equals(binding_value(source.statements[0]), {
    tag: "num",
    type: "i32",
    value: 255,
  });
  assert_equals(binding_value(source.statements[1]), {
    tag: "num",
    type: "i64",
    value: 4294967296n,
  });
  assert_equals(binding_value(source.statements[2]), {
    tag: "num",
    type: "f32",
    value: 1.5,
  });
  assert_equals(binding_value(source.statements[3]), {
    tag: "num",
    type: "f32",
    value: 100,
  });
  assert_equals(
    format_source(source),
    "let byte_mask = 255\n" +
      "let wide_mask = 4294967296i64\n" +
      "let ratio = 1.5f32\n" +
      "let exponent = 100f32",
  );
  assert_throws(
    () => parse_source("let value = 0x"),
    "Hexadecimal literal requires at least one digit",
  );
  assert_throws(
    () => parse_source("let value = 1.5"),
    "Floating-point literal requires an f32 suffix",
  );
});
