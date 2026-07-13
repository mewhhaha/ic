import { assert_equals } from "../assert.ts";
import { format_expr } from "./format.ts";
import { parse_source } from "./parser.ts";

Deno.test("is parses type operands at comparison precedence", () => {
  const source = parse_source(
    "let matches = value is #atom && other is &(Left | Right)",
  );
  const statement = source.statements[0];

  if (!statement || statement.tag !== "bind") {
    throw new Error("Expected binding statement");
  }

  assert_equals(statement.value, {
    tag: "if",
    cond: {
      tag: "is",
      value: { tag: "var", name: "value" },
      type_expr: { tag: "atom", name: "atom" },
    },
    then_branch: {
      tag: "if",
      cond: {
        tag: "is",
        value: { tag: "var", name: "other" },
        type_expr: {
          tag: "borrow",
          value: {
            tag: "union",
            left: { tag: "name", name: "Left" },
            right: { tag: "name", name: "Right" },
          },
        },
      },
      then_branch: { tag: "bool", value: true },
      else_branch: { tag: "bool", value: false },
    },
    else_branch: { tag: "bool", value: false },
  });
});

Deno.test("is stops before blocks and expression delimiters", () => {
  const source = parse_source(
    "if value is #(Left | Right) { 1 }\ncall(value is Thing, other)",
  );
  const first = source.statements[0];
  const second = source.statements[1];

  if (!first || first.tag !== "if_stmt") {
    throw new Error("Expected if statement");
  }

  if (!second || second.tag !== "expr" || second.expr.tag !== "app") {
    throw new Error("Expected expression statement");
  }

  assert_equals(first.cond.tag, "is");
  assert_equals(second.expr.args[0], {
    tag: "is",
    value: { tag: "var", name: "value" },
    type_expr: { tag: "name", name: "Thing" },
  });
});

Deno.test("is formatter protects a logical value", () => {
  assert_equals(
    format_expr({
      tag: "is",
      value: {
        tag: "if",
        cond: { tag: "var", name: "left" },
        then_branch: { tag: "var", name: "right" },
        else_branch: { tag: "num", type: "i32", value: 0 },
      },
      type_expr: { tag: "name", name: "Truth" },
    }),
    "(if left right else 0) is Truth",
  );
});
