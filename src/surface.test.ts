import { assertEquals, assertIncludes, assertThrows } from "./assert.ts";
import { Expr } from "./expr.ts";
import { Ic } from "./ic.ts";
import { Mod } from "./mod.ts";
import {
  Surface,
  type Surface as SurfaceNode,
  Term,
  type Term as TermNode,
} from "./surface.ts";

function i32(value: number): TermNode {
  return { tag: "num", type: "i32", value };
}

function var_(name: string): TermNode {
  return { tag: "var", name };
}

function add(left: TermNode, right: TermNode): TermNode {
  return { tag: "prim", prim: "i32.add", args: [left, right] };
}

Deno.test("Term.emit lowers single-use let through APP-LAM", () => {
  const term: TermNode = {
    tag: "let",
    name: "x",
    value: i32(41),
    body: add(var_("x"), i32(1)),
  };

  assertEquals(
    Ic.reduce(Term.emit(term)),
    { tag: "num", type: "i32", value: 42 },
  );
});

Deno.test("Term.emit inserts erasure for unused let values", () => {
  const term: TermNode = {
    tag: "let",
    name: "x",
    value: i32(1),
    body: i32(42),
  };

  assertEquals(Term.emit(term), {
    tag: "era",
    expr: i32(1),
    body: i32(42),
  });
});

Deno.test("Term.emit inserts duplication for repeated let uses", () => {
  const term: TermNode = {
    tag: "let",
    name: "x",
    value: i32(21),
    body: add(var_("x"), var_("x")),
  };

  assertEquals(
    Expr.fmt(Ic.emit(Term.emit(term))),
    "let _v0:i32 = 21:i32;\n(_v0:i32 +:i32 _v0:i32)",
  );
});

Deno.test("Term.emit inserts erasure for unused lambda parameters", () => {
  const term: TermNode = {
    tag: "lam",
    name: "x",
    body: i32(42),
  };

  assertEquals(Term.emit(term), {
    tag: "lam",
    name: "x",
    body: {
      tag: "era",
      expr: { tag: "var", name: "x" },
      body: i32(42),
    },
  });
});

Deno.test("Term.emit inserts duplication for repeated lambda parameters", () => {
  const term: TermNode = {
    tag: "app",
    func: {
      tag: "lam",
      name: "x",
      body: add(var_("x"), var_("x")),
    },
    arg: i32(21),
  };

  assertEquals(
    Expr.fmt(Ic.emit(Term.emit(term))),
    "let _v0:i32 = 21:i32;\n(_v0:i32 +:i32 _v0:i32)",
  );
});

Deno.test("Term.emit rejects unbound source variables", () => {
  assertThrows(() => Term.emit(var_("x")), "Unbound source variable: x");
});

Deno.test("Surface.emit builds an executable module and exports values", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "let", name: "answer", value: i32(42), exported: true },
      { tag: "expr", value: add(var_("answer"), i32(1)) },
    ],
  };

  const mod = Surface.emit(surface);
  const wat = Mod.emit(mod);

  assertIncludes(wat, '(export "answer" (func $answer))');
  assertIncludes(wat, '(export "main" (func $main))');
  assertIncludes(wat, "i32.const 43");
});

Deno.test("Surface.emit erases earlier top-level expressions before main", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "expr", value: i32(1) },
      { tag: "expr", value: i32(42) },
    ],
  };

  const mod = Surface.emit(surface);
  const wat = Mod.emit(mod);

  assertIncludes(wat, "i32.const 42");
});

Deno.test("Surface.emit supports named expression exports", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "expr", value: i32(7), exportedAs: "seven" },
      { tag: "expr", value: i32(42) },
    ],
  };

  const wat = Mod.emit(Surface.emit(surface));

  assertIncludes(wat, '(export "seven" (func $seven))');
  assertIncludes(wat, '(export "main" (func $main))');
});

Deno.test("Surface.emit rejects duplicate top-level bindings", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "let", name: "x", value: i32(1) },
      { tag: "let", name: "x", value: i32(2) },
      { tag: "expr", value: i32(42) },
    ],
  };

  assertThrows(() => Surface.emit(surface), "Duplicate top-level binding: x");
});
