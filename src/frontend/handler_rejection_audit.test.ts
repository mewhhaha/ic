import { build_abi_manifest } from "../abi.ts";
import { assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("handler clauses match operation signatures", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Counter { add: (I32) => Unit }
Counter {
  add: (!resume) => !resume(()),
  return: value => value,
}
`),
    "Handler clause Counter.add expects 2 parameters, got 1",
  );

  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
Counter {
  get: (resume) => resume(0),
  return: value => value,
}
`),
    "Handler clause Counter.get requires a final affine resumption parameter",
  );

  assert_throws(
    () =>
      Source.parse(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => !resume(0),
  return: () => 0,
}
`),
    "Handler return clause must accept exactly one parameter",
  );
});

Deno.test("resumptions and effect operations enforce call arity", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => !resume(),
  return: value => value,
}
`),
    "Resumption resume expects exactly one argument",
  );

  assert_throws(
    () =>
      Source.core(`
effect Counter { add: (I32) => Unit }
let run = () => {
  _ <- Counter.add()
}
let counter = Counter {
  add: (amount, !resume) => !resume(()),
  return: value => value,
}
try run() with counter
`),
    "Effect operation argument count mismatch: Counter.add",
  );
});

Deno.test("handler state bindings have distinct persistent slots", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
{
  let state = 0
  let state = 1
  Counter {
    get: (!resume) => !resume(state),
    return: value => value,
  }
}
`),
    "Duplicate handler state binding: state",
  );
});

Deno.test("managed ABI rejects Resume nested in an aggregate", () => {
  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
const continuation_box = struct { continuation: Resume }
const ix_entry_result_type = continuation_box
0
`)),
    "Managed ABI cannot expose Resume values",
  );
});

Deno.test("handler annotations and rich result types are checked early", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Counter { add: (I32) => Unit }
Counter {
  add: (amount: Text, !resume) => !resume(()),
  return: value => value,
}
`),
    "Handler clause parameter amount expects I32, got Text",
  );

  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume: Text) => !resume(0),
  return: value => value,
}
`),
    "Handler resumption parameter resume expects Resume, got Text",
  );

  assert_throws(
    () =>
      Source.effects(`
const wanted = struct { x: I32 }
const other = struct { y: I32 }
effect Read { read: () => wanted }
Read {
  read: (!resume) => !resume(other { y: 1 }),
  return: value => value,
}
`),
    "Resumption resume expects wanted, got other",
  );

  assert_throws(
    () =>
      Source.effects(`
const outcome = union { suspended: Resume, done: I32 }
effect Suspend { pause: () => I32 }
Suspend {
  pause: (!resume) => outcome.suspended(!resume),
  return: (value: I32) => value,
}
`),
    "Handler clause Suspend.pause returns outcome, expected I32",
  );
});

Deno.test("handler checks distinguish Bool is results from I32", () => {
  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => !resume(1 is Int),
  return: value => value,
}
`),
    "Resumption resume expects I32, got Bool",
  );

  assert_throws(
    () =>
      Source.effects(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => 1 is Int,
  return: (value: I32) => value,
}
`),
    "Handler clause Counter.get returns Bool, expected I32",
  );

  Source.effects(`
effect Counter { get: () => Bool }
Counter {
  get: (!resume) => !resume(1 is Int),
  return: (value: Bool) => value,
}
`);
});
