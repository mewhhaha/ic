# Extensions And Protocol Fact Checkers

## Goal

Implement `with` extensions and protocol-like abstractions as ordinary const
fact checkers.

## Source Sections

- Extending Type Values
- Protocols as Fact Checkers
- applicative
- monad

## Work

- Parse and evaluate `with` extension objects.
- Ensure `with` creates a new extended const value and shadows the previous
  name.
- Keep extensions lexical, not global.
- Implement fact checkers for extended type-values.
- Support protocol examples:

```txt
const functor = f_type => { ... }
const applicative = f_type => { ... }
const monad = m_type => { ... }
```

- Support generic functions constrained by const fact checkers:

```txt
let fmap = (const f_type: functor, fa, const f) => {
  f_type.map(fa, f)
}
```

- Treat protocol/fact-checker operations as compile-time structural checks, not
  runtime dispatch. Any protocol operation that moves, borrows, freezes, or
  returns runtime-owned data must specialize to concrete Core code before the
  ownership/lifetime proof gate.
- Allow protocol facts to require ownership contracts, such as a method taking a
  bounded borrow, consuming a unique owner, returning a frozen/shareable value,
  or producing a scratch-free result. These remain ordinary const facts checked
  structurally.
- Reject protocol-specialized code whose generated ownership facts are missing.
  The baseline does not use GC or hidden managed storage to make a generic
  protocol operation safe after specialization.

## Acceptance Criteria

- `option_type = option_type with { ... }` shadows the previous `option_type`
  binding without mutation.
- Extended values are callable if the original value was callable.
- Static fields like `option_type.map` resolve after extension.
- `functor(f_type)` succeeds only when `f_type` exposes the expected `map`
  operation.
- `applicative` can depend on `functor`; `monad` can depend on `applicative`.
- Generic protocol-checked functions specialize before code generation.
- Specialized protocol code exposes storage, lifetime, borrow, freeze,
  promotion, and cleanup facts before WAT emission whenever it touches runtime
  memory.

## Verification

- Add tests for `with` shadowing.
- Add tests for extension field lookup.
- Add fact-checker tests for `functor`, `applicative`, and `monad` shapes.
- Add specialization tests for `fmap(option_type, a, inc)`.
- Add protocol/fact-checker fixtures for ownership-bearing operations:
  bounded-borrow inputs, unique-owner transfer, frozen/shareable returns, and
  rejected missing cleanup or scratch-escape facts.

## Implementation Status

- Implemented `with` extension objects, lexical shadowing of extended const
  values, binding-time extension field capture, extension field lookup, callable
  extended type constructors, and protocol-like const fact checkers.
- Tests cover extension lookup, binding-time extension field capture, computed
  facts through extensions, nested fact-checker execution, protocol failure
  diagnostics, and `functor`/`applicative`/`monad`-style specialization.
