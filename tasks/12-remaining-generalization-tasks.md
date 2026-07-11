# Remaining Generalization Tasks

## Goal

Refine the broad reserved surface into implementable tasks. These tasks are
based on the current code, diagnostics, and tests after the MVP source-to-Ic and
source-to-Core/Wasm work.

Target profile: `core-3-nonweb`. Use baseline structured Wasm control flow,
locals, linear memory, globals, tables, and indirect calls. Do not depend on
proposal-only Wasm features. The default backend is analysis-first: make
ownership/lifetime analysis complete for the supported source surface, and
reject uncertain escapes with deterministic diagnostics instead of adding a GC
fallback.

Resolved memory/lifetime decision:

- The active baseline is no-GC `core-3-nonweb`. Skipping GC is accepted only by
  making ownership, lifetime, escape, borrow, promotion, and cleanup analysis
  complete for the source shape being lowered.
- The implementation direction is to make that static analysis strong enough for
  every supported shape. A shape that cannot yet be proven is not accepted by
  adding GC; it is split into narrower proof fixtures, rejected with a named
  diagnostic, or deferred to an explicit future profile.
- Ordinary runtime heap values are `unique_heap` owners by default. They can be
  moved, returned, transferred, frozen, dropped, or borrowed, but not implicitly
  copied.
- `&value` and `let view = &value` create lexical read-only `borrow_view`
  values. They are runtime-free analysis facts; a live view blocks owner
  mutation, move, freeze, transfer, return, and escaping capture.
- `freeze value` consumes a unique owner and produces immutable
  `frozen_shareable` storage. This is the explicit copy/share boundary for data
  that must be duplicated or captured by reusable closures.
- `scratch { ... }` is the ergonomic temporary-computation arena. It returns a
  value, saves the scratch pointer on entry, resets on every exit edge, and is
  not a hidden attached region.
- A value can leave `scratch {}` only when it is scalar, already
  `frozen_shareable`, explicitly frozen/promoted into persistent storage, or
  proven scratch-free through every field, union payload, and closure capture.
- Cleanup for source values and compiler-created temporaries is inserted from
  static storage/lifetime facts. Valid outcomes are scratch reset, owner drop,
  ownership transfer, explicit freeze/promotion, returned owner, or a no-cleanup
  proof for scalar/frozen data.
- Linear/path-sensitive analysis is storage-driven. It applies to source `!`
  capabilities, `unique_heap` owners, active `borrow_view` barriers,
  `scratch_backed` values, and ownership-bearing closure slots; scalar and
  `frozen_shareable` values remain freely copyable.
- Optional longer-lived regions are future explicit owner packages with tied
  returned values, cleanup/drop facts, move/consume rules, ABI rules, and
  host-boundary rules. They are not inferred from ordinary `scratch {}`.
- There is no default GC or managed-storage repair task for `core-3-nonweb`. If
  analysis is too broad, split the source shape into narrower proof fixtures,
  reject deterministically before WAT emission, or defer it to an explicit
  future region/managed-storage profile.
- The active task queue is therefore analysis work, not collector selection.
  Every memory-heavy feature must name its storage category, owner/lifetime
  facts, borrow/view facts, scratch escape decision, freeze/promotion edge,
  cleanup/drop/reset action, accepted proof fixture, and nearest rejected proof
  fixture before codegen is broadened.
- Do not create umbrella tickets that say "solve with GC later" for scratch
  returns, temporary cleanup, closure environments, aggregates, unions, text, or
  host boundaries. If a collector-backed approach is wanted later, it starts as
  a separate named profile after the unmanaged baseline has a deterministic
  rejection fixture.

Feature classification for this task set:

- Baseline Wasm: structured control flow, locals, globals, tables, indirect
  calls, and linear memory.
- Source-language/static analysis: unique ownership, bounded borrows, frozen
  shareable values, scratchpad lifetimes, escape facts, promotion decisions, and
  cleanup insertion.
- Future separate target only: named region owner packages, managed storage,
  tracing GC, or Wasm-GC. They must not change the default linear-memory
  semantics or make an unproven baseline case accepted.

Current implementation handoff:

- Treat "skip GC if the analysis is proper" as the active baseline contract.
  There is no collector-backed repair path for the default `core-3-nonweb`
  backend.
- Make proof fixtures the next unit of work. Accepted fixtures must show
  `target_profile: "core-3-nonweb"`, `managed_storage: "disabled"`, storage
  rows, lifetime rows, borrow/view rows when relevant, scratch result rows when
  relevant, freeze/promotion rows when relevant, cleanup/drop/reset rows, and
  host-boundary rows when relevant.
- Rejected fixtures must name the first missing proof edge, such as
  `active_borrow`, `scratch_backed_result`, `missing_promotion`,
  `missing_temporary_cleanup`, or `unknown_host_boundary_ownership`.
- Deferred fixtures must name an explicit future profile. Longer-lived regions
  are future owner packages with tied returned values, cleanup/drop facts,
  move/consume rules, ABI rules, and host-boundary rules; ordinary `scratch {}`
  must not infer that package.
- Use this implementation order for the active queue: storage fact inventory,
  borrow/view lifetimes, scratch result proofs, freeze/promotion edges,
  temporary cleanup rows, storage-driven linear analysis, first-class closure
  storage, host/import ownership contracts, and the final no-GC WAT gate.

## Memory Fixture Source Forms

Use these concrete source forms when adding proof fixtures:

```txt
let view = borrow owner
let shared = freeze owner

let result = scratch {
  let tmp = make_value()
  tmp
}
```

The required accepted-fixture proof shape is:

```txt
target_profile: "core-3-nonweb"
managed_storage: "disabled"
storage_rows: [...]
borrow_view_rows: [...]
scratch_result_rows: [...]
freeze_promotion_rows: [...]
cleanup_rows: [...]
host_boundary_rows: [...]
```

Rows that are irrelevant to a fixture may be empty, but they should be present
so the proof gate cannot silently skip a category. The first rejected fixture
for each ticket should name the missing edge:

```txt
missing_edge: active_borrow
missing_edge: scratch_backed_result
missing_edge: missing_promotion
missing_edge: unknown_host_boundary_ownership
missing_edge: missing_temporary_cleanup
```

For `scratch {}` specifically, the result gate runs before the saved pointer is
reset. Accepted results are only `scalar_local`, `frozen_shareable`, explicitly
promoted persistent values, or values proven scratch-free through all fields,
union payloads, and closure captures. Raw `scratch_backed` text, aggregate,
union, or closure-environment escapes reject before WAT emission.

## Current No-GC Task Update

The latest memory decision is now part of the active task queue: skip GC in the
default backend only by making the static analysis precise enough. Do not add a
collector-backed accepted state while ownership, lifetime, escape, borrow,
freeze/promotion, or cleanup facts are missing.

Use these ticket boundaries for the next implementation work:

1. `ownership_fact_inventory`
   - Audit every currently accepted source-to-Core/Wasm path that touches
     runtime memory.
   - For each path, require visible rows for storage class, owner/lifetime ids,
     origin, escape/result decision, borrow/view state, scratch result decision,
     freeze/promotion edge, host-boundary contract when relevant, and
     cleanup/drop/reset/transfer behavior.
   - Any path without those rows either rejects before WAT emission or becomes a
     narrower follow-up ticket.

2. `borrow_view_lifetimes`
   - Keep `borrow owner` / `let view = borrow owner` as runtime-free lexical
     read-only views.
   - Add accepted and rejected fixtures for field views, payload views, branch
     merges, loops, closure captures, owner replacement, mutation, freeze,
     transfer, return, and unknown host-boundary passage.

3. `scratch_result_proofs`
   - Lower `scratch {}` as saved-pointer entry plus reset on every exit edge.
   - Check the returned value before reset. Accept only scalar,
     `frozen_shareable`, explicitly frozen/promoted, or transitively
     scratch-free values.
   - Split hard cases by runtime text, aggregate field, union payload, closure
     environment slot, and nested field/payload path.

4. `freeze_and_promotion_edges`
   - Make `freeze` and scratch-to-persistent promotion explicit Core copy edges,
     never WAT-emitter repairs.
   - Split copy fixtures by text bytes, aggregate fields, union payloads, and
     closure environment slots.

5. `temporary_cleanup_rows`
   - Insert cleanup for source values and lowering-created temporaries from the
     same proof rows.
   - Track temporaries from text operations, aggregate materialization, union
     payload construction, closure environment setup, host marshaling, and
     promotion.
   - Missing cleanup proof is a deterministic rejection or narrower proof task,
     not a default GC task.

6. `storage_driven_linear_analysis`
   - Run exact-use/path-sensitive checks for source `!` capabilities,
     `unique_heap` owners, live `borrow_view` barriers, `scratch_backed` values,
     and ownership-bearing closure slots.
   - Keep scalar locals and `frozen_shareable` values copyable.

7. `future_region_owner_packages`
   - Keep optional longer-lived regions as explicit future owner packages with
     region owners, tied returned values, cleanup/drop facts, move/consume
     rules, ABI rules, and host-boundary rules.
   - Ordinary `scratch {}` must not synthesize a hidden region package.

8. `no_gc_wat_gate`
   - Add a final pre-WAT proof gate for the unmanaged `core-3-nonweb` baseline.
   - Require `managed_storage: "disabled"` plus complete storage, lifetime,
     escape/result, borrow/view, scratch, freeze/promotion, host-boundary, and
     cleanup rows.
   - Reject missing proof rows before WAT emission instead of selecting a hidden
     region, GC, or managed-storage fallback.

Every ticket above closes in one of three states: accepted with proof rows and
`managed_storage: "disabled"`, rejected before WAT emission with a named missing
proof edge, or deferred to an explicit future region/managed-storage profile.

## Current Execution Split

Use this split for the next memory/lifetime implementation passes. It reflects
the chosen model: unique ownership by default, explicit frozen sharing,
runtime-free borrow/views, value-returning scratchpads, optional regions only as
future explicit owner packages, and no GC fallback in the default
`core-3-nonweb` backend.

1. `ownership_fact_inventory`
   - Normalize the proof rows used by allocation, borrow, drop, cleanup,
     transfer, host-boundary, closure, aggregate, text, and union passes.
   - Every row must name the storage class, owner id, lifetime id, origin,
     escape/result decision, and cleanup/drop/reset/transfer decision.
   - Accepted rows keep `managed_storage: "disabled"` visible.

2. `borrow_view_lifetimes`
   - Treat `borrow value` and `let view = borrow value` as analysis-only,
     read-only lexical views.
   - A live view blocks owner move, mutation, freeze, transfer, return, and
     escaping capture.
   - Cover direct owner views, field views, union payload views, branch joins,
     loop-carried views, and scratch-local views.

3. `scratch_result_proofs`
   - Keep `scratch {}` as a temporary scratchpad with a value result, not an
     attached region.
   - Emit saved-pointer reset edges on fallthrough, `return`, `break`, and
     `continue`.
   - Before reset, accept only scalar, already frozen/shareable, explicitly
     frozen/promoted, or transitively scratch-free results.

4. `freeze_and_promotion_edges`
   - Make `freeze` the explicit unique-to-immutable-shareable boundary.
   - Make scratch-to-persistent promotion an explicit Core copy edge before the
     scratch reset.
   - Split copies by text bytes, aggregate fields, union payloads, closure
     environment slots, and nested field/payload paths.

5. `temporary_cleanup_rows`
   - Insert cleanup for source owners and compiler-created temporaries from the
     same proof facts.
   - Track temporaries from text operations, aggregate materialization, union
     payload construction, closure environment setup, host marshaling, and
     freeze/promotion copies.
   - Missing cleanup proof rejects before WAT emission or becomes a narrower
     proof task.

6. `storage_driven_linear_analysis`
   - Run path-sensitive exact-use checks for source `!` capabilities,
     `unique_heap` owners, active `borrow_view` barriers, `scratch_backed`
     values, and ownership-bearing closure slots.
   - Keep scalar locals and `frozen_shareable` values freely copyable.

7. `future_region_owner_packages`
   - Defer longer-lived regions to an explicit owner-package feature.
   - A region package must carry the region owner, tied returned-value
     lifetimes, cleanup/drop facts, move/consume rules, ABI rules, and
     host-boundary rules.
   - Ordinary `scratch {}` must never infer or hide such a package.

8. `no_gc_wat_gate`
   - Keep tracing GC, managed storage, and Wasm-GC out of the baseline queue.
   - Require complete unmanaged proof rows before WAT emission for the default
     backend.
   - If we want a collector-backed target later, define it as a named future
     profile with separate Core representation, proof output, ABI rules, and
     tests; do not use that future profile to make an unproven baseline case
     accepted.

## No-GC Milestone Order

Use this order when turning the selected memory model into implementation work.
The order matters because later passes should consume proof rows instead of
rediscovering ownership facts or repairing missing lifetimes during WAT
emission.

1. Define the proof row schema and diagnostics.
   - Rows must cover storage class, owner id, lifetime id, origin, escape/result
     decision, borrow/view state, scratch decision, freeze/promotion edge,
     cleanup/drop/reset/transfer decision, and `managed_storage: "disabled"`.
   - Rejections should name the first missing edge, not a generic memory error.

2. Audit current WAT-emitting memory paths.
   - Classify text, aggregate, union, closure, host-boundary, and temporary
     paths as accepted with rows, rejected with a named gap, or deferred to a
     future profile.
   - Do not broaden emission for a path that still lacks storage or cleanup
     rows.

3. Implement lexical borrow/view barriers.
   - `borrow owner` and borrowed field/payload views are runtime-free,
     read-only, and tied to the owner lifetime.
   - While a view is live, reject owner mutation, move, freeze, transfer,
     return, escaping closure capture, and unknown non-scalar host passage.

4. Implement `scratch {}` lowering and the result gate.
   - Emit saved-pointer reset edges for fallthrough, `return`, `break`, and
     `continue`.
   - Check the returned value before reset. Accept scalar, frozen/shareable,
     explicitly frozen/promoted, or transitively scratch-free values; reject raw
     scratch-backed text, aggregate, union, and closure results.

5. Add explicit freeze and promotion copies.
   - `freeze` consumes a unique owner and produces immutable shareable storage.
   - Scratch-to-persistent promotion is an explicit Core copy edge shaped by
     layout for text bytes, aggregate fields, union payloads, and closure
     environment slots.

6. Insert temporary cleanup from proof rows.
   - Cover source owners and compiler-created temporaries from text operations,
     aggregate materialization, union payload construction, closure environment
     setup, host marshaling, and promotion.
   - Initial unique drops may still lower to no-op WAT for the bump allocator,
     but the drop or no-cleanup decision must be visible.

7. Make closure storage ownership-aware per slot.
   - Capture-free closures are code/table values.
   - Reusable captured closures may store only scalar or frozen/shareable slots.
   - Unique, borrowed, scratch-backed, capability, or nested ownership-bearing
     captures require linear closure support or deterministic rejection.

8. Extend host/import ownership contracts.
   - Accept non-scalar boundaries only with bounded-borrow, frozen/shareable,
     ownership-transfer, or host-returned-owner contracts.
   - Keep unknown non-scalar imports rejected before WAT emission.

9. Keep regions and managed storage as future profiles.
   - Longer-lived regions require explicit region-owner packages with tied
     returned values, cleanup/drop facts, move/consume rules, ABI rules, and
     host-boundary rules.
   - GC, managed storage, and Wasm-GC require named target profiles with
     separate Core representation and tests; they are not fallback paths for the
     baseline.

## Authoritative Memory/Lifetime Contract

This section is the current source of truth for memory/lifetime work. Later
sections may keep older research notes or detailed implementation history, but
new task refinement should follow this contract when deciding what is accepted,
rejected, or deferred.

The chosen baseline is static proof, not GC. Keep `core-3-nonweb` unmanaged and
skip GC only by making the ownership/lifetime analysis complete for each
accepted source shape. A hard case is not accepted by letting a collector,
hidden attached region, implicit promotion, or runtime-discovered cleanup decide
later.

This supersedes any older notes that treated GC as a fallback for scratchpad
returns, compiler-created temporaries, closure environments, aggregate fields,
union payloads, text buffers, host-boundary values, or cleanup insertion. If a
case is too hard to prove, refine it into a smaller ownership/lifetime task,
reject it before WAT emission with a named proof gap, or defer it to an explicit
future region/managed-storage profile.

Required storage categories:

- `scalar_local`: copyable scalar values with no runtime cleanup.
- `unique_heap`: ordinary owned runtime heap values.
- `borrow_view`: read-only non-owning views tied to an owner lifetime.
- `frozen_shareable`: immutable runtime values that can be duplicated freely.
- `scratch_backed`: values tied to an active `scratch {}` lifetime.

Required source model:

- `borrow owner` and `let view = borrow owner` create lexical read-only views. A
  live view blocks owner move, mutation, freeze, transfer, return, and escaping
  capture.
- `freeze owner` consumes a unique owner and produces immutable
  `frozen_shareable` storage.
- `scratch { ... }` is a lexical scratchpad with a value result. It saves a
  scratch pointer on entry, resets on every exit edge, and never returns an
  implicit attached region.
- Values leaving `scratch {}` must be scalar, already frozen/shareable,
  explicitly frozen/promoted into persistent storage, or proven scratch-free at
  the value, field, payload, and closure-capture level.
- Cleanup for scratch storage is the reset edge. Cleanup for unique owners and
  lowering-created temporaries is inserted from static storage/lifetime facts; a
  missing cleanup decision is a proof gap, not a reason to enable GC.
- Optional longer-lived regions are not part of ordinary `scratch {}`. If they
  are added later, they must be explicit owner packages with tied returned
  values, cleanup/drop facts, move/consume rules, ABI rules, and host-boundary
  rules.
- Linear/path-sensitive analysis applies only to source `!` capabilities,
  `unique_heap` owners, active `borrow_view` barriers, `scratch_backed` values,
  and closure slots containing those values.

Required task split:

1. Storage fact inventory: give every non-scalar source value and
   compiler-created temporary a storage class, owner id, lifetime id, origin,
   escape decision, and cleanup/drop/reset decision.
2. Borrow/view pass: implement lexical view lifetimes and owner barriers for
   fields, branches, loops, closures, and host/import calls.
3. Scratchpad lowering: emit saved-pointer reset edges for fallthrough,
   `return`, `break`, and `continue`, then check the value result before reset.
4. Scratch escape proof: split text, aggregate, union, closure, field, payload,
   and capture shapes until each escape is proven scratch-free, explicitly
   promoted/frozen, or rejected.
5. Freeze and promotion: make every cross-lifetime share an explicit Core copy
   edge, shaped by layout for text bytes, aggregate fields, union payloads, and
   closure environment slots.
6. Temporary cleanup: record cleanup/drop/transfer/no-cleanup facts for
   lowering-created temporaries from aggregate materialization, text operations,
   union payload construction, closure environment setup, host marshaling, and
   promotion.
7. Closure capture ownership: reusable closures may capture scalar or
   frozen/shareable slots; unique, borrow, scratch-backed, capability, or
   ownership-bearing slots require linear closure support or deterministic
   rejection.
8. Host/import contracts: continue bounded-borrow, frozen/shareable,
   ownership-transfer, and host-returned-owner contracts through wrappers and
   interprocedural static calls; reject unknown non-scalar boundaries.
9. Future profiles: keep named arenas, attached-region return packages, reusable
   allocators, destructors, tracing GC, managed storage, and Wasm-GC as explicit
   future profiles with separate Core representation, ABI, proof output, and
   tests.

Required implementation order:

1. Classify storage first. Before broadening codegen for a value shape, attach
   `scalar_local`, `unique_heap`, `borrow_view`, `frozen_shareable`, or
   `scratch_backed` facts to source values and lowering-created temporaries.
2. Assign owner and lifetime ids next. This includes owner ids for unique
   values, view lifetimes for borrows, scratch lifetime ids, frozen storage
   origins, and closure-environment slot ownership.
3. Run borrow/view barriers before move-like operations. A live view blocks
   owner mutation, move, freeze, transfer, return, escaping capture, and unknown
   host-boundary use until the lexical view lifetime ends.
4. Lower `scratch {}` as saved-pointer plus reset edges before WAT emission. The
   value result is checked before reset and must be scalar, frozen/shareable,
   explicitly frozen/promoted, or proven scratch-free through every reachable
   field, payload, and closure-capture slot.
5. Emit freeze and promotion as explicit Core copy edges at the lifetime
   boundary. The copy is shaped by layout for text bytes, aggregate fields,
   union payloads, and closure environment slots.
6. Insert cleanup from the same facts. Valid cleanup outcomes are scratch reset,
   owner drop, ownership transfer, explicit freeze/promotion, return of the
   owner, or a no-cleanup proof for scalar and frozen/shareable values.
7. Run the final no-GC proof gate before both pure-Ic and structured Core/Wasm
   emission. If any storage, lifetime, borrow, scratch result, freeze/promotion,
   host-boundary, or cleanup row is missing, reject with a named proof gap or
   defer to a future explicit region/managed-storage profile.

Confirmed immediate backlog from this decision:

1. Add proof fixtures for borrow/view barriers, including owner replacement,
   mutation, freeze, transfer, return, closure capture, and host-boundary
   rejections while a view is live.
2. Finish `scratch {}` result analysis for scalar, frozen/shareable, explicit
   promotion, text, aggregate, union payload, and closure-capture shapes.
3. Broaden explicit `freeze` and scratch-to-persistent promotion copies across
   runtime text, aggregates, unions, and first-class closure environments.
4. Add cleanup/drop/transfer/no-cleanup rows for lowering-created temporaries
   from text operations, aggregate materialization, union payload construction,
   closure environment setup, host marshaling, and promotion.
5. Make first-class closure storage per-slot: reusable only for scalar or
   frozen/shareable captures; linear or rejected for unique, borrow,
   scratch-backed, capability, or nested ownership-bearing captures.
6. Extend host/import contracts for bounded borrows, frozen/shareable values,
   ownership transfer, and host-returned owners through wrappers and
   interprocedural static calls.
7. Keep optional named regions, reusable allocators/destructors, tracing GC,
   managed storage, and Wasm-GC in future explicit profiles, not as hidden
   fallbacks for baseline proof gaps.

Each slice is done only when it is accepted with proof rows and
`managed_storage: "disabled"`, rejected before WAT emission with a named missing
fact, or deferred to a future explicit profile.

Latest decision update:

- Treat the no-GC baseline as a required proof gate, not as an optimization
  preference. A memory/lifetime feature is accepted only when the static
  ownership analysis can prove its storage, lifetime, escape, borrow,
  freeze/promotion, and cleanup facts.
- If a supported shape is hard to analyze, split it into narrower tasks by
  storage class and escape path until it is accepted with proof rows or rejected
  with a deterministic diagnostic. Do not keep it accepted by letting GC, hidden
  attached regions, implicit promotion, or runtime-discovered cleanup decide
  later.
- `scratch { ... }` remains a value-returning scratchpad for temporary
  computation. It resets on all exit edges, and its result is checked before
  reset. A result may escape only as scalar, already frozen/shareable,
  explicitly frozen/promoted, or proven scratch-free through fields, payloads,
  and closure captures.
- Optional regions remain future explicit owner packages. A region-returning
  value must carry the region owner and its cleanup/drop/move facts; ordinary
  `scratch {}` never infers that package.
- Linear analysis is storage-driven. It applies to source `!` capabilities,
  unique owners, live borrow barriers, scratch-backed values, and
  ownership-bearing closure slots, while scalar and frozen/shareable values stay
  freely copyable.

No-GC implementation refinement:

- Accepted `core-3-nonweb` programs should not need a collector to repair
  ownership, temporary cleanup, closure environments, aggregate fields, union
  payloads, text buffers, or host-boundary values. The proof pass must make the
  lifetime and cleanup decision before WAT emission.
- Treat `scratch {}` as a share-friendly temporary arena only inside its lexical
  body. It saves a pointer on entry, resets on every exit, and checks the
  returned value before reset. Returning a value tied to scratch storage is
  accepted only through scalarization, existing frozen/shareable ownership,
  explicit freeze/promotion, or a transitive scratch-free proof.
- Insert cleanup for source values and compiler-created temporaries from the
  same ownership rows. A cleanup row can be a scratch reset, owner drop,
  ownership transfer, freeze/promotion, or explicit no-cleanup decision for
  scalar/frozen data. If none can be proven, the case stays open or rejects.
- Keep optional longer-lived regions as a future explicit owner-package task. A
  region package must carry a region owner, tied returned-value lifetimes,
  cleanup/drop facts, move/consume rules, ABI rules, and host-boundary rules.
  Ordinary `scratch {}` must not synthesize this package implicitly.
- A future GC or managed-storage backend may exist, but only as a named target
  profile with separate representation and tests. It is not an implementation
  step for the default linear-memory backend.

Final planning note:

- There is no active GC implementation task for the default `core-3-nonweb`
  backend. Skip GC by making the static ownership/lifetime analysis complete for
  the accepted source surface.
- Do not keep a case accepted by saying a future collector will clean up
  scratch-backed values, source owners, lowering-created temporaries, closure
  environments, aggregate fields, union payloads, text buffers, or host-boundary
  values. Missing cleanup or escape proof means the slice is still open.
- The only baseline outcomes are: accepted with proof rows and
  `managed_storage: "disabled"`, rejected before WAT emission with a named proof
  gap, or deferred to a future explicit region/managed-storage profile.
- `scratch { ... }` remains a lexical scratchpad with a value result. It may be
  used for share-friendly temporary computation, but its result must be scalar,
  frozen/shareable, explicitly frozen/promoted, or proven scratch-free before
  reset.
- Optional longer-lived regions remain explicit future owner packages with tied
  returned values, cleanup/drop facts, and move/consume rules. They are not
  inferred from ordinary `scratch {}`.

## Active Acceptance Gate

The current baseline is analysis-complete no-GC lowering. A memory/lifetime
slice is ready for WAT only when static proof has classified storage, lifetime,
borrow/view state, scratch escape, freeze/promotion, host-boundary behavior when
relevant, and cleanup/drop/reset behavior for every source value and
compiler-created temporary it touches.

Resolved implementation direction from the scratchpad/lifetime discussion:

- Do not add a GC task to finish the baseline. The work is to make the static
  analysis precise enough to insert cleanup for source values and
  compiler-created temporaries.
- `scratch { ... }` is the temporary scratchpad primitive: it returns a value,
  uses saved-pointer reset on every exit edge, and never keeps an attached live
  region after reset.
- A scratch result can leave only through scalar/frozen data, explicit
  freeze/promotion, or a transitive scratch-free proof. If that cannot be
  proven, reject before WAT emission.
- Optional longer-lived regions stay future explicit owner packages with tied
  values, cleanup/drop facts, and move/consume rules; they are not inferred from
  ordinary scratchpads.
- Each remaining memory-heavy task should split by storage class and escape
  shape until it has an accepted no-GC proof fixture, a deterministic rejected
  fixture, or an explicit future region/managed-storage profile.

This is now a design lock for the active task set: skip GC by proving the
supported language surface, not by leaving hard cases to runtime management. The
review question for each memory task is therefore "which proof row accepts or
rejects this shape?", not "which collector should own it?".

When a case is hard, do not add a collector-backed fallback to make it accepted.
Split it by storage category and escape shape until it becomes one of:

- accepted with proof rows and `managed_storage: "disabled"`;
- rejected before WAT emission with a diagnostic naming the missing proof edge;
- deferred to a future explicit region or managed-storage profile.

The active implementation model is unique-by-default runtime heap ownership,
lexical `borrow`/view syntax for read-only non-owning access, explicit `freeze`
for immutable shareable values, value-returning `scratch {}` scratchpads with
saved-pointer reset, proof-driven cleanup insertion for source values and
lowering-created temporaries, and storage-driven linear participation only for
capabilities, unique owners, active borrow barriers, scratch-backed values, and
ownership-bearing closure slots.

Optional longer-lived regions remain useful future work, but only as explicit
region-owner packages with tied return values, cleanup/drop facts, and
move/consume rules. Ordinary `scratch {}` never returns a hidden live region,
and GC is not the baseline tie-breaker for hard scratchpad, temporary, closure,
aggregate, union, text, borrow, host-boundary, or cleanup cases.

Current handoff from the memory decision:

- Treat the Task 12 tickets below as the active implementation queue, not as
  research notes. The work is to make ownership/lifetime analysis precise enough
  for accepted `core-3-nonweb` cases.
- If a ticket is too broad, split it by storage category and escape path until
  it has an accepted proof fixture, a deterministic rejected fixture, or an
  explicit future region/managed-storage profile.
- Do not add a collector-backed accepted state for temporary cleanup, scratchpad
  results, closure environments, aggregate fields, union payloads, text buffers,
  borrows, or host boundaries.

## Proof Fixture Shape

Every remaining memory/lifetime implementation slice should add proof fixtures
before broadening WAT emission. This is the concrete harness for the no-GC
decision.

Accepted fixtures must expose:

- the source or Core snippet being accepted;
- `target_profile: "core-3-nonweb"`;
- `managed_storage: "disabled"`;
- one row per non-scalar source value and lowering-created temporary, including
  storage class, owner id, lifetime id, origin, escape decision, and
  cleanup/drop/reset/transfer decision;
- borrow/view rows for every lexical view, including owner, lifetime, and the
  blocked operations while the view is live;
- scratch rows for every `scratch {}` scope, including saved-pointer entry,
  every reset edge, and the result decision before reset;
- explicit `freeze` or promotion rows for values crossing a lifetime boundary as
  immutable shareable data;
- host/import boundary rows for non-scalar arguments or results; and
- enough WAT or lowered-Core evidence to show that codegen consumes those rows
  rather than inventing cleanup later.

Rejected fixtures must name the first missing or invalid proof edge, such as
active borrow, scratch-backed result, missing promotion, missing temporary
cleanup, unsupported ownership-bearing closure capture, or unknown host/import
boundary. They must reject before WAT emission.

Deferred fixtures must name the future profile they need, such as explicit
region-owner packages, reusable allocator/destructor support, tracing GC,
managed storage, or Wasm-GC. A deferred fixture is not accepted by the baseline
emitter.

## First Proof Fixtures To Add

Start implementation with these fixture groups. Each group should include the
smallest accepted program that exposes the proof rows and the nearest rejected
program that names the missing ownership/lifetime edge.

1. Borrow/view barriers
   - Accept a lexical read-only `borrow` used for scalar or frozen reads while
     the owner remains live.
   - Reject owner move, mutation, freeze, return, transfer, escaping capture, or
     unknown host-boundary use while the borrow view is live.

2. Scratchpad scalar and frozen results
   - Accept `scratch { ... }` results that are scalar or already
     `frozen_shareable`.
   - Accept explicit `freeze` or promotion before scratch reset when the result
     must outlive the scratchpad.
   - Reject raw `scratch_backed` text, aggregate, union, or closure results that
     would require a hidden attached region or collector.

3. Aggregate and union scratch escapes
   - Accept aggregate fields and union payloads only when every slot is scalar,
     frozen/shareable, explicitly promoted, or proven scratch-free.
   - Reject the first field, payload, or nested capture that still points into
     scratch storage at the reset boundary.

4. Lowering-created temporary cleanup
   - Accept text, aggregate, union, closure-environment, host-marshaling, and
     promotion temporaries only when each temporary has a lifetime end and a
     cleanup, transfer, freeze, reset, drop, or no-cleanup row.
   - Reject WAT emission when a temporary would rely on runtime-discovered
     cleanup or GC.

5. First-class closure storage
   - Accept capture-free closures as code pointer/table-index values with no
     heap environment.
   - Accept reusable captured closures only with scalar or frozen/shareable
     environment slots.
   - Require linear closure support or reject when a closure captures a unique
     owner, live borrow view, scratch-backed value, capability, or nested
     ownership-bearing closure.

6. Host/import ownership contracts
   - Accept non-scalar host/import boundaries only with explicit bounded-borrow,
     frozen/shareable, ownership-transfer, or host-returned owner contracts.
   - Reject unknown non-scalar boundaries before WAT emission.

7. Future explicit region packages
   - Defer longer-lived region returns until they have explicit region owner
     values, tied returned lifetimes, cleanup/drop facts, move/consume rules,
     ABI rules, and host-boundary rules.
   - Do not infer this package from ordinary `scratch {}`.

## Confirmed No-GC Implementation Queue

This is the current task queue from the memory/lifetime decision. These are
implementation tasks for the baseline, not open design choices.

1. Proof-gate audit
   - Audit every accepted source-to-Core/Wasm path that touches runtime memory.
   - A path is accepted only when proof rows show storage class, owner/lifetime
     ids, borrow/view state, scratch reset/result decision, freeze/promotion
     edge, host-boundary contract when relevant, and cleanup/drop/transfer
     behavior.
   - Missing rows keep the case out of WAT emission until the proof exists or
     the compiler rejects it deterministically.

2. Ownership and borrow facts
   - Keep runtime heap values `unique_heap` by default.
   - Keep `borrow owner` and `let view = borrow owner` as lexical, read-only,
     runtime-free views.
   - A live view blocks owner mutation, move, transfer, freeze, return, and
     escaping closure capture.

3. Scratchpad result analysis
   - Keep `scratch { ... }` as the ergonomic temporary scratchpad with a value
     result and saved-pointer reset on every exit edge.
   - Check the result before reset. Accept only scalar, already frozen,
     explicitly frozen/promoted, or proven scratch-free values.
   - Do not attach a hidden region to a scratch result.

4. Freeze, promotion, and cleanup insertion
   - Make `freeze` and scratch-to-persistent promotion explicit Core copy edges
     before the lifetime boundary.
   - Insert cleanup for source values and compiler-created temporaries from the
     same storage/lifetime facts.
   - Track temporaries from text work, aggregate materialization, union payload
     construction, closure environment setup, host marshaling, and promotion.

5. Storage-driven linear participation
   - Apply path-sensitive linear analysis only to source `!` capabilities,
     `unique_heap` owners, active `borrow_view` barriers, `scratch_backed`
     values, and closure slots containing those values.
   - Scalars and `frozen_shareable` values remain freely copyable/shareable.

6. Future explicit regions and managed storage
   - Optional longer-lived regions are future explicit owner packages with tied
     return values, cleanup/drop facts, move/consume rules, ABI rules, and
     host-boundary rules.
   - GC, managed storage, and Wasm-GC stay outside the active `core-3-nonweb`
     queue. If a supported shape is too hard, split it into a smaller proof
     fixture or reject it before WAT emission.

## Concrete Memory/Lifetime Tickets

Track the selected memory model through these concrete tickets. Each ticket must
land with accepted and rejected proof fixtures before WAT emission is broadened
for that shape. The default answer to uncertain lifetime or cleanup cases is not
GC; it is a smaller proof ticket, a deterministic pre-WAT rejection, or a future
explicit region/managed-storage profile.

For each ticket, the implementation harness should include:

- a source or Core fixture that is accepted with
  `target_profile:
  "core-3-nonweb"` and `managed_storage: "disabled"`;
- visible proof rows for the storage/lifetime facts the emitter consumes;
- the nearest rejected source or Core fixture with a diagnostic naming the first
  missing or invalid proof edge; and
- a WAT or lowered-Core check only after the proof rows exist.

1. `ownership_fact_inventory`
   - Add a proof row for every non-scalar source value and lowering-created
     temporary.
   - Rows must include storage class, owner id, lifetime id, origin,
     escape/result decision, and cleanup/drop/reset/transfer decision.
   - Include temporaries from text concat/copy/slice, aggregate materialization,
     union payload construction, closure environment setup, host marshaling, and
     freeze/promotion copies.

2. `borrow_view_lifetimes`
   - Treat `borrow value` as a lexical read-only view with no runtime storage.
   - While a view is live, reject owner mutation, move, transfer, freeze,
     return, escaping closure capture, and unknown host/import passage.
   - Cover direct owners, field views, union payload views, branch merges, loop
     edges, and scratchpad scopes.

3. `scratch_result_proofs`
   - Keep `scratch { ... }` as a value-returning scratchpad with saved-pointer
     reset on fallthrough, `return`, `break`, and `continue`.
   - Before reset, classify the result as scalar, `frozen_shareable`, explicitly
     frozen/promoted, proven scratch-free, or rejected.
   - Split escape fixtures by runtime `Text`, aggregate fields, union payloads,
     first-class closure captures, and nested field/payload paths.

4. `freeze_and_promotion_edges`
   - Make `freeze value` consume a unique owner and create immutable
     `frozen_shareable` storage.
   - Make scratch-to-persistent promotion an explicit Core copy edge before the
     scratch reset.
   - Preserve frozen/shareable facts through fields, union payloads, and closure
     environment slots so reusable closure captures remain copy-safe.

5. `temporary_cleanup_rows`
   - Insert cleanup from proof facts for source owners and compiler-created
     temporaries.
   - Valid cleanup outcomes are scratch reset, owner drop, ownership transfer,
     explicit freeze/promotion, or proven no-cleanup for scalar/frozen values.
   - Missing cleanup facts must reject before WAT emission instead of selecting
     managed storage.

6. `storage_driven_linear_analysis`
   - Apply exact-use/path-sensitive checks to source `!` capabilities,
     `unique_heap` owners, live `borrow_view` barriers, `scratch_backed` values,
     and closure slots containing ownership-bearing values.
   - Keep scalar locals and `frozen_shareable` values copyable.
   - First-class closures are reusable only when every captured slot is scalar
     or frozen/shareable; owned, borrowed, scratch-backed, capability, or nested
     ownership-bearing captures need linear closure support or rejection.

7. `future_region_owner_packages`
   - Defer longer-lived regions to an explicit owner-package feature.
   - A region package must carry the region owner, values tied to that owner,
     cleanup/drop facts, move/consume rules, ABI rules, and host-boundary rules.
   - Ordinary `scratch {}` must not infer this package, and GC is not a fallback
     for scratch result uncertainty.

8. `no_gc_wat_gate`
   - Run after ownership, borrow, scratch, freeze/promotion, cleanup, and
     host-boundary proof rows have been assembled.
   - Accepted fixtures must expose `target_profile: "core-3-nonweb"` and
     `managed_storage: "disabled"`.
   - Rejected fixtures must name the first missing proof edge before WAT
     emission.

## Immediate Task Split From Memory Decision

Use this split when turning the no-GC decision into implementation work. The
baseline goal is not to add a collector; it is to make each accepted memory
shape statically explain itself.

1. Storage fact inventory
   - Audit every WAT-emitting path that can allocate, move, borrow, freeze,
     return, drop, or transfer non-scalar data.
   - Add or require proof rows for storage class, owner id, lifetime id, origin,
     escape decision, and cleanup/drop/reset decision.
   - Keep accepted fixtures visibly on `managed_storage: "disabled"`.

2. Borrow/view lifetime pass
   - Implement `borrow value` and `let view = borrow value` as lexical,
     read-only, runtime-free views.
   - Reject owner move, mutation, freeze, transfer, return, or escaping capture
     while a view is live.
   - Split field and payload views so a borrowed projection still protects the
     containing owner.

3. Scratchpad lowering and result gate
   - Lower `scratch { ... }` to saved scratch pointer plus reset edges on
     fallthrough, `return`, `break`, and `continue`.
   - Check the value result before reset and accept only scalar,
     `frozen_shareable`, explicitly frozen/promoted, or proven scratch-free
     values.
   - Reject any result that would need a hidden attached region or collector to
     survive the reset.

4. Explicit freeze and promotion
   - Make `freeze value` consume a unique owner and produce immutable shareable
     storage.
   - Make scratch-to-persistent promotion an explicit Core copy edge before the
     scratch reset.
   - Split promotion fixtures by runtime text, aggregate, union payload, closure
     environment, and nested field/payload shape.

5. Temporary cleanup insertion
   - Track compiler-created temporaries from text operations, aggregate
     materialization, union payload construction, closure environment setup,
     host marshaling, and promotion copies.
   - Give each temporary a lifetime end and a cleanup, transfer, freeze, reset,
     drop, or no-cleanup decision before WAT emission.
   - Treat a missing temporary cleanup decision as a proof gap, not a reason to
     introduce GC.

6. Storage-driven linear analysis
   - Reuse path-sensitive linear machinery for source `!` capabilities,
     `unique_heap` owners, active `borrow_view` barriers, `scratch_backed`
     values, and ownership-bearing closure slots.
   - Do not run exact-use checks for scalar locals or `frozen_shareable` values.
   - Make closure environments either reusable with scalar/frozen slots, linear
     with owned slots, or rejected when borrow/scratch lifetimes cannot be
     proven.

7. Future-only region and managed profiles
   - Keep optional longer-lived regions as explicit owner-package tasks with
     tied returned values, cleanup/drop facts, move/consume rules, ABI rules,
     and host-boundary rules.
   - Keep managed storage, tracing GC, and Wasm-GC as separate target profiles
     with their own Core representation and tests.
   - Do not let those profiles act as hidden fallbacks for the baseline.

## Current Decision Record

This is the decision to preserve when refining the remaining memory tasks:

- Use unique ownership for ordinary runtime heap values.
- Use `borrow owner` / `let view = borrow owner` for read-only lexical views.
- Use `freeze owner` to turn a unique owner into immutable shareable storage.
- Use `scratch { ... }` as the ergonomic scratchpad for temporary shareable
  computation. It returns a value, resets on every exit edge, and never attaches
  a hidden live region to that value.
- Treat scratchpads as temporary allocation scopes first, not general lifetime
  regions. The efficient baseline shape is a saved scratch pointer on entry,
  ordinary work inside the scope, and reset on all exits after the result has
  been proven independent of scratch storage or explicitly promoted.
- Insert cleanup/drop/reset decisions from static ownership and lifetime facts,
  including compiler-created temporaries.
- Apply path-sensitive linear analysis only to values whose storage or effect
  role requires it: source `!` capabilities, `unique_heap` owners, active
  `borrow_view` barriers, `scratch_backed` values, and ownership-bearing closure
  slots.
- Skip GC for the baseline. If analysis is not precise enough, split the case
  until it becomes an accepted proof fixture, a deterministic rejection, or a
  future explicit region/managed-storage profile.
- The no-GC choice is conditional on this analysis being complete. A hard case
  should create a narrower ownership/lifetime task; it should not stay accepted
  by leaving cleanup, scratch escape, or temporary lifetime decisions to a
  collector.
- Do not open a baseline GC task for hard cleanup, scratch, borrow, aggregate,
  union, text, host-boundary, or closure-capture cases. The baseline work is to
  make the static proof precise enough, or to keep the unsupported shape
  rejected before WAT emission.
- Treat "analysis is complete enough" as the condition for accepting a baseline
  slice. GC is not the tie-breaker for a difficult scratchpad, temporary,
  borrow, closure, aggregate, union, text, or host-boundary case. When the
  static proof is not complete, keep the task open, split it smaller, or reject
  with a named proof gap.
- Treat optional longer-lived regions as future explicit owner packages. A
  returned value tied to a region must carry that region owner and its cleanup
  facts; ordinary `scratch {}` results do not get this behavior implicitly.
- A future region-return feature should return or carry the region owner
  explicitly, with values tied to that owner. Dropping or consuming the owner is
  what ends the region; this is separate from the MVP `scratch {}` reset model.

Latest scratchpad/no-GC refinement:

- `scratch { ... }` is the temporary-computation surface for the baseline. It
  may allocate share-friendly temporary values, but it returns an ordinary value
  and resets before that value can observe scratch-backed storage.
- A value leaving `scratch {}` must be classified before reset as scalar,
  already frozen/shareable, explicitly frozen/promoted into persistent storage,
  proven scratch-free through every field/payload/capture slot, or rejected.
- Do not use GC as the answer to hard scratchpad result analysis. If a result or
  compiler-created temporary is hard to analyze, split the shape until it has a
  proof row, reject it with a named missing edge, or defer it to an explicit
  future region/managed-storage profile.
- Cleanup insertion is proof-driven for source values and lowering-created
  temporaries. Every temporary from aggregate materialization, text
  copy/concat/slice work, union payload construction, closure environment setup,
  host marshaling, or promotion must have a storage class, lifetime end, and
  cleanup/transfer/no-cleanup decision before WAT emission.
- Linear/path-sensitive analysis is applied only where storage or effects need
  it: source `!` capabilities, `unique_heap` owners, live `borrow_view`
  barriers, `scratch_backed` values, and closure slots that contain those
  values. Scalars and `frozen_shareable` values remain freely copy/share.
- Optional longer-lived regions remain future explicit owner packages. They are
  not inferred from `scratch {}` and do not rescue an otherwise unsafe scratch
  return in the default `core-3-nonweb` backend.

No-GC proof obligation for every remaining memory slice:

- Before broadening codegen, define the storage shape being accepted:
  `scalar_local`, `unique_heap`, `borrow_view`, `frozen_shareable`, or
  `scratch_backed`.
- Prove the lifetime edge that makes cleanup possible. For source values this is
  scope exit, move, transfer, freeze, return, or explicit drop; for
  lowering-created temporaries this is the expression, branch, loop, call, or
  scratchpad boundary that owns the temporary.
- Insert cleanup from those facts, not from a later runtime fallback. Scratch
  storage resets on the scratch lifetime end; unique heap values record drop or
  transfer facts even while the first bump allocator lowers drops to no-op WAT;
  frozen/shareable and scalar values require no cleanup.
- A `scratch {}` result is checked before reset. It may escape only as a scalar,
  already-frozen value, explicit promotion/freeze into persistent storage, or a
  value proven scratch-free through fields and union payloads.
- If any storage, lifetime, borrow/view, scratch escape, freeze/promotion,
  host-boundary, or cleanup row is missing, the task is to split the source
  shape smaller or reject deterministically before WAT emission. Do not make it
  accepted by adding tracing GC, managed storage, hidden attached regions,
  implicit promotion, or runtime-discovered cleanup to the baseline.

## Chosen Memory Model Snapshot

Use this as the short checklist when splitting implementation work:

- Runtime heap values are unique by default. They can be moved, consumed,
  borrowed, frozen, returned, or dropped, but not implicitly copied.
- `borrow value` and `let view = borrow value` are the MVP borrow/view syntax.
  They create read-only non-owning views with lexical lifetimes.
- `freeze value` consumes a unique owner and produces immutable
  `frozen_shareable` storage that can be duplicated freely.
- `scratch { ... }` is the MVP temporary arena construct. It is a lexical
  scratchpad, not an attached region object. It has a value result, resets on
  every exit edge, and does not keep a hidden live region after reset.
- A `scratch {}` result can escape only when it is scalar, already frozen,
  explicitly promoted/frozen into persistent storage, or proven scratch-free at
  the value, field, and payload level.
- Optional longer-lived regions are future explicit owner packages. Values tied
  to such a region must carry the region owner, lifetime facts, cleanup/drop
  facts, move/consume rules, ABI rules, and host-boundary rules.
- Cleanup is inserted from static facts for both source values and
  compiler-created temporaries. Scratch-backed temporaries reset with the
  scratchpad; unique heap temporaries record drop or transfer decisions; scalar
  and frozen values require no runtime cleanup.
- Linear/path-sensitive analysis is storage-driven. It applies to source `!`
  capabilities, `unique_heap` owners, active `borrow_view` barriers,
  `scratch_backed` values, and closure slots that contain those values. Plain
  scalars and frozen/shareable values remain copy/share values.
- The baseline deliberately skips GC. If a case is hard to analyze, split it
  into a smaller accepted proof fixture, a deterministic rejection, or a future
  explicit region/managed-storage profile.

## No-GC Efficiency Target

This is the performance contract for the selected baseline. It is part of the
task definition, not a later optimization pass.

- `borrow owner` / `let view = borrow owner` should be analysis-only for the
  MVP. A borrow emits no allocation, no copy, and no runtime reference count; it
  only blocks owner operations until the lexical view lifetime ends.
- `scratch { ... }` should compile to a saved scratch pointer on entry plus
  reset edges on every exit that leaves the scratch lifetime. Normal scratch
  cleanup should be O(1), independent of the number of temporary values created
  inside the scope.
- `freeze value` and scratch-to-persistent promotion are the only places where
  copying is expected for immutable sharing across a lifetime boundary. The copy
  is explicit in Core and should be shaped by the value layout: text bytes,
  aggregate fields, union payloads, or closure environment slots.
- `frozen_shareable` values are immutable runtime data and may be duplicated
  freely after the freeze/promotion edge. They should not participate in
  exact-use linear analysis.
- `unique_heap` drops must be proof-visible at scope exit, replacement,
  transfer, discard, and early exits. The first bump allocator may lower those
  drops to no-op WAT, but reusable allocators and destructors will consume the
  same drop facts later.
- Compiler-created temporaries use the same storage and lifetime proof as source
  values. Temporaries from text operations, aggregate materialization, union
  payload construction, closure environment setup, host marshaling, and
  promotion must have a cleanup or transfer edge before WAT emission.
- If this static analysis cannot prove the supported shape, the baseline
  response is to split the shape or reject before WAT emission. Do not accept
  the program by adding a tracing GC, hidden attached region, implicit
  promotion, runtime-discovered cleanup, or Wasm-GC fallback.

## Analysis-Complete Gate

Skipping GC is allowed only when the accepted slice is analysis-complete. Use
this gate before marking any memory/lifetime task ready for WAT emission.

A slice is analysis-complete when:

- Every non-scalar source value and lowering-created temporary has a storage
  class, owner id, lifetime id, and source/lowering origin.
- Every borrow/view records the borrowed owner, lexical lifetime, and barriers
  against move, mutation, freeze, transfer, return, and escaping capture.
- Every `scratch {}` scope records entry, reset edges for all exits, and a
  result decision before reset: scalar, frozen/shareable, explicitly
  frozen/promoted, proven scratch-free, or rejected.
- Every freeze or promotion is an explicit Core copy edge before a lifetime
  boundary, not an implicit typechecker or WAT-emitter repair.
- Every unique owner and ownership-bearing temporary has a drop, transfer,
  replacement, freeze, return, or explicit no-cleanup decision.
- Every host/import boundary for non-scalar data has an explicit bounded-borrow,
  frozen/shareable, ownership-transfer, or host-returned owner contract.
- The proof surface exposes `managed_storage: "disabled"` and enough rows for a
  test to explain why WAT emission is safe without a collector.

If any row is missing, the task remains active. The next step is to split the
case by value shape or escape path, add the missing proof fact, add an explicit
freeze/promotion edge, reject before WAT emission, or defer it to a future
explicit region/managed-storage profile.

## Current No-GC Work Order

This is the implementation order for the memory/lifetime decision. It is a
baseline `core-3-nonweb` plan, not a managed-storage plan.

1. Build one ownership fact schema for accepted value shapes: `unique_heap`,
   `borrow_view`, `frozen_shareable`, and `scratch_backed`. Include owner ids,
   lifetime ids, source/lowering origin, escape decision, and cleanup/drop/reset
   decision.
2. Make `borrow value` / `let view = borrow value` lexical read-only views. They
   should be runtime-free and block owner move, mutation, freeze, ownership
   transfer, return, and escaping capture while live.
3. Keep `scratch { ... }` as a value-returning scratchpad. Lower it with a saved
   scratch pointer, reset every exit edge, and check the result before reset.
   Accepted results are scalar, already frozen/shareable, explicitly
   frozen/promoted, or proven scratch-free through fields, payloads, and
   captures.
4. Make `freeze` and scratch-to-persistent promotion explicit Core copy edges.
   These are the intentional copy points for values that cross a lifetime
   boundary as immutable shareable data.
5. Insert cleanup for source values and lowering-created temporaries from the
   same proof facts. Temporaries from text operations, aggregate
   materialization, union payload construction, closure environments, host
   marshaling, and promotion must have a lifetime end before WAT emission.
6. Apply path-sensitive linear analysis only to storage/effect-bearing values:
   source `!` capabilities, `unique_heap` owners, active `borrow_view` barriers,
   `scratch_backed` values, and ownership-bearing closure slots.
7. Leave optional longer-lived regions, attached region-owner return packages,
   tracing GC, managed storage, and Wasm-GC as explicit future profiles. They
   must not be used as fallback behavior for a baseline case whose proof rows
   are missing.

## Memory/Lifetime Implementation Slices

Use these slices when turning the memory model into code. Each slice should add
accepted proof fixtures, rejected diagnostics, and WAT-to-Wasm coverage only
after the no-GC proof rows are visible.

1. Ownership fact model
   - Record storage class, owner id, lifetime id, source/lowering origin, and
     cleanup decision for every non-scalar source value and compiler-created
     temporary.
   - Keep the storage set explicit: `scalar_local`, `unique_heap`,
     `borrow_view`, `frozen_shareable`, and `scratch_backed`.
   - Add proof assertions for the fact rows before broadening WAT emission.

2. Borrow/view analysis
   - Treat `borrow value` and `let view = borrow value` as read-only, non-owning
     views with lexical lifetimes.
   - While a view is live, reject owner move, mutation, freeze, transfer,
     return, escaping closure capture, and unknown host-boundary use.
   - Keep the MVP borrow runtime-free: no allocation, reference count, or copy.

3. Scratchpad result gate
   - Model `scratch { ... }` as a lexical scratchpad with a value result, saved
     scratch pointer on entry, and reset edges on fallthrough, `return`,
     `break`, and `continue`.
   - Keep scratch allocation efficient: normal cleanup is the reset edge, not a
     per-allocation walk or collector pass. Per-value cleanup is needed only for
     values promoted, transferred, or moved out of the scratch lifetime.
   - Check the result before reset. Accept only scalar, already frozen,
     explicitly frozen/promoted, or field/payload-proven scratch-free results.
   - Reject raw scratch-backed pointers that would require a hidden attached
     region or a collector to remain valid.

4. Freeze and promotion edges
   - Make `freeze value` consume a unique owner and produce `frozen_shareable`
     storage.
   - Make scratch-to-persistent promotion an explicit Core copy edge before
     scratch reset, shaped by the value layout: text bytes, aggregate fields,
     union payloads, or closure environment slots.
   - Split text, aggregate, union, and closure-environment promotion into
     separate proof fixtures.

5. Temporary cleanup and drops
   - Track lowering-created temporaries by origin: text operation, aggregate
     materialization, union payload construction, closure environment setup,
     host marshaling, and promotion copy.
   - Give each temporary a cleanup edge: scratch reset, unique-owner drop,
     ownership transfer, explicit freeze/promotion, or no-cleanup for scalar and
     frozen/shareable values.
   - Treat missing temporary cleanup facts as a proof gap. The next step is to
     split the temporary by origin and lifetime boundary, not to add GC-managed
     cleanup to the baseline.
   - Keep unique drops proof-visible even while the first bump allocator lowers
     them to no-op WAT.

6. Optional explicit regions
   - Defer longer-lived regions until scratchpad proof is stable.
   - Model future regions as explicit owner packages with tied returned values,
     region ids, cleanup/drop facts, move/consume rules, ABI rules, and
     host-boundary rules.
   - Do not use regions, managed storage, tracing GC, or Wasm-GC as a fallback
     for an otherwise unproven baseline scratch return.

7. Managed storage profile deferral
   - Keep GC and managed storage out of the active `core-3-nonweb` task queue.
   - Do not start managed storage to make the current scratchpad, temporary
     cleanup, closure capture, aggregate, union, text, borrow, or host-boundary
     work easier. Finish the static proof slice first, reject it
     deterministically, or mark it as a future explicit profile.
   - Only add a managed profile after the no-GC baseline has a named rejection
     or proof gap that cannot reasonably be addressed by smaller static analysis
     slices.
   - A managed profile needs its own Core representation, ABI, proof output,
     host-boundary rules, tests, and target selection. It must not be a hidden
     fallback inside the baseline emitter.

## Current Implementation Notes

- Core drop planning is split so `src/core/drop/types.ts` owns shared plan/state
  shapes, `src/core/drop/emit.ts` owns drop/transfer step emission,
  `src/core/drop/static_function.ts` and `src/core/drop/static_owner.ts` own
  static helper discovery/classification, `src/core/drop/ownership.ts` owns
  owner consumption and unique-heap classification,
  `src/core/drop/static_call.ts` owns scoped static-call drop helper binding and
  alias analysis, `src/core/drop/expr_result.ts` owns expression-branch result
  merge/drop bookkeeping, discarded-expression result drops, result-expression
  ownership decisions, and shared result-scanner callback types,
  `src/core/drop/expr_children.ts` owns generic expression-child traversal and
  app/union ownership side effects, `src/core/drop/branch.ts` owns statement
  branch owner merge/drop helpers and branch statement scanning through an
  explicit recursive statement-scanner callback, `src/core/drop/block.ts` owns
  block-expression owner/result scanning, `src/core/drop/bind_owner.ts` owns
  binding owner replacement logic, `src/core/drop/binding_stmt.ts` owns `bind`,
  `assign`, and `index_assign` statement drop scanning,
  `src/core/drop/static_transfer.ts` owns static ownership-transfer call
  scanning, `src/core/drop/closure_body.ts` owns closure-body drop scanning and
  closure-local final-escape handling, `src/core/drop/conditional_expr.ts` owns
  `if`/`if let` expression branch drop scanning,
  `src/core/drop/conditional_stmt.ts` owns `if`/`if else`/`if let` statement
  drop scanning, `src/core/drop/loop_stmt.ts` owns range-loop and
  collection-loop statement drop scanning, and `src/core/drop/state.ts` owns
  owner/scope state helpers. General statement/final-result traversal and
  scanner callback wiring live in `src/core/drop/scan.ts`; `src/core/drop.ts`
  remains the public drop-plan facade.
- Core borrow planning has started the same split. `src/core/borrow/types.ts`
  owns shared borrow plan, validation, state, scope, alias, and recorded-borrow
  shapes. `src/core/borrow/scope.ts` owns deterministic scope ids and scratch
  exit-edge naming. `src/core/borrow/validate.ts` owns plan validation and
  check-to-error conversion. `src/core/borrow/barrier.ts` owns active-borrow
  barrier checks and diagnostics for blocked move/freeze/mutation.
  `src/core/borrow/contains.ts` owns the read-only scanner that detects borrow
  syntax inside expressions and statements. `src/core/borrow/control.ts` owns
  statement-sequence exit detection used when scanning only reachable borrow
  state. `src/core/borrow/capture.ts` owns captured borrow-view escape detection
  for closure bodies. `src/core/borrow/aliases.ts` owns borrow alias
  canonicalization, view/field alias merging, and stored-view alias helpers.
  `src/core/borrow/record.ts` owns borrow edge creation, bounded-vs-escaping
  lifetime decisions, active-borrow registration, and stored-view alias
  creation. `src/core/borrow/scan.ts` owns mutating borrow traversal and scan
  orchestration. `src/core/borrow/stmt.ts` owns statement/control-flow borrow
  traversal through expression-scanner callbacks. `src/core/borrow/binding.ts`
  owns binding-value borrow analysis and binding-time alias updates through
  scanner callbacks. `src/core/borrow/field_alias.ts` owns field-owner alias
  derivation and block/branch field-alias propagation.
  `src/core/borrow/view_result.ts` owns stored-borrow-view result analysis for
  blocks, branches, and promoted merged views. `src/core/borrow.ts` remains the
  public borrow-plan facade, so further splits should move one coherent scanner
  concern at a time.
- Core cleanup planning has started the same split. Scratch reset exit-edge
  discovery now lives in `src/core/cleanup/exit_edges.ts`; `src/core/cleanup.ts`
  re-exports `core_scratch_exit_edges` and `CoreCleanupExitEdge` while remaining
  the cleanup-plan facade. Scratch-return ownership classification, static
  aggregate/union scratch-free checks, freeze-copy support decisions, and
  field/payload rejection details now live in
  `src/core/cleanup/scratch_return.ts`.
- Core closure ownership planning has started the same split. Shared plan, hook,
  capture-slot, and fact shapes live in `src/core/closure_ownership/types.ts`.
  Nested closure value containment scanning now lives in
  `src/core/closure_ownership/contains.ts`, local borrow-view and scratch-backed
  ownership fact tracking lives in `src/core/closure_ownership/facts.ts`, and
  capture allow/reserved decisions live in
  `src/core/closure_ownership/decision.ts`. Statement/expression traversal,
  block/scratch/direct-call fact threading, local collection probes, and closure
  ownership edge recording live in `src/core/closure_ownership/scan.ts`.
  `src/core/closure_ownership.ts` remains the public planning facade.
- Core runtime aggregate planning has started the same split. Runtime aggregate
  layout construction, field lookup, nested field base-offset calculation, and
  static struct-type equality now live in
  `src/core/runtime_aggregate/layout.ts`. Aggregate type discovery and nested
  field access live in `src/core/runtime_aggregate/type_expr.ts`. Shared
  temp/local, emit-context, and hook shapes live in
  `src/core/runtime_aggregate/types.ts`, temp-local planning and local
  declaration live in `src/core/runtime_aggregate/plan.ts`, runtime aggregate
  value and field load/pointer emission live in
  `src/core/runtime_aggregate/emit.ts`, and aggregate freeze-copy support lives
  in `src/core/runtime_aggregate/freeze_copy.ts`.
  `src/core/runtime_aggregate.ts` remains the public compatibility facade.
- Core text fact planning has started the same split.
  `src/core/text_facts/types.ts` owns shared context, hook, and runtime text
  equality shapes. `src/core/text_facts/block.ts` owns block-local text fact
  propagation, block context cloning, and binding-time text-local updates.
  `src/core/text_facts/if_let.ts` owns static, dynamic-union, and runtime-union
  `if let` text fact analysis. `src/core/text_facts/collection.ts` owns
  collection indexing and `get(...)` text fact recognition through text-check
  callbacks. `src/core/text_facts/runtime_ops.ts` owns runtime text operation
  recognition for `append`, concat, equality, and `slice`.
  `src/core/text_facts.ts` remains the public facade for text classification,
  host-import text results, text-app function-type probing, and the existing
  backend-facing runtime text operation APIs.
- Core ownership planning has started the same split.
  `src/core/ownership/types.ts` owns shared ownership result, pointer-reason,
  and hook shapes. `src/core/ownership/text.ts` owns ownership-result display
  text and non-scalar diagnostic text. `src/core/ownership/branch.ts` owns
  `if`/`if let` branch ownership merging, freeze-result detection, and
  static/dynamic/runtime union branch contexts through an ownership scanner
  callback. `src/core/ownership.ts` remains the public facade for expression
  ownership classification, scoped static-call ownership, block result
  ownership, and runtime union probing.

## Historical Memory/Lifetime Notes

This section is retained for status detail from the research and implementation
pass. The authoritative contract near the top of this file wins if any older
wording here is less specific.

- The baseline remains `core-3-nonweb`: ordinary structured Wasm plus linear
  memory. It skips GC by making the static analysis precise for the supported
  source surface.
- No-GC is now the acceptance rule for the default backend, not a later
  optimization. If analysis cannot prove a memory/lifetime case, the task is to
  narrow the case and add proof facts or a deterministic compiler rejection, not
  to accept it through a collector.
- This supersedes the earlier possible GC fallback for hard scratchpad,
  temporary, closure-capture, aggregate, union-payload, text, and host-boundary
  cases. Spend the baseline work on precise proof facts, explicit promotion, or
  deterministic rejection before considering managed storage.
- The implementation work should therefore improve the ownership/lifetime proof
  until the supported case is accepted, or classify the case as rejected or a
  future explicit profile. Do not add collector hooks, runtime-discovered
  cleanup, or hidden managed storage as an intermediate baseline state.
- Runtime heap values default to `unique_heap`. They can move, be consumed by an
  ownership-transfer call, be borrowed, be frozen, be returned, or be dropped;
  they are never implicitly copied.
- `borrow owner` and `let view = borrow owner` are the MVP view syntax. A borrow
  is read-only, non-owning, and bounded by the owner lifetime. While the view is
  live, the owner cannot be moved, mutated, frozen, or consumed.
- `scratch { ... }` is the MVP scratchpad surface: a lexical arena for temporary
  shareable computation with a value result. It resets on every exit edge that
  leaves the scratch lifetime, including fallthrough, `return`, `break`, and
  `continue`.
- Sharing inside a scratchpad is ordinary immutable sharing for scalars,
  frozen/shareable values, and values proven not to require exact ownership.
  Unique, borrowed, scratch-backed, capability, or ownership-bearing closure
  slots still participate in the same path-sensitive analysis as outside the
  scratchpad.
- A `scratch { ... }` result never keeps a hidden live region. It may escape
  only when scalar, already `frozen_shareable`, explicitly frozen/promoted into
  persistent storage, or proven scratch-free at the value, field, and payload
  level.
- Optional longer-lived regions are a later explicit feature, not a fallback for
  scratch escapes. If added, a region return must be represented as an owner
  package whose returned values are tied to that region owner, whose cleanup is
  explicit when the owner is consumed or dropped, and whose movement
  participates in ownership analysis.
- `freeze value` consumes a unique owner and produces immutable
  `frozen_shareable` storage. Scratch-to-persistent promotion is an explicit
  Core edge emitted before scratch reset, not a typechecker or WAT-emitter
  repair.
- Cleanup is proof-driven. Source values and compiler-created temporaries both
  need storage, lifetime, escape, and drop/reset facts before WAT emission.
  Scratch reset emits real WAT; unique heap drops may stay no-op facts until a
  reusable allocator or destructor path exists.
- Linear analysis is storage-driven. Apply path-sensitive exact-use or move
  checking only to source `!` capabilities, `unique_heap` owners, active
  `borrow_view` barriers, `scratch_backed` values, and closure slots containing
  those values. Scalars and already-frozen values stay copy/share values.
- Unknown host/import calls are escaping for non-scalar values unless their
  signatures explicitly declare bounded-borrow, frozen/shareable, or
  ownership-transfer behavior.
- If a case cannot prove ownership, lifetime, borrow/view validity,
  scratch-escape, freeze/promotion, host-boundary, and cleanup/drop/reset facts,
  split it by value category and escape shape until it becomes an accepted proof
  fixture, a rejected diagnostic fixture, or a deferred future profile.
- Named arenas, attached-region return packages, reusable allocators,
  destructors, tracing GC, managed storage, and Wasm-GC are future explicit
  profiles. They must not make an uncertain `core-3-nonweb` program accepted.

Decision checkpoint for new memory work:

- The default answer to hard lifetime cases is "make the proof smaller and more
  precise", not "let a collector decide". A supported slice must have static
  storage, lifetime, escape, borrow, freeze/promotion, and cleanup facts before
  WAT emission.
- `scratch {}` remains the ergonomic temporary-computation surface. It may
  allocate share-friendly temporary data inside the scope, but its result is an
  ordinary value: scalar, frozen/shareable, explicitly promoted, proven
  scratch-free, or rejected.
- First-class closure storage follows the same contract. Closure environments
  are classified as persistent `unique_heap`, `frozen_shareable`,
  `scratch_backed`, or rejected; each captured slot carries its own ownership
  and lifetime facts.
- Any future GC, managed storage, named arena, or attached-region return design
  must be a separate target/profile task with its own Core representation, ABI,
  proof output, and tests.

Current refinement from the scratchpad and lifetime discussion:

- The baseline does not keep a "GC can decide later" escape hatch. If cleanup
  insertion is hard, the next task is to expose the missing storage/lifetime row
  or split the shape until it can be proven or rejected.
- Cleanup for compiler-created temporaries is part of the same proof as cleanup
  for source values. Temporaries created for text operations, aggregate
  materialization, union payload construction, closure environments, host
  marshaling, and promotion must have an owner/lifetime end before WAT emission.
- `scratch { ... }` remains the ergonomic temporary-computation surface. It can
  allocate share-friendly data while the scope is active, but the returned value
  is checked before reset and cannot carry an implicit attached region.
- Optional longer-lived regions remain useful future work only after the
  scratchpad proof is stable. They must return explicit region-owner packages
  with tied values and cleanup facts, rather than changing ordinary scratchpad
  results.
- Linear analysis is a tool for storage/effect-bearing values, not a global rule
  for every value. It applies where exact ownership matters: capabilities,
  unique owners, live borrow barriers, scratch-backed values, and closure slots
  containing those values.

Implementation rule for the selected baseline:

- Start each memory/lifetime slice by classifying the value as `scalar_local`,
  `unique_heap`, `borrow_view`, `frozen_shareable`, or `scratch_backed`.
- Attach a lifetime id to every owner, borrow, scratch scope, closure
  environment slot, host-returned owner, and lowering-created temporary that is
  not purely scalar.
- Check borrows as lexical read-only views. A live view blocks owner mutation,
  move, transfer, freeze, return, and escaping capture until the view ends.
- Check scratch results before reset. A result can leave only when it is scalar,
  frozen/shareable, explicitly promoted/frozen into persistent storage, or
  proven scratch-free through every field and union payload.
- Insert cleanup from the same facts that made the value accepted. Scratch
  scopes reset on all exit edges; unique owners and ownership-bearing
  temporaries record drop/transfer decisions even while the bump allocator
  lowers those drops to no-op WAT.
- If a proof row is missing, split the feature by storage category and escape
  shape until it becomes an accepted proof fixture, a deterministic rejected
  diagnostic, or an explicitly deferred future profile. Do not accept it by
  adding hidden region attachment, implicit promotion, runtime-discovered
  cleanup, tracing GC, managed storage, or Wasm-GC.

Per-slice execution checklist:

1. Classify storage and owner/lifetime ids for every source value and
   lowering-created temporary.
2. Check active borrows and view escapes before owner moves, mutation, freeze,
   transfer, return, or closure capture.
3. Check scratch results before reset and identify the exact field, payload, or
   value edge for any scratch-backed escape.
4. Emit explicit freeze/promotion copies before scratch reset when a value must
   leave the scratch lifetime as persistent `frozen_shareable` storage.
5. Record cleanup/drop/reset facts from the same proof data used by WAT
   emission.
6. Run the no-GC proof gate before module emission and assert
   `managed_storage: "disabled"` for accepted baseline fixtures.

Concrete task split from the latest memory decision:

1. Ownership fact schema

   - Give every non-scalar runtime value an owner id, lifetime id, storage
     class, and source/lowering origin.
   - Represent `unique_heap`, `borrow_view`, `frozen_shareable`, and
     `scratch_backed` with one proof vocabulary so mutation, closures, host
     calls, temporaries, and final-result checks read the same facts.
   - Treat scalar locals and frozen/shareable values as freely shareable; do not
     run linear exact-use checks for them.

2. Borrow/view analysis

   - Keep the source syntax to `borrow owner` and `let view = borrow owner`.
   - Track the view lifetime, the borrowed owner, and the lexical end point.
   - Reject owner mutation, move, freeze, transfer, return, or escaping capture
     while a view is live.

3. Scratchpad elaboration

   - Lower `scratch { ... }` to a lexical scratch lifetime with a saved pointer
     on entry and reset edges on fallthrough, `return`, `break`, and `continue`.
   - Allow temporary sharing inside the scratchpad only when the stored values
     are scalar, frozen/shareable, or otherwise proven not to require exact
     ownership.
   - Preserve normal ownership checks inside the scratchpad for unique owners,
     views, scratch-backed pointers, capabilities, and ownership-bearing closure
     slots.

4. Scratch result checking

   - Check the scratch result before reset.
   - Accept only scalar results, already frozen/shareable results, explicitly
     frozen/promoted results, or values proven scratch-free through every field
     and union payload.
   - Reject uncertain scratch-backed escapes with a diagnostic naming the field,
     payload, or value edge that still depends on the reset scratch lifetime.

5. Freeze and promotion

   - Make `freeze value` consume a unique owner and produce immutable
     `frozen_shareable` storage.
   - Make scratch-to-persistent promotion an explicit Core copy edge before the
     scratch reset.
   - Split promotion support by value shape: runtime text, aggregate, union,
     closure environment, and nested field/payload combinations.

6. Cleanup for source values and temporaries

   - Insert drops/resets from proof-visible lifetime ends, including values
     created by lowering.
   - Track lowering-created temporaries for aggregate materialization, text
     copy/concat/slice loops, union payload construction, closure environment
     setup, and promotion copies.
   - Keep unique-heap drops in the proof even when the first bump allocator
     lowers them to no-op WAT.

7. Linear participation

   - Reuse the path-sensitive state machinery for source `!` capabilities,
     `unique_heap` owners, active `borrow_view` barriers, `scratch_backed`
     values, and closure slots containing those values.
   - Do not make all ordinary values linear; participation is determined by
     storage class or effect role.

8. Future explicit regions

   - Do not infer an attached region from `scratch {}`.
   - If longer-lived regions are added later, make them explicit owner packages
     with region ids, tied value lifetimes, cleanup/drop facts, move/consume
     rules, ABI rules, and host-boundary rules.
   - Keep managed GC, tracing GC, and Wasm-GC as separate future target
     profiles, not baseline fallback behavior.

9. Slice acceptance matrix

   - Every memory/lifetime slice must close in one of three states: accepted
     with proof facts, rejected before WAT emission with a named missing fact,
     or deferred to a future explicit region/managed-storage profile.
   - Accepted fixtures should assert `managed_storage: "disabled"` and expose
     the storage class, lifetime id, borrow/view decision, scratch reset edge,
     freeze/promotion edge, host-boundary decision when relevant, and
     drop/cleanup/transfer decision.
   - Rejected fixtures should fail before WAT emission and name the reason:
     active borrow, moved owner, scratch-backed escape, unsupported promotion,
     missing temporary cleanup, unknown host/import ownership, or unsupported
     ownership-bearing closure capture.
   - Deferred fixtures should stay documented as future profiles. Do not unblock
     them by adding hidden attached regions, implicit promotion,
     runtime-discovered cleanup, tracing GC, managed storage, or Wasm-GC to the
     baseline.

## Active Memory Implementation Tracks

These are the concrete tracks for the remaining memory work. They are the active
split for the no-GC baseline, not open research topics. Each track should land
accepted proof fixtures and the nearest rejected diagnostic fixture before
broader runtime features depend on it.

The selected mix is fixed for this queue: ordinary runtime owners are
`unique_heap`, read-only views are lexical `borrow_view` facts, immutable
shareable values are `frozen_shareable`, and scratchpad storage is
`scratch_backed` until a result is proven scalar, frozen, explicitly promoted,
or scratch-free. Linear/path-sensitive checks follow those storage facts; they
do not apply to every ordinary value.

1. Proof inventory gate: keep `managed_storage: "disabled"` visible and reject
   before WAT emission when required storage, lifetime, borrow, scratch,
   freeze/promotion, host-boundary, or cleanup facts are missing. Every accepted
   baseline fixture should be reviewable as "analysis complete"; no fixture
   should depend on a future collector, hidden attached region, or WAT-emitter
   cleanup inference to be sound.
2. Lowering-created temporary cleanup: add cleanup/drop/reset facts for
   aggregate materialization, text copy/concat/slice loops, union payload
   construction, closure environment setup, and promotion temporaries.
3. Field/payload scratch-escape proofs: accept scratch returns only when every
   aggregate field or union payload is scalar, frozen/shareable, explicitly
   promoted, or proven scratch-free.
4. Explicit freeze and promotion copies: implement persistent copies for
   scratch-backed text, aggregate, union, and closure shapes as each shape gains
   proof facts. Promotion must be a Core edge before scratch reset.
5. Borrow/view barriers: keep `borrow owner` and `let view = borrow owner` as
   the MVP view syntax, and finish owner barriers for fields, loops, closures,
   branch merges, and host-call boundaries.
6. Closure capture ownership: reusable closures may capture scalar or
   frozen/shareable slots. Captures of unique, borrow, scratch-backed, or
   capability slots must either make the closure linear or reject before WAT
   emission.
7. Host/import transfer analysis: continue bounded-borrow, frozen/shareable,
   ownership-transfer, and host-returned owner contracts through wrappers and
   interprocedural static calls. Unknown non-scalar boundaries stay rejected.
8. Deferred region/managed profile spec: keep optional longer-lived regions as
   explicit future owner packages with tied return values, cleanup/drop facts,
   move/consume rules, ABI rules, and host-boundary rules. This track may
   collect requirements, but it must not make ordinary `scratch {}` return a
   hidden attached region or make GC the fallback for an unproven baseline case.

Future explicit region packages are not part of the active baseline queue. After
scratchpads are stable, optional named regions can be designed as explicit owner
packages with region ids, tied return values, cleanup/drop facts, ABI rules, and
host-boundary rules. They do not make uncertain `scratch {}` results accepted by
default; ordinary `scratch {}` never grows an attached region implicitly.

Every track should keep the same triage shape: supported with proof facts,
rejected before WAT emission with a named missing fact, or deferred to a future
explicit region/managed-storage profile. Do not add a GC-backed accepted state
for scratch escapes, temporary cleanup, closure captures, aggregate fields,
union payloads, text buffers, or host boundaries.

Task 12.2 is the detailed task split for this model. Runtime aggregate, union,
text, closure, mutation, and capability tasks should only broaden when the same
proof surface can accept or reject the new shape deterministically.

## First No-GC Fixture Backlog

Use these as the first concrete fixtures when implementing the active tracks.
Each item needs one accepted proof fixture and the nearest rejected diagnostic
fixture before broader syntax depends on it.

1. Borrow/view barriers
   - Accept a lexical `borrow owner` used only for reads inside the current
     block, loop iteration, function call, or `scratch {}` body.
   - Reject moving, returning, freezing, mutating, transferring, or escaping a
     closure capture of the owner while the view is live.
   - Include field/payload views, where borrowing `owner.field` or a union
     payload still protects the containing owner edge.

2. Scratch scalar and frozen returns
   - Accept `scratch { scalar }` and `scratch { freeze owned_text }` with a
     saved-pointer reset on every exit edge.
   - Reject `scratch { owned_text }` when the result would still point into
     scratch storage after reset.
   - Prove that the result decision happens before reset, and that no hidden
     attached region is returned.

3. Scratch aggregate and union result gates
   - Accept aggregates and union cases only when every reachable field or
     payload is scalar, already frozen/shareable, explicitly promoted, or proven
     scratch-free.
   - Reject the first field or payload that is still `scratch_backed`, and name
     that edge in the diagnostic.
   - Split static-shaped aggregate, runtime aggregate, static union case, and
     runtime union payload fixtures instead of trying to solve them as one broad
     case.

4. Lowering-created temporary cleanup
   - Track temporaries from text concat/copy/slice, aggregate materialization,
     union payload construction, closure environment allocation, host
     marshaling, and promotion copies.
   - Accept only when each temporary has a storage class, lifetime end, and
     cleanup/drop/transfer/no-cleanup decision.
   - Reject missing cleanup decisions before WAT emission; do not add a
     collector-backed cleanup path.

5. First-class closure storage
   - Represent a closure as code pointer or table index plus an optional
     environment pointer.
   - Classify each captured slot independently. Reusable closures may capture
     scalar and `frozen_shareable` slots; captures of `unique_heap`,
     `borrow_view`, `scratch_backed`, capability, or ownership-bearing slots
     require a linear closure path or rejection.
   - Add proof rows for environment storage, captured-slot ownership, transfer
     or drop behavior, and any freeze/promotion edge needed to make a reusable
     closure valid.

6. Host/import boundaries
   - Accept only explicit bounded-borrow, frozen/shareable, ownership-transfer,
     or host-returned-owner contracts for non-scalar values.
   - Reject unknown non-scalar host calls, direct unique owners passed to
     bounded-borrow-only imports, borrowed views passed to transfer imports, and
     scratch-backed values whose lifetime cannot cross the boundary.
   - Keep the host contract visible in proof output before WAT emission.

## Current Agreed Memory Task Split

This is the concrete split for the selected no-GC baseline. These are defined
implementation tasks, not just research topics. If a task is still too broad,
split it by value category and escape shape: scalar, static aggregate, static
union case, dynamic static-union `if`, runtime heap aggregate, runtime union
payload, runtime text, closure environment, and host boundary.

Task status from the latest memory decision:

- Defined upfront: no-GC proof gate, `unique_heap` default storage, lexical
  borrow/views, lexical `scratch {}` scratchpads with value results,
  `frozen_shareable` values, explicit freeze/promotion, cleanup for source and
  lowering-created temporaries, and storage-driven linear participation.
- Refine during implementation: each runtime heap aggregate, runtime union
  payload, runtime text, closure environment, host-boundary, scratch escape, and
  promotion shape. The refinement is mechanical: either expose the proof facts
  and accept it, reject with a named missing edge, or defer it to a future
  explicit region/managed-storage profile.
- Not part of the baseline: hidden attached-region returns, implicit promotion,
  tracing GC, Wasm-GC, managed fallback storage, or runtime-discovered cleanup.
- Future optional regions must be refined as their own profile: explicit region
  owner values, explicit value-to-region ties, explicit cleanup, and linear
  movement of the region owner. They do not change ordinary `scratch {}`
  returns.
- The borrow/view, scratchpad, freeze/promotion, and cleanup decisions are
  implementation tasks now, not pending design choices. The remaining design
  work is only how broad each accepted slice is before it is split.

Definition of done for each memory/lifetime slice:

- Accepted cases expose proof facts before WAT emission: storage class, lifetime
  id, borrow/view validity, escape decision, scratch reset edge,
  freeze/promotion edge, host-boundary decision when relevant, and
  drop/cleanup/transfer decision.
- Rejected cases fail before WAT emission with a diagnostic that names the
  missing edge, such as active borrow, scratch-backed escape, unsupported
  promotion, missing temporary cleanup, or unknown host/import ownership.
- Deferred cases are explicitly future profiles. Named arenas, attached-region
  return packages, reusable allocators, destructors, managed GC, tracing GC, and
  Wasm-GC do not make the baseline case accepted.

Locked task refinement from the latest memory decision:

- Implement the baseline without GC by making the analysis precise enough for
  the supported source surface.
- Treat "skip GC if the analysis can be made proper" as the active baseline
  rule. The implementation task is to expose the missing static proof facts, not
  to keep a collector-backed acceptance path open while the proof is incomplete.
- Keep `scratch { ... }` as a value-returning scratchpad. It is useful for
  temporary shareable computation, but it never returns a hidden live region.
- Any value leaving a scratchpad must be scalar, already frozen/shareable,
  explicitly promoted/frozen into persistent storage, or proven scratch-free at
  the value, field, and payload level.
- Use `borrow owner` / `let view = borrow owner` as the MVP view syntax to make
  lifetime analysis local and predictable. Views are read-only, non-owning, and
  bounded by the owner lifetime.
- Insert cleanup for source values and compiler-created temporaries from the
  same ownership/lifetime facts. Scratch-backed values reset with the scratch
  scope; unique heap values record drop facts; scalar and frozen values need no
  runtime cleanup.
- Temporary cleanup is inserted from known lifetime ends. If the lifetime end or
  selected storage class is unknown, the baseline task is to add the missing
  fact or reject before WAT emission, not to defer cleanup to GC.
- Apply linear/path-sensitive analysis only where the storage class or effect
  role requires it: source `!` capabilities, `unique_heap` owners, active
  `borrow_view` barriers, `scratch_backed` values, and closure slots containing
  those values.
- If an attached region is needed later, add an explicit region-owner package
  with its own Core representation, ABI, lifetime facts, escape facts, and
  cleanup rules. Do not infer that package from ordinary `scratch {}` returns.
- When analysis is incomplete, split by value category and escape shape, then
  land either an accepted proof fixture or a rejected diagnostic fixture. Do not
  accept the baseline case through GC, hidden region attachment, implicit
  promotion, or runtime-discovered cleanup.
- Only open a GC/managed-storage task after the case has been explicitly
  classified as a future profile with its own Core representation, ABI,
  ownership proof surface, and tests. Such a task must not change the
  `core-3-nonweb` acceptance matrix.

Current implementation status for that split:

- Done enough to build on: baseline `Core.proof(...)` with
  `managed_storage: "disabled"`, explicit storage classes, borrow-view
  validation for the current owner/alias surface, scratch reset insertion on
  fallthrough/`return`/`break`/`continue`, static-shaped scratch-free aggregate
  and union returns, persistent freeze for runtime text/aggregate/union/closure
  owners, direct scratch runtime text promotion, direct/block-local/branch
  scratch closure freeze, direct aggregate/union constructor scratch freeze,
  block-local scratch runtime aggregate alias promotion with scalar, `Text`, and
  nested aggregate fields, block-local scratch runtime union alias promotion for
  scalar/`Text`/`Unit`, union-pointer, and supported aggregate-pointer payloads,
  reusable free-list cleanup for allocation-linked source-owner paths, and the
  first Core host/import contract slices. `Core.host_imports` now carries
  explicit argument contracts, `Core.proof(...).host_boundaries` records the
  matched signature and per-argument decisions, bounded-borrow imports accept
  `borrow_view` arguments, ownership-transfer imports consume direct
  `unique_heap` arguments, `Core.drops(...)` records `host_transfer` facts, and
  `Core.mod(...)` emits the corresponding WAT imports and calls.
- Still active baseline work: true immutable heap-copy promotion for broader
  aggregate/union existing owners, broader scratch-backed text and closure
  promotion shapes, field-sensitive scratch escape facts for heap-backed
  aggregate/union payloads, deeper closure-capture ownership and linear
  participation, source-level import-contract syntax, deeper interprocedural
  transfer analysis, and cleanup/drop facts for every lowering-created
  temporary.
- Deferred profiles: named arenas, attached-region return packages, reusable
  allocators, destructors, tracing GC, managed storage, and Wasm-GC. These are
  future targets only; they must not make an uncertain `core-3-nonweb` program
  accepted.

1. Static proof gate

   - Keep `managed_storage: "disabled"` for `core-3-nonweb`.
   - Reject before WAT emission when a storage, lifetime, borrow, scratch
     escape, freeze/promotion, cleanup, or host-boundary fact is missing.
   - Add accepted fixtures that expose the facts used by WAT emission and
     rejected fixtures that assert deterministic diagnostics.

2. Ownership and storage facts

   - Track `scalar_local`, `unique_heap`, `borrow_view`, `frozen_shareable`, and
     `scratch_backed` for source values and lowering-created temporaries.
   - Treat runtime heap values as unique by default, frozen values as
     copy/share, and scratch-backed values as bounded by the active scratch
     lifetime.
   - Keep static type values, static-shaped aggregates, and static union cases
     as ownerless compiler facts until a runtime pointer is materialized.

3. Borrow/view syntax and checking

   - Use only `borrow owner` and `let view = borrow owner` for the MVP view
     surface.
   - Views are read-only and non-owning. They cannot be returned, stored into a
     longer-lived place, captured by escaping closures, or carried past the
     owner lifetime.
   - While a view is active, the owner cannot be moved, replaced, mutated,
     frozen, or consumed by an owning operation.

4. Scratchpad regions

   - Treat `scratch { ... }` as a lexical temporary arena with a value result.
   - Save the scratch pointer on entry and reset it on fallthrough, `return`,
     `break`, and `continue` exits that leave the scratch lifetime.
   - A returned value may escape only when it is scalar, already
     frozen/shareable, explicitly promoted/frozen into persistent storage, or
     proven scratch-free at the value or field level.
   - Do not attach the scratchpad to the result in the MVP. Attached-region
     returns are a future explicit owner-package feature.

5. Freeze and promotion

   - `freeze value` consumes a unique owner and produces immutable
     `frozen_shareable` storage.
   - Scratch-to-persistent promotion is an explicit Core edge emitted before
     scratch reset, not an implicit typechecker or WAT-emitter repair.
   - Preserve idempotent freeze for already-frozen values and reject mutation
     through frozen values.

6. Cleanup and temporaries

   - Insert cleanup from ownership/lifetime facts for source values and
     compiler-created temporaries.
   - Scratch-backed temporaries reset with the scratchpad.
   - Unique heap temporaries record drop points even while the first bump
     allocator lowers those drops to no-op code.

7. Host/import boundary facts

   - Treat unknown non-scalar host/import calls as escaping.
   - Accept borrowed or unique heap values across the boundary only when the
     import signature declares bounded-borrow or ownership-transfer facts.
   - Include those boundary decisions in `Core.proof(...)`.
   - Implemented first slices: Core import signatures distinguish scalar,
     bounded-borrow, frozen/shareable, and ownership-transfer argument
     contracts. Bounded-borrow contracts accept explicit `borrow` views and
     reject direct `unique_heap` arguments unless the caller wraps them in
     `borrow`. Ownership-transfer contracts accept direct `unique_heap`
     arguments, record `host_transfer` drop-plan facts, and reject borrowed
     views. Direct use-after-transfer validation rejects later use of a
     transferred owner before WAT emission. Unknown non-scalar imports still
     reject before WAT emission. Host-returned owner result contracts are
     implemented for Core imports, and invalid owner-result ABI shapes now
     reject through `Core.proof(...)` before module emission.
   - Source-level contract declarations are implemented for scalar numeric ABI
     values, Text ownership contracts, explicit non-Text pointer owner reasons,
     and user-defined aggregate/union type-value owner references. Remaining
     slices are deeper interprocedural transfer analysis and any future
     scratch-backed promotion policy that crosses the boundary intentionally.

8. Deferred profiles

   - Named arenas, attached-region return values, reusable allocators,
     destructors, tracing GC, and Wasm-GC are separate follow-up profiles.
   - They must not weaken the baseline proof gate or rescue accepted baseline
     fixtures with managed storage.
   - A future managed profile may accept cases the baseline rejects, but only
     with separate storage classes, ABI rules, proof output, and tests.

### No-GC Acceptance Matrix

Use this matrix when refining any memory/lifetime task:

- Accepted baseline cases must expose storage class, lifetime id, borrow/view
  validity, escape decision, scratch reset edge, freeze/promotion edge,
  host-boundary decision when relevant, and drop/cleanup/transfer decision
  before WAT emission.
- Rejected baseline cases must fail before WAT emission and name the missing
  fact: active borrow, moved owner, scratch-backed escape, unsupported
  promotion, missing temporary cleanup, unsupported closure capture, or unknown
  host/import ownership.
- Deferred profile cases are named arenas, attached-region return packages,
  reusable allocators, destructors, tracing GC, managed storage, and Wasm-GC.
  They need separate source/API shape, Core representation, ABI, proof output,
  and tests before they can accept programs the baseline rejects.
- `scratch {}` results are accepted only when scalar, already frozen/shareable,
  explicitly promoted/frozen into persistent storage, or proven scratch-free at
  the value or field/payload level.
- Compiler-created temporaries follow the same matrix as source values. Scratch
  temporaries reset with the scratch scope, unique temporaries produce drop
  facts, and scalar or frozen temporaries need no runtime cleanup.

Concrete proof inventory for each accepted baseline memory slice:

- Storage/lifetime row: source or lowering-created value, storage class,
  lifetime id, owner id when relevant, and reason for the selected storage.
- Borrow/view row: borrowed owner, view lifetime, view end point, and the owner
  operations blocked while the view is live.
- Scratch row: scratch lifetime id, saved pointer, reset edges for normal and
  early exits, result escape classification, and field/payload path when a
  returned value is proven scratch-free or rejected.
- Freeze/promotion row: consumed owner, source storage, destination storage,
  copied fields/payloads, and cleanup/reset ordering.
- Drop/cleanup row: owner or temporary id, normal/early exit edge, drop/reset
  action, and whether the first bump allocator lowers the action to no-op WAT.
- Host-boundary row: import signature contract, argument/result ownership
  decision, transfer/drop decision, and diagnostic for unknown or unsupported
  non-scalar escapes.

## Immediate Memory/Lifetime Next Slices

Use these as the next reviewable implementation slices. Each slice needs an
accepted proof fixture or a rejected diagnostic fixture before it is considered
done.

Latest refinement rule:

- These are defined implementation tasks, not open research tasks. The selected
  baseline is no-GC because the analysis must become complete for the supported
  surface.
- If a slice is still too broad, split it by storage shape and escape path:
  runtime text, runtime aggregate, runtime union payload, closure environment,
  host/import boundary, source owner cleanup, or lowering-created temporary.
- Close each split slice in exactly one state: accepted with proof rows,
  rejected before WAT emission with a named missing edge, or deferred to a
  future explicit region/managed-storage profile.
- Do not create an intermediate accepted state that relies on hidden attached
  regions, implicit promotion, runtime-discovered cleanup, tracing GC, managed
  storage, or Wasm-GC.

Current queue from the latest no-GC decision:

1. Audit the proof gate against every currently accepted `Core.emit(...)`,
   `Core.mod(...)`, and source-to-WAT feature. A feature is accepted only when
   the proof exposes the storage, lifetime, escape, borrow, scratch,
   freeze/promotion, host-boundary, and cleanup facts WAT emission depends on.
2. Normalize allocation facts for source values and lowering-created
   temporaries. Runtime text, aggregates, unions, and closure environments start
   as `unique_heap`; scratch allocations are `scratch_backed`; frozen values are
   `frozen_shareable`; scalars remain `scalar_local`.
3. Keep `borrow owner` and `let view = borrow owner` as the MVP view syntax.
   Finish field-owner, loop/branch merge, closure-capture, and host/import
   barriers before adding broader view forms.
4. Keep `scratch { ... }` lexical. It has a value result and resets on every
   exit edge. Finish scratch allocation routing and field/payload-level escape
   proofs before accepting broader heap-backed aggregate, union, text, or
   closure results.
5. Make `freeze` and scratch-to-persistent promotion explicit Core edges.
   Promotion must happen before scratch reset; unsupported shapes reject instead
   of implicitly promoting or selecting managed storage.
6. Complete cleanup for source values and lowering-created temporaries from the
   same ownership/lifetime facts. Scratch temporaries reset with the scratchpad;
   unique temporaries record drop facts even while the bump allocator lowers
   them to no-op code.
7. Apply path-sensitive linear/unique analysis only where storage or effects
   require it: source `!` capabilities, `unique_heap` owners, active
   `borrow_view` barriers, `scratch_backed` values, and closure slots containing
   those values.
8. Defer named arenas, attached-region returns, reusable allocators,
   destructors, tracing GC, managed storage, and Wasm-GC to explicit future
   profiles with separate Core representation, ABI, proof output, and tests.
   Those profiles can be designed after the no-GC baseline is proven for the
   supported surface; they should not be used to accept a current uncertain
   lifetime, scratch, borrow, closure-capture, or temporary-cleanup case.

9. Baseline no-GC proof audit

   - Audit every currently accepted `Core.emit(...)`, `Core.mod(...)`, and
     source-to-Core/Wasm feature against the proof-gate contract.
   - Start with fixture groups that already emit WAT: runtime text, runtime
     aggregate pointers, runtime union pointers, first-class closures, scratch
     allocation/promotion, host imports, and lowering-created temporaries.
   - Add missing proof output for accepted features or move the feature to a
     rejected diagnostic before WAT emission.
   - Include lowering-created temporaries in the same audit as source values:
     aggregate materialization, text copy loops, union payload construction,
     closure environment setup, and promotion.
   - For each group, assert the concrete proof inventory above instead of only
     asserting that WAT was emitted.
   - Keep `managed_storage: "disabled"` in every accepted baseline fixture. If
     the proof is hard, split the case by value category and escape shape
     instead of enabling a GC or hidden attached region.
   - Implemented scoped static-call proof scanning for cleanup and freeze edges.
     A helper call whose body contains `scratch { ... freeze ... }` now reports
     the same final `frozen_heap` result, scratch reset, and freeze proof edge
     as the direct expression form before WAT emission.
   - Implemented closure-body scratch cleanup proof scanning. A stored closure
     whose body contains `scratch { ... }` now reports the scratch reset and
     scratch-return cleanup facts through `Core.cleanup(...)` and
     `Core.proof(...)` before lifted closure WAT emission.
   - Implemented closure-body freeze proof scanning for runtime closure values.
     Runtime-selected closures whose bodies return `scratch { freeze ... }` now
     report both branch-local freeze edges as well as scratch cleanup facts.
     Direct statically callable helper bindings are skipped at definition time
     so their scoped static-call sites own the proof rows without duplication.
   - Implemented scoped static-call allocation proof scanning. Helper calls with
     statement-scoped bodies now report the body allocation facts at the
     specialized call site, while direct helper definitions that do not allocate
     first-class closure environments no longer record synthetic closure
     allocation facts.
   - Implemented matching scoped static-call drop proof scanning. Inlined
     helpers with statement-scoped bodies keep real body drop facts, but no
     longer record synthetic helper closure scope-exit drops when no closure
     environment is emitted.

10. Scratch-backed aggregate/union alias promotion

    - Implemented the first aggregate alias shape:
      `scratch { let temp = user_type { ... }; freeze temp }` now copies a
      known-layout runtime aggregate into persistent frozen storage before
      reset. Scalar fields are copied directly, `Text` fields are copied through
      the persistent text freeze-copy path, and nested aggregate fields recurse
      through the same layout copy.
    - Implemented the first runtime union alias shape:
      `scratch { let temp = result_type.ok(...); freeze temp }` now copies the
      source union record into persistent frozen storage before reset when the
      union payload surface is scalar/`Text`/`Unit` or a supported aggregate
      pointer, and now recurses through union-pointer payload slots. `Text`
      payload slots, aggregate `Text` fields, and nested union payloads are
      copied through persistent freeze-copy paths so the frozen union does not
      retain scratch pointers.
    - Implemented aggregate alias promotion for supported union-pointer fields:
      `scratch { let temp = box_type { result: result_type.ok(...) }; freeze temp }`
      now copies the aggregate and recursively copies the union field into
      persistent frozen storage before scratch reset.
    - Implemented static-shaped existing aggregate aliases in scratch freeze:
      `let existing: user_type = user_type { ... }; scratch { let temp = existing; freeze temp }`
      now resolves the alias through the static-shaped aggregate fact, plans the
      aggregate fields, and emits the same persistent aggregate/text copy path.
    - Implemented branch-selected existing runtime union aliases in scratch
      freeze:
      `let existing: result_type = if flag { result_type.ok(...) } else { result_type.err(...) }; scratch { let temp = existing; freeze temp }`
      now preserves the dynamic-union static alias through local collection,
      text-layout scanning, and payload capture planning, so `Text` payload
      facts survive into the persistent union/text freeze-copy path.
    - Implemented branch-assigned existing runtime union aliases in scratch
      freeze:
      `let existing: result_type = result_type.err(...); if flag { existing = result_type.ok(...) } else { existing = result_type.err(...) }; scratch { let temp = existing; freeze temp }`
      now merges compatible static union-case assignments, keeps generated
      branch temporaries visible outside the branch, and preserves payload facts
      through scratch freeze and matching.
    - Implemented branch-assigned existing runtime aggregate aliases in scratch
      freeze:
      `let existing: user_type = user_type { ... }; if flag { existing = user_type { ... } } else { existing = user_type { ... } }; scratch { let temp = existing; freeze temp }`
      now merges compatible static-shaped aggregate assignments whose fields
      have been captured into compiler-generated locals, preserves those
      per-field branch facts through scratch freeze, records the persistent
      aggregate/text freeze-copy proof rows, and compiles through WAT-to-Wasm
      after scratch reset.
    - Dynamic range/text collection loops that carry static aggregate/union
      compiler facts, including aliases to those facts, now reject
      deterministically instead of treating a loop-body static assignment as an
      unconditional post-loop value. The rejection is covered through type,
      proof, and emission entry points. Loop-carried existing aggregate/union
      promotion remains pending until the loop-runs/last-iteration value and
      cleanup facts can be represented explicitly.
    - Implemented static scratch block setup emission for static aggregate/union
      returns. Multi-statement `scratch {}` blocks whose final value is a static
      aggregate or union constructor now preserve block-local frozen runtime
      captures, emit the setup under scratch reset tracking, and compile through
      WAT-to-Wasm without retaining scratch pointers.
    - Implemented block-local static aggregate/union alias returns through
      scratch. Generated field/payload capture locals now preserve frozen facts,
      so shapes like
      `scratch { let name: Text = freeze append(...); let temp: user_type = user_type { name: name, ... }; temp }`
      and the matching union-case alias form prove their returned
      aggregate/union fields are scratch-free, keep managed storage disabled,
      emit scratch reset, and compile through WAT-to-Wasm.
    - Remaining alias work: broader existing aggregate/union owner copies across
      more complex multi-step assignment and loop shapes, branch combinations
      beyond compatible aggregate/union assignments, plus field-sensitive
      scratch-free proofs for returned heap-backed values.
    - Distinguish this from the already implemented direct constructor case,
      where `scratch { freeze user_type { ... } }` can materialize directly on
      persistent heap storage before reset.
    - Preserve aggregate/union type facts, source owner facts, destination
      frozen storage facts, and scratch cleanup facts through the promotion.

11. Field-sensitive scratch escape facts

    - Track scratch-backed status per aggregate field and union payload, not
      only on the outer pointer.
    - Accept returned heap-backed aggregates/unions only when every reachable
      field or payload is scalar, static/frozen, explicitly promoted, or
      otherwise proven scratch-free.
    - Reject mixed values with a diagnostic that names the escape edge and the
      field or payload that may reference reset scratch storage.
    - Implemented the first rejected diagnostic slice for static-shaped scratch
      aggregate and union returns: when a field or payload may reference reset
      scratch storage, the type/proof diagnostic names the offending field or
      payload path instead of only reporting the outer aggregate/union pointer.
    - Scratch reset proof rows now carry the same field/payload rejection detail
      as type and emission analysis. Unsafe returns such as
      `scratch { user_type { name: append(...) } }` now report the offending
      `field name` in `Core.proof(...)` before WAT emission instead of only
      reporting the outer `unique_heap runtime_aggregate` scratch escape.

12. Lowering-created temporary cleanup

    - Add cleanup/drop/reset facts for temporaries introduced by runtime
      aggregate materialization, runtime text copy/slice/concat loops, runtime
      union payload construction, closure environment setup, and promotion.
    - Keep scratch temporaries reclaimed by scratch reset and unique heap
      temporaries represented as drop facts while the first bump allocator still
      lowers drops to no-ops.
    - Ensure each new accepted WAT-emitting feature has a proof fixture showing
      the temporary cleanup facts it depends on.
    - Implemented first runtime aggregate temporary cleanup slice: a discarded
      materialized aggregate expression such as `user_type { name: value }; 1`
      now records an ownerless `heap_drop` with `edge: "discarded_expr"` and
      `ownership: unique_heap runtime_aggregate`, matching the allocation fact
      emitted for the same expression. The same drop fact is recorded when a
      static aggregate fact is used as an expression and materialized into a
      runtime aggregate pointer before being discarded.
    - Added the matching proof fixture for discarded runtime union
      materialization. A temporary `result_type.ok(value)` expression in a
      closure body now has proof-visible persistent runtime-union allocation
      facts and an ownerless `discarded_expr` drop fact before WAT emission.
    - Implemented the bound runtime union owner cleanup slice. A binding such as
      `let result: result_type = result_type.ok(value)` now records the
      persistent runtime-union allocation fact that matches its `scope_exit`
      drop fact, while untyped shorthand union facts remain ownerless static
      values.
    - Added proof inventory coverage for runtime text temporaries. Discarded
      `append(...)` and `slice(...)` results and bound runtime `Text` owners
      produced by either operation now assert `managed_storage: "disabled"`,
      persistent `unique_heap text` allocation facts, and the matching
      `discarded_expr` or `scope_exit` drop facts before WAT emission.
    - Added closure-environment cleanup proof coverage for bound, discarded, and
      scalar-capturing closure values. `Core.proof(...)` now has fixtures
      showing persistent `unique_heap closure` allocation facts, allowed scalar
      capture ownership, and the matching `scope_exit` or `discarded_expr` drop
      facts before WAT emission.
    - Split the drop-plan implementation surface so shared types live in
      `src/core/drop/types.ts` and heap-drop/host-transfer step emission lives
      in `src/core/drop/emit.ts`. Static helper-function discovery and parameter
      matching live in `src/core/drop/static_function.ts`; static
      ownerless-value and non-runtime-closure classification lives in
      `src/core/drop/static_owner.ts`; moved-owner, final-escape, host-transfer,
      and unique-heap classification helpers live in
      `src/core/drop/ownership.ts`; owner-map, scope-name, exit-owner, and
      alias-resolution helpers live in `src/core/drop/state.ts`.
      `src/core/drop.ts` now stays focused on statement/expression scanning,
      owner movement, and static-call transfer analysis.

13. Host/import ownership contracts

    - Implemented bounded-borrow and direct ownership-transfer import slices. A
      `Core.host_imports` entry can describe scalar, bounded-borrow,
      frozen/shareable, and ownership-transfer argument contracts; proof records
      the signature and per-argument decision; `Core.drops(...)` records
      `host_transfer` facts for consumed direct unique owners; `Core.mod(...)`
      emits the WAT import and call.
    - Bounded-borrow imports accept `borrow owner` views and reject direct
      `unique_heap` arguments with a deterministic diagnostic. Scalar arguments
      remain ownership-neutral but still require a known import signature.
    - Direct use-after-transfer diagnostics are implemented for named owners
      consumed by ownership-transfer imports.
    - Core-level host-returned owner contracts are implemented for import
      results. A `Core.host_imports` entry can mark an imported result as
      `unique_heap` or `frozen_shareable`, and the proof/drop/final-result paths
      carry that ownership through WAT emission.
    - Frozen/shareable argument fixtures are implemented for Core imports, with
      proof-visible ownership decisions and WAT-to-Wasm coverage.
    - Scratch-backed Core import argument policy is implemented for the first
      boundary slice: explicit bounded-borrow views over scratch-backed values
      are accepted for call-bounded reads, while ownership-transfer contracts
      reject scratch-backed values before WAT emission.
    - Source-level host import contract syntax is implemented for the first
      scalar/Text slice:
      `host_import host_read from "env.read" (bounded_borrow Text) => I32`,
      `ownership_transfer Text`, `frozen_shareable Text`, scalar numeric
      parameters/results, and host-returned `unique_heap Text` or
      `frozen_shareable Text` results lower to the existing Core `host_imports`
      contract surface. Pure Ic lowering rejects those declarations with a
      structured Core/Wasm route diagnostic.
    - Source-level host import contract syntax now also accepts non-Text pointer
      ownership reasons: `bounded_borrow runtime_aggregate`,
      `ownership_transfer runtime_union`, `frozen_shareable closure`, and
      returned `unique_heap` or `frozen_shareable` owners for `runtime_union`,
      `runtime_aggregate`, and `closure`. The frontend preserves those owner
      names for formatting and lowers them to the existing Core contract
      surface.
    - Source-level host import contract syntax also accepts user-defined
      aggregate and union type-values in owner-contract positions, for example
      `bounded_borrow user_type`, `ownership_transfer result_type`, and returned
      `unique_heap user_type`. `Source.core(...)` resolves preceding top-level
      `const` struct type-values to `runtime_aggregate` and union type-values to
      `runtime_union`, including simple const aliases, while missing or non-type
      owner references reject before Core emission.
    - Implemented the first interprocedural transfer-analysis slice for direct
      calls to top-level statically bound lambda wrappers with variable
      arguments. A wrapper such as `let send = msg => host_take(msg)` now
      records the caller's owner as a `host_transfer`, removes it from the drop
      plan, and rejects later use of that owner before WAT emission.
    - Implemented the matching wrapper-aware bounded-borrow proof slice for
      source-level host imports. Expression-bodied and simple block-bodied
      wrappers such as `let read = msg => host_read(msg)` now preserve the
      underlying `bounded_borrow` host-boundary edge through `Core.proof(...)`;
      calls with `borrow message` are accepted and calls with direct
      `unique_heap Text` owners reject before WAT emission.
    - Implemented the local view wrapper slice for annotated bounded-borrow
      wrappers. A wrapper such as
      `let read = (msg: Text) => { let view = borrow msg; host_read(view) }` now
      records the underlying `bounded_borrow` host-boundary edge for
      `read(message)`, while a local alias without `borrow` still rejects a
      direct `unique_heap Text` owner before WAT emission.
    - Implemented the recursive bounded-borrow wrapper slice for statically
      bound `rec` wrapper values, for example
      `let read = rec (msg: Text) => host_read(msg)`. Calls with
      `borrow message` now preserve the underlying `bounded_borrow` edge, while
      direct unique-owner calls still reject before WAT emission.
    - Implemented the branch-selected bounded-borrow wrapper slice for annotated
      closure branches, for example
      `let read = if flag { (msg: Text) => host_read(msg) } else { (msg: Text) => host_read(msg) }`.
      The proof records a bounded-borrow edge for each possible branch when the
      call uses `borrow message`, and records deterministic rejections for each
      branch when the call passes the direct unique owner. Branch target
      scanning now binds call arguments against each branch's own parameter
      names, so alpha-renamed branches such as `message` on one side and `text`
      on the other preserve bounded-borrow host-boundary facts.
    - Implemented the higher-order bounded-borrow wrapper slice for const
      function parameters. A helper such as
      `let relay = (const f, msg: Text) => f(borrow msg)` can receive a
      statically bound bounded-borrow wrapper like `read`, preserve the
      underlying `bounded_borrow` host-boundary edge, and compile through WAT;
      the same relay without `borrow` still rejects a direct unique owner.
    - Implemented the local static-function alias slice for higher-order
      bounded-borrow wrappers. A helper such as
      `let relay = (const f, msg: Text) => { let g = f; g(borrow msg) }` now
      keeps `g` visible to borrow analysis and host-boundary proof scanning, and
      the matching `g(msg)` shape rejects the direct unique owner.
    - Implemented the next wrapper-transfer slice for top-level block-bodied
      lambda wrappers whose body is a single transfer expression or return. A
      wrapper such as `let send = msg => { host_take(msg) }` now records the
      same caller-owner transfer and rejects use-after-transfer.
    - Implemented the multi-statement block-bodied wrapper slice for wrappers
      whose block contains ownership-transfer calls before a scalar/block
      result, for example
      `let send = msg => { let code = host_take(msg); code }`. Transfer
      validation and drop planning now agree on the caller-owner
      `host_transfer`, while closure-returning helper bodies are skipped by the
      transfer-only drop scan.
    - Implemented the branch-selected top-level wrapper slice for annotated
      closure branches, for example
      `let send = if flag { (msg: Text) => host_take(msg) } else { (msg: Text) => host_take(msg) }`.
      Transfer validation records branch-scoped caller-owner `host_transfer`
      facts, drop planning records matching branch transfer steps, use after the
      wrapper transfer rejects before WAT emission, and WAT-to-Wasm coverage
      exercises the selected closure through `call_indirect`.
    - Implemented the first non-variable-argument wrapper slice for unique
      temporary expression arguments. A call such as `send(append("a", "b"))`
      through a top-level ownership-transfer wrapper now records a synthetic
      temporary transfer in validation, records an ownerless `host_transfer`
      drop-plan step for the temporary unique value, and compiles through
      WAT-to-Wasm.
    - Implemented expression-bodied temporary transfer wrappers with annotated
      parameters. A wrapper such as
      `let send = (msg: Text) => host_take(append(msg, "!"))` now seeds the
      static transfer scan with the wrapper's parameter text fact, records the
      appended temporary as an ownerless `host_transfer`, preserves the
      unannotated `msg => host_take(msg)` caller-context fallback, and compiles
      through WAT-to-Wasm.
    - Implemented the broader non-variable wrapper argument proof gate. Static
      wrapper transfer validation now checks the aliased argument ownership
      before recording a synthetic transfer: branch-created runtime text
      temporaries such as
      `send(if flag { append("a", "b") } else { append("c", "d") })` are
      accepted as `unique_heap`, while scalar named or temporary arguments such
      as `send(value)` or `send(1)` reject before WAT emission with a
      deterministic invalid transfer-argument diagnostic.
    - Implemented the branch-local wrapper-definition slice. A wrapper bound
      inside a statement list, such as
      `if flag { let send = msg => host_take(msg); send(message) }`, is now
      visible to subsequent statements in that lexical analysis scope, records
      caller-owner transfer facts, emits matching drop-plan transfer steps, and
      rejects use-after-transfer after branch merges.
    - Implemented the first recursive-wrapper slice for statically bound `rec`
      wrapper values, for example
      `let send = rec (msg: Text) => host_take(msg)`. Transfer validation and
      drop planning now treat the wrapper body like a lambda wrapper, record the
      caller-owner `host_transfer`, reject use-after-transfer, and compile the
      direct rec-wrapper call through WAT-to-Wasm.
    - Implemented the first higher-order wrapper slice for const function
      parameters. A helper such as `let relay = (const f, msg) => f(msg)` can
      now receive a statically bound ownership-transfer wrapper like `send`,
      keep the function argument as a static function value during scoped
      static-call typing/emission, record the nested caller-owner
      `host_transfer`, remove the owner from the drop plan, reject later use of
      that owner, and compile through WAT-to-Wasm.
    - Implemented the local static-function alias wrapper slice for higher-order
      transfers. A helper such as
      `let relay = (const f, msg) => { let g = f; g(msg) }` now keeps `g` as a
      static function alias during scoped static-call local collection, transfer
      validation, drop planning, and WAT emission. The nested `host_transfer` is
      recorded under `static_call/g`, use-after-transfer rejects before WAT
      emission, and WAT-to-Wasm coverage exercises the alias wrapper through the
      host import.
    - Generic wrapper templates with `const` function parameters are no longer
      scanned as ordinary runtime closure bodies by drop planning. Transfer
      validation now scopes lambda and `rec` bodies through the same annotated
      closure-body context used by transfer-target scanning, so captured runtime
      `Text` index assignment and higher-order wrapper transfer checks both pass
      through the no-GC proof gate before WAT emission.
    - Remaining work: deeper interprocedural transfer analysis for dynamic or
      more general higher-order wrappers and truly self-recursive transfer
      shapes, plus any future scratch-backed promotion policy that intentionally
      crosses the host boundary.

14. Closure ownership participation

    - Record per-slot ownership facts for closure environments.
    - Allow reusable closure capture only for scalar or `frozen_shareable`
      slots.
    - Make closures with captured `unique_heap`, `borrow_view`,
      `scratch_backed`, or source `!` values linear or reject them until linear
      closure calls are implemented end to end.
    - Implemented first proof-visible slice: `Core.closure_ownership(...)` and
      `Core.proof(...).closure_ownership` record closure capture slots with
      their ownership class. Scalar and frozen/shareable captures are marked
      allowed; `unique_heap`, `borrow_view`, and `scratch_backed` captures are
      marked reserved for linear closure ownership support. The current slice
      records the facts without changing existing closure codegen yet.
    - Implemented follow-up classification for stored `borrow` views and
      scratch-local temporaries captured by closures, so the proof surface can
      now distinguish `borrow_view` and `scratch_backed` captures instead of
      reporting them as ordinary unique heap captures.
    - Implemented first proof-gated rejection slice: reusable closures that
      capture stored `borrow_view` values or `scratch_backed` local temporaries
      now reject before WAT emission with closure-capture diagnostics.
    - Implemented follow-up proof-gated rejection slice: reusable closures that
      capture `unique_heap text` values now reject before WAT emission unless
      the text is frozen/shareable first.
    - Implemented proof-visible accepted slices for the existing non-linear
      runtime aggregate pointer, runtime union pointer, and closure-pointer
      capture paths. These now report allowed capture decisions instead of
      generic reserved unique captures, and stored runtime union pointer
      captures round-trip through WAT-to-Wasm `call_indirect`. Runtime aggregate
      pointer captures now also have type and WAT assertions for `call_indirect`
      plus captured field loads, so every current `unique_heap` reason is either
      explicitly accepted (`runtime_aggregate`, `runtime_union`, `closure`) or
      rejected (`text`) by the closure ownership proof gate.
    - Implemented a generic proof-gate check for reserved closure-capture
      decisions. Any capture slot reported as reserved now rejects before WAT
      emission, including future non-text `unique_heap` capture classes that are
      not explicitly allowed.
    - Remaining work: future `unique_heap` capture classes must either be
      explicitly accepted through reusable/frozen proof facts or rejected by the
      generic reserved-capture gate until real linear closure values are
      implemented.

15. Future explicit region package design

    - Keep ordinary `scratch {}` lexical and reset-on-exit.
    - If escaping region values are added later, model them as an explicit live
      owner package such as `{ region, value }` with Core lifetime, ownership,
      escape, and cleanup facts.
    - Do not infer attached regions from unsafe scratch returns.
    - Split this future profile into separate tasks before implementation:
      source/API shape, Core representation, region-owner lifetime facts, values
      tied to the owner, cleanup/reset/drop behavior, and host/import boundary
      rules.

## Memory Direction

This section is retained as explanatory background. The authoritative contract
and active implementation tracks above win if an older note below is less
specific.

The baseline memory model is:

- Runtime heap values are unique by default. They can be moved, consumed,
  borrowed, frozen, or explicitly dropped, but they cannot be implicitly copied.
- `borrow value` creates a lexical read-only view. It is a convenience for
  analysis and API contracts, not a new owning value.
- `freeze value` consumes unique ownership and produces immutable shareable
  storage. Freezing or promoting out of scratch storage must be an explicit Core
  operation before WAT emission.
- `scratch { ... }` is the MVP temporary arena construct: a lexical scratchpad
  with a value result. It does not return an attached live region. Any returned
  value must be scalar, frozen, promoted, or proven not to reference reset
  scratch storage.
- Scratchpads are the source-level scratchpad surface for temporary
  computations. They are allowed to make temporary values easy to share inside
  the scope, but the reset boundary remains lexical and explicit.
- Cleanup is inserted from facts. Scratch scopes reset on every exit edge;
  unique heap values record drop facts at known lifetime ends; scalar and
  already-frozen values need no runtime cleanup.
- Optional named or nested regions can be considered after `scratch {}` is
  stable, but they should reuse the same lifetime ids, escape facts, and
  cleanup/reset machinery.
- A future attached-region value can be explored as an explicit owning package
  such as `{ region, value }`, where the returned value is tied to the returned
  region lifetime. This is not the MVP surface. The MVP should first prove the
  simpler `scratch { ... }` rule: reset the scratchpad before the result can
  observe dangling scratch storage.
- GC, Wasm-GC, or tracing storage is a future separate backend profile. It is
  not a fallback for missing facts in the baseline linear-memory backend.
- If a scratch, borrow, freeze, closure, or host-boundary case is hard to
  analyze, split it into narrower proof fixtures or reject it deterministically.
  Do not keep the case accepted by adding "let GC decide" behavior to the
  baseline.
- The baseline efficiency target is static cleanup: scalar locals copy, scratch
  storage resets in O(1), frozen values share without tracing, and unique-heap
  drops are represented even while the first bump allocator treats them as
  no-ops.

## Research Notes

- Dynamic behavior that needs loops, mutation, memory, or first-class closure
  storage should go through structured `Core` before WAT. The Ic frontend should
  stay focused on pure scalar/text-pointer graph lowering, static expansion, and
  interaction-calculus reductions.
- `Core` already preserves unknown `collection_loop`, `index`, and
  `index_assign` nodes, and already emits dynamic `range_loop` control flow. The
  missing piece for unknown collections is mostly facts and memory/runtime
  representation, not a new loop syntax.
- Runtime closures and runtime union values already use a shared bump-allocation
  model through `closure_heap_global`. Runtime aggregates should reuse that heap
  path instead of introducing another allocator.
- Runtime union payload support is already layout-driven for scalar, `Text`,
  `Unit`, union-pointer, and aggregate-pointer struct payloads. Broader payloads
  should extend that layout path instead of adding case-specific emitters.
- Linear checking already validates many source paths before lowering. The main
  unresolved design is how a first-class closure owns captured linear values and
  how an effectful capability method maps to imports or runtime function
  pointers.
- Runtime heap aggregate values should be unique by default. Sharing mutable
  heap values requires explicit `borrow` or `freeze`.
- `borrow value` creates a read-only view whose lifetime is bounded by the
  current block, loop iteration, function call, or scratchpad scope. Borrowed
  views cannot escape, and the borrowed unique value cannot be moved, mutated,
  or frozen until the borrow ends.
- The concrete borrow/view source shape is `borrow owner`; a stored view is just
  `let view = borrow owner`. A stored view remains non-owning and read-only, and
  its lifetime must be proven no longer than the owner lifetime.
- `freeze value` consumes a unique owned value and produces an immutable
  shareable value. It may copy or promote out of scratch storage as needed.
- `scratch { ... }` is a temporary bump-allocation scope with a return value.
  Scratch storage is reset at block exit. The returned value must be scalar,
  proven not to reference scratch storage, or explicitly moved/promoted/frozen
  into non-scratch storage.
- `scratch { ... }` is not intended to grow into an implicit region object. If a
  later design needs a region to outlive the block, that should be an explicit
  value such as a region owner plus values tied to that owner.
- The baseline backend should use static lifetime and escape analysis. Do not
  add a GC fallback for uncertain scratchpad escapes. A future Wasm-GC backend
  may be a separate compile target, but it should not change baseline linear
  memory semantics.
- The compiler should insert cleanup at known lifetime ends. Scratch cleanup is
  required and resets the scratch pointer on all exits. General unique-heap drop
  points may initially lower to no-ops with the bump allocator, but the analysis
  should still produce them.
- `scratch { ... }` is a lexical scratchpad scope, not a general region object
  exposed to source programs. It has a return value, but that value must not
  carry a pointer into reset scratch storage unless the compiler can prove it is
  scratch-free or explicitly promotes/freezes it.
- Optional longer-lived regions are a separate owner-package feature. They may
  reuse lifetime machinery from scratchpads, but they must not add implicit
  managed storage or be inferred from ordinary `scratch {}`. Later named or
  nested arenas should produce explicit lifetime ids, reset/drop edges, owner
  move/consume facts, and return-value escape facts.
- If later region values are allowed to escape a block, make that escape
  explicit in Core as a live region owner plus values tied to that owner. Do not
  infer an attached region implicitly from an unsafe scratch return.
- Temporaries created by lowering should receive cleanup at their proven
  lifetime end. Scalar and frozen temporaries need no runtime cleanup,
  scratch-backed temporaries reset with the scratch scope, and unique-heap
  temporaries record drop points even if the initial bump allocator lowers them
  to no-ops.
- The baseline backend should make allocation choices from static facts. Do not
  add a "let GC decide" fallback to the default target. If an escape, borrow, or
  scratch lifetime cannot be proven, fail with a deterministic diagnostic and
  leave managed GC as a future separate backend target.
- The practical requirement is to make the baseline analysis complete enough for
  the supported source surface, not to compensate with runtime tracing. GC or
  Wasm-GC can be researched later as a different backend profile with different
  storage and boundary rules.

## Memory Model Decisions

Use these storage/lifetime facts throughout the remaining tasks:

```txt
scalar_local      copyable Wasm local value
unique_heap       owned linear-memory pointer, mutable if facts allow it
borrow_view       read-only view tied to a lexical lifetime
frozen_shareable  immutable value that may be duplicated freely
scratch_backed    pointer into the active scratchpad scope
```

Rules:

- Runtime aggregate, text, union, and closure-environment pointers start as
  `unique_heap` unless produced inside `scratch {}`.
- A `borrow_view` may be copied as a view, but it cannot outlive its owner and
  cannot be used for mutation.
- A `unique_heap` value cannot be copied. It can be moved, borrowed, frozen, or
  consumed by a linear operation.
- A `frozen_shareable` value is immutable and may cross branches, closures, and
  scratch boundaries.
- A `scratch_backed` value may be used freely inside the active scratchpad
  according to its ownership facts, but it cannot escape unless promoted,
  frozen, scalarized, or proven scratch-free.
- A value returned from `scratch { ... }` carries the scratch lifetime until
  escape analysis proves otherwise. Returning does not extend the scratchpad
  lifetime; it either produces a scratch-free value, emits explicit
  promotion/freeze before reset, or rejects.
- Cleanup/reset edges must be explicit in Core before WAT emission so structured
  Wasm `block`/`loop`/`br` lowering cannot skip them.
- Every runtime allocation site should record the selected storage class and the
  reason for that choice: static data, scalarized local, persistent unique heap,
  frozen heap, scratch arena, or rejected uncertain escape.

## Static Analysis Gate

The baseline implementation should skip GC by making the analysis precise enough
for the supported source surface. A program may reach WAT emission only after
the compiler can prove all of these facts:

- Each runtime value has a storage class and lifetime id.
- Each borrow has a source owner, target lifetime, and proof that the target
  cannot outlive the owner.
- Each scratch result is scalar, frozen/shareable, explicitly promoted, or
  proven not to reference scratch storage before the scratch pointer resets.
- Each unique heap owner is moved, consumed, returned, or assigned a
  deterministic drop point.
- Each lowering-created temporary is cleaned up at the same proven lifetime end
  as an equivalent source value.
- Each ownership-bearing value that needs path sensitivity is tracked by the
  same linear/unique state engine, while scalar and frozen values bypass that
  engine as copy/share values.
- Each unknown host/import call is treated as escaping unless its signature
  explicitly accepts a bounded borrow.

If any proof is missing, the baseline backend must reject with a deterministic
diagnostic. It must not silently promote, trace, or hand the value to a runtime
collector. Managed GC or Wasm-GC can be added later only as a separate target
profile with its own storage facts, boundary rules, and tests.

## No-GC Proof Harness

Task 12.2 should grow a small harness that proves the baseline target is
analysis-complete for the accepted surface instead of relying on managed
storage. The harness should cover:

- ownership decisions for source values and lowering-created temporaries
- borrow creation, stored borrow views, owner barriers, and borrow escapes
- `freeze` over direct owners, block/branch results, and scratch-backed values
- `scratch {}` fallthrough, `return`, `break`, and `continue` reset edges
- optional branches and loops where a value may or may not be consumed
- closure captures by storage class: frozen, unique, borrowed, and
  scratch-backed
- unknown host/import calls as escaping unless they declare bounded-borrow facts

Each accepted fixture should expose the facts used by WAT emission: storage
class, lifetime id, escape edge, cleanup/reset edge, and drop or ownership
transfer decision. Each rejected fixture should assert the deterministic
diagnostic. No accepted baseline fixture should select a GC or Wasm-GC escape
path; those remain separate future target profiles. The proof output should make
this visible with `managed_storage: "disabled"` or an equivalent baseline
profile marker.

## No-GC Memory Implementation Queue

Use this queue before broadening runtime aggregates, general mutation, or
effectful imports. Each item should add proof output, accepted fixtures, and
rejected diagnostics before the next item depends on it.

No queue item may accept a baseline fixture by selecting managed storage. The
required shape is: prove the value's storage/lifetime facts, emit explicit
cleanup/reset/promotion where needed, or reject with a deterministic diagnostic.
When the proof shape is too broad, split the task by value category, for example
scalar, static aggregate, static union case, dynamic static-union `if`, runtime
heap aggregate, runtime union payload, runtime text, and closure environment.
This triage rule also applies to compiler-created temporaries and source-level
scratchpad returns; both need the same proof facts as ordinary values before
they can reach WAT emission.

1. Proof contract and no-GC acceptance gate

   - Make the baseline proof check the gate before WAT emission. Accepted
     programs must expose storage class, lifetime id, escape edge, borrow
     validity, scratch reset edge, freeze/promotion edge, and drop/transfer
     decisions for every runtime value and lowering-created temporary.
   - The proof must state whether a value participates in linear/unique
     path-sensitive analysis. Participation is required for capabilities, unique
     owners, active borrow barriers, scratch-backed owners, and captured
     ownership-bearing closure slots, and should be absent for scalar/frozen
     copy/share values.
   - Add fixtures that prove skipped GC is an intentional backend contract:
     accepted fixtures show the facts used by emission, and rejected fixtures
     fail with deterministic missing-fact diagnostics.

- Do not allow any later queue item to accept a case by silently promoting,
  tracing, or delegating lifetime decisions to a managed runtime.
- Keep each queue item reviewable by pairing every newly accepted shape with a
  proof fixture and every unsupported shape with a deterministic rejection. A
  case is not done just because it could be handled by a future collector.

2. Host/import boundary facts

   - Implemented Core signature slices for scalar, bounded-borrow,
     frozen/shareable, and direct ownership-transfer argument contracts on
     `Core.host_imports`.
   - `Core.host_boundaries(...)` and `Core.proof(...)` report matched import
     signatures and per-argument decisions before WAT emission.
   - `Core.drops(...)` reports `host_transfer` facts when an ownership-transfer
     import consumes a direct `unique_heap` owner.
   - `Core.proof(...)` reports transfer-validation issues when a transferred
     owner is used later in the same Core program path.
   - `Core.mod(...)` emits WAT imports and direct calls for known host imports.
   - Bounded-borrow contracts accept explicit `borrow` views. Unknown imports
     and direct `unique_heap`, `borrow_view`, or `scratch_backed` arguments
     without a matching contract reject before WAT emission.
   - Core-level host-returned owner contracts are implemented for imported
     results, including proof-visible signatures, owned final-result escape
     facts, scope-exit drops for bound unique results, and WAT import calls.
   - Frozen/shareable Core import arguments have proof and WAT fixture coverage.
   - Scratch-backed Core import arguments have proof coverage: bounded-borrow
     views are accepted, and ownership transfer rejects scratch-backed storage.
   - Source-level contract declarations are implemented for scalar numeric ABI
     values, Text ownership contracts, explicit non-Text pointer owner reasons,
     and user-defined aggregate/union type-value owner references. Direct,
     single-expression block, multi-statement block, and branch-selected
     annotated closure top-level transfer wrappers are covered, including
     temporary unique expression arguments such as `send(append(...))` and
     branch-local wrapper definitions visible to later statements in the same
     lexical analysis scope. Remaining work is deeper interprocedural transfer
     analysis for higher-order/recursive wrappers, broader non-variable-argument
     wrappers, and any future scratch-backed promotion policy that crosses the
     boundary intentionally.

3. Runtime aggregate ownership facts

   - Materialized structs/objects need pointer, layout, storage class, lifetime,
     and owner facts.
   - Static-shaped aggregate facts remain compiler facts until an expression
     actually materializes a runtime pointer.

4. Scratch allocation selection

   - Route temporary aggregate/text/union payload allocations inside
     `scratch {}` to the scratch pointer only when escape analysis proves they
     die inside the scope.
   - Mark those values as `scratch_backed` with the scratch lifetime id and the
     allocation reason, so later borrow, freeze, escape, and cleanup checks do
     not have to rediscover where the pointer came from.
   - Keep persistent heap allocation for values that are returned, captured, or
     otherwise proven to escape safely.
   - Implemented first slices: temporary runtime aggregate materialization,
     runtime text concatenation, and runtime union value materialization inside
     an active `scratch {}` body use `__scratch_heap` when the scratch result is
     scalar or otherwise scratch-free.

5. Scratch escape enforcement

   - Reject returned scratch-backed values unless they are scalar, frozen,
     promoted, or proven scratch-free.
   - If a returned value contains both scratch-backed and non-scratch fields,
     track that at the field/layout level instead of treating the whole value as
     safe by default.
   - Prove scratch-free static-shaped aggregate and static union results before
     heap-backed aggregate and union payload escapes. Dynamic static-union `if`
     results are accepted only when the condition and both case payloads are
     scratch-free.
   - Make every rejected case point at the escape edge that forced the decision.

6. Freeze and promotion codegen

   - Implement immutable heap copy/promotion for supported heap-backed values.
   - Promotion from scratch to persistent heap is an explicit Core edge emitted
     before the scratch reset; it is not an implicit repair in type checking,
     proof checking, or WAT emission.
   - Preserve idempotent `freeze` for already-frozen values and mutation
     rejection through frozen storage.

7. Temporary cleanup completion

   - Extend drop/reset planning to lowering-created temporaries from aggregate
     materialization, runtime text operations, union payload construction, and
     closure environment setup.
   - Cleanup facts must cover compiler-created temporaries even when the source
     expression is otherwise scalarized, so future materialization choices do
     not accidentally skip drops or scratch resets.
   - Keep bump-allocator drops as analysis facts until a reusable allocator or
     destructor path exists.

8. Runtime aggregate memory slice

   - The current implementation already has the first persistent-heap slice:
     runtime aggregate allocation, field stores, local/fact propagation for
     stored aggregate pointers, and field loads from those stored pointers.
   - Continue by integrating that representation with scratch allocation,
     scratch-backed aggregate rejection/promotion tests, full aggregate-pointer
     closure capture semantics, and the broader cleanup proof facts from the
     preceding items.

9. Future managed profile

   - Only after the no-GC baseline is stable, consider a separate managed or
     Wasm-GC target with its own storage classes, ABI, and tests.
   - Do not let that future profile weaken baseline proof requirements.
   - Do not use this item to unblock any `core-3-nonweb` fixture. A baseline
     fixture must either prove ownership/lifetime safety with explicit
     cleanup/reset/promotion or reject before WAT emission.

Immediate refinement tasks from the memory decision:

1. Finish the baseline proof gate audit.

   - Check every current `Core.emit` and `Core.mod` accepted feature against the
     no-GC contract.
   - Add missing proof facts or reject the feature before emission.
   - Include lowering-created temporaries in the same audit as source values.

2. Make scratch-backed facts field-sensitive.

   - Runtime aggregate, union payload, and text-operation temporaries can be
     scratch-backed internally, but returned aggregate values need field-level
     scratch-free, frozen, promoted, or scalar proofs.
   - Reject whole-value escapes when any field may still reference reset scratch
     storage.

3. Implement explicit freeze/promotion codegen.

   - Consume the source owner, allocate/copy into persistent frozen storage, and
     emit the promotion before scratch reset when the source is scratch-backed.
   - Record the resulting `frozen_shareable` fact so branch merge, closure
     capture, and return paths can duplicate the value safely.

4. Complete host/import ownership contracts.

   - Treat unknown imports as escaping.
   - Bounded-borrow signatures are implemented at the Core import boundary and
     accept explicit borrow views.
   - Direct ownership-transfer signatures are implemented for `unique_heap`
     owners and record `host_transfer` facts in `Core.drops(...)`.
   - Host-returned owner facts are implemented for Core import result contracts.
   - Frozen/shareable Core import arguments have proof and WAT fixture coverage.
   - Scratch-backed Core import arguments are classified at the boundary:
     explicit bounded borrows are accepted, and ownership transfer rejects them.
   - Source-level contract syntax is implemented for scalar numeric ABI values,
     Text ownership contracts, explicit non-Text pointer owner reasons, and
     user-defined aggregate/union type-value owner references. Add deeper
     interprocedural transfer analysis before allowing more wrapper shapes to
     transfer broader heap values across the boundary.

5. Extend cleanup from facts, not emit shape.

   - Add cleanup/drop/reset facts for temporaries introduced by runtime
     aggregate materialization, text copy/slice/concat loops, union payload
     construction, closure environment setup, and promotion.
   - Keep unique drops as no-op bump-allocator facts until reusable allocation
     or destructors are added.

## Task 12.2 Implementation Task Split

Use this split to make the no-GC baseline implementable and reviewable. Each
slice should add accepted fixtures, rejected fixtures, and proof output checks
before the next slice depends on it.

### 12.2.a Storage Classification

- Classify every runtime allocation site and lowering-created temporary as
  `scalar_local`, `unique_heap`, `borrow_view`, `frozen_shareable`,
  `scratch_backed`, or rejected.
- Record the source type, storage class, lifetime id, allocation reason, and
  escape reason for each allocation fact.
- Treat static-shaped aggregate values, static aggregate updates, extension
  objects, and type values as ownerless compiler facts unless they are
  materialized as runtime heap values.
- Reject any value that reaches WAT emission without a storage class.

Acceptance tests:

- Scalar, static text, static-shaped aggregate, closure environment,
  runtime-union payload, and scratch-produced values report the expected storage
  class.
- Unknown storage selection rejects with a deterministic diagnostic.
- Lowering-created temporaries appear in the same fact table as source values.

### 12.2.b Lifetime And Escape Facts

- Assign lexical lifetime ids for program bodies, blocks, loop iterations,
  function calls, closure environments, and scratchpads.
- Record escape edges for final results, explicit `return`, branch/loop merges,
  closure captures, heap/global/module stores, scratch returns, and unknown
  host/import calls.
- Treat unknown host/import calls as escaping unless their signature explicitly
  says an argument is a bounded borrow or ownership transfer. The first Core
  signature slices are implemented for bounded-borrow imports, direct
  ownership-transfer imports, and host-returned owner results.
- Reject values whose storage class cannot survive the target lifetime.

Acceptance tests:

- Returning, capturing, branch-merging, and scratch-returning values expose the
  edge that caused the escape decision.
- Unknown imports reject unique, borrowed, or scratch-backed arguments. Known
  bounded-borrow imports accept explicit `borrow owner` views and reject direct
  unique-owner arguments unless the signature uses ownership transfer. Known
  ownership-transfer imports consume direct unique-owner arguments and reject
  borrowed views.
- Optimization or static-call rewrites preserve lifetime ids and escape facts.

### 12.2.c Borrow/View Checking

- Keep the concrete source syntax as `borrow owner` and
  `let view = borrow owner`.
- A borrow view is read-only and non-owning. It can be copied as a view, but it
  cannot outlive the owner and cannot be used for mutation.
- While a borrow is active, the borrowed unique owner cannot be moved, mutated,
  frozen, or consumed by another owning operation.
- Support block-, loop-iteration-, function-call-, closure-body-, and
  scratchpad-bounded borrows.

Acceptance tests:

- `borrow owner` works for read-only consumers inside the bounded lifetime.
- Stored views are accepted when they remain in the current block and rejected
  when returned, captured, stored into longer-lived state, or carried past the
  owner.
- Owner mutation, move, replacement, and `freeze` reject while a view is live.

### 12.2.d Scratchpad Regions

- Treat `scratch { ... }` as the MVP region-like construct: a lexical scratchpad
  with a value result and an explicit reset boundary.
- Use scratchpads for temporary computations and easy sharing inside the scope;
  do not expose an implicit region object in the MVP.
- Save the scratch pointer on entry and reset it on fallthrough, `return`,
  `break`, and `continue` exits that leave the scratch lifetime.
- A scratch result may escape only when it is scalar, already
  `frozen_shareable`, explicitly promoted/frozen into non-scratch storage, or
  proven not to reference scratch storage.

Acceptance tests:

- Scratch reset facts and WAT resets exist on every exit edge.
- Scratch-backed temporary text/aggregate/union values are valid inside the
  scratch scope.
- Direct and block-local runtime text scratch freeze records a scratch
  allocation, persistent promotion allocation, and frozen scratch return without
  enabling managed storage.
- Scoped static-call runtime text scratch freeze records the final frozen
  result, scratch reset, and freeze proof edge instead of relying only on
  emitted WAT.
- Returning a value that may point into reset scratch storage rejects unless an
  explicit promotion or `freeze` happened first.
- Unsupported non-text scratch temporary promotion remains rejected until the
  proof can tie the temp to a safe persistent promotion edge.

### 12.2.e Freeze And Promotion

- Make `freeze value` consume a `unique_heap` value and produce immutable
  `frozen_shareable` storage.
- Treat `freeze` over already-frozen values as idempotent.
- Implement scratch-to-persistent promotion as an explicit Core operation before
  scratch reset, not as an implicit typechecker or WAT-emitter repair.
- Reject mutation through frozen values and reject freeze when ownership is
  borrowed, already moved, or otherwise unavailable.

Acceptance tests:

- Freezing direct owners, block results, branch results, and accepted direct
  scratch-backed runtime text values records the owner-consumption or promotion
  edge.
- Frozen values can be duplicated, captured, branch-merged, and returned without
  unique-owner drops.
- Mutation through a frozen value rejects.
- Unsupported scratch-backed freeze shapes reject deterministically before WAT
  emission instead of selecting GC.

### 12.2.f Unique And Linear State

- Reuse path-sensitive control-flow state for source `!` capabilities and
  move-only `unique_heap` values where the rules align.
- Keep the concepts distinct: capability tokens are exactly-once linear values;
  ordinary unique heap values are owned values that may be moved, consumed,
  frozen, borrowed, returned, or dropped.
- Capability tokens cannot become `frozen_shareable` and should not be borrowed
  as shareable data.
- Closure environments must record per-slot ownership facts. A closure that
  captures a unique or linear value is reusable only when the capture is frozen
  or otherwise proven shareable; otherwise the closure itself must be linear or
  rejected.

Acceptance tests:

- Branches and loops merge source linear capability state and unique-owner state
  deterministically.
- Unique owners are never implicitly copied through assignment, branch merge,
  closure capture, or specialization.
- Capturing unique/linear values in first-class closures either produces a
  linear closure or rejects.

### 12.2.g Cleanup, Drops, And Proof Gate

- Insert cleanup for source values and compiler-created temporaries at their
  proven lifetime end.
- Scratch-backed values reset with the scratchpad. Unique heap values record
  drop facts even while the first bump allocator lowers drops to no-ops.
- Wire the final no-GC proof gate before WAT emission after `Core.drops(...)`
  covers every accepted Core feature.
- The proof gate must report storage classes, lifetime ids, escape decisions,
  borrow decisions, scratch reset edges, freeze/promotion edges, and unique
  owner drop or transfer decisions.

Acceptance tests:

- Accepted fixtures expose every fact WAT emission depends on.
- Rejected fixtures assert deterministic diagnostics for missing storage,
  lifetime, borrow, scratch escape, freeze/promotion, host-call, or cleanup
  facts.
- No accepted `core-3-nonweb` fixture selects managed GC or Wasm-GC storage.

### 12.2.h Future Region And Managed-Storage Profiles

- Defer named arenas and attached-region returns until `scratch {}` analysis is
  stable.
- If attached-region returns are added, represent them explicitly as a live
  region owner plus values tied to that owner. Do not infer them from ordinary
  scratch returns.
- Keep reusable allocators, destructors, managed GC, and Wasm-GC as separate
  follow-up backend profiles with separate storage and boundary rules.

Acceptance tests:

- Ordinary `scratch {}` cannot return a hidden attached region.
- A future attached-region value must carry an explicit owner/lifetime fact.
- Baseline proof output continues to show `managed_storage: "disabled"`.

### 12.2.i Decision-To-Fixture Matrix

Use this matrix to split future memory work into reviewable vertical slices.
Each accepted fixture must expose the proof facts it relies on; each unsupported
fixture must reject before WAT emission.

1. Unique ownership

   - Track moves, replacement, mutation, freeze, return, and drop for every
     `unique_heap` owner.
   - Reject implicit copies through assignment, branch merge, closure capture,
     specialization, or aggregate field aliases.
   - Fixtures: direct move, branch move, loop-carried owner, field alias owner,
     discarded temporary, and returned owner.

2. Borrow/views

   - Keep the source surface as `borrow owner` and `let view = borrow owner`.
   - Views are read-only and non-owning. They may be copied as views but cannot
     escape the owner lifetime.
   - Fixtures: bounded read-only call, stored local view, branch-created view,
     loop-created view, returned view rejection, captured view rejection, and
     owner mutation/freeze rejection while the view is live.

3. Scratchpads

   - Treat `scratch { ... }` as a lexical scratchpad with a value result and no
     hidden attached region.
   - Reset the scratch pointer on fallthrough, `return`, `break`, and `continue`
     exits that leave the scope.
   - Fixtures: scalar return, scratch-backed temporary used inside the scope,
     scratch-backed return rejection, field-sensitive scratch-free aggregate
     return, and branch/`if let` scratch result.

4. Frozen/shareable values

   - Make `freeze` consume a unique owner or promote a supported scratch-backed
     value into persistent immutable storage.
   - Frozen values can be duplicated, branch-merged, captured, and returned.
   - Fixtures: direct runtime text freeze, scratch text promotion, runtime
     aggregate freeze, runtime union freeze, closure-environment freeze, frozen
     mutation rejection, and idempotent freeze over already-frozen data.

5. Cleanup and temporaries

   - Insert cleanup from ownership/lifetime facts, not from ad hoc WAT emitter
     shape.
   - Scratch cleanup emits real resets. Unique heap drops may remain no-op facts
     under the first bump allocator, but they must still be present.
   - Fixtures: runtime aggregate materialization temp, text copy/concat temp,
     union payload temp, closure environment temp, promotion temp, discarded
     expression, early `return`, loop `break`, and loop `continue`.

6. Linear participation

   - Apply path-sensitive linear/unique analysis only to source `!`
     capabilities, `unique_heap` owners, active `borrow_view` barriers,
     `scratch_backed` values, and closure slots containing any of those values.
   - Keep scalar locals and already-frozen values copy/share values.
   - Fixtures: capability exactly-once use, unique-owner move, frozen capture,
     rejected unique capture in reusable closure, accepted linear closure, and
     rejected double call of a linear closure.
   - Implemented first closure fixture: proof output distinguishes scalar and
     frozen/shareable captures from unique captures that remain reserved for
     linear closure ownership.
   - Implemented follow-up closure fixture: stored borrow-view captures and
     scratch-backed local captures are now classified separately and remain
     proof-gated rejections until linear closure values are implemented.
   - Implemented `unique_heap text` closure-capture rejection. Existing runtime
     aggregate pointer, runtime union pointer, and closure-pointer captures now
     expose allowed proof decisions. Remaining closure fixtures need any broader
     capture shapes to land as reusable/frozen proof facts, deterministic
     rejections, or linear closure call support.

7. Host/import boundaries

   - Treat unknown non-scalar imports as escaping.
   - Accept heap-backed values only with explicit bounded-borrow or
     ownership-transfer signatures.
   - Implemented fixtures: scalar import argument, bounded-borrow import through
     `borrow owner`, direct ownership-transfer import for a unique owner,
     borrowed-value rejection for transfer, direct use-after-transfer rejection,
     host-returned owned and frozen/shareable results, frozen/shareable import
     arguments, scratch-backed bounded-borrow arguments, scratch-backed transfer
     rejection, and unknown/direct-owner rejection before WAT emission.
   - Implemented source-level fixtures: bounded-borrow `Text`, transfer `Text`,
     frozen/shareable `Text`, scalar numeric signatures, and host-returned
     `unique_heap Text` contracts lower to Core imports; source WAT output calls
     the imported function with the declared ownership contract.
   - Remaining fixtures: deeper interprocedural transfer analysis and any future
     scratch-backed promotion policy that intentionally crosses a host boundary.

## Recommended Order

1. Add compile-target routing and diagnostics.
2. Lock the analysis-first baseline memory policy: unique by default, lexical
   borrows, explicit `freeze`, lexical `scratch {}` scratchpads, and
   deterministic rejection when escape analysis is uncertain.
3. Define ownership facts, lifetime scopes, escape analysis, and drop/reset
   elaboration.
4. Implement borrow/view checking on top of lexical lifetime scopes.
5. Implement scratchpad arena allocation and reset insertion.
6. Implement freeze and explicit scratch-to-heap promotion.
7. Add unique-heap drop planning for source values and lowering-created
   temporaries. Drops can lower to no-ops under the first bump allocator.
8. Add the no-GC proof harness for accepted/rejected ownership, borrow, scratch,
   freeze, closure-capture, temporary-cleanup, and host-call cases.
9. Implement runtime aggregate memory representation.
10. Implement fact-directed runtime indexing and collection loops.
11. Generalize memory-backed mutation.
12. Expand dynamic `if let` through structured Core.
13. Expand runtime union payloads on top of aggregate memory.
14. Add runtime text operations that need allocation/copy loops.
15. Add effectful capability method ABI.
16. Add first-class linear closure captures.
17. Sweep remaining `Cannot ... yet` Core/Ic diagnostics.

This order puts representation and facts before features that depend on them.

## Task 12.1: Compile-Target Routing

### Problem

The current frontend-to-Ic path rejects dynamic range loops, unknown collection
loops, unknown dynamic `if let`, memory-backed mutation, and effectful linear
capabilities. Some of these already have a structured `Core` representation and
should not be forced through Ic.

### Implementation

- Add an explicit API boundary for "pure Ic lowerable" versus "structured
  Core/Wasm required".
- Keep `Source.compile` or the current test helper strict if it is intended to
  prove Ic lowering.
- Add or document a `Source.mod`/`Source.wat` style path for source snippets
  that need structured Core.
- Improve diagnostics so they say whether a feature is unsupported entirely or
  only unavailable on the Ic path.

### Likely Modules

- `src/frontend/source.ts`
- `src/frontend/lower.ts`
- `src/core/from_source.ts`
- `src/core/from_source/context.ts`
- `src/core/from_source/expr.ts`
- `src/core/from_source/host_import.ts`
- `src/core/from_source/stmt.ts`
- `src/wasm_*.test.ts`
- `src/frontend.test.ts`

### Acceptance Tests

- A dynamic range loop still rejects on the pure Ic helper.
- The same dynamic range loop compiles through `Source -> Core -> Mod -> WAT`.
- Unknown dynamic collection and `if let` diagnostics mention the required
  structured path when appropriate.

### Implementation Status

- `Source.compile` remains the strict pure-Ic entrypoint.
- `Source.core` now accepts either parsed source or source text and lowers
  through the structured Core bridge.
- Source-to-Core context state, fresh shadow aliases, host-import owner
  type-value tracking, host-import contract conversion, statement lowering, and
  expression lowering are split under `src/core/from_source/`, leaving the main
  bridge as the public program-level facade.
- `Source.mod` and `Source.wat` expose the structured Core/Wasm route for source
  text or parsed source. `Source.wat` emits a full WAT module through the
  existing `Core.mod` and `Mod.emit` path.
- `Source.core_file`, `Source.mod_file`, and `Source.wat_file` now expose the
  same structured route for file-backed programs after import resolution, while
  `Source.compile_file` remains the strict pure-Ic file helper.
- Unresolved import diagnostics now point to the file-loading API surface:
  `Source.load`, `Source.compile_file`, `Source.core_file`, `Source.mod_file`,
  and `Source.wat_file`.
- Source-level annotated dynamic tail recursion now compiles through
  `Source.wat`; the host-boundary proof pass recognizes internal `rec(...)` tail
  calls and no longer records them as unknown host/import calls.
- Ic-only diagnostics for dynamic range bounds, unknown collection loops,
  untyped dynamic `if let`, rec values/dynamic rec cases, and unknown index
  expressions, unknown field access, or memory-backed index assignment now point
  callers to `Source.core`, `Source.mod`, or `Source.wat`.
- Core/WAT emission still requires typed Core locals. A source snippet with an
  unbound dynamic range bound can be preserved as Core for diagnostics, but it
  must be typed before WAT emission.

## Task 12.2: Ownership, Borrow, Freeze, And Scratchpad Analysis

### Problem

Runtime heap values need an ownership model before general memory-backed
aggregates, mutation, and temporary allocation can be safe. The default backend
should remain baseline linear-memory Wasm, so it cannot rely on GC to rescue
uncertain scratchpad escapes. The task is to make the static analysis precise
enough for the supported source surface, then reject programs outside that
surface until a separate managed backend exists.

Latest implementation direction: keep this task as the no-GC memory/lifetime
gate. It must cover unique ownership, borrow/view checking, value-returning
scratchpads, explicit freeze/promotion, cleanup for source values and
compiler-created temporaries, and storage-driven linear participation. When a
case is hard to analyze, split it by value category and escape shape instead of
adding GC, hidden attached regions, implicit promotion, or runtime-discovered
cleanup to the baseline.

Latest no-GC refinement: skipping GC is allowed only because the accepted
baseline surface is statically proven. Each hard memory case should start as a
proof task, not a runtime-management task: classify storage, attach lifetime
ids, prove borrow/view validity, prove scratch escape before reset, plan
freeze/promotion if needed, and insert cleanup/drop/reset decisions from those
facts. If any row is missing, split the case more narrowly or reject before WAT
emission. Do not keep the case accepted by adding a collector, hidden attached
region, implicit promotion, or WAT-emitter cleanup inference.

### Implementation

Split the feature into small vertical slices:

1. Backend lifetime policy

   - Keep the default backend purely static for ownership/lifetime decisions. If
     the compiler cannot prove an escape, borrow, scratch lifetime, or promotion
     is valid, it must reject before WAT emission.
   - Do not add a "let GC decide" mode to the baseline backend. Managed or
     Wasm-GC storage can be explored later as a separate compile target with its
     own lowering rules.
   - Treat `scratch { ... }` as the MVP region surface: a lexical scratchpad
     scope with a return value and explicit reset/drop facts, not a first-class
     region object.
   - Require every allocation and compiler-created temporary to carry enough
     facts for cleanup planning: storage class, lifetime id, escape edge, and
     drop/reset behavior.
   - Elaborate cleanup/reset in Core before structured Wasm emission so
     fallthrough, `return`, `break`, and `continue` cannot bypass it.

2. Ownership fact surface

   - Add ownership/lifetime facts for runtime values: `scalar_local`,
     `unique_heap`, `borrow_view`, `frozen_shareable`, and `scratch_backed`.
   - Classify static text/data segments as `frozen_shareable`, integer/float
     locals as `scalar_local`, and runtime text/aggregate/union/closure pointers
     as `unique_heap` unless allocated inside a scratch scope.
   - Attach an allocation-site fact that records storage class, source type,
     layout facts if any, lifetime id, and escape reason.
   - Keep mutable writes gated by unique/linear ownership facts.

3. Lifetime scopes and escape analysis

   - Introduce lexical lifetime ids for function bodies, blocks, loop
     iterations, call arguments, closure environments, and scratchpads.
   - Mark a value as escaping when it is returned, stored in heap/global/module
     state, captured by a closure that may escape, merged into an outer branch
     result, or passed to an unknown host/import API.
   - Treat unknown imports and host calls as escaping unless their signature
     explicitly accepts a bounded borrow.
   - Reject values whose storage class cannot survive the target lifetime, with
     diagnostics that say which escape edge caused the rejection.

4. Borrow/view checking

   - Parse and represent `borrow expr`.
   - Treat `borrow` as a read-only view, not a copy of owned data.
   - Support stored views through normal binding syntax such as
     `let view = borrow owner`; do not introduce a separate region-reference
     type that can outlive the owner.
   - Give every borrow edge a source owner, lexical lifetime id, and target
     lifetime. The target lifetime must be no longer than the owner lifetime.
   - Model `borrow` over scalars and already-frozen values as a no-op view.
   - Reject returning, storing, or capturing a borrow when the target lifetime
     can outlive the borrowed owner.
   - Reject mutation, move, or `freeze` of a unique owner while a borrow is
     active.
   - End borrows at the nearest block, loop-iteration, call, or scratchpad
     lifetime boundary.

5. Scratchpad scopes

   - Parse and represent `scratch { ... }`.
   - Treat `scratch { ... }` as the first region-like construct: a lexical
     temporary arena with a value result, not a source-level region object that
     can be stored or passed around.
   - Use scratchpads for temporary computations that benefit from cheap sharing
     inside the scope. Reset remains lexical; sharing outside the scope requires
     a proven scratch-free value or an explicit freeze/promotion.
   - Add a scratch bump-pointer path that cannot rewind persistent heap
     allocations. This can be a distinct scratch pointer or a partitioned arena,
     but the choice must be documented in the memory helpers.
   - Save the scratch pointer on entry and reset it on every exit edge:
     fallthrough, `return`, `break`, and `continue`.
   - Allocate temporary runtime aggregates/text/union payloads from the
     scratchpad inside the scope when they do not need to escape.
   - Enforce that `scratch { ... }` may return scalars, frozen/promoted values,
     or values proven not to reference scratch storage.
   - Reject scratch returns when escape analysis is uncertain.

6. Freeze and promotion

   - Parse and represent `freeze expr`.
   - Make `freeze` consume a unique value and produce an immutable
     `frozen_shareable` value.
   - If the source is scratch-backed and the frozen value escapes, emit an
     explicit promotion/copy into non-scratch heap storage before scratch reset.
   - If the source is already frozen/shareable, keep `freeze` idempotent.
   - Reject mutation through frozen values and borrowed views.
   - Do not implicitly freeze or promote just because analysis is uncertain.

7. Drop and cleanup elaboration

   - Compute drop/reset points at known lifetime ends before WAT emission.
   - Insert cleanup for temporaries introduced during lowering, using the same
     ownership/lifetime facts as source values.
   - Lower scratch cleanup to a required pointer reset on all structured exits.
   - Let unique heap drops lower to no-ops for the first bump-heap backend, but
     preserve the Core drop facts so a future reusable allocator/destructor path
     has a stable contract.
   - Verify that `return`, `break`, `continue`, and branch fallthrough cannot
     bypass cleanup.

8. Baseline backend policy

   - Do not silently promote, copy, or fall back to GC when analysis is
     uncertain.
   - Skip GC in the default backend by completing the static ownership,
     lifetime, escape, borrow, scratch, and cleanup analysis for the supported
     source surface.
   - Do not add a GC fallback to the default backend. A managed backend may be a
     future separate compile target only after baseline facts are stable.
   - Prefer deterministic static cleanup over runtime tracing for the baseline:
     insert temporary cleanup and scratch resets from ownership/lifetime facts,
     and reject programs whose facts cannot be proven.
   - Keep this whole task targetable with baseline structured Wasm, locals,
     globals, linear memory, and ordinary control flow.

9. Analysis completeness checklist

   - Track allocation-site facts for source values and lowering-created
     temporaries: storage class, source type, lifetime id, escape edge, and
     cleanup/drop behavior.
   - Treat the checklist as the baseline substitute for GC. A memory feature is
     accepted only when the proof inventory is complete enough that no runtime
     collector, hidden region, or WAT-emitter cleanup inference is needed.
   - Require these proof rows before WAT emission for every accepted non-scalar
     memory slice: storage/lifetime, borrow/view, scratch escape/reset,
     freeze/promotion, drop/cleanup, and host-boundary when the value crosses an
     import/export edge.
   - Include lowering-created temporaries in the same inventory as source
     values. Text copy loops, aggregate materialization, union payload
     construction, closure environment setup, and promotion copies are not
     allowed to rely on "temporary enough" reasoning unless they have explicit
     lifetime and cleanup facts.
   - If any proof row is missing, split the source shape by storage class and
     escape edge until it can be accepted with facts, rejected with a named
     diagnostic, or deferred to a separate future region/managed-storage
     profile.
   - Track owner state for `unique_heap` values. A unique value can be moved,
     consumed, borrowed, frozen, or dropped, but not implicitly copied.
   - Track active borrows so owner move, mutation, and `freeze` are rejected
     until the borrow lifetime ends.
   - Collect escape edges for returns, closure captures, heap/global stores,
     branch results, scratch returns, and unknown host/import calls.
   - Insert reset/drop actions at every scope edge that leaves the value's
     lifetime: fallthrough, `return`, `break`, `continue`, and discarded
     temporary expressions.
   - Make scratch-to-persistent promotion and `freeze` explicit Core operations.
     Do not hide implicit copying behind type checking or WAT emission.
   - Add accepted/rejected fixtures for each ownership edge. Accepted fixtures
     must expose the facts later WAT emission uses; rejected fixtures must
     assert a deterministic diagnostic and must not fall back to managed
     storage.

10. No-GC hard-case refinement loop

- Start broad features as an inventory of smaller value categories: scalar,
  frozen/static value, runtime text, runtime aggregate, runtime union payload,
  closure environment, scratch-backed temporary, and host boundary.
- For each category, first add either an accepted proof fixture or the nearest
  deterministic rejected diagnostic. Do not start by adding a collector-backed
  accepted path.
- Keep scratchpads lexical. A result does not carry a hidden live region; it
  must be scalar, frozen/shareable, explicitly promoted, or proven scratch-free
  before reset.
- Keep future explicit regions separate from scratchpads. A future region
  package must have a region owner, tied values, move/consume rules,
  cleanup/drop facts, ABI rules, and host-boundary rules before it accepts cases
  the baseline rejects.
- Treat compiler-created temporaries like source values. Aggregate
  materialization, text copy loops, union payload construction, closure
  environment setup, and promotion copies all need proof-visible cleanup or a
  rejected diagnostic.

### Likely Modules

- `src/frontend/parser_expr.ts`
- `src/frontend/parser_primary.ts`
- `src/frontend/parser_stmt.ts`
- `src/frontend/ast.ts`
- `src/frontend/linear_expr.ts`
- `src/frontend/linear_stmt.ts`
- `src/core/local_facts.ts`
- new `src/core/ownership.ts`
- new `src/core/lifetime.ts`
- new `src/core/lifetime_scope.ts`
- new `src/core/escape.ts`
- new `src/core/borrow.ts`
- new `src/core/cleanup.ts`
- new `src/core/scratch.ts`
- new `src/core/drop.ts`
- new `src/core/promotion.ts`

### Acceptance Tests

- `borrow x` can be passed to read-only consumers inside the same block.
- Returning a borrow from `scratch {}` or an inner block is rejected.
- Mutating, moving, or freezing an owned value while a borrow is active is
  rejected.
- `scratch { 1 + 2 }` returns a scalar and resets scratch storage.
- Scratch reset is emitted on normal fallthrough, `return`, `break`, and
  `continue` exits.
- Compiler-created temporaries get drop/reset points at their proven lifetime
  ends.
- Unique heap values that do not escape produce deterministic drop-plan entries,
  even if those entries lower to no-op code for the first bump allocator.
- Returning a scratch-backed aggregate without `freeze` or promotion is
  rejected.
- `freeze` allows a scratch-built aggregate to escape as immutable/shareable.
- Mutating a frozen value or a read-only borrow is rejected.
- Uncertain escape analysis fails with a diagnostic that says the value may
  reference scratch storage.
- Uncertain ownership, borrow, scratch, temporary-cleanup, or host-call escape
  analysis rejects before WAT emission instead of selecting a GC fallback.
- Unknown imports are treated as escaping unless their Core host signature
  declares a bounded-borrow contract.
- Static text/data remains frozen/shareable and does not allocate or require
  cleanup.
- Promotion from scratch to persistent heap is explicit in Core or rejected.

### Implementation Status

- Reserved frontend syntax now parses and formats `borrow expr`, `freeze expr`,
  and `scratch { ... }`. The source-to-Core bridge preserves them as explicit
  Core ownership nodes instead of unsupported placeholders.
- `scratch { ... }` now lowers through the source-to-Ic path when the scratch
  block result is inferred as an integer scalar or resolves to a statically
  visible/shareable text expression, including visible text bindings. Aggregate,
  unknown, dynamic text, and ownership-bearing heap results still reject on that
  Ic-only route until escape analysis can prove them pure-Ic lowerable.
- `borrow expr` and `freeze expr` now lower transparently when their operand is
  inferred as an integer scalar or resolves to statically visible/shareable
  text, including passing a borrowed scalar to a read-only function call.
  Aggregate, unknown, dynamic text, and ownership-bearing heap operands still
  reject until ownership/lifetime facts exist.
- Core type checking and emission also preserve `borrow`, `freeze`, and
  `scratch` nodes, lowering them transparently for scalar locals and
  already-shareable static text values where no ownership transition is needed.
- Core local collection, closure capture scanning, static-call substitution,
  static stability, type substitution, and text-layout scanning now traverse the
  ownership nodes structurally. Core scalar-only checks report ownership reasons
  for pointer-shaped values such as `Text`, runtime unions, and closures, while
  the accepted persistent freeze paths handle runtime aggregate, runtime union,
  and first-class closure owners explicitly.
- `src/core/ownership.ts` now defines the first explicit Core ownership fact
  surface: `scalar_local`, `unique_heap`, `frozen_shareable`, `borrow_view`, and
  `scratch_backed`. The public `Core.ownership(...)` helper classifies the final
  typed Core result, while direct analyzer tests cover scratch-backed values
  that are still ahead of current type/emission support.
- Core scalar-only `borrow`, `freeze`, and `scratch` diagnostics now report the
  ownership reason, for example frozen text, closure pointers, runtime-union
  pointers, or scratch-backed values. Bounded borrow escape checks, owner
  move/mutation/freeze protection while borrowed, control-flow drop coverage,
  and runtime text freeze promotion now have accepted proof slices. Promoted
  scratch `Text` can also be captured by a stored closure through a persistent
  frozen/shareable environment slot. Broader aggregate/union promotion and
  reusable cleanup emission are still pending.
- Core `scratch { ... }` now accepts results classified as `frozen_shareable` in
  addition to scalar locals. Static text literals inside `scratch` can return
  through Core type/emission because they are already frozen/shareable and do
  not reference scratch storage. Unfrozen unique heap scratch results still
  reject unless an implemented freeze/promotion path produces `frozen_shareable`
  storage.
- Core `freeze expr` now accepts scalar values and values that are already
  `frozen_shareable`, such as static text. Static-shaped aggregate values
  wrapped in `freeze` remain scalarized/static compiler facts, pass the no-GC
  proof gate as an allowed freeze edge, and reject indexed mutation with the
  frozen/shareable binding diagnostic. This keeps `freeze` idempotent for
  already-shareable values. Persistent runtime `Text` owners and scratch-backed
  runtime `Text` temporaries from direct or block-local `append(...)` can now be
  frozen/promoted with proof-visible allocation facts. Persistent runtime
  aggregate, runtime union, and first-class closure owners can now be frozen as
  immutable shareable storage. Direct, block-local, and branch-selected scratch
  first-class closure freeze now accept `scratch { freeze ((x: Int) => ...) }`,
  `scratch { let inner = (x: Int) => ...; freeze inner }`, and
  `scratch { if flag { freeze closure_a } else { freeze closure_b } }`, record
  frozen/shareable scratch returns and allowed closure freeze edges, and keep
  closure allocation on persistent heap storage. Scratch-backed aggregate,
  union, and broader closure promotion still reject until real copy/promotion
  exists for those shapes.
- Core `borrow expr` now accepts scalar values and values that are already
  `frozen_shareable`, such as static text. Borrowing those values is treated as
  a no-op for ownership because there is no mutable owner lifetime to protect.
  Borrowing unique heap values is now context-aware: bounded read-only uses such
  as `len(borrow message)` inside an annotated closure body are allowed when the
  borrow is confined to the immediate function-call scope, while returning or
  otherwise escaping the borrow still rejects.
- `src/core/borrow.ts` and `Core.borrows(...)` now expose the first borrow-edge
  analysis surface. It records deterministic borrow ids, source/target lifetime
  scope ids, operand ownership, and the current lifetime decision for each
  `borrow expr`. Static Core calls are scanned through their substituted call
  body, so direct calls of unannotated scalar closures can produce borrow edges
  in the function-call lifetime scope instead of being skipped. Annotated
  closure values can also be scanned with closure-local parameter facts.
  Unannotated closure values that escape or are otherwise not analyzed through a
  static call are reported explicitly as skipped analysis until closure-local
  inference is available. `Core.validate_borrows` returns a deterministic
  validation result for rejected borrow edges and skipped closure-body analysis,
  and `Core.check_borrows` throws the first validation issue for callers that
  need a hard gate. Core type checking, expression emission, and module
  generation now run the borrow gate first, so rejected borrow edges and untyped
  closure-body borrow skips fail before WAT emission. Borrow expression typing
  and emission defer lifetime rejection to that gate, which lets bounded
  unique-heap borrows lower as ordinary pointer reads after validation. Stored
  borrow-view locals such as `let view = borrow owner` are now accepted when the
  view is syntactically bounded to the current block. The borrow plan records
  the view-to-owner relation, rejects owner move/replacement, index mutation,
  and `freeze` while the view is live, and rejects returning, storing, or
  closure-capturing the view with a borrow-escape diagnostic. Branches and loops
  that assign a borrow view into an outer name now merge that view fact back to
  the parent scope, so later owner mutation or view escape cannot ignore a
  branch/loop-created borrow. Borrow-aware host/import signatures remain
  pending. The borrow plan also records borrowed-owner barrier issues for named
  owners and simple local aliases, rejecting move/replacement, index mutation,
  and `freeze` while a bounded borrow is still active in the current lexical
  scope.
- The frontend has a small static-shareable-text ownership helper backed by the
  existing visible-text resolver. The pure Ic path now accepts `borrow "text"`,
  `freeze "text"`, `scratch { "text" }`, visible text bindings, and simple
  visible text concatenations through these ownership forms, while still
  rejecting dynamic text and aggregate cases when the wrapped value would
  escape. Immediate scalar text reads are now accepted for annotated runtime
  `Text`: `len(borrow message)`, `get(freeze message, index)`, and
  `(scratch { message })[index]` recursively erase wrappers and lower to the
  usual Ic load/bounds-check shape. Pure-Ic diagnostics for non-scalar
  ownership-wrapper results now point callers to `Source.core`, `Source.mod`, or
  `Source.wat` for structured Core/Wasm lowering.
- Core ownership analysis now looks through simple block result expressions, so
  scratch blocks and other single-result blocks keep ownership facts from their
  final expression instead of falling back to plain scalar pointer typing.
- `src/core/lifetime.ts` now owns the first explicit lifetime/escape policy
  decisions for `borrow`, `freeze`, and `scratch` results. Core type checking
  and emission use those decisions instead of raw ownership booleans, so
  reserved unique-heap cases now report whether the missing work is lexical
  borrow tracking, immutable heap copy/promotion, or scratch escape handling.
- `src/core/escape.ts` and `Core.escape(...)` now expose the first allocation
  and escape-analysis surface for final Core results. The analysis records the
  ownership fact, selected storage class (`scalar_local`, `static_data`,
  `persistent_unique_heap`, `frozen_heap`, `scratch_arena`, `borrow_view`, or
  `rejected`), whether the value escapes its current scope, and the decision
  reason. It also reuses the same policy for `borrow`, `freeze`, and
  `scratch_return` edges in tests, so later allocation/reset code has a stable
  fact shape to consume. Whole-program escape-edge collection beyond final
  results and promotion codegen are still pending.
- `src/core/cleanup.ts` and `Core.cleanup(...)` now expose the first cleanup
  planning surface. It scans Core syntax for `scratch { ... }` scopes, assigns
  deterministic scratch scope names, records the scratch return-value escape
  analysis, and reports reset edges for fallthrough, `return`, `break`, and
  `continue`. Loop bodies are treated as break/continue boundaries so a `break`
  inside a nested loop does not get mistaken for a scratch-scope exit. Core WAT
  emission now saves `__scratch_heap` on `scratch {}` entry, stores the body
  result in a temporary, resets the scratch pointer, and reloads the result on
  normal fallthrough. It also emits scratch resets before `return`, `break`, and
  `continue` when those control transfers leave the active scratch scope; nested
  loop `break`/`continue` that remain inside an outer scratchpad do not reset
  that outer scope. `Core.mod` emits the `__scratch_heap` global and memory when
  a scratch expression is used, including scratch inside lifted closure bodies.
  Conditional branches and structured loops now contribute proof-visible
  cleanup/drop rows for the accepted owner paths, including branch replacement,
  `if let`, zero/one-iteration loop cases, and `break`/`continue` exits.
  Allocation-linked rows now lower to `__free` calls through the reusable
  free-list allocator at their statement and control-flow anchors.
- `src/core/lifetime_scope.ts` and `Core.lifetimes(...)` now expose the first
  lexical lifetime-scope scan. It records deterministic program, block,
  loop-iteration, function-call, closure-environment, and scratchpad scopes with
  parent links. Scratch scopes reuse the cleanup exit-edge analysis so lifetime,
  escape, and cleanup planning agree on the same scratch boundary ids. Borrow
  escape enforcement and lifetime-aware move/freeze mutation checks are still
  pending.
- `src/core/drop.ts` and `Core.drops(...)` now expose the first unique-heap drop
  planning surface. It records deterministic `heap_drop` steps for unique owners
  that are overwritten, discarded as non-final expressions, or left behind at
  scope exit. It also records `return_exit`, `break_exit`, and `continue_exit`
  edges for control transfers that leave active unique owners behind. Final
  direct unique values and final named owners are treated as escaping results.
  Terminal expression branches, such as both sides of an expression-level `if`
  returning, do not also report a false fallthrough drop. The current runtime is
  explicitly `reusable_free_list_allocator`; allocation-linked drops emit
  `__free` calls at their statement and control-flow anchors. Branches that
  assign existing unique owners merge the resulting owner back into the outer
  scope, while branch-local unique owners still drop at the branch boundary.
  Closure bodies are now scanned under deterministic `closure#N` scopes, so
  closure-local unique owners produce drop facts on closure fallthrough or
  closure-local `return` exits. Direct named-owner discards and direct
  named-owner moves through static aliases are now handled without forcing
  static owner values through runtime expression typing. Compile-time-only
  `const` values, including type values and const type-constructor results, stay
  in the static drop-analysis context and do not create runtime owners or
  require runtime expression typing. Freeze of a named, block-result, or
  branch-result unique owner is now modeled as an ownership-consuming edge in
  the drop plan, including discarded `freeze f`, `let frozen = freeze f`,
  `let frozen = { freeze f }`, branch-local `if { freeze f } else { freeze g }`,
  `return freeze f`, and self-shadowing `f := freeze f`; full immutable
  heap-copy/promotion codegen for unique values remains pending. Statement-level
  no-else `if` and typed `if let` bodies that contain `freeze f` now avoid
  forcing static owner values through runtime typing and produce conservative
  outer drop facts for paths where the optional branch does not run. Conditional
  cleanup now emits on the retained branch, including dynamic no-else `if` and
  typed `if let` fallthrough paths.
- `src/core/proof.ts`, `Core.proof(...)`, and `Core.check_proof(...)` now expose
  the first explicit baseline no-GC proof harness for the `core-3-nonweb`
  target. The proof aggregates final-result escape analysis, borrow validation,
  explicit `freeze` edges, scratch cleanup/reset facts, unique-owner drop facts,
  and lexical lifetime scopes, with `managed_storage: "disabled"`. Accepted
  scalar/scratch fixtures expose the facts WAT emission would use, while
  rejected unique-heap `freeze` and scratch-return fixtures report deterministic
  proof issues instead of selecting a GC fallback. The proof gate belongs before
  WAT/module emission; `Core.type(...)` remains a type-query surface rather than
  the final no-GC proof boundary.
- The baseline proof now exposes canonical row families for storage, lifetimes,
  borrow views, scratch results, freeze/promotion, cleanup/drop, host
  boundaries, capability methods, runtime slices, and allocation metadata.
  Accepted emitters consume the same facts rather than reconstructing a second
  ownership model after the gate.
- Persistent allocation rows now carry reusable-layout prerequisites such as
  allocation id, byte-size formula, alignment, and layout id for runtime text,
  aggregates, unions, closures, and runtime `i32` slices. The baseline runtime
  now consumes that contract through a shared header-backed first-fit
  `__alloc(size, alignment)` free list and a real `__free(ptr)`. Persistent
  allocation families share reusable blocks, while scratch allocation remains a
  distinct region discipline. Linked cleanup rows call `__free` on proven owner
  exits and replacements; escaped and frozen results remain live.
- Drop/proof analysis now recognizes static-shaped aggregate values,
  static-shaped aggregate updates, and extension objects as ownerless compiler
  facts rather than runtime heap owners. This lets `Core.proof(...)` accept the
  existing scalarized aggregate path, including static aggregate iteration,
  dynamic static-aggregate indexing, visible text fields, and `freeze` over
  static-shaped aggregates, without inventing drops or heap-promotion failures
  for values that are not represented as heap allocations.
- Drop/proof analysis now also treats static-call-only unannotated `lam` and
  `rec` values as ownerless compiler call targets instead of forcing them
  through first-class runtime closure typing. Ordinary annotated `let` closures
  still produce unique-heap drop facts when materialized as runtime closure
  values. The static type-value probe used by drop analysis is non-fatal for
  ordinary static function calls, so specialized calls such as annotated `I64`
  closures do not get mistaken for type-constructor applications.
- Drop/proof analysis now pre-collects annotated closure-body local facts before
  scanning closure bodies for drops. This covers closure-local accumulators and
  collection-loop item/index locals in first-class closure branches. It also
  treats static shorthand union cases and ownerless static union `if` values as
  compiler facts, and scans `if let` payload branches with the same static,
  dynamic, or runtime union payload contexts used by Core typing/emission. The
  proof audit over inline Core test snippets now passes for every typed snippet;
  deliberately unsupported unknown collection-loop bodies are skipped by drop
  analysis because the emitter still rejects them before WAT. `Core.emit(...)`
  and `Core.mod(...)` now run `Core.check_proof(...)` before producing WAT or
  module artifacts, so borrow, freeze, scratch-return, and final-result proof
  failures cannot pass through to baseline codegen.

### Remaining Task 12.2 Work Breakdown

Break the remaining work into these implementation slices:

1. Stored borrow-view locals

   - Implemented the MVP accepted form: `let view = borrow owner` is valid when
     the stored view is used only inside the current lexical block, including
     read-only calls such as `len(view)`.
   - The borrow plan records `view -> owner`, rejects mutation, move, or
     `freeze` of `owner` while `view` is live, and rejects returning, storing,
     or closure-capturing `view`.
   - Diagnostics now distinguish stored-view escapes from borrowed-owner
     mutation barriers.
   - Branch and loop bodies that assign a stored borrow view into an outer name
     now carry that view fact back to the parent scope. Later owner mutation or
     view escape is rejected after the merge.
   - Remaining follow-up: carry the same stored-view facts through future
     aggregate field owners.

2. Branch and loop borrow barriers

   - Extend borrowed-owner barriers beyond the current named/simple-alias owner
     surface. The current borrow plan rejects move/replacement, index mutation,
     and `freeze` for a named unique owner or simple local alias while a bounded
     borrow is active in the same lexical scope.
   - Implemented stored-view branch/loop merge for assignments into outer names:
     a view assigned in one branch or loop body is treated as possibly live in
     the parent scope.
   - Plain non-stored borrows inside loop bodies still end at the loop
     iteration/body boundary, so owner mutation after the loop is allowed when
     no borrow view escapes the body.
   - Implemented first path-sensitive loop-control precision: borrow/view,
     closure-capture, and field-owner alias scans stop after definite sequence
     exits (`return`, `break`, `continue`, and `if/else` bodies where both arms
     exit). A borrow assigned before `break` is still treated as possibly live
     after the loop; a borrow or field alias syntactically after an
     unconditional loop-control edge no longer poisons the parent scope.
   - Remaining follow-up: carry path-specific borrow-view facts through future
     richer loop/region state beyond the current definite sequence-exit model.

3. Field and aggregate owner barriers

   - Implemented the first field-owner slice for current Core aggregate facts:
     direct `borrow user.name` and `borrow user[index]` canonicalize the
     protected owner back to `user` when the field/index expression aliases
     aggregate-owned storage.
   - Implemented simple field alias propagation. Bindings such as
     `let name = user.name`, `let other = name`, and `borrow other` keep both
     the containing owner and the field value ownership, so replacing `user` or
     mutating through `name[index]` rejects while the borrow is active.
   - Implemented field-owner alias joins for branch, `if let`, and loop
     assignments into outer locals. If `name` may be `user.name` after an `if`,
     `if/else`, `if let`, or loop body, a later `borrow name` protects every
     possible containing owner represented by that join.
   - Implemented field-owner extraction through expression-valued `if` and
     `if let` results. Bindings such as
     `let name = if flag { user.name } else { other.name }` protect both
     possible containing owners when `name` is later borrowed.
   - Implemented stored borrow-view extraction through expression-valued `if`
     and `if let` results. Bindings such as
     `let view = if flag { borrow user.name } else { "fallback" }` protect the
     possible borrowed owner after the binding.
   - Implemented multi-statement block result extraction for field aliases and
     stored borrow views. A block such as `{ let inner = user.name; inner }` or
     `{ let inner = borrow user.name; inner }` carries the returned ownership
     fact to the outer binding without leaking unrelated block-local borrows.
     Field aliases assigned through block-prefix `if`, `if else`, `if let`, and
     loop statements are also joined into the returned block result, so a later
     borrow of that result protects every possible containing owner.
   - Implemented mutation barriers through the containing owner for field
     aliases that are currently emitted as memory-backed `Text` values.
   - Remaining follow-up: extend the same owner facts to full runtime aggregate
     memory representation, nested field/index alias chains through runtime
     aggregate pointers, future richer field-assignment syntax, and general
     fact-directed memory mutation.

4. Host/import borrow contracts

   - Treat unknown imports and host calls as escaping by default.
   - Implemented the first proof-visible host/import boundary slice:
     `src/core/host_boundary.ts`, `Core.host_boundaries(...)`, and
     `Core.proof(...).host_boundaries` now scan unknown Core app targets before
     WAT emission. Scalar arguments are reported as ownership-neutral but still
     require an explicit host/import signature; `unique_heap`, `borrow_view`,
     and `scratch_backed` arguments reject with a deterministic diagnostic that
     names the missing bounded-borrow or ownership-transfer contract.
   - Implemented explicit Core host import signatures on `Core.host_imports`.
     They can describe scalar, bounded-borrow, frozen/shareable, and
     ownership-transfer argument contracts. Known imports lower through
     `Core.mod(...)` as WAT imports and direct calls.
   - Bounded-borrow contracts accept explicit `borrow owner` views for imports
     that only read the view during the call. Direct unique-owner arguments
     still reject unless a future ownership-transfer contract consumes them.
   - Reject passing `borrow_view` to any import without a matching
     bounded-borrow contract.
   - Ownership-transfer contracts now consume direct `unique_heap` owners and
     record `host_transfer` facts in `Core.drops(...)`. Otherwise non-scalar
     unique values crossing the boundary remain rejected.
   - Include host/import escape facts in `Core.proof(...)`, so WAT emission can
     distinguish bounded read-only calls, ownership-transfer calls,
     host-returned owner results, scratch-backed argument policy, and rejected
     unknown calls.
   - Source-level host import declarations are implemented for scalar numeric
     ABI values, Text ownership contracts, explicit non-Text pointer owner
     reasons, and user-defined aggregate/union type-value owner references. The
     syntax is `host_import name from "module.field" (...) => ...`, with
     argument contracts such as `bounded_borrow Text`,
     `frozen_shareable runtime_aggregate`, and `ownership_transfer result_type`,
     plus result contracts such as `unique_heap Text`, `unique_heap user_type`,
     and `frozen_shareable runtime_union`.
   - Direct, block-bodied, multi-statement block-bodied, branch-selected
     annotated closure top-level ownership-transfer wrappers, and branch-local
     wrapper definitions are implemented, including temporary unique expression
     arguments that transfer without a source owner name. Higher-order const
     function wrapper calls are implemented for direct calls and local
     static-function aliases inside the wrapper body. Branch-selected
     higher-order const-function wrappers now also preserve local
     static-function aliases and temporary transfer arguments in each possible
     branch. Ordinary branch-selected closures without `const` parameters stay
     runtime/first-class values so aggregate materialization, closure tables,
     and runtime closure tests keep their existing representation. Deeper
     interprocedural transfer analysis remains pending for dynamic higher-order
     wrappers, self-recursive transfer shapes, and broader non-variable-argument
     wrapper shapes.
   - Direct use-after-transfer diagnostics are implemented in the Core transfer
     validator: after a host/import transfer consumes a named owner, later
     direct use of that owner rejects before WAT emission unless the name is
     rebound.

5. Scratchpad allocation and escape enforcement

   - Implemented scratch reset emission on all exits that leave the scratch
     lifetime: fallthrough, `return`, `break`, and `continue`.
   - Implemented allocation-routing slices for temporary runtime aggregate
     materialization, runtime text concatenation, and runtime union value
     materialization: aggregate values, runtime text concat results, and runtime
     union values emitted inside an active `scratch { ... }` body use
     `__scratch_heap` when the surrounding result is scalar or otherwise
     scratch-free.
   - Implemented the first proof-visible allocation fact surface:
     `Core.allocations(...)` and `Core.proof(...).allocations` record persistent
     unique-heap allocation facts and scratch-backed allocation facts for
     accepted runtime allocation sites. Current covered reasons include runtime
     aggregates, runtime unions, runtime text allocations, and first-class
     closure storage.
   - Allocation proof scanning now enters analyzable annotated closure bodies,
     so scratch-backed runtime text temporaries introduced inside first-class
     closure bodies are reported by the no-GC proof instead of being visible
     only in emitted WAT.
   - Mixed persistent heap and scratch heap allocation now use separate globals;
     scratch starts in its own arena when persistent heap allocation is also
     needed, so scratch reset cannot rewind persistent allocations.
   - Remaining follow-up: make allocation facts field-sensitive for returned
     heap-backed aggregate/union payload values, extend cleanup proof output for
     richer lowering-created scratch temporaries, and keep allocation facts
     aligned with future promotion/destructor paths.
   - Reject a scratch result unless it is scalar, frozen/shareable, explicitly
     promoted, or proven scratch-free.
   - Implemented the first returned-field proof for scalarized static-shaped
     aggregate results: `scratch { { field: scalar_or_static } }` can bind a
     static aggregate outside the scratchpad when every field is scalar,
     static/frozen data, or otherwise scratch-free. The proof records an allowed
     scratch-return edge and WAT emission keeps the field reads scalarized.
     Annotated static-shaped struct results now use the same proof, so
     `let user: user_type = scratch { user_type { age: x, name: "Ada" } }` can
     bind outside the scratchpad when the annotated fields are scratch-free. The
     same annotated aggregate shape rejects if a field is scratch-built runtime
     data without explicit freeze/promotion.
   - Static union cases now use the same scratch-free proof for payloads:
     `scratch { result_type.ok(value) }` can leave the scratchpad when the
     payload is scalar, static/frozen data, or otherwise scratch-free. Dynamic
     static-union `if` results are allowed only when the condition and both
     branch payloads are scratch-free.
   - Implemented expression-valued `if let` scratch-promotion coverage for
     runtime or dynamic static-union text payloads. A scratch result such as
     `scratch { if let .ok(value) = result { freeze append(value, "!") } else { freeze append("fallback", "?") } }`
     records scratch text allocation plus persistent promotion before reset. The
     same shape without `freeze` or explicit promotion rejects if the returned
     value may point into scratch storage.
   - A scratch result that is an aggregate must prove every returned field is
     scratch-free, frozen, scalar, or promoted. Otherwise the whole result
     rejects before WAT emission.
   - Keep scratch results detached from the scratchpad lifetime in the MVP. A
     future attached-region result must be an explicit region-owner package, not
     an implicit lifetime extension for ordinary `scratch { ... }`.
   - Do not add a managed fallback for hard scratch-return cases. The supported
     paths are proof, explicit promotion/freeze, or deterministic rejection.

6. Freeze and scratch-to-persistent promotion

   - Implement `freeze` for supported heap-backed values by consuming
     `unique_heap` ownership and producing `frozen_shareable` storage.
   - If the source is `scratch_backed` and the frozen/promoted value escapes,
     emit the copy into persistent non-scratch storage before scratch reset.
   - Keep `freeze` idempotent for already-frozen values and reject mutation
     through frozen storage.
   - Implemented analysis-only drop-plan consumption for direct named and
     block/branch-result unique owners consumed by `freeze`, so the original
     owner is not dropped later as if it were still live.
   - Implemented conditional cleanup for optional statement branches where
     `freeze` may not run, including dynamic no-else `if` and typed `if let`
     fallthrough paths. Linked retained-path owners lower to `__free` through
     the reusable free-list allocator.
   - Implemented the first persistent heap-backed freeze slice for runtime
     `Text`: `freeze` over `unique_heap text` consumes the owned buffer as
     immutable shareable storage, tracks frozen runtime locals through Core
     typing/emission/proof contexts, rejects later indexed mutation through the
     frozen binding.
   - Implemented the first persistent heap-backed freeze slice for runtime
     aggregates: `freeze` over `unique_heap runtime_aggregate` consumes the
     owned pointer as immutable shareable storage, keeps struct and text field
     facts visible in proof/emission contexts, records an allowed freeze edge,
     rejects later mutation through the frozen aggregate binding, and
     round-trips through WAT-to-Wasm field loads.
   - Implemented the first persistent heap-backed freeze slice for runtime
     unions: `freeze` over `unique_heap runtime_union` consumes the owned
     pointer as immutable shareable storage, keeps union facts visible through
     annotation, proof, and `if let` contexts, records an allowed freeze edge,
     and round-trips through WAT-to-Wasm matching.
   - Implemented the first persistent heap-backed freeze slice for first-class
     closures: `freeze` over `unique_heap closure` consumes the owned
     environment pointer as immutable shareable storage, keeps closure call
     facts visible through proof/emission contexts, records an allowed freeze
     edge, and round-trips through WAT-to-Wasm `call_indirect`.
   - Implemented the first direct, block-local, and branch-selected scratch
     closure freeze slice: `scratch { freeze ((x: Int) => ...) }`,
     `scratch { let inner = (x: Int) => ...; freeze inner }`, and
     `scratch { if flag { freeze closure_a } else { freeze closure_b } }` return
     frozen/shareable closure values, record allowed `unique_heap closure`
     freeze edges, keep allocation facts on persistent closure heap storage, and
     round-trip through WAT-to-Wasm `call_indirect`.
   - Implemented the first scratch-to-persistent promotion slices for runtime
     `Text`: direct `scratch { freeze append(...) }`, block-local
     `scratch { let temp = append(...); freeze temp }`, inlineable helper
     returned `Text` temporaries, expression-valued `if` branches whose arms
     each freeze runtime `Text`, and expression-valued `if let` branches whose
     selected result freezes runtime `Text` emit a persistent copy before
     scratch reset, record the scratch temporary and persistent promotion
     allocation facts, and leave managed storage disabled.
   - Implemented the statement-level dynamic `if let` scratch-text assignment
     slice: a scratch-local `Text` can be overwritten inside matching `if let`
     payload branches and frozen after the statements. Drop scanning now updates
     local facts while walking closure/block statement lists, so the matched
     payload keeps its `Text` fact in assignment ownership analysis. `if let`
     emission now advances generated temp counters across emitted branches,
     keeping local declarations and WAT temp names aligned through the later
     freeze-copy.
   - Implemented the first direct aggregate/union scratch-freeze slice:
     `scratch { freeze user_type { ... } }` and
     `scratch { freeze result_type.ok(...) }` materialize the direct constructor
     on persistent heap storage while the scratch reset is active, record
     allowed aggregate/union freeze edges, keep aggregate/union facts visible
     after the reset, and round-trip through WAT-to-Wasm.

- Implemented the first alias-based aggregate promotion:
  `scratch { let temp = user_type { ... }; freeze temp }` now copies the
  known-layout aggregate into persistent frozen storage before reset. The proof
  records the scratch field temporaries, persistent aggregate destination,
  persistent `Text` field copies, and allowed `unique_heap runtime_aggregate`
  freeze edge. WAT-to-Wasm coverage reads the promoted aggregate after scratch
  reset.
- Branch-shaped scratch aggregate promotion now reaches WAT-to-Wasm through
  static function calls with unannotated scalar branch parameters. A shape such
  as
  `scratch { let temp: user_type = if flag { user_type { ... } } else
    { user_type { ... } }; freeze temp }`
  emits the branch-selected persistent aggregate/text copies before scratch
  reset, and text-layout scanning binds unannotated closure parameters as `i32`
  placeholders so static function body scanning can collect text literals
  without treating the branch parameter as an unbound local.
- Branch-assigned scratch aggregate and union promotion now have WAT-to-Wasm
  coverage. Shapes such as
  `scratch { let temp: user_type = ...; if flag {
    temp = user_type { ... } } else { temp = user_type { ... } }; freeze temp }`
  and the equivalent `result_type.ok/err(...)` union assignment copy the
  selected aggregate fields or union payload into persistent frozen storage
  before scratch reset.
- Implemented the first alias-based runtime union promotion:
  `scratch { let temp = result_type.ok(...); freeze temp }` now copies
  scalar/`Text`/`Unit`, union-pointer, and supported aggregate-pointer payload
  aliases into persistent frozen storage before reset. The proof records the
  scratch source union, persistent union destination, persistent nested union or
  aggregate payload destination, persistent `Text` payload/field copies, and
  allowed `unique_heap runtime_union` freeze edge. WAT-to-Wasm coverage matches
  the promoted union and reads its text, nested union, or aggregate payload
  after scratch reset.
- Implemented static-shaped existing aggregate alias planning, so previously
  bound aggregate facts can be frozen through a scratch-local alias without
  failing static-value planning on the alias variable.
- Remaining follow-up: emit immutable heap copy/promotion for broader existing
  aggregate/union owners across dynamic loop-carried shapes and broader union
  branch payload shapes; add broader scratch-backed closure shapes beyond
  direct, block-local, and branch-selected persistent closure freeze; broaden
  scratch-backed text shapes; track the resulting frozen storage facts through
  Core typing/emission; then add conditional cleanup/destructor emission for
  optional consumption paths. Deep closure-capture ownership checks for linear
  or ownership-bearing capture slots remain part of the first-class linear
  closure task.
- Keep promotion as a visible Core fact with source owner, destination storage
  class, lifetime id, and cleanup/drop decision. Do not let a later pass infer
  promotion only because an escape would otherwise fail.
- Preserve static-shaped frozen values as ownerless compiler facts when they can
  stay scalarized/static, while reserving heap-copy codegen for real
  `unique_heap` or `scratch_backed` runtime storage.
- Implemented for static-shaped aggregate values: the proof scanner records
  their `freeze` edges as `frozen_shareable` and `Core.emit(...)` keeps field
  reads scalarized. Persistent runtime heap-backed aggregate freeze is
  implemented. Persistent runtime heap-backed union freeze is implemented;
  persistent runtime heap-backed closure freeze is implemented. Direct,
  block-local, and branch-selected scratch closure freeze are implemented.
  Direct aggregate/union constructor scratch freeze is implemented by
  materializing those constructors on persistent heap storage before scratch
  reset. Block-local scratch runtime aggregate alias promotion is implemented
  for supported known-layout fields. Block-local scratch runtime union alias
  promotion is implemented for scalar/`Text`/`Unit`, union-pointer, and
  supported aggregate-pointer payloads. Static-shaped existing aggregate aliases
  can now be planned through scratch freeze, while branch-selected and
  branch-assigned existing runtime union aliases preserve payload facts through
  scratch freeze. Broader existing owner copies and broader closure promotion
  remain pending.

7. Cleanup for compiler-created temporaries

   - Extend Core drop-plan analysis to all lowering-created unique temporaries.
     The current surface covers straight-line owner replacement, discarded
     unique expressions, final-result escape, scope-exit drops, terminal
     expression branches, branch assignment owner merges, closure-body owners,
     direct named-owner discards, direct named-owner moves, and explicit
     `return`/`break`/`continue` exit drops.
   - Direct block-expression result moves now preserve owner facts across the
     block boundary, including final `{ f }`, discarded `{ f }`,
     `let g = { f }`, and block-local owner result expressions.
   - Path-sensitive expression-branch owner results are implemented for
     expression-level `if` and `if let`: each branch scans with its own owner
     map, drops non-selected owners in branch scopes, and lets the surrounding
     expression context move, escape, or discard the selected result.
   - Insert drop/reset actions at the same proven lifetime ends used for source
     values. Scratch-backed temporaries reset with their scratch scope; unique
     heap temporaries link drops to reusable free-list allocation metadata and
     emit `__free` at their cleanup anchors.
   - Cleanup/reset emission now covers accepted branch merges and linked
     lowering-created temporaries through the reusable allocator.
   - Remaining follow-up: extend the same owner/drop facts to future richer
     lowering-created temporaries and reusable allocator/destructor emission.
   - Prioritize temporaries introduced by runtime aggregate materialization,
     text concatenation/copy loops, union payload construction, closure
     environment setup, and future broader scratch-to-persistent promotion.

8. Baseline no-GC proof harness

   - Implemented the explicit `Core.proof(...)` and `Core.check_proof(...)`
     surface for `core-3-nonweb`, with managed storage disabled.
   - The proof reports final-result escape facts, borrow validation, explicit
     `freeze` edges, scratch cleanup/reset facts, drop facts, and lifetime
     scopes in one result.
   - Static-shaped aggregates and aggregate updates are recognized as ownerless
     compiler facts in the drop/proof path, matching the current scalarized
     Core/Wasm representation.
   - `freeze` over static-shaped aggregate values is covered by the proof gate
     as an allowed frozen/shareable edge rather than a missing unique-heap
     promotion.
   - Rejected proof issues now cover borrow failures, missing unsupported
     unique-heap freeze/promotion, rejected scratch returns, rejected
     final-result escapes, and unsupported Core codegen nodes that must fail
     before WAT emission.

- Implemented the first unsupported-codegen proof slice for unknown
  `collection_loop` statements. They now appear in `Core.proof(...)` as
  `unsupported_codegen` issues and `Core.check_proof(...)` rejects before
  `Core.emit(...)` reaches the structured-codegen fallback.
- Implemented the follow-up unsupported-codegen proof slice for preserved
  unknown field and index expressions. `Source.core(...)` can still preserve
  those expressions for structured diagnostics, but `Core.proof(...)` now
  records deterministic `unsupported_codegen` issues and `Core.check_proof(...)`
  rejects before final-result typing or WAT emission tries to inspect missing
  field/index facts.
- Implemented the unsupported-codegen proof slice for preserved unsupported
  `if let` expression and statement targets. Static union, dynamic static-union,
  and runtime-union matches remain accepted; unknown targets now produce
  deterministic `unsupported_codegen` issues before Core typing, local lookup,
  or WAT emission.
- Implemented the final-expression unsupported app proof slice. A final Core app
  expression whose call shape is not one of the supported builtins, static
  calls, closure calls, rec calls, runtime text calls, runtime-union
  materialization paths, or declared host imports now produces
  `Cannot emit core app expression yet` from `Core.proof(...)` and
  `Core.check_proof(...)` instead of throwing from Core type inference first.
- Implemented the builtin app proof refinement for unknown `len(...)` and
  `get(...)` collection targets. Final and non-final calls such as `len(x)` or
  `get(x, 0)` where `x` has no collection/text facts now reject through
  `Core.proof(...)` and `Core.check_proof(...)` with builtin-specific proof
  diagnostics for unknown `len` and `get` collection targets. `Core.type(...)`
  keeps the matching type-query diagnostics.
- Implemented the final-expression type-value proof slice. Direct or named
  type-level Core values preserved by `Source.core(...)` now produce
  `Cannot emit core type value expression yet` from `Core.proof(...)` and
  `Core.check_proof(...)` instead of throwing from Core type inference first.
- Implemented the runtime-position type-value proof slice. Type-level Core
  expressions used as runtime expression statements or runtime `let` values now
  reject through `Core.proof(...)` before local collection, type inference, or
  WAT emission; `const` type-value bindings remain valid static compiler facts.
- Implemented the unsupported `index_assign` target proof slice. Assignments
  such as `xs[0] = value` now reject through `Core.proof(...)` when `xs` is not
  a static aggregate binding, runtime text local, or runtime aggregate local,
  instead of reaching the generic Core statement emitter fallback.
- Implemented the direct unsupported runtime expression proof slice. Direct
  runtime-position `linear`, `rec`, `comptime`, `with`, and `struct_update`
  expressions now reject through `Core.proof(...)` before type inference or WAT
  emission, while static projection paths such as `(user { age: 41 }).age`
  remain accepted as compiler facts.
- Implemented the early-analysis unsupported proof slice. Context collection and
  borrow/drop probing now map preserved unsupported shapes such as unbound
  `index_assign`, non-final unknown `field`/`index` expressions, and preserved
  `comptime` `let`/assignment values into `Core.proof(...)`
  `unsupported_codegen` issues instead of throwing before the proof object
  exists.
- Implemented the final-statement and bare-lambda unsupported proof slice. Final
  unsupported statements such as unknown `collection_loop` or `if_let_stmt`
  shapes now scan into `Core.proof(...)` before final-result extraction, and
  bare runtime `lam` expressions now reject as
  `Cannot emit core lam expression yet` instead of surfacing a Core type-probing
  failure.
- Implemented the runtime binding and outside-loop control unsupported proof
  slice. Runtime `let`/assignment values containing preserved `with`,
  `unsupported`, or non-static `struct_update` expressions now reject through
  `Core.proof(...)` instead of recursing or throwing from local collection, and
  top-level `break`/`continue` now reject before the statement emitter.
- Implemented the closure captured-assignment unsupported proof slice. A stored
  closure that assigns to a captured value in a shape outside the supported
  same-type scalar, runtime `Text` byte, runtime aggregate scalar/`Text`, or
  static aggregate rebuild cases now produces an `unsupported_codegen` proof
  issue before closure lifting or module emission.
- Fixed same-type static struct-update assignment. A source update such as
  `user = user { age: 41 }` now stores the rebuilt static struct fact instead of
  a self-referential update expression in drop/proof analysis, so proofing and
  emission no longer recurse indefinitely.
- `Core.emit(...)` and `Core.mod(...)` now run `Core.check_proof(...)` before
  WAT/module artifact emission. `Core.type(...)` remains a type-query surface
  and is not the WAT emission gate.
- Unsupported-codegen proof scanning now lives in
  `src/core/proof/unsupported.ts`, and freeze-proof traversal now lives in
  `src/core/proof/freeze.ts`. `src/core/proof.ts` remains the baseline proof
  assembly/checking surface and re-exports the scanner entrypoints for existing
  callers.
  - Remaining follow-up: keep broadening the proof facts as new Core features
    become accepted by WAT emission, especially runtime aggregate memory and
    host/import escape facts.
  - Add a proof audit fixture for every newly accepted memory feature. The
    fixture should prove `managed_storage` remains disabled and should expose
    the feature's storage class, lifetime id, escape decision, and cleanup/drop
    behavior.
  - Treat missing proof coverage as unfinished implementation, not as a reason
    to enable GC. If the feature cannot expose the required facts yet, keep it
    rejected with a deterministic diagnostic.

9. Optional attached regions after scratchpads

   - Treat optional region work as a follow-up to `scratch {}`. A future named
     arena may return values tied to a lifetime id only by returning an explicit
     live region owner and values that reference it.
   - Represent that attached-region escape in Core with ownership, lifetime,
     escape, and cleanup facts. Do not infer it from ordinary `scratch { ... }`.
   - Keep the MVP scratchpad semantics simple: `scratch {}` resets before the
     returned value can observe dangling scratch storage.

10. GC deferral and future managed backend profile

- Keep GC out of the baseline linear-memory path. The current task is to make
  the ownership/lifetime analysis complete enough for supported programs, not to
  compensate for missing facts with tracing.
- If ownership, borrow validity, scratch escape, freeze/promotion, temporary
  cleanup, or host/import escape behavior cannot be proven for a source program,
  the result is a deterministic compiler error before WAT emission.
- Keep managed GC or Wasm-GC as a separate future backend profile with different
  storage and boundary rules. It should not change the baseline task list or
  hide missing ownership, borrow, scratch escape, or temporary cleanup analysis.

## Task 12.3: Runtime Aggregate Memory Representation

### Problem

Static-shaped structs and objects can be scalarized or rebuilt. Runtime
aggregate values do not yet have a general pointer representation with layout
facts, so field/index access, mutation, captured aggregates, and collection
loops only work for special cases.

### Implementation

- Define a runtime aggregate fact: pointer local plus static type/layout value.
- Extend layout helpers to compute field offsets for runtime struct/object
  values using the existing `align_to`, `val_type_size`, `load_instr`, and
  `store_instr` helpers.
- Reuse `closure_heap_global` as the bump pointer for unique/frozen runtime
  aggregate allocation.
- Use the scratchpad bump pointer for values allocated inside `scratch {}` that
  do not need to escape.
- Emit aggregate constructors as heap allocation plus field stores.
- Emit field access as pointer plus offset load.
- Preserve existing static-shape scalarization for const-known values; only
  allocate when a runtime aggregate value must exist as a pointer.
- Record whether the emitted pointer is unique, frozen, borrowed, or
  scratch-backed.

### Likely Modules

- `src/core/memory.ts`
- new `src/core/runtime_aggregate.ts`
- `src/core/text_layout/build.ts`
- `src/core/expr_emit.ts`
- `src/core/expr_emit/types.ts`
- `src/core/expr_emit/lifetime.ts`
- `src/core/expr_type/expr.ts`
- `src/core/local_facts.ts`
- `src/core/backend/analysis/local_facts.ts`
- `src/core/backend/emit/expr.ts`

### Acceptance Tests

- Runtime struct construction returns an `i32` pointer and stores scalar/Text
  fields at stable offsets.
- Field access over a runtime aggregate emits a load and round-trips through
  WAT-to-Wasm.
- Capturing a runtime aggregate in a first-class non-linear closure snapshots
  the pointer and preserves field access after shadowing.
- Missing layout facts throw deterministic errors.
- Scratch-backed aggregate pointers cannot escape unless frozen/promoted.

### Implementation Status

- Added `src/core/runtime_aggregate.ts` for standalone runtime aggregate layout
  and materialization. The layout uses the existing `align_to`, `val_type_size`,
  `val_type_align`, and `store_instr` helpers, starts standalone struct field
  offsets at `0`, and supports scalar, `Text`, union-pointer, `Unit`, and nested
  static-shaped struct fields.
- Direct use of a static-shaped struct as a runtime value now materializes a
  unique heap pointer through the shared `__closure_heap` bump pointer. Existing
  static-shaped field/index access remains scalarized and does not allocate.
- Core expression typing reports materialized aggregate values as `i32`
  pointers, while `Core.ownership(...)` and `Core.proof(...)` classify them as
  `unique_heap runtime_aggregate` with `persistent_unique_heap` final-result
  storage.
- Core local collection reserves deterministic aggregate pointer temps only when
  the aggregate itself is emitted as a value. Static field/index scalarization
  still collects only the selected field expressions.
- Tests now cover runtime aggregate pointer materialization, aligned scalar/i64
  and `Text` field stores, binding-time snapshots of runtime field values, and
  no-GC proof classification.
- Runtime aggregate local facts now track struct type facts for stored pointer
  locals across local collection, statement emission, closure typing/lifting,
  static-call planning, type annotations, text facts, and expression
  typing/emission.
- Runtime aggregate pointer locals are now visible to ownership and proof
  analysis as `unique_heap runtime_aggregate` values, rather than plain scalar
  `i32` locals.
- Field access over a stored runtime aggregate pointer now emits a pointer load
  at the field offset. Direct scalar and `Text` fields can be used after a
  first-class closure returns an aggregate pointer, for example
  `len(user.name) + user.age`. This path now has both focused Core WAT checks
  and WAT-to-Wasm round-trip coverage.
- First-class closures can capture stored runtime aggregate pointers and later
  load fields through the captured pointer. Nested runtime aggregate fields can
  also be used directly or bound as pointer aliases, including nonzero inline
  offsets such as `let name = user.name`.
- Persistent runtime aggregate pointers can now be frozen. The frozen binding
  retains aggregate type and runtime text field facts through the no-GC proof
  gate and WAT emission, can load scalar/Text fields after freeze, and rejects
  later index mutation with the frozen/shareable binding diagnostic.
- Temporary runtime aggregate values, runtime text concat results, and runtime
  union values inside an active `scratch {}` body can now allocate from
  `__scratch_heap` when the result of the scratch expression is scalar or
  otherwise scratch-free. Mixed persistent closure/aggregate/text/union heap use
  and scratch temporaries use separate globals so scratch reset does not rewind
  persistent allocations.
- Scalarized static-shaped aggregate results can now leave `scratch {}` when
  each returned field is scalar, static/frozen data, or otherwise scratch-free.
  The no-GC proof records the scratch return as an allowed frozen/shareable
  aggregate edge, and WAT emission keeps the field reads scalarized without
  emitting a scratch allocation.
- Static union cases with scratch-free payloads can also leave `scratch {}`;
  their proof edge records a frozen/shareable union result and static `if let`
  lowering keeps the payload scalarized.
- Dynamic static-union `if` results with scratch-free conditions and branch
  payloads can also leave `scratch {}`; their proof edge records a
  frozen/shareable union result, and static `if let` lowering keeps the selected
  payload scalarized.
- Returning a scratch-backed aggregate still rejects unless the value is
  explicitly frozen/promoted or proven scratch-free at the returned-field level.
  Promotion/freeze codegen and reusable allocator/destructor cleanup integration
  remain pending.
- Nested static aggregate aliases inside a scratch-returned aggregate are now
  covered as a rejected proof fixture. The current planner must not accept that
  shape by materializing a hidden runtime aggregate pointer; a future accepted
  slice needs structural nested planning that keeps local collection, proof, and
  WAT emission in sync.
- The rejected nested-alias fixture now reaches `Core.proof(...)` as a proof row
  instead of throwing during proof-local collection. Proof-only collection
  preserves annotated struct/union facts long enough for cleanup to report the
  scratch-return rejection; normal typing and emission still reject the unsafe
  scratch return.

## Task 12.4: Runtime Indexing And Collection Facts

### Problem

`Core` can preserve unknown index and collection-loop nodes, but the emitter
only handles static aggregates and `Text`. Unknown runtime collections need
facts for `len`, `get`, element type, and optional index value.

### Implementation

- Add an indexable fact shape:

```txt
len: (collection) -> i32
get: (collection, i32) -> element
element_type: ValType or aggregate/union fact
```

- Lower `for x in xs` to a dynamic range loop over `0..len(xs)` plus `get`.
- Lower `for i, x in xs` similarly, binding `i` to the range index and `x` to
  `get(xs, i)`.
- Start with runtime arrays/slices or runtime aggregate-backed collections once
  Task 12.3 exists.
- Keep non-indexable unknown collections as explicit errors.
- Preserve ownership facts on indexed results: scalar values copy out, borrowed
  fields remain tied to the source lifetime, and frozen aggregate fields remain
  shareable.

### Likely Modules

- `src/core/collection_loop.ts`
- `src/core/index_expr.ts`
- `src/core/app_type.ts`
- `src/core/app_emit.ts`
- `src/core/local_facts.ts`
- `src/core/backend/entry/app.ts`
- `src/frontend/static_loop.ts`

### Acceptance Tests

- Unknown collection without indexable facts still rejects.
- Runtime indexable collection loop emits `block`/`loop` WAT and runs through
  Wasm.
- `break` and `continue` preserve carried scalar locals.
- Element type mismatch in a loop body is rejected before WAT emission.
- Borrowed loop item views cannot escape the loop body.

### Implementation Status

- Implemented the first runtime aggregate-backed collection fact slice. Stored
  runtime aggregate pointer locals with known struct layout now expose synthetic
  field expressions through the existing collection-field hook.
- `len(pointer)`, `get(pointer, i)`, `pointer[i]`, and `for i, value in pointer`
  now work for homogeneous scalar runtime aggregate fields. The emitted WAT
  loads each field from the stored aggregate pointer at the layout offset, and
  the WAT-to-Wasm test covers `len`, dynamic `get`, static index syntax, and
  loop iteration in one program.
- Homogeneous runtime aggregate `Text` fields now preserve text facts through
  dynamic `get`, static index syntax, and collection loop item bindings. This
  lets text operations such as `len(get(names, i))`, `len(names[0])`, and
  `len(name)` inside `for index, name in names` lower through Core/WAT. Mixed
  text/scalar dynamic collection item facts reject deterministically instead of
  treating text pointers as plain `i32`.
- Nested runtime aggregate fields can now act as collection sources when the
  nested struct has homogeneous scalar fields. Constructing an outer runtime
  aggregate from a nested aggregate pointer copies the nested fields into the
  inline layout, and `for index, item in user.scores` loads the nested fields
  from the stored aggregate pointer offsets.
- Borrowing a non-scalar item from a runtime aggregate-backed collection now
  records the source collection owner. A stored loop item view such as
  `view = borrow name` can be read after the loop while the collection owner
  remains live, and later mutation of that owner rejects through the normal
  borrowed-owner barrier.
- Runtime aggregate-backed collection loops now have explicit loop-control
  coverage: `continue` skips the current unrolled field body, `break` exits the
  collection loop, scalar carried locals remain valid, and the WAT-to-Wasm
  fixture covers the behavior.
- Unknown collections without facts still reject, and heterogeneous non-text
  runtime aggregate fields reuse the existing item-type mismatch diagnostic
  before WAT emission.
- Remaining follow-up: general runtime array/slice facts, dynamic loop lowering
  over unknown-length collections, borrowed item lifetime rules for future
  iterator-backed collections, and ownership merge facts for non-scalar indexed
  results.

## Task 12.5: General Memory-Backed Index Mutation

### Problem

Index assignment works for static-shaped aggregate rebuilds and runtime `Text`
byte assignment. General memory-backed mutation needs ownership/fact checks and
store emission.

### Implementation

- Require a mutable or linear/unique fact before emitting memory-backed stores.
- Reuse runtime aggregate layout facts from Task 12.3.
- Support scalar field/index stores first.
- Preserve current static rebuild behavior for pure values.
- Add bounds checks for runtime index mutation.
- Reject stores through borrowed or frozen values.

### Likely Modules

- `src/core/index_assign.ts`
- `src/core/index_assign/types.ts`
- `src/core/index_assign/static.ts`
- `src/core/index_assign/runtime_aggregate.ts`
- `src/core/stmt_emit.ts`
- `src/core/runtime_text.ts`
- `src/core/local_facts.ts`
- `src/frontend/index_assignment.ts`
- `src/frontend/linear_stmt.ts`

### Acceptance Tests

- Linear runtime aggregate index assignment emits a checked store.
- Non-linear non-mutable aggregate mutation is rejected.
- Frozen and borrowed aggregate mutation is rejected.
- Out-of-bounds dynamic assignment traps.
- Static aggregate rebuild tests remain unchanged.

### Implementation Status

- Implemented the first runtime aggregate field-store slices. A stored runtime
  aggregate pointer with known struct layout can now handle `target[i] = value`
  for top-level scalar, `Text`, union-pointer, and inline nested aggregate
  fields. Static indexes emit direct offset stores; dynamic indexes evaluate the
  index/value once, emit a checked branch chain, and trap through `unreachable`
  when the index is out of bounds. Dynamic stores require every possible target
  field to agree on scalar-vs-`Text`-vs-union-pointer-vs-nested facts.
- Static aggregate rebuild behavior is unchanged and still takes precedence for
  frontend-known aggregate values. Runtime `Text` byte assignment remains the
  separate byte-store path.
- Runtime aggregate union-pointer and inline nested aggregate fields are
  supported for direct and captured aggregate pointers, with matching
  union/aggregate type checks before WAT emission. Static/frozen-shareable text
  bindings now remain immutable static data and reject indexed mutation with a
  deterministic frozen/shareable binding diagnostic. Frozen unique-heap store
  attempts over runtime aggregate pointers now map into the no-GC proof gate
  with the same frozen/shareable binding diagnostic before module emission.
  Frozen unique-heap store codegen beyond deterministic rejection, arrays,
  slices, and reusable allocator/destructor cleanup remain follow-up work.
  Active borrow views already block mutation of the borrowed runtime aggregate
  owner through the existing borrow gate.
- Tests cover Core WAT shape, WAT-to-Wasm mutation behavior, dynamic
  out-of-bounds traps, captured scalar and `Text` mutation through inline and
  first-class closures, borrowed-owner mutation rejection, frozen/shareable
  static text mutation rejection, proof-gated frozen runtime aggregate mutation
  rejection, and deterministic rejection for text/scalar mismatches and mixed
  dynamic text/scalar target fields.

## Task 12.6: Dynamic `if let` Through Structured Core

### Problem

The Ic frontend supports several typed/direct union-if shapes. Unknown dynamic
`if let` and non-scalar branch results still reject on the Ic path.

### Implementation

- Require a known union type from annotation, local fact, helper return type, or
  runtime union pointer fact.
- Lower unknown dynamic `if let` to structured `Core.if_let` rather than Ic when
  branch results need memory, closures, or statement control flow.
- For pure scalar/Text-pointer expressions, keep existing Ic select lowering.
- For closure-valued branches, reuse first-class closure support in Core.
- Preserve current rejection for truly untyped targets.
- Merge ownership/lifetime facts across branches. Branches must produce
  compatible ownership states: both unique, both frozen, both scalar, or a
  rejected mismatch.

### Likely Modules

- `src/frontend/if_let.ts`
- `src/frontend/if_let_target.ts`
- `src/frontend/if_let_union_result.ts`
- `src/core/if_let.ts`
- `src/core/if_let_dispatch.ts`
- `src/core/expr_type/if_let.ts`
- `src/core/runtime_union_match.ts`

### Acceptance Tests

- Untyped dynamic `if let` still rejects.
- Annotated runtime union pointer `if let` with scalar branches runs through
  WAT-to-Wasm.
- Closure-valued `if let` branches compile through Core and call indirectly.
- Non-matching no-else `if let` produces the correct implicit fallback for the
  inferred result type.
- Branches that return scratch-backed values cannot escape the active
  scratchpad.

### Implementation Status

- Implemented the first closure-valued branch slice in Core. `Core` closure type
  inference, local collection, and closure emission now handle `if_let`
  expressions over direct dynamic union-if targets and stored runtime-union
  pointer targets. Matching branches can capture the bound payload in the lifted
  closure environment, non-matching branches call the else closure, and one
  annotated closure branch can establish the function type for an unannotated
  branch. WAT-to-Wasm coverage now validates both matching and fallback
  stored-runtime-union cases through `call_indirect`.
- Implemented implicit `Text` fallback for no-else Core `if` and dynamic
  `if_let` expressions. Text fact analysis now treats the synthetic fallback as
  an empty text value only when the selected branch is proven text, WAT emission
  emits the real empty-text pointer instead of raw `i32.const 0`, and text
  layout registers the empty literal only for expressions that need it.
  WAT-to-Wasm coverage validates no-else `Text` fallback for plain `if` and
  typed runtime-union `if let` expressions.
- Implemented the matching static annotated union-case fallback slice. The
  drop/proof local-collection shortcut now applies binding annotations before
  deciding that a runtime binding is static, so typed shorthand union cases keep
  their `type_expr` in proof/drop contexts. A non-matching no-else static
  `if let` over a `Text` payload can now materialize the empty-text fallback and
  compile through WAT-to-Wasm, while the existing `I64` implicit-zero fallback
  guard stays covered.

## Task 12.7: Runtime Union Payload Generalization

### Problem

Runtime union payload storage/matching is implemented for scalar, `Text`,
`Unit`, union-pointer, and aggregate-pointer struct payloads. Broader runtime
payload shapes, payload ownership transfer, and scratch escape/promotion rules
remain reserved.

### Implementation

- Extend `RuntimeUnionPayload` to reference runtime aggregate layouts from Task
  12.3.
- Store aggregate payloads as pointers first.
- Add optional inline payload storage only after pointer payloads are stable.
- Keep match binding fact-directed: payload binders should carry text, union,
  aggregate, or scalar facts.
- Preserve payload ownership facts. Matching a frozen payload yields a frozen
  value or read-only borrow; matching a unique payload must not duplicate it.

### Likely Modules

- `src/core/runtime_union_payload.ts`
- `src/core/runtime_union_payload_emit.ts`
- `src/core/runtime_union_match.ts`
- `src/core/runtime_union/`
- `src/core/backend/union/runtime/`

### Acceptance Tests

- Union case with runtime aggregate payload stores and matches by pointer.
- Nested union payload facts survive `if let` branch binding.
- Payload type mismatch fails before emission.
- Existing scalar/Text/static-shaped payload tests still pass.
- A union case cannot smuggle a scratch-backed payload outside `scratch {}`.

### Implementation Status

- Implemented the first aggregate-pointer payload slice. Struct-typed runtime
  union payloads now store an aggregate pointer at payload offset `4` instead of
  copying inline scalar leaves into the union object.
- Direct/static `if let` payload binding and runtime-union pointer matching now
  preserve scalar, `Text`, aggregate, and union-pointer facts. This covers
  nested `if let` over a union payload and `if let` over a union-valued field
  inside a runtime aggregate.
- Proof-visible allocation facts now include the aggregate pointer allocation
  emitted for directly constructed struct-typed runtime union payloads, so the
  no-GC proof reports both the runtime union object and the runtime aggregate
  payload allocation.
- Local collection now reserves setup temporaries created by static-value
  payload capture, so WAT locals match the aggregate/union temps used by
  emission.
- WAT-to-Wasm tests cover direct aggregate payload memory inspection, stored
  runtime union pointer matching, aggregate payload field loads, nested union
  payloads, union-valued aggregate fields, and frontend dynamic union struct
  payload lowering.
- Implemented the first direct named-owner payload transfer slice. When a
  runtime union case stores an existing `unique_heap runtime_aggregate` or
  `unique_heap runtime_union` owner as a pointer payload, `Core.proof(...)`
  records a transfer edge such as `union_case.ok`, removes the moved owner from
  scope-exit drops, and rejects direct use of that owner after the transfer
  before WAT emission.
- Implemented the simple alias payload-transfer slice. If `let alias = owner`
  names a unique aggregate/union owner and `alias` is stored into a runtime
  union pointer payload, transfer validation resolves the edge back to the
  original owner. Later use through either the alias or the original name
  rejects before WAT emission, while the accepted no-use case still compiles.
- Implemented the first static-wrapper payload-transfer slice. Top-level
  statically bound helper calls with aggregate or union parameter annotations
  now enter a closure-body proof context that carries aggregate/union parameter
  facts. A helper such as `wrap(payload: user_type) => result_type.ok(payload)`
  records the caller owner transfer at the static-call site, removes the moved
  owner from drops, rejects use-after-transfer, and compiles when the moved
  owner is not reused.
- Implemented the branch-selected static-wrapper payload-transfer slice.
  Branch-valued wrappers with aggregate/union parameter annotations now lower as
  static-call branches for union payload construction. Each possible branch
  records its own caller-owner transfer, moved owners are removed from drops,
  direct and alias use-after-transfer reject before WAT emission, and ordinary
  scalar branch closures remain runtime/first-class values.
- Implemented the higher-order static-wrapper payload-transfer slice. Helpers
  with `const` function parameters now preserve aggregate/union payload
  transfers through direct calls, block-local static-function aliases such as
  `let g = f`, and branch-valued higher-order helpers. Scoped static-call union
  recognition enters helper bodies with statement scope, so each possible nested
  wrapper call records the caller-owner transfer and use-after-transfer rejects
  before WAT emission.
- Implemented the branch-assigned payload-transfer slice where both arms assign
  a runtime union case with a moved aggregate/union pointer payload to the same
  result. The branch merge now preserves the generated payload aggregate/union
  facts, `if let` payload binders inherit those facts, `Core.proof(...)` records
  one `union_case.*` transfer per branch, WAT emission can read the matched
  payload fields, and use-after-transfer rejects before module emission.
- Implemented the one-sided branch-transfer proof gate. A branch that moves an
  owner into a runtime union payload on only some paths now rejects before WAT
  emission with a deterministic conditional-cleanup diagnostic instead of being
  accepted without a drop fact for the path where the owner remains live.
- Implemented the loop transfer proof gate for collection-loop payload moves. A
  loop body that moves an owner into a runtime union payload now rejects with
  the same conditional-cleanup diagnostic until loop execution, carried-owner,
  and zero-iteration cleanup/drop facts exist. Dynamic range loops carrying
  static aggregate/union facts already reject earlier in the loop-carried fact
  gate.
- Implemented dynamic runtime `i32` slice facts and structured iteration. The
  proof records element type, ownership, pointer offset, dynamic length, and
  capacity before WAT emits the slice loop. Runtime aggregate indexing also
  preserves indexed runtime-union type/payload facts, so a dynamically selected
  union item can flow into `if let` without losing its layout contract.
- Remaining follow-up: broaden one-sided branch and loop payload moves only
  after explicit conditional cleanup/drop facts exist; then continue through
  dynamic wrappers; add precise freeze/copy facts for payloads that should be
  shared instead of moved; implement scratch-to-persistent promotion for
  escaping scratch-backed payloads; and generalize beyond struct/union pointer
  payload shapes only when the proof gate can validate the facts.

## Task 12.8: Runtime Text/String Operations

### Problem

Text support covers literals, visible concat/data pointers, runtime length,
byte-load, `get`, byte assignment, collection loops, and a Core runtime concat
subset. Broader text operations need allocation and byte-copy loops.

### Implementation

- Decide the next operations explicitly, for example runtime concat, equality,
  slice, or append.
- Reuse length-prefixed UTF-8 representation.
- Implement allocation through the shared heap pointer for escaping values and
  through the scratchpad pointer for temporary values inside `scratch {}`.
- Emit copy/compare loops in structured Core.
- Treat returned text pointers as unique, frozen, borrowed, or scratch-backed
  according to the producing expression.

### Likely Modules

- `src/core/runtime_text.ts`
- `src/core/text_facts.ts`
- `src/core/text_layout/`
- `src/core/app_type.ts`
- `src/core/app_emit.ts`
- `src/frontend/text_lower.ts`

### Acceptance Tests

- Runtime concat allocates new text and preserves source buffers.
- Equality or slice traps/checks bounds according to the chosen operation.
- Text operations inside closures preserve captured text pointers.
- Scratch-backed text cannot escape unless frozen/promoted.

### Implementation Status

- Implemented the runtime text equality slice. Core now recognizes
  `Text == Text` and `Text != Text` as runtime text operations with an `i32`
  result instead of treating text pointers as numeric operands.
- `Core.emit` lowers runtime text equality to a structured byte-compare loop
  over the existing length-prefixed UTF-8 representation. It checks lengths
  first, compares bytes with `i32.load8_u`, and inverts the boolean result for
  `!=`.
- Implemented the runtime text slice operation. `slice(text, start, end)` is a
  Core/WAT text operation over byte offsets. It validates `i32` start/end
  operands, traps when bounds are invalid, allocates a new length-prefixed text
  buffer from the selected heap, and copies bytes with a structured loop.
- The pure Ic frontend path folds statically visible text slices, including
  dynamic visible text branch operands by applying the slice to each branch and
  preserving the branch shape. Bound visible slice results remain visible to
  later `len`, indexing, equality, and nested visible operations. Runtime text
  slices still reject with a structured Core/Wasm route diagnostic. Inlineable
  unannotated helper calls that return visible slices now preserve those facts
  through bindings as well.
- Local collection reserves deterministic hidden locals for text equality loops,
  text slice loops, and backend text facts/runtime adapters expose the text
  operations through the same hook pattern used by runtime concat.
- Core function types now carry a `result_text` fact alongside `param_texts`.
  Text-producing closure calls such as a runtime `slice` helper can satisfy
  `Text` binding annotations and propagate runtime text locals through proof and
  WAT emission instead of being treated as plain `i32` values.
- The pure Ic frontend path folds visible literal text equality to `i32`.
  Equality and inequality over dynamic visible text branches now lower to nested
  `i32.select` expressions over branch-local static text comparisons, while
  runtime `Text` equality still rejects with a structured Core/Wasm route
  diagnostic.
- The pure Ic frontend also folds the strict runtime text identity case:
  annotated `Text` parameters or bindings comparing the same resolved binding
  lower `value == value` to `1:i32` and `value != value` to `0:i32`. This now
  includes transparent `borrow`/`freeze`/`scratch` wrappers and simple
  block-local `let` aliases inside returned scratch/block values, plus
  inlineable helpers that return the same runtime `Text` binding through those
  transparent wrappers. General runtime `Text` equality still uses the
  structured Core/Wasm byte-compare path, including helpers that allocate or
  transform runtime text before comparison.
- Text-valued `if let` expressions over statically known union cases and dynamic
  union-if targets with visible branch payloads preserve visible text facts
  through bindings, so later `len`, indexing, equality, and slice-style
  operations stay on the pure Ic path. Inlineable helper-returned text `if` and
  visible `if let` results now participate in the same pure Ic fact path.
- Runtime text slice allocation is covered by the baseline no-GC proof harness:
  `Core.proof(...).allocations` records the `slice(...)` app as a
  `persistent_unique_heap` / `unique_heap text` / `runtime_text` allocation with
  managed storage disabled.
- Implemented the `append(left, right)` text operation as a shadowable source
  builtin. Literal append and append over dynamic visible text branches fold
  through the Ic path. Bound visible append results remain visible to later
  `len`, indexing, equality, and slice operations. Inlineable unannotated helper
  calls that return visible append results preserve the same facts through
  bindings. Runtime append lowers through structured Core/Wasm using the
  existing runtime text concat allocation and copy-loop path. The baseline no-GC
  proof records runtime append as a `persistent_unique_heap` /
  `unique_heap text` / `runtime_text` allocation with managed storage disabled.
- Runtime text operation temporaries now have proof-locked drop coverage for the
  reusable free-list allocator path: discarded append/slice temporaries emit
  `discarded_expr` drop facts, bound append/slice runtime text temporaries emit
  `scope_exit` drop facts, and the append proof fixture exposes both slice and
  append owner drops with managed storage disabled.
- Persistent runtime text `freeze` now reuses the consumed unique text buffer as
  frozen/shareable storage, exposes an allowed `freeze` proof edge, rejects
  mutation through the frozen runtime text binding, and supports direct,
  block-local, inlineable helper-returned, and branch-result scratch promotion
  shapes by copying the frozen result into persistent heap storage before
  scratch reset.
- The scratch promotion proof records the `append(...)` allocation as
  scratch-backed runtime text and the `freeze` edge as a persistent runtime text
  allocation with managed storage disabled for both
  `scratch { freeze append(...) }` and
  `scratch { let temp = append(...); freeze temp }`, and records one promotion
  edge per frozen `if` branch when the scratch result is selected by a branch.
- Scratch runtime `Text` promotion now also preserves text/layout facts through
  annotated local aliases, so
  `scratch { let temp: Text = append(...); let alias: Text = temp; freeze alias }`
  reaches the same no-GC proof surface and WAT-to-Wasm path as direct bound
  scratch promotion.
- Block-local runtime `Text` results now carry the same facts through scratch
  promotion, so
  `scratch { let temp: Text = { let inner: Text = append(...); inner }; freeze temp }`
  records the scratch allocation, persistent freeze allocation, and no-GC proof
  edge before WAT emission.
- Annotated scratch-frozen runtime `Text` results now preserve the same text
  facts through Core annotation checking and later local collection, so
  `let result: Text = scratch { let temp: Text = append(...); freeze temp }` can
  be used by later `len(result)` and compiles through WAT-to-Wasm. The same
  annotated shape without `freeze` still rejects before emission because
  scratch-backed unique text cannot leave the scratch scope.
- Branch-selected and branch-assigned scratch-local runtime `Text` promotion now
  has explicit proof and WAT-to-Wasm coverage. Shapes such as
  `scratch { let temp: Text = if flag { append(...) } else { append(...) }; freeze temp }`
  and
  `scratch { let temp: Text = append(...); if flag { temp = append(...) } else { temp = append(...) }; freeze temp }`
  record scratch-backed branch allocations, a persistent freeze allocation, and
  assignment replacement drop facts where the branch overwrites a scratch-local
  owner.
- Dynamic `if let` assignment inside scratch-local union promotion now preserves
  the matched payload facts and merges the assigned static union value with the
  unchanged fallthrough value. A shape such as
  `scratch { let temp: result_type = result_type.err(...); if let .some(name) = maybe { temp = result_type.ok(append(name, ...)) }; freeze temp }`
  compiles through WAT-to-Wasm and verifies both the matched `ok(Text)` branch
  and the unchanged fallback branch after scratch reset.
- Loop-assigned scratch-local runtime `Text` promotion now has explicit proof
  and WAT-to-Wasm coverage. A shape such as
  `scratch { let temp: Text = append(...); for i in 0..count { temp = append(...) }; freeze temp }`
  records scratch-backed loop allocations, the persistent freeze allocation, the
  loop-scope drop row for the carried text owner, and preserves both
  zero-iteration and one-iteration results.
- Collection-loop-assigned scratch-local runtime `Text` promotion now has proof
  and WAT-to-Wasm coverage for runtime aggregate collection facts. Static
  collection local collection now scans the body once per emitted field, so
  helper locals introduced by unrolled body text operations and the later
  scratch-to-persistent freeze copy are declared before WAT emission.
- Helper-returned scratch `Text` freeze now inlines ownership facts before the
  scratch-return gate, allocates the promoted bytes persistently, and preserves
  cleanup rows through WAT. A promoted scratch `Text` may also be stored in a
  persistent closure environment as a frozen/shareable capture; the matching raw
  scratch-backed stored capture remains rejected.
- Remaining follow-up: broader nested aggregate/union scratch-backed text
  promotion and reusable allocator/destructor cleanup beyond the current no-op
  bump drop facts.

## Task 12.9: Effectful Capability Method ABI

### Problem

Pure linear capability calls and frontend-known method-style calls work, but
unknown host-style effectful methods are intentionally rejected before Ic
lowering. A Wasm ABI is needed before lowering them generally.

### Implementation

- Define capability methods as explicit imports or as fields in a runtime
  capability object.
- Keep effects explicit: method calls consume `!cap` and return the next cap.
- Represent imported host functions in `Mod` with stable parameter/result
  signatures.
- Reject missing capability methods during type/fact checking.
- Keep frontend-known pure method calls specialized as they are today.
- Capability tokens are linear/unique values, not frozen or borrowed values.

### Likely Modules

- `src/mod.ts`
- `src/core/app_type.ts`
- `src/core/app_emit.ts`
- `src/frontend/linear_effect.ts`
- `src/frontend/builtin_call.ts`
- `src/frontend/builtin_call/text.ts`
- `src/frontend/linear_stmt.ts`
- `src/frontend/source.ts`

### Acceptance Tests

- `io = io.print("hello")` lowers to an imported function call with explicit
  token threading.
- Discarding the returned capability still fails linear validation.
- A narrowed capability object exposes only passed methods.
- Missing host method facts produce deterministic errors.

### Implementation Status

- Implemented the first explicit-import ABI slice. A method call on a linear
  receiver rewrites through `Source.core` when the method name has a matching
  `host_import`; `io = io.print("hello")` becomes `io = print(!io, "hello")` and
  emits a stable imported Wasm function call.
- Structured `Source.core`/`Source.wat` now run the existing frontend linear
  validation prepass, so discarding the returned capability still rejects with
  the same linear diagnostic as the Ic path.
- Core `linear` expressions now type and emit as consuming reads of the
  corresponding local. Exact-use checking remains a frontend/source validation
  responsibility.
- Missing imported method facts are now proof-visible. A linear receiver method
  call without a matching `host_import`, including inside a lambda body, records
  `Missing host capability method: receiver.method` before WAT emission.
- Capability objects built from known host imports now lower to explicit method
  tables. `Core.proof(...)` exposes canonical capability-method rows, narrowed
  tables reject omitted methods before WAT, and accepted calls retain explicit
  linear token threading through the selected import.
- Remaining follow-up: dynamically allocated capability tables and non-scalar or
  ownership-bearing capability tokens beyond the known-table scalar
  import-threading slice.

## Task 12.10: First-Class Linear Closure Captures

### Problem

Non-linear first-class closure storage exists. General first-class closures that
capture linear values remain reserved because closure environments currently
snapshot values that may be duplicated or called more than once.

### Implementation

- Represent a stored closure as a function/table target plus an environment
  pointer and an environment layout fact.
- Classify the closure environment allocation before WAT emission. Persistent
  reusable closure environments start as `unique_heap` unless frozen; closure
  environments allocated inside `scratch {}` are `scratch_backed` and cannot
  escape unless frozen, promoted, or proven scratch-free.
- Mark each environment slot with ownership and lifetime facts. Frozen captures
  may be shared, unique captures move into the environment, borrow captures are
  valid only while the borrow lifetime outlives the closure value, and
  scratch-backed captures require a non-escaping proof.
- Distinguish reusable closure values from linear closure values in Core facts
  before WAT emission.
- Record cleanup/drop facts for closure environment owners and lowering-created
  closure temporaries. The first bump allocator may lower persistent closure
  drops to no-op WAT, but the proof still needs the drop edge.
- Mark closures that capture linear values as linear closure values.
- A linear closure call must consume the closure exactly once.
- Store captured linear values in the closure environment without exposing copy
  paths.
- Reject aliasing, duplication, or branch paths that call the same linear
  closure more than once.
- Start with direct first-class calls, then add closure-valued branches.
- A closure may capture a frozen value freely, may borrow only within the borrow
  lifetime, and may capture a unique value only if the closure itself becomes
  linear.

First-class closure storage should be split into these concrete proof/codegen
slices:

1. Environment layout

   - Store the function-table index plus capture slots in linear memory.
   - Record slot offsets, value types, source capture names, and callable
     signature facts before WAT emission.

2. Environment storage class

   - Classify each environment as persistent `unique_heap`, persistent
     `frozen_shareable`, `scratch_backed`, or rejected.
   - A scratch-backed closure may leave `scratch {}` only by explicit freeze or
     promotion, or by a proof that the closure cannot escape the scratch
     lifetime.

3. Capture-slot ownership

   - Classify each slot independently as scalar, frozen/shareable, unique,
     borrow-view, scratch-backed, capability, or nested closure.
   - Reusable closures may freely capture only scalar and frozen/shareable
     slots. Unique, borrow, scratch-backed, capability, or ownership-bearing
     closure slots require linear closure support or a deterministic rejection.

4. Call and alias behavior

   - Reusable closure values may be copied only when all captured slots are
     reusable.
   - Linear closure values must be consumed exactly once, including through
     aliases, branches, `if let` closure selections, and higher-order calls.

5. Cleanup and proof gate

   - Record allocation, capture ownership, transfer/freeze decisions, and
     environment drop facts for bound, discarded, returned, and branch-selected
     closures.
   - Keep closure environment cleanup proof-visible even while the first bump
     allocator lowers persistent drops to no-op WAT.

### Likely Modules

- `src/frontend/linear_closure.ts`
- `src/frontend/linear_closure_rename.ts`
- `src/frontend/linear_closure_names.ts`
- `src/frontend/linear_expr.ts`
- `src/frontend/linear_stmt.ts`
- `src/core/closure_capture/`
- `src/core/closure_emit.ts`
- `src/core/closure_type/`

### Acceptance Tests

- A closure that captures `!io` can be called once and returns the next `io`.
- Calling or storing the same linear closure twice fails validation.
- Branches must consume the same linear captures.
- Non-linear closure tests continue to use ordinary reusable closure values.
- Capturing a scratch-backed value is rejected unless the closure cannot escape
  the scratchpad.

### Implementation Status

- Implemented the first Core/Wasm first-class linear capability-closure slice: a
  closure value with a linear `!io: I32` parameter can be selected through a
  runtime closure-valued branch, stored as a closure pointer, and called exactly
  once through `call_indirect`.
- Nested non-escaping closures inside that first-class closure body can consume
  the linear parameter through an import-backed method call, for example
  `let print_once = () => io.print("hello"); io = print_once()`.
- Implemented the first source `!` capture validation slice for stored closures:
  `let print_once = () => io.print("hello"); io = print_once()` is accepted, but
  a second call through the same binding, a call through an alias to that
  binding, or a branch where only one side consumes that closure rejects before
  Core/WAT emission.
- Branch-selected stored closures that capture the same source `!` value are now
  accepted when both branches resolve to compatible closure parameter shapes.
  The selected closure lowers through the existing closure pointer and
  `call_indirect` path, text literals from both branches are included in data
  layout, and duplicate or alias calls after consumption still reject before
  Core/WAT emission.
- Compatible branch-selected closures may use different parameter names. The
  frontend now alpha-renames both branch bodies into fresh shared parameter
  names before validating the captured source `!` consumption, so pure Ic and
  Core/WAT closure paths do not require branch-local parameter names to match
  textually.
- Closure-valued `if let` expressions that select scalar closures can now
  participate in the same source `!` validation path. Static union cases can
  lower through the pure Ic route, and runtime-union-pointer `if let` closure
  branches can lower through the existing Core closure table and `call_indirect`
  path when the captured linear value and payload are scalar.
- Closure-valued `if let` branches over dynamic static-union `Text` payloads now
  preserve payload text facts and host import contracts through local
  collection, so lifted closures can call bounded-borrow host imports with
  `borrow value` and compile through WAT-to-Wasm.
- Closure-valued `if let` branches over stored runtime-union-pointer `Text`
  payloads now preserve the selected payload through allocation/proof scanning,
  so the lifted closure can capture `borrow value`, emit the runtime union tag
  and payload loads, and call the bounded-borrow host import through
  WAT-to-Wasm.
- The text-layout pass now scans static/const function bodies when those
  function values are used at runtime as closure pointers, so text literals
  inside nested closure bodies get data segments before WAT emission.
- Recursive stored closures in the source `!` capture validation path now reject
  with a deterministic diagnostic that names the recursive closure binding. The
  shape stays reserved until linear closure ownership supports recursive
  self-calls explicitly.
- Branch-selected stored closures that capture a source `!` value now compare
  parameter annotations with the shared frontend annotation compatibility rule.
  Equivalent scalar annotations such as `Int` and `I32` no longer make the
  source `!` closure validator miss a valid one-shot call path.
- The pure Ic source `!` closure validator now also treats non-builtin
  annotations as potentially compatible so user-defined type aliases such as
  `user_type` and `user_alias` do not hide a valid one-shot consumption path.
  The actual dynamic-function compatibility check still rejects unrelated
  user-defined types before Ic lowering.
- Explicit linear expressions now infer the type of their binding when that type
  is known, so annotated source `!` values can participate in dynamic Ic branch
  selection. Pure Ic coverage includes dynamic `if` branches that consume the
  same linear value on both paths, return/fallthrough branches that consume a
  linear value exactly once per path, one-shot captured closures called across
  return/fallthrough paths, and dynamic `if let` closure selection with a
  captured source `!` value.
- Frontend linear-expression validation is split so
  `src/frontend/linear_expr.ts` remains the expression-consumption facade,
  branch/condition consumption and branch-state merging live in
  `src/frontend/linear_expr/branch.ts`, and shared callback/state types live in
  `src/frontend/linear_expr/types.ts`. Existing statement and loop validators
  continue to import the stable facade.
- Frontend linear-closure alpha-renaming is split behind
  `src/frontend/linear_closure_rename.ts`. Parameter shape checks and canonical
  shared parameter generation live in
  `src/frontend/linear_closure_rename/params.ts`, while the recursive
  expression/statement rename walker lives in
  `src/frontend/linear_closure_rename/walk.ts`.
- Structured Core closure function types now carry user-defined aggregate and
  union parameter metadata through `param_structs` and `param_unions`.
  Branch-selected closures that use alias-equivalent annotations such as
  `user_type` / `user_alias` or `result_type` / `result_alias` can be returned
  as first-class closure values, called through `call_indirect`, and validated
  against aggregate or union arguments before WAT emission.
- Frozen/shareable closure-capture proof coverage now includes full
  `Core.proof(...)` fixtures for frozen runtime `Text` and frozen runtime union
  captures, not only the standalone `Core.closure_ownership(...)` plan. Frozen
  aggregate `Text` field projections now preserve frozen/shareable ownership on
  the generated field temp, so reusable closures can capture those projected
  fields through the same allowed capture decision.
- Scratch-backed closure-capture proof coverage now accepts the narrow
  non-escaping direct-call shape inside `scratch {}`. A lambda immediately
  called inside the scratchpad may capture a scratch-backed `Text` value when
  the lambda body contains no nested closure value and the scratch result is
  scalar. Raw stored, returned, frozen, or branch-selected scratch-backed
  closure captures still reject; the explicit promotion slice below is the
  supported way to move captured data out of the scratch lifetime.
- Heap-stored one-shot closure environments now support explicit source `!`
  moves for scalar capability slots and runtime aggregate owner slots. Each slot
  records offset, persistent lifetime, unique environment storage, and `move`;
  the closure records `callable: "once"`, emits exactly one `call_indirect`, and
  direct or aliased reuse rejects before WAT. Aggregate layout facts remain
  available in the lifted body.
- Explicitly promoted scratch `Text` captures record a persistent
  frozen/shareable environment slot with `share` transfer plus scratch-reset
  cleanup rows. Raw scratch-backed stored captures still reject.
- Remaining follow-up: one-shot runtime-union owner slots, nested
  ownership-bearing aggregate/union captures beyond the implemented pointer
  move, and stored scratch-backed captures without an explicit promotion edge.

## Task 12.11: Broader Structured-Core/Wasm Cleanup

### Problem

The codebase still contains intentional `Cannot ... yet` diagnostics in Core
typing and emission. Some are real reserved features; others should become more
specific after the tasks above land.

### Implementation

- Audit each remaining `Cannot ... yet` diagnostic after Tasks 12.1-12.10.
- Convert broad diagnostics into feature-specific errors.
- Add tests proving each remaining unsupported node is either unreachable from
  valid source or deliberately reserved.
- Keep parser-reserved language-family features rejected.

### Likely Modules

- `src/core/expr_emit.ts`
- `src/core/expr_emit/types.ts`
- `src/core/expr_emit/lifetime.ts`
- `src/core/stmt_emit.ts`
- `src/core/expr_type/expr.ts`
- `src/core/app_emit.ts`
- `src/core/app_type.ts`
- `src/frontend/expr_lower.ts`
- `src/frontend/stmt.ts`

### Acceptance Tests

- Every remaining unsupported source feature has a test.
- Every remaining Core unsupported emitter/type path has a deterministic
  diagnostic.
- Full format, typecheck, and test suite pass.

### Implementation Status

- Linear-effect functions that cannot lower through the strict pure-Ic frontend
  now report the structured Core/Wasm route in the same diagnostic as other
  Ic-only limitations. The behavior remains rejected on `Source.compile`, but
  callers are pointed to `Source.core`, `Source.mod`, or `Source.wat` when the
  feature needs the structured path.
- Dynamic `if let` expressions with non-scalar branch results that remain
  outside the strict pure-Ic frontend now use the same structured-route
  diagnostic. Existing scalar/Text-pointer and supported closure/union/struct
  shapes still lower through Ic.
- Dynamic `if let` expressions can now use later result context before falling
  back to the non-scalar branch diagnostic. Annotated `Text` bindings and direct
  `len(...)`, `get(...)`, and byte-index calls provide `Text` context, and
  declared struct field projection provides scalar field context. These lower
  untyped dynamic union-if targets when the selected branches are Ic-safe under
  that result type.
- Dynamic `if let` function branch failures now distinguish incompatible
  parameter shapes from generic non-scalar branch results. The rejection still
  points to the structured Core/Wasm route, but the primary diagnostic now names
  the unsupported function-branch shape.
- No-else `if` and `if let` expressions now explain unsupported implicit
  fallbacks by inferred branch type. Supported fallbacks now include `Int`,
  `I64`, `Text`, structs whose fields all have fallback values, and unions with
  an Ic-safe `Unit` or fallbackable payload case. Unsupported branch results
  still produce a deterministic fallback diagnostic instead of a generic "cannot
  lower yet" error.
- Dynamic `if` expressions whose branch type is outside the Ic-selectable set
  now name the inferred branch type, for example `Type`, instead of reporting a
  generic non-`i32` branch error.
- The remaining dynamic union-if binding fallback now reports a union-specific
  pure-Ic diagnostic and points to the structured Core/Wasm route, rather than
  reusing the old generic dynamic-`if` branch wording.
- Static `rec` calls with pure linear parameters now lower through the pure Ic
  route when exact-use validation succeeds. Tail-recursive `rec(!state, ...)`
  calls resolve the consumed linear argument back to the carried value during
  static unrolling, while missing `!` or branch-mismatched consumption rejects
  with the shared linear diagnostics.
- Static `rec` bodies that contain `break` or `continue` now keep the
  rec-specific pure-Ic rejection but also include the structured Core/Wasm
  route, matching the rest of the unsupported-rec diagnostics.
- Compile-time-only final expressions now reject with compile-time-specific
  pure-Ic diagnostics: builtin type names, bound type names, struct types, union
  types, and extension values explain that they cannot be emitted as Ic results
  instead of using the older generic "cannot lower yet" wording or runtime-name
  casing errors.
- Untyped dynamic `if let` targets now reject with a target-specific pure-Ic
  diagnostic that says the Ic route needs a typed union target, while still
  pointing to `Source.core`, `Source.mod`, or `Source.wat` for structured
  Core/Wasm lowering. Expression, statement, and static-rec lowering share the
  same diagnostic.
- `borrow`, `freeze`, and `scratch` wrappers whose result cannot be proven
  pure-Ic lowerable now reject with wrapper-specific pure-Ic diagnostics instead
  of the older "non-scalar result" wording. The accepted Ic erasure path still
  covers scalars, statically shareable text, runtime `Text`, structs, unions,
  and pure closures.
- Static range-loop bodies that need dynamic break/continue state but then bind
  a value without an Ic-safe fallback now keep the feature-specific rejection
  and also point callers to `Source.core`, `Source.mod`, or `Source.wat`, where
  the original structured loop can be preserved.
- Explicit linear-value syntax with no matching binding now rejects as an
  unbound linear value, naming the missing source name, instead of using the
  broader pure-Ic lowering limitation.
- Static `rec` bodies and nested rec-result blocks that produce no value now
  reject with missing-result diagnostics instead of the broader generic
  unsupported-rec message, while still pointing to the structured Core/Wasm
  route.
- Static `rec` definitions used as values, instead of called through the
  static-rec lowering path, now reject with a rec-function-value diagnostic
  rather than the broader generic unsupported-rec message.
- Dynamic pure-Ic function branches now accept matching linear parameter shapes.
  Both branch lambdas are validated with the existing linear-use checker, their
  branch environments bind the shared parameter as linear, and mismatched
  linear/non-linear branch parameters still reject as incompatible.
- Untyped no-payload shorthand union cases now have explicit regression coverage
  for the existing inferred `Unit` case lowering, and the unreachable generic
  pure-Ic "union case yet" fallback was removed from that path. Internal
  visible-text byte-index fallbacks are also classified as normalized-text
  invariants rather than source-level unsupported features.
- Parser-reserved unsupported AST nodes now use the same strict Ic diagnostic
  shape as other Ic-only limitations, including the structured Core/Wasm route.
  The excluded grammar-family regression now proves the formatted unsupported
  node and the route-bearing lowering diagnostic for classes, traits, macros,
  runtime instance search, inheritance, and `where` clauses.
- Unresolved field calls now report a method-call-specific pure-Ic diagnostic
  instead of the generic field-access fallback. Function-valued fields that can
  lower still flow through normal field lowering; unsupported capability-style
  method calls such as `io.print("hello")` point to the structured Core/Wasm
  route.
- Unknown index update and unknown index access rejections now name the indexed
  target before the structured Core/Wasm route, so unsupported memory-backed
  shapes such as `buf[i] = x` and `buf[i]` no longer fail with only a generic
  route suffix.
- Unknown collection-loop rejections now name the collection expression before
  the structured Core/Wasm route, and the dynamic-range fixture now asserts the
  primary `for end` diagnostic as well as the route suffix.
- Static range-loop dynamic break/continue expansion now accepts an unused
  function-valued local binding whose lambda body has an unknown result type,
  such as `let f = x => x`, by deferring the synthesized function-valued
  fallback branch instead of forcing immediate dynamic-function lowering. The
  defer predicate stays narrow: ordinary dynamic function branches with
  lowerable scalar, text, struct, or union bodies continue to lower directly to
  Ic lambdas. Calls through the deferred loop-local function now inline the
  selected branch body before Ic lowering, including static-true aliases of the
  dynamic loop-control flag, so identity-style calls no longer leave unreduced
  `f#...` applications in the generated Ic graph.
- Statically expandable nested range and collection loops after dynamic
  break/continue state now lower on the pure Ic route. The nested loop body is
  expanded through the normal static-loop expander and wrapped in the current
  loop-step guard, so work after a dynamic break or continue is skipped while
  inner loop-local control remains scoped to the nested loop.
- `const` bindings after dynamic break/continue state now lower through the same
  guarded fallback path as runtime `let` bindings when their value shape is
  Ic-safe. The generated binding is intentionally emitted as a runtime `let`,
  because the binding is path-dependent and cannot remain an unconditional
  compile-time fact.
- Typed struct and union block-alias bindings after dynamic break/continue state
  now lower through the expected-type aggregate path when the direct
  dynamic-`if` route reports generic aggregate branches. Regression coverage
  includes guarded loop bindings whose block-local alias selects between
  `borrow` and simple `scratch {}` branch values before later field projection
  or `if let` union consumption.
- The guarded skipped-step path now also handles unannotated shorthand
  union-result bindings whose result comes from an implicit no-else `if let`.
  Union inference binds the matched payload before inferring the result case
  table, verifies that an implicit fallback can be built, and then lets the loop
  expander synthesize the skipped-step union fallback before later handler
  consumption.
- General `if let` expression inference now binds the matched payload before
  inferring the then branch when the target has a known union case table. The
  skipped-step fallback path uses that to lower unannotated direct payload
  results such as `Text` and struct values after dynamic loop control.
- Block-final no-else `if`/`if let` conditionals with value-producing branch
  blocks now parse as final expressions rather than statement-only blocks, and
  expected-type `if let` lowering backs off from direct unknown-fallback
  failures so nested payload selections can lower through typed handlers.
- The same guarded skipped-step path now normalizes simple block-local function
  aliases before constructing a path-dependent function value. Direct-lambda
  resolution accepts `{ let id = x => x; id }` style blocks, captures the lambda
  with the block-local environment, and keeps later calls from lowering to
  unresolved `f#...` Ic applications.
- Guarded skipped-step function aliases now also support simple non-linear
  block-local captures. The resolver treats the block prefix as an inline
  captured environment, including static-loop value snapshots, so closures such
  as `{ let offset = i + 1; let add = x => x + offset; add }` and
  `{ let offset = i + 1; return x => x + offset }` stay on the pure Ic route
  instead of falling back to structured Core solely because the block has a
  local captured value.
- Unknown dynamic `if` values can now be deferred through unannotated runtime
  bindings until a later pure-Ic consumer supplies a concrete context. Numeric
  primitive operands lower deferred `Int`/`I64` branch values through typed
  selects, `len(...)` lowers deferred text branches through the existing text
  pointer path, and runtime struct field projection can project scalar/Text
  fields from deferred branch-selected struct values. Untyped final uses still
  keep the original dynamic-if diagnostic, and incompatible function-branch
  diagnostics remain owned by the dynamic function branch checker.
- Dynamic static-loop skipped-step bindings now use that same deferred-context
  model when their immediate binding type is still unknown. The loop expander
  wraps the executed value in an implicit-fallback guard and lets later typed
  consumers prove the fallback as `Int`, `I64`, `Text`, or a typed union
  `if let` text result. This keeps unannotated numeric and text bindings after
  dynamic `break`/`continue` on the pure Ic route while untyped final uses still
  reject.
- Static-rec local bindings now also preserve unknown dynamic `if`/`if let`
  values as deferred bindings. Rec primitive operands provide `Int`/`I64`
  context, and rec-local `len(...)` provides `Text` context, allowing statically
  unrolled rec bodies to lower those unannotated locals through pure Ic without
  defaulting unknown branch values.
- Direct static-rec text results now receive caller context from text consumers.
  `len(...)`, `get(...)`, and byte-index syntax call the typed static-rec app
  route with `Text` context before reporting collection/index fallback
  diagnostics, so direct rec text results no longer require an intermediate
  annotated binding.
- Direct text consumers now also pass `Text` context through safe inlineable
  non-rec helper calls. Unannotated identity-style helpers and simple callable
  block aliases can feed `len(...)`, `get(...)`, and byte-index syntax as text
  pointers, while arithmetic helper bodies such as `value + 1` still reject with
  the normal collection diagnostic instead of becoming `load(value + 1)`.
- Call-only runtime lambda bindings can now defer immediate Ic lowering when the
  only blocker is an untyped dynamic branch that a later inline call can lower
  with caller-supplied `Text` context. Direct `len(choose(flag))`,
  `get(choose(flag), index)`, and `choose(flag)[index]` work for helpers whose
  body returns a text branch, while escaping or data-aliasing the helper still
  keeps the original dynamic-branch rejection.
- The call-only text-helper path also covers no-else dynamic text branches.
  Direct text consumers now provide the `Text` context needed to synthesize the
  empty fallback for `flag => if flag { input }`, but no-else numeric helper
  bodies and non-call uses remain rejected instead of guessing a type.
- Non-`Text` typed consumers now share an app-as-type hook that tries static-rec
  first, then inlineable non-rec helper calls. This lets numeric operands,
  annotated struct bindings, and annotated union bindings lower call-only
  dynamic-branch helpers through the caller-provided expected type instead of
  leaking free helper applications into Ic. `Text` stays on the stricter
  text-consumer proof path.
- Runtime struct type resolution now uses the same inlineable helper app-result
  inference. Direct text consumers over helper-built struct fields, including
  nested fields, can infer declared `Text` field types and lower through the
  existing runtime text pointer path; mixed non-struct helper branches still
  reject instead of inventing field facts.
- Direct `if let` results over inlineable helper-built unions now preserve
  struct-payload field facts through later projection. This covers scalar
  payload fields, `Text` payload fields consumed by `len`, and `Text` payload
  fields consumed by `get`, while numeric/struct result mismatches continue to
  reject before collection lowering.

## Locked Defaults

- Dynamic loops, memory-backed aggregates, and effectful capabilities remain
  Core/Wasm-only. The Ic path stays pure and graph-oriented.
- Runtime heap aggregates are unique by default.
- `borrow expr` creates a read-only view with block, loop-iteration, function
  call, or scratchpad-bounded lifetime.
- `freeze expr` consumes a unique value and produces immutable shareable data.
- `scratch { ... }` is a temporary arena scope with a return value, not a
  general ownership container.
- Scratch-backed values cannot escape unless they are scalar, already
  frozen/shareable, proven scratch-free, or explicitly frozen/promoted before
  the scratch reset.
- Optional longer-lived regions are future explicit owner packages. Returned
  values tied to such a region must carry the region owner, lifetime facts,
  cleanup/drop facts, and move/consume rules; ordinary `scratch {}` does not
  grow an attached live region.
- If scratch escape analysis, temporary cleanup, or region lifetime analysis is
  hard or uncertain, split the case into smaller proof fixtures or reject before
  WAT emission. Do not add a GC fallback to the default backend.
- Cleanup for lowering-created temporaries must be inserted from ownership and
  lifetime facts before WAT emission.
- Do not create a baseline collector task to rescue hard analysis cases. Split
  broad memory work by storage class and escape path until each slice is
  accepted with proof rows, rejected with a named missing fact, or deferred to
  an explicit future region/managed-storage profile.
- The active proof work is unique ownership, lexical borrow/views,
  frozen/shareable values, value-returning scratchpads with reset,
  storage-driven linear participation, and cleanup insertion for source values
  plus compiler-created temporaries.
- A future managed-storage or Wasm-GC backend may use collector-managed values,
  but that is a separate explicit target from the baseline linear-memory
  backend.
- Scratch pointer reset must be emitted on every structured exit edge.
- Unique heap drop points should be computed even if the initial bump allocator
  makes them runtime no-ops.
- The first capability ABI should use direct Wasm imports per method.
- Keep the hybrid aggregate model: scalarize static/known aggregates and
  allocate only runtime/escaping aggregates.

## Latest Memory/Lifetime Task Update

The selected baseline is now fixed as static no-GC analysis for `core-3-nonweb`.
Do not add a collector task to make uncertain scratch, temporary, aggregate,
union, text, closure, borrow, or host-boundary cases work. The compiler must
prove storage, lifetime, borrow/view, scratch escape, freeze/promotion, and
cleanup facts for source values and compiler-created temporaries before WAT
emission. If a case is hard, split it into a narrower proof fixture, reject it
before WAT emission with a named missing fact, or defer it to a future explicit
region/managed-storage profile. In other words, "skip GC if the analysis can be
made proper" means the accepted baseline work is to make the analysis proper;
GC, managed storage, or hidden attached regions are not fallback states for an
unproven `core-3-nonweb` shape.

The implementation work should be tracked as these concrete slices:

1. `ownership_fact_inventory`
   - Classify every non-scalar source value and lowering-created temporary as
     `unique_heap`, `borrow_view`, `frozen_shareable`, or `scratch_backed`
     unless it is a `scalar_local`.
   - Record owner id, lifetime id, origin, escape decision, and
     cleanup/drop/reset/transfer decision.
   - Thread the same rows through text buffers, aggregate fields, union
     payloads, closure environment slots, host-boundary marshaling, and
     compiler-created helper temporaries.
   - Add an audit fixture for each currently accepted WAT-emitting memory
     feature before broadening codegen.

2. `borrow_view_lifetimes`
   - Keep `borrow value` and `let view = borrow value` as runtime-free lexical
     views.
   - Reject owner move, mutation, freeze, transfer, return, escaping capture, or
     unknown host-boundary use while a view is live.
   - End view lifetimes at explicit block, function-call, loop-iteration, and
     scratchpad boundaries only when no escaping reference remains.
   - Preserve borrowed field and payload projections as views tied to the
     original owner, not as independent owners.

3. `scratch_result_proofs`
   - Lower `scratch { ... }` as saved-pointer plus reset on every exit edge.
   - Check the return value before reset. Accept only scalar,
     `frozen_shareable`, explicitly frozen/promoted, or transitively
     scratch-free results.
   - Reject raw scratch-backed text, aggregate, union payload, or closure
     environment escapes.
   - Prove scratch-freeness recursively through returned fields, union payloads,
     nested closures, and block-local aliases.
   - Treat `scratch {}` as the share-friendly temporary computation tool for the
     MVP; do not model it as an attached region that keeps allocations alive
     after reset.

4. `freeze_and_promotion_edges`
   - Make `freeze value` the explicit boundary from unique ownership to
     immutable shareable storage.
   - Make scratch-to-persistent promotion an explicit Core copy before the
     scratch reset.
   - Allow frozen/shareable values to be copied freely after the edge; require
     unique or scratch-backed values to prove the edge before sharing or
     escaping.
   - Keep promotion visible in proof rows even when an optimization can later
     reuse storage.

5. `temporary_cleanup_rows`
   - Insert cleanup/drop/reset/transfer/no-cleanup rows for source values and
     compiler-created temporaries before WAT emission.
   - Cover text operations, aggregate materialization, union payload
     construction, closure environment setup, host marshaling, and promotion
     copies.
   - Insert cleanup for temporaries from ownership facts during Core
     elaboration, not as a late WAT-emitter guess.
   - If cleanup is hard to prove, split the case by temporary origin and escape
     shape or reject before WAT emission.

6. `storage_driven_linear_analysis`
   - Reuse exact-use/path-sensitive machinery for source `!` capabilities,
     unique owners, active borrow barriers, scratch-backed values, and
     ownership-bearing closure slots.
   - Keep scalar locals and frozen/shareable values freely copyable.
   - Apply linear participation because of storage/effect facts, not because
     every non-scalar value is globally linear.
   - Keep capability tokens unique and non-freezable; ordinary data can become
     shareable only through explicit frozen/shareable facts.

7. `future_region_owner_packages`
   - Keep longer-lived regions out of ordinary `scratch {}`.
   - A future region feature must return or carry an explicit region owner with
     tied value lifetimes, cleanup/drop facts, move/consume rules, ABI rules,
     and host-boundary rules.
   - Model optional regions as explicit owner packages separate from the
     baseline scratchpad feature. Values tied to the region may escape only by
     moving with that owner package or by freezing/promoting out of it.

8. `no_gc_wat_gate`
   - Add a final pre-WAT proof gate for `core-3-nonweb` that requires
     `managed_storage: "disabled"` plus complete storage, lifetime, escape,
     borrow, freeze/promotion, and cleanup rows.
   - Reject missing proof rows with diagnostics that name the first missing
     edge, such as active borrow, scratch-backed return, missing promotion,
     unknown host-boundary ownership, or missing temporary cleanup.
   - Keep tracing GC, Wasm-GC, reusable arenas, and managed storage as future
     explicit profiles only. They must not repair baseline proof gaps.

Every slice above should land with one accepted proof fixture that keeps
`managed_storage: "disabled"` visible, one nearby rejected fixture that names
the first missing proof edge, and no broadened WAT emission until those fixtures
exist.

Latest refinement from the memory discussion:

- Treat `scratch {}` as the active MVP region-like construct, but only as a
  lexical scratchpad for temporary computation. It returns a value, then resets;
  the returned value must be proven independent of scratch storage, frozen,
  promoted, or scalar before the reset edge is accepted.
- Do not model ordinary `scratch {}` as an attached region that keeps returned
  values alive. Region-return packages remain a future feature with explicit
  region owners, tied lifetimes, cleanup/drop facts, move/consume rules, ABI
  rules, and host-boundary rules.
- Make cleanup insertion the baseline answer for source values and
  lowering-created temporaries. Cleanup rows come from ownership/lifetime facts
  during Core elaboration; WAT emission should consume those rows, not infer
  lifetimes late.
- Skip GC in the default backend by completing analysis for the accepted
  surface. If a case cannot be proven, split it by storage class, temporary
  origin, and escape path, then either add accepted/rejected proof fixtures or
  defer it to an explicit future region/managed-storage profile.
- Keep linear analysis fact-driven. Source `!` capabilities, unique owners,
  active borrow barriers, scratch-backed values, and ownership-bearing closure
  slots participate in exact-use/path-sensitive checks; scalar locals and
  frozen/shareable values remain copyable.

First fixture queue from this decision:

1. `borrow_view_lifetimes`
   - Accepted: direct owner views, field views, payload views, branch-local
     views, loop-local views, and bounded host-import borrows that remain inside
     the lexical lifetime.
   - Rejected: owner mutation, move, freeze, transfer, return, escaping closure
     capture, and unknown host-boundary passage while a view is live.

2. `scratch_result_proofs`
   - Accepted: scalar results, already `frozen_shareable` results, explicit
     freeze/promotion before reset, and transitively scratch-free aggregate,
     union, and closure-environment results.
   - Rejected: raw `scratch_backed` text, aggregate fields, union payloads,
     closure environment slots, or nested field/payload paths leaving the
     scratchpad without promotion or proof.

3. `temporary_cleanup_rows`
   - Accepted: cleanup/drop/reset/transfer/no-cleanup rows for source owners and
     compiler-created temporaries from text operations, aggregate
     materialization, union payload construction, closure environment setup,
     host marshaling, and promotion copies.
   - Rejected: any accepted WAT path whose source owner or lowering temporary
     has no visible cleanup/drop/reset/transfer/no-cleanup decision.

4. `freeze_and_promotion_edges`
   - Accepted: explicit unique-to-frozen and scratch-to-persistent Core copy
     edges for text bytes, aggregate fields, union payloads, closure environment
     slots, and nested field/payload paths.
   - Rejected: implicit sharing, implicit scratch escape, or WAT-emitter repair
     for a missing copy edge.

5. `future_region_owner_packages`
   - Deferred only: explicit region-owner packages with tied returned-value
     lifetimes, cleanup/drop facts, move/consume rules, ABI rules, and
     host-boundary rules.
   - Baseline rejection: ordinary `scratch {}` must not synthesize this package
     or keep allocations alive after reset.

6. `storage_driven_linear_analysis`
   - Accepted: exact-use/path-sensitive checks only for source `!` capabilities,
     unique owners, active borrow barriers, scratch-backed values, and
     ownership-bearing closure slots.
   - Non-linear: scalar locals and frozen/shareable values stay copyable.

7. `no_gc_wat_gate`
   - Accepted: complete unmanaged proof rows for the source/Core shape before
     WAT emission.
   - Rejected: missing storage, lifetime, borrow, scratch, promotion,
     host-boundary, or cleanup facts; no GC or managed-storage fallback is
     selected by the default backend.

## Latest Closure Ownership Module Handoff

Core closure ownership planning has been partially split. Shared plan, hook,
capture-slot, and fact shapes live in `src/core/closure_ownership/types.ts`.
Nested closure value containment scanning now lives in
`src/core/closure_ownership/contains.ts`; this module owns the read-only Core
expression/statement walk used to decide whether a scratch-backed capture is
still an immediate non-escaping closure call shape. Local borrow-view and
scratch-backed ownership fact tracking now lives in
`src/core/closure_ownership/facts.ts`, and capture allow/reserved decisions now
live in `src/core/closure_ownership/decision.ts`. Statement/expression
traversal, block/scratch/direct-call fact threading, local collection probes,
and closure ownership edge recording now live in
`src/core/closure_ownership/scan.ts`. `src/core/closure_ownership.ts` remains
the public planning facade.

## Latest Runtime Text Module Handoff

Core runtime text emission has been partially split. Shared heap/context and
hook shapes live in `src/core/runtime_text/types.ts`. Temporary plan builders
and local declarations for concat, equality, slice, and byte assignment now live
in `src/core/runtime_text/plan.ts`. Byte-copy loop emission for concat and
slice/freeze-copy now lives in `src/core/runtime_text/copy.ts`. Scratch-vs-
closure heap selection lives in `src/core/runtime_text/alloc.ts`. Runtime text
concat/append emission lives in `src/core/runtime_text/concat.ts`, equality
emission lives in `src/core/runtime_text/eq.ts`, slice/freeze-copy emission
lives in `src/core/runtime_text/slice.ts`, and length/byte-index/byte-assignment
emission lives in `src/core/runtime_text/access.ts`. `src/core/runtime_text.ts`
remains the public facade and re-exports operation and plan APIs for backend,
local-collection, and aggregate/union freeze-copy callers.

## Latest Index Assignment Module Handoff

Core index-assignment support has been partially split.
`src/core/index_assign/types.ts` owns the shared context, hook, plan, and
statement shapes. Static aggregate rebuild planning/emission now lives in
`src/core/index_assign/static.ts`. Runtime aggregate checked-store planning,
field-kind validation, dynamic branch-chain emission, and nested aggregate store
emission now live in `src/core/index_assign/runtime_aggregate.ts`.
`src/core/index_assign.ts` remains the public facade for backend index adapters,
local collection, statement emission, and proof callers.

## Latest Expression Emit Module Handoff

Core expression-level WAT emission has been partially split. Shared
expression-emission context and hook shapes now live in
`src/core/expr_emit/types.ts`. Scratch and freeze lifetime emission helpers,
including persistent freeze materialization/copy decisions and unsafe scratch
return diagnostics, now live in `src/core/expr_emit/lifetime.ts`. Freeze
expression dispatch now lives in `src/core/expr_emit/freeze.ts`, and scratch
expression dispatch now lives in `src/core/expr_emit/scratch.ts`.
`src/core/expr_emit.ts` remains the public expression-emission facade and owns
the remaining main expression dispatch.

## Latest Runtime Aggregate Module Handoff

Core runtime aggregate support has been partially split. Runtime aggregate
layout construction, `RuntimeAggregateField` / `RuntimeAggregateLayout` shapes,
field lookup, nested field base-offset calculation, and static struct-type
equality now live in `src/core/runtime_aggregate/layout.ts`. Aggregate type
discovery, branch-call result typing, block-result alias typing, nested field
access, and `runtime_aggregate_field_info` now live in
`src/core/runtime_aggregate/type_expr.ts`. Shared temp/local, emit-context, and
hook shapes live in `src/core/runtime_aggregate/types.ts`, temp-local planning
and local declaration live in `src/core/runtime_aggregate/plan.ts`, runtime
aggregate value and field load/pointer emission live in
`src/core/runtime_aggregate/emit.ts`, and aggregate freeze-copy support lives in
`src/core/runtime_aggregate/freeze_copy.ts`. `src/core/runtime_aggregate.ts`
remains the public compatibility facade.

## Latest Runtime Union Emit Handoff

Core runtime union emission has been partially split. Runtime union freeze-copy
support, including supported-payload checks, local declaration for nested
text/aggregate/union payload copies, recursive payload copy emission, nested
aggregate payload freeze-copy bridging, and text payload freeze-copy from WAT,
now lives in `src/core/runtime_union/freeze_copy.ts`. Shared runtime-union emit
context and hook shapes now live in `src/core/runtime_union_emit/types.ts`.
Materialized runtime-union value emission, union-case allocation,
scratch-vs-persistent heap selection, and materialized-value local collection
now live in `src/core/runtime_union_emit/value.ts`. Runtime-union `if let`
statement/expression emission now lives in
`src/core/runtime_union_emit/if_let.ts`. `src/core/runtime_union_emit.ts`
remains the public compatibility facade and re-exports the freeze-copy API for
existing callers.

## Latest Static Union Module Handoff

Core static union support is split behind the public `src/core/union_static.ts`
facade. Shared context and hook types live in `src/core/union_static/types.ts`;
type-field lookup lives in `src/core/union_static/field.ts`; scoped static-call
resolution lives in `src/core/union_static/static_call.ts`; static union
case/type discovery lives in `src/core/union_static/static_case.ts`; dynamic
union-if discovery and case matching live in
`src/core/union_static/dynamic_if.ts`; and dynamic `if let` payload binding plus
local-fact updates live in `src/core/union_static/payload.ts`.

## Latest Static Values Module Handoff

Core static-value support is split behind the public `src/core/static_values.ts`
facade. Shared contracts live in `src/core/static_values/types.ts`, recognition
lives in `src/core/static_values/recognition.ts`, scratch-free analysis lives in
`src/core/static_values/scratch_free.ts`, capture planning plus frozen/source
fact tracking lives in `src/core/static_values/capture.ts`, static struct
planning lives in `src/core/static_values/struct.ts`, and the remaining
dispatch, scratch/block, union, and branch planning lives in
`src/core/static_values/plan.ts`.

## Latest Ic Graph Reducer Handoff

The Ic graph reducer has started splitting read-only graph inspection helpers
away from the rewrite engine. Graph snapshot serialization now lives in
`src/ic/graph_reduce/dump.ts`; it owns graph reachability ordering, node text
formatting, child-reference discovery, and ref formatting for reducer debug
snapshots. Name/ref traversal now lives in `src/ic/graph_reduce/scan.ts`; it
owns structural name lookup, name-use counting, and ref containment checks used
by substitution, duplication cleanup, and cycle guards. Deterministic fresh-name
generation and source-name collection now live in
`src/ic/graph_reduce/names.ts`. Graph-to-Ic materialization now lives in
`src/ic/graph_reduce/materialize.ts`; it owns cycle-checked conversion from
reduced graph refs back to Ic nodes. Graph node cloning, replacement, and
numeric-node conversion now live in `src/ic/graph_reduce/node.ts`. Graph context
construction, allocation accounting, reduction statistics, and Ic-to-graph
construction now live in `src/ic/graph_reduce/context.ts`. Structural erasure
rewriting now lives in `src/ic/graph_reduce/erase.ts`, and graph substitution
now lives in `src/ic/graph_reduce/substitute.ts`. Rewrite orchestration,
active-pair rules, primitive/select propagation, and graph reduction recursion
now live in `src/ic/graph_reduce/reduce.ts`. `src/ic/graph_reduce.ts` remains
the public reducer/debug facade for Ic entrypoints and graph snapshots.

## Latest Ic Open-Term Handoff

The Ic open-term Wasm bridge has been split into focused modules. Non-recursive
open-term parameter inference now lives in `src/ic/open_term/infer.ts`; it owns
explicit parameter typing, open variable discovery/order, primitive
argument/result typing, duplication projection typing, and unreduced-Ic
rejection diagnostics for the plain open-term bridge. Recursive fixpoint module
assembly stays in `src/ic/open_term/recursive.ts`, while recursive function/main
type inference and parameter materialization live in
`src/ic/open_term/recursive/infer.ts`, recursive body/local/alias WAT emission
lives in `src/ic/open_term/recursive/emit.ts`, shared app and memory-primitive
helpers live in `src/ic/open_term/recursive/shared.ts`, and the recursive bridge
state shapes live in `src/ic/open_term/recursive/types.ts`.
`src/ic/open_term.ts` remains the public `Ic.mod`/`Ic.wat` facade for option
handling, recursive bridge dispatch, the reduced Ic to Expr fallback path, and
data/memory wiring.

## Latest Cleanup Module Handoff

Core cleanup planning has been partially split. Scratch reset exit-edge
discovery now lives in `src/core/cleanup/exit_edges.ts`; this module owns the
read-only Core expression/statement walk that turns a `scratch {}` body into
ordered `fallthrough`, `return`, `break`, and `continue` reset edges.
`src/core/cleanup.ts` re-exports `core_scratch_exit_edges` and
`CoreCleanupExitEdge` for existing borrow/lifetime callers and remains the
cleanup-plan facade for scratch reset steps, scratch-return ownership, and
scratch-return rejection details.

## Latest Allocation Module Handoff

Core allocation planning has been partially split. Shared allocation
plan/fact/hook/state/scope types live in `src/core/allocation/types.ts`,
allocation fact deduplication and ownership classification live in
`src/core/allocation/record.ts`, and scoped static-call allocation helper
detection lives in `src/core/allocation/static_call.ts`. Freeze/promotion
allocation predicates and aggregate/union freeze-copy allocation traversal now
live in `src/core/allocation/freeze.ts`. Static-value allocation scanning for
static structs, runtime-union owner materialization, and static-union payload
recursion lives in `src/core/allocation/static_value.ts`; it receives explicit
expression and field scanner callbacks from `src/core/allocation/scan.ts`
instead of importing the traversal module back. Runtime-union allocation
recording for direct union cases and branch-shaped runtime-union values lives in
`src/core/allocation/runtime_union.ts`; it receives an explicit expression
scanner callback for payload/type traversal. If-let branch-context allocation
scanning now lives in `src/core/allocation/if_let.ts`; it receives explicit
expression and statement scanner callbacks from `src/core/allocation/scan.ts`
instead of importing the traversal module back. Block-expression allocation
traversal now lives in `src/core/allocation/block.ts`; it owns block context
creation and statement-local collection while receiving root statement scanner
callbacks. Closure-body allocation traversal now lives in
`src/core/allocation/closure.ts`; it owns closure body context selection and
closure allocation-scope naming while receiving the root expression scanner
callback.

General statement/expression allocation traversal now lives in
`src/core/allocation/scan.ts`. `src/core/allocation.ts` remains the public
planner facade. Future splits should move one coherent scanner concern at a
time.

## Latest Transfer Module Handoff

Core ownership-transfer validation has been partially split. Transfer edge,
validation issue, hook, function target, and scanner state types live in
`src/core/transfer/types.ts`. State cloning, branch merging, conditional
transfer cleanup diagnostics, scope naming, issue deduplication, and edge text
live in `src/core/transfer/state.ts`. Static transfer function discovery,
branch-function target derivation, and parameter extraction live in
`src/core/transfer/static_function.ts`. Ownership-transfer alias tracking,
argument ownership caching, unique-argument validation, invalid wrapper-argument
diagnostics, and owner resolution live in `src/core/transfer/ownership.ts`.
Static-call transfer wrapper traversal, temporary argument aliasing,
higher-order const function aliases, and recursive branch-target scanning live
in `src/core/transfer/static_call.ts`; it receives the root expression scanner
as an explicit callback to avoid cyclic coupling. Runtime union payload
owner-transfer detection, payload ownership checks, and delegation to the common
transfer recorder live in `src/core/transfer/union_payload.ts`. Common transfer
edge creation, unique-transfer validation calls, transferred-owner state
updates, and use-after-transfer issue construction live in
`src/core/transfer/record.ts`. Conditional statement/expression traversal,
loop-body transfer merging, and `if let` branch-context binding live in
`src/core/transfer/branch.ts`; it receives root expression and statement scanner
callbacks to avoid cyclic coupling. Direct host/import ownership-transfer
argument scanning lives in `src/core/transfer/host_call.ts`.

General statement/expression transfer traversal now lives in
`src/core/transfer/scan.ts`. `src/core/transfer.ts` remains the public
validation facade. Future splits should move one coherent scanner concern at a
time.

## Latest Host-Boundary Module Handoff

Core host/import boundary proof scanning has been partially split. Boundary
plan, edge, argument, hook, state, closure-context, and static wrapper target
types live in `src/core/host_boundary/types.ts`. Ownership contract decisions,
unknown-boundary diagnostics, and ownership-transfer detection live in
`src/core/host_boundary/decision.ts`. Alias tracking, shadowed-parameter alias
scopes, scratch-local ownership classification, and host-boundary argument
ownership resolution live in `src/core/host_boundary/alias.ts`. Static
wrapper-call traversal, wrapper target discovery, wrapper recursion guards,
wrapper-depth handling, and wrapper definition filtering now live in
`src/core/host_boundary/static_call.ts`. Closure-body host-boundary scanning now
lives in `src/core/host_boundary/closure.ts`; it owns const-parameter skip
checks, closure body context selection, and shadowed parameter aliases while
receiving the root expression scanner callback. Application host-boundary
scanning and edge construction now live in `src/core/host_boundary/app.ts`; it
owns function-alias application scanning, branch/static wrapper dispatch,
known-Core-call filtering, host import signature lookup, argument decision rows,
and edge id allocation while receiving the root expression scanner callback.

`src/core/host_boundary.ts` remains the scanner/orchestration module for generic
expression/statement traversal and local collection. Future splits should move
one scanner concern at a time.

## Latest Backend Graph Handoff

Core backend graph assembly is partially split. The public entrypoint facade
remains `src/core/backend/graph.ts`, while graph construction lives under
`src/core/backend/graph/` for analysis, emission, entry, runtime, and value
services. Unsupported-codegen proof conversion lives in
`src/core/backend/graph/proof_unsupported.ts`. Read-only unsupported-codegen
support predicates now live in `src/core/backend/graph/proof_support.ts`; it
owns the collection-loop, index-assignment, type-value, app, field, index, and
`if let` gates used by baseline proof assembly. Drop-analysis static-value
discovery now lives in `src/core/backend/graph/drop_static.ts`; it owns
type-level values, text values, frozen static structs, closure values, ownerless
branch values, and block-shaped static expressions for drop-analysis contexts.
Baseline no-GC proof assembly and host-boundary proof entrypoints now live in
`src/core/backend/graph/baseline_proof.ts`; it owns the final proof-plan
orchestration that combines final-result escape, borrow validation, cleanup,
closure ownership, allocation, drop, freeze, host-boundary, transfer, lifetime,
and unsupported-codegen rows. Drop/borrow proof-context collection now lives in
`src/core/backend/graph/drop_context.ts`; it owns freeze-consumption-aware local
collection and closure-valued local recognition for proof contexts. Unsafe
scratch-return proof binding and probe diagnostics now live in
`src/core/backend/graph/drop_scratch.ts`. Closure-body, collection-loop,
runtime-union match, and `if let` branch proof-context construction now lives in
`src/core/backend/graph/proof_context.ts`. Ownership/proof hook construction now
lives in `src/core/backend/graph/proof_hooks.ts`; it owns the shared ownership
hooks, static-call proof hooks, allocation hooks, closure-ownership hooks,
closure body context adapters, runtime-aggregate ownership probe helper, and
final-expression ownership helper.

`src/core/backend/graph.ts` still owns backend-bound wrapper functions and
public backend entrypoints. Future backend graph splits should move one coherent
concern at a time.

## Latest Proof Module Handoff

Core proof assembly is split behind the public `src/core/proof.ts` facade.
Unsupported-codegen scanning lives in `src/core/proof/unsupported.ts`,
freeze-proof traversal lives in `src/core/proof/freeze.ts`, baseline no-GC proof
issue assembly lives in `src/core/proof/baseline.ts`, proof checking lives in
`src/core/proof/check.ts`, and shared proof target/issue/input/output types live
in `src/core/proof/types.ts`. Future proof work should add new proof rows or
diagnostic conversions in those modules instead of expanding the facade.

## Latest Source-To-Core Module Handoff

Source-to-Core lowering has been partially split. `src/core/from_source.ts`
remains the public program-level facade that builds host imports and top-level
Core statements. Context/name/type-owner tracking lives in
`src/core/from_source/context.ts`, host import argument/result contract
conversion lives in `src/core/from_source/host_import.ts`, recursive-tail
validation lives in `src/core/from_source/rec.ts`, statement lowering,
carried-name discovery, recursive binding lowering, and source `if`-block
statement conversion now live in `src/core/from_source/stmt.ts`, and expression
lowering plus host-import method-call rewriting now lives in
`src/core/from_source/expr.ts`.

## Latest Ic Reducer Handoff

The direct IC reducer has been partially split. `src/ic/reduce.ts` remains the
public top-level reducer and owns pseudo-trait dispatch plus the active-pair
rewrite rules for primitive calls, lambdas, applications, superpositions,
duplications, erasures, DUP-SUP, and DUP-LAM. Fresh-name context construction
and initial name collection live in `src/ic/reduce/context.ts`, structural
erasure expansion lives in `src/ic/reduce/erase.ts`, primitive superposition
spreading lives in `src/ic/reduce/prim_spread.ts`, and substitution plus
name-use counting live in `src/ic/reduce/substitute.ts`.

## Latest Type-Static Module Handoff

Core static type-value support has been partially split.
`src/core/type_static.ts` remains the public compatibility facade for static
type-value APIs. The shared context shape lives in
`src/core/type_static/types.ts`, builtin type-name and Wasm value-type helpers
live in `src/core/type_static/names.ts`, static single-statement block result
probing lives in `src/core/type_static/block.ts`, type-constructor substitution
across Core expressions/statements/patterns lives in
`src/core/type_static/substitute.ts`, and static type/function/value resolution
plus type-constructor call evaluation lives in `src/core/type_static/value.ts`.

## Latest Frontend Lower-Graph Handoff

Frontend-to-Ic lower-graph assembly is split further. The public lowerer root
remains `src/frontend/lower_graph.ts`, while lazy lower/eval/prepare/infer and
`if`/`if let` bridge wrappers live in `src/frontend/lower_graph/bridge.ts`.
Union/struct value hook wiring, dynamic branch hooks, struct-value hooks, and
delayed value-graph construction now live in
`src/frontend/lower_graph/value.ts`. Expression/program/static-rec hook
composition, call-graph construction, and index-assignment hook threading now
live in `src/frontend/lower_graph/program.ts`.

`src/frontend/lower_graph.ts` still owns the top-level dependency graph and the
environment-sensitive callbacks that tie const evaluation, annotations,
static-rec lowering, text lowering, static loops, and struct/runtime aggregate
resolution together. Future frontend lower-graph splits should move one coherent
wiring concern at a time and keep the lazy self-references explicit.

## Latest Frontend Struct-Values Handoff

Frontend struct-value support is split behind the public
`src/frontend/struct_values.ts` facade. Declared struct validation, type-value
resolution, object-field inference, and declared field-type discovery remain in
`src/frontend/struct_value_type.ts`. Shared hook and target types live in
`src/frontend/struct_values/types.ts`; pure struct-update rebuilds live in
`src/frontend/struct_values/update.ts`; handler-encoded struct-value Ic lowering
lives in `src/frontend/struct_values/lower.ts`; and frontend-known struct-value
resolution, including wrappers, static calls, blocks, field/index projections,
bindings, and dynamic struct branch hooks, lives in
`src/frontend/struct_values/resolve.ts`. The update helper receives the resolver
callback explicitly so update and resolution can stay decoupled.

## Latest Frontend Eval Handoff

Frontend compile-time evaluation is split behind the public
`src/frontend/eval.ts` facade. Shared hook and resolved-union shapes live in
`src/frontend/eval/types.ts`. Expression-value evaluation, including `comptime`,
const-call, deferred-call, visible-text primitive, field, and index resolution,
lives in `src/frontend/eval/value.ts`. Statement/block evaluation, including
const/let binding, assignment, index assignment, static loop expansion, static
`if`, static `if let`, type checks, and module-level diagnostics, lives in
`src/frontend/eval/block.ts`. Simple block foldability and non-foldable
diagnostic filtering live in `src/frontend/eval/simple.ts`.

The facade keeps the mutual recursion between value and block evaluation
explicit by passing recursive callbacks into the helper modules. Future eval
work should add new compile-time source forms to the focused helper that owns
the construct, and keep the exported `eval_front_value`, `eval_front_block`, and
`eval_simple_front_block` entrypoints stable.

## Latest Frontend Static-Loop Fallback Handoff

Frontend dynamic-loop-control fallback synthesis is split under
`src/frontend/static_loop/fallback/`. The public fallback dispatcher remains
`src/frontend/static_loop/fallback.ts`. Aggregate value fallback entrypoints
remain in `src/frontend/static_loop/fallback/aggregate.ts`, while declared
struct field typing lives in `src/frontend/static_loop/fallback/field.ts`,
guarded struct/union value construction lives in
`src/frontend/static_loop/fallback/guarded.ts`, recursive type-name fallback
construction lives in `src/frontend/static_loop/fallback/type_fallback.ts`,
typed fallback environment setup lives in
`src/frontend/static_loop/fallback/typed_env.ts`, and shared fallback target and
binding callback shapes live in `src/frontend/static_loop/fallback/types.ts`.

Future static-loop fallback work should add new skipped-step fallback shapes to
the focused module that owns the construct. Keep `aggregate.ts` as the public
aggregate fallback facade so `src/frontend/static_loop/fallback.ts` does not
need to know the internal recursive type/guarded-value helpers.

## Latest Frontend Static-Rec Block Handoff

Frontend static-rec block traversal is split behind `src/frontend/rec_block.ts`.
Shared recursive lowerer callback types live in
`src/frontend/rec_block/types.ts`. Binding, assignment, index-assignment, and
deferred binding classification live in `src/frontend/rec_block/binding.ts`.
Static-rec `if` and `if let` statement dispatch, including dynamic union
fallback construction and static matched-case payload binding, lives in
`src/frontend/rec_block/branch.ts`.

`src/frontend/rec_block.ts` remains the public block traversal entrypoint and
owns expected-type block alias probing, statement iteration, static loop
expansion, terminal `break`/`continue` diagnostics, unresolved import
diagnostics, and the explicit recursive `block_lowerer` callback. Future
static-rec statement work should add handlers to the focused module that owns
the statement family and keep recursive lowering through the callback instead of
creating import cycles.

## Latest Frontend Static-Rec Inference Handoff

Frontend static-rec result inference is split behind
`src/frontend/rec_infer.ts`. The facade owns expression-level dispatch and
delegates field/index result typing to `src/frontend/rec_infer/access.ts`.
Statement and block inference, including static loop expansion, binding,
assignment, index-assignment, static `if`, and static/typed `if let`
continuation typing, lives in `src/frontend/rec_infer/block.ts`. Shared
recursive inference callback typing lives in `src/frontend/rec_infer/types.ts`,
keeping the submodules decoupled from the facade and avoiding import cycles.

## Latest Frontend Parser Handoff

Frontend parser expression handling is split further. Primary expressions,
reserved unsupported-expression consumption, and balanced extension-object text
consumption live in `src/frontend/parser_primary.ts`. Expression arrow,
closure-body, binary precedence, unary, and postfix parsing remain in
`src/frontend/parser_expr.ts`. Program and statement parsing now live in
`src/frontend/parser_stmt.ts`, leaving `src/frontend/parser.ts` as the public
`parse_source(...)` facade. Binding/import statement helpers live in
`src/frontend/parser_stmt/binding.ts`, and statement-level `if`/`if let`/`for`
parsing lives in `src/frontend/parser_stmt/control.ts`.

Future parser splits should keep token-cursor mechanics in
`src/frontend/parser_cursor.ts`, aggregate field/type-pattern parsing in
`src/frontend/parser_aggregate.ts`, conditional expression parsing in
`src/frontend/parser_conditional.ts`, primary atoms in
`src/frontend/parser_primary.ts`, precedence/postfix expression assembly in
`src/frontend/parser_expr.ts`, statement dispatch in
`src/frontend/parser_stmt.ts`, binding/import statements in
`src/frontend/parser_stmt/binding.ts`, and statement control flow in
`src/frontend/parser_stmt/control.ts`.

## Latest Frontend Builtin-Call Handoff

Frontend pure-Ic builtin call lowering is split behind the public
`src/frontend/builtin_call.ts` facade. The facade owns the shared hook contract,
`fail`/`panic` dispatch, fallback compile-time builtin evaluation, and
frontend-known linear method calls. Text and index builtins, including `len`,
`get`, `slice`, and `append`, dispatch through
`src/frontend/builtin_call/text.ts`; read/index builtins live in
`src/frontend/builtin_call/text_read.ts`, and text-producing operation builtins
live in `src/frontend/builtin_call/text_ops.ts`.

Future builtin work should add new builtin families under
`src/frontend/builtin_call/` and keep `src/frontend/builtin_call.ts` as the
stable dispatcher used by expression lowering.

## Latest Frontend Statement Handoff

Frontend pure-Ic statement lowering is split behind the public
`src/frontend/stmt.ts` facade. The facade owns the top-level statement sequence
dispatch, unresolved import/host-import diagnostics, type-check statements,
`break`/`continue`/`return` routing, and binding delegation. Binding,
assignment, index-assignment, recursive/runtime binding, call-only deferral, and
linear containment remain in the existing `src/frontend/stmt/` helpers.

Static loop expansion dispatch, static/dynamic `if` statement lowering,
static/dynamic `if let` statement lowering, expression-statement erasure,
compile-time-only expression skipping, and block-statement continuation handling
now live in `src/frontend/stmt/control.ts`. The control helper receives the
recursive `LowerStatementsWithDone` callback explicitly, so it can lower nested
continuations without importing the facade or creating cyclic coupling.

## Latest Frontend Format Handoff

Frontend source formatting is split behind the public `src/frontend/format.ts`
facade. The facade keeps `format_source(...)` and exported `format_expr(...)`
stable for `Source.fmt`, diagnostics, and helper modules that need expression
text.

Statement formatting now lives in `src/frontend/format/stmt.ts`, expression
formatting lives in `src/frontend/format/expr.ts`, shared field/type-pattern and
parameter helpers live in `src/frontend/format/common.ts`, host-import signature
formatting lives in `src/frontend/format/host_import.ts`, and primitive display
symbols live in `src/frontend/format/prim.ts`. The statement and expression
helpers receive formatter callbacks where they need mutual recursion, keeping
the helpers decoupled from the facade and from each other.

## Latest Frontend Ic-Share Handoff

Frontend pure-Ic sharing helpers are split behind the public
`src/frontend/ic_share.ts` facade. The facade keeps the existing exported
helpers stable: `lower_bound_value`, `lower_lambda_binding`, and
`share_free_variables`.

Runtime binding and lambda binding lowering live in
`src/frontend/ic_share/binding.ts`. Free-name and named-use counting live in
`src/frontend/ic_share/count.ts`. Top-level free-variable sharing lives in
`src/frontend/ic_share/free.ts`. Deterministic sharing plan construction,
share-label assignment, and replacement of each name use with share leaves live
in `src/frontend/ic_share/share.ts`. Future graph-sharing work should keep
affine use counting separate from duplication-plan construction so lowering
callers can depend on the facade without pulling in traversal internals.

## Latest Aggregate Temporary Proof Fixture

The cleanup fixture for discarded runtime aggregate materialization now asserts
the full no-GC proof inventory instead of only the drop plan. Direct runtime
struct materialization in a closure body and static aggregate materialization
through a value reference both prove `managed_storage: "disabled"`, the
persistent `unique_heap runtime_aggregate` allocation row, and the matching
ownerless `discarded_expr` heap-drop row before WAT emission.

## Latest Source Owner Replacement Proof Fixture

The source-owner cleanup fixture for same-name closure replacement now asserts
the baseline proof rows as well as the direct drop plan. Replacing a
`unique_heap closure` binding now proves disabled managed storage, two
persistent closure allocation rows, the `assignment_replace` drop for the old
owner, and the final `scope_exit` drop for the replacement owner before WAT
emission.

## Latest Source Owner Cleanup Matrix

The source-owner cleanup fixture now asserts baseline proof rows for the main
accepted closure-owner exit edges. Normal program scope exit, closure-body scope
exit, closure-body return exit, program return exit, discarded named owner, and
moved-owner scope exit all prove disabled managed storage, the persistent
closure allocation rows they depend on, and the matching heap-drop rows before
WAT emission.

## Latest Block Owner Cleanup Matrix

Block-result and block-local closure-owner cleanup now has matching no-GC proof
fixtures. Discarded and moved outer owners through block expressions, discarded
and moved block-local owners, and a block-local owner dropped at block scope all
prove disabled managed storage, the persistent closure allocation rows at the
correct program or block scope, and the matching heap-drop rows before WAT
emission.

## Latest Branch And Control Cleanup Matrix

Branch-selected and control-flow closure-owner cleanup now asserts baseline
proof rows for representative accepted paths. Moved owners through `if`
branches, mixed branch-local/direct closure owners, `if let` branch owners with
runtime-union target allocation, loop `break` and `continue` exits, and
conditional return exits all prove disabled managed storage, the persistent
allocation rows they depend on, and the matching heap-drop rows before WAT
emission.

## Latest Union Payload Borrow Barrier

Borrow/view analysis now treats `if let` payload names as aliases of the matched
union owner when the payload is borrowed. A stored view assigned from
`borrow value` inside an `if let` branch protects the original union owner after
the branch merge, and an expression result such as
`let view = if let ... { borrow value } else { ... }` does the same for runtime
union payloads. The new fixtures assert borrow validation, baseline
`Core.proof(...)` rejection, and pre-WAT `Emit.emit(Core, ...)` rejection for
owner replacement while the payload view is live. The borrow alias state also
remembers declared union binding types, so scalar payload borrows remain
copyable and do not create owner barriers while heap-backed payloads such as
`Text`, struct, or nested union payloads still protect the matched owner. The
non-scalar coverage now includes explicit aggregate and nested-union payload
fixtures that assert borrow validation, `Core.proof(...)` rejection, and pre-WAT
emission rejection for owner replacement.

## Latest Borrow View Freeze/Transfer Barrier

Stored borrow-view lifetime coverage now has source-level rejected fixtures for
`freeze` and host ownership transfer while a view is live.
`let view = borrow
message; freeze message` rejects through borrow validation,
baseline `Core.proof(...)`, and pre-WAT `Emit.emit(Core, ...)`. Host calls
declared with an `ownership_transfer` argument now participate in the same
active-borrow barrier, so `host_take(message)` rejects while `view` still
protects `message`. The borrow scanner receives the backend host-import lookup
as an optional hook; synthetic borrow-plan tests that do not model host imports
keep the previous behavior.
