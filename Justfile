run:
  deno run --allow-read main.ts

duck *args:
  deno run --allow-read --allow-write duck.ts {{args}}

fmt:
  deno fmt

fmt-check:
  deno fmt --check

lint:
  deno lint --ignore=.claude

typecheck:
  deno check main.ts duck.ts
  deno check scripts/*.ts
  rg --files src case-studies examples -g '*.test.ts' -0 | xargs -0 deno check

architecture-report:
  deno run --allow-read scripts/dependency-boundaries.ts

architecture-check:
  deno run --allow-read scripts/dependency-boundaries.ts --check >/dev/null

architecture-baseline:
  deno run --allow-read --allow-write scripts/dependency-boundaries.ts --write-baseline

source-test:
  deno test --allow-read --allow-write --allow-run src scripts

case-studies:
  deno test --allow-read --allow-write --allow-run case-studies

case-study study:
  deno test --allow-read --allow-write --allow-run case-studies/{{study}}

test: source-test examples case-studies

examples:
  deno test --allow-read --allow-write --allow-run examples/examples.test.ts

grammar-generate:
  deno run --allow-read --allow-write --allow-run=tree-sitter scripts/generate-grammar.ts

grammar-check:
  deno run --allow-read --allow-write --allow-run=tree-sitter scripts/generate-grammar.ts --check
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter test
  cd tree-sitter-duck && rg --files ../examples -g '*.duck' -0 | xargs -0 env XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter parse --quiet --stat
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter parse --quiet --stat ../src/frontend/prelude*.duck
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/highlights.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/indents.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/textobjects.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/locals.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/tags.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null
  cd tree-sitter-duck && XDG_CACHE_HOME=/tmp/ducklang-tree-sitter-cache tree-sitter query queries/rainbows.scm ../examples/effects/01_inferred_io.duck ../examples/handlers/01_local_counter.duck >/dev/null

quality: fmt-check lint typecheck architecture-check

helix-grammar: grammar-check

helix-register: helix-grammar
  scripts/setup_helix.sh

install: helix-register

check: quality grammar-check source-test examples case-studies
