# Source Examples

Every executable Ducklang example uses the sole gpufuck compiler pipeline.

Run the complete catalog:

```sh
just examples
```

Run one program:

```sh
just duck run examples/basics/01_arithmetic_and_shadowing.duck
```

Compile one program to binary Wasm:

```sh
just duck build examples/data/01_struct_fields.duck
```

Run source-level `@[test]` declarations:

```sh
just duck test examples/testing/01_inline_tests.duck
```

The directories group examples by language area:

- `basics/` covers values, functions, calls, and control flow.
- `compile_time/` covers specialization, types, attributes, and derivation.
- `functions/` covers closures, recursion, and early control transfer.
- `data/` covers structs, unions, patterns, text, and bytes.
- `loops/` covers ranges and collection iteration.
- `iterators/` covers source-defined iterator combinators.
- `ownership_modules/` covers affine values, modules, and host contracts.
- `effects/` and `handlers/` cover inferred effects and source handlers.
- `showcases/` combines multiple features into larger programs.
- `failures/compile/` contains programs the compiler must reject.
- `failures/traps/` contains valid programs that must trap at runtime.

`manifest.ts` is the authoritative executable inventory. Its expected results
and host capability values are checked by `examples.test.ts`.
`corpus_coverage.ts` maps every Tree-sitter corpus feature to runnable examples,
so adding syntax requires adding or naming an executable example.
