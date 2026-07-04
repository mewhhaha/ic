# Lowering Pipeline To Interaction Calculus And Wasm

## Goal

Implement the compiler pipeline from source through structured core,
interaction-calculus-style graph IR, and Wasm-oriented IR.

## Source Sections

- Lowering Model
- Interaction Calculus Interpretation
- Wasm-Oriented Representation

## Pipeline

```txt
Source
  -> Typed Core
  -> Const evaluation and specialization
  -> Structured Core
  -> Ownership, lifetime, escape, and cleanup elaboration
  -> Interaction-calculus-style graph IR
  -> Wasm Codegen IR
```

## Work

- Preserve functions, closures, loops, linear values, layout facts, and
  struct/union representations in structured core.
- Lower pure expressions to interaction-calculus-style graph IR with explicit
  sharing and erasure.
- Lower shadowing to fresh graph names.
- Lower loops as structured feedback over carried variables, not as erased pure
  graph terms too early.
- Run ownership, borrow, freeze, scratchpad, escape, and cleanup analysis before
  WAT emission. Cleanup/reset edges must be represented in Core so structured
  `block`, `loop`, `br`, and `return` lowering cannot skip them.
- Run unique-owner drop planning before WAT emission as part of the same
  elaboration pass. The initial bump allocator can lower unique drops to no-op
  code, but the plan must be present for later reusable allocation and
  destructors.
- Lower Wasm-oriented values:

```txt
small primitives -> Wasm locals
structs -> scalarized locals, unique heap, frozen heap, or scratch storage
unions -> tag + payload with ownership facts
slices/strings -> pointer + length with storage/lifetime facts
closures -> function pointer + environment pointer with capture ownership
linear capabilities -> explicit parameters/results
loops -> block/loop/br_if
```

- Monomorphize generic and duck-typed functions before code generation.
- Keep the default backend on baseline linear-memory Wasm. If scratch escapes,
  borrows, closure captures, or temporary lifetimes cannot be proven sound,
  reject before emission instead of falling back to GC.
- Treat the no-GC proof gate as part of feature acceptance. A Core feature is
  not WAT-ready until its storage class, lifetime, escape, borrow, promotion,
  and cleanup facts are visible to the emitter; missing facts go back to
  analysis tasks or deterministic rejection fixtures.
- Treat GC or Wasm-GC as a separate future target profile. It must not change
  the baseline pass ordering or hide missing ownership facts.
- Do not add a collector-backed repair path in lowering. When the proof rows are
  missing, lowering should report the missing storage, lifetime, borrow,
  scratch, promotion, host-boundary, or cleanup edge and send the case back to
  Task 12 refinement.
- Treat `borrow value` as an analysis-visible read-only view, not as a runtime
  owner copy. A live view blocks owner move, mutation, freeze, transfer, return,
  and escaping capture until the view lifetime ends.
- Treat `scratch { ... }` as a lexical scratchpad with a value result, not as an
  attached region that can escape the reset. Any scratch-backed result that
  crosses the boundary must be scalarized, frozen, promoted, proven
  scratch-free, or rejected in Core before WAT is emitted.
- If optional regions are introduced later, lower them as explicit region-owner
  values with region ids, tied payload lifetimes, cleanup/drop facts, and
  move/consume rules. Do not make WAT emission infer a hidden region attachment
  for an otherwise unsafe scratch result.
- Keep scratchpads as the default temporary-computation mechanism. They give the
  compiler a cheap allocation/reset boundary without requiring managed storage
  or extending region lifetimes implicitly.
- Treat future region-return lowering as an explicit owner-package feature:
  returned values must carry the region owner, lifetime ties, cleanup/drop
  facts, and move/consume behavior. Do not infer this package from ordinary
  `scratch {}` lowering.
- Insert cleanup for compiler-created temporaries through the same ownership
  facts as source values. The backend should not rely on WAT emission or a
  runtime collector to discover temporary lifetimes.
- Keep the no-GC efficiency target visible in lowering: borrows are runtime-free
  views, scratch reset is a saved-pointer restore, freeze/promotion is an
  explicit Core copy edge, frozen values are freely shareable, and unique drops
  remain proof-visible even when the initial bump allocator emits no-op drops.
- Lowering-created temporaries should be split by origin when analysis is
  incomplete: aggregate materialization, text copy/concat/slice loops, union
  payload construction, closure environment setup, host-boundary marshaling, and
  scratch-to-persistent promotion copies.
- Add a final ownership proof gate before WAT emission. Accepted programs must
  have storage classes, lifetime ids, escape decisions, borrow decisions,
  scratch reset edges, and unique-owner drop decisions for source values and
  lowering-created temporaries. Missing facts are compiler errors, not GC
  fallback points.
- The proof gate is the boundary where "skip GC if analysis is proper" is
  enforced. If the analysis cannot prove the case yet, the accepted baseline
  program does not exist yet.
- Use the Task 12 authoritative no-GC acceptance matrix for every lowering
  feature that touches runtime memory: accepted with proof facts, rejected with
  a named missing fact, or deferred to an explicit future
  region/managed-storage profile.
- Keep the proof gate ahead of both the pure Ic route and the structured
  Core/Wasm route. Pure scalar/frozen values may still lower through Ic, while
  owned, borrowed, scratch-backed, or closure-environment values must stay in
  structured Core until ownership and cleanup decisions are explicit.
- Use the Task 12 first fixture backlog as the initial lowering order for
  memory-heavy features: borrow/view barriers, scalar and frozen scratch
  returns, aggregate/union scratch result gates, lowering-created temporary
  cleanup, first-class closure storage, and host/import ownership contracts.
  Do not broaden a lowering path until its accepted and rejected proof fixtures
  exist.
- Lowering proof fixtures must follow the Task 12 proof-fixture shape. The
  final pre-WAT gate must expose `target_profile: "core-3-nonweb"`,
  `managed_storage: "disabled"`, storage/lifetime rows, borrow/scratch result
  rows, freeze/promotion rows, cleanup/drop/reset rows, and host-boundary rows
  before an ownership-heavy value reaches codegen.
- Treat skipped GC as a lowering invariant: if the proof gate cannot show how a
  temporary, scratch result, unique owner, borrow view, closure environment, or
  host-boundary value is cleaned up or kept alive, WAT emission must not repair
  it by selecting collector-managed storage.

## Acceptance Criteria

- Pure computation can lower into the existing interaction-calculus-inspired IR.
- Structured loops preserve optimization facts until Wasm lowering.
- Linear capabilities remain explicit parameters/results.
- Struct/union layout facts drive loads, stores, tags, and payload offsets.
- Protocol abstractions disappear after specialization.
- Scratch resets and temporary cleanup points are visible in Core before WAT is
  emitted.
- Scratch results never depend on a live attached scratch region after reset.
- Any future region-return feature exposes the region owner and tied value
  lifetimes in Core before WAT emission.
- Unique heap drop points are visible in analysis before WAT is emitted, even
  when the first backend lowers them to no-ops.
- The baseline backend rejects uncertain lifetime/escape cases deterministically
  rather than relying on managed storage.
- The baseline backend has no GC fallback; managed or Wasm-GC storage is a
  separate future profile with separate ownership and boundary rules.
- WAT emission is reached only after the ownership proof gate succeeds for the
  selected baseline target.
- Any fallback to managed storage, tracing GC, Wasm-GC, or hidden attached
  regions is a separate future target profile and cannot be introduced by an
  emitter as a repair for missing proof rows.

## Verification

- Add lowering tests from source snippets to typed/structured core.
- Add graph IR tests for fresh names, sharing, duplication, and erasure.
- Add Wasm text tests for range loops and simple functions.
- Add monomorphization tests for protocol-constrained functions.
- Add proof-gate tests for every newly accepted Core/Wasm memory feature,
  checking storage class, lifetime id, borrow/view status, scratch reset edge,
  freeze/promotion edge, and drop/cleanup facts before WAT emission.
- Add rejected-emission tests for missing ownership, borrow, scratch escape,
  host-boundary, promotion, or temporary-cleanup facts instead of accepting the
  case through GC or implicit region attachment.
- Add route tests that prove ownership-heavy values stay on the structured
  Core/Wasm path, while pure scalar or frozen/shareable values can still use the
  Ic path safely.
- For each new memory-heavy lowering fixture, add a paired rejection that names
  the first missing proof edge, such as active borrow, scratch-backed field,
  unsupported promotion, missing temporary cleanup, ownership-bearing closure
  capture, or unknown host boundary.
- Add a proof-fixture assertion for each accepted lowering slice so tests can
  verify that WAT emission is consuming explicit no-GC proof rows instead of
  relying on hidden region attachment, implicit promotion, or managed storage.

## Implementation Status

- Implemented the source-to-Ic-to-Expr-to-Mod-to-WAT path for pure scalar
  computations.
- Implemented explicit source `i64` literal lowering through Ic and Expr,
  including arithmetic, comparisons, dynamic `select`, and typed dynamic
  indexing over const-known aggregates and typed runtime structs. Runtime `I64`
  binding and parameter facts retag parse-time-default numeric primitives to i64
  operations in both frontend Ic lowering and structured Core WAT emission,
  including chained arithmetic whose intermediate primitive was parsed before
  the operand facts were known, dynamic branches whose result type depends on
  those retagged primitives, and no-else `if`/`if let` expression fallbacks that
  must materialize `0i64` for inferred `I64` branch results or `""` for inferred
  `Text` branch results. No-else frontend `if`/`if let` fallbacks also
  synthesize Ic-safe struct fields and union cases when each field or payload
  has a fallback value.
- Implemented Ic primitive folding and propagation coverage for arithmetic,
  comparisons, select, trap, duplication, one-sided duplication cleanup,
  superposition, unary memory loads, and erasure. Dynamic selects retag to
  `i64.select` when reduction exposes i64 selected branches.
- Implemented source lowering tests for fresh names, specialization,
  source-level erasure for unused runtime bindings, explicit Ic sharing for
  repeated runtime bindings, parameters, and free names, monomorphized
  protocol-style calls, const binding/closure capture snapshots, runtime-index
  `get` and bracket indexing over const-known aggregate values and typed runtime
  structs, visible aggregate and concrete visible `Text` arguments specialized
  into closures that field-select, index, update, call `len`/`get`, or iterate
  their parameters, specialized runtime closure calls that preserve binding-time
  capture environments, dynamic ordinary function branches that eta-expand to Ic
  lambdas for scalar/text-pointer selected bodies, including simple aliases to
  known closures, matching, one-sided, and alias-equivalent parameter
  annotations, selected-branch call rejection for known incompatible arguments,
  annotation-driven wrapper erasure for branch-selected scalar, text, struct,
  and union arguments, typed aggregate branch values, and annotated runtime
  bindings whose dynamic branch values are otherwise unknown at runtime,
  simple one-expression block wrappers and pure block-local alias wrappers
  around those annotated dynamic branch values,
  including implicit no-else typed struct/union branch values synthesized from
  declared annotation fallbacks, static-rec annotated aggregate arguments that
  select between wrapper branches with or without explicit `else`, direct
  static-rec struct results projected by field, static index, or `get`,
  annotated static-rec app results lowered under expected scalar, `Text`,
  struct, and union binding/call-argument contexts, and i64
  selected bodies whose primitive type is recovered from
  parameter/capture facts, branch-call inlining for frontend-known struct/union
  consumers, typed pure union handler lowering with numeric and text-pointer
  results, typed struct and frontend-known object handler lowering, dynamic
  typed struct and frontend-known object `if` field selection, same-case dynamic
  typed union `if` payload selection, same-case locally inferred shorthand
  dynamic union values, standalone inferred shorthand union cases including
  unknown runtime payloads, different-case dynamic typed or locally inferred
  shorthand union `if` values including unknown runtime payloads, different-case
  dynamic typed union `if` consumed by numeric/text-pointer `if let` including
  `Text` payloads used by `len` and named-struct payloads used by field access,
  including shorthand object payloads resolved from declared union-case context
  and typed unknown union-value branches matched by dynamic `if let`, including
  annotated helper calls that return dynamic `if` values over typed union
  parameters, i64 select retagging after direct handler-encoded union
  application, dynamic union `if let` expressions that produce handler-encoded
  union results through direct targets, deferred const-call results, and
  inlineable runtime closure calls, dynamic `if` branches whose union cases are
  produced by inlineable identity or constructor helper calls, typed union case
  tables preserved through direct and simple block-bodied inlineable helper
  returns into `if let`, static-rec application of those bound handler-encoded
  union results, locally inferred shorthand dynamic union cases consumed by
  `if let`, inlineable runtime closure calls returning dynamic union values
  consumed by `if let`, known union cases through frontend-known
  field/static-index projections, simple block-local frontend-known text values
  in visible text operations, simple block-local frontend-known struct and union
  values, simple block-local dynamic union-if values consumed by `if let`, known
  runtime text/struct/union type facts through unannotated frontend helper
  calls, frontend-known object/typed-struct dynamic `if let` field-wise Ic value
  lowering, deferred const-call results that produce dynamic union `if` values
  consumed by `if let`, pure explicit capability-function calls over linear
  values, frontend-known method-style capability calls over linear values,
  dynamic indexing and index assignment over visible text fields as `i32`
  data-pointer selects, dynamic indexed visible text `len`, typed runtime struct
  dynamic indexing over runtime scalar/text payloads, rejection of known non-i32
  conditions before Ic select lowering, typed runtime struct loop expansion, and
  frontend-to-Ic shapes.
- Existing Wasm tests cover simple scalar functions, primitive expression
  emission, and a frontend static range loop through
  `Source -> Ic -> Expr -> Mod -> WAT -> Wasm`.
- Added a minimal `Source -> Core` structured path that preserves dynamic range
  loops with carried-variable facts before later Ic/Wasm-oriented lowering.
- Kept `src/core.ts` as the public facade and grouped Core backend
  implementation modules under `src/core/`.
- Kept `src/core/backend.ts` as the public Core trait facade, moved the `Core`
  companion implementation into `src/core/backend/core.ts`, and kept
  `src/core/backend/graph.ts` as the public backend entrypoint facade. Backend
  graph composition is in `src/core/backend/graph/instance.ts`, with wiring
  split into `src/core/backend/graph/analysis.ts` for local facts, expression
  typing, and type checks, `src/core/backend/graph/emit.ts` for
  expression/statement WAT emission, `src/core/backend/graph/values.ts` for
  static-call, static-value, struct, and text hooks,
  `src/core/backend/graph/runtime.ts` for runtime service assembly, and
  `src/core/backend/graph/entry.ts` for app/index/local-collection/artifact
  wiring. Analysis graph service adapters live under
  `src/core/backend/graph/analysis/` for local facts, expression typing, and
  type checks. Emit graph service adapters live under
  `src/core/backend/graph/emit/` for expression and statement WAT emitters.
  Values graph service adapters live under `src/core/backend/graph/values/` for
  static-call, static-value, struct, and text services. Runtime graph service
  adapters live under `src/core/backend/graph/runtime/` for closure,
  runtime-union, control-flow, and recursion services; entry graph service
  adapters live under `src/core/backend/graph/entry/` for app, index,
  local-collection, and artifact services, with lazy graph dependencies
  described by `src/core/backend/graph_deps.ts` and assembled in
  `src/core/backend/graph/deps.ts`. The combined backend graph contract lives in
  `src/core/backend/graph/types.ts`. Backend utility helpers live under
  `src/core/backend/util/`, with `src/core/backend/util.ts` kept as the
  compatibility facade. Backend graph context construction and child-context
  cloning live in `src/core/backend/graph/context.ts`, keeping `CoreCtx`
  defaults and host-import map cloning out of the public backend graph facade.
  Unsupported-codegen proof conversion lives in
  `src/core/backend/graph/proof_unsupported.ts`, keeping analysis-error
  normalization and placeholder unsupported-proof assembly out of the public
  backend graph facade.
- Moved Core top-level WAT artifact assembly, lifted-closure function/table
  aggregation, data segment exposure, and `Mod` construction into
  `src/core/artifact_emit.ts`; `src/core/backend/entry/artifact.ts` owns the
  backend adapter that composes text-layout, statement emission, lifted-closure,
  and result-type hooks.
- Moved Core WAT-emission context construction, branch cloning, recursive body
  context creation, lifted-closure body context creation, and runtime-union
  match branch binding into `src/core/emit_ctx.ts`, keeping backend hook wiring
  separate from reusable emit-context shapes.
- Kept graph-specific source-to-Ic sharing helpers in `src/frontend/ic_share.ts`
  so bound-value erasure, lambda sharing, and repeated free-name sharing are
  separate from the large semantic lowering pass.
- Kept `src/frontend/lower.ts` as the stable frontend lowering facade and moved
  the internal lowerer hook-composition graph into
  `src/frontend/lower_graph.ts`.
- Moved frontend expression/call/if/index hook assembly into
  `src/frontend/lower_expression_hooks_adapter.ts`, and
  prepare/eval/statement/inference hook assembly into
  `src/frontend/lower_program_hooks_adapter.ts`, keeping repeated hook wiring
  out of `src/frontend/lower_graph.ts`.
- Moved frontend visible-text primitives such as UTF-8 byte-length calculation
  and compile-time visible text concatenation into `src/frontend/text.ts`.
- Moved frontend visible-text value discovery and text-concat operand visibility
  checks into `src/frontend/text_visible.ts`, with the shared text-lowering hook
  contract in `src/frontend/text_lower_types.ts`, keeping recognition separate
  from text length/index Ic construction.
- Moved frontend static/runtime text byte-index Ic construction into
  `src/frontend/text_lower/byte_index.ts`, leaving `src/frontend/text_lower.ts`
  focused on visible/runtime text length selection.
- Moved frontend text-lowering hook composition and text-specific lowerer
  adapter glue into `src/frontend/lower_text_adapter.ts`, keeping text hook
  wiring out of `src/frontend/lower_graph.ts`.
- Moved frontend static range and collection loop expansion into
  `src/frontend/static_loop.ts`, leaving `src/frontend/lower_graph.ts` to
  provide the environment-sensitive static evaluation and type-resolution hooks;
  statically decidable nested `if` and statically known `if let`
  `break`/`continue` edges are unrolled there, terminal `return` stops further
  unrolling, nested static loops are flattened with inner `break`/`continue`
  scoped to the inner loop, and simple dynamic `if { break }` /
  `if { continue }` / `if let { break }` / `if let { continue }` bodies lower
  through synthesized active/step flags before Ic lowering. Those branches may
  include simple local-binding, assignment, or expression prefix statements
  before the terminal `break` or `continue`; top-level non-linear integer,
  `Text`, resolvable static-shaped struct, and resolvable same-case union `let`
  bindings before later dynamic `break`/`continue` checks lower through an
  explicit inactive fallback branch with the correct integer width, an empty
  text value, recursively synthesized field fallbacks, or recursively
  synthesized payload fallbacks. Nested dynamic `if` and `if let` loop-control
  bodies lower by recursively guarding statements after inner
  `break`/`continue`, so non-terminal trailing assignments are skipped once the
  active step is cleared.
- Moved frontend static-loop hook composition and static-loop adapter glue into
  `src/frontend/lower_static_loop_adapter.ts`, keeping static loop hook wiring
  out of `src/frontend/lower_graph.ts`.
- Moved frontend static-loop shared hook/item contracts into
  `src/frontend/static_loop/types.ts`, loop binding/read-only helpers into
  `src/frontend/static_loop/binding.ts`, static loop body expansion and dynamic
  loop-control need detection into `src/frontend/static_loop/body.ts`,
  collection item materialization into `src/frontend/static_loop/items.ts`,
  static `if let` payload binding into
  `src/frontend/static_loop/if_let_payload.ts`, dynamic-control flag generation
  and loop-control scanning into `src/frontend/static_loop/dynamic_control.ts`,
  and guarded dynamic-control statement expansion into
  `src/frontend/static_loop/expand_dynamic.ts`. Dynamic skipped-step fallback
  synthesis and guarded struct/union/function value helpers live in
  `src/frontend/static_loop/fallback.ts`, keeping type/fallback construction
  separate from dynamic-control statement expansion.
- Moved frontend static expression lowering and static `i32` evaluation into
  `src/frontend/static_expr.ts`, leaving `src/frontend/lower_graph.ts` to
  provide the dynamic fallback, lookup, and field/index resolution hooks.
- Moved frontend static-expression hook composition and static-expression
  adapter glue into `src/frontend/lower_static_expr_adapter.ts`, keeping
  static-expression hook wiring out of `src/frontend/lower_graph.ts`.
- Moved frontend numeric primitive operand validation into
  `src/frontend/numeric.ts`, with `src/frontend/lower_graph.ts` supplying
  expression inference and annotation-derived numeric facts.
- Moved frontend visible-parameter specialization analysis into
  `src/frontend/visible_params.ts`, with root-name checks, dependency scanning,
  and collection-iteration scanning split under `src/frontend/visible_params/`,
  so aggregate/text call-site deferral traversal stays out of the semantic
  lowering pass.
- Moved frontend local/aliased/simple-block/static-branch linear closure
  tracking into `src/frontend/linear_closure.ts`, keeping closure recognition
  separate from path-sensitive linear consumption validation.
- Moved frontend path-sensitive linear validation into
  `src/frontend/linear_stmt.ts` for statement/control-flow traversal,
  `src/frontend/linear_expr.ts` for expression consumption, and
  `src/frontend/linear_state.ts` for carried-state comparison helpers, leaving
  `src/frontend/linear.ts` as the stable public facade.
- Moved frontend deferred aggregate and visible-text value detection into
  `src/frontend/call_deferred.ts`.
- Moved frontend const/runtime call argument specialization checks and argument
  binding into `src/frontend/call_args.ts`, with call specialization supplying
  annotation, inference, deferred-value, and environment hooks.
- Moved frontend call-target and dynamic function-branch target resolution into
  `src/frontend/call_target.ts`, with call specialization supplying const-call
  and static-branch hooks.
- Moved frontend call-specialization graph delegates into
  `src/frontend/lower_call_graph.ts`, keeping const-call, deferred-call,
  runtime-call, and specialization wrapper wiring out of
  `src/frontend/lower_graph.ts`.
- Moved frontend call-graph forwarding through cyclic lowerer dependencies into
  `src/frontend/lower_call_facade.ts`, keeping lazy call delegate wrappers out
  of `src/frontend/lower_graph.ts`.
- Moved frontend struct/union value graph delegates into
  `src/frontend/lower_value_graph.ts`, keeping aggregate access wrappers,
  struct/union value resolution, and union-case inference dispatch out of
  `src/frontend/lower_graph.ts`.
- Moved frontend value-graph forwarding through cyclic lowerer dependencies into
  `src/frontend/lower_value_facade.ts`, keeping lazy aggregate/union delegate
  wrappers out of `src/frontend/lower_graph.ts`.
- Moved app-as-expected-type lowering and inlineable helper app-result type
  inference into `src/frontend/lower_app_type_adapter.ts`, keeping
  static-rec/app-helper context recursion out of `src/frontend/lower_graph.ts`.
- Moved shared union helper-call inlining for union value resolution and union
  case inference into `src/frontend/union_call_inline.ts`, so dynamic `if let`
  branch lowering and case-table inference use the same direct, deferred,
  specialized, and runtime helper-call path.
- Split frontend call specialization so `src/frontend/call_specialize_types.ts`
  owns the hook contract, `src/frontend/call_resolve.ts` owns reusable call
  target wrappers, `src/frontend/call_specialize_decision.ts` owns
  specialization predicates, `src/frontend/call_dynamic_args.ts` owns dynamic
  function-branch argument checks, `src/frontend/call_inline.ts` owns
  const/runtime call inlining, and `src/frontend/call_union_result.ts` owns
  call-result union inference; `src/frontend/call_specialize.ts` remains the
  specialized Ic application facade with the lowerer supplying annotation,
  inference, value-resolution, dynamic-union, and Ic-lowering hooks.
- Kept `src/frontend/infer.ts` as the frontend expression type-inference facade,
  with the implementation split under `src/frontend/infer/` into hook contracts,
  primitive/builtin inference, runtime-struct field/index inference,
  statement-result inference, and the main expression dispatcher. The lowerer
  supplies text, struct, union, and index resolution hooks.
- Split frontend expression-to-Ic lowering so `src/frontend/expr_lower.ts`
  remains the dispatch surface, `src/frontend/expr_lower_types.ts` owns the
  shared hook contract, `src/frontend/expr_lower_binding.ts` owns
  binding/lambda/linear lowering, and `src/frontend/expr_lower_access.ts` owns
  app/field/index lowering, with the lowerer supplying specialization, builtin,
  struct, union, text, index, and recursive-call hooks.
- Moved frontend-known struct-value discovery, declared field-type discovery,
  and handler-encoded struct-value Ic lowering into
  `src/frontend/struct_values.ts`, with the lowerer supplying nested expression
  lowering and environment-sensitive resolution hooks.
- Moved frontend declared static-shaped struct field/index value resolution,
  access retagging, and indexed-result classification into
  `src/frontend/struct_access.ts`, with the lowerer supplying static evaluation
  and struct-value discovery hooks.
- Moved frontend struct-access hook composition and dynamic aggregate index
  adapter glue into `src/frontend/lower_struct_access_adapter.ts`, keeping
  aggregate field/index resolver wiring out of `src/frontend/lower_graph.ts`.
- Moved frontend statement sequencing, static statement-loop expansion,
  statement-level `if`/`if let`, and non-final expression erasure into
  `src/frontend/stmt.ts`; moved shared statement hook types into
  `src/frontend/stmt/types.ts`; and moved binding/assignment/index-assignment
  shadowing into `src/frontend/stmt/binding.ts`, with the lowerer supplying
  expression, type, annotation, loop, index-assignment, and value-resolution
  hooks.
- Moved call-only runtime lambda defer scanning into
  `src/frontend/stmt/call_only_defer.ts`, keeping tail-use scanning and
  linear-capture rejection out of `src/frontend/stmt/binding.ts`.
- Moved frontend const/runtime value preparation, including union-constructor
  normalization, struct update rebuild validation, deferred const-call capture,
  and extension base capture, into `src/frontend/prepare.ts`, with the lowerer
  supplying struct, union, call, and capture hooks.
- Moved frontend compile-time value and block evaluation into
  `src/frontend/eval.ts`, with the lowerer supplying annotation, const-call,
  static-loop, index-assignment, type, and value-resolution hooks.
- Moved frontend compile-time expression and extension-field resolution into
  `src/frontend/const_resolve.ts`, with the lowerer supplying const-builtin,
  const-call, static-index, simple-block, and index-resolution hooks.
- Moved frontend const-resolution hook composition and const-resolution adapter
  glue into `src/frontend/lower_const_resolve_adapter.ts`, keeping const builtin
  and const expression/field resolver wiring out of
  `src/frontend/lower_graph.ts`.
- Moved frontend `if` expression lowering into `src/frontend/if_expr.ts`, with
  the lowerer supplying branch inference, dynamic struct/union reshaping, and
  nested Ic-lowering hooks.
- Moved shared direct-lambda selection helpers for dynamic function-valued
  branches into `src/frontend/function_if.ts`, so ordinary dynamic `if` and
  function-valued dynamic `if let` use the same parameter annotation and alias
  rules.
- Moved frontend `if let` shared type/default/handler helpers into
  `src/frontend/if_let_common.ts`, hook/type shapes into
  `src/frontend/if_let_types.ts`, and handler-encoded union-result lowering into
  `src/frontend/if_let_union_result.ts`, leaving `src/frontend/if_let.ts`
  focused on known-union and dynamic union-if orchestration.
- Moved frontend structural type-pattern/fact-checker validation and type-field
  substitution into `src/frontend/type_patterns.ts`, with the lowerer supplying
  the compile-time expression resolver hook.
- Moved frontend compile-time builtin evaluation for structural facts, layout
  helpers, `len`, and `get` into `src/frontend/const_builtin.ts`, with the
  lowerer supplying environment, field lookup, and aggregate resolution hooks.
- Moved frontend const-known expression and block analysis into
  `src/frontend/const_known.ts`, keeping the compile-time eligibility traversal
  separate from const-call execution and Ic lowering.
- Moved frontend union construction, typed constructor validation, union
  type-value resolution, and shorthand union-case inference into
  `src/frontend/union_values.ts`, moved dynamic union branch case-shape
  inference into `src/frontend/union_infer.ts`, and shared dynamic union-if case
  merging through `src/frontend/dynamic_union_cases.ts`, with the lowerer
  supplying expression, field, index, and dynamic-target resolution hooks.
- Moved frontend `if let` union-handler lowering, scalar/text branch selection,
  and union-result branch handling into `src/frontend/if_let.ts`, with the
  lowerer supplying inference, union/struct resolution, const-call inlining, and
  Ic-lowering hooks.
- Moved frontend dynamic union-if target discovery through captures, blocks,
  deferred calls, specialized calls, and aliases into
  `src/frontend/if_let_target.ts`.
- Kept `src/frontend/dynamic_branch.ts` as the public dynamic-branch facade and
  split shared hook/result shapes, dynamic struct/`if let` branch reshaping, and
  dynamic union handler-value lowering into
  `src/frontend/dynamic_branch/types.ts`,
  `src/frontend/dynamic_branch/struct.ts`, and
  `src/frontend/dynamic_branch/union.ts`, with the lowerer supplying the
  environment-sensitive inference, struct/union resolution, and Ic-lowering
  hooks. The struct branch facade now delegates to
  `src/frontend/dynamic_branch/struct/if.ts`,
  `src/frontend/dynamic_branch/struct/if_let.ts`, and
  `src/frontend/dynamic_branch/struct/helpers.ts`, keeping dynamic `if`, dynamic
  `if let`, and shared nested-struct shaping separate.
- Moved frontend dynamic-branch hook composition and dynamic-branch lowerer
  adapter glue into `src/frontend/lower_dynamic_branch_adapter.ts`, keeping
  dynamic branch hook wiring out of `src/frontend/lower_graph.ts`.
- Moved frontend runtime typed-struct type discovery, projection/index
  selection, and indexed-field type helpers into
  `src/frontend/runtime_struct.ts`, so ordinary frontend lowering and static-rec
  struct lowering use the same field selection rules.
- Moved frontend runtime-struct hook composition and runtime-struct adapter glue
  into `src/frontend/lower_runtime_struct_adapter.ts`, keeping runtime
  typed-struct projection and type-discovery hook wiring out of
  `src/frontend/lower_graph.ts`.
- Moved frontend tail-recursion validation and static-rec lowering into
  `src/frontend/rec.ts`, moved static-rec result-expression dispatch into
  `src/frontend/rec_result.ts`, moved the shared static-rec hook contract into
  `src/frontend/rec_hooks.ts`, moved recursive target/argument binding into
  `src/frontend/rec_bind.ts`, moved static-rec `if` branch lowering into
  `src/frontend/rec_if.ts`, moved static-rec union/`if let` lowering into
  `src/frontend/rec_union.ts`, with dynamic union `if`, rec-aware `if let`, and
  union-result `if let` application split under `src/frontend/rec_union/`, moved
  static-rec union handler application and case-to-handler Ic helpers into
  `src/frontend/rec_union_handlers.ts`, moved static-rec union case-shape
  inference into `src/frontend/rec_union_infer.ts`, moved static-rec expression
  inference into `src/frontend/rec_infer.ts`, and moved shared static-rec
  helpers into `src/frontend/rec_util.ts`, with static-rec lower-graph hook
  assembly in `src/frontend/lower_static_rec_adapter.ts` and the lowerer
  supplying the environment, type, static-loop, and Ic-lowering hooks.
- Moved lazy lower/eval/prepare/infer and `if`/`if let` bridge wrappers into
  `src/frontend/lower_graph/bridge.ts`, keeping cyclic hook access explicit and
  reducing wrapper weight in `src/frontend/lower_graph.ts`.
- Split frontend annotation handling so `src/frontend/annotation_types.ts` owns
  the hook contract, `src/frontend/annotation_resolve.ts` owns annotation type
  and numeric resolution, `src/frontend/annotation_context.ts` owns direct
  struct/union annotation context, and `src/frontend/annotation_check.ts` owns
  binding annotation checks; `src/frontend/annotations.ts` remains the public
  facade for runtime binding annotation application and assignment type
  selection, with the lowerer supplying value-resolution and static-lowering
  hooks.
- Moved frontend annotation hook composition and annotation adapter glue into
  `src/frontend/lower_annotation_adapter.ts`, keeping binding/type annotation
  wiring out of `src/frontend/lower_graph.ts`.
- Moved frontend lexical expression substitution for deferred const-call
  inlining into `src/frontend/substitute.ts`, so parameter, block, loop, and
  `if let` payload shadowing rules are isolated from semantic lowering.
- Moved Core text data encoding helpers into `src/core/text.ts`, leaving the
  backend to own control-flow and static-value emission while text bytes and
  alignment stay in a focused module.
- Moved Core static text recognition, text concatenation visibility checks, and
  static text length/index helpers into `src/core/text_static.ts`, with the
  backend supplying aggregate-shape and expression-type hooks.
- Moved Core visible/runtime text fact recognition and runtime text-concat
  operand detection into `src/core/text_facts.ts`, with the backend supplying
  expression-type, static struct, and static text hooks.
- Moved Core text data layout scanning and heap-start calculation into
  `src/core/text_layout.ts`, with the backend supplying static-value,
  aggregate-shape, union-case, and type hooks. `src/core/text_layout.ts` is now
  a compatibility facade over `src/core/text_layout/build.ts`,
  `src/core/text_layout/types.ts`, and `src/core/text_layout/param.ts`.
- Moved Core runtime text WAT helpers for heap concatenation, length loads, byte
  loads, and byte assignment into `src/core/runtime_text.ts`, with the backend
  supplying expression emission, type checks, and runtime-concat detection.
- Moved Core backend text hook composition and text-specific adapter glue behind
  `src/core/backend/text.ts`, with static text adapters in
  `src/core/backend/text/static.ts`, text fact adapters in
  `src/core/backend/text/facts.ts`, text layout adapters in
  `src/core/backend/text/layout.ts`, and runtime text emission adapters in
  `src/core/backend/text/runtime.ts`, keeping static/runtime text hook wiring
  out of `src/core/backend.ts`.
- Moved Core memory-layout helpers for scalar sizes, alignment, loads, and
  stores into `src/core/memory.ts`.
- Moved Core runtime-union payload layout, static-shaped struct payload
  validation, and packed payload-size calculation into
  `src/core/runtime_union_payload.ts`, with the backend supplying static struct,
  text, and expression-type hooks.
- Moved Core runtime-union value/type recognition, pointer-target discovery,
  case metadata, and match-case metadata behind the `src/core/runtime_union.ts`
  facade, with the implementation split under `src/core/runtime_union/` into
  focused runtime value, type-expression/equality, case metadata, target
  resolution, match metadata, and size modules. The backend supplies closure
  typing, dynamic union-if, static union-case, static struct, text, and
  expression-type hooks.
- Moved Core runtime-union match payload fact binding, static/core branch
  context creation, and temporary payload-local construction into
  `src/core/runtime_union_match.ts`, keeping packed payload field reconstruction
  out of the backend emitter.
- Moved Core runtime-union heap materialization and pointer `if let` control
  flow into `src/core/runtime_union_emit.ts`, while packed struct payload stores
  and payload loads for pointer matches live in
  `src/core/runtime_union_payload_emit.ts`, with the backend supplying
  expression emission, expression typing, statement emission, static struct
  facts, branch context, and case metadata hooks.
- Moved Core backend union hook composition and union-specific adapter glue
  behind `src/core/backend/union.ts`, with static union adapters in
  `src/core/backend/union/static.ts` and runtime union adapters in
  `src/core/backend/union/runtime.ts`. Runtime union adapter contracts,
  type/match metadata hooks, and local/WAT emission hooks live in
  `src/core/backend/union/runtime/types.ts`,
  `src/core/backend/union/runtime/info.ts`,
  `src/core/backend/union/runtime/info/hooks.ts`,
  `src/core/backend/union/runtime/info/query.ts`,
  `src/core/backend/union/runtime/info/match.ts`, and
  `src/core/backend/union/runtime/emit.ts`, keeping static/runtime union hook
  wiring out of `src/core/backend.ts`; `if_let_dispatch.ts` now takes direct
  runtime-union emit callbacks from that adapter instead of a separate runtime
  hook object.
- Moved Core backend leaf utilities such as local registration, static index
  checks, temporary local naming, and indentation into
  `src/core/backend/util.ts` so the backend file keeps more of its weight on
  lowering rules.
- Moved Core static-call statement-scope detection and assignment-through-AST
  checks into `src/core/scope_analysis.ts`, so backend static-call planning can
  depend on a focused Core AST analysis module.
- Moved Core type-level static evaluation, type-name resolution, and type
  constructor substitution into `src/core/type_static.ts` so the backend does
  not own both type metaprogramming and WAT emission details.
- Moved Core binding/parameter annotation validation, direct struct/union
  annotation context, structural type-pattern checks, and value type-name checks
  into `src/core/type_check.ts`, with the backend supplying text, union,
  static-call, and expression-typing hooks.
- Moved Core backend type-check hook composition and type-check adapter glue
  into `src/core/backend/analysis/type_check.ts`, with the adapter contract in
  `src/core/backend/analysis/type_check/types.ts`, keeping annotation,
  type-pattern, value-type-name, and const type-value wiring out of
  `src/core/backend.ts`.
- Moved Core closure-function, text-local, and runtime union-local fact tracking
  into `src/core/local_facts.ts`, with the backend supplying closure typing,
  runtime-union type lookup/equality, and static type hooks.
- Moved Core backend local-fact hook composition and local-fact adapter glue
  into `src/core/backend/analysis/local_facts.ts`, keeping function-type,
  text-local, and runtime union-local fact wiring out of `src/core/backend.ts`.
- Kept `src/core/local_collect.ts` as the Core local/context collection facade,
  moved the shared context/hook contract into `src/core/local_collect/types.ts`,
  and split the main statement/expression traversal into
  `src/core/local_collect/stmt.ts` and `src/core/local_collect/expr.ts`.
- Moved Core backend local-collection hook composition and local-collection
  adapter glue into `src/core/backend/entry/local_collect.ts`, with the backend
  contract in `src/core/backend/entry/local_collect/types.ts`, keeping type,
  static, union, text, closure, recursion, and index hook wiring out of
  `src/core/backend.ts`.
- Moved Core recursion-specific local collection into
  `src/core/local_collect_rec.ts`, and Core `if let` local collection into
  `src/core/local_collect_if_let.ts`. Moved closure-valued local collection into
  `src/core/local_collect_closure.ts`, block-expression final statement
  collection into `src/core/local_collect_block.ts`, static `if/else` statement
  branch collection into `src/core/local_collect_if_else.ts`, and
  range/static/text collection-loop local collection into
  `src/core/local_collect_loop.ts`, keeping those feature-specific traversal
  rules out of the main collector.
- Moved Core lexical expression substitution for const-call inlining into
  `src/core/substitute.ts`, mirroring the frontend substitution module and
  keeping lambda, block, loop, and `if let` shadowing rules out of the backend
  emitter.
- Kept Core scoped static-call expression rewriting exported from
  `src/core/static_call_rewrite.ts` and split statement/block rewriting plus
  replacement-name shadowing under `src/core/static_call_rewrite/`, keeping
  statement-bodied inline-call AST rewriting separate from static-call planning
  and WAT emission.
- Kept Core static-call public exports in `src/core/static_call.ts` and split
  the implementation under `src/core/static_call/`: `types.ts` owns the shared
  context/hook contract, `arity.ts` owns arity checks, `target.ts` owns
  static-call/static-rec target discovery and scope-free substitution, and
  `scoped.ts` owns scoped static-call type/emission planning.
- Moved Core backend static-call adapter glue into
  `src/core/backend/values/static_call.ts`, with the backend contract in
  `src/core/backend/values/static_call/types.ts`, hook-object assembly in
  `src/core/backend/values/static_call/hooks.ts`, scoped-call wrappers in
  `src/core/backend/values/static_call/scoped.ts`, and lookup/target wrappers in
  `src/core/backend/values/static_call/lookup.ts`, keeping static-call hook
  wiring out of `src/core/backend.ts`.
- Moved Core statement-level `if`/`if else` WAT emission into
  `src/core/if_stmt.ts`, with the backend supplying condition typing,
  expression/statement emission, static capture planning, and static assignment
  merging hooks.
- Moved Core general statement WAT dispatch into `src/core/stmt_emit.ts`,
  including binds, assignments, loop/branch dispatch, final-expression handling,
  drops, and index-assignment routing, with the backend supplying static-value,
  local-fact, loop, text, and nested emit hooks.
- Moved Core `if let` dispatch between static union, dynamic union-if, and
  runtime union-pointer lowering into `src/core/if_let_dispatch.ts`, with the
  backend supplying static, dynamic, and runtime target discovery hooks.
- Moved Core `if let` statement/expression WAT emission into
  `src/core/if_let.ts`, with the backend supplying static union-case lookup,
  dynamic union-if discovery, expression typing, and nested emit hooks.
- Moved Core static and emission-time `if let` payload binding into
  `src/core/if_let_payload.ts`, with `src/core/emit_ctx.ts` supplying branch
  context cloning and the backend supplying expression emission/type hooks,
  static struct lookup, text facts, and local-fact clearing.
- Moved Core static union-case lookup, dynamic union-if discovery, and dynamic
  `if let` payload binding into `src/core/union_static.ts`, with the backend
  supplying type-value, static-call, and expression-typing hooks.
- Moved Core recursive-call result typing, initial parameter binding, tail-call
  detection, and tail-call argument validation into `src/core/rec_type.ts`, with
  the backend supplying annotation, expression typing, local-collection, and
  context-cloning hooks.
- Moved Core tail-recursive call/body WAT emission into `src/core/rec_emit.ts`,
  with the backend supplying parameter annotation, tail-call validation, result
  typing, context cloning, and nested emit hooks.
- Moved Core backend recursion hook composition and recursion-specific adapter
  glue into `src/core/backend/runtime/rec.ts`, keeping recursive typing/emission
  hook wiring out of `src/core/backend.ts`.
- Moved Core expression and final-statement result typing into
  `src/core/expr_type.ts`, with the backend supplying application, text, union,
  static-value, closure, block-local collection, and payload-fact hooks.
- Moved Core backend expression-type hook composition and primitive operand
  specialization into `src/core/backend/analysis/expr_type.ts`, keeping
  result-type hook wiring out of `src/core/backend.ts`.
- Moved Core application result typing for `len`, `get`, `panic`, recursive
  calls, static calls, scoped static calls, and dynamic closure calls into
  `src/core/app_type.ts`, with the backend supplying collection, text,
  recursion, static-call, and closure hooks.
- Moved Core application WAT dispatch for the same shapes into
  `src/core/app_emit.ts`, with the backend supplying static analysis, text
  helpers, closure typing, and nested emit hooks.
- Moved Core backend application hook composition and application adapter glue
  into `src/core/backend/entry/app.ts`, keeping app typing/emission wiring out
  of `src/core/backend.ts`.
- Moved Core first-class closure environment allocation and dynamic
  `call_indirect` emission into `src/core/closure_emit.ts`, shared closure
  runtime shapes/constants into `src/core/closure_runtime.ts`, closure lift
  registration, environment layout, and function-table type registration into
  `src/core/closure_lift.ts`, and lifted closure function emission into
  `src/core/closure_lift_emit.ts`, with the backend supplying closure typing and
  nested expression/local hooks.
- Moved Core closure-valued `if` WAT emission into
  `src/core/closure_if_emit.ts`, with the backend supplying closure type
  refinement, nested statement/expression emission, and runtime closure emission
  hooks.
- Moved Core first-class closure function-type discovery, selected-branch
  closure type checking, and closure-call argument validation into
  `src/core/closure_type.ts`, with the backend supplying expression typing,
  runtime-union result facts, capture discovery, annotation checks, and scoped
  static-call hooks.
- Moved Core lambda runtime-capture discovery and static capture snapshot
  planning into `src/core/closure_capture.ts`, with the backend supplying static
  struct-binding lookup for supported captured aggregate index-assignment cases.
  Removed unused capture-free runtime-local traversal from that module so it
  only carries active capture planning and assignment analysis.
- Moved Core backend closure hook composition and closure-specific adapter glue
  behind `src/core/backend/closure.ts`, with capture adapters in
  `src/core/backend/closure/capture.ts`, closure type adapters in
  `src/core/backend/closure/type.ts`, runtime closure emission adapters in
  `src/core/backend/closure/emit.ts`, and closure-valued `if` adapters in
  `src/core/backend/closure/if.ts`, keeping closure capture/type/emission hook
  wiring out of `src/core/backend.ts`.
- Moved Core static aggregate index-assignment planning/emission into
  `src/core/index_assign.ts`, with the backend supplying type checks, static
  text/value planning, expression stability, and nested emit hooks.
- Moved Core backend index hook composition and index-specific adapter glue into
  `src/core/backend/entry/index.ts`, keeping static index assignment, dynamic
  index emission, and collection item-type hook wiring out of
  `src/core/backend.ts`.
- Moved Core expression-level WAT emission into `src/core/expr_emit.ts`, with
  the backend supplying static value/text facts, app/if-let/closure emitters,
  runtime text helpers, and nested statement/expression hooks.
- Moved Core backend expression-emission hook composition and closure-valued
  `if` dispatch into `src/core/backend/emit/expr.ts`, keeping expression emit
  hook wiring out of `src/core/backend.ts`.
- Moved Core backend statement-emission hook composition into
  `src/core/backend/emit/stmt.ts`, keeping bind, loop, branch, text assignment,
  and static index assignment dispatch wiring out of `src/core/backend.ts`.
- Added `src/core/proof.ts`, `Core.proof(...)`, and `Core.check_proof(...)` as
  the first explicit `core-3-nonweb` no-GC proof harness. It aggregates
  final-result escape facts, borrow validation, explicit `freeze` edges, scratch
  cleanup/reset facts, unique-owner drop facts, and lifetime scopes with
  `managed_storage: "disabled"`. `Core.emit(...)` and `Core.mod(...)` now run
  `Core.check_proof(...)` before producing WAT/module artifacts, while
  `Core.type(...)` remains a type-query surface rather than the emission gate.
  The drop/proof path treats static-shaped aggregates, aggregate updates, and
  extension objects as ownerless compiler facts, matching the existing
  scalarized aggregate representation instead of forcing those values through
  runtime heap ownership. The first host/import boundary slice is also wired
  through this gate: known `Core.host_imports` entries record scalar,
  bounded-borrow, and ownership-transfer argument contracts; proof output
  records the matched signature and per-argument decision; `Core.drops(...)`
  records `host_transfer` facts for direct unique-owner transfer;
  `Core.proof(...)` rejects later direct use of a transferred owner; module
  emission writes the WAT import/call.
- Moved Core dynamic index selection over static aggregate shapes into
  `src/core/index_expr.ts`, and pure visible text byte-index expression
  construction into `src/core/text_index.ts`, keeping those leaf lowering rules
  out of the backend emitter.
- Moved assigned-name discovery for statement merge analysis into
  `src/core/assigned_names.ts`.
- Moved static-value stability analysis for static captures, merge planning, and
  index-assignment planning into `src/core/static_stability.ts`.
- Moved statement-level static `if/else` assignment merging into
  `src/core/static_merge.ts`, with the backend supplying static struct-capture
  planning.
- Moved Core backend control-flow hook composition and control-flow adapter glue
  behind `src/core/backend/control_flow.ts`, with range and collection-loop
  adapters in `src/core/backend/control_flow/loop.ts`, `if let` and payload
  adapters in `src/core/backend/control_flow/if_let.ts`, `if let` hook builders
  in `src/core/backend/control_flow/if_let/hooks.ts`, and `if`
  statement/static-merge adapters in `src/core/backend/control_flow/if_stmt.ts`,
  keeping range-loop, collection-loop, `if`, `if let`, runtime-union `if let`,
  payload binding, and static branch-merge wiring out of `src/core/backend.ts`.
- Moved Core static struct-value resolution, static struct updates, dynamic
  struct-if reshaping, and static collection-field projection into
  `src/core/struct_static.ts`, with the backend supplying expression-type and
  static-call hooks.
- Moved Core backend static-struct hook composition and struct-specific adapter
  glue into `src/core/backend/values/struct.ts`, keeping static struct hook
  wiring out of `src/core/backend.ts`.
- Moved Core static value capture planning for structs, unions, text, dynamic
  aggregate branches, and static-value recognition into
  `src/core/static_values.ts`, with the backend supplying text, union, struct,
  runtime-union, expression-type, and nested emit hooks.
  `src/core/static_values.ts` is now a compatibility facade over
  `src/core/static_values/types.ts`, `src/core/static_values/recognition.ts`,
  and `src/core/static_values/plan.ts`.
- Moved Core backend static-value hook composition and static-value adapter glue
  into `src/core/backend/values/static_value.ts`, with the backend contract in
  `src/core/backend/values/static_value/types.ts`, hook adapters in
  `src/core/backend/values/static_value/hooks.ts`, recognition wrappers in
  `src/core/backend/values/static_value/recognition.ts`, and capture planning
  wrappers in `src/core/backend/values/static_value/plan.ts`, keeping
  static-value hook wiring out of `src/core/backend.ts`.
- Implemented minimal `Core.emit` WAT lowering for scalar `i32` range loops,
  including single-evaluated start/end/step values, dynamic positive and
  negative steps, no-else `if`, statement-level dynamic `if ... else` assignment
  branches, `break`, and `continue`, with WAT-to-Wasm instantiation tests.
- Implemented `Core.emit` WAT lowering for scalar dynamic tail recursion by
  initializing recursive parameter locals, emitting a result block around a Wasm
  loop, and turning tail `rec(...)` calls into simultaneous parameter updates
  plus a branch back to the loop, with WAT-to-Wasm instantiation coverage.
- Implemented `Core.emit` WAT lowering for static collection loops over literal,
  statically bound, or compatible dynamic `if` object/struct shapes by unrolling
  fields, field/static-index scalarization, `len`/`get` calls through statically
  bound aggregate shapes, and dynamic aggregate index expressions over
  homogeneous fields via structured typed `if` chains with trap fallbacks.
  Static-call block bodies now collect block-local locals before emitting
  inlined collection loops with carried state. Direct dynamic statically shaped
  aggregate `if` field/index access and same-case dynamic union `if` payload
  selection through `if let` are covered by WAT-to-Wasm instantiation tests.
  Runtime aggregate pointers with known struct layout now also expose collection
  facts for homogeneous fields, including nested aggregate fields whose inline
  struct layout is stored inside the parent aggregate pointer. Implemented
  range-loop WAT emission through `src/core/range_loop.ts` and static aggregate
  and `Text` collection-loop WAT emission through `src/core/collection_loop.ts`,
  with the backend adapter supplying the semantic hooks for expression emission,
  statement emission, static aggregate facts, and text recognition.
- Implemented `Core.emit` WAT lowering for static `if let` statements and
  expressions over literal or statically bound shorthand and typed-constructor
  union cases by emitting matching bodies and payload local bindings, with
  WAT-to-Wasm instantiation coverage.
- Implemented `Core.emit` WAT lowering for typed scalar/`Text`/`Unit` and
  static-shaped struct union values by materializing direct typed constructors
  and direct dynamic `if` branches over typed union cases into heap objects with
  an `i32` tag, scalar/text-pointer payload slots, union-pointer payload slots,
  or packed nested struct-field slots, and pointer result, with WAT-to-Wasm
  memory inspection coverage, including direct union-pointer payload matching.
- Implemented `Core.emit` static analysis for type-level const bindings while
  preserving simple const aliases to visible type-values and builtin type names,
  validating and then eliding destructuring `type_check` statements from
  generated WAT, with WAT-to-Wasm instantiation coverage.
- Implemented frontend elision for non-final expression statements proven to be
  compile-time-only, including type-values and `with` extension expressions:
  they are const-validated and skipped before Ic lowering, while final
  type-value results remain rejected as non-runtime values.
- Implemented `Core.emit` static instantiation of simple const type constructors
  returning struct/union type-values, including curried calls, with WAT-to-Wasm
  instantiation coverage.
- Implemented structured Core validation for built-in scalar/type binding
  annotations before WAT emission, and explicit rejection for unsupported Core
  binding annotations, with WAT-to-Wasm instantiation coverage for valid
  annotated bindings.
- Implemented structured Core preservation of closure parameter annotations and
  built-in scalar/type parameter checks during static Core call inlining. Direct
  struct/union type-value parameter annotations provide static call argument
  context, with WAT-to-Wasm coverage.
- The frontend Ic path also uses explicit runtime binding and parameter
  annotations as type context for otherwise unknown runtime scalar, `Text`,
  struct, and union values, and same-type reassignment preserves that explicit
  context for later Ic lowering. Static-rec lowering preserves the same context
  for annotated rec parameters and rec-local bindings when lowering `Text`
  length, byte indexing, `get`, struct projection, struct indexing, struct
  `get`, dynamic scalar/text `if` results, dynamic struct `if`
  result/projection/index lowering, statement-level dynamic `if`/`if let`
  fallthrough, dynamic struct index-assignment rebuilds, and union `if let` over
  captured runtime values, including dynamic union `if` targets consumed by
  `if let`. Known incompatible value types are still rejected.
- `Core.emit` also treats known `let` closures as inlineable static call
  targets, snapshots scalar runtime captures into hidden locals at binding time,
  and uses hidden parameter/block-local names for statement-bodied inline calls.
  It has WAT-to-Wasm coverage for text collection loops inside such closures,
  closure-local parameter assignment, caller-safe local shadowing, and
  later-shadowed scalar captures. `Core.mod` lowers first-class scalar closures
  with annotated scalar parameters by emitting closure environments, lifted
  functions, a function table, a heap pointer global, and `call_indirect`. The
  closure environment allocation lives in `src/core/closure_emit.ts`,
  environment layout and function-table type registration live in
  `src/core/closure_lift.ts`, lifted-function WAT emission lives in
  `src/core/closure_lift_emit.ts`, and runtime-capture discovery and static
  capture snapshots live in `src/core/closure_capture.ts`, with unused
  capture-free runtime-local traversal removed from that module. Captured
  first-class closure pointers and closures returned from scoped static calls
  keep their callable signatures, including returned closures with annotated
  `I64` parameters/captures stored in 8-byte-aligned environment slots. The
  static text-layout scan enters annotated lambda/rec bodies with scoped
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
  before rebuild. The frontend also rebuilds typed runtime structs with runtime
  scalar/text payloads by using declared field types to lower the generated
  dynamic field selections. Runtime locals known to have type `Text` lower byte
  index assignment to bounds-checked `i32.store8`, including lifted first-class
  closure bodies and captured runtime `Text` locals inside first-class closure
  environments, with WAT-to-Wasm mutation and trap coverage. Captured aggregate
  and non-Text memory-backed index assignment remains reserved.
- Implemented structured Core direct type annotation context for visible
  struct/union type-values, including shorthand union cases, object values, and
  dynamic union-if branches whose cases belong to the annotated union, with
  WAT-to-Wasm coverage. Visible `Text` payloads flowing through those dynamic
  union-if values stay available to later `if let` text operations such as
  `len`, with shadowing covered by WAT-to-Wasm tests. Frontend dynamic union
  branch inference preserves explicit named struct payloads before Ic lowering,
  and Core dynamic union-if `if let` lowering keeps named struct payloads as
  branch-local static aggregate facts, with field access covered by WAT-to-Wasm
  tests.
- Implemented `Core.data` and `Core.emit` support for text literals as
  length-prefixed UTF-8 data pointers, with WAT-to-Wasm memory coverage.
- The `Source -> Core` path also preserves unknown collection loops and unknown
  index assignments so later fact-directed memory/codegen work has structured
  inputs.
- `Core.emit` applies static and dynamic index assignments to statically bound
  object/struct shapes by capturing runtime index and value expressions in
  hidden locals as needed, with WAT-to-Wasm instantiation coverage. Visible
  `Text` update values stay available to later text operations after dynamic
  index assignment and shadowing. Inlineable static closure calls clone captured
  static aggregate shapes and static aggregate arguments before applying those
  index-assignment rebuilds.
- `Core.emit` rebuilds static-shaped struct update expressions by replacing the
  updated fields in the static aggregate shape and capturing runtime update
  values in hidden locals, with WAT-to-Wasm instantiation coverage.
- `Core.emit` captures runtime field values, union payloads, and dynamic
  aggregate/union `if` bindings into hidden locals when statically shaped values
  are bound or assigned, preserving value semantics under later shadowing.
- `Core.emit` preserves compatible static-shaped struct and visible text
  assignments across statement-level dynamic `if ... else` branches by capturing
  the branch condition before either branch runs and merging the selected fields
  or text value afterward.
- The `Mod` layer emits and validates Wasm function imports, including imported
  function exports and local/import duplicate-name checks, with a WAT-to-Wasm
  instantiation test that calls a host function.
- The `Mod` layer emits a single Wasm memory and active data segments, with a
  WAT-to-Wasm instantiation test that reads initialized bytes from memory.
- Text literals lower through Ic and Expr to `i32` pointers into length-prefixed
  UTF-8 module data, with a frontend WAT-to-Wasm instantiation test that checks
  the returned pointer and initialized bytes.
- Core text literals also emit through `Core.data` to the same module data
  representation.
- Core `panic("...")` emits WAT `unreachable`, with WAT-to-Wasm runtime trap
  coverage.
- Core `if let` expressions and statements whose target is a direct or
  statically bound dynamic `if` over shorthand or typed-constructor union-case
  branches lower to Wasm control flow without runtime union storage.
- Core `if let` expressions and statements also consume simple const-call
  results that statically inline to dynamic union `if` values, preserving the
  selected condition through hidden locals before WAT emission.
- Core static aggregate analysis also consumes simple const-call results that
  statically inline to dynamic object/struct `if` values, allowing collection
  loops over those shapes to unroll before WAT emission.
- Dynamic text `if` expressions and dynamic indexes over homogeneous visible
  text fields lower by selecting between text data pointers.
- Visible text literals, bindings, fields, indexes, const-call results, and
  dynamic text branches concatenate with `+` before Ic/Expr data-pointer
  lowering, with frontend WAT-to-Wasm memory coverage for concatenated text.
- The frontend rejects text-typed values as numeric primitive operands unless
  both operands are in the visible text concatenation subset, and rejects other
  known non-numeric operands before primitive Ic lowering.
- `Core.data` and `Core.emit` lower visible Core text concatenation to
  length-prefixed UTF-8 module data pointers, including dynamic indexes over
  visible text fields, with WAT-to-Wasm memory coverage.
- `Core.emit` lowers runtime `Text` concatenation to a heap allocation that
  stores a length prefix and copies the left and right UTF-8 byte ranges with
  structured Wasm loops. Simple static-call text results are also visited during
  data-layout collection so folded text has a data segment, with WAT-to-Wasm
  coverage.
- `len` over frontend-visible text values lowers to Ic `i32` byte lengths,
  including dynamic text `if` branches and dynamic indexes over visible text
  fields whose alternatives are visible.
- Static and dynamic byte indexes, plus `get(text, index)`, over simple
  block-local visible text values and dynamic indexes into visible text fields
  lower to Ic byte-selection chains with trap fallbacks.
- Static byte indexes over dynamic frontend-visible text branches lower
  branch-local out-of-range cases to `i32.trap`, so only the selected short
  branch traps at runtime.
- `len` over runtime values known to have type `Text` lowers through Ic/Expr to
  `i32.load` from the length-prefixed text pointer, with WAT-to-Wasm coverage.
- `borrow`, `freeze`, and `scratch` wrappers around runtime values known to have
  type `Text` now erase on the pure Ic route when the wrapped value is returned,
  matching the existing unwrapped runtime text identity path. Inlineable helpers
  that return the same runtime `Text` binding, including through transparent
  `scratch {}` wrappers, now fold `helper(input) == helper(input)` to `1:i32`;
  helpers that allocate or transform runtime text still route equality through
  structured Core/Wasm.
- Static-call result inference now reuses the specialized call environment, so
  builtin lowering can see `Text` results returned by simple annotated helpers,
  including helpers that return the text through transparent ownership wrappers.
- Inline-specialized helper calls now apply known runtime annotations to unknown
  arguments before visible-value probing, so `helper(input)[index]` and
  `get(helper(input), index)` over annotated `Text` helpers lower through the
  same runtime `Text` Ic byte-load path.
- Runtime values known to have type `Text` can be byte-indexed through Ic/Expr
  as a bounds-checked `i32.load8_u(pointer + 4 + index)`, with WAT-to-Wasm
  coverage for in-range values and out-of-range traps.
- `get(value, index)` over runtime values known to have type `Text` lowers to
  the same bounds-checked byte load path, with WAT-to-Wasm coverage for in-range
  values and out-of-range traps.
- Static-rec application result typing preserves annotated static-shaped struct
  and nested `Text` fields after the rec call returns, so expressions such as
  `selected.name.first` can feed runtime `Text` operations after Ic lowering.
- Static-rec app lowering can now receive an expected result type from annotated
  bindings and annotated call arguments. Dynamic rec result branches that are
  otherwise unknown lower as typed scalar/`Text` selects, typed struct handler
  values, or typed union handler values before the pure Ic route continues.
  Block-local alias results inside the rec result keep that expected type, so
  branch-local ownership wrappers can still lower through typed struct field
  projection and union handler selection.
- Expected-type pure-Ic lowering now unwraps simple one-expression block
  results, single-return block results, and pure two-statement alias blocks
  before applying typed dynamic branch lowering. Annotated bindings, annotated
  call arguments, and direct text reads such as
  `{ if flag { input } else { other } }`,
  `{ return if flag { input } else { other } }`, or
  `{ let selected: Text = if flag { input } else { other }; selected }` keep
  their scalar, `Text`, struct, or union context instead of falling back to
  untyped branch lowering. The same path now preserves the expected type before
  struct field projection or union handler selection when those block-local
  branches contain `borrow`, `freeze`, or simple `scratch {}` wrappers, including
  typed union `if let` branch results.
- Static-rec union payload bindings preserve user-defined annotation type names
  before Ic lowering, so recursive `if let` bodies can project nested struct
  fields and use runtime `Text` operations on payload fields.
- `Core.emit` lowers `len` over visible text literals, bindings, dynamic text
  branches, and dynamic indexes over visible text fields to `i32` byte lengths,
  with WAT-to-Wasm coverage.
- Static byte indexes over frontend-visible text lower to Ic `i32` UTF-8 byte
  values. `Core.emit` lowers static and dynamic byte indexes over visible text
  to WAT values, using structured control flow and `unreachable` for
  out-of-range dynamic indexes. `Core.emit` also lowers `get(text, index)` over
  visible text and runtime values known to have type `Text` to the same
  byte-index path, with WAT-to-Wasm coverage for in-range values and
  out-of-range traps.
- Frontend-visible text collection loops lower as UTF-8 byte expansion through
  Ic. Concrete visible `Text` arguments passed to closures that index, call
  `len`/`get`, or iterate the parameter specialize before Ic expansion.
  `Core.emit` lowers visible text and runtime values known to have type `Text`
  to Wasm `block`/`loop` control flow over length-prefixed UTF-8 text data, with
  WAT-to-Wasm coverage for `break` and `continue`.
- The pure Ic frontend folds identity equality for the same runtime `Text`
  binding. Annotated `Text` parameters or bindings can lower `value == value`,
  `value != value`, and transparent `borrow`/`freeze`/`scratch` wrappers around
  the same binding without entering the runtime byte-compare route. Simple
  block-local `let` aliases inside a returned scratch/block value are treated as
  transparent only for this identity check; non-identical runtime text
  comparisons still route to structured Core/Wasm.
- The frontend lowers direct non-escaping local closure calls, including
  parameterized calls, simple local aliases, simple block-local aliases/direct
  block calls, literal-condition static closure branches, and dynamic ordinary
  function branches, including simple aliases to known closures, with
  scalar/text-pointer Ic results plus frontend-known struct/union consumers, and
  rejects incompatible dynamic function branch parameter shapes before generic
  dynamic `if` lowering. The frontend also lowers dynamic union-if `if let`
  expressions whose branches return direct non-linear closures with compatible
  parameter shapes, while validating outer linear-value consumption at the call
  site before Ic reduction. The structured Core path now also supports
  closure-valued `if let` expressions over direct dynamic union-if targets and
  stored runtime-union pointer targets, including payload captures in lifted
  closure environments, one-sided branch signature inference, and WAT-to-Wasm
  `call_indirect` coverage for matching and fallback branches.
- General dynamic loop codegen, unknown runtime collection codegen, general
  first-class linear closure captures, frontend aggregate memory layout, unknown
  dynamic `if let` outside typed/direct union-if or inlineable helper-call and
  closure-call union-result shapes, runtime union payload storage/matching
  outside the implemented scalar, `Text`, `Unit`, union-pointer, and
  aggregate-pointer struct payload cases, unknown runtime text/string operations
  outside the supported visible literal/concat/data-pointer cases and runtime
  `Text` length, byte-load, `get`, byte assignment, collection-loop, and Core
  runtime concat subset, and effectful linear capabilities are not yet
  represented in a structured Wasm-oriented IR.
- Static-loop skipped-step fallback lowering now materializes inner no-else
  `if`/`if let` fallbacks before adding the dynamic loop-control guard. This
  preserves the same Ic-safe scalar/text/struct/union fallback behavior inside
  guarded loop bindings, including no-else union bindings consumed by later
  `if let` statements.
- Dynamic `if let` union-result lowering now handles encoded nested dynamic
  union targets, not only direct union-case target branches. This lets guarded
  loop bindings such as `let result = if let .some(value) = maybe { ... }`
  lower through pure Ic even when `maybe` is a skipped-step union value whose
  active branch is itself a dynamic union `if`.
- Expected-type aggregate lowering now falls through from the direct dynamic
  `if` probe to the typed aggregate path when the direct route reports generic
  struct or union branches. This keeps annotated guarded loop bindings such as
  `let user: user_type = { let selected = if let ...; return selected }` and
  `let option: option_type = { ... }` lowerable through Ic after dynamic static
  loop `break`/`continue` state, including ownership-wrapper branches.
- Union-result inference for implicit no-else `if let` expressions now produces
  the inferred then-case table when that table has a valid implicit fallback.
  Static-loop skipped-step binding expansion uses that union-case inference
  before generic expression inference, so shorthand results such as
  `if let .some(value) = maybe { .ok(value) }` keep their payload type and lower
  through later union handlers.
- General expression inference now binds known `if let` payload types while
  inferring the then branch. Static-loop skipped-step bindings that return the
  matched payload directly can therefore synthesize `Text` and struct fallbacks
  without requiring a manual annotation.
- Expected-type `if let` lowering now backs off from speculative direct
  lowering when direct no-else fallback inference is weaker than the expected
  result type. This lets nested block-final no-else `if let` payload selections
  lower through the typed handler path instead of failing with an unknown
  fallback.
- Direct-lambda resolution now includes simple two-statement block-local aliases
  used after dynamic static-loop control. The skipped-step function binding path
  normalizes the active value before building the guard, so loop-local aliases
  such as `let f = { let id = x => x; id }` inline at call sites instead of
  reaching Ic reduction as unresolved runtime applications.
- The same direct-lambda path now accepts a non-linear binding prefix before the
  returned block-local function alias or direct returned lambda. Value-backed
  bindings from the static-loop expansion snapshot are cloned as inline facts
  for the captured lambda environment, which keeps loop-local captures such as
  `offset = i + 1` concrete before Ic reduction.
