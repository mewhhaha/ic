import { build_abi_manifest } from "../abi.ts";
import { assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { resolve_bundled_source_imports } from "./load.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";

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
  get: (resume: I32) => resume(0),
  return: value => value,
}
`),
    "Handler resumption parameter resume expects Resume, got I32",
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
    "Resumption resume expects I32, got Unit",
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
      build_abi_manifest(elaborate_front_type_sets(
        resolve_bundled_source_imports(Source.parse(`
const { struct } = import "duck:prelude" ()
const continuation_box = struct { .continuation= Resume }
const duck_entry_result_type = continuation_box
0
`)),
      )),
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
const { struct } = import "duck:prelude" ()
const wanted = struct { .x= I32 }
effect Read { read: () => wanted }
Read {
  read: (!resume) => !resume("no"),
  return: value => value,
}
`),
    "Resumption resume expects wanted, got Text",
  );

  assert_throws(
    () =>
      Source.effects(`
type Outcome = | \`Suspended Resume | \`Done I32
const outcome = Outcome
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
