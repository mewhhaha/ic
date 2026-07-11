import { assert_equals } from "../assert.ts";
import { format_source } from "./format.ts";
import { parse_source } from "./parser.ts";

Deno.test("atoms parse and borrows format canonically", () => {
  const source = parse_source("let value = &#snake_case");
  const statement = source.statements[0];

  if (!statement || statement.tag !== "bind") {
    throw new Error("Expected binding statement");
  }

  assert_equals(statement.value, {
    tag: "borrow",
    value: { tag: "atom", name: "snake_case" },
  });
  assert_equals(format_source(source), "let value = &#snake_case");
});

Deno.test("legacy borrow syntax remains accepted and canonicalized", () => {
  const source = parse_source("let value = borrow item");
  assert_equals(format_source(source), "let value = &item");
});
