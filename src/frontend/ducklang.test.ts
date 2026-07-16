import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import {
  ducklang_effects_prelude_text,
  ducklang_functional_prelude_text,
  ducklang_prelude_text,
  ducklang_runtime_prelude_text,
} from "./prelude.ts";
import { Source } from "./source.ts";

const add_duck = `
duck Add Self Other Output {
  .add = [Self, Other] -> Output
}

extend I32 {
  .add = [left, right] => @wasm.add_i32 [left, right]
}
`;

function occurrence_count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

Deno.test("structural duck members resolve through typed Wasm intrinsics", () => {
  const wat = Source.wat(add_duck + "Add.add [20, 22]");

  assert_includes(wat, "i32.add");
  assert_equals(occurrence_count(wat, "i32.add"), 1);
});

Deno.test("declared operators preserve associativity across duck results", () => {
  const wat = Source.wat(
    add_duck +
      "infixl 60 +++ = Add.add\n" +
      "20 +++ 22 +++ 0",
  );

  assert_equals(occurrence_count(wat, "i32.add"), 2);
});

Deno.test("exact aliases share structural extensions", () => {
  const wat = Source.wat(`
type Scalar = I32
${add_duck}
let left: Scalar = 20
Add.add [left, 22]
`);

  assert_includes(wat, "i32.add");
});

Deno.test("type namespaces expose ordered labeled product projections", async () => {
  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
type Vec3 = struct {
  .x = I32,
  .y = I32,
  .z = I32,
}
let value: Vec3 = [1, 2, 3]
Vec3.x value + Vec3.y value * 10 + Vec3.z value * 100
`);
  const instance = await instantiate_wat(wat, "ducklang_struct_accessors", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for Ducklang struct accessors");
  }

  assert_equals(main(), 321);
});

Deno.test("generic structs retain their source-built namespace", async () => {
  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = left => right => struct {
  .first = left,
  .second = right,
}
const int_pair = pair_type(I32)(I32)
let value: int_pair = [20, 22]
int_pair.first value + int_pair.second value
`);
  const instance = await instantiate_wat(wat, "ducklang_generic_struct", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for generic Ducklang struct");
  }

  assert_equals(main(), 42);
});

Deno.test("struct is an explicitly imported source const function", () => {
  assert_throws(
    () =>
      Source.wat(`
type Point = struct { .x = I32 }
let point: Point = [20]
point.x
`),
    "Unbound core value: struct",
  );

  assert_throws(
    () =>
      Source.wat(`
const struct = (const fields) => comptime fields
type Point = struct { .x = I32 }
let point: Point = [20]
Point.x point
`),
    "Compile-time shape cannot be emitted as a Core result",
  );

  assert_equals(ducklang_prelude_text.includes("@shape.entries"), false);
  assert_equals(ducklang_prelude_text.includes("@type.product"), false);
  assert_equals(ducklang_prelude_text.includes("@type.namespace"), false);

  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
type Point = struct { .x = I32 }
let point: Point = [20]
Point.x point
`);
  assert_includes(wat, "i32.const 20");
});

Deno.test("prelude exports compose into a specialized runtime function", async () => {
  const wat = Source.wat(`
const { identity, compose } = comptime (import "duck:prelude/functional")()
const add_two = value => value + 2
const double = value => value * 2
const combined = comptime compose [add_two, double]
identity (combined 20)
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_compose", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude composition");
  }

  assert_equals(main(), 42);
});

Deno.test("prelude operators cover pipelines collections and integer bits", async () => {
  const wat = Source.wat(`
const { length, bit_or } = comptime import "duck:prelude/functional" ()
const increment = value => value + 1
const double = value => value * 2
const decorate = value => value <> "c"
let piped = 20 |> increment |> double
let text_length = length (decorate "ab")
let shifted = 1 << 4
piped + text_length + bit_or [shifted, 2]
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_operators", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude operators");
  }

  assert_equals(main(), 63);
});

Deno.test("prelude functor and monad operators dispatch through ducks", async () => {
  const wat = Source.wat(`
const { identity } = comptime import "duck:prelude/functional" ()
type Identity value = [.value = value]
extend Identity {
  .map = [wrapped, transform] => [.value = transform(wrapped.value)]
  .bind = [wrapped, transform] => transform wrapped.value
}
type IntIdentity = Identity I32
let wrapped: IntIdentity = [.value = 40]
let increment = (value: I32) => value + 1
let wrap_increment: I32 -> IntIdentity = value => [.value = value + 1]
let mapped: IntIdentity = increment <$> wrapped
let bound: IntIdentity = wrapped >>= wrap_increment
identity (mapped.value + bound.value)
`);
  const instance = await instantiate_wat(
    wat,
    "ducklang_prelude_categories",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude categories");
  }

  assert_equals(main(), 82);
});

Deno.test("prelude From dispatches conversion through the source type", async () => {
  const wat = Source.wat(`
const { identity } = comptime import "duck:prelude/functional" ()
type Celsius = [.value = I32]
type Fahrenheit = [.value = I32]
extend Fahrenheit {
  .from = (value: Fahrenheit) => [.value = (value.value - 32) * 5 / 9]
}
let source: Fahrenheit = [.value = 212]
let converted: Celsius = From.from source
identity converted.value
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_from", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude From conversion");
  }

  assert_equals(main(), 100);
});

Deno.test("prelude exports generic option types", async () => {
  const wat = Source.wat(`
const { identity } = comptime (import "duck:prelude/functional")()
type IntOption = Option I32
let value: IntOption = IntOption.some 42
identity (if let .some(found) = value { found } else { 0 })
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_option", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude option");
  }

  assert_equals(main(), 42);
});

Deno.test("prelude declares functional contracts and standard effects", () => {
  const functional = Source.parse(ducklang_functional_prelude_text);
  const runtime = Source.parse(ducklang_runtime_prelude_text);
  const effects_source = Source.parse(ducklang_effects_prelude_text);
  const functional_ducks = (functional.declarations || []).flatMap(
    (declaration) => {
      if (declaration.tag === "duck") {
        return [declaration.name];
      }

      return [];
    },
  );
  const runtime_ducks = (runtime.declarations || []).flatMap((declaration) => {
    if (declaration.tag === "duck") {
      return [declaration.name];
    }

    return [];
  });
  const effects = (effects_source.declarations || []).flatMap((declaration) => {
    if (declaration.tag === "effect") {
      return [declaration.name];
    }

    return [];
  });

  assert_equals(functional_ducks, [
    "Eq",
    "Ord",
    "Monoid",
    "Functor",
    "Applicative",
    "Monad",
    "Foldable",
    "Show",
    "From",
    "Default",
    "Bounded",
    "Enum",
    "Alternative",
    "Bifunctor",
    "Contravariant",
    "Traversable",
  ]);
  assert_equals(runtime_ducks, ["Semigroup", "Bits"]);
  assert_equals(effects, [
    "State",
    "Reader",
    "Writer",
    "Raise",
  ]);
  assert_equals(
    (effects_source.declarations || []).flatMap((declaration) => {
      if (declaration.tag === "effect") {
        return [declaration.params];
      }

      return [];
    }),
    [["value"], ["environment"], ["output"], ["error"]],
  );
});

Deno.test("higher-kinded duck signatures validate source type constructors", () => {
  const wat = Source.wat(`
type Identity value = value
duck Functor F A B {
  .map = [F A, A -> B] -> F B
}
extend Identity {
  .map = [value, transform] => transform value
}
comptime Functor [Identity, I32, I32]
0
`);

  assert_includes(wat, "i32.const 0");
});

Deno.test("imported functional ducks report the missing constructor instance", () => {
  assert_throws(
    () =>
      Source.wat(`
const { identity } = comptime (import "duck:prelude/functional")()
type IntOption = Option I32
let value: IntOption = IntOption.some 41
let increment = (value: I32) => value + 1
let mapped: IntOption = Functor.map [value, increment]
identity mapped
`),
    "Missing duck satisfaction for Functor.map at Option",
  );
});

Deno.test("prelude State effect infers its value type from a source handler", async () => {
  const wat = Source.wat(`
const { identity } = comptime (import "duck:prelude/functional")()
const _ = comptime (import "duck:prelude/effects")()
let run = () => {
  before <- State.get()
  _ <- State.put(before + 2)
  after <- State.get()
  after
}
let state = {
  let current = 40
  State {
    get: (!resume) => !resume(current),
    put: (value, !resume) => {
      current = value
      !resume(())
    },
    return: value => value,
  }
}
identity (try run() with state)
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_state", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude State effect");
  }

  assert_equals(main(), 42);
});

Deno.test("prelude Writer effect infers its output type from calls", async () => {
  const wat = Source.wat(`
const { identity } = comptime (import "duck:prelude/functional")()
const _ = comptime (import "duck:prelude/effects")()
let run = () => {
  _ <- Writer.tell("twenty")
  _ <- Writer.tell("two")
  33
}
let writer = {
  let written = 0
  Writer {
    tell: (message, !resume) => {
      written = written + @len(message)
      !resume(())
    },
    return: value => value + written,
  }
}
identity (try run() with writer)
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_writer", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude Writer effect");
  }

  assert_equals(main(), 42);
});

Deno.test("source-built struct namespaces stay scoped to their type value", () => {
  const source = `
const { struct } = comptime (import "duck:prelude")()
type Cartesian = struct { .x = I32 }
type Polar = struct { .radius = I32 }
let cartesian: Cartesian = [20]
let polar: Polar = [22]
Cartesian.x cartesian + Polar.radius polar
`;

  assert_includes(Source.wat(source), "i32.add");
  assert_throws(
    () => Source.wat(source.replace("Polar.radius polar", "Polar.x polar")),
    "x",
  );
});

Deno.test("computed type members require compile-time Text names", () => {
  assert_throws(
    () => Source.wat("comptime ([] with { .[1] = value => value })"),
    "Computed type member name must be non-empty Text",
  );
});

Deno.test("labeled product patterns project selected struct slots", () => {
  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
type Point = struct { .x = I32, .y = I32 }
let point: Point = [20, 22]
let { .x = x } = point
x
`);

  assert_includes(wat, "i32.const 20");
});

Deno.test("source struct construction composes with repeat types", () => {
  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
const point_type = struct { .x = I32, .y = I32 }
type MaybeType = | .some = point_type | .none
type RowType = [I32; 2 * 3]
const maybe_type = MaybeType
let point: point_type = [20, 22]
let row: RowType = [1, 2, 3, 4, 5, 6]
let value: maybe_type = maybe_type.some point
if let .some(selected) = value {
  selected.x + row[5]
} else {
  0
}
`);

  assert_includes(wat, "i32.const 20");
  assert_includes(wat, "i32.const 6");
});

Deno.test("repeat types reject array constructor syntax", () => {
  assert_throws(
    () => Source.parse("type Pixels = array [I32, 3]\n"),
    "Expected type name",
  );
});

Deno.test("union namespaces contextualize labeled product payloads", () => {
  const wat = Source.wat(`
const { struct } = comptime (import "duck:prelude")()
type Point = struct { .x = I32, .y = I32 }
type Shape = | .point = Point | .none
let shape: Shape = Shape.point [20, 22]
if let .point(point) = shape {
  point.x
} else {
  0
}
`);

  assert_includes(wat, "i32.const 20");
});

Deno.test("module bindings shadow the prelude struct constructor", () => {
  const wat = Source.wat(`
let struct = value => value
struct 42
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("receiver calls use extensions when no runtime field shadows them", () => {
  const wat = Source.wat(`
extend I32 {
  .twice = value => @wasm.add_i32 [value, value]
}
20.twice []
`);

  assert_includes(wat, "i32.add");
});

Deno.test("explicit duck checks reject missing and incompatible members", () => {
  assert_throws(
    () =>
      Source.wat(`
duck Add Self Other Output {
  .add = [Self, Other] -> Output
}
comptime Add [I32, I32, I32]
0
`),
    "Missing duck satisfaction for Add.add at I32",
  );

  assert_throws(
    () =>
      Source.wat(`
duck Add Self Other Output {
  .add = [Self, Other] -> Output
}
extend I32 {
  .add = [left, right] => @wasm.eq_i32 [left, right]
}
comptime Add [I32, I32, I32]
0
`),
    "requires role Output to be I32, got Bool",
  );
});

Deno.test("normalized aliases reject duplicate extension members", () => {
  assert_throws(
    () =>
      Source.wat(`
type Scalar = I32
extend I32 {
  .read = value => value
}
extend Scalar {
  .read = value => value
}
0
`),
    "Duplicate extension member in the same scope: I32.read",
  );
});
