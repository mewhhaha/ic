import { assertEquals, assertThrows } from "./assert.ts";
import { Expr } from "./expr.ts";
import { IC, type IC as ICNode } from "./ic.ts";

function i32(value: number): ICNode {
  return { tag: "num", type: "i32", value };
}

function i64(value: bigint): ICNode {
  return { tag: "num", type: "i64", value };
}

function var_(name: string): ICNode {
  return { tag: "var", name };
}

function add(left: ICNode, right: ICNode): ICNode {
  return { tag: "prim", prim: "i32.add", args: [left, right] };
}

function id(name: string): ICNode {
  return { tag: "lam", name, body: var_(name) };
}

Deno.test("IC.fmt formats dup and sup terms", () => {
  const program: ICNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: { tag: "sup", label: "A", left: i32(1), right: i32(2) },
    body: add(var_("x0"), var_("x1")),
  };

  assertEquals(
    IC.fmt(program),
    "! x &A = &A{1:i32, 2:i32};\nx0 + x1",
  );
});

Deno.test("IC.reduce applies APP-LAM", () => {
  const program: ICNode = {
    tag: "app",
    func: id("x"),
    arg: i32(42),
  };

  assertEquals(IC.reduce(program), i32(42));
});

Deno.test("IC.reduce annihilates same-label DUP-SUP", () => {
  const program: ICNode = {
    tag: "dup",
    label: "A",
    name: "x",
    expr: { tag: "sup", label: "A", left: i32(40), right: i32(2) },
    body: add(var_("x0"), var_("x1")),
  };

  assertEquals(IC.reduce(program), i32(42));
});

Deno.test("IC.reduce commutes different-label DUP-SUP enough to lower", () => {
  const program: ICNode = {
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

  const expr = IC.emit(program);

  assertEquals(
    Expr.fmt(expr),
    "let _a0:i32 = 40:i32;\nlet _b1:i32 = 2:i32;\n(_a0:i32 +:i32 _b1:i32)",
  );
});

Deno.test("IC.reduce applies APP-SUP and then same-label DUP-SUP", () => {
  const program: ICNode = {
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

  assertEquals(IC.reduce(program), i32(42));
});

Deno.test("IC.reduce applies DUP-LAM", () => {
  const program: ICNode = {
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

  assertEquals(IC.reduce(program), i32(42));
});

Deno.test("IC.reduce propagates primitive calls over superpositions", () => {
  const program: ICNode = {
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

  assertEquals(IC.reduce(program), i32(33));
});

Deno.test("IC.reduce folds i32 primitives with wrapping", () => {
  const program: ICNode = {
    tag: "prim",
    prim: "i32.add",
    args: [i32(2147483647), i32(1)],
  };

  assertEquals(IC.reduce(program), i32(-2147483648));
});

Deno.test("IC.reduce folds i64 primitives with wrapping", () => {
  const program: ICNode = {
    tag: "prim",
    prim: "i64.mul",
    args: [i64(3n), i64(7n)],
  };

  assertEquals(IC.reduce(program), i64(21n));
});

Deno.test("IC.emit rejects unreduced superpositions", () => {
  const program: ICNode = {
    tag: "sup",
    label: "A",
    left: i32(1),
    right: i32(2),
  };

  assertThrows(
    () => IC.emit(program),
    "Cannot lower superposition before reduction",
  );
});
