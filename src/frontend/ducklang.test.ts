import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import {
  ducklang_effect_defaults_prelude_text,
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

Deno.test("newtype seals and unwraps a zero-cost nominal value", () => {
  const wat = Source.wat(`
const { newtype } = comptime import "duck:prelude" ()
type Centimeter = newtype I32
const distance = 42 :> Centimeter
Centimeter.unwrap distance
`);

  assert_includes(wat, "i32.const 42");
  assert_equals(ducklang_prelude_text.includes("const newtype"), true);
});

Deno.test("fixed-width integers wrap and preserve unsigned comparisons", async () => {
  const wat = Source.wat(`
let maximum: U5 = 31u5
let one: U5 = 1u5
let wrapped = maximum + one
if maximum > one { wrapped } else { 7u5 }
`);
  const instance = await instantiate_wat(wat, "ducklang_fixed_integer", {});
  const main = instance.exports.main;
  assert_equals(typeof main, "function");

  if (typeof main !== "function") {
    throw new Error("Missing fixed-width integer main function");
  }

  assert_equals(main(), 0);
  assert_includes(wat, "i32.gt_u");
  assert_includes(wat, "i32.and");
});

Deno.test("fixed-width shifts use the declared width", async () => {
  const wat = Source.wat(`
let shift = (value: U5, amount: U5) => value << amount
shift [31u5, 5u5]
`);
  const instance = await instantiate_wat(wat, "ducklang_fixed_shift", {});
  const main = instance.exports.main;
  assert_equals(typeof main, "function");

  if (typeof main !== "function") {
    throw new Error("Missing fixed-width shift main function");
  }

  assert_equals(main(), 0);
  assert_includes(wat, "i32.ge_u");
});

Deno.test("wide integers use little-endian Core limbs", async () => {
  const wat = Source.wat(`
let maximum: U128 = 340282366920938463463374607431768211455u128
let one: U128 = 1u128
maximum + one
`);
  const instance = await instantiate_wat(wat, "ducklang_wide_integer", {});
  const main = instance.exports.main;
  const memory = instance.exports.memory;
  assert_equals(typeof main, "function");
  assert_equals(memory instanceof WebAssembly.Memory, true);

  if (typeof main !== "function" || !(memory instanceof WebAssembly.Memory)) {
    throw new Error("Missing wide-integer runtime exports");
  }

  const pointer = main();
  assert_equals(typeof pointer, "number");

  if (typeof pointer !== "number") {
    throw new Error("Wide-integer main result is not a pointer");
  }

  const limbs = new Uint32Array(memory.buffer, pointer, 4);
  assert_equals([...limbs], [0, 0, 0, 0]);
});

Deno.test("signed wide integer division truncates toward zero", async () => {
  for (
    const example of [
      { expression: "-100i96 / 7i96", expected: -14 },
      { expression: "-100i96 % 7i96", expected: -2 },
      { expression: "100i96 / -7i96", expected: -14 },
    ]
  ) {
    const wat = Source.wat(
      "@integer.wrap [(" + example.expression + "), I32]",
    );
    const instance = await instantiate_wat(wat, "ducklang_wide_signed", {});
    const main = instance.exports.main;
    assert_equals(typeof main, "function");

    if (typeof main !== "function") {
      throw new Error("Missing signed wide-integer main function");
    }

    assert_equals(main(), example.expected);
  }
});

Deno.test("packed source types use one scalar and typed accessors", async () => {
  const wat = Source.wat(`
const { packed } = comptime import "duck:prelude" ()
type Header = packed struct {
  .kind = U3,
  .urgent = U1,
  .length = U12,
}
let header: Header = Header.pack [5u3, 1u1, 120u12]
let changed: Header = Header.with_kind [header, 2u3]
Header.kind changed
`);
  const instance = await instantiate_wat(wat, "ducklang_packed", {});
  const main = instance.exports.main;
  assert_equals(typeof main, "function");

  if (typeof main !== "function") {
    throw new Error("Missing packed type main function");
  }

  assert_equals(main(), 2);
  assert_equals(wat.includes("call $__alloc"), false);
  assert_equals(ducklang_prelude_text.includes("const packed"), true);
});

Deno.test("packed source types cross the scalar boundary with Core limbs", async () => {
  const wat = Source.wat(`
const { packed } = comptime import "duck:prelude" ()
type Packet = packed [U64, U64]
let packet: Packet = Packet.pack [1u64, 2u64]
Packet.item_1 packet
`);
  const instance = await instantiate_wat(wat, "ducklang_wide_packed", {});
  const main = instance.exports.main;
  assert_equals(typeof main, "function");

  if (typeof main !== "function") {
    throw new Error("Missing wide packed main function");
  }

  assert_equals(main(), 2n);
  assert_includes(wat, "i32.load");
});

Deno.test("type operators compose source type values", () => {
  const wat = Source.wat(`
const { struct, type_extend, type_union, type_difference } =
  comptime import "duck:prelude" ()

type Point = struct { .x = I32 }
const point_with_double = Point :+ { .double = value => value.x * 2 }
const numeric = I32 :| I64
const narrowed = numeric :- I64
let point: Point = [21]

const _ = narrowed
point_with_double.double point
`);

  assert_includes(wat, "i32.const 21");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.mul");
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

Deno.test("prelude option combinators eliminate and inspect options", async () => {
  const wat = Source.wat(`
const { option, option_unwrap_or, option_is_some, option_is_none } = comptime import "duck:prelude/functional" ()
type IntOption = Option I32
let present: IntOption = IntOption.some 41
let absent: IntOption = .none
const increment = value => value + 1
const resolve_option = comptime option [0, increment]
let flags = if option_is_some present { 1 } else { 0 }
flags = flags + if option_is_none absent { 1 } else { 0 }
resolve_option present + option_unwrap_or [2, absent] + flags
`);
  const instance = await instantiate_wat(
    wat,
    "ducklang_prelude_option_combinators",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude option combinators");
  }

  assert_equals(main(), 46);
});

Deno.test("prelude result combinators eliminate and inspect results", async () => {
  const wat = Source.wat(`
const { result_unwrap_or, result_is_ok, result_is_err } = comptime import "duck:prelude/functional" ()
type IntResult = Result I32 I32
let succeeded: IntResult = IntResult.ok 41
let failed: IntResult = IntResult.err 7
let flags = if result_is_ok succeeded { 1 } else { 0 }
flags = flags + if result_is_err failed { 1 } else { 0 }
result_unwrap_or [3, failed] + flags
`);
  const instance = await instantiate_wat(
    wat,
    "ducklang_prelude_result_combinators",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude result combinators");
  }

  assert_equals(main(), 5);
});

Deno.test("prelude either combinators distinguish both cases", async () => {
  const wat = Source.wat(`
const { either_is_left, either_is_right } = comptime import "duck:prelude/functional" ()
type IntEither = Either I32 I32
let left: IntEither = IntEither.left 9
let right: IntEither = IntEither.right 10
let flags = if either_is_left left { 1 } else { 0 }
flags + if either_is_right right { 1 } else { 0 }
`);
  const instance = await instantiate_wat(
    wat,
    "ducklang_prelude_either_combinators",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude either combinators");
  }

  assert_equals(main(), 2);
});

Deno.test("prelude converge combines two projections", async () => {
  const wat = Source.wat(`
const { converge } = comptime import "duck:prelude/functional" ()
const add_pair = [first, second] => first + second
const increment = value => value + 1
const double = value => value * 2
const combined = comptime converge [add_pair, increment, double]
combined 10
`);
  const instance = await instantiate_wat(
    wat,
    "ducklang_prelude_converge",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude converge");
  }

  assert_equals(main(), 31);
});

Deno.test("prelude operators cover pipelines collections and integer bits", async () => {
  const wat = Source.wat(`
const { pipe, apply, length, bit_or } = comptime import "duck:prelude/functional" ()
const increment = value => value + 1
const double = value => value * 2
const decorate = value => value <> "c"
let piped = 20 |> increment |> double
let applied = double $ 10
let text_length = length (decorate "ab")
let shifted = 1 << 4
piped + applied + text_length + bit_or [shifted, 2]
`);
  const instance = await instantiate_wat(wat, "ducklang_prelude_operators", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for prelude operators");
  }

  assert_equals(main(), 83);
});

Deno.test("pipe rejects a value outside its generic input type", () => {
  assert_throws(
    () =>
      Source.wat(`
const { pipe } = comptime import "duck:prelude/functional" ()
const text_length = (value: Text) => @len(value)
20 |> text_length
`),
    "Core parameter annotation expects Text, got I32",
  );
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
  const functional_fixities = (functional.declarations || []).flatMap(
    (declaration) => {
      if (declaration.tag === "fixity") {
        return [[declaration.operator, declaration.target]];
      }

      return [];
    },
  );
  const runtime_fixities = (runtime.declarations || []).flatMap(
    (declaration) => {
      if (declaration.tag === "fixity") {
        return [[declaration.operator, declaration.target]];
      }

      return [];
    },
  );
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
    "Semigroup",
    "Bits",
    "Semiring",
    "Ring",
    "EuclideanRing",
    "Functor",
    "Apply",
    "Applicative",
    "Monad",
    "Bind",
    "Foldable",
    "Show",
    "From",
    "Into",
    "TryFrom",
    "Default",
    "Bounded",
    "Enum",
    "Alternative",
    "Bifunctor",
    "Contravariant",
    "Traversable",
    "Category",
    "Profunctor",
  ]);
  assert_equals(runtime_ducks, []);
  assert_equals(functional_fixities, [
    ["$", "apply"],
    ["|>", "pipe"],
    ["<$>", "Functor.map"],
    ["<*>", "Applicative.apply"],
    [">>=", "Monad.bind"],
    ["<|>", "Alternative.or_else"],
    ["<>", "Semigroup.append"],
    ["|||", "bit_or"],
    ["^^^", "bit_xor"],
    ["&&&", "bit_and"],
    ["<<", "shift_left"],
    [">>", "shift_right_unsigned"],
  ]);
  assert_equals(runtime_fixities, []);
  assert_equals(effects, [
    "State",
    "Reader",
    "Writer",
    "Raise",
    "Clock",
    "Random",
    "Console",
    "Environment",
    "Resource",
    "Log",
    "Validation",
    "Async",
    "Channel",
    "Mutex",
    "Semaphore",
    "TaskGroup",
    "Stm",
  ]);
  assert_equals(
    (effects_source.declarations || []).flatMap((declaration) => {
      if (declaration.tag === "effect") {
        return [declaration.params];
      }

      return [];
    }),
    [
      ["value"],
      ["environment"],
      ["output"],
      ["error"],
      [],
      [],
      [],
      ["value"],
      ["resource"],
      ["message"],
      ["error"],
      ["task", "result"],
      ["value"],
      ["value"],
      [],
      ["task"],
      ["value"],
    ],
  );
});

Deno.test("effect defaults export a complete source handler set", () => {
  const source = Source.parse(ducklang_effect_defaults_prelude_text);
  const final = source.statements[source.statements.length - 1];

  if (final?.tag !== "return" || final.value.tag !== "struct_value") {
    throw new Error("Missing effect defaults export record");
  }

  assert_equals(final.value.fields.map((field) => field.name), [
    "default_state",
    "default_reader",
    "handle_writer",
    "handle_raise",
    "deterministic_clock",
    "handle_random",
    "handle_console",
    "handle_environment",
    "handle_resource",
    "handle_log",
    "handle_validation",
    "handle_async",
    "handle_channel",
    "single_slot_channel",
    "handle_mutex",
    "sequential_mutex",
    "handle_semaphore",
    "counting_semaphore",
    "handle_task_group",
    "handle_stm",
  ]);
});

Deno.test("source default State and Reader handlers compose", async () => {
  const wat = Source.wat(`
const { default_state, default_reader } = comptime import "duck:prelude/effects/defaults" ()
let run = () => {
  environment <- Reader.ask()
  _ <- State.put(environment + 2)
  value <- State.get()
  value
}
try (try run() with default_state(0)) with default_reader(40)
`);
  const instance = await instantiate_wat(
    wat,
    "effect_defaults_state_reader",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for State and Reader defaults");
  }

  assert_equals(main(), 42);
});

Deno.test("deterministic effect defaults retain local state", async () => {
  const wat = Source.wat(`
const { deterministic_clock, single_slot_channel } = comptime import "duck:prelude/effects/defaults" ()
let run = () => {
  first <- Clock.wall_time_ms()
  _ <- Channel.send(20)
  value <- Channel.receive()
  second <- Clock.wall_time_ms()
  @unsafe_i32_wrap_i64(first + second) + value
}
try (try run() with deterministic_clock(10i64, 2i64)) with single_slot_channel(0)
`);
  const instance = await instantiate_wat(
    wat,
    "effect_defaults_deterministic",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for deterministic defaults");
  }

  assert_equals(main(), 42);
});

Deno.test("effect adapters receive explicit authority functions", async () => {
  const wat = Source.wat(`
const { handle_environment } = comptime import "duck:prelude/effects/defaults" ()
const lookup = name => 40
let run = () => {
  value <- Environment.lookup("answer")
  value + 2
}
try run() with handle_environment(lookup)
`);
  const instance = await instantiate_wat(wat, "effect_defaults_authority", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for effect adapter authority");
  }

  assert_equals(main(), 42);
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

Deno.test("named State instances keep independent identities and value types", async () => {
  const wat = Source.wat(`
const _ = comptime import "duck:prelude/effects" ()
const counter = State I32
const message = State Text
let run = () => {
  before <- counter.get()
  text <- message.get()
  _ <- counter.put(before + 1)
  _ <- message.put(@append(text, "!"))
  after <- message.get()
  before + @len(after)
}
let counter_handler = {
  let counter_value = 40
  counter {
    get: (!resume) => !resume(counter_value),
    put: (value, !resume) => {
      counter_value = value
      !resume(())
    },
    return: value => value,
  }
}
let message_handler = {
  let message_value = "a"
  message {
    get: (!resume) => !resume(message_value),
    put: (value, !resume) => {
      message_value = value
      !resume(())
    },
    return: value => value,
  }
}
try (try run() with counter_handler) with message_handler
`);
  const instance = await instantiate_wat(wat, "named_state_instances", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for named State instances");
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
