# Terminal editor

This case study keeps editor state, editing, selection movement, rendering, and
terminal policy in Duck. The gpufuck target compiles the program to Wasm, while
Deno is a thin synchronous boundary for terminal and file I/O: it enters the
alternate screen, enables raw input, supplies typed terminal capabilities, and
restores the terminal in `finally` blocks.

The document is a height-balanced piece tree with cached byte and line counts.
Inserts and deletes split and join subtrees instead of shifting one contiguous
buffer, while lookup descends by cached lengths. Materialization walks the
leaves with an explicit stack without exposing the tree traversal to callers.

Selections follow the Helix model: every normal-mode cursor is an inclusive
selection, `v` toggles an anchored extension, and edits operate on the selected
range. The editor stores a nonempty selection collection with one primary
selection and a list of secondary selections. This proof of concept edits the
primary selection; the representation leaves multi-selection commands as a
source-level extension rather than another host concern.

Editing modes and save status are source-defined sum types. Key reduction
returns the next editor together with an ordered list of typed save and quit
commands, so one-shot commands do not become persistent editor state. A
source-defined decoder turns terminal bytes into typed keys and retains
incomplete CSI control sequences across reads while treating a lone Escape at a
read boundary as an immediate key. Rendering maps display bytes lazily and
writes through a bounded output builder, while folds compute cached leaf
metadata.

The case study still exposes two toolchain gaps. A render-local byte-sink
effect would be cleaner than explicit builder threading, but Duck effects cannot
yet run inside runtime `for` and `loop` bodies. Key and command sequences use
monomorphic recursive unions because gpufuck cannot yet instantiate generic
`List` with a union element type.

Run it with:

```sh
deno run -A case-studies/editor/editor.ts path/to/file
```

Normal mode supports `h`/`l` or left/right arrows, `v`, `d`, `c`, `i`, `a`, `w`,
and `q`. Insert mode accepts terminal bytes, backspace, Enter, Tab, and Escape.

This proof of concept moves by UTF-8 code points. It does not yet segment
extended grapheme clusters or calculate terminal display width, so combining
sequences and wide glyphs are not full cursor cells yet. A production editor
would also coalesce small adjacent leaves and apply edit commands to every
selection without changing the host boundary.
