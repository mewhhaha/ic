# Draft Language Specification Tasks

Source: user-provided draft specification, "A Minimal Capability-Oriented
Language Lowering to Interaction Calculus and Wasm".

These tasks turn the draft into implementation and documentation work for a
small language with shared runtime/compile-time syntax, immutable values with
shadowing, explicit linear capabilities, type-values, structural fact checking,
specialization, interaction-calculus-style graph IR, and Wasm code generation.

The normalized language specification lives in `docs/language.md`.

## Naming Rule

All tasks assume the semantic casing convention:

- Use `snake_case` for runtime values, const values, type-values, type
  constructors, protocols, fact-checker values, functions, methods, fields, and
  modules.
- Built-in type names such as `Int`, `I64`, `Text`, and `Unit` keep their
  builtin spelling.

Draft examples that used non-`snake_case` user-defined identifiers should be
normalized in implementation docs and fixtures. Representative normalized names
are:

- `make_adder`
- `read_number`
- `invalid_digit`
- `size_of`
- `align_of`
- `fields_of`
- `cases_of`
- `is_struct`
- `is_union`
- `align_to`
- `tag_size`
- `max_payload`
- `max_align`
- `tag_offset`
- `payload_offset`
- `user_layout`

## Memory And Lifetime Direction

The baseline backend targets `core-3-nonweb`: structured Wasm plus linear
memory. It should not depend on Wasm-GC, tracing GC, hidden attached regions, or
any proposal-only feature. The active decision is to skip GC only by making the
static ownership/lifetime/cleanup analysis complete for every accepted source
shape, including compiler-created temporaries.

Task 12's authoritative memory/lifetime contract is the detailed source of
truth. There is no active GC task for the default backend, and older
collector-fallback notes are superseded by that contract. Hard cases should be
split into smaller proof fixtures, rejected before WAT emission, or deferred to
an explicit future region/managed-storage profile. The cross-task contract is:

1. Classify runtime storage as `scalar_local`, `unique_heap`, `borrow_view`,
   `frozen_shareable`, or `scratch_backed`.
2. Treat ordinary runtime heap values as `unique_heap` unless they are static,
   scalar, explicitly frozen, or allocated inside `scratch {}`.
3. Keep `&owner` / `let view = &owner` as lexical read-only views. Active views
   block owner move, mutation, freeze, transfer, return, and escaping capture.
4. Keep `scratch { ... }` as a lexical scratchpad with a value result. It saves
   and restores a scratch pointer on all exit edges and never returns an
   implicit attached region.
5. Let scratch results escape only when scalar, already frozen/shareable,
   explicitly frozen/promoted into persistent storage, or proven scratch-free at
   the value, field, payload, and closure-capture level.
6. Make `freeze` and scratch-to-persistent promotion explicit Core copy edges
   before crossing a lifetime boundary.
7. Insert cleanup/drop/reset facts for source values and compiler-created
   temporaries from the same proof data used by lowering. Missing cleanup facts
   are proof gaps, not managed-storage fallback points.
8. Apply path-sensitive linear/unique analysis only to source `!` capabilities,
   `unique_heap` owners, live `borrow_view` barriers, `scratch_backed` values,
   and ownership-bearing closure slots.
9. Treat named arenas, attached-region return packages, reusable allocators,
   destructors, tracing GC, managed storage, and Wasm-GC as future explicit
   profiles, not baseline repair paths.

Current task update from the memory decision:

- Use unique ownership for ordinary runtime heap values, lexical `borrow`/view
  syntax for read-only non-owning access, explicit `freeze` for immutable
  shareable values, and `scratch {}` for temporary share-friendly computation.
- `scratch {}` returns a value, but the value is checked before the scratch
  reset. It may escape only as scalar, frozen/shareable, explicitly
  frozen/promoted into persistent storage, or proven scratch-free through
  fields, payloads, and closure captures.
- Cleanup for source values and lowering-created temporaries is proof-driven.
  Every accepted memory slice must expose storage class, owner/lifetime ids,
  escape decision, borrow/view state, freeze/promotion edges when relevant, and
  cleanup/drop/reset/transfer decisions before WAT emission.
- Linear analysis is required only for storage/effect-bearing values: source `!`
  capabilities, unique owners, active borrow barriers, scratch-backed values,
  and ownership-bearing closure slots. Scalars and frozen/shareable values
  remain freely copyable.
- Optional longer-lived regions are future explicit owner packages with tied
  returned values and cleanup/drop/move facts. Ordinary `scratch {}` does not
  grow an attached live region.
- Do not add a default GC or managed-storage task for `core-3-nonweb`. If the
  analysis cannot prove a case, split it into a smaller proof fixture, reject it
  deterministically, or defer it to an explicit future region/managed-storage
  profile.

Current implementation handoff:

- Treat "skip GC if the analysis is proper" as the active baseline contract, not
  as an optimization note. Every accepted memory-heavy slice must prove its
  ownership, lifetime, borrow/view, scratch escape, freeze/promotion, and
  cleanup rows before WAT emission.
- Build the next tasks around proof fixtures first: accepted fixtures expose
  `target_profile: "core-3-nonweb"` and `managed_storage: "disabled"`; rejected
  fixtures name the first missing proof edge; deferred fixtures name an explicit
  future region or managed-storage profile.
- Prioritize the proof queue in this order: storage fact inventory, borrow/view
  lifetimes, scratch result proofs, freeze/promotion edges, temporary cleanup
  rows, storage-driven linear analysis, first-class closure storage, host/import
  ownership contracts, and the final no-GC WAT gate.

No-GC implementation commitment:

- The baseline skips GC by proving storage, lifetime, escape, borrow,
  freeze/promotion, and cleanup facts before WAT emission. This is an acceptance
  requirement, not a later optimization pass.
- The active implementation path is to make that analysis complete for the
  supported surface. A hard case should shrink into narrower proof fixtures or
  reject deterministically; it should not become a baseline GC or managed
  storage ticket.
- "Skip GC if the analysis is proper" is therefore a hard acceptance rule:
  accepted memory-heavy fixtures must show the proof rows that make the case
  safe, not a promise that runtime management will clean it up later.
- `scratch {}` is a lexical scratchpad with reset edges, not an attached region.
  A scratch result must be checked before reset and can escape only as scalar,
  frozen/shareable, explicitly frozen/promoted, or transitively scratch-free.
- Cleanup insertion is proof-driven for source values and lowering-created
  temporaries. Missing cleanup proof produces a deterministic rejection or a
  narrower follow-up task; it does not select collector-managed storage.
- Optional regions remain future explicit owner packages with region owners,
  tied returned-value lifetimes, cleanup/drop facts, move/consume rules, ABI
  rules, and host-boundary rules.
- Future GC, managed storage, and Wasm-GC are separate target profiles, not
  fallback behavior for the default linear-memory backend.

The resulting immediate backlog is: borrow/view barriers, scratch result escape
proofs, explicit freeze/promotion copies, temporary cleanup rows, per-slot
closure capture ownership, host/import ownership contracts, and future-only
region/managed-storage profiles.

Every memory/lifetime slice closes in exactly one state:

- accepted with proof rows and `managed_storage: "disabled"`;
- rejected before WAT emission with a diagnostic naming the missing proof edge;
- deferred to an explicit future region or managed-storage profile.

Immediate implementation tracks:

1. Audit accepted WAT-emitting features against the no-GC proof gate.
2. Finish lexical borrow/view barriers across fields, branches, loops, closures,
   and host/import calls.
3. Finish `scratch {}` lowering and pre-reset result checks for text,
   aggregates, unions, closures, and nested field/payload shapes.
4. Broaden explicit `freeze` and scratch-to-persistent promotion copy edges.
5. Complete cleanup facts for compiler-created temporaries from aggregate
   materialization, text operations, union payload construction, closure
   environment setup, host marshaling, and promotion.
6. Make closure capture storage per-slot: reusable closures may capture scalar
   or frozen/shareable slots; unique, borrow, scratch-backed, capability, or
   ownership-bearing slots require linear closure support or deterministic
   rejection.
7. Extend host/import ownership contracts through wrappers and interprocedural
   static calls while keeping unknown non-scalar boundaries rejected.
8. Keep hard memory cases out of the accepted baseline until they are split into
   narrower proof fixtures or deterministic rejection fixtures; do not open a
   default GC or managed-storage repair task for `core-3-nonweb`.

Authoritative Task 12 slices:

1. `ownership_fact_inventory`: record storage class, owner/lifetime ids, origin,
   escape decision, and cleanup/drop/reset/transfer decision for source values
   and lowering-created temporaries.
2. `borrow_view_lifetimes`: keep borrowed values as runtime-free lexical views
   tied to the original owner, including borrowed field and payload projections.
3. `scratch_result_proofs`: lower `scratch {}` as saved pointer plus reset and
   prove returned values scalar, frozen/shareable, promoted, or transitively
   scratch-free before reset.
4. `freeze_and_promotion_edges`: make unique-to-frozen sharing and
   scratch-to-persistent escape explicit Core edges.
5. `temporary_cleanup_rows`: insert cleanup from ownership facts during Core
   elaboration for text, aggregate, union, closure, host, and promotion
   temporaries.
6. `storage_driven_linear_analysis`: apply exact-use/path-sensitive analysis to
   capabilities, unique owners, live borrow barriers, scratch-backed values, and
   ownership-bearing closure slots while leaving scalars and frozen values
   copyable.
7. `future_region_owner_packages`: keep optional longer-lived regions as
   explicit future owner packages, separate from ordinary scratchpads.
8. `no_gc_wat_gate`: require complete no-GC proof rows before WAT emission and
   reject missing rows instead of selecting managed storage.

Decision lock: for the default `core-3-nonweb` target, the task queue is
analysis and proof work, not collector selection. Each memory-heavy ticket must
define the accepted proof row, the nearest rejected missing-proof fixture, and
`managed_storage: "disabled"` before WAT emission is broadened.

Latest scratchpad/no-GC refinement: Task 12 now names the canonical
implementation tickets for the selected memory model:
`ownership_fact_inventory`, `borrow_view_lifetimes`, `scratch_result_proofs`,
`freeze_and_promotion_edges`, `temporary_cleanup_rows`,
`storage_driven_linear_analysis`, `future_region_owner_packages`, and
`no_gc_wat_gate`. The current plan skips GC by making the static analysis
complete for the accepted surface, not by adding a collector fallback. Cleanup
for source values and compiler-created temporaries must be inserted from
ownership/lifetime facts; `scratch {}` remains a value-returning temporary
scratchpad with saved-pointer reset, not an attached region; and optional
longer-lived regions remain future explicit owner packages. If a memory-heavy
shape cannot be proven, split it by storage class, temporary origin, and escape
path until it is accepted with no-GC proof rows, rejected before WAT emission,
or deferred to a named future region/managed-storage profile.

The immediate implementation tasks should therefore define proof fixtures before
broadening codegen:

1. Accepted fixtures show `target_profile: "core-3-nonweb"`,
   `managed_storage: "disabled"`, storage/lifetime rows, borrow/scratch rows,
   freeze/promotion rows, and cleanup/drop/reset rows.
2. Rejected fixtures name the first missing proof edge: active borrow,
   scratch-backed result, missing promotion, unknown host-boundary ownership, or
   missing temporary cleanup.
3. Deferred fixtures name the explicit future profile, such as region-owner
   packages or managed storage, and must not be accepted by the baseline WAT
   path.

The first pass should make the proof fixtures concrete before adding broader
lowering support:

1. `borrow_view_lifetimes`: accepted read-only field/payload views and rejected
   owner mutation, move, freeze, transfer, return, escaping capture, and unknown
   host-boundary use while a view is live.
2. `scratch_result_proofs`: accepted scalar, frozen/shareable, promoted, and
   transitively scratch-free returns, plus rejected raw scratch-backed text,
   aggregate, union payload, and closure-environment escapes.
3. `temporary_cleanup_rows`: accepted source-owner and compiler-temporary
   cleanup rows for text, aggregate, union, closure environment, host
   marshaling, and promotion temporaries, plus rejected missing-cleanup paths.
4. `freeze_and_promotion_edges`: accepted unique-to-frozen and
   scratch-to-persistent Core copy edges for text bytes, aggregate fields, union
   payloads, closure environment slots, and nested field/payload paths.
5. `future_region_owner_packages`: documentation-only deferred fixtures for
   explicit region-owner packages, making clear that ordinary `scratch {}` does
   not attach a live region to its result.
6. `no_gc_wat_gate`: final pre-WAT proof gate that accepts only complete
   unmanaged proof rows and rejects missing storage, lifetime, borrow, scratch,
   promotion, host-boundary, or cleanup facts before emission.

Fixture source forms should use the same syntax planned for the language:

```txt
let view = &owner
let shared = freeze owner

let result = scratch {
  let tmp = make_value()
  tmp
}
```

Each accepted fixture must expose `target_profile: "core-3-nonweb"`,
`managed_storage: "disabled"`, storage rows, borrow/view rows when relevant,
scratch-result rows when relevant, freeze/promotion rows when relevant, and
cleanup/drop/reset/transfer rows. Rejected fixtures should name the first
missing proof edge, such as `active_borrow`, `scratch_backed_result`,
`missing_promotion`, `unknown_host_boundary_ownership`, or
`missing_temporary_cleanup`.

## Task Order

1. [01-normalize-naming-and-spec.md](01-normalize-naming-and-spec.md)
2. [02-bindings-shadowing-and-core-syntax.md](02-bindings-shadowing-and-core-syntax.md)
3. [03-const-comptime-and-specialization.md](03-const-comptime-and-specialization.md)
4. [04-functions-closures-and-control-flow.md](04-functions-closures-and-control-flow.md)
5. [05-linear-capabilities-and-modules.md](05-linear-capabilities-and-modules.md)
6. [06-type-values-structs-unions-and-facts.md](06-type-values-structs-unions-and-facts.md)
7. [07-extensions-and-protocol-fact-checkers.md](07-extensions-and-protocol-fact-checkers.md)
8. [08-recursion-loops-break-continue-and-linear-state.md](08-recursion-loops-break-continue-and-linear-state.md)
9. [09-mutation-layout-and-error-model.md](09-mutation-layout-and-error-model.md)
10. [10-lowering-pipeline-to-ic-and-wasm.md](10-lowering-pipeline-to-ic-and-wasm.md)
11. [11-mvp-grammar-and-scope-control.md](11-mvp-grammar-and-scope-control.md)
12. [12-remaining-generalization-tasks.md](12-remaining-generalization-tasks.md)

## Completion Criteria

- Each task has an implementation target, acceptance criteria, and verification
  notes.
- User-defined source examples use `snake_case`.
- Remaining non-`snake_case` names in snippets are builtin type names such as
  `Int`, `Text`, `I64`, and `Unit`.
- The task set covers every major section of the draft specification.

## Current Implementation Snapshot

Earlier revisions of this file carried a file-by-file narrative of the entire
module layout. That narrative duplicated what the source tree already shows and
drifted as modules moved; it was removed in favor of the pointers below (the
full text remains in git history).

Where things stand:

- The language contract lives in `docs/language.md`. Per-feature backend
  coverage — which shapes the pure Ic route and the structured Core route each
  accept, plus the reserved list — lives in `docs/coverage.md`.
- `src/frontend.ts` is the public frontend facade (`Source`, `IxRunner`,
  `IxHost`), with implementation modules under `src/frontend/`. The lowerer
  follows a facade-plus-hooks architecture: `src/frontend/lower.ts` is the
  stable entry, `src/frontend/lower_graph.ts` composes hooks, and
  `lower_*_adapter.ts` modules wire feature-specific hook bundles. Feature
  areas (text, unions, structs, static loops, linear analysis, effects) each
  own a small module cluster, usually a facade file plus a same-named
  directory.
- `src/core.ts` is the structured Core facade with implementation under
  `src/core/`. The backend mirrors the frontend architecture:
  `src/core/backend.ts` is the public trait facade, `src/core/backend/graph*`
  composes analysis/emission services, and feature emitters (runtime text,
  runtime unions, closures, recursion, index assignment, ownership proofs)
  live in focused `src/core/*.ts` modules with hook contracts supplied by the
  backend.
- `src/ic.ts` owns Interaction Calculus reduction (`src/ic/graph_reduce*`),
  validation, and lowering to `src/expr.ts`; `src/mod.ts` and `src/wat.ts` own
  Wasm module assembly; `src/abi.ts` and `src/host.ts` own the managed
  JavaScript ABI.
- Tests live next to the code (`src/*.test.ts`, `src/frontend/*.test.ts`),
  end-to-end Wasm integration tests are grouped in `src/wasm_*.test.ts`, and
  the executable example suite with expected results, failures, and traps
  lives under `examples/` with `examples/manifest.ts` as the source of truth.

When a slice of work changes what a route accepts, update `docs/coverage.md`;
when it changes language semantics, update `docs/language.md`. This file only
tracks task planning and the memory/lifetime contract above.
