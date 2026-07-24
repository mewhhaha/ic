# Effect examples

These examples cover opaque host effects, inferred and annotated operation rows,
effectful `<-` binding, and file-module capability wiring.

- `01_inferred_io.duck` infers `Io.read` and `Io.print`.
- `02_annotated_effect_row.duck` checks a declared `-> <row>` upper bound.
- `03_cli_stdin_stdout.duck` declares separate `Stdin` and `Stdout` effects.
- `multi_file/` separates a host interface, an effect-using module, and an entry
  module.
- `../handlers/` contains effects handled entirely in Duck source.

Host interfaces are declarations, not runtime imports. Pass their concrete
capabilities as `DuckInit` when calling `DuckCompiler.run_file` or
`DuckProgram.run`. The editor case study contains a complete Deno host adapter
for the same model.

Run the executable effect and handler coverage with:

```sh
just examples
```
