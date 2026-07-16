# Grep Case Study

This directory contains a small literal grep command-line program in Duck. It
accepts exactly `pattern path`, reads the file in 64 KiB chunks, and writes each
matching line (including its newline when present) as raw bytes. Exit status is
`0` when at least one line matches, `1` when none match, and `2` for an invalid
invocation or I/O failure. An empty pattern matches every existing line.

The matcher keeps only the unfinished tail between reads. Completed lines are
dropped from the rolling `Bytes` buffer, so retained input is bounded by one
chunk plus the longest unfinished line rather than the complete file. `@append`
and `@slice` currently allocate and copy, and matching is a naive byte search;
this is a correctness slice, not a performance claim.

The outer read loop is an unbounded, value-producing `loop`: each terminal path
uses `break` to return the final exit status. The rolling buffer, its next
unconsumed byte, EOF state, and accumulated status are explicit locals whose
types are inferred from their values and uses. The `scan` parameter, result, and
effect types are inferred as well. Guard clauses keep the read, match, and write
transitions on one shallow path, and the same path handles terminated and
unterminated final lines.

The top-level file scope brackets the scan: it closes the reader after every
structured scan result and never closes when opening failed. Regexes, directory
traversal, ignore files, diagnostics, and richer ripgrep options are not
included. The program returns status `2` for expected I/O errors but cannot
format their `Text` payloads for the byte-oriented `Stderr` capability yet.

## Run

Run the literal matcher:

```sh
deno run --allow-read --allow-run=wat2wasm \
  case-studies/grep/grep.ts needle case-studies/grep/fixtures/input.txt
```

Run its contract tests:

```sh
deno test --no-check --allow-read --allow-run \
  case-studies/grep/grep.test.ts
```

## Boundary

`host.duck` declares six capabilities:

- `Process` provides indexed raw argv and the current directory.
- `Walk` provides an unfiltered depth-first cursor with explicit enter/leave
  events and pruning. Duck will own hidden-file, glob, and ignore policy.
- `FileReader` owns one synchronous stream per runner.
- `Stdin`, `Stdout`, and `Stderr` exchange byte chunks and terminal facts.

Expected I/O failures are typed union values. ABI violations and invalid host
state are exceptions. Paths are UTF-8 `Text` in this Deno-first slice. File and
stream payloads are owned `Bytes`; output calls receive bounded borrows.

The live and mock implementations are selected by the TypeScript runner. The
Duck module receives only the capability objects supplied through `Init`.

The current single-file program exercises `Process`, `FileReader`, and `Stdout`.
`Walk`, `Stdin`, and `Stderr` remain part of the case study's minimal
ripgrep-shaped host boundary and have independently tested live/mock handlers.
