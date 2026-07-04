# Recursion, Loops, Break, Continue, And Linear State

## Goal

Implement `rec`, `for`, `break`, `continue`, and loop-edge linearity rules.

## Source Sections

- Loops and Tail Recursion
- Break, Continue, and Linear State

## Work

- Parse `rec` functions.
- Enforce that `rec(...)` calls are only valid in tail position.
- Parse range loops:

```txt
for i in 0..n {
  body
}

for i in a..b by s {
  body
}
```

- Evaluate loop start, end, and step once.
- Enforce nonzero step.
- Support collection loops:

```txt
for x in xs { ... }
for i, x in xs { ... }
```

- Lower collection loops using facts:

```txt
range -> range_loop
indexable -> indexed_loop as range_loop + get
iterable -> iterator_loop
otherwise fail
```

- Validate linear state across `break`, `continue`, and fallthrough.
- Preserve ownership cleanup edges across loop control. A `break` or `continue`
  that leaves a scratchpad or unique-owner lifetime must run the same reset/drop
  elaboration as normal fallthrough; control transfers that stay inside the
  lifetime must not reset it early.
- Merge loop-carried ownership states path-sensitively. A carried value must
  have compatible storage and ownership state at every backedge, `continue`,
  `break`, and zero-iteration exit.
- For scratchpads inside loops, emit reset edges for every exit that leaves the
  scratch lifetime. For scratchpads outside loops, do not reset on loop
  backedges that remain inside the scratch lifetime.
- Reject loops carrying unique, borrowed, scratch-backed, or ownership-bearing
  closure values until the carried-state merge exposes cleanup/drop/reset facts
  for all control-flow edges.

## Acceptance Criteria

- Non-tail `rec(...)` is rejected.
- Range loops lower to structured loop IR.
- Loop index bindings are fresh and read-only.
- `continue` jumps to the step phase.
- `break` exits the loop.
- Every loop edge leaves carried linear variables valid.
- Loop `break` and `continue` cannot bypass scratch resets or planned unique
  owner drops for lifetimes they exit.
- Dynamic loops with owned carried values are accepted only when the Core proof
  includes storage, lifetime, merge, and cleanup facts. Missing facts reject
  before WAT emission instead of selecting GC.

## Verification

- Add tests for valid and invalid `rec`.
- Add parser/lowering tests for range and collection loops.
- Add linearity tests for `break`, `continue`, and fallthrough paths.
- Add no-GC loop ownership fixtures for scratch reset on `break`/`continue`,
  zero-iteration owner cleanup, carried unique owner merges, active borrow
  barriers, and rejected uncertain cleanup.

## Implementation Status

- Implemented parsing for `rec`, range loops, collection loops, `break`, and
  `continue`.
- Implemented tail-position validation for `rec` and static unrolling for
  compile-time reducible recursive calls, including rec bodies with static
  loops, frontend-known aggregate index assignment, compile-time-known const
  parameters, and bound dynamic union `if let` result handler application.
  Tail-recursion validation lives in `src/frontend/rec_validate.ts`. Static-rec
  lowering lives in `src/frontend/rec.ts`, static-rec result-expression dispatch
  lives in `src/frontend/rec_result.ts`, the shared static-rec hook contract
  lives in `src/frontend/rec_hooks.ts`, recursive target/argument binding lives
  in `src/frontend/rec_bind.ts`, static-rec union/`if let` lowering lives in
  `src/frontend/rec_union.ts`, with dynamic union `if`, rec-aware `if let`, and
  union-result `if let` application split under `src/frontend/rec_union/`.
  Static-rec union case-shape inference lives in
  `src/frontend/rec_union_infer.ts`, static-rec expression inference lives in
  `src/frontend/rec_infer.ts`, and shared static-rec helpers live in
  `src/frontend/rec_util.ts`, with `src/frontend/lower_static_rec_adapter.ts`
  assembling the lower-graph static-rec hook object behind the public lowerer
  facade. Static-rec struct-value result lowering now uses declared struct field
  order when a concrete struct type is available, matching ordinary struct
  lowering and preserving field projections when source construction order
  differs from declaration order.
- Implemented static range-loop expansion, static collection-loop expansion over
  const-known aggregate values, typed runtime structs, and frontend-visible text
  bytes, read-only loop bindings, nonzero step checks, and static
  `break`/`continue`, plus terminal `return` propagation and nested static-loop
  flattening, including statically decidable nested `if` statements, statically
  known matching/non-matching `if let` statements, and loop-index/payload
  conditions. Inner-loop `break`/`continue` stay scoped to the inner loop, while
  inner `return` exits the function. Simple dynamic `if` or `if let` statements
  with a terminal `break` or `continue` lower inside static Ic-expanded range
  loops and statically expanded collection loops over const-known aggregates,
  typed runtime structs, and frontend-visible text bytes through synthesized
  active/step flags. Those branches may run simple local-binding, assignment, or
  expression prefix statements before the terminal loop control. Nested dynamic
  loop-control bodies remain rejected explicitly instead of being silently
  unrolled. Closures that field-select, index, update, call `len`/`get`, or
  iterate a parameter defer lowering so visible aggregate or concrete visible
  `Text` arguments can specialize the call before Ic expansion.
- Implemented runtime-index `get(xs, i)` and `xs[i]` lowering over const-known
  aggregate values and typed runtime structs as pure Ic `select` chains with
  out-of-range trap fallbacks, including declared runtime scalar fields and
  declared or homogeneous visible `Text` fields as `i32` data-pointer results.
- Added a minimal `Core` structured representation and `Source.core(...)` path
  that preserves dynamic range loops with start, end, step, body, and carried
  assignment facts before Ic/Wasm lowering.
- Implemented minimal `Core.emit` WAT lowering for scalar `i32` range loops with
  single-evaluated start/end/step values, compile-time rejection for statically
  zero steps, runtime traps for dynamically zero steps, local carried
  assignments, and Wasm `block`/`loop` control flow, including no-else `if`
  statements that can branch to loop `break` and `continue` labels.
- Implemented `Core.emit` WAT lowering for scalar dynamic tail-recursive calls
  by initializing recursive parameter locals and lowering tail `rec(...)` calls
  to parameter updates plus `br` back to a Wasm `loop`.
- Static-rec text-specific result lowering is split into
  `src/frontend/rec_text.ts`, and runtime struct projection/index lowering is
  split into `src/frontend/rec_struct.ts`, separate from recursive unrolling and
  control-flow handling.
- Static-rec `if` branch lowering is split into `src/frontend/rec_if.ts`, and it
  handles scalar/text dynamic `if` expressions and dynamic struct `if`
  result/projection/index lowering, including nested static-shaped struct
  fields, with rec-aware branch lowering, plus statement-level dynamic
  `if`/`if
  let` fallthrough, so final results, conditional statement updates,
  and dynamic index-assignment rebuilds preserve captured rec arguments and
  rec-local runtime type context.
- Static-rec application result typing now reuses the rec argument binding and
  result inference path, so values bound from static rec calls retain annotated
  struct/text field types for later frontend field access, `len`, and `get`
  lowering. Direct static-rec call results with struct type facts can also feed
  field, static index, and `get` projection without first assigning the result
  to a local, while missing fields still reject deterministically. Annotated
  binding and call-argument contexts now also pass an expected scalar, `Text`,
  struct, or union result type into static-rec app lowering, so otherwise
  unknown dynamic rec result branches can lower through typed Ic selects,
  handler projections, or union handlers. Simple block-local result aliases in
  those rec results keep the same expected type, including branch-local
  `borrow`, `freeze`, or simple `scratch {}` wrappers before typed struct
  projection or union `if let` consumption.
- Static-rec argument binding now uses annotated parameter context to erase
  `borrow`, `freeze`, and simple value-returning `scratch` wrappers before Ic
  result lowering. Initial calls such as `loop(borrow input, 2)` and recursive
  tail-call arguments use the same annotation-driven wrapper boundary as
  ordinary specialized calls, including struct projection and typed union
  `if let` consumption. Dynamic branch arguments with declared struct or union
  parameter context also use typed aggregate lowering, including implicit
  no-else fallbacks for shapes such as `loop(if flag { borrow input }, 0)` and
  explicit else branches such as `loop(if flag { scratch { input } } else {
  other }, 0)`.
- Static-rec block-local annotated bindings and same-type assignments use the
  same wrapper-erasure boundary, so rec bodies can bind or update scalar/Text
  locals from `borrow`, `freeze`, or `scratch` wrappers before producing an Ic
  result.
- Static-rec wrapper erasure now reaches scalar/Text dynamic `if` branch
  initializers as well. Annotated rec arguments and rec-local bindings can
  select between branch-local wrappers and ordinary values before the rec body
  lowers to Ic.
- Static-rec union payload binders now resolve user-defined annotation type
  names, so `if let` payloads such as `user_type` retain nested struct and
  `Text` field facts inside rec bodies.
- Static-rec result lowering handles dynamic union `if` targets consumed by
  `if let`, preserving captured rec arguments in matching payload branches.
- Implemented `Core.emit` WAT lowering for statement-level dynamic `if ... else`
  branches that update scalar locals.
- Implemented `Core.emit` WAT lowering for static collection loops over literal,
  statically bound, compatible dynamic `if`, or simple const-call dynamic `if`
  object/struct shapes by unrolling fields, including loop-local item/index
  bindings and `break`/`continue` labels, plus field and static-index
  scalarization through statically bound aggregate shapes.
- Implemented `Core.emit` WAT lowering for `len(collection)` and
  `get(collection, index)` when the collection resolves to a statically shaped
  object/struct value, including dynamic index trap fallbacks.
- Implemented `Core.emit` WAT lowering for visible text and runtime values known
  to have type `Text` as length-prefixed UTF-8 byte loops with item/index locals
  and `break`/`continue` labels.
- The same `Core` path preserves unknown collection loops with item/index names,
  collection expression, body, and carried assignment facts.
- Tests cover static `rec`, static-rec bodies with loops and aggregate index
  assignment, const rec parameters, pure linear rec parameters with exact-use
  validation, annotated `Text`, struct, and union rec parameters, annotated rec
  arguments wrapped in `borrow`, `freeze`, and `scratch`, rec-local annotated
  wrapper bindings and same-type wrapper assignments, branch-local wrapper
  selection in annotated rec arguments and rec-local bindings, and rec-local
  bindings including text length, byte indexing, and `get`, struct projection,
  struct indexing, struct `get`, dynamic scalar/text `if` results, dynamic
  struct `if` result/projection/index lowering including nested static-shaped
  struct fields returned from static-rec dynamic branches, statement-level
  dynamic `if`/`if let` fallthrough including dynamic outer `if` branches whose
  rec branch contains typed union `if let` fallthrough, and dynamic struct index
  assignment, dynamic union `if let` payload branches and handler-result
  applications including user-defined struct payload field access, invalid
  `rec`, Core dynamic tail-recursive WAT lowering and instantiation, range
  loops, collection loops, invalid ranges, typed runtime struct `len`,
  runtime-index `get`, runtime bracket indexing over known aggregates and typed
  runtime structs with runtime scalar/text payloads, bounds-checked runtime
  `Text` `get`, dynamic indexing over visible text fields, frontend visible
  aggregate and concrete visible `Text` arguments specialized into closures that
  field-select, index, update, call `len`/`get`, or iterate their parameters,
  frontend-visible and Core visible/runtime `Text` collection loops,
  dynamic-loop rejection, structured-core dynamic range-loop and unknown
  collection-loop preservation, Core range-loop WAT instantiation, dynamic
  positive and negative Core range-step WAT instantiation, dynamic zero
  range-step trap coverage, conditional Core range-loop `break`/`continue`
  codegen, frontend nested statically decidable `if` and statically known
  `if let` `break`/`continue` lowering, static-loop `return` propagation, nested
  static-loop return propagation with scoped inner `break`/`continue`, explicit
  dynamic conditional static-loop `if { break }`, `if { continue }`,
  `if let { break }`, and `if let { continue }` lowering across range loops and
  statically expanded collection loops, integer, `Text`, resolvable
  static-shaped struct, resolvable same-case union top-level `let` bindings,
  path-dependent annotated scalar/text/runtime aggregate bindings including
  typed unknown struct projections, nested typed struct projections, and typed
  unknown union values, path-dependent scalar/function `const` bindings, scalar
  block-result bindings, direct-lambda scalar call bindings, direct-lambda typed
  struct call bindings, and simple block-local aliases of typed struct/union
  calls before dynamic loop-control checks, recursive nested dynamic
  loop-control lowering that skips trailing statements after inner
  `break`/`continue`, statically expandable nested loops after dynamic
  loop-control state by guarding the nested unrolled statements with the current
  loop-step flag, frontend pure linear static-range `break`/`continue` lowering
  with loop-edge rebinding checks, Core static and compatible dynamic shaped
  collection-loop WAT instantiation including const-call dynamic aggregate
  shapes, static-call block-local collection-loop WAT instantiation, Core
  visible and runtime `Text` collection-loop WAT instantiation, Core aggregate
  `len`/`get` WAT instantiation, and loop-edge linearity. The implemented Core
  range-loop and collection-loop emitters are split into
  `src/core/range_loop.ts` and `src/core/collection_loop.ts`; collection loops
  remain hook-driven through backend adapter static facts. Frontend static-loop
  shared contracts, binding/read-only helpers, body expansion, dynamic-control
  need detection, collection item materialization, static `if let` payload
  binding, dynamic-control scanning, and guarded dynamic-control expansion live
  under `src/frontend/static_loop/`.
- Unknown runtime collection-loop and broader structured-loop codegen remain
  reserved.
- Latest skipped-step fallback slice: bindings after dynamic static-loop
  `break`/`continue` now materialize an inner no-else `if`/`if let` fallback
  before the outer skipped-step guard is added. This keeps no-else union results
  lowerable through pure Ic when they are later consumed by `if let`, instead of
  hiding the implicit fallback inside a nested branch.
- Latest nested dynamic-union target slice: union-valued no-else `if let`
  bindings after dynamic static-loop control can now consume loop-local values
  whose target union is itself a nested dynamic union `if`. The union-result
  handler path applies target-case handlers to encoded nested union targets
  instead of requiring both target branches to be direct union cases.
- Typed aggregate block-alias bindings after dynamic static-loop control now
  keep their expected struct or union context when the block result is selected
  by a dynamic `if let` with `borrow`, `freeze`, or simple `scratch {}` branch
  values. The guarded skipped-step branch no longer fails through the older
  untyped dynamic-`if` aggregate rejection before typed field or union-handler
  lowering can run.
- Unannotated shorthand union-result bindings after dynamic static-loop control
  now prefer the union-case inference path before generic expression inference.
  A shape like `let result = if let .some(value) = maybe { .ok(value) }` can
  synthesize its implicit skipped-step fallback from the inferred `.ok(Int)`
  payload and remain consumable by a later `if let`.
- Unannotated scalar, `Text`, and aggregate payload-result bindings after
  dynamic static-loop control now infer the matched `if let` payload type before
  building the skipped-step fallback. Shapes such as
  `let text = if let .some(value) = maybe { value }` and
  `let user = if let .some(value) = maybe { value }` stay on the pure Ic route
  when the target union case declares `Text` or a struct type.
- Simple block-local function aliases after dynamic static-loop control now
  resolve to their direct lambda before the guarded skipped-step function value
  is built. A shape like `let f = { let id = x => x; id }` can be called after a
  dynamic `break` guard without leaving an unresolved `f#...` application in the
  reduced Ic graph.
- Block-local function aliases after dynamic static-loop control can also carry
  simple non-linear local captures. The direct-lambda resolver inlines the
  block prefix into the captured environment, so
  `let f = { let offset = i + 1; let add = x => x + offset; add }` and
  `let f = { let offset = i + 1; return x => x + offset }` lower through pure
  Ic without leaking `offset#...` or placeholder loop-index names.
- Unannotated calls through a loop-local function binding after dynamic
  static-loop control now infer the inlined scalar result type for skipped-step
  fallback synthesis. A shape such as `let id = x => x; let value = id(i)`
  after a dynamic `break` guard remains on the pure Ic route without requiring
  an explicit `Int` annotation.
- The same skipped-step call-result inference preserves lambda parameter
  annotations. A loop-local helper such as `let id = (text: Text) => text` can
  be called after a dynamic `break` guard, and the binding fallback still
  materializes the correct `Text` value for later `len(...)` lowering.
- Branch-selected loop-local function bindings after dynamic static-loop control
  now infer as function-shaped when both branches resolve to compatible direct
  lambdas in the current environment. The guarded skipped-step path eta-expands
  the selected function body, preserves compatible annotations such as `Text`,
  and keeps later calls like `let value = id(input); len(value)` on the pure Ic
  route.
- Branch-selected loop-local functions in that same guarded path can now carry
  simple non-linear block-local captures from each selected branch. Captured
  aliases are substituted into the branch body as captured expressions while the
  selected function parameters remain normal lambda parameters, so captured
  `Text` aliases and scalar offsets do not leak unresolved block-local names
  into the reduced Ic graph.
- Calls through branch-selected loop-local functions can now return declared
  struct values after dynamic static-loop control. Skipped-step fallback
  synthesis follows captured struct type expressions back to their declared
  field types, so fields such as `label: Text` get the correct empty-text
  fallback even when the field value is a free runtime name.
- `if let`-selected loop-local function bindings after dynamic static-loop
  control now use the same eta-expanded function path as dynamic `if` function
  branches. The generated function body keeps the original `if let`, so payload
  names are still bound by the existing union-handler lowering while compatible
  lambda parameters and simple branch captures are normalized for later calls.
- Union-valued same-type assignments after dynamic static-loop `break` or
  `continue` state now synthesize an explicit skipped-step assignment value:
  `name = if loop_step { new_value } else { name }`. This preserves the
  previous union value on skipped paths, keeps no-else union assignment
  fallbacks typed, and lets a later final `if let` consume `Text` payloads on
  the pure Ic route.
- Same-type union assignments written with `:=` after dynamic static-loop
  control now use that same skipped-step assignment path when the new union
  cases are statically proven to match the previous binding. True type-changing
  or unknown `:=` assignments remain outside the pure Ic path.
- Final statement-form dynamic `if` and `if let` blocks now keep implicit
  fallback metadata when statement lowering wraps them as expression blocks.
  This prevents generated loop-control guards from turning a final no-else
  `if let` into an empty-block result while branch type inference is deciding
  whether the pure Ic route is valid.
- Unannotated unknown bindings after dynamic static-loop control can now stay
  deferred through the skipped-step guard until a later pure-Ic consumer
  supplies the result type. Numeric consumers materialize `Int`/`I64` zero
  fallbacks, typed text consumers materialize `""`, and typed union `if let`
  text results lower through the existing handler/text path. Untyped final
  uses still keep the dynamic-unknown rejection instead of guessing a fallback.
- Static-rec local bindings now use the same deferred result-context model for
  unknown dynamic `if`/`if let` values. Rec-local numeric primitive operands
  lower deferred `Int`/`I64` values through typed operands, and `len(...)`
  lowers deferred runtime `Text` values through the existing text pointer path,
  so statically unrolled rec bodies no longer need redundant local annotations
  for those pure Ic cases.
- Direct text consumers now provide `Text` context to static-rec call results.
  `len(make(...))`, `get(make(...), i)`, and `make(...)[i]` can lower a rec
  result whose final value is an otherwise unknown dynamic text branch, while
  unknown non-rec call results still keep the normal unsupported collection
  diagnostics.
