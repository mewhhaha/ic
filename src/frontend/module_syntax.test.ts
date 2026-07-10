import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { format_source } from "./format.ts";
import { load_source } from "./load.ts";
import { parse_source } from "./parser.ts";

Deno.test("module syntax parses effects, contexts, state, and exports", () => {
  const source = parse_source(`
module (!init: Init) where

declare effect Io {
  print: (bounded_borrow Text) => Unit
  read: () => Text
}

declare Init {
  io: Io
}

let Fx read_name = () => {
  let (!Fx, name) = Fx.read()
  name
}

let (Fx :: { Io.read, Io.print }) greet = () => {
  let (!Fx, ()) = Fx.print("hello")
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
  assert_equals(
    first && first.tag === "bind" ? first.effect_context : undefined,
    {
      name: "Fx",
      operations: undefined,
    },
  );

  const second = source.statements[1];
  assert_equals(
    second && second.tag === "bind" ? second.effect_context : undefined,
    {
      name: "Fx",
      operations: [
        { effect: "Io", operation: "read" },
        { effect: "Io", operation: "print" },
      ],
    },
  );

  const formatted = format_source(source);
  assert_includes(formatted, "module (!init: Init) where");
  assert_includes(formatted, "declare effect Io");
  assert_includes(formatted, 'let (!Fx, ()) = Fx.print("hello")');
  assert_includes(formatted, "const { a, b } = dependency(init)");
  assert_includes(formatted, "return { a, message: b }");
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
      body: { tag: "app", func: { tag: "var", name: "run" }, args: [] },
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
  assert_includes(formatted, "Counter { get: (!resume) => !resume(state)");
  assert_includes(formatted, "return: value => { value, state }");
  assert_includes(formatted, "let make = () => Counter {");
  assert_includes(formatted, "!resume(())");
  assert_includes(formatted, "try run() with counter");
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
      args: [{ tag: "num", type: "i32", value: 1 }],
    },
  });

  const negated = parse_source("!(resume(1))").statements[0];
  assert_equals(
    negated && negated.tag === "expr" ? negated.expr.tag : undefined,
    "prim",
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
      'module () where\nimport dependency from "./dependency.ix"\n' +
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
