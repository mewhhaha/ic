import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

const counter_source = `
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let Fx run = () => {
  let (!Fx, ()) = Fx.Counter.add(2)
  let (!Fx, value) = Fx.Counter.get()
  value
}

let counter = {
  let count = 0
  Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => value,
  }
}

try run() with counter
`;

async function run_i32(source: string): Promise<number> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(Source.wat(source)));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }

  const instance = await WebAssembly.instantiate(output.stdout);
  const main = instance.instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  return Number(main());
}

Deno.test("Ix handler elaboration lowers a deep scalar counter", () => {
  const core = Source.core(counter_source);
  assert_equals(
    core.statements.some((stmt) => stmt.tag === "unsupported"),
    false,
  );
  const wat = Source.wat(counter_source);
  assert_includes(wat, "i32.add");
});

Deno.test("Ix handler elaboration runs a deep scalar counter", async () => {
  assert_equals(await run_i32(counter_source), 2);
});

Deno.test("Ix handler clauses can abort without resuming", async () => {
  assert_equals(
    await run_i32(`
effect Stop { stop: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Stop.stop()
  value + 100
}
let stop = Stop {
    stop: (!resume) => 41,
    return: value => value,
}
try run() with stop
`),
    41,
  );
});

Deno.test("Ix handler clauses can post-process a resumed result", async () => {
  assert_equals(
    await run_i32(`
effect Ask { ask: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Ask.ask()
  value + 1
}
let ask = Ask {
    ask: (!resume) => !resume(4) + 10,
    return: value => value,
}
try run() with ask
`),
    15,
  );
});

Deno.test("partial Ix handlers forward to an outer handler", async () => {
  assert_equals(
    await run_i32(`
effect Pair {
  left: () => I32
  right: () => I32
}
let Fx run = () => {
  let (!Fx, left) = Fx.Pair.left()
  let (!Fx, right) = Fx.Pair.right()
  left + right
}
let outer = Pair {
    left: (!resume) => !resume(10),
    right: (!resume) => !resume(20),
    return: value => value,
}
let inner = Pair {
    left: (!resume) => !resume(1),
    return: value => value,
}
try (try run() with inner) with outer
`),
    21,
  );
});

Deno.test("resuming reinstalls nested captured handlers", async () => {
  assert_equals(
    await run_i32(`
effect Outer { enter: () => I32 }
effect Inner { read: () => I32 }
let Fx run = () => {
  let (!Fx, outer) = Fx.Outer.enter()
  let (!Fx, inner) = Fx.Inner.read()
  outer + inner
}
let outer = Outer {
    enter: (!resume) => !resume(7),
    return: value => value,
}
let inner = Inner {
    read: (!resume) => !resume(5),
    return: value => value,
}
try (try run() with inner) with outer
`),
    12,
  );
});

Deno.test("handler clauses forward same-effect calls with inactive delimiters", async () => {
  assert_equals(
    await run_i32(`
effect Ask { ask: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Ask.ask()
  value
}
let outer = Ask {
  ask: (!resume) => !resume(10),
  return: value => value + 100,
}
let Fx inner = () => Ask {
  ask: (!resume) => {
    let (!Fx, value) = Fx.Ask.ask()
    !resume(value + 1)
  },
  return: value => value + 10,
}
try (try run() with inner()) with outer
`),
    121,
  );
});

Deno.test("Ix handler elaboration rejects consuming one handler twice", () => {
  assert_throws(
    () =>
      Source.core(`
effect Ask { ask: () => I32 }
let Fx ask = () => {
  let (!Fx, value) = Fx.Ask.ask()
  value
}
let h = Ask {
    ask: (!resume) => !resume(1),
    return: value => value,
}
let first = try ask() with h
let second = try ask() with h
first + second
`),
    "Handler h was already consumed",
  );
});
