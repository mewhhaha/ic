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

The current frontend has an Ic-lowerable MVP slice behind the `src/frontend.ts`
facade, with implementation modules in `src/frontend/` and tests in
`src/frontend.test.ts`. `src/frontend/lower.ts` is the stable lowerer facade,
while `src/frontend/lower_graph.ts` owns the internal hook composition and
environment-threading graph. Frontend call-specialization graph delegates live
in `src/frontend/lower_call_graph.ts`, keeping const-call, deferred-call,
runtime-call, and specialization wrapper wiring out of the lowerer root.
`src/frontend/lower_call_facade.ts` keeps lazy call-graph forwarding for cyclic
lowerer dependencies out of `src/frontend/lower_graph.ts`. Frontend value graph
delegates live in `src/frontend/lower_value_graph.ts`, keeping struct/union
value resolution, union-case inference, and aggregate access wrapper wiring out
of the lowerer root. `src/frontend/lower_value_facade.ts` keeps lazy
aggregate/union graph forwarding for cyclic lowerer dependencies out of
`src/frontend/lower_graph.ts`. Frontend expression/call/if/index hook assembly
lives in `src/frontend/lower_expression_hooks_adapter.ts`, and
prepare/eval/statement/inference hook assembly lives in
`src/frontend/lower_program_hooks_adapter.ts`, keeping repeated lower-graph hook
wiring out of `src/frontend/lower_graph.ts`. Lazy lower/eval/prepare/infer and
`if`/`if let` bridge wrappers live in `src/frontend/lower_graph/bridge.ts`,
keeping cyclic hook access explicit. Frontend lower-graph value wiring now lives
in `src/frontend/lower_graph/value.ts`; it owns union-value hooks,
union-inference hooks, dynamic branch hooks, struct-value hooks, and delayed
value-graph construction. Frontend lower-graph program wiring now lives in
`src/frontend/lower_graph/program.ts`; it owns expression/program/static-rec
hook composition, call-graph construction, and index-assignment hook threading.
`src/frontend/lower_app_type_adapter.ts` owns app-as-expected-type lowering and
inlineable helper app-result type inference, keeping static-rec/app-helper
context recursion out of `src/frontend/lower_graph.ts`. Expected-type frontend
lowering is split so `src/frontend/typed_lower.ts` stays a small dispatcher,
`src/frontend/typed_hooks.ts` owns the hook/type contract,
`src/frontend/typed_block.ts` owns simple block-result and alias normalization,
`src/frontend/typed_if.ts` owns typed dynamic branch dispatch,
`src/frontend/typed_if_values.ts` owns typed struct/union selection, and
`src/frontend/typed_if_fallback.ts` plus `src/frontend/typed_type.ts` own typed
fallback and type-name helpers. Shared statement-result extraction for
block-like helpers lives in `src/frontend/block_result.ts`, keeping repeated
`expr`/`return` final-value checks out of typed, rec, text, call-target, and
expression lowering modules. Ic sharing/erasure helpers live in
`src/frontend/ic_share.ts`, keeping that graph-specific machinery separate from
source semantic lowering. Static-rec text result lowering lives in
`src/frontend/rec_text.ts`, keeping `Text` length, `get`, and byte-index Ic
construction out of the recursion unrolling module. Static-rec runtime struct
projection and index lowering lives in `src/frontend/rec_struct.ts`, keeping
aggregate selector Ic construction out of that same recursion unrolling module.
Shared runtime typed-struct type discovery, nested field-projection type
discovery, projection/index access entry points, and indexed-field type helpers
live in `src/frontend/runtime_struct.ts`, while runtime struct selector
construction and dynamic `if` projection lowering live in
`src/frontend/runtime_struct_projection.ts`, so ordinary frontend lowering and
static-rec struct lowering use the same field selection rules. Frontend
runtime-struct hook composition and runtime-struct adapter glue live in
`src/frontend/lower_runtime_struct_adapter.ts`, keeping runtime typed-struct
projection and type-discovery hook wiring out of `src/frontend/lower_graph.ts`.
Declared static-shaped struct field/index value resolution, access retagging,
and indexed-result classification live in `src/frontend/struct_access.ts`,
keeping that type-sensitive aggregate access logic out of the main semantic
lowering pass. Frontend struct-access hook composition and dynamic aggregate
index adapter glue live in `src/frontend/lower_struct_access_adapter.ts`,
keeping aggregate field/index resolver wiring out of
`src/frontend/lower_graph.ts`. Frontend declared struct-value validation, struct
type-value resolution, and declared field-type discovery live in
`src/frontend/struct_value_type.ts`; frontend-known struct-value discovery, pure
struct-update rebuilds, and handler-encoded struct-value Ic lowering are split
behind the `src/frontend/struct_values.ts` facade. Shared hook and target shapes
live in `src/frontend/struct_values/types.ts`, pure update rebuilds live in
`src/frontend/struct_values/update.ts`, handler-encoded Ic lowering lives in
`src/frontend/struct_values/lower.ts`, and frontend-known struct-value
resolution lives in `src/frontend/struct_values/resolve.ts`, with the main
lowerer supplying nested expression lowering and environment-sensitive
resolution hooks. Frontend union handler-encoded case lowering and public
re-exports live in `src/frontend/union_values.ts`; union value,
constructor-call, block-alias, and type-value resolution live in
`src/frontend/union_resolve.ts`; payload inference and typed constructor
validation live in `src/frontend/union_payload.ts`; and the shared hook/target
contract lives in `src/frontend/union_value_types.ts`. Dynamic union branch
case-shape inference lives in `src/frontend/union_infer.ts` with shared dynamic
union-if case merging in `src/frontend/dynamic_union_cases.ts` and shared
inlineable helper-call result discovery in `src/frontend/union_call_inline.ts`.
Frontend aggregate index assignment rebuilds live in
`src/frontend/index_assignment.ts`, keeping static and runtime typed-struct
update construction out of the main semantic lowering pass. Frontend dynamic
index selection over frontend-known aggregates and typed runtime structs lives
in `src/frontend/index_access.ts`. Ic lowering for builtins and frontend-known
method calls lives in `src/frontend/builtin_call.ts`, with the main lowerer
supplying type inference, text lowering, compile-time builtin evaluation, and
aggregate index hooks. Text/index builtins such as `len`, `get`, `slice`, and
`append` are grouped in `src/frontend/builtin_call/text.ts`, with read/index
builtins in `src/frontend/builtin_call/text_read.ts` and text-producing
operations in `src/frontend/builtin_call/text_ops.ts`. Compile-time structural
builtins, layout helpers, and `has(...)` fact queries live in
`src/frontend/const_builtin.ts`. Ic primitive folding and select reduction live
in `src/ic/prim_reduce.ts`, keeping numeric primitive behavior separate from the
active-pair rewrite rules in `src/ic/graph_reduce.ts`. IC reducer fresh-name
context lives in `src/ic/graph_reduce/context.ts`, structural erasure lives in
`src/ic/graph_reduce/erase.ts`, graph materialization lives in
`src/ic/graph_reduce/materialize.ts`, and substitution plus name scanning live
in `src/ic/graph_reduce/substitute.ts` and `src/ic/graph_reduce/scan.ts`;
primitive propagation over superpositions
includes unary memory loads, and dynamic selects retag to `i64.select` when
reduction exposes i64 branches. The exported `Ic` companion also satisfies the
generic `Reduce<ctx, from, to>` pattern, so context-free top-level reduction can
be called through `Reduce.reduce`. Source-file loading and import resolution
live in `src/frontend/load.ts`, keeping filesystem concerns out of the `Source`
companion facade. The structured Core entrypoint follows the same facade shape:
`src/core.ts` re-exports the backend, AST, formatter, source-lowering, backend
utilities, and text data helpers grouped under `src/core/`. Core top-level WAT
artifact assembly, lifted-closure function/table aggregation, data segment
exposure, and `Mod` construction live in `src/core/artifact_emit.ts`, while
`src/core/backend/entry/artifact.ts` owns the backend adapter that composes
text-layout, statement emission, lifted-closure, and result-type hooks. The Core
backend keeps `src/core/backend.ts` as the public trait facade, with the `Core`
companion implementation in `src/core/backend/core.ts`;
`src/core/backend/graph.ts` stays the public backend entrypoint facade. Backend
composition lives in `src/core/backend/graph/instance.ts`; analysis, emission,
static-value/text, runtime/control-flow, and entry/artifact wiring live in
`src/core/backend/graph/analysis.ts`, `src/core/backend/graph/emit.ts`,
`src/core/backend/graph/values.ts`, `src/core/backend/graph/runtime.ts`, and
`src/core/backend/graph/entry.ts`, with lazy graph dependencies described in
`src/core/backend/graph_deps.ts` and assembled in
`src/core/backend/graph/deps.ts`. The combined backend graph contract lives in
`src/core/backend/graph/types.ts`. Analysis graph construction is split under
`src/core/backend/graph/analysis/` for local-fact, expression-type, and
type-check service adapters. Emit graph construction is split under
`src/core/backend/graph/emit/` for expression and statement WAT-emitter service
adapters. Values graph construction is split under
`src/core/backend/graph/values/` for static-call, static-value, struct, and text
service adapters. Runtime graph construction is split further under
`src/core/backend/graph/runtime/` for closure, runtime-union, control-flow, and
recursion services; entry graph construction is split under
`src/core/backend/graph/entry/` for app, index, local-collection, and artifact
services. Backend utility helpers are grouped under `src/core/backend/util/`,
with `src/core/backend/util.ts` kept as a compatibility facade. Backend graph
context construction and child-context cloning live in
`src/core/backend/graph/context.ts`, keeping host-import map cloning and
`CoreCtx` defaults out of the public backend graph facade. Unsupported-codegen
proof conversion lives in `src/core/backend/graph/proof_unsupported.ts`, keeping
analysis-error normalization and placeholder unsupported-proof assembly out of
the public backend graph facade. Unsupported-codegen proof support predicates
for collection loops, index assignment, final type values, app/field/index
expressions, and `if let` targets live in
`src/core/backend/graph/proof_support.ts`, keeping read-only proof gates out of
the public backend graph facade. Drop-analysis static-value discovery for
type-level values, text, frozen static structs, closure values, ownerless branch
values, and block-shaped static expressions now lives in
`src/core/backend/graph/drop_static.ts`. Drop-analysis freeze-consumption
detection and local-fact clearing live in
`src/core/backend/graph/drop_freeze.ts`, keeping the drop/proof local-collection
helpers smaller inside the backend graph facade. Drop/borrow proof-context
collection, freeze-consumption-aware local collection, unsafe scratch-return
proof binding, and closure-valued local recognition now live in
`src/core/backend/graph/drop_context.ts`. Closure-body, collection-loop,
runtime-union match, and `if let` branch proof-context construction now lives in
`src/core/backend/graph/proof_context.ts`. Core emission context construction,
branch cloning, recursive body context creation, lifted-closure body context
creation, and runtime-union match branch binding live in `src/core/emit_ctx.ts`,
keeping backend hook wiring separate from the shared WAT-emission context
shapes. Core type-level static evaluation and type-constructor substitution live
behind `src/core/type_static.ts`, with helper modules under
`src/core/type_static/` for builtin names, block results, substitution, context
types, and static value resolution. This keeps that metaprogramming path
separate from WAT emission. Core binding/parameter annotation validation, direct
struct/union annotation context, structural type-pattern checks, and value
type-name checks live in `src/core/type_check.ts`, with the backend supplying
text, union, static-call, and expression-typing hooks. Core backend type-check
adapter glue lives in `src/core/backend/analysis/type_check.ts`, with
hook-object assembly in `src/core/backend/analysis/type_check/hooks.ts` and the
adapter contract in `src/core/backend/analysis/type_check/types.ts`, keeping
annotation, type-pattern, value-type-name, and const type-value wiring out of
`src/core/backend.ts`. Core closure-function, text-local, and runtime
union-local fact tracking lives in `src/core/local_facts.ts`, with the backend
supplying closure typing, runtime-union type lookup/equality, and static type
hooks. Core backend local-fact adapter glue lives in
`src/core/backend/analysis/local_facts.ts`, with hook-object assembly in
`src/core/backend/analysis/local_facts/hooks.ts`, keeping function-type,
text-local, and runtime union-local fact wiring out of `src/core/backend.ts`.
Core local/context collection facade lives in `src/core/local_collect.ts`, with
the shared context/hook contract in `src/core/local_collect/types.ts` and the
main statement/expression traversal split into `src/core/local_collect/stmt.ts`
and `src/core/local_collect/expr.ts`. Core backend local-collection adapter glue
lives in `src/core/backend/entry/local_collect.ts`, with hook-object assembly in
`src/core/backend/entry/local_collect/hooks.ts` and its backend contract in
`src/core/backend/entry/local_collect/types.ts`, keeping type, static, union,
text, closure, recursion, and index hook wiring out of `src/core/backend.ts`.
Core recursion-specific local collection lives in
`src/core/local_collect_rec.ts`, and Core `if let` local collection lives in
`src/core/local_collect_if_let.ts`. Core closure-valued local collection lives
in `src/core/local_collect_closure.ts`, block-expression final statement
collection lives in `src/core/local_collect_block.ts`, static `if/else`
statement branch collection lives in `src/core/local_collect_if_else.ts`, and
range/static/text collection-loop local collection lives in
`src/core/local_collect_loop.ts`, keeping those feature-specific traversal rules
out of the main collector. Core const-call inlining delegates lexical expression
substitution to `src/core/substitute.ts`, mirroring the frontend substitution
module while keeping block, loop, lambda, and `if let` shadowing rules out of
the WAT emitter. Core scoped static-call expression rewriting stays exported
from `src/core/static_call_rewrite.ts`, while statement/block rewriting and
replacement-name shadowing live under `src/core/static_call_rewrite/`, keeping
statement-bodied inline-call AST rewriting separate from static-call planning
and WAT emission. Core static-call public exports live in
`src/core/static_call.ts`, while the implementation is split under
`src/core/static_call/`: `types.ts` owns the shared context/hook contract,
`arity.ts` owns arity checks, `target.ts` owns static-call/static-rec target
discovery and scope-free substitution, and `scoped.ts` owns scoped static-call
type/emission planning. Core backend static-call adapter glue lives in
`src/core/backend/values/static_call.ts`, its backend contract lives in
`src/core/backend/values/static_call/types.ts`, hook-object assembly lives in
`src/core/backend/values/static_call/hooks.ts`, and scoped-call versus
lookup/target wrappers live in `src/core/backend/values/static_call/scoped.ts`
and `src/core/backend/values/static_call/lookup.ts`, keeping static-call hook
wiring out of `src/core/backend.ts`. Core static text recognition, text
concatenation visibility checks, and static text length/index helpers live in
`src/core/text_static.ts`, keeping that text-specific analysis separate from the
backend control-flow emitter. Core visible/runtime text fact recognition and
runtime text-concat operand detection live in `src/core/text_facts.ts`, with the
backend supplying expression-type, static struct, and static text hooks. Core
text data layout scanning and heap-start calculation live in
`src/core/text_layout.ts`, which now re-exports the split layout builder, layout
types, and parameter-type helper from `src/core/text_layout/`. Core runtime text
operation emitters for heap concatenation, equality, slice, length loads, byte
loads, and byte assignment live behind `src/core/runtime_text.ts`. Runtime text
shared contexts and hooks live in `src/core/runtime_text/types.ts`, temporary
plan/local declaration helpers live in `src/core/runtime_text/plan.ts`, and
byte-copy loop emitters live in `src/core/runtime_text/copy.ts`. Heap selection
lives in `src/core/runtime_text/alloc.ts`; concat/append, equality,
slice/freeze-copy, and byte access/update emission live in
`src/core/runtime_text/concat.ts`, `src/core/runtime_text/eq.ts`,
`src/core/runtime_text/slice.ts`, and `src/core/runtime_text/access.ts`. Core
backend text hook composition and text-specific adapter glue is composed by
`src/core/backend/text.ts`, with static text adapters in
`src/core/backend/text/static.ts`, text fact adapters in
`src/core/backend/text/facts.ts`, text layout adapters in
`src/core/backend/text/layout.ts`, and runtime text emission adapters in
`src/core/backend/text/runtime.ts`, keeping static/runtime text hook wiring out
of `src/core/backend.ts`. Core memory-layout helpers for scalar sizes,
alignment, loads, and stores live in `src/core/memory.ts`. Core runtime-union
value/type recognition, pointer-target discovery, case metadata, and match-case
metadata are exported through `src/core/runtime_union.ts`, with the
implementation split under `src/core/runtime_union/` into focused modules for
runtime value discovery, type-expression/equality checks, case metadata, target
resolution, match metadata, and union storage size. Runtime-union payload
layout, static-shaped struct payload validation, and packed payload-size
calculation live in `src/core/runtime_union_payload.ts`. Runtime-union match
payload fact binding, static/core branch context creation, and temporary
payload-local construction live in `src/core/runtime_union_match.ts`.
Runtime-union heap materialization and pointer `if let` control flow live in
`src/core/runtime_union_emit.ts`, while packed struct payload stores and payload
loads for pointer matches live in `src/core/runtime_union_payload_emit.ts`. Core
backend union hook composition and union-specific adapter glue is composed by
`src/core/backend/union.ts`, with static union adapters in
`src/core/backend/union/static.ts` and runtime union adapters in
`src/core/backend/union/runtime.ts`. Runtime union adapter contracts, type/match
metadata hooks, and local/WAT emission hooks live in
`src/core/backend/union/runtime/types.ts`,
`src/core/backend/union/runtime/info.ts`,
`src/core/backend/union/runtime/info/hooks.ts`,
`src/core/backend/union/runtime/info/query.ts`,
`src/core/backend/union/runtime/info/match.ts`, and
`src/core/backend/union/runtime/emit.ts`, keeping static/runtime union hook
wiring out of `src/core/backend.ts`. Core statement-level `if`/`if else` WAT
emission lives in `src/core/if_stmt.ts`, with the backend supplying condition
typing, expression/statement emission, static capture planning, and static
assignment merging hooks. Core general statement WAT dispatch, including binds,
assignments, loop/branch dispatch, final-expression handling, drops, and
index-assignment routing, lives in `src/core/stmt_emit.ts`, with the backend
supplying static-value, local-fact, loop, text, and nested emit hooks. Core
`if let` dispatch between static union, dynamic union-if, and runtime
union-pointer lowering lives in `src/core/if_let_dispatch.ts`, with the backend
supplying static, dynamic, and runtime target discovery hooks. Core `if let`
statement/expression WAT emission lives in `src/core/if_let.ts`, with the
backend supplying union-case lookup, dynamic union-if discovery, expression
typing, and nested emit hooks. Core static and emission-time `if let` payload
binding lives in `src/core/if_let_payload.ts`, with `src/core/emit_ctx.ts`
supplying branch context cloning and the backend supplying expression
emission/type hooks, static struct lookup, text facts, and local-fact clearing.
Core static union-case lookup, dynamic union-if discovery, and dynamic `if let`
payload binding live behind `src/core/union_static.ts`, with the backend
supplying type-value, static-call, and expression-typing hooks. The split
implementation keeps shared context/hook types in
`src/core/union_static/types.ts`, type-field lookup in
`src/core/union_static/field.ts`, scoped static-call resolution in
`src/core/union_static/static_call.ts`, static case/type discovery in
`src/core/union_static/static_case.ts`, dynamic union-if discovery in
`src/core/union_static/dynamic_if.ts`, and dynamic payload binding/fact updates
in `src/core/union_static/payload.ts`. Core recursive-call result typing,
initial parameter binding, tail-call detection, and tail-call argument
validation live in `src/core/rec_type.ts`, with the backend supplying
annotation, expression typing, local-collection, and context-cloning hooks. Core
tail-recursive call/body WAT emission lives in `src/core/rec_emit.ts`, with the
backend supplying parameter annotation, tail-call validation, result typing,
context cloning, and nested emit hooks. Core backend recursion hook composition
and recursion-specific adapter glue live in `src/core/backend/runtime/rec.ts`,
keeping recursive typing/emission hook wiring out of `src/core/backend.ts`. Core
expression and final-statement result typing lives in `src/core/expr_type.ts`,
with the backend supplying application, text, union, static-value, closure,
block-local collection, and payload-fact hooks. Core backend expression-type
adapter glue and primitive operand specialization live in
`src/core/backend/analysis/expr_type.ts`, with hook-object assembly in
`src/core/backend/analysis/expr_type/hooks.ts`, keeping result-type hook wiring
out of `src/core/backend.ts`. Core application result typing for `len`, `get`,
`panic`, recursive calls, static calls, scoped static calls, and dynamic closure
calls lives in `src/core/app_type.ts`, with the backend supplying collection,
text, recursion, static-call, and closure hooks. Core application WAT dispatch
for the same shapes lives in `src/core/app_emit.ts`, with the backend supplying
static analysis, text helpers, closure typing, and nested emit hooks. Core
backend application hook composition and application adapter glue live in
`src/core/backend/entry/app.ts`, keeping app typing/emission wiring out of
`src/core/backend.ts`. Core first-class closure environment allocation and
dynamic `call_indirect` emission live in `src/core/closure_emit.ts`, shared
closure runtime shapes and constants live in `src/core/closure_runtime.ts`,
closure lift registration/environment layout/type registration lives in
`src/core/closure_lift.ts`, and lifted closure function emission lives in
`src/core/closure_lift_emit.ts`, with the backend supplying closure typing and
nested expression/local hooks. Core closure-valued `if` WAT emission lives in
`src/core/closure_if_emit.ts`, with the backend supplying closure type
refinement, nested statement/expression emission, and runtime closure emission
hooks. Core first-class closure function-type discovery, selected-branch closure
type checking, and closure-call argument validation live in
`src/core/closure_type.ts`, with the backend supplying expression typing,
runtime-union result facts, capture discovery, annotation checks, and scoped
static-call hooks. Core lambda runtime-capture discovery and static capture
snapshot planning live in `src/core/closure_capture.ts`, with the backend
supplying static struct-binding lookup for supported captured aggregate
index-assignment cases; unused capture-free runtime-local traversal has been
removed so the module only carries active capture planning and assignment
analysis. Core backend closure hook composition and closure-specific adapter
glue is composed by `src/core/backend/closure.ts`, with capture adapters in
`src/core/backend/closure/capture.ts`, closure type adapters in
`src/core/backend/closure/type.ts`, runtime closure emission adapters in
`src/core/backend/closure/emit.ts`, and closure-valued `if` adapters in
`src/core/backend/closure/if.ts`, keeping closure capture/type/emission hook
wiring out of `src/core/backend.ts`. Core index-assignment support is split
behind the `src/core/index_assign.ts` facade: shared hook and plan shapes live
in `src/core/index_assign/types.ts`, static aggregate rebuild planning/emission
lives in `src/core/index_assign/static.ts`, and runtime aggregate checked-store
planning/emission lives in `src/core/index_assign/runtime_aggregate.ts`, with
the backend supplying type checks, static text/value planning, expression
stability, and nested emit hooks. Core backend index-specific adapter glue lives
in `src/core/backend/entry/index.ts`, with hook-object assembly in
`src/core/backend/entry/index/hooks.ts`, keeping static index assignment,
dynamic index emission, and collection item-type hook wiring out of
`src/core/backend.ts`. Core expression-level WAT emission lives behind the
`src/core/expr_emit.ts` facade. Shared expression-emission context and hook
shapes now live in `src/core/expr_emit/types.ts`, while scratch/freeze lifetime
emission helpers live in `src/core/expr_emit/lifetime.ts`. Freeze expression
dispatch now lives in `src/core/expr_emit/freeze.ts`, and scratch expression
dispatch now lives in `src/core/expr_emit/scratch.ts`; the backend supplies
static value/text facts, app/if-let/closure emitters, runtime text helpers, and
nested statement/expression hooks. Core backend expression-emission adapter glue
and closure-valued `if` dispatch live in `src/core/backend/emit/expr.ts`, with
hook-object assembly in `src/core/backend/emit/expr/hooks.ts`, keeping
expression emit hook wiring out of `src/core/backend.ts`. Core backend
statement-emission adapter glue lives in `src/core/backend/emit/stmt.ts`, with
hook-object assembly in `src/core/backend/emit/stmt/hooks.ts`, keeping bind,
loop, branch, text assignment, and static index assignment dispatch wiring out
of `src/core/backend.ts`. Core dynamic index selection over static aggregate
shapes lives in `src/core/index_expr.ts`, and pure visible text byte-index
expression construction lives in `src/core/text_index.ts`. Core assigned-name
discovery for statement merge analysis lives in `src/core/assigned_names.ts`.
Core scope analysis for static-call statement scope and assignment-through-AST
checks lives in `src/core/scope_analysis.ts`. Core static-value stability
analysis for static captures, merge planning, and index-assignment planning
lives in `src/core/static_stability.ts`. Core statement-level static `if/else`
assignment merging lives in `src/core/static_merge.ts`, with the backend
supplying static struct-capture planning. Core backend control-flow hook
composition and control-flow adapter glue is composed by
`src/core/backend/control_flow.ts`, with range and collection-loop adapters in
`src/core/backend/control_flow/loop.ts`, `if let` and payload adapters in
`src/core/backend/control_flow/if_let.ts`, `if let` hook builders in
`src/core/backend/control_flow/if_let/hooks.ts`, and `if` statement/static-merge
adapters in `src/core/backend/control_flow/if_stmt.ts`, keeping range-loop,
collection-loop, `if`, `if let`, runtime-union `if let`, payload binding, and
static branch-merge wiring out of `src/core/backend.ts`. Core static
struct-value resolution, static struct updates, dynamic struct-if reshaping, and
static collection-field projection live in `src/core/struct_static.ts`, with the
backend supplying expression-type and static-call hooks. Core backend
static-struct hook composition and struct-specific adapter glue live in
`src/core/backend/values/struct.ts`, keeping static struct hook wiring out of
`src/core/backend.ts`. Core static value capture planning for structs, unions,
text, dynamic aggregate branches, and static-value recognition lives in
`src/core/static_values.ts`, which now re-exports the split static-value
contracts, recognition, scratch-free analysis, capture/frozen fact planning,
struct planning, and general planning modules from `src/core/static_values/`,
with the backend supplying text, union, struct, runtime-union, expression-type,
and nested emit hooks. Core backend static-value hook composition and
static-value adapter glue live in `src/core/backend/values/static_value.ts`,
with its backend contract in `src/core/backend/values/static_value/types.ts`,
hook adapters in `src/core/backend/values/static_value/hooks.ts`, recognition
wrappers in `src/core/backend/values/static_value/recognition.ts`, and capture
planning wrappers in `src/core/backend/values/static_value/plan.ts`, keeping
static-value hook wiring out of `src/core/backend.ts`. Frontend numeric literal
parsing, truthiness lowering helpers, primitive result typing, and numeric
primitive operand validation live in `src/frontend/numeric.ts`, with the main
lowerer supplying expression inference and annotation-derived numeric facts.
Frontend visible-text primitives live in `src/frontend/text.ts`, frontend text
length lowering lives in `src/frontend/text_lower.ts`, and static/runtime text
byte-index lowering lives in `src/frontend/text_lower/byte_index.ts`, with
visible-text byte selection and shared text-index validation in
`src/frontend/text_lower/visible_byte_index.ts`, behind a shared hook contract
in `src/frontend/text_lower_types.ts`. Visible-text value discovery and
text-concat operand checks live in `src/frontend/text_visible.ts`, with visible
`if let` and dynamic union branch text recovery in
`src/frontend/text_visible_if_let.ts`, keeping visible text recognition separate
from UTF-8 byte-length and text byte-load Ic construction. Frontend
text-lowering hook composition and text-specific lowerer adapter glue live in
`src/frontend/lower_text_adapter.ts`, keeping text hook wiring out of
`src/frontend/lower_graph.ts`. Frontend static range and collection loop
expansion lives in `src/frontend/static_loop.ts`, with the main lowerer
supplying only the environment-sensitive static evaluation and type-resolution
hooks; statically decidable nested `if` `break`/`continue` edges and statically
known `if let` `break`/`continue` edges are unrolled there, while terminal
`return` stops further unrolling, nested static loops are flattened with inner
`break`/`continue` scoped to the inner loop, and simple dynamic `if { break }`,
`if { continue }`, `if let { break }`, and `if let { continue }` bodies lower
through synthesized active/step flags before Ic lowering for static range loops
and statically expanded collection loops over const-known aggregates, typed
runtime structs, and frontend-visible text bytes. Those dynamic loop-control
branches may run simple local-binding, assignment, or expression prefix
statements before the terminal `break` or `continue`; the same dynamic-control
path supports top-level non-linear integer, `Text`, resolvable static-shaped
struct, and resolvable same-case union `let` bindings before later dynamic
`break`/`continue` checks by binding an explicit inactive fallback branch with
the correct integer width, an empty text value, recursively synthesized field
fallbacks, or recursively synthesized payload fallbacks. Nested dynamic `if` and
`if let` loop-control bodies lower by recursively guarding statements after
inner `break`/`continue`, so non-terminal trailing assignments are skipped once
the active step is cleared. Frontend static-loop hook composition and
static-loop adapter glue live in `src/frontend/lower_static_loop_adapter.ts`,
keeping static loop hook wiring out of `src/frontend/lower_graph.ts`.
Static-loop shared hook/item contracts live in
`src/frontend/static_loop/types.ts`, loop binding/read-only helpers live in
`src/frontend/static_loop/binding.ts`, static loop body expansion and dynamic
loop-control need detection live in `src/frontend/static_loop/body.ts`,
collection item materialization lives in `src/frontend/static_loop/items.ts`,
static `if let` payload binding lives in
`src/frontend/static_loop/if_let_payload.ts`, dynamic loop-control flag
generation and loop-control scanning live in
`src/frontend/static_loop/dynamic_control.ts`, and guarded dynamic-control
statement expansion lives in `src/frontend/static_loop/expand_dynamic.ts`, while
dynamic loop-control local binding/assignment guard synthesis lives in
`src/frontend/static_loop/expand_dynamic_binding.ts` and skipped-step fallback
synthesis and guarded struct/union/function value dispatch lives in
`src/frontend/static_loop/fallback.ts`. Call-result inference/inlining for
skipped-step helper calls lives in `src/frontend/static_loop/fallback/app.ts`,
branch-selected function fallback normalization lives in
`src/frontend/static_loop/fallback/function.ts`, and aggregate/type fallback and
guarded aggregate value construction lives in
`src/frontend/static_loop/fallback/aggregate.ts`, with declared field typing in
`src/frontend/static_loop/fallback/field.ts`, guarded aggregate value
construction in `src/frontend/static_loop/fallback/guarded.ts`, recursive type
fallback construction in `src/frontend/static_loop/fallback/type_fallback.ts`,
typed fallback environments in `src/frontend/static_loop/fallback/typed_env.ts`,
and shared fallback shapes in `src/frontend/static_loop/fallback/types.ts`. This
keeps that helper weight out of `src/frontend/static_loop.ts` and the fallback
dispatcher. Frontend static expression lowering and static `i32` evaluation
lives in `src/frontend/static_expr.ts`, with the main lowerer supplying dynamic
fallback, lookup, and field/index resolution hooks. Frontend static-expression
hook composition and static-expression adapter glue live in
`src/frontend/lower_static_expr_adapter.ts`, keeping static-expression hook
wiring out of `src/frontend/lower_graph.ts`. Frontend const-known expression and
block analysis lives in `src/frontend/const_known.ts`. Frontend
visible-parameter specialization analysis lives in
`src/frontend/visible_params.ts`, with root-name checks, dependency scanning,
and collection-iteration scanning split under `src/frontend/visible_params/`,
keeping call-site aggregate/text deferral traversal separate from source
semantic lowering. Frontend deferred aggregate and visible-text value detection
lives in `src/frontend/call_deferred.ts`. Frontend const/runtime call argument
specialization checks and argument binding live in `src/frontend/call_args.ts`,
with call specialization supplying annotation, inference, deferred-value, and
environment hooks. Frontend call-target and dynamic function-branch target
resolution lives in `src/frontend/call_target.ts`, with the call-specialization
hook contract in `src/frontend/call_specialize_types.ts`, reusable target
wrappers in `src/frontend/call_resolve.ts`, call specialization predicates in
`src/frontend/call_specialize_decision.ts`, dynamic function-branch argument
checks in `src/frontend/call_dynamic_args.ts`, const/runtime call inlining in
`src/frontend/call_inline.ts`, and call-result union inference in
`src/frontend/call_union_result.ts`. Call-specific unresolved linear-effect
scanning, including frontend-known method allowances, lives in
`src/frontend/call_linear_effect.ts`; `src/frontend/call_specialize.ts` remains
the specialized Ic application facade. Frontend expression type inference keeps
`src/frontend/infer.ts` as the facade, with hook contracts, primitive/builtin
inference, runtime-struct field/index inference, app-result inference,
field/index access inference, control-flow inference, block statement inference,
statement-result inference, and the main expression dispatcher split under
`src/frontend/infer/`; the main lowerer supplies text, struct, union, and index
resolution hooks. Frontend expression-to-Ic dispatch lives in
`src/frontend/expr_lower.ts`, with the shared hook contract in
`src/frontend/expr_lower_types.ts`, binding/lambda/linear lowering in
`src/frontend/expr_lower_binding.ts`, and app/field/index lowering in
`src/frontend/expr_lower_access.ts`. Primitive, numeric-operand, and text
identity/equality lowering live in `src/frontend/expr_primitive.ts`; pure-Ic
ownership-wrapper eligibility and erasure live in
`src/frontend/expr_ownership.ts`; the main lowerer supplies specialization,
builtin, struct, union, text, index, and recursive-call hooks. Frontend
statement sequencing, binding/assignment shadowing, static statement-loop
expansion, statement-level `if`/`if let`, and non-final expression erasure live
in `src/frontend/stmt.ts`, with the main lowerer supplying expression, type,
annotation, loop, index-assignment, and value-resolution hooks. Statement
binding dispatch, const binding, assignment, and index-assignment shadowing live
in `src/frontend/stmt/binding.ts`, runtime binding branches live in
`src/frontend/stmt/runtime_binding.ts`, and shared binding-body continuation
lowering lives in `src/frontend/stmt/binding_body.ts`. Frontend const/runtime
value preparation, including union-constructor normalization, struct update
rebuild validation, deferred const-call capture, and extension base capture,
lives in `src/frontend/prepare.ts`, with the main lowerer supplying struct,
union, call, and capture hooks. Frontend compile-time value and block evaluation
lives behind the `src/frontend/eval.ts` facade, with shared hook types in
`src/frontend/eval/types.ts`, expression-value evaluation in
`src/frontend/eval/value.ts`, statement/block evaluation in
`src/frontend/eval/block.ts`, and simple-block foldability in
`src/frontend/eval/simple.ts`. The main lowerer supplies annotation, call, loop,
index-assignment, type, and value-resolution hooks. Frontend compile-time
expression and extension-field resolution lives in
`src/frontend/const_resolve.ts`, with the main lowerer supplying const-builtin,
const-call, static-index, simple-block, and index-resolution hooks. Frontend
const-resolution hook composition and const-resolution adapter glue live in
`src/frontend/lower_const_resolve_adapter.ts`, keeping const builtin and const
expression/field resolver wiring out of `src/frontend/lower_graph.ts`. Frontend
`if` expression lowering lives in `src/frontend/if_expr.ts`, with the main
lowerer supplying branch inference, dynamic struct/union reshaping, and nested
Ic-lowering hooks. Dynamic function-valued `if` Ic lowering lives in
`src/frontend/if_function.ts`; shared direct-lambda selection helpers for
dynamic function-valued branches live in `src/frontend/function_if.ts`, so
ordinary dynamic `if` and function-valued dynamic `if let` use the same
parameter annotation and alias rules. Frontend dynamic union-if branch selection
and handler orchestration live in `src/frontend/if_let_dynamic.ts`, with the
known-union facade in `src/frontend/if_let.ts`; function-valued dynamic `if let`
Ic lowering lives in `src/frontend/if_let_function.ts`; shared `if let`
type/default/handler helpers live in `src/frontend/if_let_common.ts`, and
handler-encoded union-result lowering lives in
`src/frontend/if_let_union_result.ts`. Union-result case inference lives in
`src/frontend/if_let_union_infer.ts`, handler-encoded union result construction
helpers live in `src/frontend/if_let_union_value.ts`, and shared union-case
equality checks live in `src/frontend/union_cases.ts`. Dynamic union-if target
discovery through captures, blocks, deferred calls, specialized calls, and
aliases lives in `src/frontend/if_let_target.ts`, with hook/type shapes in
`src/frontend/if_let_types.ts`. Frontend statement sequencing, static
statement-loop expansion, statement-level `if`/`if let`, and non-final
expression erasure live in `src/frontend/stmt.ts`; shared statement hook types
live in `src/frontend/stmt/types.ts`; and binding, assignment, index-assignment,
and deterministic binding-body shadowing live in `src/frontend/stmt/binding.ts`,
with runtime binding cases in `src/frontend/stmt/runtime_binding.ts` and shared
binding-body continuation lowering in `src/frontend/stmt/binding_body.ts`.
Call-only runtime lambda defer scanning lives in
`src/frontend/stmt/call_only_defer.ts`, tail-use validation lives in
`src/frontend/stmt/call_only_defer_scan.ts`, and linear-expression detection
lives in `src/frontend/stmt/linear_contains.ts`, keeping that scanner weight out
of the binding lowerer. Frontend reserved linear effect detection lives in
`src/frontend/linear_effect.ts`, separate from path-sensitive statement
validation in `src/frontend/linear_stmt.ts`, loop-body validation and carried
loop-state merging in `src/frontend/linear_stmt_loop.ts`, expression consumption
in `src/frontend/linear_expr.ts`, branch/condition merge helpers in
`src/frontend/linear_expr/branch.ts`, shared expression-consumption types in
`src/frontend/linear_expr/types.ts`, and carried-state helpers in
`src/frontend/linear_state.ts`; `src/frontend/linear.ts` remains the public
facade. Frontend local/aliased/simple-block/static-branch linear closure
tracking lives in `src/frontend/linear_closure.ts`, linear closure
alpha-renaming is exported through `src/frontend/linear_closure_rename.ts`, with
parameter compatibility/canonicalization in
`src/frontend/linear_closure_rename/params.ts` and the expression/statement
rename walker in `src/frontend/linear_closure_rename/walk.ts`, and closure-name
collection lives in `src/frontend/linear_closure_names.ts`. Frontend structural
type-pattern/fact-checker validation lives in `src/frontend/type_patterns.ts`,
with the main lowerer supplying the compile-time expression resolver hook.
Frontend dynamic branch lowering keeps `src/frontend/dynamic_branch.ts` as the
public facade, with shared hook/result shapes in
`src/frontend/dynamic_branch/types.ts`, dynamic struct/`if let` branch reshaping
in `src/frontend/dynamic_branch/struct.ts`, and dynamic union branch
handler-value lowering in `src/frontend/dynamic_branch/union.ts`. The dynamic
struct branch facade delegates to `src/frontend/dynamic_branch/struct/if.ts`,
`src/frontend/dynamic_branch/struct/if_let.ts`, and
`src/frontend/dynamic_branch/struct/helpers.ts` so dynamic `if`, dynamic
`if let`, and shared nested-struct shaping stay decoupled. The main lowerer
still supplies inference, value-resolution, and Ic-lowering hooks. Frontend
dynamic-branch hook composition and dynamic-branch lowerer adapter glue live in
`src/frontend/lower_dynamic_branch_adapter.ts`, keeping dynamic branch hook
wiring out of `src/frontend/lower_graph.ts`. Frontend tail-recursion validation
lives in `src/frontend/rec_validate.ts`. Static-rec lowering lives in
`src/frontend/rec.ts`, static-rec statement/block traversal and expected-type
block alias handling live in `src/frontend/rec_block.ts`, with shared block
lowerer types in `src/frontend/rec_block/types.ts`, binding/assignment updates
in `src/frontend/rec_block/binding.ts`, and static-rec `if`/`if let` statement
dispatch in `src/frontend/rec_block/branch.ts`. Static-rec result-expression
dispatch lives in `src/frontend/rec_result.ts`, static-rec primitive lowering
lives in `src/frontend/rec_prim.ts`, expected-type helper lowering lives in
`src/frontend/rec_type_lower.ts`, bound non-lambda app lowering lives in
`src/frontend/rec_bound_app.ts`, struct-value result lowering lives in
`src/frontend/rec_struct_value.ts`, the shared static-rec hook contract lives in
`src/frontend/rec_hooks.ts`, recursive target/argument binding lives in
`src/frontend/rec_bind.ts`, static-rec `if` branch lowering lives in
`src/frontend/rec_if.ts`, dynamic struct-valued static-rec `if` field selection
lives in `src/frontend/rec_if_struct.ts`, static-rec union/`if let` lowering
lives in `src/frontend/rec_union.ts`, with dynamic union `if`, rec-aware
`if let`, and union-result `if let` application split under
`src/frontend/rec_union/`. Static-rec union handler application and
case-to-handler Ic helpers live in `src/frontend/rec_union_handlers.ts`,
static-rec union case-shape inference lives in
`src/frontend/rec_union_infer.ts`, static-rec expression inference dispatch
lives in `src/frontend/rec_infer.ts`, field/index result typing lives in
`src/frontend/rec_infer/access.ts`, statement/block inference lives in
`src/frontend/rec_infer/block.ts`, shared recursive inference callback shapes
live in `src/frontend/rec_infer/types.ts`, and shared static-rec helpers live in
`src/frontend/rec_util.ts`, with static-rec lower-graph hook assembly in
`src/frontend/lower_static_rec_adapter.ts` and the main lowerer supplying
environment, type, static-loop, and Ic-lowering hooks. Frontend annotation hook
shapes live in `src/frontend/annotation_types.ts`, annotation type and numeric
resolution live in `src/frontend/annotation_resolve.ts`, direct struct/union
annotation context lives in `src/frontend/annotation_context.ts`, and binding
annotation checks live in `src/frontend/annotation_check.ts`;
`src/frontend/annotations.ts` keeps runtime binding annotation application and
assignment type selection as the public facade, with the main lowerer supplying
value-resolution and static-lowering hooks. Frontend annotation hook composition
and annotation adapter glue live in `src/frontend/lower_annotation_adapter.ts`,
keeping binding/type annotation wiring out of `src/frontend/lower_graph.ts`.
Frontend const-call inlining delegates lexical expression substitution to
`src/frontend/substitute.ts`, keeping shadowing rules for params, blocks, loops,
and `if let` payload names out of the semantic lowering pass. Frontend parser
token navigation lives in `src/frontend/parser_cursor.ts`, parameter and
annotation parsing lives in `src/frontend/parser_params.ts`, aggregate
field/type-pattern parsing lives in `src/frontend/parser_aggregate.ts`, block
parsing lives in `src/frontend/parser_block.ts`, conditional expression parsing
lives in `src/frontend/parser_conditional.ts`, primary expression parsing and
balanced unsupported-text consumption live in `src/frontend/parser_primary.ts`,
expression arrow/precedence/unary/postfix parsing lives in
`src/frontend/parser_expr.ts`, and host-import target and ownership-contract
interpretation lives in `src/frontend/parser_host_import.ts`. Parser support
rules for reserved keywords, builtin type-reference names, module-function
normalization, operator precedence, and struct-value starts live in
`src/frontend/parser_support.ts`. Frontend source parsing remains the public
facade in `src/frontend/parser.ts`, while program and statement dispatch live in
`src/frontend/parser_stmt.ts`, binding/import statement helpers live in
`src/frontend/parser_stmt/binding.ts`, and statement-level `if`/`if let`/`for`
parsing lives in `src/frontend/parser_stmt/control.ts`.

Implemented and verified:

- `let`, `const`, `comptime`, `=`, `:=`, closures, returns, `if`, no-else `if`,
  no-else scalar `if let` expressions with typed `i32`/`i64` zero fallbacks,
  no-else text `if`/`if let` expressions with `""` fallback, no-else
  struct/union `if` and `if let` expressions with synthesized Ic-safe field or
  case fallbacks, dynamic no-else `if` fallthrough, nested block return
  propagation before later fallthrough statements, known-case `if let` including
  runtime payloads and frontend-known field/static-index projections, rejection
  of known non-i32 conditions before Ic lowering, `&&`, `||`, static `rec`,
  static-rec bodies with static loops and const parameters, and Core dynamic
  tail-recursive loop lowering.
- Unsuffixed integer literals as current `Int`/`i32` values plus explicit
  `i32`/`i64` suffixes, with i64 arithmetic, comparisons, dynamic selects, and
  dynamic indexing preserving the value type. Runtime `I64` binding and
  parameter facts retag parse-time-default numeric primitives to i64 operations
  in both frontend Ic lowering and structured Core WAT emission, including
  chained arithmetic whose intermediate primitive was parsed before the operand
  facts were known, dynamic branches whose result type depends on those retagged
  primitives, no-else expression fallback zeros that inherit an inferred `I64`
  branch result, no-else text fallbacks that materialize `""`, and no-else
  aggregate fallbacks that synthesize field-wise struct values or union cases.
- Const functions with binding-time capture environments, const parameters,
  specialization, reification of const values, scalar runtime parameter
  annotation checks, frontend annotated unknown runtime bindings and arguments
  through scalar/text/struct/union Ic paths, same-type reassignment preserving
  explicit frontend runtime type context for unknown values, static-rec
  preservation of that context for annotated `Text`, struct, and union
  parameters and rec-local bindings including text length, byte indexing, and
  `get`, struct projection, struct indexing, struct `get`, dynamic scalar/text
  `if` results, dynamic struct `if` result/projection/index lowering, dynamic
  statement-level `if`/`if let` fallthrough including typed union `if let`
  fallthrough inside dynamic static-rec branch inference, dynamic union `if let`
  result handler application through direct, deferred const-call, and inlineable
  runtime closure-call targets, dynamic struct index-assignment rebuilds, and
  dynamic union `if let` payload branches, known runtime text/struct/union type
  facts through unannotated frontend helper-call specialization, structured Core
  preservation of closure parameter annotations with built-in static-call
  parameter checks and direct struct/union parameter context, and const
  functions with loops/assignments. Simple const block values can resolve to
  union cases and type-values before Ic lowering. Dynamic ordinary function
  branches, including simple aliases to known closures, eta-expand to Ic lambdas
  when their applied bodies produce scalar or text-pointer results, preserve
  matching, one-sided, and alias-equivalent parameter annotations in selected
  closure branches, reject known incompatible selected-branch call arguments,
  recover i64 selected bodies from parameter/capture facts, and calls through
  those branches inline back to dynamic `if` expressions for frontend-known
  struct and union consumers.
- Binding annotations for built-in scalar/type checks and fact-checker checks,
  structured Core built-in scalar/type binding annotation validation, structured
  Core direct type annotation context for visible struct/union type-values,
  struct and union type-values, simple Core const aliases to visible type-values
  and builtin type names, frontend binding-time type-alias capture inside type
  fields and destructuring patterns, frontend non-final compile-time-only
  expression statement elision before Ic lowering, simple Core const
  type-constructor instantiation including curried calls, generic type
  constructors, typed constructors, direct annotation context for shorthand
  aggregate values and dynamic typed union-if branches, declared case payload
  context for shorthand object values in typed union annotations, structural
  builtins, destructuring fact checkers, runtime struct parameter and
  typed-union parameter fact-checker annotations, and `with` extensions with
  binding-time field capture.
- Pure linear functions and `let`/`const` bindings, pure specialized calls with
  linear parameters, pure explicit capability-function calls through
  const-specialized dependency objects, frontend-known method-style capability
  calls over linear receiver bindings and direct specialized known-capability
  arguments without treating ordinary object function fields as
  implicit-receiver methods, path-sensitive linear validation, module functions
  from explicit dependency objects, source-file import loading, and capability
  narrowing checks.
- The module layer emits and validates Wasm function imports, imported function
  exports, a single Wasm memory, and active data segments, with WAT-to-Wasm
  integration tests for host imports and initialized memory.
- Static range loops, static collection loops over const-known aggregate values,
  typed runtime structs, frontend-visible text bytes, and visible aggregate or
  concrete visible `Text` arguments specialized into closures that field-select,
  index, update, call `len`/`get`, or iterate their parameters, runtime-index
  `get` and bracket indexing over const-known aggregate values and typed runtime
  structs with runtime scalar/text payloads, typed runtime struct `len`, static
  `break`/`continue` including pure linear loop-edge rebinding, specialized
  runtime closure calls that preserve binding-time capture environments, typed
  pure union handler lowering for dynamic `if let` with numeric and text-pointer
  results, source-level erasure for unused runtime bindings, explicit Ic sharing
  for repeated runtime bindings, parameters, and free names, Ic cleanup for
  one-sided duplications, primitive superposition propagation for unary memory
  loads, pure struct-update expressions by rebuild, frontend-known aggregate and
  typed runtime struct index assignment by rebuild including runtime scalar/text
  payloads and visible text fields, dynamic typed struct `if` field selection,
  dynamic frontend-known object `if` field selection, same-case dynamic typed or
  locally inferred shorthand union `if` payload selection as handler-encoded
  values, standalone inferred shorthand union cases as one-case Ic handler
  lambdas including unknown runtime payloads, different-case dynamic typed or
  locally inferred shorthand union `if` as handler-encoded Ic values including
  unknown runtime payloads, different-case dynamic typed union `if` consumed by
  numeric/text-pointer `if let` including `Text` payloads used by `len` and
  named-struct payloads used by field access, including shorthand object
  payloads resolved from declared union-case context and typed unknown
  union-value branches matched by dynamic `if let`, including annotated helper
  calls that return dynamic `if` values over typed union parameters, i64 select
  retagging after direct handler-encoded union application, dynamic union
  `if let` expressions that produce handler-encoded union results through direct
  targets, deferred const-call results, inlineable runtime closure calls, and
  dynamic `if` branches whose union cases are produced by inlineable identity or
  constructor helper calls, inferred union case tables for unannotated
  union-result `if let` expressions preserved into later `=` shadowing checks,
  typed union case tables preserved through direct and simple block-bodied
  inlineable helper returns into `if let`, static-rec application of those bound
  handler-encoded union results, locally inferred shorthand dynamic union cases
  consumed by `if let` both directly and through statically bound dynamic `if`
  values, through deferred const-call results, and through inlineable runtime
  closure calls that return dynamic union values, binding-time payload capture
  for bound union cases, known union cases through frontend-known
  field/static-index projections, frontend-known object/typed-struct dynamic
  `if let` field-wise Ic value lowering, simple block-local frontend-known text
  values in visible text operations, simple block-local frontend-known struct
  and union values, simple const block union values and type-values, simple
  block-local dynamic union-if values consumed by `if let`, known runtime
  text/struct/union type facts through unannotated frontend helper calls,
  deferred const-call aggregate results consumed by field/index access, typed
  struct and frontend-known object values as Ic handler lambdas, text literals
  as length-prefixed UTF-8 data pointers, visible text concatenation with
  WAT-to-Wasm memory coverage, static visible text byte indexing including
  selected-branch traps for dynamic visible text branches, visible text equality
  and inequality over literals and dynamic visible branches, static slices and
  named `append` over literals and dynamic visible branches, bound visible slice
  and append results feeding later `len`/index/equality/nested visible
  operations, static and dynamic-union `if let` text results preserving visible
  facts through bindings, inlineable unannotated helper-returned visible
  `append`, `slice`, text `if`, and text `if let` results feeding later
  equality, rejection of text-typed values in numeric primitive operands outside
  fully visible text concatenation/equality and rejection of other known
  non-numeric values before primitive Ic lowering, dynamic text `if` by
  data-pointer selection, dynamic indexing and index assignment over visible
  text fields by data-pointer selection, `len`, byte indexing, and `get` over
  frontend-visible text values, dynamic visible text branches, and dynamic
  indexes over visible text fields, compile-time layout helpers, `fail`,
  `panic`, and explicit `result_type`-style unions.
- A minimal `Source -> Core` structured path preserves dynamic range loops,
  unknown collection loops, and unknown index assignments with carried-variable
  facts before Ic/Wasm codegen.
- `Core.emit` lowers `panic("...")` to WAT `unreachable`, with WAT-to-Wasm
  runtime trap coverage.
- `Core.emit` applies static and dynamic index assignments to statically bound
  object/struct shapes by capturing runtime index and value expressions in
  hidden locals as needed, with WAT-to-Wasm coverage. Visible `Text` update
  values stay available to later text operations after dynamic index assignment
  and shadowing. Inlineable static closure calls clone captured static aggregate
  shapes and static aggregate arguments before applying those index-assignment
  rebuilds.
- `Core.emit` rebuilds static-shaped struct update expressions and captures
  runtime update values in hidden locals, with WAT-to-Wasm coverage.
- `Core.emit` snapshots runtime field values, union payloads, and dynamic
  aggregate/union `if` bindings when binding or assigning statically shaped
  values, so later shadowing does not change the aggregate value, with
  WAT-to-Wasm coverage.
- `Core.emit` merges compatible static-shaped struct and visible text
  assignments across statement-level dynamic `if ... else` branches, preserving
  the selected static fact with WAT-to-Wasm coverage.
- `Core.emit` lowers scalar `i32` range loops to WAT `block`/`loop` control
  flow, evaluating start, end, and step once, rejecting statically zero steps,
  trapping dynamically zero steps, and supporting no-else `if`, statement-level
  dynamic `if ... else` assignment branches, `break`, and `continue`, with
  WAT-to-Wasm instantiation tests.
- `Core.emit` lowers scalar dynamic tail recursion to WAT `block`/`loop` control
  flow by carrying recursive parameters in locals and updating them before
  branching back to the loop, with WAT-to-Wasm instantiation tests. Source-level
  annotated dynamic tail recursion now reaches the same structured route through
  `Source.wat` without internal `rec(...)` tail calls being reported as host
  imports. Named source `let rec` lambdas also lower to this Core `rec`
  representation when every recursive self-call is in tail position; non-tail
  named fixpoints remain on the Ic fixpoint bridge and reject on the structured
  Core route.
- `Core.emit` lowers static collection loops over literal, statically bound, or
  compatible dynamic `if` object/struct shapes by unrolling fields, scalarizes
  field/static-index access through those bindings, lowers `len`/`get` calls
  over those shapes, and lowers dynamic aggregate index expressions over
  homogeneous fields through structured typed `if` chains with trap fallbacks.
  It also lowers direct or simple const-call dynamic statically shaped aggregate
  `if` collection loops, static-call block bodies with local carried values and
  collection loops, direct dynamic statically shaped aggregate `if` field/index
  access, and same-case dynamic union `if` payload selection through `if let`.
  Dynamic union-if `if let` lowering works for direct and statically bound
  shorthand or typed-constructor union branches, with loop-local item/index
  bindings and `break`/`continue` edges covered by WAT-to-Wasm instantiation
  tests.
- `Core.emit` lowers visible text and runtime values known to have type `Text`
  to Wasm `block`/`loop` control flow over length-prefixed UTF-8 data, with
  item/index locals and `break`/`continue` edges covered by WAT-to-Wasm
  instantiation tests. Range-loop WAT emission now lives in
  `src/core/range_loop.ts`; static aggregate and `Text` collection-loop WAT
  emission lives in `src/core/collection_loop.ts`, with the backend adapter
  supplying the semantic hooks for static facts and nested expression/statement
  emission.
- `Core.emit` lowers static `if let` statements and expressions over literal or
  statically bound shorthand and typed-constructor union cases by emitting
  matching bodies and payload local bindings, with WAT-to-Wasm coverage for
  matching and non-matching cases.
- `Core.emit` materializes typed scalar/`Text`/`Unit` and static-shaped struct
  union values as heap objects with an `i32` tag, scalar/text-pointer payload
  slots, union-pointer payload slots, or packed nested struct-field slots, and
  `i32` pointer result for direct typed constructors and direct dynamic `if`
  branches over typed union cases, with WAT-to-Wasm memory inspection coverage.
- `Core.emit` statically inlines simple const-call results that produce dynamic
  union `if` values when they are consumed by `if let`, with WAT-to-Wasm
  coverage and captured condition locals preserving value semantics.
- `Core.emit` keeps type-level const bindings available to static Core analysis
  including simple const aliases to visible type-values and builtin type names,
  while validating and then eliding destructuring `type_check` statements from
  generated WAT, with WAT-to-Wasm coverage.
- The frontend validates and elides non-final expression statements proven to be
  compile-time-only, including type-values and `with` extension expressions,
  before Ic lowering; final type-value program results still fail as non-runtime
  values.
- `Core.emit` instantiates simple const type constructors returning struct/union
  type-values, including curried calls, before WAT emission, with WAT-to-Wasm
  coverage.
- `Core.emit` validates built-in scalar/type binding annotations during Core
  static analysis before WAT emission and rejects unsupported Core binding
  annotations explicitly, with WAT-to-Wasm coverage for valid annotated
  bindings.
- `Core.emit` preserves closure parameter annotations and checks built-in
  scalar/type parameter annotations while inlining static Core calls. Direct
  struct/union type-value parameter annotations also provide static call
  argument context, with WAT-to-Wasm coverage.
- `Core.emit` treats known `let` closures as inlineable static call targets,
  snapshots scalar runtime captures into hidden locals at binding time, and uses
  hidden parameter/block-local names for statement-bodied inline calls. It has
  WAT-to-Wasm coverage for text collection loops inside such closures,
  closure-local parameter assignment, caller-safe local shadowing, and
  later-shadowed scalar captures. `Core.mod` lowers first-class scalar closures
  with annotated scalar parameters by emitting environment-pointer closure
  values, lifted functions, function-table elements, a heap pointer global, and
  `call_indirect`; closure allocation lives in `src/core/closure_emit.ts`,
  closure layout/type registration lives in `src/core/closure_lift.ts`, lifted
  function WAT emission lives in `src/core/closure_lift_emit.ts`, closure type
  discovery and call argument validation are isolated in
  `src/core/closure_type.ts`, and runtime-capture discovery and static capture
  snapshots are isolated in `src/core/closure_capture.ts`, with unused
  capture-free runtime-local traversal removed from that module. Captured
  first-class closure pointers and closures returned from scoped static calls
  keep their callable signatures, including returned closures with annotated
  `I64` parameters/captures stored in 8-byte-aligned environment slots. Static
  text-layout scanning enters annotated lambda/rec bodies with scoped
  scalar/text parameter facts so those returned closure environments can be
  discovered before WAT emission. Selected first-class closure branches can
  derive one-sided `Int`/`I32`, `I64`, and `Text` parameter facts from the
  annotated branch, and Core tracks `Text` parameter facts separately from plain
  `i32` so `Int`/`Text` branch mismatches fail before WAT emission. Same-type
  assignment to captured scalar names lowers as per-call closure-local shadowing
  for both inlined static closures and first-class closure environments.
  Sequential type-changing shadowing freshens to new Core locals before WAT
  emission, including closure-local shadows. Runtime locals hidden inside
  captured static text values are captured into first-class closure environments
  before lifted closure emission. Inlineable static closures that index-assign
  captured statically shaped aggregates clone those aggregate shapes per call
  before rebuild. Runtime locals known to have type `Text` lower byte index
  assignment to bounds-checked `i32.store8`, including lifted first-class
  closure bodies and captured runtime `Text` locals inside first-class closure
  environments, with WAT-to-Wasm mutation and trap coverage. Stored runtime
  aggregate pointers with known struct layouts now support top-level scalar,
  `Text`, union-pointer, and inline nested aggregate index assignment through
  checked memory stores, including static offset stores, dynamic index branch
  chains, out-of-bounds traps, and rejection for mixed dynamic target field
  kinds. The same store path now works when the runtime aggregate pointer is
  captured by inline and first-class closures. Static/frozen-shareable text
  bindings now stay immutable static data, `borrow` and `freeze` over already
  shareable text preserve static text recognition, and indexed mutation through
  those bindings rejects with a deterministic frozen/shareable diagnostic.
  Broader array/slice mutation, frozen unique-heap store facts beyond current
  freeze-promotion reservations, and reusable allocator/destructor cleanup
  remain reserved.
- `Core.emit` applies direct struct/union type-value binding annotation context
  to shorthand object values, union-case values, and dynamic union-if branch
  values whose cases belong to the annotated union, with WAT-to-Wasm coverage.
  Visible `Text` payloads from those dynamic union values remain visible to
  later `if let` text operations after shadowing. Frontend dynamic union
  branches preserve explicitly named struct payloads and shorthand object
  payloads resolved through declared union-case context before Ic lowering, and
  Core dynamic union-if `if let` lowering keeps those payloads as branch-local
  static aggregate facts, with field access covered through WAT-to-Wasm.
- `Core.emit` materializes typed scalar/`Text`/`Unit` and static-shaped struct
  runtime union values as heap tag/payload objects and preserves typed
  union-pointer facts across annotated runtime bindings, first-class
  closure-call results, direct union-pointer payloads, and nested static-shaped
  struct payload fields, so stored pointer `if let` matches lower to tag and
  scalar/text-pointer, union-pointer, or struct-field payload loads, with
  WAT-to-Wasm coverage. The frontend also resolves nested runtime struct field
  types through annotations, so typed dynamic union payloads such as
  `user.name.first` remain visible to `Text` operations before Ic lowering.
- `Core.data` and `Core.emit` lower Core text literals to length-prefixed UTF-8
  module data pointers, with WAT-to-Wasm memory coverage.
- `Core.data` and `Core.emit` lower visible Core text concatenation to
  length-prefixed UTF-8 module data pointers, including dynamic indexes over
  visible text fields, with WAT-to-Wasm memory coverage.
- `Core.emit` lowers runtime `Text` concatenation to heap-allocated
  length-prefixed UTF-8 text by storing the combined byte length and copying
  both operands with structured Wasm loops. Simple static-call text results are
  also visited during data-layout collection so folded text has a data segment,
  with WAT-to-Wasm coverage. The runtime text WAT helpers are split into
  `src/core/runtime_text.ts`, `src/core/runtime_text/types.ts`,
  `src/core/runtime_text/plan.ts`, and `src/core/runtime_text/copy.ts`.
- `Core.emit` lowers `len` over visible text literals, bindings, dynamic text
  branches, and dynamic indexes over visible text fields to UTF-8 byte lengths,
  with WAT-to-Wasm coverage. It also lowers `len` over runtime values known to
  have type `Text` to an `i32.load` from the length prefix.
- `Core.emit` lowers static and dynamic byte indexes over visible text values
  and runtime values known to have type `Text` to UTF-8 byte values with
  out-of-range traps, with WAT-to-Wasm coverage.
- `Core.emit` lowers `get(text, index)` over visible text and runtime values
  known to have type `Text` to the same UTF-8 byte-index path, with WAT-to-Wasm
  coverage for in-range values and out-of-range traps.
- The frontend lowers `len` over runtime values known to have type `Text`
  through Ic/Expr to `i32.load` from the length-prefixed text pointer, with
  WAT-to-Wasm coverage.
- The frontend lowers byte indexes over runtime values known to have type `Text`
  through Ic/Expr to bounds-checked `i32.load8_u(pointer + 4 + index)`, with
  WAT-to-Wasm coverage for in-range values and out-of-range traps.
- The frontend lowers `get(value, index)` over runtime values known to have type
  `Text` through the same bounds-checked byte-load path, with WAT-to-Wasm
  coverage for in-range values and out-of-range traps.
- Static-rec application result typing preserves annotated static-shaped struct
  and nested `Text` fields after the rec call returns, including dynamic struct
  `if` branches with nested static-shaped struct fields.
- Static-rec app lowering can now receive an expected result type from annotated
  bindings and annotated call arguments. Dynamic result branches that are
  otherwise unknown lower through typed scalar/`Text` selects, typed struct
  handler projections, or typed union handlers on the pure Ic route.
- Expected-type pure-Ic lowering now preserves annotation context through simple
  one-expression block wrappers. Annotated bindings and annotated call arguments
  whose value is `{ if flag { input } else { other } }` lower as typed `Text`,
  struct, or union values instead of taking the untyped dynamic-branch path.
- Static-rec union payload bindings preserve user-defined annotation type names,
  so recursive `if let` bodies can project nested struct payload fields and use
  runtime `Text` operations on them.
- The frontend lowers collection loops over frontend-visible text values as
  UTF-8 byte expansion through Ic. Concrete visible `Text` arguments passed to
  closures that index, call `len`/`get`, or iterate the parameter specialize
  before Ic expansion, with WAT-to-Wasm coverage. `Core.emit` lowers collection
  loops over visible text and runtime values known to have type `Text` as
  length-prefixed UTF-8 byte loops, including first-class closure bodies.
- The frontend lowers direct non-escaping local closure calls, including
  parameterized calls, simple local aliases, simple block-local aliases/direct
  block calls, literal-condition static closure branches, and dynamic ordinary
  function branches, including simple aliases to known closures, with
  scalar/text-pointer Ic results plus frontend-known struct/union consumers,
  rejecting incompatible dynamic function branch parameter shapes before generic
  dynamic `if` lowering, and dynamic union-if `if let` expressions whose
  branches return direct non-linear closures with compatible parameter shapes,
  including i64 selected bodies recovered from matching, one-sided, and
  alias-equivalent parameter/capture facts, while validating outer linear-value
  consumption at the call site before Ic reduction.
- The parser reserves excluded language-family keywords such as `class`,
  `trait`, `macro`, `instance`, `extends`, `inherits`, and `where` so they
  produce explicit unsupported diagnostics instead of ordinary identifiers.
- The parser enforces lowercase-leading `snake_case` for source identifiers
  across bindings, parameters, loop binders, linear-value references, field
  access, union cases, `if let` payload binders, type-pattern fields, and
  user-defined type references while preserving builtin type spellings such as
  `Int`, `I64`, `Text`, `Unit`, and `Type`.
- The public frontend route is split between strict pure-Ic lowering and
  structured Core/Wasm lowering. `Source.compile` remains the Ic-only helper,
  while `Source.core`, `Source.mod`, and `Source.wat` accept source text or
  parsed source for structured programs. `Source.core_file`, `Source.mod_file`,
  and `Source.wat_file` expose the same structured route after import
  resolution, while `Source.compile_file` remains the strict pure-Ic file
  helper. Unresolved import diagnostics now point to the file-loading API
  surface for both Ic and structured routes. Ic-only diagnostics for dynamic
  range bounds, unknown collection loops, untyped dynamic `if let`, rec
  values/dynamic rec cases, unknown field access, and unknown index expressions
  or memory-backed index assignment now point to the structured route.
- Remaining memory/generalization work is planned around unique-by-default
  runtime heap values, read-only `borrow` views whose lifetimes are bounded by
  the current block, loop iteration, function call, or `scratch {}` scope,
  explicit `freeze` for immutable shareable values, and `scratch {}` as a
  temporary bump-allocated arena with a return value. The latest baseline
  decision is no GC fallback for `core-3-nonweb`: make the static ownership,
  lifetime, borrow, scratch-escape, freeze/promotion, and cleanup analysis
  precise enough for supported programs, then reject uncertain facts before WAT
  emission. Any managed or Wasm-GC strategy is a separate future backend target.
  Optional longer-lived regions are future explicit owner packages. They may
  reuse scratch/arena lifetime machinery, but must not be inferred from ordinary
  `scratch {}` or introduce implicit managed storage. Scratch reset must be
  emitted on every structured exit edge, and unique heap drop points now lower
  through allocation-linked `__free` calls in the reusable free-list allocator.
  Lowering-created temporaries also need cleanup points from ownership/lifetime
  facts. Allocation sites should record their storage class and escape reason,
  unknown host/import calls should be treated as escaping unless marked as
  bounded-borrow consumers, and scratch-to-heap promotion should be explicit in
  Core rather than an implicit fallback.
- `&expr`, `freeze expr`, and `scratch { ... }` are reserved in the
  frontend grammar and source formatter. Source-to-Core now preserves them as
  explicit ownership nodes, and Core type/emit lowers them transparently for
  integer scalar results, already-shareable static text values, persistent
  runtime `Text` freeze, persistent runtime aggregate freeze, persistent runtime
  union freeze, and persistent first-class closure freeze. Core structural
  analysis passes traverse those nodes for locals, captures, static-call
  substitution, type substitution, stability, and text layout. Direct
  source-to-Ic lowering accepts the same scalar subset plus statically
  visible/shareable text expressions, including visible text bindings, simple
  visible text concatenations, and frontend-known struct/union handler values
  wrapped in `borrow`, `freeze`, or `scratch`. Pure closure values wrapped in
  those forms also erase on the Ic route, while the existing closure lowerer
  still rejects unsupported linear effects. Those safe wrapper expressions now
  preserve their inferred frontend type for `=` shadowing checks, so
  wrapper-bound structs, unions, and closures still reject accidental type
  changes. Immediate scalar text reads over annotated runtime `Text` now also
  erase wrappers on the Ic route, so `len(&message)`,
  `get(freeze message, index)`, and `(scratch { message })[index]` recursively
  lower to the usual Ic memory-read shape without letting the wrapped value
  escape. Wrapper expressions that return a runtime value already known as
  `Text` also erase transparently on the Ic route, matching the unwrapped text
  identity path. Static-call result inference now follows the same
  specialization environment, so `len(identity(input))` can see that a simple
  annotated helper returns runtime `Text` even when the helper body returns that
  text through `borrow`, `freeze`, or `scratch`. Inline-specialized helper calls
  now apply known runtime annotations to otherwise unknown arguments before
  probing visible values, so byte indexing and `get(...)` over those helper
  results can fall through to the existing runtime `Text` Ic load path. Dynamic
  text operations, unknown values, and ownership-bearing heap results still
  reject on that Ic-only route until the full ownership/lifetime analysis can
  prove them pure-Ic lowerable. The first explicit Core ownership fact surface
  now lives in `src/core/ownership.ts`, with facts for `scalar_local`,
  `unique_heap`, `frozen_shareable`, `borrow_view`, and `scratch_backed`; Core
  scalar-only diagnostics use these facts to explain current rejections. Core
  `scratch { ... }` can now return frozen/shareable static text in addition to
  scalar locals, while unfrozen unique heap scratch results remain rejected
  unless an implemented freeze/promotion path produces `frozen_shareable`
  storage. Core `freeze expr` is now accepted for scalar and
  already-frozen/shareable values such as static text. Static-shaped aggregate
  values wrapped in `freeze` remain scalarized/static compiler facts, pass the
  no-GC proof gate, and reject indexed mutation with the frozen/shareable
  binding diagnostic. Persistent `unique_heap text` values can now be consumed
  by `freeze` as immutable shareable storage; frozen runtime text locals carry a
  frozen fact through Core typing/emission/proof contexts and reject later
  indexed mutation. Direct scratch runtime text freeze such as
  `scratch { freeze append(value, "!") }`, block-local scratch text freeze such
  as `scratch { let temp = append(...); freeze temp }`, inlineable
  helper-returned `Text` temporaries, and branch results whose `if` arms each
  freeze runtime `Text` now emit an explicit persistent copy before scratch
  reset and record both the scratch temporary and persistent promotion
  allocation in the no-GC proof. Persistent runtime aggregate, union, and
  closure owners also freeze as immutable shareable storage; direct,
  block-local, and branch-selected scratch closure freeze keep the frozen
  closure on persistent heap storage and can leave `scratch {}` as
  `frozen_shareable`. Scratch-backed aggregate, union, broader closure, and
  remaining text promotion still require future copying work. Core `&expr`
  is also accepted for scalar and already-frozen/shareable values, and bounded
  unique-heap borrows can now be used by immediate read-only consumers such as
  `len(&message)` inside annotated closure bodies. Escaping unique-heap
  borrows still reject. The first Core lifetime policy module now lives in
  `src/core/lifetime.ts`; Core type checking and emission use it to explain
  reserved `borrow`, `freeze`, and `scratch` cases in terms of missing lexical
  borrow tracking, immutable heap copy/promotion, or scratch escape handling.
  `src/core/borrow.ts` and `Core.borrows(...)` now expose deterministic borrow
  edges with source/target lifetime scopes, operand ownership, and lifetime
  decisions. Static Core calls are scanned through their substituted call body,
  so direct calls of unannotated scalar closures can produce function-call-scope
  borrow edges. Annotated closure values are scanned with closure-local
  parameter facts; unannotated escaping closure values are still reported as
  skipped analysis until closure-local inference is available.
  `Core.validate_borrows(...)` and `Core.check_borrows(...)` add deterministic
  validation/throwing gates for rejected borrow edges and skipped closure-body
  analysis, including context-aware allowed decisions for bounded unique-heap
  borrows. Core type checking, expression emission, and module generation now
  run the borrow gate before WAT emission. `src/core/escape.ts` and
  `Core.escape(...)` now expose the first allocation/escape analysis result for
  final Core values, recording ownership, selected storage class, whether the
  value escapes, and the decision reason. `src/core/cleanup.ts` and
  `Core.cleanup(...)` now expose the first cleanup plan for scratch scopes,
  including deterministic scratch scope names, return-value escape facts, and
  fallthrough/`return`/`break`/`continue` reset edges. `src/core/drop.ts` and
  `Core.drops(...)` expose deterministic unique-heap drop and host-transfer
  planning. Drop-plan shared types now live in `src/core/drop/types.ts`, and
  heap-drop/host-transfer step emission lives in `src/core/drop/emit.ts`. Static
  helper-function discovery and parameter matching live in
  `src/core/drop/static_function.ts`; static ownerless-value and
  non-runtime-closure classification lives in `src/core/drop/static_owner.ts`;
  moved-owner, final-escape, host-transfer, and unique-heap classification
  helpers live in `src/core/drop/ownership.ts`; owner-map, scope-name,
  exit-owner, and alias-resolution helpers live in `src/core/drop/state.ts`,
  leaving the main drop module focused on scanning. `src/core/lifetime_scope.ts`
  and `Core.lifetimes(...)` now expose deterministic lexical scopes for
  programs, blocks, loop iterations, function calls, closure environments, and
  scratchpads. Core WAT emission now saves and restores `__scratch_heap` around
  `scratch {}` on normal fallthrough, stores the scratch body result in a
  temporary before reset, emits scratch resets before
  `return`/`break`/`continue` when those control transfers leave the active
  scratch scope, and leaves nested-loop control alone when it remains inside an
  outer scratchpad. `Core.mod` emits the `__scratch_heap` global and memory when
  scratch is used, including scratch inside lifted closure bodies.
  `src/core/drop.ts` and `Core.drops(...)` now expose deterministic unique-heap
  drop facts for straight-line owner replacement, discarded unique expressions,
  final-result escape, scope-exit drops, and `return`/`break`/`continue` exits.
  Terminal expression branches do not also report false fallthrough drops, and
  branch assignments to existing unique owners merge into the outer owner state.
  Branch-local owners and closure-local owners inside closure bodies now produce
  deterministic drop facts at their boundary. The runtime now uses a reusable
  free-list allocator, so linked `reusable_free_list_allocator` drop steps emit
  `__free` calls at their cleanup anchors. Direct named-owner discards and
  direct named-owner moves through static aliases now produce drop facts without
  forcing static owner values through runtime expression typing.
  Compile-time-only `const` values, including type values and const
  type-constructor results, stay in the static drop-analysis context and do not
  create runtime owners or require runtime expression typing. The borrow plan
  now rejects named-owner and simple-local-alias move/replacement, index
  mutation, and `freeze` while a bounded borrow is active in the same lexical
  scope. Stored borrow-view locals are now accepted when bounded to the current
  block, protect their owner while live, and reject returning, storing, or
  closure-capturing the view. Branches and loops that assign a stored borrow
  view into an outer name merge that view fact back to the parent scope, so
  owner mutation or view escape after the merge is rejected. Direct field/index
  borrows and simple field-owner aliases now canonicalize back to the containing
  owner, so replacing `user` after `borrow user.name`, replacing `user` after
  `let name = user.name; borrow name`, or mutating through the field alias while
  the borrow is live rejects. Field-owner aliases assigned through branches,
  `if let` bodies, or loop bodies into an outer local are also merged into the
  parent borrow state; if the local may alias multiple containing owners, a
  later borrow protects each possible owner. Expression-valued `if` and `if let`
  results that return field aliases also preserve every possible containing
  owner for later borrow barriers. Expression-valued `if` and `if let` results
  that return stored borrow views now preserve those possible views and protect
  their owners after the binding. Multi-statement block results that return
  field aliases or stored borrow views also carry that ownership fact to the
  outer binding. Field aliases assigned through block-prefix `if`, `if else`,
  `if let`, and loop statements are joined into the returned block result as
  possible containing owners. Broader borrow escape enforcement, full runtime
  aggregate memory ownership, nested aggregate alias chains, explicit
  freeze/promotion codegen, reusable allocator/destructor lowering, and cleanup
  planning for lowering-created temporaries remain pending. Direct
  block-expression owner result moves such as `{ f }`, discarded `{ f }`,
  `let g = { f }`, and block-local owner results are covered by the current drop
  plan. The same drop plan now treats `freeze` of direct named, block-result,
  and branch-result unique owners as consuming the source owner, including
  discarded, bound, block-wrapped, branch-local, returned, and self-shadowed
  freeze expressions. Optional statement branches containing `freeze`, including
  no-else `if` and typed `if let` bodies, now avoid runtime typing of static
  owner values and produce conditional cleanup facts for paths where the branch
  may not run; linked retained-path owners emit `__free` through the reusable
  free-list allocator. `src/core/proof.ts`, `Core.proof(...)`, and
  `Core.check_proof(...)` now expose an explicit `core-3-nonweb` no-GC proof
  harness with managed storage disabled. It aggregates final-result escape
  facts, borrow validation, explicit `freeze` edges, scratch cleanup/reset
  facts, unique-owner drop facts, and lifetime scopes. Accepted scalar/scratch
  fixtures and scalarized static-shaped aggregate fixtures expose the facts WAT
  emission would use, including allowed `freeze` edges over scalarized
  static-shaped aggregates and scratch-return edges for scratch-free
  static-shaped aggregate results, and rejected unique-heap `freeze` or
  scratch-return fixtures produce deterministic proof issues rather than
  selecting a GC fallback. Static-shaped aggregate values, aggregate updates,
  and extension objects are now treated as ownerless compiler facts in the
  drop/proof path, matching the current scalarized Core/Wasm representation.
  Static-call-only unannotated `lam` and `rec` values are also treated as
  ownerless compiler call targets, while annotated runtime closures still
  produce unique-heap drop facts when materialized. Drop-analysis type-value
  probing is non-fatal for ordinary static function calls, so specialized static
  runtime calls are not mistaken for type-constructor applications. Annotated
  closure bodies are now pre-collected for drop/proof local facts, covering
  closure-local accumulators and collection-loop item/index locals. Static
  shorthand union cases, ownerless static union `if` values, and
  static/dynamic/runtime `if let` payload branch contexts are now covered by the
  proof path. The inline Core proof audit now passes for every typed snippet;
  deliberately unsupported unknown collection-loop bodies are skipped by drop
  analysis because emission still rejects them before WAT. `Core.emit(...)` and
  `Core.mod(...)` now run `Core.check_proof(...)` before producing WAT/module
  artifacts, while `Core.type(...)` remains a type-query surface rather than the
  WAT emission gate. Persistent heap-backed aggregate, union, and closure freeze
  is implemented; direct, block-local, and branch-selected scratch closure
  freeze are implemented; block-local scratch aggregate alias promotion is
  implemented for supported known-layout fields; block-local scratch runtime
  union alias promotion is implemented for scalar/`Text`/`Unit`, union-pointer,
  and supported aggregate-pointer payloads. Actual immutable heap copy/promotion
  for static-shaped existing aggregate aliases is implemented, and
  branch-selected plus branch-assigned existing runtime union aliases preserve
  payload facts through scratch freeze. Dynamic loops that would carry static
  aggregate/union facts now reject until loop-specific promotion facts exist.
  Broader existing owners, broader closure shapes, and remaining text shapes are
  still pending. Expression-level `if` and `if let` owner results are now
  path-sensitive: non-selected owners drop in branch scopes, while the selected
  owner is moved, escaped, or discarded by the surrounding context. These are
  baseline static-analysis tasks: the compiler should make ownership, borrow,
  scratch escape, and cleanup facts precise enough for supported programs, then
  reject uncertain cases before WAT emission. `scratch {}` is the MVP
  region-like construct with a value result, but it does not return a live
  attached region after reset; escaping results must be scalar, frozen,
  promoted, proven scratch-free, or rejected. GC/Wasm-GC remains a future
  separate backend target rather than a fallback. Direct use of a static-shaped
  struct as a runtime value now materializes a standalone
  `unique_heap runtime_aggregate` pointer through the shared `__closure_heap`,
  while existing static field/index scalarization remains allocation-free.
  Closure-valued `if let` expressions in structured Core now reuse first-class
  closure storage over direct dynamic union-if targets and stored runtime-union
  pointer targets. Matching branches may capture the bound payload in the lifted
  closure environment, fallback branches call indirectly through the else
  closure, and one annotated branch can establish the signature for an
  unannotated branch. WAT-to-Wasm coverage validates both matching and fallback
  stored-runtime-union cases through `call_indirect`. Frontend same-type `=`
  shadowing now compares function parameter shape instead of accepting every
  `fn` tag as equivalent. Arity, `const`/linear flags, and annotation shape must
  match; parameter names may differ, and built-in integer annotation aliases
  normalize together. Known struct field-type facts now participate in frontend
  same-type `=` shadowing as well, so same-field structs with incompatible
  payload types reject before Ic lowering. Anonymous object literals now
  contribute shallow field-type facts when every field has a simple known type,
  so typed-to-anonymous and anonymous-to-anonymous struct shadows are guarded
  before Ic lowering too. Shorthand union cases now contribute simple payload
  facts as well, so `.ok(1)` cannot be same-type shadowed with `.ok("text")`.

The first host/import proof and codegen slices are implemented for Task 12.2:
`Core.host_imports` can describe scalar, bounded-borrow, frozen/shareable, and
ownership-transfer argument contracts. `Core.host_boundaries(...)` and
`Core.proof(...).host_boundaries` report matched signatures and per-argument
decisions before WAT emission, `Core.drops(...)` records `host_transfer` facts
for consumed direct unique owners, `Core.proof(...)` reports direct
use-after-transfer issues, and `Core.mod(...)` emits known host imports and
direct calls. Bounded-borrow imports accept explicit `&owner` views.
Ownership-transfer imports accept direct `unique_heap` arguments and reject
borrowed views. Host-returned owner contracts are implemented for Core import
results, including proof-visible signatures, owned final-result escape facts,
scope-exit drops for bound unique results, and WAT import calls. Unknown
`unique_heap`, `borrow_view`, and `scratch_backed` boundary arguments reject
with diagnostics that name the missing bounded-borrow or ownership-transfer
contract. Frozen/shareable Core import arguments now have proof and WAT fixture
coverage. Scratch-backed Core import arguments now classify bounded-borrow views
as call-bounded reads and reject ownership transfer before WAT emission.
Source-level host import declarations now lower scalar numeric ABI signatures
and ownership contracts to the same Core `host_imports` surface:
`bounded_borrow Text`, `ownership_transfer Text`, `frozen_shareable Text`,
non-Text pointer owner reasons such as `runtime_aggregate`, `runtime_union`, and
`closure`, user-defined aggregate/union type-value owner references such as
`bounded_borrow user_type`, `ownership_transfer result_type`, and
`unique_heap user_type`, and host-returned `unique_heap` or `frozen_shareable`
pointer owners. `Source.core(...)` resolves preceding top-level `const` struct
type-values to `runtime_aggregate` and union type-values to `runtime_union`,
including simple const aliases, while missing or non-type owner references
reject before Core emission. Pure Ic lowering rejects those declarations with a
structured Core/Wasm route diagnostic, while `Source.wat(...)` emits the WAT
import and call. Source-to-Core context state, name aliasing, and host-import
owner type-value tracking now live in `src/core/from_source/context.ts`;
host-import argument and result contract conversion lives in
`src/core/from_source/host_import.ts`. Statement lowering, carried-name
discovery, recursive binding lowering, and source `if`-block statement
conversion now live in `src/core/from_source/stmt.ts`; expression lowering,
host-import method-call rewriting, parameter/field/type-field conversion, and
block-body discovery now live in `src/core/from_source/expr.ts`.
`src/core/from_source.ts` remains the public Source-to-Core program facade. The
first interprocedural transfer slice is implemented for direct calls to
top-level statically bound lambda wrappers with variable arguments; wrapper
calls now record caller-owner `host_transfer` drops and reject later use of the
transferred owner. Single-expression block-bodied wrappers such as
`let send = msg => { host_take(msg) }` are covered by the same proof/drop path.
Multi-statement block-bodied wrappers such as
`let send = msg => { let code = host_take(msg); code }` are now covered by the
same transfer/drop path. Closure-returning helper bodies are skipped by the
transfer-only drop scan so ordinary first-class closure helpers are not probed
as transfer wrappers. Branch-selected top-level wrappers with annotated closure
branches, such as
`let send = if flag { (msg: Text) => host_take(msg) } else { (msg: Text) => host_take(msg) }`,
now record branch-scoped caller-owner `host_transfer` facts, reject later use of
the transferred owner, and compile through WAT-to-Wasm `call_indirect`.
Top-level ownership-transfer wrappers now also accept unique temporary
expression arguments such as `send(append("a", "b"))`; transfer validation
records a synthetic temporary owner, drop planning records an ownerless
`host_transfer` step, and the wrapper call compiles through WAT-to-Wasm. Static
wrapper transfer validation now proves aliased non-variable arguments before
recording synthetic transfers: branch-created runtime text temporaries are
accepted as `unique_heap`, while scalar named or temporary arguments reject
before WAT emission with an invalid transfer-argument diagnostic. Branch-local
wrapper definitions such as
`if flag { let send = msg => host_take(msg); send(message) }` are now visible to
later statements in that lexical analysis scope, record caller-owner transfer
facts, and reject use-after-transfer after branch merges. Statically bound `rec`
wrapper values such as `let send = rec (msg: Text) => host_take(msg)` now use
the same proof/drop path, record caller-owner `host_transfer` facts, reject
use-after-transfer, and compile through WAT-to-Wasm. Const function-parameter
higher-order wrappers such as `let relay = (const f, msg) => f(msg)` can now
receive a statically bound transfer wrapper, preserve that argument as a static
function during scoped static-call typing/emission, record the nested
caller-owner `host_transfer`, reject use-after-transfer, and compile through
WAT-to-Wasm. Remaining work is deeper transfer analysis for dynamic or more
general higher-order wrappers, truly self-recursive transfer shapes, plus any
future scratch-backed promotion policy that intentionally crosses the host
boundary.

Latest task update: the memory/lifetime queue is locked to the no-GC baseline.
If a case cannot prove ownership, lifetime, borrow/view validity, scratch
escape, freeze/promotion, host-boundary behavior, and cleanup/drop/reset facts
before WAT emission, split it by value category and escape shape or reject it
with a deterministic diagnostic. The next implementation slices remain
field-sensitive scratch escape for heap-backed aggregate/union payloads, cleanup
for lowering-created temporaries, deeper interprocedural transfer analysis, and
proof-gating or linearizing reserved closure captures. Accepted baseline
fixtures should keep `managed_storage: "disabled"` or an equivalent no-GC
profile marker visible in the proof output, including cases for compiler-created
temporaries and scratchpad returns. Per-slot closure capture ownership is now
proof-visible through `Core.closure_ownership(...)` and
`Core.proof(...).closure_ownership`: scalar and frozen/shareable captures are
allowed, selected runtime aggregate pointer, runtime union pointer, and closure
pointer captures report their supported decisions, and every reserved
closure-capture slot now rejects through the baseline proof gate before WAT
emission. Remaining closure work is to explicitly accept more reusable/frozen
capture classes or implement real linear closure calls. Named arenas,
attached-region return packages, reusable allocators, destructors, managed GC,
and Wasm-GC stay future explicit profiles.

Latest task refinement: Task 12 now has a final no-GC implementation roadmap.
The order is proof inventory gate, unique heap ownership by default,
`borrow`/view checking, lexical value-returning `scratch {}` scratchpads,
explicit `freeze`/promotion, cleanup for source values and lowering-created
temporaries, storage-driven linear participation, and only then future explicit
region or managed-storage profiles. The immediate slices are temporary cleanup
facts, field/payload-sensitive scratch escape proofs, broader explicit
freeze/promotion copies, closure capture linearization or rejection, and deeper
host/import transfer analysis.

Latest implementation slice: discarded runtime aggregate materialization now
participates in the drop plan. A discarded aggregate expression records an
ownerless `heap_drop` on `discarded_expr` with `unique_heap runtime_aggregate`,
so the cleanup proof matches the runtime aggregate allocation fact and anchors
its reusable-allocator `__free` emission. This covers direct aggregate
construction and static aggregate facts that are materialized by expression use
before being discarded.

Latest proof-gate slice: unsupported Core codegen nodes now participate in
`Core.proof(...)`. Covered shapes now include unknown `collection_loop`
statements, preserved unknown field/index expressions, and preserved unsupported
`if let` expression/statement targets. Final unsupported app expressions are
also proof-gated before Core type inference, as are final direct or named
type-level Core values. They produce `unsupported_codegen` proof issues and fail
in `Core.check_proof(...)` before Core typing or `Core.emit(...)` reaches the
WAT fallback.

Latest host-transfer slice: higher-order ownership-transfer wrappers now handle
local static function aliases inside the wrapper body. A shape such as
`let relay = (const f, msg) => { let g = f; g(msg) }` preserves `g` as a static
function alias through scoped static-call local collection, transfer validation,
drop planning, and WAT emission, so the nested `host_transfer` is proof-visible
and use-after-transfer still rejects before codegen. This shape now also has
WAT-to-Wasm runtime coverage through the host import.

Latest task split update: Task 12 now turns the no-GC memory decision into seven
implementation slices: proof inventory gating, lowering-created temporary
cleanup, field/payload scratch-escape proofs, explicit freeze/promotion copies,
borrow/view barriers, closure capture ownership, and deeper host/import transfer
analysis. Each slice should land as an accepted proof fixture plus the nearest
rejected diagnostic fixture. The baseline remains `core-3-nonweb` with no GC
fallback; hard cases are split by value category and escape shape.

Latest memory model clarification: the baseline mix is unique ownership, lexical
borrow/views, value-returning `scratch {}` scratchpads, explicit `freeze` into
immutable shareable values, storage-driven linear analysis, and proof-driven
cleanup for source values and lowering-created temporaries. `scratch {}` is the
MVP temporary arena, not a hidden live region. Optional longer-lived regions are
future explicit owner packages with tied values, cleanup/drop facts, and
move/consume rules; they do not act as a fallback for uncertain scratch escapes.
The default backend still skips GC by making the analysis precise or rejecting
before WAT emission. Each memory slice should now close as one of three states:
accepted with proof facts, rejected with a deterministic diagnostic, or deferred
to a future explicit region/managed-storage profile.

Latest scratchpad/no-GC task update: there is no active baseline GC task. Hard
scratchpad returns, temporary cleanup, closure captures, aggregate/union
payloads, runtime text buffers, and host-boundary shapes must be handled by
static proof rows, explicit freeze/promotion, deterministic rejection, or a
future explicit profile. Cleanup for compiler-created temporaries is now part of
the same acceptance gate as cleanup for source values: each temporary needs a
storage class, lifetime end, and cleanup/transfer/no-cleanup decision before WAT
emission. Optional longer-lived regions remain explicit owner-package work and
are not inferred from ordinary `scratch {}` results.

Current no-GC implementation rule: do not open a collector task to finish the
baseline memory model. If a lifetime, scratch escape, closure capture, aggregate
payload, text buffer, host boundary, or temporary cleanup case is too broad to
prove, split it by storage class and escape path until it has one of three
outcomes: accepted with visible proof rows, rejected with a deterministic
diagnostic naming the missing fact, or deferred to an explicit future
region/managed-storage profile. The immediate work remains static analysis:
unique ownership, lexical borrow/views, frozen/shareable values, value-returning
scratchpads with reset, storage-driven linear participation, and proof-driven
cleanup insertion.

Intentionally reserved or still incomplete:

- General dynamic structured-loop codegen, unknown dynamic `if let` outside
  typed/direct union-if or the implemented inlineable helper-call/closure-call
  union-result shapes, memory-backed index assignment beyond runtime `Text`
  bytes and runtime aggregate scalar/`Text`/union-pointer/inline nested fields,
  general first-class linear closure captures, unknown runtime collection
  codegen, mutable collection fact checking/codegen, runtime union payload
  storage/matching outside the implemented scalar, `Text`, `Unit`,
  union-pointer, and aggregate-pointer struct payload cases, runtime text/string
  operations outside the supported visible literal/concat/equality/data-pointer
  cases and runtime `Text` length, byte-load, `get`, byte assignment,
  collection-loop, and Core runtime concat/freeze/scratch-promotion subset,
  runtime capability-object method tables beyond the implemented host-import
  scalar token-threading slice, frontend aggregate memory/codegen
  representation, general array, slice, frozen unique-heap memory-backed index
  mutation beyond current freeze-promotion reservations, and broader
  structured-core/Wasm codegen. These have been split into implementable
  follow-up tickets in
  [12-remaining-generalization-tasks.md](12-remaining-generalization-tasks.md).

Latest capability-method slice: `Source.core`/`Source.wat` now accept an
import-backed scalar linear method call when the field name has a matching
`host_import`. A source shape such as `io = io.print("hello")` rewrites to
`io = print(!io, "hello")`, emits a Wasm import call, and preserves existing
linear validation for discarded returned capabilities. Core `linear` expressions
now type and emit as consuming local reads; frontend/source validation remains
the exact-use gate. Missing imported method facts on linear receivers now reject
before WAT emission with `Missing host capability method: receiver.method`,
including the same shape inside lambda bodies.

Latest first-class linear capability-closure slice: a runtime-selected closure
value with a linear `!io: I32` parameter can now be stored as a closure pointer
and called through `call_indirect`, while a nested non-escaping closure in its
body consumes the linear parameter through an import-backed method call. Text
literals inside static/const function bodies used as runtime closure values are
now included in Core text data layout before WAT emission. Stored closures that
capture a source `!` value are consumed after one call; duplicate calls, alias
calls after consumption, and branch paths that disagree about closure
consumption now reject before Core/WAT emission. Branch-selected stored closures
that capture a source `!` value are accepted when both branches have compatible
closure parameter shape; both branch literals are laid out, the selected closure
calls through `call_indirect`, and duplicate/alias calls after consumption still
reject. Compatible branch closures may now use different branch-local parameter
names because the frontend alpha-renames both branch bodies into fresh shared
parameter names before validation/lowering. General closure-environment storage
that moves source `!` values into heap-stored closures remains pending.
Closure-valued `if let` expressions now participate in the same validation path
for scalar closures: static union cases can reduce on the pure Ic path, and
runtime-union-pointer branches lower through the Core closure table and
`call_indirect` when the captured linear value and bound payload are scalar.
Dynamic static-union `Text` payload branches now also preserve payload text
facts and host import contracts through local collection, so lifted closures can
call bounded-borrow host imports with `borrow value` and compile through
WAT-to-Wasm. Stored runtime-union-pointer `Text` payload branches now preserve
the selected payload through allocation/proof scanning too, so lifted closures
can capture `borrow value`, emit the runtime union payload load, and call the
bounded-borrow host import through WAT-to-Wasm.

Latest proof-gate refinement: frozen/shareable indexed mutation now reaches the
baseline no-GC proof surface before module emission for runtime aggregate
pointers, using the same deterministic frozen/shareable binding diagnostic as
the emitter. The regression covers `Core.proof`, `Core.check_proof`,
`Core.emit`, and `Core.mod`.

Latest unsupported-codegen refinement: stored closures with captured assignment
shapes outside the currently supported scalar/text/aggregate/static rebuild
cases now reject through `Core.proof(...)` as `unsupported_codegen` before
closure lifting or module emission. The regression covers `Core.proof`,
`Core.check_proof`, `Core.emit`, and `Core.mod`.

Latest host-boundary proof refinement: invalid host-returned owner contracts,
such as an owned pointer result declared with a non-`i32` Wasm result type, now
reject through `Core.proof(...)` as `unsupported_codegen` before module
emission. The regression covers `Core.proof`, `Core.check_proof`, `Core.emit`,
and `Core.mod`.

Latest cleanup proof fixture: discarded runtime union materialization now has
explicit proof coverage for its persistent `unique_heap runtime_union`
allocation and ownerless `discarded_expr` drop fact. This keeps the accepted
temporary-cleanup slice visible through `Core.proof(...)` before WAT emission.

Latest allocation proof refinement: bound typed runtime union owners now record
the persistent `unique_heap runtime_union` allocation fact that corresponds to
their `scope_exit` drop fact. Untyped shorthand union facts remain static and do
not acquire heap allocation facts.

Latest closure cleanup proof fixture: bound, discarded, and scalar-capturing
closure values now have proof coverage that pairs persistent closure allocation
facts with their `scope_exit` or `discarded_expr` drop facts and allowed scalar
capture ownership before WAT emission.

Latest closure-capture proof fixture: every current `unique_heap` capture reason
is now explicitly classified by the closure ownership proof gate. Runtime
aggregate, runtime union, and closure-pointer captures are accepted with proof
decisions; unique text captures still reject unless frozen/shareable first.
Runtime aggregate pointer captures now also assert Core type and WAT
`call_indirect` plus captured field loads.

Latest host-boundary wrapper proof refinement: source-level bounded-borrow host
imports now preserve proof edges through expression-bodied and simple
block-bodied static wrappers. `read(borrow message)` records the underlying
`bounded_borrow` decision, while `read(message)` rejects before WAT emission
because a direct `unique_heap Text` owner cannot cross a bounded-borrow
boundary. Annotated wrappers that create a local view, such as
`let read = (msg: Text) => { let view = borrow msg; host_read(view) }`, now
record the same bounded-borrow edge for `read(message)`; replacing the local
view with a plain alias still rejects the direct unique owner. Statically bound
recursive wrappers such as `let read = rec (msg: Text) => host_read(msg)` now
preserve the bounded-borrow edge for `read(borrow message)` and reject
`read(message)`. Branch-selected annotated wrappers such as
`let read = if flag { (msg: Text) => host_read(msg) } else { (msg: Text) => host_read(msg) }`
now record a bounded-borrow edge for each possible branch when called with
`borrow message`, and reject each branch when called with the direct unique
owner. Higher-order const-function helpers such as
`let relay = (const f, msg: Text) => f(borrow msg)` now preserve the same
bounded-borrow edge when called as `relay(read, message)`, while the same relay
without `borrow` rejects the direct unique owner. Local static-function aliases
inside those helpers, for example `let g = f; g(borrow msg)`, now preserve the
same borrow and host-boundary facts; the matching `g(msg)` shape rejects instead
of silently missing the host boundary. Branch-selected wrappers with
alpha-renamed parameters, such as `message` in one branch and `text` in the
other, now bind call arguments per branch before scanning host-boundary facts.

Latest task decision checkpoint: the task queue now treats no-GC as the baseline
acceptance rule. Hard lifetime cases should be split until they have static
proof facts, explicit freeze/promotion, or a deterministic rejection; they
should not be accepted by adding collector-backed cleanup. `scratch {}` remains
a value-returning temporary scratchpad, optional longer-lived regions remain
future explicit owner packages, and first-class closure environments now fall
under the same storage contract: persistent `unique_heap`, `frozen_shareable`,
`scratch_backed`, or rejected, with per-slot ownership and cleanup/drop facts
before WAT emission.

Latest memory task update: Task 12 now spells out the implementation rule for
that baseline. Each slice starts by classifying storage, attaching lifetime ids,
checking lexical borrows, proving scratch-result escape before reset, and
inserting cleanup/drop/reset decisions from the same proof facts. Missing rows
mean split the feature into a smaller accepted/rejected/deferred fixture; hidden
region attachment, implicit promotion, runtime-discovered cleanup, GC, managed
storage, and Wasm-GC remain outside the baseline.

Latest cleanup proof fixture: runtime text temporaries now have explicit
proof-inventory coverage. Discarded `append(...)` and `slice(...)` results, plus
bound runtime `Text` owners produced by either operation, assert managed storage
is disabled, expose persistent `unique_heap text` allocation facts, and match
those facts to `discarded_expr` or `scope_exit` drop rows before WAT emission.

Latest scratch text promotion slice: annotated aliases of scratch-backed runtime
`Text` temporaries now carry layout-time text facts through promotion. A shape
such as
`scratch { let temp: Text = append(...); let alias: Text = temp; freeze alias }`
records the same no-GC allocation and freeze proof rows as direct bound scratch
promotion and compiles through WAT-to-Wasm.

Latest scratch text block-result slice: block-local runtime `Text` results now
carry text facts through scratch promotion. A shape such as
`scratch { let temp: Text = { let inner: Text = append(...); inner }; freeze temp }`
records the scratch allocation, persistent freeze allocation, and no-GC proof
edge, and compiles through WAT-to-Wasm.

Latest borrow-control-flow slice: Core borrow analysis now treats definite
sequence exits as reachability barriers for borrow/view scans, closure-capture
borrow-view scans, and field-owner alias scans. Stored borrows or field aliases
after an unconditional `break`, `continue`, or `return` no longer make later
owner mutation reject, while borrows assigned before a loop `break` are still
merged into the parent as possibly live.

Latest annotated scratch text slice: Core text facts now see through
`scratch { ... }` in the same way they already see through `freeze` and block
results. Annotated bindings such as
`let result: Text = scratch { let temp: Text = append(...); freeze temp }` now
type-check, preserve text facts for later `len(result)`, and compile through
WAT-to-Wasm. The unfrozen annotated shape still rejects before emission because
scratch-backed unique text cannot leave the scratch scope.

Latest expression-transfer wrapper slice: ownership-transfer drop analysis now
uses a wrapper's annotated closure context when scanning static transfer
targets, while preserving the older caller-context fallback for unannotated
wrappers. A shape such as
`let send = (msg: Text) => host_take(append(msg, "!"))` now records the appended
runtime `Text` temporary as an ownerless host transfer and compiles through
WAT-to-Wasm.

Latest transfer proof-gate refinement: generic wrapper templates with `const`
function parameters are skipped by ordinary runtime drop-body scanning, while
transfer validation now scopes ordinary lambda and `rec` body scans through the
annotated closure-body context. This keeps captured runtime `Text` index
assignment closures and higher-order alias ownership-transfer wrappers accepted
by the no-GC proof gate before WAT emission.

Latest branch-selected static-wrapper slice: branch-valued higher-order generic
ownership-transfer wrappers now lower as static call branches when both arms
provide compatible `const`-parameter static call targets. A shape such as
`let relay = if flag { (const f, msg: Text) => { let g = f; g(append(msg, "!")) } } else { ... }`
preserves the local static-function alias, records one possible host transfer
per branch for the temporary `Text`, and compiles through WAT-to-Wasm. Ordinary
branch-selected closures without `const` parameters remain runtime/first-class
values.

Latest task-doc memory update: Task 12 now starts with a compact chosen-model
snapshot. The baseline is unique ownership for runtime heap values, lexical
`borrow`/view syntax, value-returning `scratch {}` scratchpads, explicit
`freeze` into immutable shareable storage, proof-driven cleanup for source
values and lowering-created temporaries, and storage-driven linear analysis.
Optional longer-lived regions remain future explicit owner packages, and GC or
managed storage remains outside the default `core-3-nonweb` baseline. Hard cases
must be split into accepted proof fixtures, deterministic rejections, or future
explicit profiles.

Latest scoped static-call proof slice: `Core.proof(...)` now enters scoped
static-call bodies when collecting cleanup and freeze proof facts. A helper call
whose body returns `scratch { ... freeze ... }` now reports the final
`frozen_heap` result, scratch reset edge, and freeze edge before WAT emission,
matching the direct scratch/freeze expression proof surface.

Latest closure scratch cleanup proof slice: `Core.cleanup(...)` and
`Core.proof(...)` now scan closure bodies with closure-local context. Accepted
closures containing `scratch {}` expose the scratch reset and scratch-return
cleanup facts before lifted closure WAT emission.

Latest closure freeze proof slice: `Core.proof(...).freeze_edges` now scans
runtime closure bodies with the same closure-local context. Runtime-selected
closures that return `scratch { freeze ... }` expose both branch freeze edges,
while direct static helper definitions avoid duplicate definition-site and
call-site proof rows.

Latest scoped static-call allocation proof slice: allocation proof now follows
statement-scoped static helper call bodies at the specialized call site. Inlined
helpers no longer report synthetic closure allocation facts when WAT does not
materialize a closure environment, but their body text/aggregate/union
allocation facts remain visible.

Latest scoped static-call drop proof slice: drop proof now follows the same
statement-scoped static helper rule. Inlined helpers keep real body drop facts,
such as assignment replacement drops inside the helper body, without reporting a
synthetic helper closure scope-exit drop when no closure environment is emitted.

Latest scratch static block setup slice: static aggregate/union scratch returns
with block-local runtime captures now emit their setup under scratch reset
tracking. Frozen runtime captures are preserved as persistent values before the
scratch reset, the returned static aggregate/union facts remain usable after the
scope, and the new aggregate/union fixtures compile through WAT-to-Wasm.

Latest memory task decision record: Task 12 now has an explicit no-GC baseline
checklist for every memory/lifetime slice. The selected model is unique runtime
heap ownership, lexical `borrow` views, explicit `freeze` into immutable
shareable storage, value-returning `scratch {}` scratchpads with reset on every
exit edge, proof-driven cleanup for source values and lowering-created
temporaries, and storage-driven linear participation. Hard cases should be split
into accepted proof fixtures, deterministic rejections, or future explicit
region/managed-storage profiles; they should not be accepted by hidden attached
regions, implicit promotion, runtime-discovered cleanup, or GC.

Latest Task 12.2 proof-inventory update: skipping GC is now expressed as an
analysis-completeness requirement. Every accepted non-scalar memory slice must
expose storage/lifetime, borrow/view, scratch escape/reset, freeze/promotion,
drop/cleanup, and host-boundary rows when relevant before WAT emission. Source
values and lowering-created temporaries use the same inventory; missing rows
mean split the shape into a smaller proof fixture, reject with a named
diagnostic, or defer to a separate future region/managed-storage profile.

Latest dynamic text fallback slice: Core no-else `if` and dynamic `if_let`
expressions that produce `Text` now use an actual empty-text fallback. Text fact
analysis proves the fallback only when the selected branch is text, WAT emission
emits the empty-text pointer instead of raw zero, text layout registers the
empty literal only when needed, and WAT-to-Wasm coverage validates plain `if`
and typed runtime-union `if let` fallback behavior.

Latest static `Text` if-let fallback slice: proof/drop local collection now
applies binding annotations before storing static runtime bindings, so typed
shorthand union cases preserve their `type_expr` outside the normal emission
context. A non-matching no-else static `if let` over a `Text` union payload now
lowers to the empty-text fallback and compiles through WAT-to-Wasm, with the
existing `I64` zero-fallback guard still covered.

Latest runtime union payload ownership slice: direct named
`unique_heap runtime_aggregate` and `unique_heap runtime_union` owners are now
moved when stored as runtime union pointer payloads. `Core.proof(...)` records a
`union_case.*` transfer edge, the moved source owner no longer receives a
separate scope-exit drop, and direct use of that owner after the payload
transfer rejects before WAT emission.

Latest runtime union payload alias slice: simple aliases to moved aggregate or
union owners now resolve to the original owner during payload-transfer
validation. A payload transfer through `alias` records the transfer against the
original owner, rejects later use through either name, and still compiles when
the moved owner is not reused.

Latest runtime union payload wrapper slice: statically bound helper calls with
aggregate/union parameter annotations now carry those parameter facts through
proof scanning. A wrapper that constructs a runtime union pointer payload from
its parameter records the caller owner transfer at the static-call site, removes
the moved owner from drops, rejects use-after-transfer, and still compiles when
the moved owner is not reused.

Latest branch-selected payload wrapper slice: branch-valued wrappers with
aggregate/union parameter annotations now lower as static-call branches for
runtime union payload construction. `Core.proof(...)` records one
`union_case.ok` transfer per possible branch, removes the moved owner from
drops, rejects direct or alias use-after-transfer, and keeps ordinary scalar
branch closures on the runtime first-class closure path.

Latest higher-order payload wrapper slice: runtime union payload transfers now
survive higher-order static wrappers with `const` function parameters, including
block-local static-function aliases such as `let g = f` and branch-valued
higher-order helpers. Scoped static-call union recognition enters those helper
bodies with statement-local facts, records nested `union_case.ok` transfers, and
rejects later use of the moved owner before WAT emission.

Latest task-doc memory refinement: Task 12.2 now frames every hard lifetime case
as a no-GC proof task first: classify storage, attach lifetime ids, validate
borrows, prove scratch escape before reset, plan explicit freeze/promotion, and
insert cleanup/drop/reset facts for source values and lowering-created
temporaries. Missing proof rows mean a smaller accepted fixture, a deterministic
rejection, or a future explicit region/managed-storage profile. Task 12.10 now
splits first-class closure storage into environment layout, environment storage
class, per-slot capture ownership, reusable-vs-linear call behavior, and
proof-visible cleanup/drop facts.

Latest verification passed with 323 tests:

```txt
deno fmt --check main.ts test.ts src docs tasks
deno check main.ts test.ts src/**/*.ts
deno test --allow-read --allow-write --allow-run
```

Latest task-doc memory decision: the remaining memory/lifetime tasks now treat
the no-GC baseline as a proof obligation for each accepted slice. Every
memory-backed value or lowering-created temporary must declare its storage
class, lifetime edge, escape decision, borrow/view state, freeze/promotion edge
when needed, and cleanup/drop/reset fact before codegen broadens. `scratch {}`
remains a value-returning scratchpad whose result is checked before reset;
uncertain scratch escapes, temporary cleanup, closure captures, host boundaries,
or owner moves must split into smaller proof fixtures or reject before WAT
emission. Managed storage, tracing GC, implicit promotion, and hidden attached
regions stay future explicit profiles, not baseline fallbacks.

Latest branch-assigned payload transfer slice: dynamic `if/else` statements that
assign the same runtime union result from aggregate/union pointer payload cases
now preserve the branch-generated payload facts. Matching the result with
`if let` binds the payload as a runtime aggregate/union pointer, WAT emission
can read its fields, `Core.proof(...)` records one `union_case.*` transfer per
branch, and use-after-transfer rejects before module emission. One-sided
conditional moves still need explicit conditional cleanup/drop facts before they
should be treated as a completed branch-transfer shape.

Latest one-sided transfer proof gate: one-sided branch payload transfers no
longer pass the no-GC baseline by accident. If only some branch paths move an
owner into a runtime union payload, `Core.proof(...)` now reports a conditional
cleanup/drop diagnostic and `Core.mod(...)` rejects before WAT emission. The
accepted branch-transfer shape remains the one where every branch path transfers
the owner, with one proof-visible transfer edge per branch.

Latest loop transfer proof gate: collection-loop payload transfers now use the
same conditional cleanup/drop gate. A loop body that moves an owner into a
runtime union payload rejects before WAT emission until loop execution,
carried-owner, and zero-iteration cleanup facts are represented explicitly.
Dynamic range loops that would carry aggregate/union static facts still reject
earlier through the loop-carried fact gate.

Latest scratch text promotion fixture: branch-selected and branch-assigned
scratch-local runtime `Text` values now have explicit no-GC proof coverage and
WAT-to-Wasm coverage. The accepted shapes bind a branch result to `temp` and
freeze it after the branch, or overwrite `temp` inside both branch arms before
freezing. Proof output records scratch-backed branch allocations, persistent
freeze allocation, and replacement-drop rows for overwritten text owners.

Latest loop scratch text promotion fixture: loop-assigned scratch-local runtime
`Text` values now have proof and WAT-to-Wasm coverage. The accepted shape starts
with a scratch-backed `temp`, updates it inside a range loop, freezes it after
the loop, records the loop-scope drop row for the carried text owner, and covers
both zero-iteration and one-iteration results.

Latest collection-loop scratch text promotion fix: collection-loop-assigned
scratch-local runtime `Text` values now compile through WAT-to-Wasm when the
collection comes from runtime aggregate collection facts. Static collection
local collection now scans the loop body once per emitted field, so unrolled
body text-operation helpers and the later freeze-copy helpers are declared
before WAT emission.

Latest if-let scratch text assignment fix: statement-level dynamic `if let`
branches can now overwrite a scratch-local runtime `Text` and freeze it after
the branch sequence. Drop scanning updates local facts as it walks closure/block
statements, so the `if let` payload keeps its `Text` fact during assignment
ownership analysis. `if let` emission now advances generated temp counters
across emitted branches, so WAT local declarations match the freeze copy
temporaries.

Latest task-doc memory gate: Task 12 now names the no-GC acceptance rule as the
analysis-complete gate. A memory/lifetime slice is ready for WAT only when
storage, owner/lifetime ids, borrow barriers, scratch reset/result decisions,
explicit freeze/promotion edges, cleanup/drop/transfer facts, and host-boundary
contracts are proof-visible with `managed_storage: "disabled"`. Missing rows
keep the task active: split the case, add the proof fact, promote/freeze
explicitly, reject before emission, or defer to a future explicit
region/managed-storage profile.

Latest branch-assigned aggregate promotion slice: existing runtime aggregate
aliases assigned in both `if/else` arms can now be frozen through a
scratch-local alias. The static assignment merge accepts compatible aggregate
facts whose fields were captured into compiler-generated temps, so
`scratch { let temp =
existing; freeze temp }` preserves per-field branch facts,
emits the persistent aggregate/text freeze-copy path before scratch reset, and
records the no-GC proof rows with managed storage disabled.

Latest scratch static alias return slice: static-value field/payload capture now
preserves frozen facts on generated locals. Multi-statement `scratch {}` blocks
can return a block-local aggregate or union alias whose reachable text payloads
were frozen inside the scratch scope, while still emitting the scratch reset and
keeping the proof surface at `managed_storage: "disabled"`.

Latest memory/lifetime task split: Task 12 now breaks the chosen no-GC memory
model into concrete implementation slices: ownership fact rows, borrow/view
analysis, scratchpad result gating, explicit freeze/promotion edges,
lowering-created temporary cleanup/drop facts, and future explicit region owner
packages. The baseline remains analysis-complete `core-3-nonweb`: hard lifetime
cases must become smaller proof fixtures, deterministic rejections, or deferred
future profiles, not GC-backed accepted programs.

Latest nested scratch alias boundary: nested block-local static aggregate
aliases inside a scratch-returned aggregate are now covered as a rejected no-GC
proof fixture. Direct scratch-free field/payload aliases remain accepted; the
nested alias shape stays rejected until structural nested planning can keep
local collection, proof, and WAT emission synchronized.

Latest memory-model task update: Task 12, Task 10, and Task 11 now state the
final no-GC baseline in the same terms. Runtime heap values default to unique
ownership; borrows/views are lexical and runtime-free; `freeze` creates
immutable shareable storage; `scratch {}` is a value-returning scratchpad for
temporary shareable computation and never returns a hidden live region. Cleanup
for source values and compiler-created temporaries must come from proof-visible
storage/lifetime facts. If a hard case cannot be proven, the task is to split
it, reject deterministically, or defer it to a future explicit region or
managed-storage profile, not to let GC decide in the baseline.

Latest frontend diagnostic sweep: linear-effect functions that remain outside
the strict pure-Ic frontend now include the structured Core/Wasm route in their
rejection message. The `Source.compile` behavior stays strict, but the
diagnostic now points callers to `Source.core`, `Source.mod`, or `Source.wat`,
matching the compile-target routing task.

Latest dynamic if-let diagnostic sweep: non-scalar dynamic `if let` branch
results that are still outside the strict pure-Ic route now use the same
structured Core/Wasm route diagnostic. Supported scalar, `Text` pointer,
closure, union, and struct shapes keep their existing Ic lowering paths.

Latest implicit-fallback diagnostic sweep: no-else `if` and `if let` expressions
now name the unsupported inferred branch type when an implicit fallback cannot
be synthesized. The strict Ic path supports implicit fallbacks for `Int`, `I64`,
`Text`, structs whose fields all have fallback values, and unions with an
Ic-safe `Unit` or fallbackable payload case; unsupported branch results still
reject with a deterministic fallback diagnostic instead of a generic "cannot
lower yet" message.

Latest dynamic-if diagnostic sweep: dynamic `if` expressions whose branch type
is outside the Ic-selectable set now report the inferred branch type, such as
`Type`, instead of a generic non-`i32` branch diagnostic.

Latest dynamic union-if binding diagnostic sweep: the last generic dynamic-`if`
binding fallback now reports a union-specific pure-Ic diagnostic and points to
`Source.core`, `Source.mod`, or `Source.wat` for structured Core/Wasm lowering.

Latest static-rec diagnostic sweep: static `rec` calls with linear parameters
now reject with a rec-specific pure-Ic diagnostic and the structured Core/Wasm
route, instead of the older generic linear-parameter wording.

Latest compile-time-only diagnostic sweep: final builtin type names, bound type
names, struct types, union types, and extension values now reject with
compile-time-specific pure-Ic messages that explain they cannot be emitted as Ic
results, replacing the older generic "cannot lower yet" wording and runtime
name-casing errors.

Latest untyped dynamic-if-let diagnostic sweep: expression, statement, and
static-rec lowering now share a pure-Ic diagnostic that says dynamic `if let`
needs a typed union target on the Ic route, while still pointing callers to the
structured Core/Wasm route.

Latest ownership-wrapper diagnostic sweep: `borrow`, `freeze`, and `scratch`
wrappers whose result is not pure-Ic lowerable now reject with wrapper-specific
messages and the structured Core/Wasm route, replacing the older misleading
"non-scalar result" wording. The safe erasure path still covers scalars,
statically shareable text, runtime `Text`, structs, unions, and pure closures.

Latest nested scratch proof fix: rejected nested static aggregate aliases inside
a scratch-returned aggregate now reach `Core.proof(...)` as a deterministic
scratch-return proof row. Proof-local collection preserves annotated
struct/union facts long enough for cleanup to report the no-GC rejection, while
normal typing and emission still reject the unsafe scratch return.

Latest scratch-return proof-detail slice: scratch reset cleanup rows now carry
field/payload rejection detail into `Core.proof(...)`. Unsafe static-shaped
scratch returns such as a struct field initialized by scratch-backed
`append(...)` now reject before WAT emission with the offending field path named
in the baseline proof issue, rather than only naming the outer aggregate scratch
escape.

Latest dynamic-if-let function diagnostic sweep: dynamic `if let` branches that
produce function values but have incompatible parameter shapes now reject on the
pure Ic route with a function-branch-specific diagnostic and the structured
Core/Wasm route, instead of the older generic non-scalar branch wording.

Latest static-rec control-flow diagnostic sweep: `break` and `continue` inside
static `rec` bodies now keep the rec-body-specific pure-Ic rejection while also
pointing callers to `Source.core`, `Source.mod`, or `Source.wat` for structured
Core/Wasm lowering.

Latest memory task decision lock: Task 12 now treats "skip GC if analysis can be
made proper" as the active `core-3-nonweb` baseline rule. The implementation
work is to expose missing ownership/lifetime proof facts, split hard shapes into
smaller accepted or rejected fixtures, and keep GC or managed storage only as a
future explicit profile with its own Core representation, ABI, proof surface,
and tests.

Latest static-loop diagnostic sweep: static range-loop expansion with dynamic
break/continue state now gives nested loops and local bindings that need
unsupported Ic fallback values the structured Core/Wasm route in the rejection
message. The structured `Source.core` path still preserves the original range
loop for those cases.

Latest unbound-linear diagnostic sweep: explicit `!name` syntax without a
matching linear binding now rejects as `Unbound linear value: name`, replacing
the broader pure-Ic lowering limitation for that malformed source shape.

Latest static-rec missing-result diagnostic sweep: static `rec` bodies and
nested rec-result blocks that produce no value now reject with missing-result
messages, while preserving the structured Core/Wasm route hint.

Latest rec-value diagnostic sweep: direct or bound static `rec` definitions used
as values now reject with a rec-function-value message, keeping static-rec calls
on the existing pure-Ic lowering path.

Latest dynamic-function linear-parameter slice: pure Ic dynamic function
branches now accept matching linear parameter shapes, validate both branch
lambdas with the existing linear-use checker, and continue rejecting mismatched
linear/non-linear parameter branches.

Latest shorthand-union diagnostic sweep: untyped no-payload shorthand cases such
as `.none` now have explicit regression coverage for the existing inferred
`Unit` case lowering, and the unreachable generic pure-Ic "union case yet"
fallback was removed from that path. Internal visible-text byte-index fallback
errors are now normalized-text invariants instead of source-facing
unsupported-feature diagnostics.

Latest recursive-linear-closure diagnostic sweep: source `!` capture validation
now rejects recursive stored closure calls with the closure binding name, for
example `Cannot validate recursive linear closure call yet: recurse`, instead of
the older unnamed reservation. The shape remains reserved until linear closure
ownership can model recursive self-calls.

Latest memory task clarification: the task queue now treats "skip GC if the
analysis can be made proper" as the selected baseline rule, not as an optional
optimization. Task 12 keeps GC and managed storage out of the active
`core-3-nonweb` queue; hard cleanup, scratch, borrow, aggregate, union, text,
host-boundary, and closure-capture cases must be split into static proof
fixtures, deterministic rejections, or a future explicit managed/region profile.
Task 10 now names the no-GC proof gate as the lowering boundary, and Task 11
excludes collector-decided scratch or temporary cleanup from the MVP grammar.

Latest linear-closure annotation slice: branch-selected stored closures that
capture a source `!` value now use the shared frontend parameter-annotation
compatibility rule. A one-shot closure selected between `(a: Int) => !x + a` and
`(b: I32) => !x + b` lowers through the pure Ic path instead of missing the
captured linear consumption because the annotation names differed.

Latest linear-closure alias slice: the pure Ic source `!` closure validator now
treats non-builtin parameter annotations as potentially compatible before the
real dynamic-function type check runs. Branch-selected stored closures can
consume the same linear value through `user_type` / `user_alias` parameter
annotations, while unrelated user-defined annotations still reject through the
existing compatible-parameter diagnostic.

Latest Core closure aggregate/union parameter slice: first-class closure
function types now preserve user-defined aggregate and union parameter metadata.
Returned branch-selected closures with alias-equivalent `struct` or `union`
annotations can be applied through `call_indirect`, and closure-call validation
checks the aggregate/union argument facts before WAT emission.

Latest static-loop function-binding slice: static range-loop expansion with
dynamic `break`/`continue` state now accepts unused function-valued local
bindings whose branch body type needs call-site specialization, for example
`let f = x => x`. The synthesized fallback function branch is deferred instead
of being lowered immediately, while existing dynamic function branches with
lowerable scalar/text/aggregate/union bodies still lower directly to Ic lambdas.
Calls through that deferred loop-local function from later guarded statements
now inline through the existing dynamic-function-if call path, including
static-true aliases of the loop-control flag, so identity-style calls no longer
leave unreduced `f#...` applications in the Ic graph.

Latest memory-task update: Task 12 now records the current baseline as
analysis-complete no-GC work. Scratchpads are value-returning temporary
allocation scopes with saved-pointer reset; returned values must be scalar,
frozen/shareable, explicitly promoted, or proven scratch-free before reset.
Compiler-created temporaries use the same proof-driven cleanup facts as source
values. Hard lifetime cases now split into narrower proof fixtures,
deterministic rejections, or future explicit region/managed-storage profiles;
they do not become accepted by letting a collector decide cleanup.

Latest static-loop nested dynamic-control slice: pure Ic static-loop expansion
now accepts statically expandable nested range and collection loops after a
dynamic `break`/`continue` state has been introduced. Nested loop statements are
expanded through the normal static-loop expander and guarded by the current
loop-step flag, so a dynamic outer `break` skips the nested work while inner
loop-local control stays scoped to the nested loop.

Latest static-loop const dynamic-control slice: `const` bindings that appear
after dynamic loop-control state now lower through the guarded fallback path
when their value shape is Ic-safe. The generated statement becomes a runtime
`let`, because the binding is path-dependent after a dynamic `break` or
`continue` and cannot remain an unconditional compile-time fact. Regression
coverage includes scalar consts, const function bindings, and nested collection
loops guarded after dynamic outer breaks.

Latest static-rec linear-parameter slice: pure linear `rec` parameters now lower
through the Ic static-rec path when exact-use validation succeeds. Recursive
tail calls such as `rec(!state, n - 1)` carry the consumed linear value forward
during static unrolling, while missing explicit consumption or branch-mismatched
linear use rejects through the shared linear diagnostics.

Latest memory-task gate update: Task 12 now names the active acceptance gate as
analysis-complete no-GC lowering. A memory/lifetime slice reaches WAT only after
storage, lifetime, borrow/view, scratch escape, freeze/promotion, host-boundary,
and cleanup/drop/reset proof rows exist for the values and temporaries it
touches. Hard cases must split into accepted proof fixtures, deterministic
rejected diagnostics, or future explicit region/managed-storage profiles.
`scratch {}` remains a value-returning scratchpad with saved-pointer reset;
optional longer-lived regions require explicit owner packages; GC is not the
baseline fallback.

Latest linear Ic inference slice: explicit linear expressions now infer the type
of their binding when known. Annotated source `!` values can therefore lower
through dynamic Ic `if` selection, return/fallthrough branches, one-shot
captured closure calls across those paths, and dynamic `if let` closure
selection while preserving exact-use validation.

Latest static-rec struct-order fix: static-rec struct-value result lowering now
uses declared field order when lowering a typed struct handler. A rec body that
returns `user_type { score: 2, age: 40 }` now preserves `user.age == 40` after
binding, matching ordinary declared struct lowering.

Latest memory-task refinement: Task 12 now records the scratchpad/no-GC decision
as concrete implementation guidance. Memory work should split broad cases by
storage shape and escape path, then close each slice as accepted with proof
rows, rejected before WAT emission with a named missing edge, or deferred to a
future explicit region/managed-storage profile. Hidden attached regions,
implicit promotion, runtime-discovered cleanup, tracing GC, managed storage, and
Wasm-GC remain outside the accepted `core-3-nonweb` baseline.

Latest dynamic-loop-control inference slice: path-dependent bindings after a
dynamic static-loop `break`/`continue` guard now infer simple block-local scalar
results and ordinary direct-lambda scalar call results. The frontend can
synthesize the skipped-step fallback and keep lowering those shapes through pure
Ic instead of routing them to structured Core/Wasm.

Latest dynamic-loop-control struct-call slice: struct-value recognition now
inlines ordinary direct runtime calls before deciding that a value is not a
frontend-known struct. Path-dependent static-loop bindings such as
`let pair = make(i)` after a dynamic `break` guard can synthesize a skipped-step
typed-struct fallback and still lower field use through pure Ic.

Latest struct block-call resolution slice: simple block-local `let` aliases
whose final value is a direct-lambda typed struct call are now recognized before
speculative const-block evaluation. This lets plain struct field projection and
dynamic-loop skipped-step fallback lower through pure Ic without making runtime
`const` captures legal.

Latest union block-call resolution slice: simple block-local `let` aliases whose
final value is a direct-lambda typed union call now feed the same union-value
resolver used by dynamic-loop skipped-step fallback. Plain `if let` consumption
and guarded loop fallback lower through pure Ic, while block-local runtime
`const` captures still reject.

Latest dynamic-loop annotation fallback slice: skipped-step fallback synthesis
after dynamic static-loop control now uses explicit binding annotations when the
value itself is otherwise unknown. Direct path-dependent bindings such as
`let label: Text = text`, `let amount: Int = value`, and
`let amount: I64 = value` can keep lowering through pure Ic with `""`, `0:i32`,
or `0:i64` fallbacks.

Latest dynamic-loop aggregate annotation fallback slice: annotated unknown
runtime struct and union bindings after dynamic static-loop control now
synthesize Ic-safe skipped-step fallbacks. Struct annotations generate
field-wise guarded values, so `let pair: pair_type = source` can still lower
`pair.first` and `len(pair.label)`, and nested struct annotations project
through paths such as `user.name.first`. Union annotations capture the runtime
source with the declared case table so later `if let` handlers can consume the
dynamic branch.

Latest text literal escape slice: frontend tokenization now accepts `\t` and
`\r` in addition to the existing newline, quote, and backslash escapes. The
source-to-Ic text literal tests now cover newline, tab, carriage return, quote,
and backslash escapes directly.

Latest memory-model lock: the selected baseline remains analysis-complete no-GC
lowering. `scratch {}` is a value-returning scratchpad whose result must be
scalar, already frozen/shareable, explicitly frozen/promoted, or proven
scratch-free before reset. Optional longer-lived regions are future explicit
owner packages with tied values, cleanup/drop facts, and move/consume rules.
Hard scratch, temporary, closure, aggregate, union, text, host-boundary, or
region-lifetime cases should split into smaller proof fixtures, reject before
WAT emission, or defer to an explicit future profile; they do not become
accepted by letting a collector decide cleanup.

Latest memory-task queue update: Task 12 now starts the active no-GC memory work
with a concrete implementation queue: proof-gate audit, ownership and borrow
facts, scratchpad result analysis, explicit freeze/promotion and cleanup
insertion, storage-driven linear participation, and future-only explicit
regions/managed storage. The baseline remains unique ownership plus lexical
borrows/views, frozen shareable values, value-returning scratchpads, and static
cleanup facts; GC is not an accepted fallback while analysis is incomplete.

Latest dynamic-loop no-else union fallback slice: static-loop expansion now
materializes implicit no-else fallbacks inside a binding before wrapping that
binding in the dynamic `break`/`continue` skipped-step guard. A loop-local
`let result = if flag { result_type.ok(...) }` after a dynamic break can now
lower through pure Ic and be consumed by a later `if let`, using the same union
fallback behavior as ordinary no-else bindings.

Latest nested dynamic-union if-let slice: union-result `if let` lowering now
accepts encoded nested dynamic union targets. After dynamic static-loop control,
a loop-local `maybe` union can be guarded by the skipped-step flag and still
feed `let result = if let .some(value) = maybe { result_type.ok(...) }`, with
the result later consumed by another `if let` on the pure Ic route.

Latest typed unit-case constructor slice: typed no-payload union cases now lower
through pure Ic as either `option_type.none()` or `option_type.none`. The field
form resolves only for cases declared as `Unit`; payload cases continue to
require an explicit one-argument constructor call.

Latest ownership-wrapper runtime-struct slice: annotated runtime struct
projection facts now survive pure-Ic `borrow`, `freeze`, and simple
value-returning `scratch` wrappers. Shapes such as `(borrow user).age`,
`(freeze user).age`, and `(scratch { user })[index]` lower through the existing
handler projection path when `user` has a known struct annotation.

Latest ownership-wrapper scalar-context slice: pure-Ic numeric primitive and
`if` condition lowering now erase `borrow`, `freeze`, and simple value-returning
`scratch` wrappers after the scalar context has accepted the operand. Direct
shapes such as `borrow input + 1`, `freeze input == 0`, and
`if scratch { input } { ... } else { ... }` now lower like their unwrapped
scalar forms while top-level unknown wrapper results still route to structured
Core/Wasm.

Latest ownership-wrapper annotated-call slice: annotated runtime parameters now
carry the same wrapper-erasure context across frontend-to-Ic call boundaries.
Direct specialized calls and const-parameter helper calls lower wrapped
arguments such as `borrow input`, `freeze input`, and `scratch { input }` when
the parameter annotation supplies `Int`, `I64`, `Text`, or a declared struct
shape.

Latest memory-task decision update: the task queue now locks in the no-GC
baseline as an analysis-complete proof gate. Remaining memory work should split
hard cases by storage class and escape path until they are accepted with proof
rows or rejected before WAT emission. `scratch {}` stays a value-returning
scratchpad with saved-pointer reset, optional longer-lived regions remain future
explicit owner packages, and cleanup for source values plus compiler-created
temporaries must come from static ownership/lifetime facts. First-class closure
storage follows the same rule: code pointer/table index plus optional
environment pointer, per-slot ownership facts, explicit cleanup/drop or
promotion edges, and no GC fallback for uncertain captures.

Latest ownership-wrapper dynamic-function slice: branch-selected functions now
carry compatible parameter facts through the generic Ic application path. Direct
and bound dynamic function branches erase `borrow`, `freeze`, and simple
value-returning `scratch` wrappers at the call boundary when selected-branch
annotations prove an `Int`, `I64`, `Text`, or declared struct parameter context,
matching the direct specialized-call behavior.

Latest ownership-wrapper static-rec slice: annotated static-rec parameters now
erase captured `borrow`, `freeze`, and simple value-returning `scratch` wrappers
before Ic result lowering. Initial calls such as `loop(borrow input, 2)` and
later tail-recursive arguments use the same annotation-driven boundary as
ordinary specialized calls, covering scalar, `I64`, and `Text` rec parameters.
The dynamic function wrapper coverage also now includes typed union parameter
contexts consumed through `if let`.

Latest ownership-wrapper binding slice: annotated runtime `let` bindings and
same-type assignments now erase `borrow`, `freeze`, and simple value-returning
`scratch` wrappers before pure-Ic lowering when the binding type supplies the
runtime context. This covers scalar, `I64`, `Text`, declared struct projection,
and typed union `if let` consumption, plus the same local binding/assignment
path inside static-rec bodies.

Latest ownership-wrapper branch-context slice: annotation-driven wrapper erasure
now reaches simple block results, scalar/Text dynamic `if` branch results, and
typed struct/union dynamic branch values whose runtime branches are otherwise
unknown. Annotated bindings, same-type assignments, static-rec arguments,
rec-local bindings, direct specialized calls, and branch-selected dynamic
function calls can select between `borrow`/`freeze`/simple `scratch` branch
values and ordinary runtime values before lowering to Ic.

Latest ownership-wrapper no-else aggregate slice: annotated typed struct and
union contexts now keep wrapper erasure when the dynamic `if` omits an explicit
`else`. Bindings and direct typed call arguments such as
`let user: user_type =
if flag { borrow input }`,
`let option: option_type = if flag { scratch {
input } }`, and
`choose(if flag { borrow input })` synthesize annotation-driven fallback fields
or union cases before pure-Ic lowering, while incompatible aggregate annotations
still reject.

Latest ownership-wrapper static-rec aggregate slice: annotated static-rec
parameters now reuse typed aggregate lowering for dynamic wrapper branch
arguments. `loop(if flag { borrow input }, 0)` and
`loop(if flag { scratch {
input } } else { other }, 0)` over declared struct or
union parameters lower by selecting projected fields or union handlers,
including implicit no-else fallback fields/cases, instead of applying a scalar
placeholder to the whole aggregate handler.

Latest static-rec result projection slice: runtime struct type resolution now
recognizes static-rec app result types. Direct results such as `make(0).age`,
`make(0)[0]`, and `get(make(0), 0)` lower through the existing handler
projection path when static-rec inference proves a struct result, and missing
fields keep the deterministic struct-field diagnostic.

Latest typed static-rec result slice: annotated binding and annotated
call-argument contexts now pass the expected result type into static-rec app
lowering. Static-rec apps whose final dynamic branches are otherwise unknown can
lower as `Int`, `Text`, declared struct, or declared union values before
continuing through pure Ic consumers such as `len`, field projection, and
`if let`.

Latest typed block-result slice: expected-type lowering now unwraps simple
one-expression block results, single-return block results, and pure
two-statement alias blocks before typed branch lowering. Annotated bindings,
annotated call arguments, and direct text reads with block-wrapped dynamic `if`
values keep scalar, `Text`, struct, or union context on the pure Ic route.
Struct field projection and union handler selection now keep that expected type
when block-local selected branches contain `borrow`, `freeze`, or simple
`scratch {}` wrappers.

Latest static-rec expected block-alias slice: annotated static-rec result
contexts now preserve expected struct and union types through simple block-local
result aliases. A rec result block can select between `borrow`/`scratch`
branches, return the alias, and still feed typed struct projection or union
`if let` lowering on the pure Ic route.

Latest typed if-let block-alias slice: expected-type lowering now handles typed
union `if let` results directly. Simple block-local aliases such as
`let selected: Text = if let ... { borrow input } else { scratch { other } }`
preserve the expected scalar, `Text`, struct, or union type before pure Ic
lowering.

Latest no-GC task backlog update: Task 12 now spells out the first concrete
fixtures for the selected analysis-first baseline. The initial work order is
borrow/view barriers, scalar and frozen scratch returns, aggregate/union scratch
result gates, lowering-created temporary cleanup, first-class closure storage,
and host/import ownership contracts. Each slice needs an accepted proof fixture
and the nearest rejected diagnostic before codegen broadens; hard cases split by
storage class and escape path instead of becoming GC fallback work.

Latest static-loop skipped-step call slice: dynamic loop-control fallback
synthesis now preserves loop-local lambda parameter annotations when inferring
the result of a call binding. A helper such as `let id = (text: Text) => text`
can be called after a dynamic `break` guard, and the path-dependent result gets
the correct `Text` fallback for later pure-Ic `len(...)` lowering.

Latest memory task harness update: Task 12 now defines the proof-fixture shape
for the no-GC baseline. Accepted memory/lifetime slices must show the
`core-3-nonweb` target, `managed_storage: "disabled"`, storage/lifetime rows,
borrow/view rows, scratch reset and result rows, explicit freeze/promotion rows,
cleanup/drop/reset decisions, host-boundary rows when relevant, and lowered
Core/WAT evidence that consumes those facts. Rejected fixtures name the first
missing proof edge before WAT emission, and deferred fixtures name the explicit
future region or managed-storage profile they require.

Latest static-loop branch-function slice: dynamic static-loop skipped-step
fallback now recognizes branch-selected loop-local function bindings when both
branches are compatible direct lambdas in the current environment. The fallback
eta-expands the selected body, preserves parameter annotations such as `Text`,
and later calls through the binding can still lower through pure Ic instead of
routing to structured Core/Wasm.

Latest static-loop branch-function capture slice: the same branch-selected
function path now substitutes simple non-linear block-local captures from each
branch into the eta-expanded body as captured expressions. This keeps branch
locals such as `let saved: Text = input` or `let offset = i + 1` available to
later calls through the selected loop-local function without leaking unresolved
block-local names into Ic.

Latest static-loop branch-function struct slice: calls through branch-selected
loop-local functions can now return declared struct values after dynamic
`break`/`continue` state. Skipped-step fallback synthesis follows captured
struct type expressions back to declared field types, so a field like
`label: Text` receives the correct text fallback instead of being treated as an
unknown free runtime value.

Latest static-loop if-let function slice: `if let`-selected loop-local function
bindings after dynamic `break`/`continue` state now eta-expand to a single
function whose body keeps the original `if let`. Payload names stay bound by the
existing union-handler path, while compatible parameters and simple branch
captures are normalized so later calls through the binding remain pure-Ic
lowerable.

Latest memory proof-fixture update: Task 12 now turns the selected no-GC memory
model into first fixtures to implement. The initial groups are borrow/view
barriers, scalar and frozen scratchpad results, aggregate/union scratch escape
checks, lowering-created temporary cleanup rows, first-class closure storage,
host/import ownership contracts, and future-only explicit region owner packages.
Each group needs the smallest accepted proof fixture and the nearest rejected
diagnostic before WAT emission broadens; ordinary `scratch {}` still returns a
value and never creates a hidden live region, while GC remains outside the
baseline fallback path.

Latest static-loop union-assignment slice: same-type union assignments after
dynamic static-loop `break`/`continue` state now rewrite to a path-dependent
assignment value that keeps the previous union on skipped steps. Declared union
case payload types are preserved for dynamic `if let` handlers, including
runtime `Text` payloads, and final statement-form dynamic `if`/`if let` blocks
keep implicit fallback metadata when wrapped as expression blocks by statement
lowering.

Latest static-loop union-change-assignment slice: `:=` assignments after dynamic
static-loop `break`/`continue` now take the same union skipped-step path when
the assigned value has statically matching union cases. This covers direct typed
constructors and no-else union branches while leaving true type-changing or
unknown `:=` assignments out of the pure Ic route.

Latest unsupported-node diagnostic slice: parser-reserved unsupported AST nodes
now report the same structured Core/Wasm route as the rest of the strict pure-Ic
limitations. Excluded grammar-family tests still prove formatting as
`<unsupported ...>` and now also assert the route-bearing lowering diagnostic.

Latest method-call diagnostic slice: unresolved field calls now reject as
method-call limitations instead of generic field-access failures. The
capability-style `io.print("hello")` fixture keeps the structured Core/Wasm
route, while lowerable function-valued fields still use normal field lowering.

Latest index diagnostic slice: unknown index update/access rejections now name
the indexed target before the structured Core/Wasm route. The frontend keeps
unsupported memory-backed shapes reserved, but `buf[i] = x` and `buf[i]` now
explain which target could not be lowered through pure Ic.

Latest loop diagnostic slice: unknown collection-loop rejections now name the
collection expression before the structured Core/Wasm route. The unsupported
loop regression also asserts the dynamic-range primary diagnostic, so both
range-bound and collection-loop Ic-only failures identify the blocked shape.

Latest closure-capture proof slice: frozen runtime `Text` and frozen runtime
union captures now have full `Core.proof(...)` fixtures, including empty issue
sets and the reusable frozen/shareable capture decision. Frozen aggregate `Text`
field projections now preserve frozen/shareable ownership on the generated field
temp, so reusable closures can capture projected frozen fields through the same
allowed capture decision.

Latest memory-ticket update: Task 12 now tracks the selected no-GC memory model
as concrete implementation tickets: `ownership_fact_inventory`,
`borrow_view_lifetimes`, `scratch_result_proofs`, `freeze_and_promotion_edges`,
`temporary_cleanup_rows`, `storage_driven_linear_analysis`,
`future_region_owner_packages`, and `no_gc_wat_gate`. These tickets lock in the
mix of unique ownership, lexical borrow/views, explicit frozen/shareable values,
value-returning scratchpads, proof-driven temporary cleanup, and storage-driven
linear checks. Ordinary `scratch {}` does not create hidden attached regions;
optional longer-lived regions remain future explicit owner packages, and GC
remains outside the default `core-3-nonweb` fallback path when analysis is
incomplete.

Latest scratch-capture proof slice: Core closure ownership now accepts a
scratch-backed `Text` capture only for an immediate non-escaping lambda call
inside the active `scratch {}` scope when the lambda body contains no nested
closure value and the scratch result is scalar. Stored, returned, frozen, or
branch-selected scratch-backed closure captures remain rejected until the linear
closure/scratch escape proof is implemented.

Latest branch aggregate promotion slice: branch-selected scratch aggregate
promotion through a static function now compiles through WAT-to-Wasm. The text
layout scanner binds unannotated closure parameters as `i32` placeholders while
scanning static function bodies, so branch conditions such as `flag` do not look
unbound during literal/layout collection. The regression covers
`scratch { let temp: user_type = if flag { user_type { ... } } else {
user_type { ... } }; freeze temp }`
and verifies both selected branches after scratch reset.

Latest branch-assigned promotion slice: scratch-local aggregate and union owners
assigned in both arms of an `if/else` can now be frozen after the branch and
used after scratch reset, with WAT-to-Wasm coverage for both selected branches.
Dynamic loop-carried aggregate/union facts remain the narrower promotion
follow-up rather than all branch assignment shapes.

Latest memory-direction task update: Task 12 now makes the active memory queue
explicit around the selected mix of `unique_heap` owners, lexical `borrow_view`
facts, `frozen_shareable` values, and `scratch_backed` scratchpad storage.
Linear/path-sensitive analysis follows those storage facts instead of applying
to every ordinary value. Optional longer-lived regions are tracked only as a
deferred explicit owner-package profile with tied return values and cleanup/drop
facts; ordinary `scratch {}` still returns a checked value and never grows a
hidden attached region. GC and managed storage remain outside the accepted
`core-3-nonweb` baseline when analysis is incomplete.

Latest dynamic-if-let scratch union slice: scratch-local union promotion now
handles a dynamic `if let` assignment whose matched payload is used to build the
promoted union case. Core text layout scans `if let` bodies with payload facts,
and dynamic/runtime `if let` statement lowering merges assigned static facts
back into the outer context. The WAT-to-Wasm regression covers both the matched
`ok(Text)` result and the unchanged fallback branch after scratch reset.

Latest no-GC analysis-order update: Task 12 now records the implementation order
for the selected memory model. Storage classification comes first, followed by
owner/lifetime ids, borrow/view barriers, scratch saved-pointer reset plus
result proof, explicit freeze/promotion copy edges, cleanup/drop rows, and a
final no-GC proof gate before pure-Ic or structured Core/Wasm emission. Missing
rows reject with a named proof gap or defer to a future explicit
region/managed-storage profile instead of selecting GC for the baseline.

Latest deferred dynamic-if context slice: unannotated runtime bindings whose
value is an otherwise unknown dynamic `if` can now wait for a later pure-Ic
consumer to provide type context. Numeric primitive operands lower deferred
`Int`/`I64` branch values, `len(...)` lowers deferred text branches, and runtime
struct field projection can select scalar/Text fields from deferred
branch-selected structs. Untyped final uses still report the original dynamic-if
diagnostic, and incompatible function branches keep their specific
function-branch errors.

Latest memory/lifetime task lock: Task 12 now states the selected baseline at
the top of the file. Runtime heap values are unique by default; `borrow` creates
runtime-free lexical views; `freeze` is the explicit immutable sharing point;
and `scratch {}` is a value-returning temporary arena with saved-pointer reset,
not a hidden attached region. The active `core-3-nonweb` queue skips GC only by
making ownership, lifetime, escape, promotion, borrow/view, and cleanup proof
complete. Hard scratch, temporary, closure, aggregate, union, text, or
host-boundary cases must become narrower proof fixtures, deterministic pre-WAT
rejections, or future explicit region/managed-storage profiles.

Latest dynamic-if-let context slice: typed `if let` lowering now ignores only
the generic dynamic branch-result failure from the untyped path and then uses
the caller-provided result type. This lets annotated `Text` results and declared
struct field projections lower untyped dynamic union-if targets through pure Ic,
while incompatible dynamic function branches keep their specific rejection.
Direct `len(if let ... )` calls now provide the same `Text` result context,
including no-else text fallback synthesis. Direct `get(if let ..., index)` and
`(if let ...)[index]` now share that typed text path and lower to the existing
bounds-checked byte-load Ic shape.

Latest memory-task update: the task queue keeps the selected no-GC baseline.
Runtime heap values default to unique ownership, `borrow` creates lexical
runtime-free views, `freeze` is the explicit immutable sharing boundary, and
`scratch {}` is a value-returning temporary arena with saved-pointer reset on
all exits. Scratch results must be scalar, already frozen/shareable, explicitly
frozen/promoted, or transitively scratch-free before reset. Compiler-created
temporaries get cleanup/drop/reset/transfer rows from the same ownership proof
data. If the analysis is not precise enough, the remaining work is a narrower
proof fixture, a deterministic pre-WAT rejection, or a future explicit
region/managed-storage profile, not a baseline GC fallback.

Latest dynamic-loop deferred-context slice: unannotated bindings after dynamic
static-loop `break`/`continue` state can now defer their skipped-step fallback
until a later typed pure-Ic consumer supplies context. The expander wraps the
executed value in an implicit-fallback guard instead of guessing a type. Numeric
primitive consumers materialize zero fallbacks, typed text consumers materialize
empty-text fallbacks, and typed union `if let` text results use the existing
handler/text lowering path. Untyped final uses still reject as dynamic unknowns.

Latest static-rec deferred-context slice: rec-local bindings whose value is an
unknown dynamic `if` or `if let` now keep the deferred binding flag during
static-rec unrolling. Rec primitive operands lower those locals with `Int` or
`I64` context, and rec-local `len(...)` lowers them with `Text` context through
the existing runtime-text pointer path. This removes redundant local annotations
for pure numeric/text rec bodies while preserving untyped dynamic unknown
rejections elsewhere.

Latest direct static-rec text-consumer slice: text reads now pass `Text` context
into static-rec app lowering. Direct `len(make(...))`, `get(make(...), index)`,
and `make(...)[index]` can consume a static-rec result whose final branch is an
unknown dynamic text value, without first binding it as `Text`. Unknown non-rec
calls still reject through the existing collection or index diagnostics.

Latest memory-task clarification: Task 12 now treats the chosen model as active
analysis work, not collector selection. Each memory-heavy ticket must define the
storage category, owner/lifetime facts, borrow/view facts, scratch escape
decision, freeze/promotion edge, cleanup/drop/reset action, accepted no-GC
fixture, and nearest rejected proof fixture before WAT emission is broadened.
The baseline remains `core-3-nonweb` with `managed_storage: "disabled"`; hard
cases split smaller, reject before WAT, or move to a future explicit
region/managed-storage profile.

Latest inline text-consumer slice: direct `len(...)`, `get(...)`, and byte-index
reads now pass `Text` context through safe inlineable non-rec helper calls.
Unannotated identity helpers and simple callable block aliases lower to runtime
text pointer reads without an intermediate annotation, while arithmetic helper
bodies still reject through the collection diagnostic instead of being treated
as text pointers.

Latest call-only text-helper slice: runtime lambda bindings whose immediate Ic
lowering is blocked only by an untyped dynamic text branch can remain
environment-only when every use before shadowing is a call target. Direct text
consumers then inline helpers whose body selects between runtime text pointers
with caller-supplied `Text` context. Returning or data-aliasing that helper
still rejects with the original dynamic-branch diagnostic.

Latest no-else text-helper slice: the call-only text-helper defer path now also
handles no-else dynamic branches. Direct text consumers provide `Text` context
for helpers whose body is `if flag { input }`, so `len`, `get`, and byte-index
reads synthesize the empty-text fallback at the inline call site. Numeric
no-else helper bodies and non-call uses remain rejected.

Latest non-text app-context slice: `lower_app_as_front_type` now has a shared
non-`Text` path that tries static-rec, then inlineable non-rec helper calls.
Numeric primitive operands, annotated struct bindings, and annotated union
bindings inline call-only dynamic-branch helpers under the caller-provided type,
so Ic output no longer leaks free helper applications such as
`(choose#0)(flag)`. `Text` contexts still use the stricter text-consumer proof
path.

Latest helper struct-field text slice: runtime struct type resolution now uses
inlineable helper app-result inference. Direct text consumers over helper-built
declared struct fields, including nested `Text` fields, lower through the
runtime text pointer path for `len`, `get`, and byte-index reads. Mixed helper
branches that do not consistently return the declared struct shape still reject
before text pointer lowering.

Latest helper union-payload struct-field slice: direct `if let` results that
select a struct payload from an inlineable helper-built union now keep declared
field facts through projection. Scalar fields, `Text` fields read by `len`, and
`Text` fields read by `get` or byte-index lower through pure Ic without leaking
free helper applications; numeric/struct result mismatches still reject.

Latest memory/lifetime task update: Task 12 now records the final no-GC baseline
as concrete implementation slices. The active work is ownership fact inventory,
lexical borrow/view lifetimes, scratch result proofs, explicit freeze/promotion
edges, temporary cleanup rows, storage-driven linear analysis, and future-only
region owner packages. `scratch {}` remains a value-returning temporary arena
with reset on every exit edge; results must be scalar, frozen/shareable,
explicitly promoted/frozen, or proven scratch-free before the reset. Hard cases
should split into narrower proof fixtures, reject before WAT with a named
missing fact, or move to a future explicit region/managed-storage profile. They
should not create a baseline GC fallback. The concrete follow-up work is to make
the static proof complete for the accepted source shapes and insert cleanup from
those proof rows for source values and compiler-created temporaries.

Latest task-doc handoff: the selected memory model is now reflected as active
implementation work, not collector selection. Task 12 keeps the current queue as
ownership/lifetime proof tickets: storage facts, borrow/view barriers,
scratchpad result gates, explicit freeze/promotion edges, cleanup insertion,
storage-driven linear checks, and future-only explicit region packages. If one
ticket is still too broad, split it by storage category and escape path until it
has an accepted no-GC proof fixture, a deterministic rejected fixture, or an
explicit future profile. The frontend module map also now records
`src/frontend/linear_stmt_loop.ts` as the loop-body validation and carried-state
merge module.

Latest drop module split: Core drop planning now has `src/core/drop/types.ts`
for shared plan/state types and `src/core/drop/emit.ts` for heap-drop and
host-transfer step emission. Static helper-function discovery now lives in
`src/core/drop/static_function.ts`, static owner classification lives in
`src/core/drop/static_owner.ts`, owner consumption and unique-heap
classification lives in `src/core/drop/ownership.ts`, scoped static-call drop
helper binding and alias analysis lives in `src/core/drop/static_call.ts`,
expression-branch result merge/drop bookkeeping, discarded-expression result
drops, result-expression ownership decisions, and shared result-scanner callback
types live in `src/core/drop/expr_result.ts`, generic expression-child traversal
and app/union ownership side effects live in `src/core/drop/expr_children.ts`,
statement branch owner merge/drop helpers and branch statement scanning live in
`src/core/drop/branch.ts`, block-expression owner/result scanning lives in
`src/core/drop/block.ts`, binding owner replacement logic lives in
`src/core/drop/bind_owner.ts`, `bind`/`assign`/`index_assign` statement drop
scanning lives in `src/core/drop/binding_stmt.ts`, static ownership-transfer
call scanning lives in `src/core/drop/static_transfer.ts`, closure-body drop
scanning and closure-local final-escape handling live in
`src/core/drop/closure_body.ts`, `if`/`if let` expression branch drop scanning
lives in `src/core/drop/conditional_expr.ts`, `if`/`if else`/`if let` statement
drop scanning lives in `src/core/drop/conditional_stmt.ts`, range-loop and
collection-loop statement drop scanning lives in `src/core/drop/loop_stmt.ts`,
owner/scope state helpers live in `src/core/drop/state.ts`, and general
statement/final-result traversal plus scanner callback wiring lives in
`src/core/drop/scan.ts`. `src/core/drop.ts` remains the public drop-plan facade
for cleanup/drop proof work.

Latest cleanup module split: Core cleanup planning now has
`src/core/cleanup/exit_edges.ts` for scratch reset exit-edge discovery. The new
module owns the read-only Core walk that maps a `scratch {}` body to ordered
`fallthrough`, `return`, `break`, and `continue` reset edges. Scratch-return
ownership classification, static aggregate/union scratch-free checks,
freeze-copy support decisions, and field/payload rejection details now live in
`src/core/cleanup/scratch_return.ts`. `src/core/cleanup.ts` re-exports the
public scratch cleanup helpers for existing borrow/lifetime callers and remains
the cleanup-plan scanner facade.

Latest closure ownership module split: Core closure ownership planning now has
`src/core/closure_ownership/types.ts` for shared plan, hook, capture-slot, and
fact shapes. Nested closure value containment scanning lives in
`src/core/closure_ownership/contains.ts`; that module owns the read-only Core
walk used to distinguish the allowed immediate non-escaping scratch-backed
capture shape from stored or nested closure captures. Local borrow-view and
scratch-backed ownership fact tracking now lives in
`src/core/closure_ownership/facts.ts`, and capture allow/reserved decisions now
live in `src/core/closure_ownership/decision.ts`. Statement/expression
traversal, block/scratch/direct-call fact threading, local collection probes,
and closure ownership edge recording now live in
`src/core/closure_ownership/scan.ts`. `src/core/closure_ownership.ts` remains
the public planning facade.

Latest runtime aggregate module split: Core runtime aggregate support now has
`src/core/runtime_aggregate/layout.ts` for layout construction,
`RuntimeAggregateField` / `RuntimeAggregateLayout` shapes, field lookup, nested
field base-offset calculation, and static struct-type equality. Aggregate type
discovery, branch-call result typing, block-result alias typing, nested field
access, and `runtime_aggregate_field_info` now live in
`src/core/runtime_aggregate/type_expr.ts`. Shared temp/local, emit-context, and
hook shapes live in `src/core/runtime_aggregate/types.ts`, temp-local planning
and local declaration live in `src/core/runtime_aggregate/plan.ts`, runtime
aggregate value and field load/pointer emission live in
`src/core/runtime_aggregate/emit.ts`, and aggregate freeze-copy support lives in
`src/core/runtime_aggregate/freeze_copy.ts`. `src/core/runtime_aggregate.ts`
remains the public compatibility facade.

Latest runtime union emit split: Core runtime union freeze-copy support now
lives in `src/core/runtime_union/freeze_copy.ts`. The module owns
supported-payload checks, local declaration for nested text/aggregate/union
payload copies, recursive payload copy emission, nested aggregate payload
freeze-copy bridging, and text payload freeze-copy from WAT. Shared
runtime-union emit context and hook shapes now live in
`src/core/runtime_union_emit/types.ts`. Materialized runtime-union value
emission, union-case allocation, scratch-vs-persistent heap selection, and
materialized-value local collection now live in
`src/core/runtime_union_emit/value.ts`. Runtime-union `if let`
statement/expression emission now lives in
`src/core/runtime_union_emit/if_let.ts`. `src/core/runtime_union_emit.ts`
remains the public compatibility facade and re-exports the freeze-copy API.

Latest Ic graph reducer split: graph snapshot serialization now lives in
`src/ic/graph_reduce/dump.ts`. The module owns graph reachability ordering, node
text formatting, child-reference discovery, and ref formatting for reducer debug
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

Latest Ic open-term split: non-recursive open-term parameter inference now lives
in `src/ic/open_term/infer.ts`. It owns explicit parameter typing, open variable
discovery/order, primitive argument/result typing, duplication projection
typing, and unreduced-Ic rejection diagnostics for the plain open-term bridge.
Recursive fixpoint module assembly stays in `src/ic/open_term/recursive.ts`,
while recursive function/main type inference and parameter materialization live
in `src/ic/open_term/recursive/infer.ts`, recursive body/local/alias WAT
emission lives in `src/ic/open_term/recursive/emit.ts`, shared app and
memory-primitive helpers live in `src/ic/open_term/recursive/shared.ts`, and the
recursive bridge state shapes live in `src/ic/open_term/recursive/types.ts`.
`src/ic/open_term.ts` remains the public `Ic.mod`/`Ic.wat` facade for option
handling, recursive bridge dispatch, the reduced Ic to Expr fallback path, and
data/memory wiring.

Latest borrow module split: Core borrow planning now has
`src/core/borrow/types.ts` for shared plan, validation, state, scope, alias, and
recorded-borrow shapes, `src/core/borrow/scope.ts` for deterministic scope ids
and scratch exit-edge naming, and `src/core/borrow/validate.ts` for plan
validation plus check-to-error conversion. Active-borrow barrier checks and
blocked move/freeze/mutation diagnostics now live in
`src/core/borrow/barrier.ts`. The read-only scanner that detects borrow syntax
inside expressions and statements now lives in `src/core/borrow/contains.ts`.
Statement-sequence exit detection for reachable borrow-state scanning now lives
in `src/core/borrow/control.ts`. Captured borrow-view escape detection for
closure bodies now lives in `src/core/borrow/capture.ts`. Borrow alias
canonicalization, view/field alias merging, and stored-view alias helpers now
live in `src/core/borrow/aliases.ts`. Borrow edge creation, bounded-vs-escaping
lifetime decisions, active-borrow registration, and stored-view alias creation
now live in `src/core/borrow/record.ts`. The mutating borrow traversal now lives
in `src/core/borrow/scan.ts`, while statement/control-flow borrow traversal now
lives in `src/core/borrow/stmt.ts` through expression-scanner callbacks.
Binding-value borrow analysis and binding-time alias updates now live in
`src/core/borrow/binding.ts` through scanner callbacks. Field-owner alias
derivation and block/branch field-alias propagation live in
`src/core/borrow/field_alias.ts`. Stored-borrow-view result analysis for blocks,
branches, and promoted merged views now lives in
`src/core/borrow/view_result.ts`. `src/core/borrow.ts` remains the public
borrow-plan facade. Task 12 records this as the current handoff so future borrow
splits can move one coherent scanner concern at a time.

Latest transfer module split: Core ownership-transfer validation now has
`src/core/transfer/types.ts` for transfer edges, validation issues, hooks,
function targets, and scanner state. Transfer state cloning, branch merging,
conditional-transfer cleanup diagnostics, scope naming, issue deduplication, and
edge text live in `src/core/transfer/state.ts`. Static transfer function
discovery, branch-function target derivation, and parameter extraction now live
in `src/core/transfer/static_function.ts`. Ownership-transfer alias tracking,
argument ownership caching, unique-argument validation, and owner resolution now
live in `src/core/transfer/ownership.ts`. Static-call transfer wrapper
traversal, temporary argument aliasing, higher-order const function aliases, and
recursive branch-target scanning now live in `src/core/transfer/static_call.ts`.
Runtime union payload owner-transfer detection, payload ownership checks, and
delegation to the common transfer recorder now live in
`src/core/transfer/union_payload.ts`. Common transfer edge creation,
unique-transfer validation calls, transferred-owner state updates, and
use-after-transfer issue construction now live in `src/core/transfer/record.ts`.
Conditional statement/expression traversal, loop-body transfer merging, and
`if let` branch-context binding now live in `src/core/transfer/branch.ts`.
Direct host/import ownership-transfer argument scanning now lives in
`src/core/transfer/host_call.ts`. General statement/expression transfer
traversal now lives in `src/core/transfer/scan.ts`; `src/core/transfer.ts`
remains the public validation facade.

Latest host-boundary module split: Core host/import boundary proof scanning now
has `src/core/host_boundary/types.ts` for boundary plan, edge, hook, state, and
static-target shapes, plus `src/core/host_boundary/decision.ts` for ownership
contract decisions and ownership-transfer detection.
`src/core/host_boundary/alias.ts` owns alias tracking, shadowed-parameter alias
scopes, scratch-local ownership classification, and host-boundary argument
ownership resolution. Static wrapper-call traversal, wrapper target discovery,
wrapper recursion guards, wrapper-depth handling, and wrapper definition
filtering now live in `src/core/host_boundary/static_call.ts`. Closure-body
host-boundary scanning now lives in `src/core/host_boundary/closure.ts`; it owns
const-parameter skip checks, closure body context selection, and shadowed
parameter aliases while receiving the root expression scanner callback.
Application host-boundary scanning and edge construction now live in
`src/core/host_boundary/app.ts`; it owns function-alias application scanning,
branch/static wrapper dispatch, known-Core-call filtering, host import signature
lookup, argument decision rows, and edge id allocation while receiving the root
expression scanner callback. `src/core/host_boundary.ts` remains the
scanner/orchestration module for generic expression/statement traversal and
local collection.

Latest proof module split: Core unsupported-codegen proof scanning lives in
`src/core/proof/unsupported.ts`, freeze-proof traversal lives in
`src/core/proof/freeze.ts`, baseline proof issue assembly lives in
`src/core/proof/baseline.ts`, proof checking lives in `src/core/proof/check.ts`,
and shared proof target/issue/input/output shapes live in
`src/core/proof/types.ts`. `src/core/proof.ts` is now only the compatibility
facade for backend graph callers and public Core proof imports.

Latest backend graph split: Unsupported-codegen proof support predicates now
live in `src/core/backend/graph/proof_support.ts`, and drop-analysis
static-value discovery now lives in `src/core/backend/graph/drop_static.ts`.
Baseline no-GC proof assembly and host-boundary proof entrypoints now live in
`src/core/backend/graph/baseline_proof.ts`, keeping proof-plan orchestration out
of the public backend facade. Closure-body, collection-loop, runtime-union
match, and `if let` branch proof-context construction now lives in
`src/core/backend/graph/proof_context.ts`. `proof_support.ts` owns the read-only
collection-loop, index-assignment, type-value, app, field, index, and `if let`
support gates used during baseline proof assembly. `drop_static.ts` owns
type/text/static struct/closure/branch and block-shaped static value recognition
for drop-analysis contexts. `drop_context.ts` owns drop/borrow context
collection, freeze-consumption-aware local collection, and closure-valued local
recognition. Unsafe scratch-return proof binding and probe diagnostics now live
in `src/core/backend/graph/drop_scratch.ts`. Ownership/proof hook construction
now lives in `src/core/backend/graph/proof_hooks.ts`; it owns the shared
ownership hooks, static-call proof hooks, allocation hooks, closure-ownership
hooks, closure body context adapters, runtime-aggregate ownership probe helper,
and final-expression ownership helper. `src/core/backend/graph.ts` still owns
public backend entrypoints and backend-bound wrapper functions.

Latest allocation module split: Core allocation planning now has
`src/core/allocation/types.ts` for allocation plan/fact/hook/state/scope types,
`src/core/allocation/record.ts` for allocation fact deduplication and ownership
classification, `src/core/allocation/static_call.ts` for scoped static-call
allocation helper detection, and `src/core/allocation/freeze.ts` for
freeze/promotion allocation predicates plus aggregate/union freeze-copy
allocation traversal. Static-value allocation scanning for static structs,
runtime-union owner materialization, and static-union payload recursion lives in
`src/core/allocation/static_value.ts`, with expression and field scanner
callbacks supplied by the root traversal. Runtime-union allocation recording for
direct union cases and branch-shaped runtime-union values lives in
`src/core/allocation/runtime_union.ts`, with an expression scanner callback for
payload/type traversal. If-let branch-context allocation scanning now lives in
`src/core/allocation/if_let.ts` and is called with explicit expression and
statement scanner callbacks to avoid cyclic coupling. Block-expression
allocation traversal now lives in `src/core/allocation/block.ts`; it owns block
context creation and statement-local collection while receiving root statement
scanner callbacks. Closure-body allocation traversal now lives in
`src/core/allocation/closure.ts`; it owns closure body context selection and
closure allocation-scope naming while receiving the root expression scanner.
General statement/expression allocation traversal now lives in
`src/core/allocation/scan.ts`; `src/core/allocation.ts` remains the public
planning facade.

Latest text-facts module split: Core text fact support now has
`src/core/text_facts/types.ts` for shared context, hook, and runtime text
equality shapes. Block-local text fact propagation now lives in
`src/core/text_facts/block.ts`, including block-context cloning and binding-time
text-local updates. `if let` text fact analysis for static, dynamic-union, and
runtime-union targets now lives in `src/core/text_facts/if_let.ts`. Collection
indexing and `get(...)` text fact recognition now live in
`src/core/text_facts/collection.ts` behind explicit text-check callbacks.
Runtime text operation recognition for `append`, concat, equality, and `slice`
now lives in `src/core/text_facts/runtime_ops.ts`. `src/core/text_facts.ts`
remains the public facade for text classification, host-import text results,
text-app function-type probing, and the existing backend-facing runtime text
operation APIs.

Latest ownership module split: Core ownership support now has
`src/core/ownership/types.ts` for shared ownership result, pointer-reason, and
hook shapes. Ownership-result display and non-scalar diagnostics now live in
`src/core/ownership/text.ts`. Branch ownership merging for `if` and `if let`,
including freeze-result detection and static/dynamic/runtime union branch
contexts, now lives in `src/core/ownership/branch.ts` through an ownership
scanner callback. `src/core/ownership.ts` remains the public facade for
expression ownership classification, scoped static-call ownership, block result
ownership, and runtime union probing.

Latest memory-task execution split: Task 12 now records the selected no-GC
memory model as concrete implementation tickets: `ownership_fact_inventory`,
`borrow_view_lifetimes`, `scratch_result_proofs`, `freeze_and_promotion_edges`,
`temporary_cleanup_rows`, `storage_driven_linear_analysis`,
`future_region_owner_packages`, and `no_gc_wat_gate`. The active baseline is
still `core-3-nonweb` with unique heap owners, runtime-free lexical
borrows/views, explicit frozen/shareable values, value-returning scratchpads,
proof-driven temporary cleanup, and storage-driven linear checks. Optional
longer-lived regions are future explicit owner packages; ordinary `scratch {}`
does not attach a hidden live region, and GC/managed storage remain future named
profiles rather than fallbacks for missing proof rows.

Latest no-GC milestone order: Task 12 now orders the work as proof row schema
and diagnostics, audit of current WAT-emitting memory paths, lexical borrow/view
barriers, `scratch {}` lowering plus pre-reset result gates, explicit
freeze/promotion copies, proof-driven temporary cleanup, ownership-aware closure
storage, host/import ownership contracts, and future-only region/managed-storage
profiles. The active implementation rule is still to make the static analysis
complete for accepted shapes or reject before WAT emission; do not add a
collector-backed repair path to the default backend.

Latest Source-to-Core module split: `src/core/from_source.ts` now stays as the
program-level facade. Context/name/type-owner tracking remains in
`src/core/from_source/context.ts`, host import contract conversion remains in
`src/core/from_source/host_import.ts`, recursive-tail validation remains in
`src/core/from_source/rec.ts`, statement lowering lives in
`src/core/from_source/stmt.ts`, and expression lowering plus host-import
method-call rewriting lives in `src/core/from_source/expr.ts`.

Latest frontend statement split: `src/frontend/stmt.ts` now stays as the public
pure-Ic statement-lowering facade and sequence dispatcher. Binding, assignment,
index-assignment, recursive/runtime binding, call-only deferral, and linear
containment remain in the existing `src/frontend/stmt/` helpers. Static loop
expansion dispatch, static/dynamic `if` statement lowering, static/dynamic
`if let` statement lowering, expression-statement erasure, compile-time-only
expression skipping, and block-statement continuation handling now live in
`src/frontend/stmt/control.ts`, with recursive sequencing passed in through the
shared `LowerStatementsWithDone` callback to avoid import cycles.

Latest frontend format split: `src/frontend/format.ts` now stays as the public
formatting facade for `Source.fmt` and exported `format_expr`. Statement
formatting lives in `src/frontend/format/stmt.ts`, expression formatting lives
in `src/frontend/format/expr.ts`, shared field/type-pattern/parameter helpers
live in `src/frontend/format/common.ts`, host-import signature formatting lives
in `src/frontend/format/host_import.ts`, and primitive display symbols live in
`src/frontend/format/prim.ts`. The expression and statement modules receive
callbacks for mutual recursion, so the facade keeps the public entrypoints
stable without creating helper import cycles.

Latest frontend Ic-share split: `src/frontend/ic_share.ts` now stays as the
public pure-Ic sharing facade. Runtime binding and lambda binding helpers live
in `src/frontend/ic_share/binding.ts`, free-name/use counting lives in
`src/frontend/ic_share/count.ts`, top-level free-variable sharing lives in
`src/frontend/ic_share/free.ts`, and deterministic duplication plan creation
plus leaf substitution lives in `src/frontend/ic_share/share.ts`. Existing
callers continue to import `lower_bound_value`, `lower_lambda_binding`, and
`share_free_variables` from the facade.

Latest aggregate temporary proof fixture: discarded runtime aggregate
materialization now has the same proof-inventory assertions as the text, union,
and closure temporary cleanup fixtures. The direct runtime struct temporary and
static aggregate materialization cases both assert disabled managed storage, the
persistent `unique_heap runtime_aggregate` allocation row, and the ownerless
`discarded_expr` heap-drop row before WAT emission.

Latest source owner replacement proof fixture: same-name closure replacement now
asserts the full baseline proof inventory. The accepted shape proves disabled
managed storage, both persistent closure allocation rows, the
`assignment_replace` drop for the old closure owner, and the `scope_exit` drop
for the replacement owner before WAT emission.

Latest source owner cleanup matrix: representative accepted closure-owner
cleanup edges now assert proof rows rather than only `Core.drops(...)`. Normal
program scope exit, closure-body scope exit, closure-body return exit, program
return exit, discarded named owners, and moved-owner scope exit all prove
disabled managed storage, the needed persistent closure allocation rows, and the
matching heap-drop rows before WAT emission.

Latest block owner cleanup matrix: discarded and moved outer owners through
block expressions, discarded and moved block-local owners, and a block-local
owner dropped at block scope now assert `Core.proof(...)` inventory before WAT
emission. The fixtures prove disabled managed storage, the persistent closure
allocation rows at the right program/block scope, and the matching heap-drop
rows.

Latest branch/control cleanup matrix: branch-selected closure-owner cleanup and
control-flow exits now assert baseline proof inventory. Moved `if` branch
owners, mixed branch-local/direct closure owners, `if let` branch owners with a
runtime-union target allocation, loop `break`/`continue` exits, and conditional
return exits all prove disabled managed storage, persistent allocation rows, and
matching heap-drop rows before WAT emission.

Latest union payload borrow barrier: borrow/view analysis now aliases matched
`if let` payload names back to the union owner when the payload is borrowed. A
stored branch view from `borrow value` and an expression-result view from
`if let ... { borrow value } else { ... }` now reject owner replacement while
the payload view is live, and the fixtures assert borrow validation,
`Core.proof(...)` rejection, and pre-WAT emission rejection. Declared union
binding types are remembered in borrow alias state so scalar payload borrows
remain copyable and accepted while heap-backed payloads still create owner
barriers. Aggregate and nested-union payload views now have the same proof-gated
rejection fixtures as `Text` payload views.

Latest borrow view freeze/transfer barrier: source-level stored borrow-view
fixtures now reject `freeze` and host ownership transfer while a view is live.
`freeze message` and `host_take(message)` with an `ownership_transfer` import
both surface through borrow validation, baseline `Core.proof(...)`, and pre-WAT
emission rejection. The host-transfer check is wired through an optional borrow
scanner hook, so real backend host imports are checked without forcing synthetic
borrow-plan tests to model host imports.
