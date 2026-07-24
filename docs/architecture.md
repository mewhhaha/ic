# Compiler Architecture

Ducklang has one compilation pipeline:

```txt
Source -> frontend -> semantic Core -> gpufuck Functional Core -> Wasm
```

Duck owns source-language behavior. Gpufuck owns compilation of the lowered
functional module and binary Wasm emission. There is no Duck-native Wasm,
Interaction Calculus, WAT, or separate host-ABI route.

## Frontend

`src/frontend/` owns parsing, imports, source metadata, diagnostics, binding and
type facts, linearity, effects, compile-time evaluation, specialization, and
tooling analysis. `Source` is the tooling facade for parsing, analysis,
formatting, effects, and source loading. It does not compile programs.

The frontend remains independent of semantic Core. This lets `duck check`, the
formatter, and the language server operate without initializing WebGPU or
gpufuck.

## Semantic Core

`src/core/ast.ts` defines the target-independent semantic representation.
`src/core/from_source/` constructs it from elaborated source and is the only
Core layer allowed to depend on frontend syntax. The other retained Core modules
provide demand, capture, ownership, storage, substitution, and source origin
facts needed by lowering.

Semantic Core describes behavior, not concrete Wasm instructions or module
layout.

## Gpufuck adapter

`experiments/gpufuck/core_lowering.ts` is the single compiler boundary. It loads
and elaborates source, builds semantic Core, and lowers Core to gpufuck's typed
Functional Core. `experiments/gpufuck/compiler.ts` owns compiler caching, WebGPU
setup, comptime execution, host capability binding, and gpufuck calls.

`src/compiler.ts` is the supported TypeScript compiler API. `DuckCompiler`
compiles binary Wasm, prepares programs, runs programs, and executes source
tests. Host interfaces contribute source declarations; `DuckInit` values grant
runtime capabilities.

## Dependency policy

- Frontend modules do not import semantic Core.
- Core imports frontend syntax only through `core/from_source/`.
- Semantic operations do not contain concrete Wasm emission.
- Compilation and execution enter through `DuckCompiler`.
- A target rejection is reported as an error; there is no fallback route.

The dependency check rejects violations and multi-file cycles.
