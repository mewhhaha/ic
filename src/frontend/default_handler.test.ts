import { assert_equals, assert_throws } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { format_source } from "./format.ts";
import { parse_source } from "./parser.ts";
import { Source } from "./source.ts";

Deno.test("try without with formats as an inferred handler boundary", () => {
  const source = parse_source("try run()\n");
  const statement = source.statements[0];

  if (statement?.tag !== "expr" || statement.expr.tag !== "try_with") {
    throw new Error("Expected implicit try expression");
  }

  assert_equals(statement.expr.infer_default_handlers, true);
  assert_equals(format_source(source), "try run ()");
});

Deno.test("try infers and orders several source default handlers", async () => {
  const source = `
const _ = import "duck:prelude/effects" ()

effect First {
  get: () => I32
}

effect Second {
  get: () => I32
}

const first = () => First {
  get: (!resume) => !resume(20),
  return: value => value,
}

extend First {
  type Handled = First
  .make = _ => first()
  .output = _ => Identity
  .order = _ => 10
}

const second = () => Second {
  get: (!resume) => !resume(22),
  return: value => value,
}

extend Second {
  type Handled = Second
  .make = _ => second()
  .output = _ => Identity
  .order = _ => 20
}

let run: () -> <First :| Second> I32 = () => {
  left <- First.get()
  right <- Second.get()
  left + right
}

try run()
`;
  const wat = Source.wat(source);
  assert_equals(Source.analyze(source, { route: "core" }).diagnostics, []);
  const instance = await instantiate_wat(wat, "inferred_default_handlers", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function");
  }

  assert_equals(main(), 42);
  assert_equals(Source.effects(source).module_effects, []);
});

Deno.test("try reports a missing default handler", () => {
  assert_throws(
    () =>
      Source.wat(`
effect Counter {
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value
}

try run()
`),
    "No default handler is in scope for effect Counter",
  );
});

Deno.test("generic Do default resolves List through Monad", () => {
  Source.core(`
const {} = import "duck:prelude/effects/defaults" ()
type IntList = List I32

let run = (wrapped: IntList) => {
  _ <- do wrapped
  42
}

let empty: IntList = \`Nil ()
let result: IntList = try run(empty)
0
`);
});

Deno.test("exact affine Option default overrides generic Do", async () => {
  const wat = Source.wat(`
const { option_unwrap_or } = import "duck:prelude/functional" ()
const {} = import "duck:prelude/effects/defaults" ()

type IntOption = Option I32

let run = () => {
  let wrapped: IntOption = \`Some 42
  value <- do wrapped
  value
}

let result: IntOption = try run()
option_unwrap_or(7, result)
`);
  const instance = await instantiate_wat(wat, "exact_do_default", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function for exact Option Do default");
  }

  assert_equals(main(), 42);
});

Deno.test("generic Do reports a missing Monad instance", () => {
  assert_throws(
    () =>
      Source.core(`
const {} = import "duck:prelude/effects/defaults" ()
type Box value = \`Box value
type IntBox = Box I32

let run = (wrapped: IntBox) => {
  value <- do wrapped
  value
}

let input: IntBox = \`Box 42
let result: IntBox = try run(input)
0
`),
    "Missing duck satisfaction for Monad.bind at Box",
  );
});

Deno.test("try rejects ambiguous defaults for one effect", () => {
  assert_throws(
    () =>
      Source.wat(`
const _ = import "duck:prelude/effects" ()

effect Counter {
  get: () => I32
}

type OtherCounterDefault = newtype Unit

const first = () => Counter {
  get: (!resume) => !resume(20),
  return: value => value,
}

extend Counter {
  type Handled = Counter
  .make = _ => first()
  .output = _ => Identity
  .order = _ => 10
}

const second = () => Counter {
  get: (!resume) => !resume(22),
  return: value => value,
}

extend OtherCounterDefault {
  type Handled = Counter
  .make = _ => second()
  .output = _ => Identity
  .order = _ => 20
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value
}

try run()
`),
    "More than one default handler is in scope for effect Counter: Counter, OtherCounterDefault",
  );
});

Deno.test("try rejects equal ordering for different defaults", () => {
  assert_throws(
    () =>
      Source.wat(`
const _ = import "duck:prelude/effects" ()

effect First {
  get: () => I32
}

effect Second {
  get: () => I32
}

const first = () => First {
  get: (!resume) => !resume(20),
  return: value => value,
}

extend First {
  type Handled = First
  .make = _ => first()
  .output = _ => Identity
  .order = _ => 10
}

const second = () => Second {
  get: (!resume) => !resume(22),
  return: value => value,
}

extend Second {
  type Handled = Second
  .make = _ => second()
  .output = _ => Identity
  .order = _ => 10
}

let run: () -> <First :| Second> I32 = () => {
  left <- First.get()
  right <- Second.get()
  left + right
}

try run()
`),
    "Default handlers First and Second use the same order 10",
  );
});
