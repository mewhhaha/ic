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

## Language Tour

This tour introduces one idea at a time. Most snippets are header-free programs:
their last expression becomes the exported `main` result. Imported application
modules use the explicit header and export record introduced in step 15.

| Area                                     | Start here                                      |
| ---------------------------------------- | ----------------------------------------------- |
| Values and control flow                  | steps 1–6                                       |
| Data and types                           | steps 7–10                                      |
| Compile-time programming and the prelude | steps 11–13                                     |
| Effects, ownership, and modules          | steps 14–16                                     |
| Compiler routes and embedding            | [Compiler Entry Points](#compiler-entry-points) |

The complete executable catalog is in [examples/README.md](examples/README.md),
and [docs/language.md](docs/language.md) is the detailed language reference.

### 1. A program is a sequence of expressions

The result of the last expression is the program result:

```duck
let answer = 40 + 2
answer
```

Save that as `answer.duck` and run it with:

```sh
just duck run answer.duck
```

The main scalar types are `Bool`, `I32`, `U32`, `I64`, `F32`, `F64`, `Text`,
`Bytes`, and `Unit`. `Int` is the ergonomic source integer type and has the same
runtime representation as `I32`. Literals retain their type:

```duck
let count: I32 = 42i32
let large: I64 = 42i64
let ratio: F32 = 1.5f32
let ready: Bool = true
let letter = 'A'
let greeting: Text = "hello"

count
```

Fixed-width integers are available as `I<N>` and `U<N>` for any positive bit
width. Widths through 64 bits use scalar carriers; wider integers use an affine
multi-limb Core representation.

### 2. `let`, `const`, and shadowing

`let` binds a runtime value. `const` binds a compile-time value. Values are
immutable; assignment syntax creates a new lexical generation:

```duck
let value = 40
value = value + 2  // same type
value := "done"   // a new value with a different type

value
```

Use `=` when the type stays the same and `:=` when it changes. The compiler
rejects accidental type changes through `=`.

### 3. Functions, calls, and function types

Functions use `=>`. A multi-parameter function still receives one product
argument, which keeps application uniform:

```duck
let add: [Int, Int] -> Int = (left: Int, right: Int) => {
  left + right
}

let increment = value => value + 1
increment(add(20, 21))
```

`[A, B]` is the canonical stored tuple type. `(A, B)` is a transient value-pack
type used only at function boundaries. `(A; N)` repeats `A` into an `N`-value
pack at compile time, while `[A; N]` remains one stored fixed array. `A -> B` is
a pure function type, and arrows associate to the right. Functions close over
lexical bindings and may return other functions:

```duck
let make_adder = amount => {
  value => value + amount
}
let add_two = make_adder(2)
add_two(40)
```

Recursive runtime functions use `let rec`:

```duck
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(8)
```

Functions in one `let rec ... and ...` group are mutually visible:

```duck
let rec even = n => if n == 0 { true } else { odd(n - 1) }
and odd = n => if n == 0 { false } else { even(n - 1) }

even(8)
```

### 4. Boolean control flow and explicit casts

Conditions require `Bool`; integers are never implicitly truthy:

```duck
let value = 40

if value < 41 && value != 0 {
  value + 2
} else {
  0
}
```

Use `@as` when an explicit zero-cost representation cast is intended. `Bool`
shares its carrier with `Int`, `I32`, and `U32`, so zero is false and nonzero is
true after an explicit cast:

```duck
let flag: I32 = 2

if @as(flag, Bool) {
  42
} else {
  0
}
```

`@as` does not permit width changes or cross a newtype boundary. The explicit
unsafe numeric intrinsics cover bit reinterpretation, truncation, and extension.

### 5. Blocks, early return, and pattern conditions

Blocks and conditionals are expressions. `return` exits the current function:

```duck
let classify = value => {
  if value < 0 {
    return 0
  }

  if value == 0 { 1 } else { 2 }
}

classify(10) + 40
```

`if let` checks and extracts one union case; step 8 introduces union types.

### 6. Loops and collections

Ranges are half-open. `for` supports a value, an optional index, and an explicit
step:

```duck
let total = 0

for value in 1..5 {
  total = total + value
}

total
```

`break`, `continue`, nested loops, collection iteration, and value-producing
`loop` expressions are supported:

```duck
let answer = loop {
  for value in 0..10 {
    if value == 6 {
      break 42
    }
  }

  break 0
}

answer
```

See [examples/loops](examples/loops) for dynamic bounds, stepped ranges, text
byte iteration, and folds.

### 7. Products, structs, fields, and updates

Brackets create real tuple data that can be bound, nested, and stored.
Parenthesized comma lists are non-storable value packs: they can be passed,
returned, or immediately destructured, but `let pair = (left, right)` is
rejected. This keeps function arity separate from data representation:

```duck
let swap = (left, right) => (right, left)
let (first, second) = swap(20, 22)
let stored = [first, second]
```

Labeled products are created with the source-defined `struct` type function:

```duck
const { struct } = comptime import "duck:prelude" ()

type Point = struct { .x = Int, .y = Int }

let point: Point = [20, 21]
let moved: Point = point :+ { .x = point.x + 1 }

moved.x + moved.y
```

Fields can be read by name or index. `:+` returns an updated product; it does
not mutate the original value. Product patterns can destructure all fields or
select labeled fields.

Fixed arrays use `[Element; Length]`, and their lengths are compile-time natural
expressions:

```duck
const width = 3
let values: [Int; width] = [20, 21, 1]
values[0] + values[1] + values[2]
```

The same length syntax describes homogeneous transient function inputs and
results without introducing stored data:

```duck
const width = 3
let sum: (I32; width) -> I32 = (a, b, c) => a + b + c
sum(20, 21, 1)
```

`(T; 0)` is the empty pack and `(T; 1)` is a one-value pack. Both remain
distinct from grouping `(T)`.

Function inputs are patterns rather than a separate parameter-only grammar. They
may bind one typed value, destructure one structural value, or require an exact
literal or compile-time value:

```duck
let scalar = (value: I32) => value
let field = { value: I32 } => value
let exactly_42 = 42 => ()
const only_i32 = I32 => ()
```

### 8. Sum types, generics, and matching

`type` declares sum types with named constructors. Type application uses
whitespace:

```duck
type Option value =
  | .some = value
  | .none

type IntOption = Option Int
let value: IntOption = IntOption.some(41)

if let .some(found) = value {
  found + 1
} else {
  0
}
```

`match` handles larger sums with explicit arms and coverage checking. Union
payloads may contain products, text, fixed arrays, or other unions.

### 9. Text, bytes, and runtime collections

`Text` is UTF-8. `Bytes` is an immutable byte collection. The runtime prelude
wraps the compiler primitives with ordinary source functions:

```duck
const { append, length, get, slice } =
  comptime import "duck:prelude/runtime" ()

let name = append ["Ada", " Lovelace"]
let first = slice [name, 0, 3]

length(first) + get [name, 1]
```

The functional prelude also defines `<>` for append. UTF-8 conversion is
explicit through `encode_utf8` and `decode_utf8`; `Text` and `Bytes` are not
silently interchangeable. Runtime indexing and slicing emit bounds checks.

### 10. Types are compile-time values

Type algebra is expressed by source-defined operators:

```duck
type Value = I32 :| Text :| I64
type Number = Value :- Text
type ExactInt = Number :& I32

let value: Value = 42

if value is I32 {
  value
} else {
  0
}
```

- `:|` forms a type union.
- `:&` forms an intersection.
- `:-` removes members.
- `:+` extends a type value with namespace members or methods.
- `:>` seals a representation-compatible value as a nominal newtype.

Newtypes are zero-cost but nominally distinct:

```duck
const { newtype } = comptime import "duck:prelude" ()

type Centimeter = newtype I32
const distance = 42 :> Centimeter

Centimeter.unwrap distance
```

`packed` builds one source-defined scalar from fixed-width fields and generates
typed `pack`, access, and immutable `with_<field>` functions. See
[examples/data/15_packed_integers.duck](examples/data/15_packed_integers.duck).

### 11. Compile-time programming and Rank-N types

`comptime` evaluates a call while compiling. Const functions can generate
specialized runtime functions:

```duck
const make_adder = amount => value => value + amount
const add_two = comptime make_adder(2)

add_two(40)
```

Const evaluation supports lexical capture, memoized structural recursion, fixed
arrays, type descriptors, and reflection such as `@describe_fields`. Parameters
marked `const` specialize at each call site.

Explicit `forall` works at any type position. This function requires a callback
that remains polymorphic across both calls:

```duck
const apply_identity: (forall value.value -> value) -> I32 =
  (const identity) => if identity(true) {
    identity(41) + 1
  } else {
    0
  }

const identity = value => value
comptime apply_identity(identity)
```

### 12. Operators and the batteries-included prelude

Operators are declarations in Duck source, not parser-wired implementations. The
runtime prelude supplies arithmetic and comparison syntax. Importing the
functional prelude adds pipelines, application, append, bit operations, and
functional categories:

```duck
const { pipe, apply, length, bit_or } =
  comptime import "duck:prelude/functional" ()

const increment = value => value + 1
const double = value => value * 2

let piped = 20 |> increment |> double
let applied = double $ 10
let shifted = 1 << 4

piped + applied + length("abc") + bit_or [shifted, 2]
```

The same module exports `identity`, `constant`, `compose`, `flip`, `curry`,
`uncurry`, `fanout`, `converge`, and helpers for `Option`, `Result`, and
`Either`. It declares the standard ducks `Eq`, `Ord`, `Semigroup`, `Monoid`,
`Bits`, `Functor`, `Applicative`, `Monad`, `Foldable`, `Traversable`,
`Category`, `Show`, `From`, `Into`, `TryFrom`, and related categories.

The standard functional operators are:

| Operator            | Meaning                                      |
| ------------------- | -------------------------------------------- |
| `$`                 | function application                         |
| `                   | >`                                           |
| `<>`                | append                                       |
| `&&&`, `            |                                              |
| `<<`, `>>`          | left and unsigned-right shift                |
| `<$>`, `<*>`, `>>=` | functor map, applicative apply, monadic bind |
| `<                  | >`                                           |

### 13. Ducks, extensions, and compiler intrinsics

A `duck` is a structural compile-time contract. `extend` installs members for a
type, and `:+` creates a lexically extended type or const value:

```duck
duck Iterator Self {
  type Item
  .next = Self -> [Item, Self]
}

extend Counter {
  type Item = I32
  .next = counter => [counter.value, counter]
}
```

Duck type members are internal to the contract: member signatures can name them,
while each extension supplies the concrete type (or uses a declared default).
Value members remain structural and are checked after those type members are
substituted.

```duck
const readable = operations => {
  operations.read
  operations
}

const scalar_operations = 0
const scalar_operations = scalar_operations :+ {
  .read = value => value + 1
}

let read = (const operations: readable, value) => operations.read(value)
read(scalar_operations, 41)
```

Names beginning with `@` are compiler functions. Most application code reaches
them through source prelude wrappers. Important groups include:

- checked representation casts: `@as`, `@seal`, and `@representation`;
- text and collection operations: `@append`, `@len`, `@get`, and `@slice`;
- integer bits and shifts: `@bit_and`, `@bit_or`, `@bit_xor`, `@shift_left`, and
  `@shift_right_u`;
- numeric conversions, formatting, SIMD, UTF-8, and explicit panic;
- compile-time type reflection and the `@type.*` functions behind type
  operators.

### 14. Effects: host operations, local handlers, and defaults

Effects are typed operation sets. `<-` executes an effectful computation and
binds its result; ordinary `let` stays pure. Unannotated functions infer their
minimal row, while `-> <row>` states an explicit upper bound:

```duck
declare effect Io {
  read: () => Text
  print: (&Text) => Unit
}

let greet: () -> <Io.read :| Io.print> Text = () => {
  name <- Io.read()
  _ <- Io.print(&name)
  name
}
```

`declare effect` is implemented by the host. Plain `effect` is implemented by a
Duck handler:

```duck
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(40)
  value <- Counter.get()
  value + 2
}

let counter = {
  let count = 0
  Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => value,
  }
}

try run() with counter
```

Handlers are deep and resumptions are affine. Omitted operations forward to an
outer handler. Checked duplication is available only when every captured value
is safe to copy or share.

The effects prelude declares `State`, `Reader`, `Writer`, `Raise`, `Clock`,
`Random`, `Console`, `Environment`, `Resource`, `Log`, `Validation`, `Async`,
`Channel`, `Mutex`, `Semaphore`, `TaskGroup`, and `Stm`. The defaults module
provides source handlers and explicit adapter factories:

```duck
const _ = comptime import "duck:prelude/effects" ()
const { default_state, default_reader } =
  comptime import "duck:prelude/effects/defaults" ()

let run = () => {
  environment <- Reader.ask()
  _ <- State.put(environment + 2)
  value <- State.get()
  value
}

try (try run() with default_state(0)) with default_reader(40)
```

Use named const instances when one run has several effects from the same family:

```duck
const _ = comptime import "duck:prelude/effects" ()

const counter = State I32
const message = State Text
```

Those constants are nominal effect identities, not runtime state. Two
`State I32` instances are independent; each installed handler owns its state.
Async, STM, clock, and random adapters do not invent authority—the installed
implementation supplies scheduling, transactions, time, or entropy.

### 15. Affine values, borrowing, scratch storage, and freezing

`!` marks a value that must be consumed exactly once:

```duck
let consume = (!value) => value + 1

let !token = 41
consume(!token)
```

Ownership-oriented expressions make lifetime changes explicit:

- `&value` creates a bounded borrow.
- `scratch { ... }` scopes temporary allocation.
- `freeze value` promotes an immutable value to shareable storage.
- `dup` requests checked duplication rather than silently copying an affine
  value.

Host effect signatures use the same contracts:

```duck
declare effect Host {
  read: (&Text) => I32
  take: (Text) => I32
}
```

Core proves moves, borrows, allocation ownership, cleanup, and drops before WAT
emission. The managed ABI preserves those contracts when values cross into
JavaScript.

### 16. Modules, imports, capabilities, and exports

Reusable files are functions from an explicit module input to an export record:

```duck
module (capabilities) where

return {
  .run = capabilities.base + capabilities.bonus
}
```

The importer loads the module value, supplies its dependencies, and selects its
exports:

```duck
const score_module = import "./multi_file/score_module.duck"
const capabilities = [.base = 40, .bonus = 2]

let application = score_module(capabilities)
application.run
```

Importing does not grant authority. Managed entry modules receive their root
resources through `Init`, and imported modules receive only the narrowed record
the caller passes:

```duck
module (!init: Init) where

declare effect Console {
  print: (&Text) => Unit
}

declare Init { console: Console }

_ <- Console.print(&"hello")
return { .status = 0 }
```

The compiler turns declared host effects into typed Wasm imports internally;
there is no user-written raw Wasm import form.

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
