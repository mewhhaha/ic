import { assertEquals, assertIncludes, assertThrows } from "./assert.ts";
import { Expr, type Expr as ExprNode } from "./expr.ts";

function num(value: number): ExprNode {
  return { tag: "num", type: "i32", value };
}

function num64(value: bigint): ExprNode {
  return { tag: "num", type: "i64", value };
}

function var_(name: string): ExprNode {
  return { tag: "var", type: "i32", name };
}

function add(left: ExprNode, right: ExprNode): ExprNode {
  return { tag: "prim", type: "i32", prim: "i32.add", args: [left, right] };
}

Deno.test("Expr.type returns let body type", () => {
  const expr: ExprNode = {
    tag: "let",
    name: "x",
    value: num64(1n),
    body: add(num(1), num(2)),
  };

  assertEquals(Expr(expr).type(), "i32");
});

Deno.test("Expr.fmt formats typed primitive expressions", () => {
  assertEquals(Expr(add(num(1), num(2))).fmt(), "(1:i32 +:i32 2:i32)");
});

Deno.test("Expr.emit emits typed primitive instructions", () => {
  assertEquals(
    Expr(add(num(1), num(2))).emit(),
    "i32.const 1\ni32.const 2\ni32.add",
  );
});

Deno.test("Expr.emit emits i64 primitive instructions", () => {
  const expr: ExprNode = {
    tag: "prim",
    type: "i64",
    prim: "i64.mul",
    args: [num64(3n), num64(7n)],
  };

  assertEquals(Expr(expr).emit(), "i64.const 3\ni64.const 7\ni64.mul");
});

Deno.test("Expr.emit emits let locals before the body", () => {
  const expr: ExprNode = {
    tag: "let",
    name: "x",
    value: num(41),
    body: add(var_("x"), num(1)),
  };

  assertEquals(
    Expr(expr).emit(),
    "(local $x i32)\ni32.const 41\nlocal.set $x\nlocal.get $x\ni32.const 1\ni32.add",
  );
});

Deno.test("Expr.emit rejects unbound variables", () => {
  assertThrows(() => Expr(var_("x")).emit(), "Unbound variable: x");
});

Deno.test("Expr.emit rejects local type mismatches", () => {
  const expr: ExprNode = {
    tag: "let",
    name: "x",
    value: num(1),
    body: { tag: "var", type: "i64", name: "x" },
  };

  assertThrows(() => Expr(expr).emit(), "Local $x is i32, got i64");
});

Deno.test("Expr.emit rejects primitive operand type mismatches", () => {
  const expr: ExprNode = {
    tag: "prim",
    type: "i32",
    prim: "i32.add",
    args: [num(1), num64(2n)],
  };

  assertThrows(() => Expr(expr).emit(), "Expected i32, got i64");
});

Deno.test("Expr.fmt rejects primitive arity mismatches", () => {
  const expr: ExprNode = {
    tag: "prim",
    type: "i32",
    prim: "i32.add",
    args: [num(1)],
  };

  assertThrows(() => Expr(expr).fmt(), "Primitive i32.add expects 2 arguments");
});

Deno.test("Expr.emit output can be matched by instruction snippets", () => {
  const emitted = Expr(add(num(10), num(20))).emit();

  assertIncludes(emitted, "i32.const 10");
  assertIncludes(emitted, "i32.add");
});
