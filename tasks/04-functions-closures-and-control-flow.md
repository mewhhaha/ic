# Functions, Closures, And Control Flow

## Goal

Implement closures, block return semantics, `return`, `if`, and `if let`.

## Source Sections

- Functions and Closures
- Structs and Unions
- Minimal Grammar Sketch

## Work

- Parse closure forms:

```txt
let add = (x, y) => x + y

let add = (x, y) => {
  x + y
}
```

- Treat the final expression in a block as the block result.
- Support `return` for early exits from functions.
- Support `if` expressions and `if let` pattern matching.
- Support runtime closures capturing runtime values.
- Reject const functions that capture runtime values.
- Defer general first-class linear closure captures; require effectful functions
  to take linear values explicitly.
- Treat first-class closure environments as owned runtime storage with per-slot
  ownership facts. Frozen captures may be shared, unique captures move into the
  environment and make the closure value linear, borrow captures are valid only
  while the borrow lifetime outlives the closure, and scratch-backed captures
  require a non-escaping proof or explicit freeze/promotion.
- Keep closure storage on the baseline linear-memory backend. Do not use GC to
  keep uncertain captures alive; reject captures whose ownership, borrow, or
  scratch lifetime cannot be proven before WAT emission.
- Treat a first-class closure value as an owner package for its environment. The
  environment allocation, capture slots, call signature, transfer/freeze
  decisions, and cleanup/drop facts must be visible in Core before WAT emission.
- Store first-class runtime closures as an explicit code pointer/table index
  plus an environment pointer when captures are present. The environment record
  has its own storage class, lifetime id, and per-slot ownership facts; a
  capture-free closure may stay as a code pointer with no heap environment.
- Reusable closure values may capture only scalar or `frozen_shareable` slots by
  default. Capturing `unique_heap`, `borrow_view`, `scratch_backed`, capability,
  or ownership-bearing slots either makes the closure linear with explicit
  move/consume behavior or rejects before WAT emission.
- Closure environment cleanup is inserted from the same proof surface as other
  source values and compiler-created temporaries. A missing capture lifetime,
  environment drop, scratch reset, or promotion edge is a proof gap, not a GC
  fallback point.
- A closure returned from `scratch {}` may escape only when the environment is
  scalar/capture-free, already frozen/shareable, explicitly promoted/frozen, or
  proven scratch-free. A hidden attached scratch region is not a closure
  lifetime strategy.
- Split first-class closure storage into explicit implementation slices:
  closure value representation, environment layout, per-slot capture
  classification, call ABI, linear closure participation, and environment
  cleanup/drop proof.
- For representation, use a code pointer or function-table index plus an
  environment pointer when captures exist. Capture-free closures may remain code
  pointers; captured closures allocate an environment record with storage,
  lifetime, and cleanup facts.
- For capture classification, record each slot as scalar, frozen/shareable,
  unique owner, borrow view, scratch-backed value, capability, or nested
  ownership-bearing closure. Reusable closure values accept scalar and
  frozen/shareable slots by default; other slots require linear closure
  behavior or rejection.
- For cleanup, treat closure environments and environment-construction
  temporaries like other owned runtime values. Accepted closure fixtures must
  expose allocation, capture ownership, freeze/promotion, transfer, and
  drop/reset facts before WAT emission with `managed_storage: "disabled"`.
- Support the narrow frontend case where a direct non-escaping local closure
  call, including parameterized calls, simple local aliases, and
  literal-condition static closure branches, consumes an outer linear value
  along a valid linear control-flow path.

## Acceptance Criteria

- Closures can be parsed, typed, and lowered.
- Block final-expression return works.
- Early `return` exits the nearest function.
- Runtime captures are represented explicitly in closure state.
- Const captures are restricted to const values.
- `if let .case(value) = expr { ... }` narrows union cases.
- First-class closure environments record capture storage class and lifetime
  facts before WAT emission.
- Captured environments expose code pointer/table index, optional environment
  pointer, environment storage class, lifetime id, and per-slot ownership facts.
- Capturing a unique value either moves it into a linear closure or rejects if
  the closure can be duplicated.
- Capturing a borrow or scratch-backed value rejects unless the closure is
  proven not to outlive the borrow/scratch lifetime.
- Returned or stored first-class closures expose environment ownership and
  cleanup facts with `managed_storage: "disabled"` in the baseline.

## Verification

- Add parser tests for closure expression and block forms.
- Add lowering tests for closure environments.
- Add type tests for runtime capture versus invalid const capture.
- Add `if let` tests over union values.
- Add closure ownership fixtures for scalar/frozen captures, unique captures,
  borrow capture rejection, scratch-backed capture rejection or promotion, and
  environment cleanup/drop proof rows.

## Implementation Status

- Implemented closures, block final expressions, early `return` including nested
  block returns before later fallthrough statements, runtime closure captures,
  specialized runtime closure calls that preserve the closure binding
  environment, const capture checks, `if`, static and dynamic no-else `if`
  statement fallthrough, no-else integer `if`/`if let` expressions with `0`
  fallback, no-else text `if`/`if let` expressions with `""` fallback, no-else
  struct and union `if`/`if let` expressions with synthesized field-wise or
  case-table fallbacks when every field/payload has an Ic-safe fallback,
  block-final no-else `if`/`if let` conditionals as value-producing final
  expressions when their branch block has a value result,
  known-case `if let` including runtime payloads and frontend-known
  field/static-index projections, rejection of known non-i32 conditions before
  Ic lowering, and direct typed pure union `if let` through Ic handlers, plus
  same-case dynamic typed or locally inferred shorthand union `if` payload
  selection as handler-encoded values, including unknown runtime payloads;
  different-case dynamic typed or locally inferred shorthand union `if` as
  handler-encoded Ic values, including unknown runtime payloads; and
  different-case dynamic typed union `if` consumed by numeric/text-pointer
  `if let`, including `Text` payloads used by `len`; locally inferred shorthand
  dynamic union cases work both directly and through statically bound dynamic
  `if` values when consumed by `if let`, including dynamic union values returned
  by inlineable runtime closure calls; frontend-known object/typed-struct
  `if let` results lower field-by-field through that scalar path, either as
  field projections or as Ic handler-encoded aggregate values; simple
  block-local frontend-known union values are resolved before known-case
  `if let` lowering, and simple block-local dynamic union-if values are resolved
  before dynamic `if let` lowering; dynamic ordinary function branches,
  including simple aliases to known closures, eta-expand to Ic lambdas when
  their applied bodies produce scalar/text-pointer results, preserve matching
  parameter annotations, one-sided annotations, and alias-equivalent annotations
  across selected branches, use selected-branch parameter facts to erase
  `borrow`, `freeze`, and simple value-returning `scratch` wrappers at the call
  boundary, reject incompatible selected-branch call arguments, reject
  incompatible dynamic branch parameter shapes before generic dynamic `if`
  lowering, recover i64 selected bodies from those parameter/capture facts, and
  calls through those branches inline back to dynamic `if` expressions for
  frontend-known struct and union consumers.
- Implemented static `Core.emit` lowering for `if let` statements and
  expressions over literal or statically bound shorthand and typed-constructor
  union-case targets, including payload local binding and skipped non-matching
  cases.
- Implemented `Core.emit` lowering for `if let` expressions and statements whose
  target is a direct or statically bound dynamic `if` over shorthand or
  typed-constructor union-case branches, without materializing runtime union
  storage.
- Implemented `Core.emit` lowering for statement-level dynamic `if ... else`
  branches that update scalar locals, preserving expression `if` lowering for
  value-producing branches.
- `Core.emit` also merges compatible static-shaped struct and visible text
  assignments from both `if ... else` branches, capturing the condition before
  either branch runs so later shadowing does not change the selected value.
- `Core.emit` treats known `let` closures as inlineable static call targets and
  snapshots scalar runtime captures into hidden locals when the closure is
  bound, so later shadowing does not change the captured value. Statement-bodied
  inline calls use hidden parameter and block-local names, so closure-local
  assignment and shadowing do not clobber caller locals.
- `Core.mod` lowers first-class scalar closures with annotated scalar parameters
  through explicit closure environments: closure values are `i32` environment
  pointers, offset `0` stores a function-table index, scalar captures are
  snapshotted into following slots, captured closure pointers keep their
  callable signatures, and closures returned from scoped static calls preserve
  their callable signatures when rebound to locals. Returned closures with
  annotated `I64` parameters/captures use the same environment layout with
  8-byte-aligned i64 capture slots, and the static text-layout scan now enters
  annotated lambda/rec bodies with scoped scalar/text parameter facts before WAT
  emission. Selected first-class closure branches can derive one-sided
  `Int`/`I32`, `I64`, and `Text` parameter facts from the annotated branch, and
  Core keeps `Text` parameter facts separate from plain `i32` so `Int`/`Text`
  branch mismatches fail before WAT emission. Core closure function-type
  discovery, selected-branch closure type checking, and closure-call argument
  validation live in `src/core/closure_type.ts`. Lifted functions take the env
  pointer as their first parameter, and dynamic calls use `call_indirect`.
  Same-type assignment to a captured scalar name lowers as a per-call
  closure-local shadow for both inlined static closures and first-class closure
  environments. Sequential type-changing closure-local shadowing lowers to fresh
  Core locals. Inlineable static closures that index-assign captured statically
  shaped aggregates clone those aggregate shapes per call before rebuild.
  Runtime locals hidden inside captured static text values are captured into the
  first-class closure environment before lifted closure emission. Captured
  runtime `Text` byte assignment works through first-class closure environments;
  unused capture-free runtime-local traversal was removed from
  `src/core/closure_capture.ts`, and captured aggregate and non-Text
  memory-backed index assignment remains unsupported.
- `&&` and `||` are implemented as boolean `if` expressions and lower through
  the existing Ic `select` path for dynamic operands.
- Direct `Text` consumers now provide caller context through safe inlineable
  helper calls. Unannotated identity-style helpers such as `value => value`,
  and callable block aliases such as `{ let id = value => value; id }`, can
  feed `len(...)`, `get(...)`, and byte-index syntax without an intermediate
  `Text` annotation. The inline text path rejects helper bodies such as
  `value + 1` instead of treating arbitrary lowered `i32` expressions as text
  pointers.
- Call-only runtime lambda bindings whose body contains an untyped dynamic text
  branch can stay environment-only until an inline call supplies `Text`
  context. This covers helpers like `flag => if flag { input } else { other }`
  feeding direct text consumers, including simple block-local aliases, while
  escaping the helper as a function value or aliasing it as data still rejects.
- The same call-only text-helper path now handles no-else dynamic text branches
  once the direct text consumer supplies `Text` context. `len(choose(flag))`,
  `get(choose(flag), i)`, and `choose(flag)[i]` synthesize the empty-text
  fallback at the call site; numeric no-else helper bodies and escaping helper
  values remain rejected.
- Non-`Text` expected contexts now use a shared app-as-type hook for call-only
  helper results. Numeric primitive operands, annotated struct bindings, and
  annotated union bindings inline unannotated helpers whose bodies contain
  dynamic branches, so Ic output no longer leaks free helper calls such as
  `(choose#0)(flag)`. `Text` expected contexts stay on the dedicated text
  proof path to avoid treating arbitrary `i32` expressions as text pointers.
- Inlineable helper app-result inference now feeds runtime struct field typing.
  Direct text consumers such as `len(choose(flag).name)`,
  `get(choose(flag).name, i)`, and nested field reads can lower when the helper
  returns declared struct values with `Text` fields. Mixed helper branches that
  do not consistently return the declared struct shape still reject before text
  pointer lowering.
- Direct `if let` results that select a struct payload from an inlineable
  helper-built union now keep declared struct field facts through field
  projection. Scalar fields, `Text` fields consumed by `len`, and `Text` fields
  consumed by `get` lower through pure Ic without leaking a free helper
  application, while mismatched non-struct result branches reject.
- Tests cover closure environments, runtime/const capture behavior, specialized
  runtime closure capture snapshots, dynamic `if` lowering, static branch
  folding, no-else fallthrough, dynamic no-else statement lowering, no-else
  expression lowering, union `if let` over known values, typed dynamic union
  `if let` over Ic-lowerable numeric and text-pointer values, same-case dynamic
  typed union `if` payload selection, and same-case locally inferred shorthand
  dynamic union values through Ic handlers, plus different-case dynamic typed or
  locally inferred shorthand union `if` values through Ic handlers and
  different-case dynamic typed union `if` consumed by numeric/text-pointer
  `if let`, dynamic union `if let` expressions that produce handler-encoded
  union results, including direct shorthand union cases, deferred const-call
  results, inlineable runtime closure calls whose case table can be inferred
  from the dynamic `if` branches, and dynamic `if` branches whose union cases
  are produced by inlineable identity or constructor helper calls, static-rec
  application of those bound handler-encoded union results and typed union
  `if let` fallthrough inside dynamic static-rec branch inference,
  frontend-known object/typed-struct `if let` value lowering, plus static and
  direct dynamic union-if Core `if let` statement and expression WAT-to-Wasm
  lowering, and Core statement-level dynamic `if ... else` scalar/static-shaped
  assignment branches through WAT-to-Wasm, plus `let` closure inlining with
  scalar runtime capture snapshotting, closure-local parameter assignment,
  caller-safe local shadowing, nested block return propagation through
  fallthrough statements, first-class scalar closure storage through `Core.mod`
  function tables and `call_indirect`, function-valued dynamic union-if `if let`
  expressions whose branches return direct non-linear closures with compatible
  parameter shapes, one-sided selected first-class closure parameter facts for
  `Int`, `I64`, and `Text`, `Int`/`Text` selected-closure mismatch rejection,
  captured first-class closure calls, closures returned from scoped static
  calls, same-type captured scalar assignment through static and first-class
  closure paths, type-changing closure-local shadowing through Core/WAT, and
  captured static aggregate index assignment by rebuild, captured runtime `Text`
  byte assignment through `Core.mod` and WAT-to-Wasm, direct non-escaping
  local/aliased/simple-block/static-branch linear closure captures in the
  frontend, plus rejection of unsupported captured assignment forms.
- Unknown dynamic `if let` targets outside typed/direct union-if or inlineable
  closure-call union-result shapes and general first-class linear closure
  captures remain reserved for a structured-core phase. Captured runtime
  aggregate scalar/`Text`/union-pointer/inline nested index assignment is
  supported.
