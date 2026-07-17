import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("effect parameters parse and format as lexical type parameters", () => {
  const source = Source.parse(`
effect State value {
  get: () => value
  put: (value) => Unit
}
0
`);
  const declaration = source.declarations?.[0];

  if (declaration === undefined || declaration.tag !== "effect") {
    throw new Error("Missing State effect declaration");
  }

  assert_equals(declaration.params, ["value"]);
  assert_equals(
    Source.fmt(source),
    "effect State value { get: () => value, put: (value) => Unit }\n0",
  );
});

Deno.test("effect parameters specialize from operation arguments", () => {
  const analysis = Source.effects(`
effect Writer output { tell: (output) => Unit }
let write = () => {
  _ <- Writer.tell(42)
}
0
`);

  assert_equals(analysis.functions.write?.effects, [{
    effect: "Writer",
    operation: "tell",
  }]);
});

Deno.test("effect parameters reject incompatible specializations", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Writer output { tell: (output) => Unit }
let write = () => {
  _ <- Writer.tell(42)
  _ <- Writer.tell("forty-two")
}
0
`),
    "Effect Writer parameter output is used as both I32 and Text",
  );
});

Deno.test("used effect parameters must resolve before effect analysis", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Reader environment { ask: () => environment }
let read = () => {
  _ <- Reader.ask()
}
0
`),
    "Cannot infer effect Reader parameter environment",
  );
});

Deno.test("host effect declarations keep concrete ABI signatures", () => {
  assert_throws(
    () => Source.parse("declare effect Input value { read: () => value }\n0"),
    "Host effects require concrete ABI types",
  );
});

Deno.test("effect parameters specialize scalar ownership for lowering", () => {
  const wat = Source.wat(`
effect State value {
  get: () => value
  put: (value) => Unit
}
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
try run() with state
`);

  assert_includes(wat, "i32.add");
});

Deno.test("named effect instances distinguish equal payload types", () => {
  const analysis = Source.effects(`
effect State value {
  get: () => value
  put: (value) => Unit
}
const left = State I32
const right = State I32
let run = () => {
  _ <- left.put(1)
  _ <- right.put(2)
}
0
`);

  assert_equals(analysis.functions.run?.effects, [
    { effect: "left", operation: "put" },
    { effect: "right", operation: "put" },
  ]);
});

Deno.test("named effect instances require const bindings", () => {
  assert_throws(
    () =>
      Source.wat(`
effect State value { get: () => value }
let counter = State I32
let run = () => {
  value <- counter.get()
  value
}
run()
`),
    "Effect instance counter must use a const binding",
  );
});

Deno.test("parameterless effects support named instances", () => {
  const analysis = Source.effects(`
effect Clock { now: () => I64 }
const wall_clock = Clock ()
let run = () => {
  time <- wall_clock.now()
  time
}
0
`);

  assert_equals(analysis.functions.run?.effects, [
    { effect: "wall_clock", operation: "now" },
  ]);
});

Deno.test("named effects accept multiple concrete type arguments", () => {
  const analysis = Source.effects(`
const _ = comptime import "duck:prelude/effects" ()
const jobs = Async [I32, I64]
let run = () => {
  task <- jobs.spawn(42)
  result <- jobs.await(task)
  result
}
0
`);

  assert_equals(analysis.functions.run?.effects, [
    { effect: "jobs", operation: "await" },
    { effect: "jobs", operation: "spawn" },
  ]);
});
