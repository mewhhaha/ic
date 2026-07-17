# Experimental gpufuck compiler

This directory translates Duck's elaborated semantic Core into the functional
surface from the sibling `../gpufuck` repository, runs gpufuck's WebGPU semantic
compiler, and emits runnable WebAssembly.

The adapter explicitly selects gpufuck's strict-eager evaluation profile to
match Duck's source semantics.

The Core adapter supports Duck's i32, i64, and f32 surface; closures and
recursion; structs, arrays, unions, and runtime indexing; range, collection,
break, continue, and loop-expression control flow; local handlers; and the
Text/Bytes operations used by the examples. Duck Bool remains its source ABI i32
and is converted to gpufuck Bool only at control-flow conditions.

Duck's frontend retains parsing, module specialization, type-level evaluation,
ownership and linearity validation, effect analysis, and source diagnostics.
Borrow, freeze, scratch, and owned aggregates lower to gpufuck's immutable
values, while effect and Init declarations lower to typed gpufuck host
capabilities with their borrow, transfer, and frozen-shareable contracts. The
`run`, `run_file`, and `run_async` methods install the adapter's Text/Bytes
runtime automatically and accept the remaining Init capabilities from the
caller. File compilation continues to use Duck's source-module specialization;
batch compilation uses gpufuck's ordered GPU lanes.

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

On the July 2026 development checkout after switching the adapter to semantic
Core, gpufuck was slower for the ten-file suite (28.72 ms versus 4.49 ms) and at
every generated size. It compiled 1,000 bindings in 121.80 ms versus 83.62 ms,
and 2,000 bindings in 429.17 ms versus 250.19 ms. The broader lowering produces
substantially more functional Core than the earlier scalar adapter, so the old
large-input crossover no longer holds. These figures are local measurements, not
stable performance guarantees.

The runtime benchmark uses the modular program in `workload/main.duck`. Four
parameterized modules specialize constants used by three recursive 512-round
kernels. The current Core backend cannot emit the linked modular form yet, so
`workload/current.duck` is the checked-in flattened equivalent used for the
runtime baseline. The benchmark verifies that both return the same value before
measuring fresh first execution, instantiation plus first execution, and warm
calls on one instance. Gpufuck's compact scalar entry forces the pure result on
the first call and retains it for later calls, so the warm measurement is lookup
latency rather than repeated kernel execution.

In the same checkout, gpufuck's fresh first execution was slower (7.57 us versus
970 ns), as was instantiation plus first execution (17.77 us versus 2.68 us).
After the pure result had been forced, repeated calls on the same instance took
5.64 ns versus 1.01 us. That warm result is retained-value lookup, not a 179x
speedup of the recursive calculation itself. The experiment currently shows no
compilation gain and trades startup latency for extremely cheap repeated access
to a pure result.

The compatibility scan compiles all 75 non-failure, standalone programs under
`examples/` through gpufuck. The focused tests also execute structured values,
ownership forms, local handlers, loops, compile-time-derived functions, and
aggregate effect capabilities.

This is not yet a drop-in replacement for Duck's `duck-js-1` backend. Managed
callable exports are not mapped to gpufuck's persistent callable exports;
separately prepared Duck modules are specialized by Duck before gpufuck rather
than represented as gpufuck module artifacts; and Duck has no source annotation
for gpufuck's suspending operations, so `run_async` can replay asynchronous host
bindings but cannot distinguish suspension in the Duck effect contract. Duck's
v128 and raw linear-memory primitives remain outside gpufuck Functional Core.
Duck currently has no f64 source type, so gpufuck's f64 support is not exposed
by this adapter.
