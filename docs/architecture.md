# Compiler Architecture

Ducklang has one frontend and two backend routes. The split is explicit because
the current Interaction Calculus IR models affine computation and local graph
rewrites, while the structured Core IR also carries control-flow, storage,
ownership, host-boundary, and cleanup evidence.

```txt
                                  reduce       lower
                              -> Ic graph ------------> Expr --+
                             /                              |
Source -> parse/analyze ----+                               +-> Mod -> WAT -> Wasm
                             \                              |
                              -> structured Core ----------+
                                      |
                                      +-> proof and cleanup
                                      |
                                      +-> managed ABI wrapper
```

## Shared frontend

The frontend owns source syntax, diagnostics, binding and canonical type facts,
linearity, compile-time evaluation, effect specialization, and import
resolution. Its implemented stages are explicit:

```txt
syntax -> names/scopes -> canonical types/facts
       -> const/affine/effect validation -> elaboration
       -> route validation -> lowering
```

`src/frontend/pipeline.ts` owns those backend-free stages. `source.ts` is the
route facade: it selects IC, Core, or managed lowering after the shared language
contract succeeds. Shared frontend modules do not import Core or WAT emitters.

`duck check` intentionally runs this shared analysis without forcing every
program through one backend. `duck build` selects a concrete route and reports
route-specific rejection during compilation.

## IC route

Entry points: `Source.compile`, `Source.ic_mod`, and `Source.ic_wat`.

The IC route owns explicit duplication, superposition, erasure, lambda
interaction, primitive propagation/folding, recursive scalar fixpoints, graph
reduction, and the pure no-GC proof. Reduced terms lower to `Expr`, whose only
job is to compute one Wasm value. `Expr` then enters the shared `Mod` layer.

This route is the place to test alignment with Interaction Calculus theory. New
structured runtime features do not belong here unless their IC representation
and rewrite behavior are designed first.

## Core route

Entry points: `Source.core`, `Source.mod`, and `Source.wat`.

Core owns structured statements and control flow, runtime aggregates and text,
closures, handlers, allocation, ownership, borrows, freezing, scratch lifetimes,
host boundaries, and cleanup. Its proof and emission graph produces a `Mod`
directly.

Core source adapters may depend on frontend source types, and Core emission may
depend on the shared Wasm module layer. Frontend semantic code must not depend
on concrete Core emission instructions.

Core dependencies flow in one direction:

```txt
model -> analysis -> plan -> emit -> backend
```

`core/model/` owns immutable allocation, ownership, union, and static-value
contracts. `core/analysis/` owns pure field and static-value queries.
Allocation, drop, cleanup, closure, and ownership modules build plans from those
contracts. `core/emit/` owns WAT formatting, local declarations, and generated
names, while `core/backend/` composes the public route. Source-language type
syntax enters Core only through `core/from_source/` adapters.

The dependency check rejects reverse layer imports, shared-frontend backend
imports, Core imports that bypass `from_source`, and every multi-file strongly
connected component. The checked baseline is empty, so any new finding fails CI.

## Managed route

Entry points: `Source.artifact` and `Source.artifact_file`.

The managed route wraps a Core module with the `duck-js-1` ABI. It emits an ABI
manifest, marshaling exports, allocation hooks, and typed effect imports.
`DuckHost` validates and instantiates that contract.

## Shared module boundary

`Mod` owns Wasm functions, imports, exports, memory, globals, tables, and data
segments. `Expr` and Core emit function bodies or module artifacts without
moving module structure into their semantic IRs.

## Change policy

- Every feature states which route accepts it.
- Shared semantic rules are checked before route lowering.
- A route rejection is a diagnostic, not a silent fallback to another route.
- Generated names and artifact ordering are deterministic.
- Documentation must not describe an aspirational stage as an implemented
  pipeline edge.
