import { assert_equals } from "../assert.ts";
import type { Stmt } from "./ast.ts";
import { parse_source } from "./parser.ts";
import { infer_front_function_signatures } from "./signature_inference.ts";
import { substitute_front_stmt } from "./substitute.ts";
import { format_type_expr } from "./type_expr.ts";

function binding_signature(statement: Stmt | undefined): string | undefined {
  if (statement?.tag !== "bind" || statement.type_annotation === undefined) {
    return undefined;
  }

  return format_type_expr(statement.type_annotation);
}

Deno.test("declared polymorphic signatures contextualize lambda parameters", () => {
  const source = parse_source(`
const choose: forall left right.[left, right] -> left = (first, second) => first;
choose(42, true)
`);
  const choose = source.statements[0];

  if (choose?.tag !== "bind" || choose.value.tag !== "lam") {
    throw new Error("Missing choose function");
  }

  assert_equals(
    choose.value.params.map((param) => param.annotation),
    ["left", "right"],
  );
});

Deno.test("function signatures infer field owners and transitive borrows", () => {
  const source = infer_front_function_signatures(parse_source(`
type Point = struct { .x = I32 }
let read = point => point.x;
let forward = point => read(point);
let point = Point.new { .x = 42 };
forward(&point)
`));
  const read = source.statements.find((statement) => {
    return statement.tag === "bind" && statement.name === "read";
  });
  const forward = source.statements.find((statement) => {
    return statement.tag === "bind" && statement.name === "forward";
  });

  assert_equals(binding_signature(read), "&Point -> I32");
  assert_equals(binding_signature(forward), "&Point -> I32");
});

Deno.test("function signatures preserve transient value-pack results", () => {
  const source = infer_front_function_signatures(parse_source(`
let direct = value => (value, true);
let block = value => {
  (value, false)
};
let (direct_value, direct_flag) = direct(1);
let (block_value, block_flag) = block(2);
direct_value + block_value
`));

  assert_equals(binding_signature(source.statements[0]), "I32 -> (I32, Bool)");
  assert_equals(binding_signature(source.statements[1]), "I32 -> (I32, Bool)");
});

Deno.test("mutually recursive components infer one shared signature solution", () => {
  const source = infer_front_function_signatures(parse_source(`
let rec even = value => {
  if value == 0 { 1 } else { odd(value - 1) }
}
and odd = value => {
  if value == 0 { 0 } else { even(value - 1) }
};
even(10)
`));
  const even = source.statements[0];

  if (even?.tag !== "bind") {
    throw new Error("Missing even binding");
  }

  assert_equals(binding_signature(even), "I32 -> I32");
  assert_equals(even.mutual?.length, 1);

  const odd = even.mutual?.[0];
  assert_equals(
    odd?.type_annotation && format_type_expr(odd.type_annotation),
    "I32 -> I32",
  );
});

Deno.test("recursive match results infer from the terminating branch", () => {
  const source = infer_front_function_signatures(parse_source(`
type Numbers = | \`More [I32, Numbers] | \`End Unit
let rec last = (values: Numbers) => match values {
  | \`More node => last(node[1])
  | \`End () => 0
};
last(\`More [42, \`End ()])
`));

  assert_equals(binding_signature(source.statements[0]), "Numbers -> I32");
});

Deno.test("recursive value-pack results remain transient", () => {
  const source = infer_front_function_signatures(parse_source(`
let rec pair = (value: I32) => {
  if value == 0 { (1, 2) } else { pair(value - 1) }
};
let (left, right) = pair(3);
left + right
`));

  assert_equals(binding_signature(source.statements[0]), "I32 -> (I32, I32)");
});

Deno.test("substitution preserves inferred value-pack signatures", () => {
  const source = infer_front_function_signatures(parse_source(`
let pair = value => (value, value);
let (left, right) = pair(1);
left + right
`));
  const pair = source.statements[0];

  if (pair === undefined) {
    throw new Error("Missing pair binding");
  }

  const substituted = substitute_front_stmt(
    pair,
    new Map([["unrelated", { tag: "num", type: "i32", value: 0 }]]),
  );

  assert_equals(binding_signature(substituted), "I32 -> (I32, I32)");
});

Deno.test("unconstrained polymorphic functions remain unspecialized", () => {
  const source = infer_front_function_signatures(parse_source(`
let identity = value => value;
identity(true)
identity(1)
`));

  assert_equals(binding_signature(source.statements[0]), undefined);
});
