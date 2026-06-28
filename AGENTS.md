# AGENTS.md

## Goal

Build a small Interaction Calculus inspired compiler pipeline in Deno:

```txt
IC -> Expr -> Mod -> WAT -> Wasm
```

The project should stay simple and inspectable while it grows. Prefer small explicit compiler stages over clever abstractions.

## Theory background

This project is inspired by HVM4 and should stay aligned with the theory it is based on.

Primary implementation references:

- HVM4 repository: https://github.com/HigherOrderCO/HVM4
- HVM4 Interaction Calculus notes: https://github.com/HigherOrderCO/HVM4/blob/main/docs/theory/interaction_calculus.md
- HVM4 core syntax: https://github.com/HigherOrderCO/HVM4/blob/main/docs/hvm/core.md
- HVM4 memory layout: https://github.com/HigherOrderCO/HVM4/blob/main/docs/hvm/memory.md
- HVM2 repository and paper entry point: https://github.com/HigherOrderCO/HVM
- Bend, the high-level language targeting HVM: https://github.com/HigherOrderCO/Bend

Theory roots to keep in mind:

- Lambda Calculus: lambdas, applications, beta reduction, normal forms.
- Optimal reduction: avoid duplicating shared work, especially under lambdas.
- Interaction Nets: local graph rewriting with active pairs and strong confluence.
- Lafont Interaction Combinators: a tiny universal interaction-net system based on erasure, duplication, and constructor/fan behavior.
- HVM4 Interaction Calculus: extends lambda calculus with explicit duplications and superpositions.

Useful papers / historical anchors:

- Yves Lafont, "Interaction Nets", POPL 1990: https://doi.org/10.1145/96709.96718
- Yves Lafont, "Interaction Combinators", Information and Computation 1997: https://doi.org/10.1006/inco.1997.2643
- John Lamping, "An Algorithm for Optimal Lambda Calculus Reduction", POPL 1990.
- Andrea Asperti and Stefano Guerrini, "The Optimal Implementation of Functional Programming Languages".

Core HVM4 ideas we should preserve:

- Variables are affine: each variable is used at most once.
- Variables are global: a variable can occur outside its binder's lexical scope.
- Duplications and superpositions are dual constructs.
- Dup/sup labels matter: equal labels annihilate, different labels commute.
- The four central IC interactions are APP-LAM, DUP-SUP, APP-SUP, and DUP-LAM.
- Practical constructs such as numbers, constructors, matching, and operations should be layered on top of that core rather than mixed into it.

## Style rules

- Do not use ternary expressions.
- Do not use the nullish coalescing operator.
- Do not silently default when compiler information is missing.
- If a binding, type, local, or lowering fact cannot be found, throw an error.
- Prefer explicit `if` blocks over compact expressions when the branch matters.
- Use `expect(value, message)` directly at invariant sites.
- Define `expect` as an assertion helper for its first argument so TypeScript narrows after it succeeds.
- Do not hide `expect` behind tiny wrapper helpers such as `expectType` or `expectArity`.
- If a helper function only calls another function or performs one trivial lookup, inline it at the call site.
- Keep semantic operations separate from concrete Wasm instructions.

## Numeric literals

Numeric literals must carry their value type in IC. Do not silently default source numbers to `i32` during lowering.

Prefer this shape:

```ts
{ tag: "num", type: "i32", value: 21 }
```

Use `i64` explicitly for 64-bit literals:

```ts
{ tag: "num", type: "i64", value: 21n }
```

## Primitive operations

Represent primitive operations as explicit primitive nodes, not as top-level tags.

Prefer this shape:

```ts
{ tag: "prim", prim: "add", args: [left, right] }
```

Do not represent each operation like this:

```ts
{ tag: "add", left, right }
```

The primitive table owns metadata such as display text, arity, and typed Wasm instructions. This keeps the tree shape stable when adding more primitive functions.

Check arity from the table when formatting, lowering, or emitting:

```ts
const expected = arity(expr.prim);
expect(expr.args.length === expected, "error message");
```

Do not use an `isOp` style type guard to detect primitive names as tags.

## IC reduction

Put Interaction Calculus rewrite rules in `IC.reduce` before lowering to `Expr`.

Start with the small core rules and keep each rule explicit. The first real interaction rule is APP-LAM:

```txt
(λx. body)(arg) -> body[x := arg]
```

Same-label DUP-SUP annihilation:

```txt
! x &L = &L{a, b}; body -> body[x0 := a, x1 := b]
```

APP-SUP propagation creates a duplication for the argument and a superposition of applications:

```txt
(&L{f, g})(x) -> ! a &L = x; &L{f(a0), g(a1)}
```

Use deterministic fresh names for generated binders. Different-label DUP-SUP commute is not implemented yet. Until it is, throw an error instead of pretending the lowerer can handle it.

Do not lower unreduced `lam`, `app`, or `sup` nodes to `Expr`. If they remain after reduction, throw an error.

## Module layer

Keep `Expr` focused on computing one value. Do not put module, function, export, import, memory, or start-function structure into `Expr`.

Use a separate `Mod` layer after `Expr`:

```txt
Expr -> Mod -> WAT
```

The module layer owns Wasm functions and exports. `Expr.emit` should emit only the function body instructions.

Store module functions as a map keyed by function name. This makes export validation a direct lookup instead of a scan.

## Pseudo traits

Types can have ad-hoc pseudo traits attached to empty functions.

Define shared pseudo-trait shapes in `src/trait.ts`:

```ts
export type Format<self> = {
  fmt: (value: self) => string;
};

export type Emit<from, to> = {
  emit: (value: from) => to;
};

export type Reduce<self> = {
  reduce: (value: self) => self;
};
```

Define the data type and an empty function with the same exported name:

```ts
export type IC =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; name: string };

export function IC() {}
```

Attach methods directly to the function:

```ts
IC.fmt = function fmt(ic: IC): string {
  if (ic.tag === "num") {
    return ic.value.toString() + ":" + ic.type;
  }

  if (ic.tag === "var") {
    return ic.name;
  }

  ic satisfies never;
  throw new Error("panic");
};
```

Place `satisfies` checks in the implementation file, immediately after the relevant pseudo-trait methods are assigned:

```ts
IC.emit = function emit(ic: IC): Expr {
  return lower(ic, new Map());
};

IC satisfies Format<IC> & Emit<IC, Expr>;
```

Do not keep these checks in `main.ts`. Do not replace this pattern with object literals or constructor casts. The empty function is the namespace-like value, and traits are added to it ad hoc.
