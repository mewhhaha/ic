import { assert_equals } from "../assert.ts";
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import {
  intersect_sem_types,
  sem_type_from_expr,
  sem_type_key,
  sem_type_subtype,
  type SemType,
  subtract_sem_type,
} from "./semantic_type.ts";

function type(text: string): SemType {
  return sem_type_from_expr(parse_type_expr(tokenize(text)));
}

Deno.test("semantic unions normalize as commutative idempotent sets", () => {
  assert_equals(
    sem_type_key(type("Text | Int | Text")),
    sem_type_key(type("Int | Text")),
  );
  assert_equals(sem_type_key(type("_ | Text")), "top");
  assert_equals(sem_type_key(type("Never | Text")), "scalar(Text)");
});

Deno.test("semantic intersections and differences normalize finite unions", () => {
  assert_equals(
    sem_type_key(intersect_sem_types(type("Int | Text"), type("Text"))),
    "scalar(Text)",
  );
  assert_equals(
    sem_type_key(subtract_sem_type(type("Int | Text"), type("Text"))),
    "scalar(I32)",
  );
  assert_equals(
    sem_type_key(subtract_sem_type(type("Text"), type("Text"))),
    "never",
  );
});

Deno.test("record intersections merge constraints and use width subtyping", () => {
  const x: SemType = {
    tag: "record",
    fields: [{ name: "x", type: type("Int") }],
  };
  const y: SemType = {
    tag: "record",
    fields: [{ name: "y", type: type("Text") }],
  };
  const both = intersect_sem_types(x, y);

  assert_equals(sem_type_key(both), "record(x:scalar(I32),y:scalar(Text))");
  assert_equals(sem_type_subtype(both, x), true);
  assert_equals(sem_type_subtype(both, y), true);
});
