import { assert_equals, assert_throws } from "../assert.ts";
import { analyze_front_effects } from "./effect_analysis.ts";
import { parse_source } from "./parser.ts";

Deno.test("effect analysis infers direct and forwarded operation rows", () => {
  const source = parse_source(`
module (!init: Init) where
declare effect Io {
  read: () => Text
  print: (bounded_borrow Text) => Unit
}
declare Init { io: Io }

let Fx read_name = () => {
  let (!Fx, name) = Fx.read()
  name
}

let App greet = () => {
  let name = read_name()
  let (!App, ()) = App.print(borrow name)
}

greet()
return {}
`);

  assert_equals(analyze_front_effects(source), {
    module_effects: [
      { effect: "Io", operation: "print" },
      { effect: "Io", operation: "read" },
    ],
    functions: {
      read_name: {
        name: "read_name",
        context: "Fx",
        effects: [{ effect: "Io", operation: "read" }],
        annotated: false,
      },
      greet: {
        name: "greet",
        context: "App",
        effects: [
          { effect: "Io", operation: "print" },
          { effect: "Io", operation: "read" },
        ],
        annotated: false,
      },
    },
  });
});

Deno.test("effect analysis enforces annotations and pure functions", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect Io { read: () => Text, print: (Text) => Unit }
let (Fx :: { Io.read }) bad = () => {
  let (!Fx, ()) = Fx.print("hello")
}
bad
`)),
    "does not allow Io.print",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect Io { read: () => Text }
let Fx read_name = () => {
  let (!Fx, name) = Fx.read()
  name
}
let pure = () => read_name()
pure
`)),
    "Pure function pure calls effects",
  );
});

Deno.test("effect analysis requires qualified operations on collisions", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect File { read: () => Text }
declare effect Io { read: () => Text }
let Fx read = () => {
  let (!Fx, value) = Fx.read()
  value
}
read
`)),
    "Ambiguous effect operation read",
  );

  const qualified = analyze_front_effects(parse_source(`
declare effect File { read: () => Text }
declare effect Io { read: () => Text }
let Fx read = () => {
  let (!Fx, value) = Fx.Io.read()
  value
}
read
`));
  assert_equals(qualified.functions.read?.effects, [
    { effect: "Io", operation: "read" },
  ]);
});

Deno.test("effect analysis discharges Ix operations through handler factories", () => {
  const analysis = analyze_front_effects(parse_source(`
effect Counter { get: () => I32, add: (I32) => Unit }

let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  let (!Fx, ()) = Fx.Counter.add(1)
  value
}

let counter = () => {
  let count = 0
  Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: (value) => value
  }
}

try run() with counter()
`));

  assert_equals(analysis.module_effects, []);
  assert_equals(analysis.functions.run?.effects, [
    { effect: "Counter", operation: "add" },
    { effect: "Counter", operation: "get" },
  ]);
});

Deno.test("effect analysis forwards partial handlers and keeps clauses deep", () => {
  const analysis = analyze_front_effects(parse_source(`
effect Counter { get: () => I32, add: (I32) => Unit }

let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  let (!Fx, ()) = Fx.Counter.add(value)
}

let Fx inner = () => Counter {
    get: (!resume) => {
      let (!Fx, ()) = Fx.Counter.add(1)
      !resume(0)
    },
    return: (value) => value
}

let outer = () => Counter {
    add: (amount, !resume) => !resume(()),
    return: (value) => value
}

try (try run() with inner()) with outer()
`));

  assert_equals(analysis.module_effects, []);
  assert_equals(analysis.functions.inner?.effects, []);

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32, add: (I32) => Unit }
let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  let (!Fx, ()) = Fx.Counter.add(value)
}
let Fx inner = () => Counter {
    get: (!resume) => {
      let (!Fx, ()) = Fx.Counter.add(1)
      !resume(0)
    },
    return: (value) => value
}
try run() with inner()
`)),
    "Unresolved Ix effect at module boundary: Counter.add",
  );
});

Deno.test("effect analysis exposes handler clause host dependencies", () => {
  const analysis = analyze_front_effects(parse_source(`
declare effect Io { print: (Text) => Unit }
effect Counter { get: () => I32 }

let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  value
}

let (Fx :: { Io.print }) counter = () => Counter {
    get: (!resume) => {
      let (!Fx, ()) = Fx.Io.print("get")
      !resume(0)
    },
    return: (value) => value
}

try run() with counter()
`));

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "print" },
  ]);

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect Io { read: () => Text, print: (Text) => Unit }
effect Counter { get: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  value
}
let (Fx :: { Io.read }) counter = () => Counter {
    get: (!resume) => {
      let (!Fx, ()) = Fx.Io.print("get")
      !resume(0)
    },
    return: (value) => value
}
try run() with counter()
`)),
    "on handler Counter does not allow Io.print",
  );
});

Deno.test("effect analysis rejects invalid handler declarations", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect Io { read: () => I32 }
Io {
    read: (!resume) => !resume(0),
    return: (value) => value
}
`)),
    "Cannot handle host-declared effect: Io",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
Counter {
    missing: (!resume) => !resume(0),
    return: (value) => value
}
`)),
    "Unknown handler clause: Counter.missing",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
Counter {
    get: (!resume) => !resume(0),
    get: (!again) => !again(1),
    return: (value) => value
}
`)),
    "Duplicate handler clause: Counter.get",
  );
});

Deno.test("effect analysis enforces pure stable handler state", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
declare effect Io { read: () => I32 }
effect Counter { get: () => I32 }
let Fx read = () => {
  let (!Fx, value) = Fx.Io.read()
  value
}
let Fx counter = () => {
  let count = read()
  Counter {
    get: (!resume) => !resume(count),
    return: (value) => value
  }
}
counter
`)),
    "Handler state initializer must be pure: count; calls Io.read",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
{
  let count = 0
  Counter {
    get: (!resume) => {
      count := "one"
      !resume(0)
    },
    return: (value) => value
  }
}
`)),
    "Handler state cannot change type with := count",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
{
  let count = 0
  Counter {
    get: (!resume) => {
      count = "one"
      !resume(0)
    },
    return: value => value,
  }
}
`)),
    "Handler state count expects I32, got Text",
  );
});

Deno.test("effect analysis checks resumption input types", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => !resume("wrong"),
  return: value => value,
}
`)),
    "Resumption resume expects I32, got Text",
  );

  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
Counter {
  get: (!resume) => "wrong output",
  return: value => 0,
}
`)),
    "Handler clause Counter.get returns Text, expected I32",
  );
});

Deno.test("effect analysis rejects unresolved Ix operations at the root", () => {
  assert_throws(
    () =>
      analyze_front_effects(parse_source(`
effect Counter { get: () => I32 }
let Fx run = () => {
  let (!Fx, value) = Fx.Counter.get()
  value
}
run()
`)),
    "Unresolved Ix effect at module boundary: Counter.get",
  );
});
