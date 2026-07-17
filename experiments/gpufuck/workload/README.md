# Modular runtime workload

`main.duck` imports four parameterized Duck modules. The mixer, sequence, and
folder modules derive constants for three recursive numerical kernels, while the
pipeline module sets their seed and iteration count. Each kernel runs for 512
rounds and relies on i32 wrapping behavior.

The current Core backend cannot emit runtime functions exported through module
records or the linked modular form used here. `current.duck` is therefore the
same specialized runtime program with the four module results expanded. The
runtime benchmark executes both artifacts and requires the shared result
`381455585` before collecting timings.

Run the modular program through gpufuck:

```sh
deno task compiler:gpufuck experiments/gpufuck/workload/main.duck
```

Compare its generated Wasm with the current compiler's flattened equivalent:

```sh
deno task compiler:gpufuck:runtime
```
