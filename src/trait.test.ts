import { as_data, Show } from "@mewhhaha/typeclasses";
import { assert_equals, assert_throws } from "./assert.ts";
import { Ic } from "./ic.ts";
import { Emit, Format, Typed } from "./trait.ts";
import { Expr } from "./expr.ts";

Deno.test("trait dispatch goes through registered typeclass instances", () => {
  const node = { tag: "num", type: "i32", value: 21 } as const;

  assert_equals(Format.fmt(Ic, node), "21:i32");
  assert_equals(Format.all(Ic, [node, node]), ["21:i32", "21:i32"]);
});

Deno.test("format companions are Show instances for wrapped data", () => {
  const node = { tag: "num", type: "i32", value: 21 } as const;

  assert_equals(Show.show(as_data(Ic, node)), Format.fmt(Ic, node));
});

Deno.test("emit and typed dispatch keep the explicit dictionary shape", () => {
  const expr = Emit.emit(Ic, { tag: "num", type: "i64", value: 7n } as const);

  assert_equals(Typed.type(Expr, expr), "i64");
});

Deno.test("unregistered dictionaries reject with a missing instance error", () => {
  const orphan = {
    fmt(value: number): string {
      return value.toString();
    },
  };

  assert_throws(
    () => Format.fmt(orphan, 1),
    "Missing Format instance for dictionary",
  );
});
