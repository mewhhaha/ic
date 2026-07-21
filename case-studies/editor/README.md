# Terminal editor

This case study keeps editor state, editing, selection movement, rendering, and
terminal policy in Duck. Deno is a thin synchronous boundary for terminal and
file I/O: it enters the alternate screen, enables raw input, forwards terminal
effects to Wasm, and restores the terminal in `finally` blocks.

The document is a linked piece sequence. Inserts and deletes split and join
pieces instead of shifting one contiguous buffer. Selections follow the Helix
model: every normal-mode cursor is an inclusive selection, `v` toggles an
anchored extension, and edits operate on the selected range.

Run it with:

```sh
deno run -A case-studies/editor/editor.ts path/to/file
```

Normal mode supports `h`/`l` or left/right arrows, `v`, `d`, `c`, `i`, `a`, `w`,
and `q`. Insert mode accepts terminal bytes, backspace, Enter, Tab, and Escape.

This proof of concept moves by UTF-8 code points. It does not yet segment
extended grapheme clusters or calculate terminal display width, so combining
sequences and wide glyphs are not full cursor cells yet. The piece sequence is
also linked rather than balanced; a production editor would add a balanced index
without changing the host boundary.
