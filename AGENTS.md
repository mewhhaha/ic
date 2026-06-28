# AGENTS.md

## Goal

Build a small Interaction Calculus inspired compiler pipeline in Deno:

```txt
IC -> Expr -> WAT -> Wasm
```

The project should stay simple and inspectable while it grows. Prefer small explicit compiler stages over clever abstractions.

## Style rules

- Do not use ternary expressions.
- Do not use the nullish coalescing operator.
- Do not silently default when compiler information is missing.
- If a binding, type, local, or lowering fact cannot be found, throw an error.
- Prefer explicit `if` blocks over compact expressions when the branch matters.
- Keep semantic operations separate from concrete Wasm instructions.

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

Check arity from the table when formatting, lowering, or emitting. Do not use an `isOp` style type guard to detect primitive names as tags.

## Pseudo traits

Types can have ad-hoc pseudo traits attached to empty functions.

Define the trait shape as a type:

```ts
type Format<self> = {
  fmt: (value: self) => string;
};

type Emit<from, to> = {
  emit: (value: from) => to;
};
```

Define the data type and an empty function with the same exported name:

```ts
export type IC =
  | { tag: "num"; value: number }
  | { tag: "var"; name: string };

export function IC() {}
```

Attach methods directly to the function:

```ts
IC.fmt = function fmt(ic: IC): string {
  if (ic.tag === "num") {
    return ic.value.toString();
  }

  if (ic.tag === "var") {
    return ic.name;
  }

  ic satisfies never;
  throw new Error("panic");
};
```

Check the pseudo traits later with `satisfies`:

```ts
IC satisfies Format<IC> & Emit<IC, Expr>;
```

Do not replace this pattern with object literals or constructor casts. The empty function is the namespace-like value, and traits are added to it ad hoc.
