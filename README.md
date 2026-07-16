# Ducklang

Ducklang is an Interaction Calculus inspired compiler and source-language
toolchain written in Deno. Source programs use one shared frontend and then
select an explicit backend route:

```txt
                         -> IC -> Expr --------->
Source -> Frontend -----|                         Mod -> WAT -> Wasm
                         -> structured Core ---->
                                               |
                                               -> managed JavaScript ABI
```

The language is a compact value-oriented playground for compile-time
specialization, affine lowering, explicit sharing/erasure, ownership checks, and
direct WebAssembly output.

## Prerequisites

Development uses Deno 2.9.2, Tree-sitter CLI 0.26.3, and `just`. WABT is a
required external tool: its `wat2wasm` executable is used by Wasm integration
tests and the build/run commands. On Debian and Ubuntu, install it with
`apt-get install wabt`.

## Quick Start

Run the demo compiler pipeline:

```sh
just run
```

This writes `build/out.wat` from the example program in `main.ts`.

Compile or run a source file directly:

```sh
just duck build examples/basics/01_arithmetic_and_shadowing.duck
just duck build examples/basics/01_arithmetic_and_shadowing.duck --emit all
just duck run examples/basics/01_arithmetic_and_shadowing.duck
```

Compile the generated WAT to Wasm:

```sh
just wasm
```

Run the test suite:

```sh
just test
```

Compile and execute the complete source example suite:

```sh
just examples
```

Install the repository's Tree-sitter grammar and Helix queries for `.duck`
files:

```sh
just install
```

This adds a managed `duck` block to `~/.config/helix/languages.toml`, installs
highlight, indentation, locals, textobject, symbol, and rainbow-bracket queries,
and builds the grammar. `just helix-register` remains available as the explicit
Helix-specific alias. Run `just helix-grammar` to validate the grammar without
changing Helix configuration.

## Tooling CLI

`duck.ts` is the language CLI. It hosts the formatter and the language server,
which live decoupled from the compiler pipeline in `src/fmt/` and `src/lsp/`:

```sh
just duck fmt examples        # format .duck files in place
just duck fmt --check src     # report unformatted files without writing
just duck fmt --stdin         # format stdin to stdout
just duck check examples      # report syntax and semantic diagnostics
just duck build main.duck     # write build/main.wasm through Core
just duck build main.duck --route ic --emit wat
just duck build main.duck --managed --emit all
just duck run main.duck
just duck lsp                 # run the language server over stdio
```

`build` accepts `--route ic|core|managed`, `--emit wat|wasm|all`,
`--out <directory>`, and `--host-interface <file>`. Managed builds always write
`<name>.abi.json` beside their WAT or Wasm output. `run` supports import-free
IC/Core programs and managed programs that require no host capabilities;
applications with effects should instantiate the managed output through
`DuckHost`.

The formatter is deliberately biased: two-space indentation, fixed spacing,
collapsed blank runs, canonical string escapes, and no configuration. It
re-emits the comment-preserving token stream without reflowing lines, and it
refuses to rewrite files that do not parse. The language server provides parse
diagnostics, document formatting, and document symbols.

`just install` registers the language server and enables format-on-save for
`.duck` files in Helix alongside the Tree-sitter grammar.

## Example

```duck
const make_adder = n => {
  x => x + n
}

const add_three = comptime make_adder(3)

let value = add_three(29)
value = value + 1
value
```

This is the header-free fragment compiled by the demo in `main.ts`: it parses
source, lowers it through IC and Expr, wraps it in a Wasm module exporting
`main` with the value `33`, and writes WAT. Loaded `.duck` files use the module
header and export-record form shown in the next section.

## Source Language

Loaded `.duck` files are modules. A module declares its inputs in the header and
returns an ordered export shape at the end of the file:

```duck
module () where

let x = 40
return { .answer = x + 2 }
```

`Source.parse` also accepts header-free fragments for tests and interactive use.

Runtime values are immutable. Assignment syntax is modeled as shadowing:

```duck
let x = 40
x = x + 2     // same-type shadowing
x := "done"  // type-changing shadowing
```

Compile-time bindings use `const`, and compile-time execution uses `comptime`:

```duck
const factor = 2
const add_factor = comptime (n => x => x + n)(factor)
```

Const evaluation supports memoized structural recursion, type descriptors, and
ordinary fixed-array construction. Fixed-array lengths may use arithmetic over
const integers, such as `const width = 2` followed by `[Int; width + 1]`. The
derived equality example combines records, arrays, and unions:
[`examples/compile_time/13_derived_nested_equality.duck`](examples/compile_time/13_derived_nested_equality.duck).

Closures use arrow syntax:

```duck
let add = (x, y) => x + y
let inc = x => x + 1
```

Recursive functions use `let rec`:

```duck
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(6)
```

Duck supports explicit Rank-N polymorphism with `forall`. Quantifiers may appear
at any type position, and unannotated const functions are generalized:

```duck
const apply_identity: (forall value. value -> value) -> I32 =
  (const identity) => identity(42)

const identity = value => value
comptime apply_identity(identity)
```

## Syntax Snapshot

Common statement forms:

```duck
let name = expr
let name: Type = expr
let rec name = params => body
let !name = expr

const name = expr
const name: Type = expr

name = expr
name := expr
name[index] = expr

if cond { statements }
if let .case(value) = target { statements }

for i in start..end { statements }
for i in start..end by step { statements }
for item in collection { statements }
for i, item in collection { statements }

return expr
break
continue
```

File-module forms:

```duck
module () where
module (!init: Init) where
module (const release: Bool) where

const logger = import "./logger.duck"
const { .write = write } = logger { .io = !init.io }

return { .write = write }
```

Common expression forms:

```duck
42
42i32
42i64
"text"

x + y
x - y
x * y
x / y
x % y
x == y
x != y
x < y
x <= y
x > y
x >= y
x && y
x || y

x => x + 1
(x: Int, y: Int) => x + y
func(arg1, arg2)

if cond { a } else { b }
if let .ok(value) = result { value } else { 0 }

object.field
object[index]
object with { .field = value }
```

Built-in type names:

```duck
Int
I32
U32
I64
Text
Unit
Type
```

## Types, Structs, And Unions

Types are compile-time values.

```duck
const { struct } = comptime import "duck:prelude" ()

const user_type = struct {
  .name = Text,
  .age = Int
}

let user: user_type = [.name = "Ada", .age = 36]

user.age
```

Unions support typed constructors and `if let` matching:

```duck
type Option t = | .some = t | .none
type IntOption = Option Int
let value = IntOption.some 41

if let .some(x) = value {
  x + 1
} else {
  0
}
```

## Text

Text literals are UTF-8 strings. Visible text operations can fold during
frontend lowering, while runtime `Text` values are represented as `i32` pointers
to length-prefixed UTF-8 data in generated WAT.

```duck
let greeting = "hello" + " " + "Ada"
@len(greeting)
```

Text builtins include:

```duck
@len(value)
@get(value, index)
@slice(value, start, end)
@append(left, right)
```

## Host Effects And Modules

Host services are nominal opaque effects declared in a Ducklang host interface.
Their methods are the operations tracked by the effect system:

```duck
declare effect Io {
  read: () => Text
  print: (&Text) => Unit
}

declare Init {
  io: Io
}
```

Unannotated functions infer their minimal operation row. Function types use
`-> <row>` for an explicit upper bound; a plain `->` is pure:

```duck
let read_name = () => {
  name <- Io.read()
  name
}

let greet: () -> <Io.read | Io.print> Text = () => {
  name <- read_name()
  _ <- Io.print(&name)
  name
}
```

`<-` executes an effectful computation and binds its result; `_ <-` discards a
`Unit` result. Ordinary `let value = ...` remains pure. Effect operations are
always qualified by their declared effect (for example, `Io.read()`). The
compiler retains the linear context-renewal proof internally, so application
code does not thread an effect token explicitly.

Effect annotations are operation sets. A family such as `Io` expands to all of
its operations. `|` is union, `&` is intersection, and `\` is difference. Rows
propagate through calls, and a row annotation is an upper bound on the inferred
minimal row. Type constructors compose by whitespace application, arrows
associate right, and lowercase row variables propagate callback effects:

```duck
(List a, a -> <e> b) -> <e> List b
```

Imported files are loaded first and then instantiated with an explicitly
narrowed context record; an import does not grant authority by itself.

The entry module receives the sole root authority from JavaScript:

```duck
module (!init: Init) where

const console = import "./console.duck"
const { .greet = greet } = console { .io = !init.io }
result <- greet("Ada")

return { .result = result }
```

`declare effect` means that the operations are implemented by the host. Plain
`effect` defines operations handled entirely inside Duck:

```duck
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let counter = {
  let count = 0
  Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => { value, count },
  }
}

let result = try run() with counter
```

Effect implementation values are affine. Handlers are deep, omitted clauses
forward outward, and the matched handler is inactive while a clause runs.
Resumptions may abort, resume once, or be duplicated with checked
`let (!left, !right) = dup !resume` when all captures are copy/share safe. Plain
effects and resumptions remain internal to one Duck run and never appear in the
managed JavaScript manifest.

## Ownership And Host Effects

Linear bindings and parameters are marked with `!`.

```duck
let !buffer = make_buffer()
let use_once = (!value) => value
```

Ownership-oriented expressions:

```duck
&value
freeze value
scratch { statements }
```

Host boundaries are declared as effects and supplied through `Init`. Operation
parameters carry the same scalar and ownership contracts used by Core:

```duck
declare effect Console {
  log: (I32) => I32
  print: (&Text) => I32
  make_text: (I32) => Text
}

declare Init { console: Console }
```

The compiler turns these operations into typed Wasm imports internally. There is
no user-written raw-import statement; this keeps host authority visible in
effect rows and makes the complete handler set swappable through `DuckRunner`.

## Compiler Entry Points

The source frontend is exposed through `Source`:

```ts
Source.parse(text); // Source AST
Source.compile(text); // Source -> IC
Source.ic_wat(text); // Source -> IC route -> WAT
Source.core(text); // Source -> structured Core
Source.mod(text, "main"); // Source -> Core -> Mod
Source.wat(text, "main"); // Source -> Core -> WAT
Source.artifact(text, "main"); // managed module, WAT, and ABI manifest
Source.artifact_file("main.duck", {
  host_interface: "host.duck",
});
```

Use the IC route for small scalar examples and open terms like `input + 1`. Use
the Core route for larger programs with structured statements, loops, runtime
text, host effects, closures, and aggregate behavior.

The Core route does not currently lower through IC. This is an intentional
architectural boundary, not an undocumented intermediate stage. See
[architecture.md](docs/architecture.md) for the route contracts and
[roadmap.md](docs/roadmap.md) for the larger reserved features.

### Managed JavaScript host ABI

`Source.artifact` emits the `duck-js-1` manifest and a module with exported
`memory`, `__duck_abi_alloc`, `__duck_abi_free`, and `__duck_abi_main`.
Instantiate that artifact through `DuckHost` to receive JavaScript values
instead of raw Wasm pointers:

```ts
import { DuckHost, DuckRunner, Source } from "./src/frontend.ts";

const artifact = Source.artifact(`
module (!init: Init) where

declare effect Measure {
  text: (&Text) => I32
}

declare Init {
  measure: Measure
}

let run: () -> <Measure> I32 = () => {
  length <- Measure.text(&"hello")
  length
}

result <- run()
return { .result = result }
`);
const wasm = compileWat(artifact.wat);
const program = await DuckHost.instantiate(wasm, artifact.abi);

const runner = DuckRunner({
  measure: {
    text(value) {
      return value.length;
    },
  },
});
const result = runner.run(program);
program.dispose();
```

For a separate host interface, compile the entry file with
`Source.artifact_file(entry, { host_interface })`. The interface contributes
only declarations; passing it does not instantiate or grant a resource. The JS
objects captured by `DuckRunner(init)` are the actual authority. Constructing a
different runner swaps the complete handler set without changing the compiled
program.

The adapter marshals entry context and export products while host effects remain
opaque registry resources inside Wasm. It validates resource handles, required
methods, UTF-8, bounds, union tags, handler availability, and ABI versions.
Allocations grow Wasm memory when needed. `Source.wat` retains the lower-level
scalar/pointer output for embedders that do not need the managed adapter.

## Repository Layout

```txt
main.ts               demo pipeline that writes build/out.wat
src/frontend.ts       source frontend public exports
src/ic.ts             Interaction Calculus layer
src/expr.ts           expression layer
src/mod.ts            Wasm module layer
src/core.ts           structured Core path
src/wasm_*.test.ts    end-to-end Wasm integration tests by feature area
docs/language.md      source-language specification
docs/coverage.md      per-route implementation coverage
docs/architecture.md  compiler route contracts and stage boundaries
docs/roadmap.md       prioritized reserved-feature work
examples/             runnable .duck source programs and expected failures
tree-sitter-duck/      Tree-sitter grammar and Helix queries for .duck files
```

The supported TypeScript exports and diagnostic categories are documented in
[TypeScript API and Diagnostic Migration](docs/typescript-api-migration.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the repository workflow and complete
verification gate. Ducklang is available under the [MIT License](LICENSE).

## Development

```sh
just fmt
just fmt-check
just lint
just typecheck
just grammar-check
just test
just check
deno task compiler:perf
```

`just check` is the complete local gate: formatting, lint, type-checking,
Tree-sitter generation/corpus/query parity, and the runtime test suite. The Wasm
integration tests require `wat2wasm`; grammar checks require `tree-sitter`
0.26.3. CI also enforces latency, heap, and generated-WAT-size budgets for the
LSP and the complete successful example manifest.

Style notes that matter in this repository:

- Keep compiler stages small and explicit.
- Do not silently default missing compiler information.
- Prefer direct invariant checks with `expect(value, message)`.
- Keep semantic operations separate from concrete Wasm instructions.
- Keep tests close to the implementation they cover.
