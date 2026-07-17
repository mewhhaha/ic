# Experimental gpufuck compiler

This directory translates Duck's elaborated semantic Core into the functional
surface from the sibling `../gpufuck` repository, runs gpufuck's WebGPU semantic
compiler, and emits runnable WebAssembly.

The adapter explicitly selects gpufuck's strict-eager evaluation profile to
match Duck's source semantics.

The Core adapter supports Duck's i32, i64, f32, and f64 surface; closures and
recursion; structs, arrays, unions, and runtime indexing; range, collection,
break, continue, and loop-expression control flow; local handlers; and the
Text/Bytes operations used by the examples. F32x4 lowers to a portable four-lane
f32 aggregate because gpufuck's Functional Core intentionally has no
target-specific SIMD type. Duck Bool remains its source ABI i32 and is converted
to gpufuck Bool only at control-flow conditions.

Duck's frontend retains parsing, module specialization, type-level evaluation,
ownership and linearity validation, effect analysis, and source diagnostics.
Borrow, freeze, scratch, and owned aggregates lower to gpufuck's immutable
values, while effect and Init declarations lower to typed gpufuck host
capabilities with their borrow, transfer, and frozen-shareable contracts. The
`run`, `run_file`, and `run_async` methods install the adapter's Text/Bytes
runtime automatically and accept the remaining Init capabilities from the
caller. Operations declared with `suspending` require `run_async`; the
synchronous runner rejects them before invoking the host. Managed source
callables become gpufuck persistent WebAssembly exports, and the lowered program
is linked from a typed gpufuck module artifact. File compilation continues to
use Duck's source-module specialization; batch compilation uses gpufuck's
ordered GPU lanes.

`evaluate_comptime` and `evaluate_comptime_file` send a pure Duck program's
`main` export through gpufuck's required compile-time executor. They return its
structured constant result or its compile, execution, and comptime diagnostics;
callers can set compiler fuel, evaluator fuel, heap, stack, and output limits
through gpufuck's comptime options. Duck still performs its source-level type
and module elaboration before the typed artifact reaches this boundary.

Compile a supported Duck file:

```sh
deno task compiler:gpufuck examples/functions/04_recursive_fibonacci.duck
```

Run the correctness suite and the before/after benchmark:

```sh
deno task compiler:gpufuck:test
deno task compiler:gpufuck:bench
deno task compiler:gpufuck:runtime
```

The benchmark preloads ten source files, warms both routes, then reports the
median of 20 rounds. The current route measures parse, frontend work, lowering,
and WAT emission. The experimental route reports parse/surface encoding, GPU
semantic compilation, and binary Wasm emission separately. GPU device/compiler
startup is reported but excluded from the warm total. WAT and Wasm byte counts
are included as context, not compared as equivalent encodings.

The same command also reports seven-round medians for generated straight-line
programs with 100, 500, 1,000, and 2,000 bindings. This makes the fixed GPU cost
and any larger-module crossover visible instead of extrapolating from tiny
examples.

On the July 2026 development checkout after filling the semantic adapter gaps,
gpufuck was slower for the ten-file suite (29.20 ms versus 4.51 ms) and at every
generated size. It compiled 1,000 bindings in 125.24 ms versus 87.34 ms, and
2,000 bindings in 434.54 ms versus 250.65 ms. The broader lowering produces
substantially more functional Core than the earlier scalar adapter, so the old
large-input crossover no longer holds. These figures are local measurements, not
stable performance guarantees.

The runtime benchmark uses the modular program in `workload/main.duck`. Four
parameterized modules specialize constants used by three recursive 512-round
kernels. The current Core backend cannot emit the linked modular form yet, so
`workload/current.duck` is the checked-in flattened equivalent used for the
runtime baseline. `workload/current_callable.duck` separately exposes the same
kernels as a managed callable. The benchmark verifies every contract before
measuring fresh first execution, instantiation plus first execution, and warm
calls on one instance.

The output separates recomputing entries, recomputing callables, and retained
values. Recomputing measurements execute all three kernels on every call; the
retained-value measurement intentionally evaluates once and measures lookup on
later calls. This prevents retained lookup from being presented as kernel
execution speed. In the July 2026 checkout, the compact modular gpufuck entry
was 234 bytes versus 204 bytes and repeated the workload in 990 ns versus 983
ns. Its fresh execution was 977 ns versus 964 ns. The managed callable
recomputed in 1.03 us after initialization versus 992 ns, while its first call
remained slower because it initializes the general functional runtime. The
explicit retained fixture took 6.26 ns after its first evaluation. These are
local measurements, not stable performance guarantees.

The compatibility test compiles all 73 non-failure, standalone programs in the
current `examples/` manifest through gpufuck. The focused tests also execute
wide numeric values, portable F32x4 operations, structured values, ownership
forms, local handlers, value-producing loops, compile-time-derived functions,
aggregate effect capabilities, suspending effects, and multi-argument managed
callable exports.

The experiment now covers Duck's source-level semantic capabilities, but it is
not a byte-for-byte replacement for the `duck-js-1` backend. Persistent callable
arguments use gpufuck's versioned tagged value ABI, while DuckHost expects
`duck-js-1`; imported Duck source modules are specialized by Duck before the
resulting typed artifact reaches gpufuck; and F32x4 is scalarized instead of
using native Wasm SIMD. Raw linear-memory loads and stores remain Duck backend
instructions rather than portable Functional Core operations. None of those
boundaries prevents the standalone source suite from compiling, but a host that
requires the exact DuckHost ABI still needs the current backend.
