# Ducklang

Ducklang is an Interaction Calculus inspired language that compiles to
WebAssembly. The parts other languages wire into their compiler — arithmetic
operators, type algebra, `derive`, effect handling — are ordinary Ducklang
declarations here, and the compiler specializes them away before anything
reaches the target.

```txt
Source -> Frontend -> semantic Core -> gpufuck Functional Core -> Wasm
```

Ordinary code looks ordinary. The last expression is the program result:

```duck
const { .struct } = import "duck:prelude" ();

type Point = struct { .x = Int, .y = Int }

let rec fib = n => if n < 2 { n } else { fib(n - 1) + fib(n - 2) };

let origin = Point.new { .x = 0, .y = 0 };
let moved = origin <& { .x = 20 };

let total = 0;
for value in 1..=4 {
  total = total + value
}

fib(8) + moved.x + total
```

Everything past this point is the part that isn't.

## `+` is a library declaration

Four lines lifted straight out of the prelude:

```duck
infixr 75 :> = @seal
infixl 45 :| = @type .union
infixl 60 + = @syntax.add
infixr 50 <> = Semigroup.append
```

Addition, type union, newtype sealing, and monoid append are all the same kind
of thing: a fixity, a precedence, and a function. Your operators get the exact
same treatment, dispatched through a `duck` — a structural compile-time contract
with no classes, no instances, and no coherence rules:

```duck
duck Add Self Other Output {
  .add = [Self, Other] -> Output
}

extend I32 {
  .add = [left, right] => @wasm.add_i32 [left, right],
}

infixl 60 +++ = Add.add

20 +++ 22
```

The prelude ships `Eq`, `Ord`, `Semigroup`, `Monoid`, `Bits`, `Functor`,
`Applicative`, `Monad`, `Foldable`, `Traversable`, `Show`, and friends the same
way, plus `|>`, `$`, `<$>`, `<*>`, and `>>=` to drive them.

## Types are values you compute with

There is no type-level sublanguage. Type algebra is a handful of source-defined
operators over ordinary compile-time values:

```duck
type Value = I32 :| Text :| I64
type Number = Value :- Text
type Method = "GET" :| "POST"
type Bit = 0 :| 1
type Centimeter = newtype I32

const distance = 42 :> Centimeter;
distance :< I32
```

`:|` unions, `:&` intersects, `:-` removes members, `:+` extends a type with
members, `:>` seals a value into a nominal newtype and `:<` opens it back to its
representation. Literals are singleton types, so `@type_of(1)` is `1`, not
`Int`. Newtypes cost nothing at runtime and still refuse to be confused with
their carrier.

## Compile time is the same language, so `derive` is just a function

Reflection is a normal call. Nothing here is a macro, an attribute plugin, or a
compiler builtin you cannot read:

```duck
const { .struct } = import "duck:prelude" ();
const { .length } = import "duck:prelude/runtime" ();

type Player = struct { .left = Int, .right = Int }

const fold = rec (values, index, state, next) => {
  if index == length values {
    state
  } else {
    rec(values, index + 1, next(state, values[index]), next)
  }
};

const derive_sum = (const target) => {
  const add_field = (sum, field) => value => sum value + @project(value, field);
  fold(@describe_fields target, 0, value => 0, add_field)
};

const sum_player = comptime derive_sum Player;
```

`comptime` evaluates the call while compiling and leaves a specialized runtime
function behind. Parameters marked `const` specialize per call site. Const
evaluation gets lexical capture, memoized structural recursion, fixed arrays,
and type descriptors, which is enough to write real derivation:
[13_derived_nested_equality.duck](examples/compile_time/13_derived_nested_equality.duck)
builds structural equality across records, arrays, and sums in about a hundred
lines of ordinary source.

Explicit `forall` works at any type position, so a const function can demand a
callback that stays polymorphic across every use.

## Effects are inferred, and handlers are code you write

```duck
effect Counter {
  get: () => I32
  add: (I32) => Unit
}

let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(40)
  value <- Counter.get()
  value + 2
};

let counter = {
  let count = 0;
  handler Counter {
    get: (!resume) => !resume count,
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => value,
  }
};

try run() with counter
```

`<-` performs an operation and binds its result; plain `let` stays pure.
Unannotated functions infer their minimal effect row, so nothing becomes
effectful all the way down by accident. A `!resume` parameter is affine and
checked as one-shot; a reusable `resume` has to prove every captured value is
safe to copy, which is what keeps multi-shot handlers honest.

Write `try computation` without `with` and the compiler installs the default
handler for each inferred effect, ordered by the `.order` each extension
declares. Missing defaults, duplicates, and ties are compile errors rather than
surprises. The effects prelude declares `State`, `Reader`, `Writer`, `Raise`,
`Do`, `Clock`, `Random`, `Console`, `Resource`, `Async`, `Channel`, `Mutex`,
`TaskGroup`, and `Stm`, with source handlers in a separate defaults module.

Effects the host implements are declared, and the compiler turns them into typed
Wasm imports. There is no user-written raw import form:

```duck
declare effect Stdout {
  write_line: (&Text) => Unit
}
```

## Ownership is proved before any Wasm exists

```duck
let consume = (!value) => value + 1;

let !token = 41;
consume !token
```

`!` marks a value that must be consumed exactly once. `&value` takes a bounded
borrow, `freeze` promotes an immutable value to shareable storage,
`scratch { ... }` scopes temporary allocation, and `dup` asks for a checked
duplicate instead of silently getting one. Core proves moves, borrows,
allocation ownership, cleanup, and drops before the program reaches the target,
and its typed host boundary keeps those contracts when values cross into
JavaScript.

## Data that says exactly how wide it is

Integers exist at every width as `I<N>` and `U<N>`. `packed` folds fixed-width
fields into one scalar and generates typed `pack`, accessors, and immutable
`with_<field>` functions:

```duck
type Header = packed struct {
  .kind = U3,
  .urgent = U1,
  .length = U12,
}

let header: Header = Header.pack [5u3, 1u1, 120u12];
let changed: Header = Header.with_kind [header, 2u3];
```

Widths through 64 bits use scalar carriers; wider ones use an affine multi-limb
Core representation.

Storage and arity are also kept apart. `[A, B]` is stored tuple data, while
`(A, B)` is a transient value pack that only exists at a function boundary, so
`let pair = (left, right)` is rejected on purpose. `(A; N)` repeats a type into
an N-value pack at compile time:

```duck
const width = 3;
let sum: (I32; width) -> I32 = (a, b, c) => a + b + c;
sum(20, 21, 1)
```

## Patterns reach into text

```duck
let classify = (value: Text) => match value {
  | "hello ${name} why" => length name
  | "" => 0
  | _ => 1
};
```

The fixed portions match as UTF-8 bytes and the capture binds an owned `Text`
slice. `|` joins arms that bind the same names, and coverage is checked:

```duck
match response {
  | `Cached value | `Fresh value => value
  | _ => "unknown"
}
```

## Importing a module grants it nothing

A module is a function from an input record to an export record:

```duck
module (capabilities) where

return {
  .run = capabilities.base + capabilities.bonus
};
```

```duck
const score_module = import "./score_module.duck";

let application = score_module [.base = 40, .bonus = 2];
application.run
```

Resolution and invocation happen during compilation. An imported module sees
only the record its caller hands it, and root resources arrive at the entry
module through `Init`. There is no ambient filesystem, no ambient clock, and no
ambient authority to smuggle anywhere.

`include "./config.json"` reads a file into a compile-time `Text` literal, and
parsing it is an ordinary staged call, so the parser you wrote decides the
resulting value and type.

## It runs real programs

- [case-studies/raytracer](case-studies/raytracer) renders a P6 PPM with one
  sphere, ambient-plus-diffuse shading, and a sky gradient. `@Bytes.generate`
  calls a pure callback once per output byte, so the renderer has no mutable
  buffer and no host effect at all.
- [case-studies/wav](case-studies/wav) synthesizes a second of 8 kHz 16-bit PCM
  from two square-wave voices. Every byte of the RIFF header and every sample is
  a pure function of its index.
- [case-studies/editor](case-studies/editor) is a modal terminal editor on the
  Helix selection model: a height-balanced piece tree with cached byte and line
  counts, source-defined modes, and a decoder that holds partial CSI sequences
  across reads. Deno only enters raw mode and moves bytes.

The renderer and synthesizer tests checksum the exact output bytes, so the
compiler cannot quietly drift underneath them.

## Get started

You need Deno 2.9.2, Tree-sitter CLI 0.26.3, `just`, a WebGPU adapter, and the
sibling `../gpufuck` checkout. The compiler emits binary Wasm directly, so there
is no WABT anywhere in the loop.

```sh
just duck run examples/basics/01_arithmetic_and_shadowing.duck
just duck build main.duck    # writes build/main.wasm
just duck test tests.duck    # runs zero-argument @[test] functions
just duck check examples     # syntax and semantic diagnostics
just duck fmt examples       # format in place
just duck lsp                # language server over stdio
just examples                # compile and run the whole catalog
```

The formatter and language server live in `src/fmt/` and `src/lsp/`, decoupled
from the compiler pipeline, which is why `duck check` and format-on-save never
touch WebGPU. The formatter has no configuration and that is the point: two
space indentation, fixed spacing, canonical escapes, comments preserved, lines
never reflowed, and a flat refusal to rewrite a file that does not parse.

For editor support:

```sh
just install
```

That builds the Tree-sitter grammar, installs highlight, indent, locals,
textobject, symbol, and rainbow-bracket queries, and registers the language
server with format-on-save in a managed `duck` block in
`~/.config/helix/languages.toml`.

### Embedding the compiler

`DuckCompiler` is the supported TypeScript API:

```ts
import { DuckCompiler } from "./src/compiler.ts";

const compiler = await DuckCompiler.create();

try {
  const wasm = await compiler.compile_file("main.duck");
  const execution = await compiler.run_file("main.duck", {
    host_interface: "host.duck",
    init: {
      Console: {
        $resource: { kind: "resource", id: 1 },
        print: (value) => {
          console.log(value);
          return { kind: "unit" };
        },
      },
    },
  });
  console.log(wasm.byteLength, execution.value);
} finally {
  compiler.destroy();
}
```

A host interface contributes declarations only. The `init` values are the entire
authority the running program has.

## Where to go next

- [docs/language.md](docs/language.md) is the language reference.
- [examples/README.md](examples/README.md) is the executable catalog. Every
  syntax feature maps to a runnable program, including the ones the compiler
  must reject and the ones that must trap.
- [docs/architecture.md](docs/architecture.md) covers the pipeline and its stage
  boundaries.
- [docs/coverage.md](docs/coverage.md) records what compiles through gpufuck
  today, and [docs/roadmap.md](docs/roadmap.md) records what does not yet:
  runtime collections, first-class linear closures, portable async, and richer
  runtime unions.
- [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow and the `just check`
  verification gate.

Ducklang is available under the [MIT License](LICENSE).
