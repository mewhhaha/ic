import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { format_source } from "./format.ts";
import { load_source } from "./load.ts";
import { parse_source } from "./parser.ts";

Deno.test("module syntax parses effects, rows, state, and exports", () => {
  const source = parse_source(`
module (!init: Init) where

declare effect Io {
  print: (&Text) => Unit
  read: () => Text
}

declare Init {
  io: Io
}

let read_name = () => {
  name <- Io.read()
  name
}

let greet: () -> <Io.read | Io.print> Unit = () => {
  _ <- Io.print("hello")
}

const { a, b } = dependency(init)
return { a, message: b }
`);

  assert_equals(source.module, {
    params: [{
      name: "init",
      is_const: false,
      is_linear: true,
      annotation: "Init",
    }],
  });
  assert_equals(source.declarations, [
    {
      tag: "effect",
      implementation: "host",
      name: "Io",
      operations: [
        {
          name: "print",
          params: [{ type_name: "Text", ownership: "bounded_borrow" }],
          result: { type_name: "Unit", ownership: "scalar" },
        },
        {
          name: "read",
          params: [],
          result: { type_name: "Text", ownership: "unique_heap" },
        },
      ],
    },
    {
      tag: "record",
      name: "Init",
      fields: [{ name: "io", type_name: "Io" }],
    },
  ]);

  const first = source.statements[0];
  if (!first || first.tag !== "bind") {
    throw new Error("Expected read_name binding");
  }
  assert_equals(first.type_annotation, undefined);

  const second = source.statements[1];
  if (!second || second.tag !== "bind") {
    throw new Error("Expected greet binding");
  }
  assert_equals(second.type_annotation, {
    tag: "arrow",
    param: { tag: "product", entries: [] },
    effects: {
      tag: "union",
      left: { tag: "operation", effect: "Io", operation: "read" },
      right: { tag: "operation", effect: "Io", operation: "print" },
    },
    result: { tag: "name", name: "Unit" },
  });

  const formatted = format_source(source);
  assert_includes(formatted, "module (!init: Init) where");
  assert_includes(formatted, "declare effect Io");
  assert_includes(formatted, '_ <- Io.print "hello"');
  assert_includes(formatted, "const { a, b } = dependency init");
  assert_includes(formatted, "return { a, message: b }");
});

Deno.test("no-demand binders parse as distinct internal names and format as underscores", () => {
  const source = parse_source(`
let _ = 1
const _ = 2
let pair = (_, const _) => 0
let count = rec (_, const _) => 0
let selected = if let .ok(_) = result { 1 } else { 0 }
let (_, value) = source
`);

  const names: string[] = [];

  for (const statement of source.statements) {
    if (statement.tag === "bind") {
      names.push(statement.name);

      if (statement.value.tag === "lam" || statement.value.tag === "rec") {
        for (const param of statement.value.params) {
          names.push(param.name);
        }
      }

      if (statement.value.tag === "if_let" && statement.value.value_name) {
        names.push(statement.value.value_name);
      }
    }

    if (statement.tag === "bind_pattern") {
      for (const item of statement.items) {
        names.push(item.name);
      }
    }
  }

  const no_demand = names.filter((name) => name.startsWith("@no_demand_"));
  assert_equals(no_demand.length, 4);
  assert_equals(new Set(no_demand).size, no_demand.length);

  const formatted = format_source(source);
  assert_includes(formatted, "let _ = 1");
  assert_includes(formatted, "const _ = 2");
  assert_includes(formatted, "let pair = (_, const _) => 0");
  assert_includes(formatted, "let count = rec (_, const _) => 0");
  assert_includes(formatted, "if let .ok(_) = result");
  assert_includes(formatted, "let (_, value) = source");
});

Deno.test("no-demand binders cannot be used as linear values or expressions", () => {
  assert_throws(
    () => parse_source("let !_ = 1"),
    "`!_` is not supported",
  );
  assert_throws(
    () => parse_source("let take = (!_ ) => 0"),
    "`!_` is not supported",
  );
  assert_throws(
    () => parse_source("let (!_) = source"),
    "Legacy effect state bindings are not supported; use `value <- Effect.operation()`",
  );
  assert_throws(
    () => parse_source("_"),
    "Wildcard `_` cannot be used as an expression",
  );
  assert_throws(
    () => parse_source("!_"),
    "`!_` is not supported",
  );
});

Deno.test("value loops and binderless ranges parse and format", () => {
  const source = parse_source(`
let code = loop {
  for 0..2 {
    ()
  }
  if ready {
    break 7
  }
  continue
}
`);
  const statement = source.statements[0];

  if (
    !statement || statement.tag !== "bind" || statement.value.tag !== "loop"
  ) {
    throw new Error("Expected a loop binding");
  }

  const range = statement.value.body[0];
  assert_equals(range?.tag, "for_range");

  if (!range || range.tag !== "for_range") {
    throw new Error("Expected a binderless range");
  }

  assert_equals(range.index.startsWith("@no_demand_"), true);
  assert_equals(range.start, { tag: "num", type: "i32", value: 0 });
  assert_equals(range.end, { tag: "num", type: "i32", value: 2 });

  const formatted = format_source(source);
  assert_includes(formatted, "let code = loop");
  assert_includes(formatted, "for 0..2 by 1");
  assert_includes(formatted, "break 7");
  assert_includes(formatted, "continue");
});

Deno.test("handler syntax parses and formats local effects and resumptions", () => {
  const source = parse_source(`
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let counter = {
  let state: I32 = 0
  Counter {
    get: (!resume) => !resume(state),
    add: (amount, !resume) => {
      state = state + amount
      !resume(())
    },
    return: value => { value, state },
  }
}

let make = () => Counter {
  get: (!resume) => !resume(0),
  return: value => value,
}

let result = try run() with counter
let (!left, !right) = dup !resume
result
`);

  assert_equals(source.declarations?.[0], {
    tag: "effect",
    implementation: "ix",
    name: "Counter",
    operations: [
      {
        name: "get",
        params: [],
        result: { type_name: "I32", ownership: "scalar" },
      },
      {
        name: "add",
        params: [{ type_name: "I32", ownership: "scalar" }],
        result: { type_name: "Unit", ownership: "scalar" },
      },
    ],
  });

  const binding = source.statements[0];
  assert_equals(
    binding && binding.tag === "bind" ? binding.value.tag : undefined,
    "handler",
  );

  if (!binding || binding.tag !== "bind" || binding.value.tag !== "handler") {
    throw new Error("Expected handler binding");
  }

  assert_equals(binding.value.state, [{
    name: "state",
    annotation: "I32",
    value: { tag: "num", type: "i32", value: 0 },
  }]);
  assert_equals(binding.value.clauses[0]?.params[0]?.is_linear, true);
  assert_equals(binding.value.clauses[1]?.body.tag, "block");
  assert_equals(binding.value.return_clause.param.name, "value");

  const handled = source.statements[1];
  assert_equals(
    handled && handled.tag === "bind" ? handled.value.tag : undefined,
    "lam",
  );

  if (!handled || handled.tag !== "bind" || handled.value.tag !== "lam") {
    throw new Error("Expected stateless handler factory");
  }

  assert_equals(handled.value.body.tag, "handler");

  if (handled.value.body.tag !== "handler") {
    throw new Error("Expected stateless handler literal");
  }

  assert_equals(handled.value.body.effect, "Counter");
  assert_equals(handled.value.body.state, []);

  const result_binding = source.statements[2];
  assert_equals(
    result_binding && result_binding.tag === "bind"
      ? result_binding.value
      : undefined,
    {
      tag: "try_with",
      body: {
        tag: "app",
        func: { tag: "var", name: "run" },
        arg: { tag: "unit" },
        args: [],
      },
      handler: { tag: "var", name: "counter" },
    },
  );
  assert_equals(source.statements[3], {
    tag: "resume_dup",
    left: "left",
    right: "right",
    value: { tag: "linear", name: "resume" },
  });

  const formatted = format_source(source);
  assert_includes(formatted, "effect Counter");
  assert_includes(formatted, "Counter { get: (!resume) => !resume state");
  assert_includes(formatted, "return: value => { value, state }");
  assert_includes(formatted, "let make = () => Counter {");
  assert_includes(formatted, "!resume ()");
  assert_includes(formatted, "try run () with counter");
  assert_includes(formatted, "let (!left, !right) = dup !resume");
  assert_equals(parse_source(formatted), source);
});

Deno.test("handler syntax distinguishes resume calls from boolean not", () => {
  const resume = parse_source("!resume(1)").statements[0];
  assert_equals(resume, {
    tag: "expr",
    expr: {
      tag: "app",
      func: { tag: "linear", name: "resume" },
      arg: { tag: "num", type: "i32", value: 1 },
      args: [{ tag: "num", type: "i32", value: 1 }],
    },
  });

  const negated = parse_source("!(resume(1))").statements[0];
  assert_equals(
    negated && negated.tag === "expr" ? negated.expr.tag : undefined,
    "if",
  );
  assert_equals(parse_source("()").statements[0], {
    tag: "expr",
    expr: { tag: "unit" },
  });
});

Deno.test("handler syntax requires a final return clause", () => {
  assert_throws(
    () =>
      parse_source(`
effect Counter { get: () => I32 }
let counter = Counter {
  get: (!resume) => !resume(0)
}
counter
`),
    "Handler requires a return clause",
  );
});

Deno.test("handler keyword spelling is rejected", () => {
  assert_throws(
    () =>
      parse_source(`
effect Counter { get: () => I32 }
let counter = handler Counter {
  return { get: (!resume) => !resume(0) }
}
counter
`),
    "Effect handlers use `Effect { ... }` literals",
  );
});

Deno.test("fragment parsing stays header-free", () => {
  assert_equals(parse_source("40 + 2"), {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: {
        tag: "prim",
        prim: "i32.add",
        left: { tag: "num", type: "i32", value: 40 },
        right: { tag: "num", type: "i32", value: 2 },
      },
    }],
  });
});

Deno.test("file loading requires a module header and record return", () => {
  const dir = Deno.makeTempDirSync();

  try {
    const fragment = dir + "/fragment.ix";
    Deno.writeTextFileSync(fragment, "42\n");
    assert_throws(
      () => load_source(fragment),
      "File module must begin with `module (...) where`",
    );

    const missing_return = dir + "/missing_return.ix";
    Deno.writeTextFileSync(missing_return, "module () where\n42\n");
    assert_throws(
      () => load_source(missing_return),
      "File module must end with `return { ... }`",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("module imports bind dependency initializers", () => {
  const dir = Deno.makeTempDirSync();

  try {
    Deno.writeTextFileSync(
      dir + "/dependency.ix",
      "module (value: I32) where\nreturn { value }\n",
    );
    Deno.writeTextFileSync(
      dir + "/main.ix",
      'module () where\nconst dependency = import "./dependency.ix"\n' +
        "const { value } = dependency(42)\nreturn { value }\n",
    );

    const loaded = load_source(dir + "/main.ix");
    const dependency = loaded.statements[0];
    assert_equals(dependency && dependency.tag === "bind", true);

    if (!dependency || dependency.tag !== "bind") {
      throw new Error("Expected loaded dependency binding");
    }

    assert_equals(dependency.name, "dependency");
    assert_equals(dependency.value.tag, "lam");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
