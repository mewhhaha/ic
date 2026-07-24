# Contributing

Ducklang keeps compiler stages explicit and each change reviewable as one idea.
Read `AGENTS.md` before changing code; it is the repository's detailed style,
testing, and architecture policy.

## Prerequisites

- Deno 2.9.2
- Tree-sitter CLI 0.26.3
- `just`
- a WebGPU adapter
- the sibling `../gpufuck` checkout

No repository dependency install is required. The Deno lockfile pins the JSR
dependencies.

## Before a change

Read the implementation you will edit and a neighboring module that performs a
similar operation. Confirm the established naming, error handling, dependency
direction, and existing test coverage before writing code.

Keep the compiler pipeline accurate:

```txt
Source -> frontend -> semantic Core -> gpufuck Functional Core -> Wasm
```

Frontend stages must not import Core. Source syntax enters Core through
`core/from_source/`, and concrete compilation belongs in the gpufuck adapter.

## Verification

Run the focused test beside the changed implementation, then run the complete
gate:

```sh
just check
```

That command checks formatting, lint, all-file types, dependency boundaries,
generated Tree-sitter files and queries, source/example tests, every case study,
and compiler/LSP performance budgets.

When changing the grammar, regenerate its checked-in artifacts with the pinned
Tree-sitter CLI and include `grammar.json`, `node-types.json`, and `parser.c` in
the same change. When changing diagnostics or the public API, update their
focused tests and the relevant reference documentation.

Report exactly which checks passed and anything that could not be verified.
