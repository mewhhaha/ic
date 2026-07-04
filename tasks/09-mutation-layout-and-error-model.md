# Mutation, Layout, And Error Model

## Goal

Implement value-based updates, linear/mutable index updates, compile-time layout
helpers, and the error model.

## Source Sections

- Mutation and Update
- Compile-Time Layout
- Error Model

## Work

- Follow the Task 12 authoritative memory/lifetime contract for every mutation
  or allocation case. The baseline uses static ownership and lifetime proofs,
  not a GC fallback, and rejects before WAT emission when a required proof fact
  is missing.
- For each mutation-adjacent slice, use the Task 12 authoritative execution
  checklist:
  classify storage and lifetimes, check active borrows, prove scratch-result
  escape before reset, emit explicit freeze/promotion when needed, record
  cleanup/drop/reset facts, and keep `managed_storage: "disabled"` for accepted
  baseline fixtures.
- Implement pure struct update by copy/rebuild:

```txt
user = user { age: user.age + 1 }
```

- Require facts proving linearity, uniqueness, or mutable capability for index
  updates:

```txt
buf[i] = x
```

- Use explicit storage facts for mutation-adjacent values: `scalar_local`,
  `unique_heap`, `borrow_view`, `frozen_shareable`, and `scratch_backed`.
- Treat runtime heap values as unique by default. `borrow value` creates a
  read-only lexical view, `freeze value` consumes unique ownership and produces
  immutable shareable data, and `scratch { ... }` creates a temporary
  bump-allocation scope with a value result.
- Keep `scratch { ... }` lexical. It resets on fallthrough, `return`, `break`,
  and `continue`; a result can escape only when scalar, frozen/shareable,
  explicitly frozen/promoted into persistent storage, or proven scratch-free.
  Attached-region return packages are a future explicit feature, not an MVP
  scratchpad fallback.
- Treat scratchpads as share-friendly temporary scopes only for values whose
  storage facts allow sharing. Unique owners, active borrows, scratch-backed
  pointers, capabilities, and ownership-bearing closure slots still require
  path-sensitive ownership analysis inside the scratchpad.
- If optional regions are added later, mutation and layout work must treat them
  as explicit owner packages: values tied to the region cannot outlive the
  region owner, cleanup/drop facts are emitted for the owner, and moving the
  package participates in linear ownership analysis.
- Make linear participation storage/fact driven. Scalar and frozen/shareable
  values remain freely usable; unique heap owners, mutable capabilities,
  ownership-transfer arguments, `scratch_backed` values, and ownership-bearing
  closure slots participate in exact-use or move/consume analysis.
- Insert cleanup/reset edges from proof facts. Scratchpad reset emits real WAT;
  unique heap drops may initially lower to no-ops for the bump allocator but
  must still be represented in analysis.
- Preserve the Task 12 no-GC efficiency target: borrow/view syntax is
  analysis-only, scratch cleanup is a saved-pointer reset, freeze/promotion is
  the explicit copy point for sharing across lifetimes, and missing cleanup
  facts reject before WAT emission instead of selecting managed storage.
- When temporary cleanup is hard to prove, split the case by value category and
  escape shape or reject before WAT emission. Do not keep mutation or allocation
  cases accepted by adding a collector-backed cleanup path to the baseline.
- Add accepted/rejected analysis fixtures for mutation-adjacent ownership
  behavior: owner replacement, borrowed-owner barriers, frozen-value mutation,
  scratch-backed returns, and lowering-created temporaries. Accepted fixtures
  expose the facts WAT emission uses; rejected fixtures assert deterministic
  diagnostics.
- Classify every new memory/mutation case using the Task 12 authoritative
  no-GC acceptance matrix: accepted with proof facts, rejected with a named
  missing fact, or deferred to an explicit future region/managed-storage
  profile.
- Use the Task 12 proof-fixture shape before broadening mutation or allocation
  codegen. Accepted fixtures must keep `target_profile: "core-3-nonweb"` and
  `managed_storage: "disabled"` visible, rejected fixtures must name the first
  missing proof edge, and deferred fixtures must name the explicit future
  profile they require.
- For mutation-created and lowering-created temporaries, define the cleanup edge
  before accepting the codegen path. The cleanup edge may be a scratch reset,
  owner drop, ownership transfer, explicit freeze/promotion into persistent
  storage, or a proof that the value is scalar/frozen and needs no cleanup.
  Missing cleanup facts are a proof failure, not a reason to enable GC.
- Keep the remaining memory work split by value shape:
  runtime `Text`, runtime aggregate, runtime union payload, first-class closure
  environment, host/import boundary, and compiler-created temporary. Each shape
  should land as either an accepted no-GC proof fixture, a rejected diagnostic,
  or a future explicit profile note.
- For scratchpad mutation/allocation cases, prove the result before reset. A
  result that still points into scratch storage must be rejected unless an
  explicit freeze/promotion copy has moved every reachable text buffer,
  aggregate field, union payload, and closure environment slot into persistent
  or frozen storage.
- For ordinary unique owners, record drop facts on replacement, discard,
  transfer, return, scope exit, and early control-flow exits. These facts remain
  required even while the initial bump allocator lowers drops to no-op WAT.
- Implement compile-time layout helpers with `snake_case` names:

```txt
const layout = t => {
  if is_struct(t) {
    ...
  }

  if is_union(t) {
    ...
  }
}
```

- Support layout facts for Wasm:

```txt
user_layout.fields.name
user_layout.fields.age
user_layout.size
user_layout.align
```

- Implement compile-time `fail`, runtime `panic`, and recoverable errors through
  explicit unions such as `result_type`.

## Acceptance Criteria

- Pure struct updates do not mutate the original value.
- Frontend-known aggregate index assignment rebuilds the aggregate.
- Unknown or general memory-backed index assignment is rejected without
  linear/mutable facts; runtime `Text` byte assignment is the supported narrow
  memory-backed case.
- Scratchpad results are rejected when escape analysis cannot prove that the
  returned value is scalar, non-scratch-backed, frozen, or promoted.
- Attached-region results are not part of the MVP `scratch {}` semantics; they
  require an explicit future region-owner representation.
- Future explicit region-owner packages must prove value-to-region lifetime
  ties, cleanup/drop behavior, and move/consume behavior before any mutation or
  layout feature can depend on them.
- The default backend does not use a GC fallback for uncertain scratch escapes.
- The default backend also does not use a GC fallback for uncertain owner moves,
  active borrows, compiler-created temporaries, freeze/promotion, or unknown
  host/import escape behavior.
- Baseline proof output identifies the target as unmanaged/no-GC, for example
  with `managed_storage: "disabled"`, so an accepted fixture cannot hide a
  managed-storage fallback.
- Every accepted memory/mutation fixture includes proof facts for storage class,
  lifetime id, borrow/view validity, scratch escape, freeze/promotion,
  cleanup/drop/reset, and host-boundary behavior when relevant. Every rejected
  fixture names the missing edge.
- Accepted memory/mutation fixtures follow the Task 12 proof-fixture shape:
  source/Core snippet, no-GC target profile, storage rows, lifetime rows,
  borrow/scratch/freeze/promotion rows when relevant, cleanup/drop/reset rows,
  and lowered Core/WAT evidence that uses those rows.
- Unsupported memory/lifetime shapes are refined into smaller proof tasks or
  rejected with deterministic diagnostics; they are not accepted by hidden
  region attachment, implicit promotion, or managed storage.
- The baseline no-GC proof gate stays ahead of WAT emission with
  `managed_storage` disabled. Accepted mutation-adjacent fixtures expose the
  exact storage, lifetime, escape, borrow/view, scratch reset, freeze/promotion,
  and drop/cleanup facts used by codegen.
- Host/import bounded-borrow contracts are represented in Core proof output.
  Direct unique owners still cannot cross a host boundary without an explicit
  transfer contract; wrapping the owner in `borrow` may satisfy a bounded-borrow
  contract.
- Direct ownership-transfer contracts are represented in Core proof and drop
  output. They consume direct `unique_heap` owners and record `host_transfer`
  facts; borrowed views and scratch-backed values remain separate follow-up
  slices.
- Host-returned owner contracts are represented in Core proof, final-result, and
  drop output for imported pointer results marked as owned or frozen/shareable.
- Accepted ownership/mutation fixtures expose storage, lifetime, escape, borrow,
  cleanup, and drop facts before WAT emission.
- Unique heap values that are overwritten, discarded, or leave scope produce
  deterministic drop-plan entries, even when the initial bump allocator lowers
  those entries to no-ops.
- Borrowed values cannot be returned, captured by escaping closures, or used
  after their owner lifetime ends.
- Frozen values are immutable and shareable, and mutation through a frozen value
  or read-only borrow is rejected.
- Values with unique ownership, mutable capability facts, ownership-transfer
  facts, or future explicit region-owner packages participate in linear
  consume/move checking.
- Layout helpers can compute struct and union size/alignment.
- Compile-time `fail` reports a compiler error when executed during `comptime`
  or fact checking.
- Runtime `panic` remains a runtime trap.
- Recoverable errors use explicit union values.

## Verification

- Add tests for struct update lowering.
- Add tests for frontend-known aggregate index assignment.
- Add tests for invalid unknown or general memory-backed index update without
  mutation facts, plus runtime `Text` byte assignment.
- Add tests for `scratch {}` returning scalars, resetting storage on all exit
  edges, rejecting escaping borrows, and rejecting uncertain scratch-backed
  aggregate returns.
- Add future tests for explicit attached-region values only if named regions are
  added after scratchpad semantics are stable.
- Add tests for drop-plan entries on overwritten, discarded, and scope-ending
  unique heap owners.
- Add tests for `borrow` read-only views and `freeze` shareable values once the
  ownership layer is implemented.
- Add no-GC proof-gate tests showing accepted cases expose the required
  ownership facts and uncertain cases reject before WAT emission.
- Assert that accepted mutation, scratchpad, freeze, and temporary-cleanup
  fixtures keep managed storage disabled. Any case that would need GC to be
  correct belongs in a rejected diagnostic or future explicit managed-profile
  task, not in the baseline.
- Add one triage fixture for each new memory/lifetime shape: accepted with proof
  facts, rejected with a deterministic diagnostic, or explicitly deferred to a
  future region/managed-storage profile.
- Rejected fixtures should name the missing edge: scratch escape, borrow/view
  lifetime, freeze/promotion, host/import escape, or lowering-created temporary
  cleanup.
- Add host/import fixtures for known bounded-borrow imports, direct
  ownership-transfer imports, borrowed-view rejection for transfer, direct
  use-after-transfer diagnostics, deeper interprocedural transfer analysis, and
  unknown non-scalar import rejection.
- Add compile-time layout tests for structs and unions.
- Add tests distinguishing `fail`, `panic`, and `result_type`.

## Implementation Status

- Implemented pure struct updates by rebuild, including direct struct-update
  expressions and assignment syntax that shadows the source name without
  mutating earlier values.
- `Core.emit` rebuilds static-shaped struct update expressions and snapshots
  runtime update values in hidden locals so later shadowing does not affect the
  updated aggregate.
- Implemented frontend-known aggregate and typed runtime struct index assignment
  by rebuild/shadowing, including static and runtime index cases, runtime scalar
  payloads whose declared field types preserve the integer width, and declared
  or homogeneous visible `Text` fields as `i32` data-pointer selections.
- The `Source -> Core` structured path preserves unknown index assignments for
  later fact-directed memory/codegen work, and `Core.emit` applies static and
  dynamic index assignments to statically bound aggregate shapes by capturing
  runtime index and value expressions in hidden locals as needed. Visible `Text`
  update values remain visible to later text operations after the assignment and
  later shadowing. Inlineable static closures clone captured static aggregate
  shapes and static aggregate arguments per call before applying those rebuilds.
- `Core.emit` lowers runtime locals known to have type `Text` through
  bounds-checked byte index assignment using `i32.store8`, including lifted
  first-class closure bodies and captured runtime `Text` locals inside
  first-class closure environments, with WAT-to-Wasm coverage for successful
  mutation and out-of-bounds traps.
- Implemented compile-time layout helpers and structural layout facts for
  structs and unions.
- Implemented compile-time `fail`, runtime `panic` as an Ic trap primitive and
  Core WAT `unreachable`, and recoverable errors through explicit union values.
- Tests cover valid/invalid struct updates, frontend-known aggregate and typed
  runtime struct index assignment including runtime scalar payloads and visible
  text fields, invalid unknown index update reservation, structured-core unknown
  index assignment preservation, Core static-shaped struct update WAT lowering,
  Core static and dynamic aggregate index assignment WAT lowering including
  visible `Text` update values, runtime `Text` byte index assignment and
  out-of-bounds traps, captured static aggregate index assignment WAT lowering,
  captured runtime `Text` byte assignment through first-class closures, Core
  panic trap WAT lowering, layout facts, `fail`, `panic`, and
  `result_type`-style unions.
- General index assignment with linear/mutable memory facts is represented in
  `Core`. The first runtime aggregate memory-backed slice is implemented for
  stored unique aggregate pointers with known struct layouts and top-level
  scalar, `Text`, union-pointer, or inline nested aggregate fields: static
  indexes emit direct offset stores, dynamic indexes evaluate index/value once
  and trap on out-of-bounds indexes. Dynamic stores reject mixed
  scalar/`Text`/union-pointer/nested target field facts before WAT emission.
  Captured runtime aggregate scalar, `Text`, union-pointer, and inline nested
  mutation is supported through inline and first-class closures. Broader
  memory-backed mutation remains reserved for arrays/slices and reusable
  allocator/destructor cleanup. Static/frozen-shareable text bindings now stay
  immutable static data and reject indexed mutation with a deterministic
  frozen/shareable binding diagnostic instead of falling through to an unbound
  local error. Static-shaped aggregate bindings created through `freeze { ... }`
  now follow the same immutable compiler-fact path: field reads stay scalarized,
  the no-GC proof records an allowed frozen/shareable edge, and indexed mutation
  rejects before WAT emission.
- Core host/import bounded-borrow and direct ownership-transfer contracts are
  implemented as part of the no-GC proof surface. Known imports can declare
  scalar, bounded-borrow, or ownership-transfer arguments; bounded borrows
  accept explicit `borrow` views; ownership transfer consumes direct
  `unique_heap` owners and records `host_transfer` facts; proof output records
  the host-boundary signature and argument decision; direct use-after-transfer
  diagnostics reject later direct owner use; module emission writes the WAT
  import/call. Host-returned owners are implemented. Scratch-backed Core import
  arguments accept explicit bounded borrows and reject ownership transfer before
  WAT emission. Source-level contract syntax is implemented for scalar numeric
  ABI values, `Text` ownership contracts, explicit non-`Text` pointer owner
  reasons, and user-defined aggregate/union owner references; deeper
  interprocedural transfer analysis remains reserved.
- The planned general memory model is now unique-by-default runtime heap values,
  block/loop/call/scratchpad-bounded read-only `borrow` views, explicit `freeze`
  for immutable shareable values, and `scratch {}` as a temporary bump-allocated
  arena with a return value. The baseline policy is analysis-first: supported
  programs must have precise ownership, borrow, scratch escape, and cleanup
  facts before WAT emission; unsupported or uncertain cases reject rather than
  falling back to GC. Scratch reset must be emitted on all structured exit
  edges, while unique heap drop points may initially lower to no-ops for the
  bump allocator. A scratch result cannot carry an attached live region in the
  MVP; it must be scalar, frozen, promoted, proven scratch-free, or rejected.
  Scratchpads are the source-level ergonomic region for temporary work, not an
  implicit managed heap. Values produced there may be freely shared only when
  they are frozen/shareable or proven not to reference reset storage. Optional
  region-like scopes should reuse scratch/arena lifetime analysis, not implicit
  managed storage. Allocation sites should record their storage class and escape
  reason. `Core.drops(...)` now records deterministic analysis-only unique-heap
  drop facts for overwritten owners, discarded unique expressions, scope-ending
  owners, `return`/`break`/`continue` exits, terminal expression branches,
  branch assignments to existing unique owners, and closure-local owners in
  closure bodies, while the first bump allocator lowers those drops to no-ops.
  Direct named-owner discards and direct named-owner moves through static
  aliases now produce drop facts without forcing static owner values through
  runtime expression typing. Compile-time-only `const` values, including type
  values and const type-constructor results, are now kept in static drop context
  without creating runtime owners or requiring runtime expression typing. Direct
  block-expression result moves such as `{ f }`, discarded `{ f }`,
  `let g = { f }`, and block-local owner results now preserve owner facts across
  the block boundary. Expression-level `if` and `if let` branches now scan owner
  results path-sensitively, dropping non-selected owners in branch scopes and
  moving, escaping, or discarding the selected owner according to the
  surrounding expression context. Lowering-created temporaries still need full
  cleanup coverage from ownership facts. Unknown host/import calls should be
  treated as escaping unless their signature explicitly accepts a bounded
  borrow, and scratch-to-heap promotion must be an explicit Core step. GC is
  deferred out of the baseline backend; the remaining work is to complete the
  static proof surface for supported programs and reject missing proofs
  deterministically. Freeze of direct named, block-result, and branch-result
  unique owners is now modeled as consuming the source owner in the drop plan,
  including discarded, bound, block-wrapped, branch-local, returned, and
  self-shadowed freeze expressions, while broader immutable heap-copy/promotion
  codegen continues to land by value shape. Attached-region results remain a
  future explicit region-owner feature rather than part of MVP `scratch {}`
  semantics. Bounded unique-heap borrows for immediate read-only consumers are
  now accepted through the Core borrow gate. The same borrow gate now rejects
  named-owner and simple local alias move/replacement, index mutation, and
  `freeze` while a bounded borrow is active in that lexical scope. Stored
  borrow-view locals are now accepted when bounded to the current block, and
  returning, storing, or closure-capturing the view rejects with a borrow-escape
  diagnostic. Branches and loops that assign a stored borrow view into an outer
  name now merge that view fact back to the parent scope, so later owner
  mutation or view escape cannot ignore the branch/loop-created borrow. Direct
  field/index borrows and simple field-owner aliases, such as
  `borrow user.name`, `let name = user.name`, and aliases of those field values,
  now canonicalize back to the containing owner for borrowed-owner barriers.
  Replacing the aggregate or mutating through the field alias while the field
  borrow is active rejects. Branch, `if let`, and loop assignments into outer
  locals now merge field-owner aliases, including joins where a local may refer
  to more than one containing owner. Expression-valued `if` and `if let` results
  that return field aliases also preserve every possible containing owner for
  later borrow barriers. Expression-valued `if` and `if let` results that return
  stored borrow views now preserve those possible borrow views and protect their
  owners after the binding. Multi-statement block results that return field
  aliases or stored borrow views also carry that ownership fact to the outer
  binding. Field aliases assigned through block-prefix `if`, `if else`,
  `if let`, and loop statements are joined into the returned block result as
  possible containing owners. Runtime aggregate pointer materialization, stored
  pointer facts, nested aggregate field aliases, captured aggregate pointers,
  and direct scalar/Text field loads are now implemented for the persistent heap
  path. The first scratch-backed runtime aggregate slice also materializes
  temporary aggregates inside `scratch {}` on the scratch heap when the value
  dies before the scratch reset. Runtime text concatenation and runtime union
  value materialization now follow the same scratch heap path inside an active
  scratch body. Scalarized static-shaped aggregates, static union cases, and
  dynamic static-union `if` results with scratch-free conditions/payloads can
  now leave `scratch {}` as frozen/shareable proof edges. Heap-backed escaping
  aggregate/text/union values still reject until explicit freeze/promotion or
  field/value-level scratch-free proofs exist. General fact-directed memory
  mutation remains pending. Optional statement branches that contain `freeze`
  now produce conservative no-op bump drop facts for the paths where the branch
  may not run, including no-else `if` and typed `if let` bodies; conditional
  destructor emission for a future reusable allocator remains pending.
