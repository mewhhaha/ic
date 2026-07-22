import { assert_equals } from "../assert.ts";
import type { Stmt } from "./ast.ts";
import { parse_source } from "./parser.ts";
import { infer_front_function_signatures } from "./signature_inference.ts";
import { format_type_expr } from "./type_expr.ts";

function binding_signature(statement: Stmt | undefined): string | undefined {
  if (statement?.tag !== "bind" || statement.type_annotation === undefined) {
    return undefined;
  }

  return format_type_expr(statement.type_annotation);
}

Deno.test("function signatures infer field owners and transitive borrows", () => {
  const source = infer_front_function_signatures(parse_source(`
type Point = struct { .x = I32 }
let read = point => point.x
let forward = point => read(point)
let point = Point.new { .x = 42 }
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

Deno.test("mutually recursive components infer one shared signature solution", () => {
  const source = infer_front_function_signatures(parse_source(`
let rec even = value => {
  if value == 0 { 1 } else { odd(value - 1) }
}
and odd = value => {
  if value == 0 { 0 } else { even(value - 1) }
}
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

Deno.test("unconstrained polymorphic functions remain unspecialized", () => {
  const source = infer_front_function_signatures(parse_source(`
let identity = value => value
identity(true)
identity(1)
`));

  assert_equals(binding_signature(source.statements[0]), undefined);
});
