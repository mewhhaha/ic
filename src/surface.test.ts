import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
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

  assert_equals(
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

  assert_equals(Term.emit(term), {
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

  assert_equals(Term.emit(term), {
    tag: "dup",
    label: "S0",
    name: "_v0",
    expr: i32(21),
    body: {
      tag: "prim",
      prim: "i32.add",
      args: [
        { tag: "var", name: "_v00" },
        { tag: "var", name: "_v01" },
      ],
    },
  });
});

Deno.test("Term.emit inserts erasure for unused lambda parameters", () => {
  const term: TermNode = {
    tag: "lam",
    name: "x",
    body: i32(42),
  };

  assert_equals(Term.emit(term), {
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

  assert_equals(Term.emit(term), {
    tag: "app",
    func: {
      tag: "lam",
      name: "x",
      body: {
        tag: "dup",
        label: "S0",
        name: "_v0",
        expr: { tag: "var", name: "x" },
        body: {
          tag: "prim",
          prim: "i32.add",
          args: [
            { tag: "var", name: "_v00" },
            { tag: "var", name: "_v01" },
          ],
        },
      },
    },
    arg: i32(21),
  });
});

Deno.test("Term.emit rejects unbound source variables", () => {
  assert_throws(() => Term.emit(var_("x")), "Unbound source variable: x");
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

  assert_includes(wat, '(export "answer" (func $answer))');
  assert_includes(wat, '(export "main" (func $main))');
  assert_includes(wat, "i32.const 43");
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

  assert_includes(wat, "i32.const 42");
});

Deno.test("Surface.emit supports named expression exports", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "expr", value: i32(7), exportedAs: "seven" },
      { tag: "expr", value: i32(42) },
    ],
  };

  const wat = Mod.emit(Surface.emit(surface));

  assert_includes(wat, '(export "seven" (func $seven))');
  assert_includes(wat, '(export "main" (func $main))');
});

Deno.test("Surface.emit rejects duplicate top-level bindings", () => {
  const surface: SurfaceNode = {
    statements: [
      { tag: "let", name: "x", value: i32(1) },
      { tag: "let", name: "x", value: i32(2) },
      { tag: "expr", value: i32(42) },
    ],
  };

  assert_throws(() => Surface.emit(surface), "Duplicate top-level binding: x");
});
