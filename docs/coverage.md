# Compiler Coverage

Ducklang's executable coverage is the gpufuck pipeline:

```txt
Source -> frontend -> semantic Core -> gpufuck Functional Core -> Wasm
```

The authoritative inventory is executable rather than duplicated here:

- `examples/manifest.ts` lists successful programs, expected compile failures,
  runtime traps, dependencies, and source tests.
- `examples/examples.test.ts` compiles or runs every manifest entry through
  `DuckCompiler`.
- `examples/corpus_coverage.ts` maps every Tree-sitter corpus feature to a
  runnable example.
- `experiments/gpufuck/compiler.test.ts` covers the compiler boundary, batching,
  caching, host interfaces, comptime execution, and Wasm execution.
- `case-studies/` exercises larger programs through the same compiler API.

`just examples` runs the complete source catalog. `just check` additionally runs
formatting, lint, type checks, dependency boundaries, grammar generation, the
language server, case studies, and performance budgets.

A feature is supported only when it reaches the gpufuck target. Parser-only or
analyzer-only acceptance is tooling support, not compiler support. Reserved
features are documented in [roadmap.md](roadmap.md).
