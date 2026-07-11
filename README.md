# Binned

Binned is a small Interaction Calculus inspired compiler pipeline written in
Deno. The project is intentionally direct and inspectable: source programs move
through explicit stages instead of a large hidden compiler framework.

```txt
Source -> IC -> Expr -> Mod -> WAT -> Wasm
```

The language is a compact value-oriented playground for compile-time
specialization, affine lowering, explicit sharing/erasure, ownership checks, and
direct WebAssembly output.

## Quick Start

Run the demo compiler pipeline:

```sh
just run
```

This writes `build/out.wat` from the example program in `main.ts`.

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

Install the repository's Tree-sitter grammar and Helix queries for `.ix` files:

```sh
just install
```

This adds a managed `ix` block to `~/.config/helix/languages.toml`, installs
highlight, indentation, locals, textobject, symbol, and rainbow-bracket queries,
and builds the grammar. `just helix-register` remains available as the explicit
Helix-specific alias. Run `just helix-grammar` to validate the grammar without
changing Helix configuration.

The tests use Deno and expect `wat2wasm` to be available for Wasm integration
checks.

## Example

```txt
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
`main` with the value `33`, and writes WAT. Loaded `.ix` files use the module
header and export-record form shown in the next section.

## Source Language

Loaded `.ix` files are modules. A module declares its inputs in the header and
returns an export record at the end of the file:

```txt
module () where

let x = 40
return { answer: x + 2 }
```

`Source.parse` also accepts header-free fragments for tests and interactive use.

Runtime values are immutable. Assignment syntax is modeled as shadowing:

```txt
let x = 40
x = x + 2     // same-type shadowing
x := "done"  // type-changing shadowing
```

Compile-time bindings use `const`, and compile-time execution uses `comptime`:

```txt
const factor = 2
const add_factor = comptime (n => x => x + n)(factor)
```

Closures use arrow syntax:

```txt
let add = (x, y) => x + y
let inc = x => x + 1
```

Recursive functions use `let rec`:

```txt
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(6)
```

## Syntax Snapshot

Common statement forms:

```txt
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

```txt
module () where
module (!init: Init) where

import logger from "./logger.ix"
const { write } = logger({ io: !init.io })

return { write }
```

Common expression forms:

```txt
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
object with { field: value }
```

Built-in type names:

```txt
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

```txt
const user_type = struct {
  name: Text,
  age: Int
}

let user = user_type {
  name: "Ada",
  age: 36
}

user.age
```

Unions support typed constructors and `if let` matching:

```txt
const option_type = t => union {
  some: t,
  none: Unit
}

const int_option_type = option_type(Int)
let value = int_option_type.some(41)

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

```txt
let greeting = "hello" + " " + "Ada"
len(greeting)
```

Text builtins include:

```txt
len(value)
get(value, index)
slice(value, start, end)
append(left, right)
```

## Host Effects And Modules

Host services are nominal opaque effects declared in an Ix host interface. Their
methods are the operations tracked by the effect system:

```txt
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

```txt
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

```txt
(List a, a -> <e> b) -> <e> List b
```

Imported files are loaded first and then instantiated with an explicitly
narrowed context record; an import does not grant authority by itself.

The entry module receives the sole root authority from JavaScript:

```txt
module (!init: Init) where

import console from "./console.ix"
const { greet } = console({ io: !init.io })
result <- greet("Ada")

return { result }
```

`declare effect` means that the operations are implemented by the host. Plain
`effect` defines operations handled entirely inside Ix:

```txt
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
effects and resumptions remain internal to one Ix run and never appear in the
managed JavaScript manifest.

## Ownership And Host Effects

Linear bindings and parameters are marked with `!`.

```txt
let !buffer = make_buffer()
let use_once = (!value) => value
```

Ownership-oriented expressions:

```txt
&value
freeze value
scratch { statements }
```

Host boundaries are declared as effects and supplied through `Init`. Operation
parameters carry the same scalar and ownership contracts used by Core:

```txt
declare effect Console {
  log: (I32) => I32
  print: (&Text) => I32
  make_text: (I32) => Text
}

declare Init { console: Console }
```

The compiler turns these operations into typed Wasm imports internally. There is
no user-written raw-import statement; this keeps host authority visible in
effect rows and makes the complete handler set swappable through `IxRunner`.

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
Source.artifact_file("main.ix", {
  host_interface: "host.ix",
});
```

Use the IC route for small scalar examples and open terms like `input + 1`. Use
the Core route for larger programs with structured statements, loops, runtime
text, host effects, closures, and aggregate behavior.

### Managed JavaScript host ABI

`Source.artifact` emits the `ix-js-2` manifest and a module with exported
`memory`, `__ix_abi_alloc`, `__ix_abi_free`, and `__ix_abi_main`. Instantiate
that artifact through `IxHost` to receive JavaScript values instead of raw Wasm
pointers:

```ts
import { IxHost, IxRunner, Source } from "./src/frontend.ts";

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
return { result }
`);
const wasm = compileWat(artifact.wat);
const program = await IxHost.instantiate(wasm, artifact.abi);

const runner = IxRunner({
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
objects captured by `IxRunner(init)` are the actual authority. Constructing a
different runner swaps the complete handler set without changing the compiled
program.

The adapter marshals entry context and export records while host effects remain
opaque registry resources inside Wasm. It validates resource handles, required
methods, UTF-8, bounds, union tags, handler availability, and ABI versions.
Allocations grow Wasm memory when needed. `Source.wat` retains the lower-level
scalar/pointer output for embedders that do not need the managed adapter.

## Repository Layout

```txt
main.ts             demo pipeline that writes build/out.wat
test.ts             Wasm integration tests
src/frontend.ts     source frontend public exports
src/ic.ts           Interaction Calculus layer
src/expr.ts         expression layer
src/mod.ts          Wasm module layer
src/core.ts         structured Core path
docs/language.md    longer source-language notes
examples/           runnable .ix source programs and expected failures
tree-sitter-ix/     Tree-sitter grammar and Helix queries for .ix files
tasks/              planning notes and task breakdowns
```

## Development

```sh
just fmt
just fmt-check
just lint
just test
just check
```

Style notes that matter in this repository:

- Keep compiler stages small and explicit.
- Do not silently default missing compiler information.
- Prefer direct invariant checks with `expect(value, message)`.
- Keep semantic operations separate from concrete Wasm instructions.
- Keep tests close to the implementation they cover.
