import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

const counter_source = `
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(2)
  value <- Counter.get()
  value
};

let counter = {
  let count = 0;
  handler Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => value,
  }
};

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

Deno.test("Duck handler elaboration lowers a deep scalar counter", () => {
  const core = Source.core(counter_source);
  assert_equals(
    core.statements.some((stmt) => stmt.tag === "unsupported"),
    false,
  );
  const wat = Source.wat(counter_source);
  assert_includes(wat, "i32.add");
});

Deno.test("Duck handler elaboration runs a deep scalar counter", async () => {
  assert_equals(await run_i32(counter_source), 2);
});

Deno.test("locally handled effects resume through runtime range loops", async () => {
  assert_equals(
    await run_i32(`
effect Counter {
  add: (I32) => Unit
}
let run = (count: I32) => {
  for index in 0..count {
    _ <- Counter.add(index)
  }
  0
};
let counter = {
  let count = 0;
  handler Counter {
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: _ => count,
  }
};
try run(5) with counter
`),
    10,
  );
});

Deno.test("an aborting loop handler skips the recursive continuation", async () => {
  assert_equals(
    await run_i32(`
effect Stop {
  stop: (I32) => Unit
}
let run: () -> <Stop> I32 = () => {
  let index = 0;

  loop {
    if index == 3 {
      _ <- Stop.stop(index)
    }

    index = index + 1
  }

  99
};
let stop = handler Stop {
  stop: (value, !resume) => value,
  return: value => value,
};
try run() with stop
`),
    3,
  );
});

Deno.test("Duck handler elaboration lowers an inferred nested effect function", async () => {
  assert_equals(
    await run_i32(`
effect Counter { get: () => I32 }
let run = () => {
  let offset = 40;
  let read = () => {
    value <- Counter.get()
    value + offset
  };
  read()
};
let counter = handler Counter {
  get: (!resume) => !resume(2),
  return: value => value,
};
try run() with counter
`),
    42,
  );
});

Deno.test("Duck handler elaboration lowers a typed nested effect function", async () => {
  assert_equals(
    await run_i32(`
effect Counter { get: () => I32 }
let run = () => {
  let read: () -> <Counter> I32 = () => {
    value <- Counter.get()
    value + 1
  };
  read()
};
let counter = handler Counter {
  get: (!resume) => !resume(41),
  return: value => value,
};
try run() with counter
`),
    42,
  );
});

Deno.test("a pure nested function shadows an outer Duck function", async () => {
  assert_equals(
    await run_i32(`
effect Counter { get: () => I32 }
let read = () => {
  value <- Counter.get()
  value
};
let run = () => {
  let read = () => 40;
  value <- Counter.get()
  read() + value
};
let counter = handler Counter {
  get: (!resume) => !resume(2),
  return: value => value,
};
try run() with counter
`),
    42,
  );
});

Deno.test("a nested Duck function can transitively shadow an outer Duck function", async () => {
  assert_equals(
    await run_i32(`
effect Counter { get: () => I32 }
let read = () => {
  value <- Counter.get()
  value
};
let helper = () => {
  value <- Counter.get()
  value
};
let run = () => {
  let read = () => {
    value <- helper();
    value
  };
  read()
};
let counter = handler Counter {
  get: (!resume) => !resume(42),
  return: value => value,
};
try run() with counter
`),
    42,
  );
});

Deno.test("Duck handler clauses can abort without resuming", async () => {
  assert_equals(
    await run_i32(`
effect Stop { stop: () => I32 }
let run = () => {
  value <- Stop.stop()
  value + 100
};
let stop = handler Stop {
    stop: (!resume) => 41,
    return: value => value,
};
try run() with stop
`),
    41,
  );
});

Deno.test("Duck handler clauses can post-process a resumed result", async () => {
  assert_equals(
    await run_i32(`
effect Ask { ask: () => I32 }
let run = () => {
  value <- Ask.ask()
  value + 1
};
let ask = handler Ask {
    ask: (!resume) => !resume(4) + 10,
    return: value => value,
};
try run() with ask
`),
    15,
  );
});

Deno.test("partial Duck handlers forward to an outer handler", async () => {
  assert_equals(
    await run_i32(`
effect Pair {
  left: () => I32
  right: () => I32
}
let run = () => {
  left <- Pair.left()
  right <- Pair.right()
  left + right
};
let outer = handler Pair {
    left: (!resume) => !resume(10),
    right: (!resume) => !resume(20),
    return: value => value,
};
let inner = handler Pair {
    left: (!resume) => !resume(1),
    return: value => value,
};
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
let run = () => {
  outer <- Outer.enter()
  inner <- Inner.read()
  outer + inner
};
let outer = handler Outer {
    enter: (!resume) => !resume(7),
    return: value => value,
};
let inner = handler Inner {
    read: (!resume) => !resume(5),
    return: value => value,
};
try (try run() with inner) with outer
`),
    12,
  );
});

Deno.test("handler clauses forward same-effect calls with inactive delimiters", async () => {
  assert_equals(
    await run_i32(`
effect Ask { ask: () => I32 }
let run = () => {
  value <- Ask.ask()
  value
};
let outer = handler Ask {
  ask: (!resume) => !resume(10),
  return: value => value + 100,
};
let inner = () => handler Ask {
  ask: (!resume) => {
    value <- Ask.ask()
    !resume(value + 1)
  },
  return: value => value + 10,
};
try (try run() with inner()) with outer
`),
    121,
  );
});

Deno.test("Duck handler elaboration rejects consuming one handler twice", () => {
  assert_throws(
    () =>
      Source.core(`
effect Ask { ask: () => I32 }
let ask = () => {
  value <- Ask.ask()
  value
};
let h = handler Ask {
    ask: (!resume) => !resume(1),
    return: value => value,
};
let first = try ask() with h;
let second = try ask() with h;
first + second
`),
    "Handler h was already consumed",
  );
});
