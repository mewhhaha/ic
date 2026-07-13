import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";

Deno.test("effect rows parse, format, and preserve bind syntax", () => {
  const source = Source.parse(`
declare effect Io {
  read: () => Text
  print: (Text) => Unit
}

let run: () -> <Io | (Io & Io.read) \\ Io.print> Text = () => {
  value <- Io.read()
  _ <- Io.print(value)
  value
}

result <- run()
result
`);
  const binding = source.statements[0];

  if (!binding || binding.tag !== "bind") {
    throw new Error("Expected an effectful function binding");
  }

  if (!binding.type_annotation || binding.type_annotation.tag !== "arrow") {
    throw new Error("Expected an annotated function type");
  }

  assert_equals(binding.type_annotation.effects, {
    tag: "union",
    left: { tag: "family", name: "Io" },
    right: {
      tag: "difference",
      left: {
        tag: "group",
        value: {
          tag: "intersection",
          left: { tag: "family", name: "Io" },
          right: { tag: "operation", effect: "Io", operation: "read" },
        },
      },
      right: { tag: "operation", effect: "Io", operation: "print" },
    },
  });

  const formatted = Source.fmt(source);
  assert_includes(
    formatted,
    "run: () -> <Io | (Io & Io.read) \\ Io.print> Text",
  );
  assert_includes(formatted, "value <- Io.read()");
  assert_includes(formatted, "_ <- Io.print(value)");
  assert_includes(formatted, "result <- run()");
  assert_equals(Source.parse(formatted), source);
});

Deno.test("effect row union, intersection, and difference normalize as sets", () => {
  const analysis = Source.effects(`
declare effect Io {
  read: () => I32
  print: (I32) => Unit
}

let intersection: () -> <Io & Io.read> I32 = () => {
  value <- Io.read()
  value
}

let difference: () -> <Io \\ Io.print> I32 = () => {
  value <- Io.read()
  value
}

let combined: () -> <Io.read | Io.print> I32 = () => {
  value <- Io.read()
  _ <- Io.print(value)
  value
}
`);

  assert_equals(analysis.functions.intersection?.effects, [
    { effect: "Io", operation: "read" },
  ]);
  assert_equals(analysis.functions.difference?.effects, [
    { effect: "Io", operation: "read" },
  ]);
  assert_equals(analysis.functions.combined?.effects, [
    { effect: "Io", operation: "print" },
    { effect: "Io", operation: "read" },
  ]);
});

Deno.test("effect rows reject braced list literals", () => {
  assert_throws(
    () =>
      Source.parse(`
declare effect Io { read: () => I32 }
let invalid: () -> <{ Io.read }> I32 = () => 0
`),
    "Expected effect row member",
  );
});

Deno.test("legacy effect binding syntax is rejected", () => {
  assert_throws(
    () => Source.parse("let Fx run = () => 0"),
    "Legacy effect contexts are not supported",
  );
  assert_throws(
    () => Source.parse("let (Fx :: Io.read) run = () => 0"),
    "Legacy effect contexts are not supported",
  );
  assert_throws(
    () => Source.parse("let (!Fx, value) = Fx.read()"),
    "Legacy effect state bindings are not supported",
  );
  assert_throws(
    () => Source.parse("let value <- Io.read()"),
    "Do not prefix an effect bind with `let`",
  );
  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }
value <- Fx.read()
value
`),
    "Effect bind must call a declared effect operation",
  );
});

Deno.test("disjoint effect intersection is an explicit empty row", () => {
  assert_throws(
    () =>
      Source.effects(`
declare effect Stdin { read: () => I32 }
declare effect Stdout { write: (I32) => Unit }

let invalid: () -> <Stdin & Stdout> I32 = () => {
  value <- Stdin.read()
  value
}
`),
    "does not allow Stdin.read",
  );
});

Deno.test("effect rows validate every operand before applying set algebra", () => {
  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }
let invalid: () -> <Io | (Missing \\ Missing)> I32 = () => 0
`),
    "Unknown declared effect: Missing",
  );
});

Deno.test("effect bind distinguishes effectful and pure computations", () => {
  assert_throws(
    () =>
      Source.effects(`
let pure = () => 1
value <- pure()
value
`),
    "requires an effectful computation",
  );

  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }
let read = () => {
  value <- Io.read()
  value
}
let value = read()
value
`),
    "Effectful binding value must use `<-`",
  );

  const analysis = Source.effects(`
declare effect Io { read: () => I32 }
let read = () => {
  value <- Io.read()
  value
}
value <- read()
value
`);
  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);
});

Deno.test("discarded direct effects may discard results", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }
_ <- Io.read()
`);
  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);

  const function_analysis = Source.effects(`
declare effect Io { read: () => I32 }
let read = () => {
  value <- Io.read()
  value
}
_ <- read()
`);
  assert_equals(function_analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);

  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read_resume: () => Resume }
let read_resume: () -> <Io.read_resume> Resume = () => {
  value <- Io.read_resume()
  value
}
_ <- read_resume()
`),
    "Discarding an effectful function result requires an explicit cleanup path",
  );

  const unit_analysis = Source.effects(`
declare effect Io { print: () => Unit }
let write: () -> <Io.print> Unit = () => {
  _ <- Io.print()
}
_ <- Io.print()
_ <- write()
`);

  assert_equals(unit_analysis.module_effects, [
    { effect: "Io", operation: "print" },
  ]);
});

Deno.test("discarded immediately invoked lambdas can infer Unit", () => {
  const analysis = Source.effects(`
declare effect Io { print: () => Unit }
_ <- (() => {
  _ <- Io.print()
})()
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "print" },
  ]);
});

Deno.test("discarded callback calls use their typed Unit result", () => {
  const analysis = Source.effects(`
declare effect Io { print: () => Unit }
let apply: (() -> <e> Unit) -> <e> Unit = (const callback) => {
  _ <- callback()
}
_ <- apply(() => {
  _ <- Io.print()
})
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "print" },
  ]);
});

Deno.test("inline callback annotations survive unannotated function calls", () => {
  const analysis = Source.effects(`
declare effect Io { print: () => Unit }
let apply = (const callback: () -> <Io.print> Unit) => {
  _ <- callback()
}
_ <- apply(() => {
  _ <- Io.print()
})
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "print" },
  ]);
});

Deno.test("function types check and infer latent effect rows", () => {
  const analysis = Source.effects(`
declare effect Io {
  read: () => I32
  print: (I32) => Unit
}

let echo: () -> <Io> I32 = () => {
  value <- Io.read()
  _ <- Io.print(value)
  value
}

result <- echo()
result
`);

  assert_equals(analysis.functions.echo, {
    name: "echo",
    effects: [
      { effect: "Io", operation: "print" },
      { effect: "Io", operation: "read" },
    ],
    annotated: true,
  });

  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }
let bad: () -> I32 = () => {
  value <- Io.read()
  value
}
bad
`),
    "Function type on bad does not allow Io.read",
  );

  assert_throws(
    () =>
      Source.effects(`
let bad: (I32, I32) -> I32 = value => value
bad
`),
    "Function type on bad expects 2 parameters, got 1",
  );

  assert_throws(
    () =>
      Source.effects(`
let bad: I32 -> Text = value => value + 1
bad
`),
    "Function type on bad returns Text, got I32",
  );
});

Deno.test("typed effect functions distinguish Bool is results from I32", () => {
  assert_throws(
    () =>
      Source.effects(`
let bad: () -> I32 = () => 1 is Int
bad
`),
    "Function type on bad returns I32, got Bool",
  );

  Source.effects(`
let valid: () -> Bool = () => 1 is Int
valid
`);
});

Deno.test("typed latent host effects erase before Core lowering", () => {
  Source.core(`
module (!init: Init) where

declare effect Stdin { read: () => I32 }
declare Init { stdin: Stdin }

let read: () -> <Stdin> I32 = () => {
  value <- Stdin.read()
  value
}

let forward = () => {
  value <- read()
  value
}

result <- forward()
return { result }
`);
});

Deno.test("higher-order row variables follow anonymous callback effects", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

result <- apply(value => {
  input <- Io.read()
  input + value
}, 1)
result
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);

  Source.core(`
module (!init: Init) where

declare effect Io { read: () => I32 }
declare Init { io: Io }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

value <- apply(item => {
  input <- Io.read()
  input + item
}, 1)
let result: I32 = value
return { result }
`);

  const pure = Source.effects(`
let apply: (I32 -> <e> I32, I32) -> <e> I32 = (callback, value) => {
  result <- callback(value)
  result
}

let result = apply(value => value + 1, 1)
result
`);
  assert_equals(pure.module_effects, []);

  assert_throws(
    () =>
      Source.effects(`
let bad: (I32 -> <e> I32, I32 -> <f> I32, I32) -> <e> I32 =
  (first, second, value) => {
    result <- second(value)
    result
  }
bad
`),
    "Function type on bad does not expose callback row variable f",
  );
});

Deno.test("higher-order row variables forward through generic wrappers", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

let forward: (I32 -> <f> I32, I32) -> <f> I32 =
  (const callback, value) => {
    result <- apply(callback, value)
    result
  }

result <- forward(value => {
  input <- Io.read()
  input + value
}, 1)
result
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);
});

Deno.test("effectful named callback values fail before Core lowering", () => {
  assert_throws(
    () =>
      Source.core(`
module (!init: Init) where

declare effect Io { read: () => I32 }
declare Init { io: Io }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

let read: I32 -> <Io.read> I32 = value => {
  input <- Io.read()
  input + value
}

result <- apply(read, 1)
return { result }
`),
    "Effectful named function read cannot be used as a value yet",
  );
});

Deno.test("anonymous callback wrappers retain symbolic effect rows", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }

let apply: (I32 -> <e> I32, I32) -> <e> I32 = (const callback, value) => {
  result <- callback(value)
  result
}

let wrapper: (I32 -> <f> I32, I32) -> <f> I32 =
  (const callback, value) => {
    result <- apply(item => callback(item), value)
    result
  }

result <- wrapper(value => {
  input <- Io.read()
  input + value
}, 1)
result
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);

  assert_throws(
    () =>
      Source.effects(`
let apply: (I32 -> <e> I32, I32) -> <e> I32 = (callback, value) => {
  result <- callback(value)
  result
}

let wrapper: (I32 -> <f> I32, I32) -> <f> I32 = (callback, value) => {
  let result = apply(item => callback(item), value)
  result
}
wrapper
`),
    "Effectful binding result must use `<-`",
  );
});

Deno.test("plain callback arrows reject latent effects", () => {
  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }

let apply: (I32 -> I32, I32) -> I32 = (callback, value) => {
  let result = callback(value)
  result
}

let result = apply(value => {
  input <- Io.read()
  input + value
}, 1)
result
`),
    "exceeds its pure callback type",
  );
});

Deno.test("unused callback rows do not make closure creation effectful", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }

let ignore: (I32 -> <e> I32, I32) -> I32 = (callback, value) => value

let result = ignore(value => {
  input <- Io.read()
  input + value
}, 1)
result
`);

  assert_equals(analysis.module_effects, []);
});

Deno.test("lambda parameter function types participate in effect inference", () => {
  const analysis = Source.effects(`
declare effect Io { read: () => I32 }

let apply = (callback: I32 -> <Io.read> I32, value: I32) => {
  result <- callback(value)
  result
}

result <- apply(value => {
  input <- Io.read()
  input + value
}, 1)
result
`);

  assert_equals(analysis.module_effects, [
    { effect: "Io", operation: "read" },
  ]);

  Source.core(`
module (!init: Init) where

declare effect Io { read: () => I32 }
declare Init { io: Io }

let apply = (callback: I32 -> <Io.read> I32, value: I32) => {
  result <- callback(value)
  result
}

value <- apply(item => {
  input <- Io.read()
  input + item
}, 1)
let result: I32 = value
return { result }
`);
});

Deno.test("typed effectful aliases fail during effect analysis", () => {
  assert_throws(
    () =>
      Source.effects(`
declare effect Io { read: () => I32 }

let read: () -> <Io.read> I32 = () => {
  value <- Io.read()
  value
}

let alias: () -> <Io.read> I32 = read
result <- alias()
result
`),
    "Typed function alias alias is not supported yet",
  );
});
