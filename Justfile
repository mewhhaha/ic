run:
  deno run --allow-read --allow-write main.ts

wasm wat_file="build/out.wat" wasm_file="build/out.wasm":
  mkdir -p build
  wat2wasm {{wat_file}} -o {{wasm_file}}

fmt:
  deno fmt *.ts src

fmt-check:
  deno fmt --check *.ts src

lint:
  deno lint

test:
  deno test --no-check --allow-read --allow-write --allow-run

examples:
  deno test --no-check --allow-read --allow-write --allow-run examples/examples.test.ts

helix-grammar:
  cd tree-sitter-ix && tree-sitter generate
  cd tree-sitter-ix && tree-sitter test
  cd tree-sitter-ix && tree-sitter parse --quiet --stat ../examples/effects/*.ix ../examples/effects/*/*.ix
  cd tree-sitter-ix && tree-sitter query queries/highlights.scm ../examples/effects/01_inferred_io.ix >/dev/null
  cd tree-sitter-ix && tree-sitter query queries/indents.scm ../examples/effects/01_inferred_io.ix >/dev/null
  cd tree-sitter-ix && tree-sitter query queries/textobjects.scm ../examples/effects/01_inferred_io.ix >/dev/null
  cd tree-sitter-ix && tree-sitter query queries/locals.scm ../examples/effects/01_inferred_io.ix >/dev/null
  cd tree-sitter-ix && tree-sitter query queries/tags.scm ../examples/effects/01_inferred_io.ix >/dev/null
  cd tree-sitter-ix && tree-sitter query queries/rainbows.scm ../examples/effects/01_inferred_io.ix >/dev/null

helix-register: helix-grammar
  scripts/setup_helix.sh

check: fmt-check lint test
