import {
  as_data,
  Do,
  Just,
  maybe,
  type MaybeValue,
  Nothing,
  Show,
} from "@mewhhaha/typeclasses";
import { assert_equals, assert_throws } from "./assert.ts";
import { Ic, type Ic as IcNode } from "./ic.ts";
import { Emit, Format, Typed } from "./trait.ts";
import { Expr } from "./expr.ts";

Deno.test("trait dispatch goes through registered typeclass instances", () => {
  const node = { tag: "num", type: "i32", value: 21 } as const;

  assert_equals(Format.fmt(Ic, node), "21:i32");
  assert_equals(Format.all(Ic, [node, node]), ["21:i32", "21:i32"]);
});

Deno.test("format companions are Show instances for wrapped data", () => {
  const node = { tag: "num", type: "i32", value: 21 } as const;
  // The Show instance is installed at registration time, so the wrapped
  // value carries it at runtime while the companion's static type does
  // not know the token; the cast bridges that gap.
  const wrapped = as_data(Ic, node) as never;

  assert_equals(Show.show(wrapped), Format.fmt(Ic, node));
});

Deno.test("emit and typed dispatch keep the explicit dictionary shape", () => {
  const expr = Emit.emit(Ic, { tag: "num", type: "i64", value: 7n } as const);

  assert_equals(Typed.type(Expr, expr), "i64");
});

Deno.test("Do syntax chains Maybe extractions over reduced Ic values", () => {
  const left = Ic.reduce({
    tag: "prim",
    prim: "i32.add",
    args: [
      { tag: "num", type: "i32", value: 20 },
      { tag: "num", type: "i32", value: 1 },
    ],
  });
  const right = Ic.reduce({ tag: "num", type: "i32", value: 21 });

  const total = Do(function* () {
    const first = yield* numeric_value(left);
    const second = yield* numeric_value(right);

    return first + second;
  });

  assert_equals(maybe(0, (value: number) => value, total), 42);

  const missing = Do(function* () {
    const first = yield* numeric_value({ tag: "var", name: "free" });

    return first;
  });

  assert_equals(maybe(-1, (value: number) => value, missing), -1);
});

function numeric_value(value: IcNode): MaybeValue<number> {
  if (value.tag === "num" && typeof value.value === "number") {
    return Just(value.value);
  }

  return Nothing();
}

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
