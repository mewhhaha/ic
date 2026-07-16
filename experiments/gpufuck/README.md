# Experimental gpufuck compiler

This directory translates Duck's pure scalar/functional subset into the
functional surface from the sibling `../gpufuck` repository, runs gpufuck's
WebGPU semantic compiler, and emits runnable WebAssembly.

The experiment currently supports i32 and Bool literals, immutable bindings,
shadowing assignments, lambdas, recursive lambdas, calls, blocks, conditionals,
and gpufuck's ten i32 binary operators. It treats pure `const` bindings and
`comptime` expressions as ordinary lazy functional expressions. Module headers,
declarations, effects, ownership forms, aggregates, memory, i64/f32 values, and
other primitives fail explicitly.

Compile a supported Duck file:

```sh
deno task compiler:gpufuck examples/functions/04_recursive_fibonacci.duck
```

Run the correctness suite and the before/after benchmark:

```sh
deno task compiler:gpufuck:test
deno task compiler:gpufuck:bench
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
