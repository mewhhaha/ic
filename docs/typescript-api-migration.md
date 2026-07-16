# TypeScript API and Diagnostic Migration

`src/frontend.ts` is the supported product entry point. Its surface is now
limited to the source compiler, root input and result types, diagnostics, the
managed JavaScript host, and `duck-js-1` manifest contracts.

Supported imports include:

```ts
import {
  diagnostic_codes,
  DuckHost,
  DuckRunner,
  Source,
} from "./src/frontend.ts";
import type {
  AbiManifest,
  DuckValue,
  SourceAnalysis,
  SourceDiagnostic,
} from "./src/frontend.ts";
```

Individual AST nodes, source facts, binding-index state, compile-time values,
canonical type-engine state, and Core types are no longer product exports.
Repository tooling imports those contracts from their owning modules under
`src/frontend/` or `src/core/`; those paths are internal and carry no package
compatibility promise. `SourceAnalysis.facts` was removed for the same reason.

Diagnostics use the typed `diagnostic_registry`. Each registered identity has a
category and default severity, and `diagnostic_codes` provides constants for
consumers such as code actions. The category ranges are:

```txt
DUCK1xxx  syntax
DUCK20xx  names and liveness
DUCK21xx  compile-time restrictions
DUCK22xx  affine and linear use
DUCK23xx  types and effects
DUCK24xx  ownership and proof
DUCK25xx  modules and imports
DUCK29xx  backend-route support
```

`Source.analyze` returns the canonical diagnostic sequence. It applies registry
severity, fills document URIs, removes duplicate root diagnostics, and sorts
primary diagnostics by URI, source span, code, and message. CLI and LSP adapters
preserve that sequence and identity. Existing command names, flags, Duck
behavior, Wasm behavior, and the `duck-js-1` ABI are unchanged.
