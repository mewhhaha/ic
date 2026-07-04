import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { Expr } from "./expr.ts";
import { Ic, type Ic as IcNode } from "./ic.ts";
import { Data, Emit, Format, Reduce, Typed } from "./trait.ts";

function i32(value: number): IcNode {
  return { tag: "num", type: "i32", value };
}

function i64(value: bigint): IcNode {
  return { tag: "num", type: "i64", value };
}

function var_(name: string): IcNode {
  return { tag: "var", name };
}

function add(left: IcNode, right: IcNode): IcNode {
  return { tag: "prim", prim: "i32.add", args: [left, right] };
}

function sub(left: IcNode, right: IcNode): IcNode {
  return { tag: "prim", prim: "i32.sub", args: [left, right] };
}

function lt(left: IcNode, right: IcNode): IcNode {
  return { tag: "prim", prim: "i32.lt_s", args: [left, right] };
}

function le(left: IcNode, right: IcNode): IcNode {
  return { tag: "prim", prim: "i32.le_s", args: [left, right] };
}

function select(
  then_branch: IcNode,
  else_branch: IcNode,
  cond: IcNode,
): IcNode {
  return {
    tag: "prim",
    prim: "i32.select",
    args: [then_branch, else_branch, cond],
  };
}

function app(func: IcNode, arg: IcNode): IcNode {
  return { tag: "app", func, arg };
}

function id(name: string): IcNode {
  return { tag: "lam", name, body: var_(name) };
}

Deno.test("Ic.fmt formats dup and sup terms", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: { tag: "sup", label: "A", left: i32(1), right: i32(2) },
    body: add(var_("x0"), var_("x1")),
  };

  assert_equals(
    Format.fmt(Ic, program),
    "! x &A = &A{1:i32, 2:i32};\nx0 + x1",
  );
});

Deno.test("Ic.fmt formats explicit erasure", () => {
  const program: IcNode = {
    tag: "era",
    expr: i32(1),
    body: i32(2),
  };

  assert_equals(Format.fmt(Ic, program), "~ 1:i32;\n2:i32");
});

Deno.test("Ic.fmt formats text literals", () => {
  const program: IcNode = { tag: "text", value: "hello\nworld" };

  assert_equals(Format.fmt(Ic, program), '"hello\\nworld"');
  assert_equals(Ic.reduce(program), program);
});

Deno.test("Ic.validate checks affine use and labels", () => {
  const valid: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: var_("input"),
    body: add(var_("x0"), var_("x1")),
  };

  assert_equals(Ic.validate(valid).ok, true);
  Ic.assert_valid(valid);

  const repeated = add(var_("input"), var_("input"));
  const repeated_validation = Ic.validate(repeated);

  assert_equals(repeated_validation.ok, false);
  assert_throws(
    () => Ic.assert_valid(repeated),
    "Free variable used more than once: input",
  );

  assert_throws(
    () =>
      Ic.assert_valid({
        tag: "sup",
        label: "bad label",
        left: i32(1),
        right: i32(2),
      }),
    "Ic label cannot contain whitespace",
  );
});

Deno.test("Ic.reduce applies APP-LAM", () => {
  const program: IcNode = {
    tag: "app",
    func: id("x"),
    arg: i32(42),
  };

  assert_equals(Ic.reduce(program), i32(42));
  assert_equals(Reduce.reduce(Ic, undefined, program), i32(42));
});

Deno.test("Ic.reduce_debug returns stats and graph snapshots", () => {
  const program: IcNode = {
    tag: "app",
    func: { tag: "lam", name: "x", body: add(var_("x"), i32(1)) },
    arg: i32(41),
  };
  const debug = Ic.reduce_debug(program);

  assert_equals(debug.result, i32(42));
  assert_equals(debug.stats.app_lam, 1);
  assert_equals(debug.stats.prim_folds, 1);
  assert_equals(debug.snapshots.length, 2);

  const initial = debug.snapshots[0];

  if (!initial) {
    throw new Error("Missing initial graph snapshot");
  }

  if (!initial.text.includes(" = app(")) {
    throw new Error("Expected initial graph snapshot to include root app");
  }
});

Deno.test("Ic.reduce annihilates same-label DUP-SUP", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: { tag: "sup", label: "A", left: i32(40), right: i32(2) },
    body: add(var_("x0"), var_("x1")),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce commutes different-label DUP-SUP", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: { tag: "sup", label: "B", left: i32(40), right: i32(2) },
    body: {
      tag: "dup",
      label: "B",
      name: "y",
      expr: var_("x0"),
      body: add(var_("y0"), var_("y1")),
    },
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce applies APP-SUP and then same-label DUP-SUP", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "r",
    expr: {
      tag: "app",
      func: { tag: "sup", label: "A", left: id("x"), right: id("y") },
      arg: { tag: "sup", label: "A", left: i32(40), right: i32(2) },
    },
    body: add(var_("r0"), var_("r1")),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce applies DUP-LAM", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "r",
    expr: {
      tag: "dup",
      label: "A",
      name: "f",
      expr: id("x"),
      body: {
        tag: "sup",
        label: "A",
        left: { tag: "app", func: var_("f0"), arg: i32(40) },
        right: { tag: "app", func: var_("f1"), arg: i32(2) },
      },
    },
    body: add(var_("r0"), var_("r1")),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce copies duplicated literals", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: i32(21),
    body: add(var_("x0"), var_("x1")),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce removes one-sided duplications", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: var_("input"),
    body: add(var_("x1"), i32(1)),
  };

  assert_equals(
    Format.fmt(Ic, Ic.reduce(program)),
    "input + 1:i32",
  );
});

Deno.test("Ic.reduce propagates primitive calls over superpositions", () => {
  const program: IcNode = {
    tag: "dup",
    label: "A",
    name: "r",
    expr: {
      tag: "prim",
      prim: "i32.add",
      args: [
        { tag: "sup", label: "A", left: i32(1), right: i32(2) },
        { tag: "sup", label: "A", left: i32(10), right: i32(20) },
      ],
    },
    body: add(var_("r0"), var_("r1")),
  };

  assert_equals(Ic.reduce(program), i32(33));
});

Deno.test("Ic.reduce folds i32 primitives with wrapping", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.add",
    args: [i32(2147483647), i32(1)],
  };

  assert_equals(Ic.reduce(program), i32(-2147483648));

  assert_equals(
    Ic.reduce({
      tag: "prim",
      prim: "i32.div_s",
      args: [i32(17), i32(5)],
    }),
    i32(3),
  );

  assert_equals(
    Ic.reduce({
      tag: "prim",
      prim: "i32.rem_s",
      args: [i32(17), i32(5)],
    }),
    i32(2),
  );

  assert_throws(
    () =>
      Ic.reduce({
        tag: "prim",
        prim: "i32.div_s",
        args: [i32(1), i32(0)],
      }),
    "i32.div_s by zero",
  );
});

Deno.test("Ic.reduce folds i64 primitives with wrapping", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i64.mul",
    args: [i64(3n), i64(7n)],
  };

  assert_equals(Ic.reduce(program), i64(21n));

  assert_equals(
    Ic.reduce({
      tag: "prim",
      prim: "i64.rem_s",
      args: [i64(17n), i64(5n)],
    }),
    i64(2n),
  );
});

Deno.test("Ic.reduce folds comparison primitives to i32 booleans", () => {
  assert_equals(
    Ic.reduce({
      tag: "prim",
      prim: "i32.lt_s",
      args: [i32(3), i32(5)],
    }),
    i32(1),
  );

  assert_equals(
    Ic.reduce({
      tag: "prim",
      prim: "i64.ge_s",
      args: [i64(3n), i64(5n)],
    }),
    i32(0),
  );
});

Deno.test("Ic.reduce folds select when the condition is known", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [i32(42), i32(0), i32(1)],
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce does not reduce the unused known select branch", () => {
  const program = select(
    i32(42),
    { tag: "prim", prim: "i32.div_s", args: [i32(1), i32(0)] },
    i32(1),
  );

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce supports recursive fixpoints in the graph reducer", () => {
  const program: IcNode = {
    tag: "fix",
    name: "count",
    expr: {
      tag: "lam",
      name: "n",
      body: select(
        i32(0),
        add(app(var_("count"), sub(var_("n"), i32(1))), i32(1)),
        le(var_("n"), i32(0)),
      ),
    },
    body: app(var_("count"), i32(3)),
  };

  assert_equals(Ic.reduce(program), i32(3));
});

Deno.test("Ic.reduce supports naive recursive fib through fix", () => {
  const program: IcNode = {
    tag: "fix",
    name: "fib",
    expr: {
      tag: "lam",
      name: "n",
      body: select(
        var_("n"),
        add(
          app(var_("fib"), sub(var_("n"), i32(1))),
          app(var_("fib"), sub(var_("n"), i32(2))),
        ),
        lt(var_("n"), i32(2)),
      ),
    },
    body: app(var_("fib"), i32(6)),
  };

  assert_equals(Ic.reduce(program), i32(8));
});

Deno.test("Ic.reduce preserves select with a dynamic condition", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [i32(42), i32(0), var_("cond")],
  };

  assert_equals(
    Format.fmt(Ic, Ic.reduce(program)),
    "if cond then 42:i32 else 0:i32",
  );

  const wide: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [i64(42n), i64(0n), var_("cond")],
  };

  assert_equals(Ic.reduce(wide), {
    tag: "prim",
    prim: "i64.select",
    args: [i64(42n), i64(0n), var_("cond")],
  });
});

Deno.test("Ic.emit lowers dynamic select to structured Expr if", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [
      i32(42),
      { tag: "prim", prim: "i32.trap", args: [] },
      { tag: "prim", prim: "i32.load", args: [{ tag: "text", value: "" }] },
    ],
  };

  const expr = Emit.emit(Ic, program);

  assert_equals(Typed.type(Expr, expr), "i32");
  assert_equals(expr.tag, "if");
  assert_equals(
    Emit.emit(Expr, expr),
    [
      "i32.const 0",
      "i32.load",
      "if (result i32)",
      "  i32.const 42",
      "else",
      "  unreachable",
      "end",
    ].join("\n"),
  );
});

Deno.test("Ic.wat bridges open numeric terms to function params", () => {
  const wat = Ic.wat(add(var_("input"), i32(1)));

  if (!wat.includes("(func $main (param $input i32) (result i32)")) {
    throw new Error("Expected open Ic WAT to expose input param:\n" + wat);
  }

  if (!wat.includes("local.get $input")) {
    throw new Error("Expected open Ic WAT to read input param:\n" + wat);
  }

  const repeated = Ic.wat({
    tag: "dup",
    label: "A",
    name: "x",
    expr: var_("input"),
    body: add(var_("x0"), var_("x1")),
  });

  if (!repeated.includes("(param $input i32)")) {
    throw new Error(
      "Expected duplicated open input to be one param:\n" + repeated,
    );
  }

  assert_throws(
    () => Ic.wat(var_("input")),
    "Cannot infer open Ic variable type: input",
  );
});

Deno.test("Ic.wat lowers top-level recursive fixpoints to functions", () => {
  const fib_body = select(
    var_("n"),
    add(
      app(var_("fib"), sub(var_("n"), i32(1))),
      app(var_("fib"), sub(var_("n"), i32(2))),
    ),
    lt(var_("n"), i32(2)),
  );
  const program: IcNode = {
    tag: "fix",
    name: "fib",
    expr: { tag: "lam", name: "n", body: fib_body },
    body: app(var_("fib"), var_("input")),
  };
  const wat = Ic.wat(program);

  assert_includes(wat, "(func $fib (param $n i32) (result i32)");
  assert_includes(wat, "(func $main (param $input i32) (result i32)");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "call $fib");
});

Deno.test("Ic.reduce preserves trap primitives", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.trap",
    args: [],
  };

  assert_equals(Ic.reduce(program), program);
  assert_equals(Format.fmt(Ic, program), "trap");
});

Deno.test("Ic.reduce preserves memory load primitives", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.load",
    args: [{ tag: "text", value: "hello" }],
  };

  assert_equals(Ic.reduce(program), program);
  assert_equals(Format.fmt(Ic, program), 'load("hello")');
});

Deno.test("Ic.reduce propagates memory loads over superpositions", () => {
  const program: IcNode = {
    tag: "prim",
    prim: "i32.load",
    args: [
      {
        tag: "sup",
        label: "A",
        left: { tag: "text", value: "yes" },
        right: { tag: "text", value: "no" },
      },
    ],
  };

  assert_equals(
    Format.fmt(Ic, Ic.reduce(program)),
    '&A{load("yes"), load("no")}',
  );
});

Deno.test("Ic.reduce erases numbers and continues", () => {
  const program: IcNode = {
    tag: "era",
    expr: i32(1),
    body: i32(42),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce erases superpositions structurally", () => {
  const program: IcNode = {
    tag: "era",
    expr: { tag: "sup", label: "A", left: i32(1), right: i32(2) },
    body: i32(42),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce erases applications structurally", () => {
  const program: IcNode = {
    tag: "era",
    expr: {
      tag: "app",
      func: id("x"),
      arg: { tag: "sup", label: "A", left: i32(1), right: i32(2) },
    },
    body: i32(42),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.reduce erases duplicated values structurally", () => {
  const program: IcNode = {
    tag: "era",
    expr: {
      tag: "dup",
      label: "A",
      name: "x",
      expr: { tag: "sup", label: "A", left: i32(1), right: i32(2) },
      body: add(var_("x0"), var_("x1")),
    },
    body: i32(42),
  };

  assert_equals(Ic.reduce(program), i32(42));
});

Deno.test("Ic.emit rejects unreduced superpositions", () => {
  const program: IcNode = {
    tag: "sup",
    label: "A",
    left: i32(1),
    right: i32(2),
  };

  assert_throws(
    () => Emit.emit(Ic, program),
    "Cannot lower superposition before reduction",
  );
});

Deno.test("Ic.emit lowers text values to Expr text pointers", () => {
  const expr = Emit.emit(Ic, { tag: "text", value: "hello" });

  assert_equals(Typed.type(Expr, expr), "i32");
  assert_equals(Emit.emit(Expr, expr), "i32.const 0");
  assert_equals(Data.data(Expr, expr), [
    { offset: 0, bytes: [5, 0, 0, 0, 104, 101, 108, 108, 111] },
  ]);
});
