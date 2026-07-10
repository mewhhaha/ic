import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

const suspended_source = `
const suspended_type = union {
  suspended: Resume,
  done: I32
}

effect Suspend {
  pause: () => I32
}

let Fx run = () => {
  let (!Fx, value) = Fx.Suspend.pause()
  value + 1
}

let suspend = Suspend {
  pause: (!resume) => suspended_type.suspended(!resume),
  return: value => suspended_type.done(value),
}

let suspended: suspended_type = try run() with suspend
if let .suspended(resume) = suspended {
  let completed: suspended_type = !resume(41)
  if let .done(value) = completed { value } else { 0 }
} else {
  0
}
`;

const direct_resume_source = `
effect Ask {
  ask: () => I32
}

let Fx run = () => {
  let (!Fx, value) = Fx.Ask.ask()
  value + 1
}

let ask = Ask {
  ask: (!resume) => !resume(41),
  return: value => value,
}

try run() with ask
`;

const duplicated_scalar_state_source = `
effect Counter {
  fork: () => Unit
  add: (I32) => Unit
  get: () => I32
}

let Fx run = () => {
  let (!Fx, ()) = Fx.Counter.fork()
  let (!Fx, ()) = Fx.Counter.add(1)
  let (!Fx, value) = Fx.Counter.get()
  value
}

let counter = {
  let state = 0
  Counter {
    fork: (!resume) => {
      let (!left, !right) = dup !resume
      let first = !left(())
      let second = !right(())
      first * 10 + second
    },
    add: (amount, !resume) => {
      state = state + amount
      !resume(())
    },
    get: (!resume) => !resume(state),
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

Deno.test("a resumption can leave try in a union and resume later", async () => {
  assert_equals(await run_i32(suspended_source), 42);
});

Deno.test("checked resumption dup copies scalar handler state", async () => {
  assert_equals(await run_i32(duplicated_scalar_state_source), 11);
});

Deno.test("a resumption cannot be invoked twice", () => {
  assert_throws(
    () =>
      Source.core(`
effect Ask { ask: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Ask.ask()
  value
}
let ask = Ask {
  ask: (!resume) => {
    let first = !resume(1)
    !resume(first + 1)
  },
  return: value => value,
}
try run() with ask
`),
    "Resumption resume was already consumed",
  );
});

Deno.test("handler state is unavailable after its resumption is consumed", () => {
  assert_throws(
    () =>
      Source.core(`
effect Counter { get: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  value
}
let counter = {
  let state = 41
  Counter {
    get: (!resume) => {
      let output = !resume(state)
      output + state
    },
    return: value => value,
  }
}
try run() with counter
`),
    "Handler state state is unavailable after consuming its resumption",
  );
});

Deno.test("checked resumption dup rejects unique handler captures", () => {
  assert_throws(
    () =>
      Source.core(`
effect Fork { fork: () => Unit }
let Fx run = () => {
  let (!Fx, ()) = Fx.Fork.fork()
  0
}
let fork = {
  let owner = (value: I32) => value
  Fork {
    fork: (!resume) => {
      let (!left, !right) = dup !resume
      !left(()) + !right(())
    },
    return: value => value,
  }
}
try run() with fork
`),
    "Cannot duplicate resumption resume: capture owner is unique",
  );
});

Deno.test("an immediate local resumption stays direct and import-free", () => {
  const direct_wat = Source.wat(direct_resume_source);

  assert_equals(direct_wat.includes("call_indirect"), false);
  assert_equals(direct_wat.includes("(table $__closure_table"), false);
  assert_equals(direct_wat.includes("(global $__closure_heap"), false);
  assert_equals(direct_wat.includes("call $__alloc"), false);
  assert_equals(direct_wat.includes("(memory $memory"), false);
  assert_equals(direct_wat.includes("__ix_effect_Ask_ask"), false);
  assert_equals(
    direct_wat.includes('(import "ix_effect" "Ask.ask"'),
    false,
  );
});

Deno.test("an escaped resumption allocates and dispatches indirectly", () => {
  const suspended_wat = Source.wat(suspended_source);

  assert_includes(suspended_wat, "call_indirect");
  assert_includes(suspended_wat, "(table $__closure_table");
  assert_includes(suspended_wat, "(global $__closure_heap");
  assert_includes(suspended_wat, "call $__alloc");
  assert_equals(suspended_wat.includes("__ix_effect_Suspend_pause"), false);
  assert_equals(
    suspended_wat.includes('(import "ix_effect" "Suspend.pause"'),
    false,
  );
});

Deno.test("an abandoned resumption drops its union frame and closure", () => {
  const wat = Source.wat(`
const suspended_type = union {
  suspended: Resume,
  done: I32
}
effect Suspend { pause: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Suspend.pause()
  value
}
let suspend = Suspend {
  pause: (!resume) => suspended_type.suspended(!resume),
  return: value => suspended_type.done(value),
}
let suspended: suspended_type = try run() with suspend
0
`);

  assert_includes(wat, "call $__alloc");
  assert_includes(wat, "call $__free");
});
