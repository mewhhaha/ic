# Const, Comptime, And Specialization

## Goal

Implement the draft's compile-time model: `const`, `comptime`, const functions,
const parameters, and specialization.

## Source Sections

- Runtime, Static Knowledge, and Compile-Time Execution
- Const functions
- Const Parameters and Specialization

## Work

- Parse and represent `const` bindings as compiler-known values.
- Parse and evaluate `comptime expr` during compilation.
- Represent const functions as statically known closures with known code and
  known captured const environment.
- Support `const` parameters:

```txt
let map = (xs, const f) => { ... }
```

- Require const parameters to be known at the call site.
- Specialize functions when const parameters are passed.
- Allow const values to be reified as runtime values when passed to ordinary
  runtime parameters.
- Keep const evaluation separate from runtime ownership. Const values may
  describe storage layouts, ownership contracts, and specialization facts, but
  `comptime` execution must not manufacture runtime owners that bypass the Task
  12 proof gate.
- When specialization inserts runtime temporaries, closure environments, union
  payloads, aggregate materialization, text operations, or host-boundary
  wrappers, those generated values must receive the same storage class, lifetime
  id, escape decision, and cleanup/transfer facts as source values.
- Reifying a const value as a runtime value must choose an explicit storage
  shape: scalar/static data, `frozen_shareable`, `unique_heap`, or rejected. It
  must not become an implicit GC-managed value in the baseline backend.

## Snake Case Examples

```txt
const make_adder = n => {
  x => x + n
}

const add_three = comptime make_adder(3)

let y = add_three(input)
```

```txt
const double = x => x * 2
let ys = map(xs, double)
```

## Acceptance Criteria

- `const` values are available to type checking and specialization.
- `comptime` executes only compiler-known computations.
- Const functions cannot capture runtime values.
- Const parameters reject runtime-only arguments.
- Specialized call output no longer needs runtime structural dispatch.
- Specialized output that touches runtime memory reaches WAT emission only after
  the no-GC ownership proof rows are present. Missing rows are deterministic
  compiler errors, not managed-storage fallbacks.

## Verification

- Add tests for successful and failing `comptime` evaluation.
- Add tests for const closure capture rules.
- Add specialization tests showing `map(xs, double)` can produce a specialized
  body.
- Add specialization tests where generated temporaries and reified const
  aggregate/text values expose ownership proof facts or reject before WAT
  emission.

## Implementation Status

- Implemented for compiler-known values, const closures with binding-time
  capture environments, const parameters, `comptime`, specialization, and
  reification of const values passed to ordinary runtime parameters. Simple
  const block values can resolve to union cases and type-values before Ic
  lowering.
- Const functions may execute supported compile-time control flow, including
  static loops and assignments.
- Tests cover successful and failing `comptime`, const binding and closure
  capture snapshots, const capture rejection, const-parameter rejection for
  runtime values, and specialized calls.
- Runtime parameter annotations on scalar values are checked at call-site
  specialization when the argument type can be proven by the current frontend.
  Frontend runtime binding and parameter annotations can also provide explicit
  scalar, text, struct, or union type context for otherwise unknown runtime
  values. Structured Core preserves closure parameter annotations and checks
  built-in scalar/type parameter annotations when static calls are inlined.
  Direct struct/union type-value parameter annotations provide static call
  argument context in Core.
- Core scoped static-call expression rewriting lives in
  `src/core/static_call_rewrite.ts`, statement/block rewriting and
  replacement-name shadowing live under `src/core/static_call_rewrite/`, and
  static-call contexts, arity checks, target discovery, and scoped planning live
  under `src/core/static_call/`, separate from backend static-call adapter glue
  and WAT emission.
- Runtime structural dispatch is intentionally excluded; generic and duck-typed
  paths are specialized before lowering.
- Annotated runtime parameters now preserve ownership-wrapper erasure at
  frontend-to-Ic call boundaries. Direct specialized calls and const-parameter
  helper calls can lower arguments such as `borrow input`, `freeze input`, or
  `scratch { input }` when the runtime parameter annotation supplies the
  scalar, text, or declared aggregate context needed by the pure Ic route.
