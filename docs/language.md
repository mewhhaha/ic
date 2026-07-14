# Source Language

This document is the normalized project specification for the source frontend
that lowers into the Interaction Calculus IR.

The language is a small effect-oriented value language. Runtime code and
compile-time code use the same expression syntax. Values are immutable, while
source names may be shadowed to provide imperative flow. Host effects are opaque
values passed through explicit module contexts, and the compiler infers
operation-level effect rows. Types are compile-time values, and protocol-like
abstractions are ordinary const fact checkers.

This file describes the language contract: syntax and the semantics a program
can rely on. Which source shapes each backend route currently accepts is
implementation status and lives in [coverage.md](coverage.md). Where a feature
below is marked reserved or rejected, the rejection is deterministic and carries
a diagnostic; it is part of the contract until the feature lands.

## Naming

Runtime bindings, const bindings, function parameters, loop binders, pattern
binders, linear-value references, type-values, type constructors, fact checkers,
protocol values, fields, methods, modules, and ordinary helper functions use
`snake_case`: a lowercase letter followed by lowercase letters, digits, or
underscores.

Declared host effects and host context records use type-style names such as `Io`
and `Init`. Lowercase names in an effect row, such as `e`, are inferred row
variables. Effect operations are always qualified by their declared effect.

```txt
let read_number = input
const make_adder = n => x => x + n
const layout_of = t => layout(t)
const align_to = (offset, alignment) => offset
const greet_user = user => user.name
const user_layout = layout(user_type)
```

Built-in type-value names such as `Int`, `I64`, `Text`, `Unit`, and `Type` keep
their builtin spelling. User-defined names and type references in annotations,
field access, struct fields, union cases, `if let` payload binders, and
destructuring patterns use `snake_case`. Compiler-internal source marker names
use `snake_case`, such as `object_type`, `layout_type`, and
`field_offsets_type`. Excluded language-family keywords such as `class`,
`trait`, `macro`, `instance`, `extends`, and `inherits` are reserved so they
produce explicit unsupported-feature diagnostics instead of becoming ordinary
names.

```txt
const user_type = struct {
  name: Text,
  age: Int
}

const option_type = t => union {
  some: t,
  none: Unit
}

const functor = f_type => {
  f_type.map
  f_type
}
```

## File Modules

Every loaded `.ix` file starts with a module header and ends with an explicit
export record. A file without inputs uses an empty header:

```txt
module () where

let answer = 40 + 2
return { answer }
```

Host-initialized entry modules declare their input schema and consume the input
linearly:

```txt
module (!init: Init) where

let result = 42
return { result }
```

The module body is not indented and does not use braces. All top-level paths
must reach a final `return { ... }`, and branch-produced export records must
have compatible fields and types. `Source.parse` remains a fragment parser for
tests and interactive compilation; file loading is what enforces the header and
final export record.

An import loads a file but does not instantiate it or grant it authority.
Instantiation is a separate call with an explicit dependency record:

```txt
const logger = import "./logger.ix"
const { write } = logger({ io: !init.io })
```

Module invocation is compiler-time wiring and specialization. Its result is the
imported file's export record, so ordinary record destructuring selects exports.
An `_` entry in that pattern selects no field and ignores the remaining export
shape. The entry module's final record is returned by the managed JavaScript
`IxRunner(init).run(program)` call. A runner captures one explicit handler set;
selecting another runner swaps host or mock effects without recompiling the
module.

## Bindings

`let` creates a runtime binding.

```txt
let x = 2
```

`const` creates a compiler-known binding.

```txt
const factor = 2
```

`=` shadows an existing name and requires the same type.

```txt
let x = 2
x = 3
```

If the previous binding has explicit runtime type context and the new value is
otherwise unknown, `=` preserves that context for later lowering. For function
values, `=` compares parameter shape as part of the type: arity, `const`/`!`
flags, and annotation shape must match, while parameter names do not matter.
Built-in integer annotation aliases such as `Int`, `I32`, and `U32` are treated
as the same `i32` parameter type. For structs with known field-type facts, `=`
also compares the declared field types, so a value with the same field names but
incompatible payload types is a type change. Anonymous object literals expose
shallow field-type facts when every field has a simple known type such as `Int`,
`I64`, or `Text`. Shorthand union cases such as `.ok(1)` also expose payload
facts when the payload has a simple known type, so `.ok(Int)` and `.ok(Text)`
are different types for `=` shadowing.

`:=` shadows an existing name and allows the type to change.

```txt
let x = 2
x := "hello"
```

Internally, shadowing creates deterministic fresh names.

```txt
let x#0 = 2
let x#1 = 3
```

Bindings may have annotations. Built-in scalar/type annotations are checked at
the binding. When the annotation names a visible struct or union type-value,
shorthand object and union-case values are checked and given that direct type
context; for typed union annotations, declared case payload types also flow into
shorthand object payloads such as `.ok({ age: 40 })`. Fact-checker annotations
run the named const fact checker against the bound value's type-value. An
explicit runtime annotation can also provide type context for an otherwise
unknown runtime value, while known incompatible values still fail at the
binding. Parameter annotations follow the same rules and are enforced at the
call boundary.

```txt
let x: Int = 41
let wide: I64 = 41i64

const user_type: has_name = struct {
  name: Int,
  age: Int
}

let user: has_name = user_type {
  name: input,
  age: 0
}
```

Integer literals carry value types in Ic. Unsuffixed source integers are the
`Int`/`i32` convention. Explicit suffixes are available for scalar lowering.
Annotated `I64` bindings and parameters give i64 type context to arithmetic over
runtime names; explicit mixed `i32`/`i64` operands are rejected.

```txt
let small = 42i32
let wide = 42i64
```

Double-quoted string literals produce UTF-8 `Text`.

Boolean literals carry the semantic source type `Bool`. `Bool` is represented as
`i32` after frontend lowering: `true` lowers to `1:i32` and `false` lowers to
`0:i32`. Comparisons, equality, logical operators, and `value is T` produce
`Bool`. Conditions and logical operators consume `Bool`; they also accept
`Int`/`I32` under the retained truthiness compatibility rule, where zero is
false and every nonzero value is true. `Bool` and `Int`/`I32` remain distinct
source types, so annotations, arithmetic, and equality do not silently mix them.

Character literals remain source-level scalar syntax over `i32`. A single-quoted
character lowers to its Unicode scalar value as `i32`, and `if let` character
patterns compare `i32` equality. Text indexing stays UTF-8-byte based, so a
non-ASCII character's scalar value is not the same as one indexed byte of its
UTF-8 encoding.

```txt
let message = "hello"
let ready = true
let newline = '\n'
let lambda = 'λ'
```

String escapes support `\n`, `\t`, `\r`, `\"`, and `\\`. Character escapes
support `\n`, `\t`, `\r`, `\'`, and `\\`, and a character literal must contain
exactly one Unicode scalar after escape decoding.

Literals can also be used as equality patterns in `if let`. Literal patterns do
not introduce a binding; they select the branch when the target equals the
literal. Both the ordinary Ix spelling and a parenthesized condition are
accepted.

```txt
if let '\n' = byte {
  line_count = line_count + 1
}

if (let "dry-run" = argument) {
  dry_run = true
}
```

Union patterns remain structural and can bind their payload, as in
`if let .ok(value) = result { ... }`.

`Bytes` is the raw, non-UTF-8 buffer type used by managed host effects. Runtime
`Bytes` values support `len`, `get`, byte iteration, `slice`, and `append`, and
bounded borrows can cross effect calls. There is no source `Bytes` literal or
borrowed slice view yet.

### Text Operations

Text values are UTF-8. The contract for text operations:

- `+` and `append(left, right)` concatenate text values.
- `len(value)` is the UTF-8 byte length.
- `value[index]` and `get(value, index)` return the UTF-8 byte at `index` as
  `i32`, trapping on out-of-range indexes.
- `slice(value, start, end)` selects a byte range.
- `==` and `!=` compare text by bytes and produce `Bool`, represented as `i32`
  after frontend lowering.
- Collection loops over text iterate UTF-8 bytes.
- A value known to have type `Text` cannot be used as a numeric primitive
  operand. Other known non-numeric values, such as structs, unions, functions,
  and type-values, are also rejected before primitive lowering.

Which text expressions fold at compile time versus allocate at runtime depends
on the backend route; see [coverage.md](coverage.md).

## Compile-Time Execution

`comptime` evaluates an expression during compilation.

```txt
const make_adder = n => {
  x => x + n
}

const add_three = comptime make_adder(3)
let result = add_three(input)
```

Const functions are statically known closures. They may capture const values but
must not capture runtime values. Const bindings preserve their binding-time
environment, so later shadowing does not change a const value or const closure's
captured state.

Function parameters may be marked `const`. A const parameter must be known at
the call site and specializes the call.

```txt
let apply_const = (x, const f) => {
  f(x)
}

const double = x => x * 2
let y = apply_const(21, double)
```

Const values can be reified when passed to ordinary runtime parameters if the
target value can lower to the current scalar Ic subset.

## Functions And Control Flow

Functions use closure syntax.

```txt
let add = (x, y) => x + y

let add_block = (x, y) => {
  x + y
}
```

Blocks return their final expression. `return` exits the nearest function,
including through nested block expressions used before later fallthrough
statements.

Closures capture their environment at binding time. Runtime scalar captures are
snapshotted when the closure value is bound, so later shadowing does not change
the captured value. Closure-local assignment and shadowing do not clobber caller
locals. Same-type assignment to a captured scalar name is a per-call
closure-local shadow. Known incompatible arguments are rejected at the call
site, while unknown runtime arguments can receive parameter type context from
annotations. General first-class linear closure captures remain reserved; direct
non-escaping local closure calls can consume outer linear values when linear use
is valid along each enclosing control-flow path. A reusable stored closure may
capture only scalar or frozen/shareable slots. An unfrozen unique owner must
move into a supported one-shot closure environment or the program rejects before
WAT emission.

`if` is an expression when both branches are present.

```txt
if input {
  42
} else {
  0
}
```

No-else `if` statements support fallthrough. Static conditions expand the chosen
path. Dynamic conditions lower by treating the following statements as the
implicit else path. In expression position, no-else `if` and `if let` use a
typed scalar zero fallback, so an `I64` then-branch gets `0i64` while an `Int`
then-branch gets `0`. A condition should be `Bool`; `Int`/`I32` conditions keep
their compatibility truthiness behavior. Known text, struct, union, function,
type-value, and `I64` conditions are rejected.

```txt
let value = 1

if flag {
  value = 42
}

value
```

```txt
let value = if flag {
  42
}
```

Logical operators are short-circuiting `if` sugar that produces `Bool`. Their
operands use the same `Bool`-first, `Int`/`I32`-compatible truthiness rule as
conditions.

The bare form `!name` is reserved for affine consumption. Negate a named Boolean
with parentheses, as in `!(ready)`; literals and calls can use `!false` and
`!ready()` directly.

```txt
ready && valid
ready || fallback
```

`else if` is nested expression syntax: each `else if` is an `if` expression in
the preceding branch's `else` arm. It can chain ordinary conditions, literal
`if let` patterns, and union `if let` patterns; every arm must produce a
compatible value (or update compatible state when used as a statement).

```txt
let label = if score == 0 {
  "zero"
} else if score == 1 {
  "one"
} else {
  "many"
}

let value = if let 0 = byte {
  10
} else if let '\n' = byte {
  20
} else if let .ok(found) = result {
  found
} else {
  0
}
```

`if let` matches union cases when the case is statically known. Runtime payloads
are still allowed in the known case, and bound union values preserve their
payload's binding-time environment when later names are shadowed. Known union
cases can also be matched after frontend-known field access or static aggregate
indexing.

```txt
let result = .ok(input)

if let .ok(value) = result {
  value + 1
} else {
  0
}
```

```txt
let value = if let .ok(found) = result {
  found + 1
}
```

Runtime union matching where the case is not statically known requires a typed
union target: a direct typed union annotation, a typed constructor, or a dynamic
`if` whose branches construct cases of an inferable union. Dynamic `if let`
expressions that produce unannotated union results carry their inferred
union-case table into later `=` shadowing checks. The exact set of dynamic union
shapes each route accepts is tracked in [coverage.md](coverage.md).

## Types, Structs, Unions, And Facts

Types are const values.

```txt
const user_type = struct {
  name: Text,
  age: Int
}
```

Type constructors are const functions returning type-values.

```txt
const result_type = e => t => union {
  ok: t,
  err: e
}

const parse_result_type = result_type(Text)(Int)
```

The experimental row syntax provides named `type` declarations as surface sugar
over those same const type-values. Bracket products may be labeled or
positional:

```txt
type Vec3 = (.x = Int, .y = Int, .z = Int)
type Pair = [Int, Int]

let point: Vec3 = (.x = 40, .y = 1, .z = 1)
let pair: Pair = [point.x, point.y]
```

Products are ordered even when their slots have names. A field name is an alias
for its declaration-order index, so `point.x` and `point[0]` select the same
slot, `point.y` and `point[1]` select the same slot, and so on. Static indexes
may select any slot. Runtime indexes retain the existing homogeneous
runtime-index rule: every selectable slot must have a compatible value type.
Reordering fields therefore changes both their indexes and their layout.

Commas form products. Named and positional entries cannot be mixed when a
product is declared or constructed, but both named and indexed access work on
the resulting value. Sum declarations use `|` between cases and need no
surrounding brackets. A leading `|` is accepted for multiline formatting:

```txt
type Maybe a = .just = a | .nothing

type Maybe a =
  | .just = a
  | .nothing

type MaybeInt = Maybe Int
```

A bare case has a `Unit` payload. Payload-bearing cases use `=`. Type parameters
elaborate to the existing compile-time type constructors, and a named alias such
as `Maybe Int` specializes one before Core lowering. The formatter emits sums in
the multiline leading-pipe form.

This first experiment supports closed top-level products, sums, aliases, and
product values. It preserves existing field order, union tags, and ABI layouts;
it does not implement structural row normalization, row spreads, open row
variables, or width subtyping yet. Nested product payloads and applied row
members are rejected before Core lowering. Recursive declarations are parsed but
rejected explicitly because recursive generic substitution and recursive
owned-child destruction are not implemented safely yet:

```txt
type List a =
  | .nil
  | .cons = [a, List a]
```

This reports `Recursive algebraic type declarations are not supported yet: List`
rather than emitting a partially owned recursive heap layout. Existing
`struct { ... }` and `union { ... }` syntax remains supported as the underlying
representation during the experiment.

Types also compose as sets. Union, intersection, and difference use the same
operators as effect rows, with difference binding most tightly:

```txt
type Value = Int | Text | I64
type Number = Value \ Text
type Answer = Number & Int

let value: Value = 42
let answer: Answer = if value is Int { value } else { 0 }
```

`_` is the top type and accepts every value. `Never` is the bottom type and has
no values. Finite unions use the existing tagged-union runtime layout when their
members need different runtime interpretations. Intersections of compatible
product rows merge their fields; finite differences and intersections normalize
before layout selection.

Set aliases may be generic, and a plain member value is injected into the
appropriate finite-union case at an annotated binding or function call:

```txt
type Maybe a = a | #nothing
type MaybeInt = Maybe Int

let unwrap = (value: MaybeInt) =>
  if value is Int { value } else { 0 }

unwrap(42)
```

The specialization may also be used directly as an annotation, as in
`let value: Maybe Int = 42`. Named specializations are materialized before Core
and retain the same tagged schema when exposed through the managed ABI.

`value is T` is an ordinary `Bool` expression, represented as `i32` after
frontend lowering. In an `if` condition, it also narrows a named value in both
branches. The false branch carries the remaining set, so chained `else if` tests
can exhaust unions with more than two members.

Atoms use `#snake_case` as both a value and its singleton type:

```txt
type Marker = #ready | #waiting
let marker: Marker = #ready

if marker is #ready { 1 } else { 0 }
```

Atoms are allocation-free `i32` identities. A compilation unit rejects the
extremely rare case where two distinct spellings map to the same identity,
rather than silently treating them as equal.

The same prefix marks frozen/shareable rich types when followed by a PascalCase
type name. `&` marks a bounded borrow. Parentheses make compound modalities
explicit:

```txt
type FrozenText = #Text
type FrozenList a = #(List a)

let text: FrozenText = "hello"
let view: &Text = &text
```

For host effect contracts, `&T` means a bounded borrow, `#T` means a
frozen/shareable value, and plain rich `T` means ownership transfer for an
argument or a unique owned result.

First-class closure parameters retain singleton-atom constraints.
Ownership-qualified closure parameters such as `#Text` and `&Text` are rejected
for now because the closure runtime does not yet carry frozen-result ownership
or the borrow-view source and lifetime into the lifted body. Ordinary bindings,
effect arguments, freezing, and direct value borrows still use the sigils
normally.

Recursive algebraic layouts are still rejected, so `#(List a)` is available as
type syntax but cannot make the currently unsupported recursive `List` layout
emittable. Ownership-qualified members such as `#Text | Int` are also rejected
as runtime tagged sets for now: the current union envelope does not encode a
different ownership policy per tag, and accepting it would make destruction
unsound.

Struct construction validates field names and field types.

```txt
let user = user_type {
  name: "Ada",
  age: 36
}
```

Union constructors validate case names and payload types.

```txt
let result = parse_result_type.ok(42)
```

Fact checkers are const functions over type-values.

```txt
const has_name = t => {
  let struct { name: Text, .. } = t
  t
}

let greet = (const t: has_name, value) => {
  size_of(t) + value
}
```

Visible `struct { ... }` and `union { ... }` type-check patterns are validated
against compile-time type-values and elided from generated code; they are
compile-time statements, not runtime checks. Type aliases used inside struct
fields, union payloads, and destructuring patterns preserve their binding-time
environment, so later shadowing does not change the resolved type. Non-final
expression statements proven to be compile-time-only, including type-values and
`with` extension expressions, are validated as const expressions and then
elided.

Runtime struct parameters can use fact-checker annotations when the argument is
a frontend-known struct value. The call specializes at the call site so scalar
field reads can still lower to Ic.

```txt
let inc = (x: Int) => {
  x + 1
}

let get_name = (user: has_name) => {
  user.name
}
```

Runtime union parameters can also use fact-checker annotations when the argument
comes from a typed union constructor. Direct union annotations provide context
for shorthand values such as `.ok(1)` and dynamic `if` expressions whose
branches construct cases of the annotated union, including cases carrying
explicitly named struct payloads; fact-checker annotations still require an
already typed union value.

```txt
const result_like = t => {
  let union { ok: Int, .. } = t
  t
}

let unwrap = (result: result_like) => {
  if let .ok(value) = result {
    value
  } else {
    0
  }
}

let result = result_type.ok(input)
unwrap(result)
```

The frontend supports structural builtins:

```txt
has(user_type.name)
fields_of(user_type)
cases_of(result_type)
is_struct(user_type)
is_union(result_type)
size_of(user_type)
align_of(user_type)
layout(user_type)
```

## Extensions And Protocols

`with` creates an extended const value and shadows the previous name. Extension
is lexical, not global. Extension fields preserve their binding-time
environment, including fields inherited through earlier extension layers.

```txt
const box_type = t => t

const box_type = box_type with {
  map: (value, const f) => {
    f(value)
  },

  pure: value => value,

  bind: (value, const f) => {
    f(value)
  }
}
```

Protocols are ordinary const fact checkers over extended values.

```txt
const functor = f_type => {
  f_type.map
  f_type
}

const applicative = f_type => {
  comptime functor(f_type)
  f_type.pure
  f_type
}

const monad = m_type => {
  comptime applicative(m_type)
  m_type.bind
  m_type
}

let bind_add = (const m_type: monad, value, const f) => {
  m_type.bind(value, f)
}
```

Protocol-constrained calls specialize before Ic lowering. There is no runtime
typeclass or instance search.

An extension can also hold a closed family of type-values. Selecting a field
specializes the family to an ordinary struct or union before Core emission:

```txt
const calc_types = 0
const calc_types = calc_types with {
  number: union { literal: Int, add: add_args_type },
  text: union { literal: Text }
}

const number_calc_type = calc_types.number
const text_calc_type = calc_types.text
```

The selected union controls which constructors exist, so
`number_calc_type.add(...)` is valid while `text_calc_type.add(...)` is
rejected. This is a closed, compile-time indexed family rather than a general
GADT: abstract indices, existential packaging, and recursive indexed unions
remain reserved. See `examples/compile_time/11_indexed_calculator.ix` for the
complete executable calculator.

## Linear Values And Host Effects

Linear parameters are marked with `!`.

```txt
let keep = (!x) => {
  x
}
```

Pure linear `let` and `const` bindings are also supported when the value can
lower to Ic.

```txt
let !token = 41
!token

const !known_token = 41
!known_token
```

A linear value must be consumed exactly once along every control-flow path. Host
authority enters through nominal effects declared in the compiler's host
interface:

```txt
module () where

declare effect Io {
  read: () => Text
  print: (&Text) => Unit
}

declare Init {
  io: Io
}

return {}
```

`declare effect Io` creates a nominal effect family, the operations `Io.read`
and `Io.print`, and an opaque host-handler type that may appear in a context
record. Ix cannot construct or inspect an `Io`; JavaScript supplies an instance
through the entry `Init`. `declare` means the operations are host-implemented.
Only declared effects appear in the managed JavaScript ABI.

An unannotated function receives its minimal inferred operation row:

```txt
let read_name = () => {
  name <- Io.read()
  name
}
```

Function types use whitespace application, right-associative `->`, and an
optional latent row between the arrow and result. An explicit row is an upper
bound, so every inferred operation must belong to it. Omitting the row from an
explicit function type declares the function pure:

```txt
let greet: () -> <Io.read | Io.print> Text = () => {
  name <- Io.read()
  _ <- Io.print(&name)
  name
}

let increment: I32 -> I32 = value => value + 1
```

`value <- computation` executes an effectful computation and binds its result.
`_ <- computation` discards a `Unit` result. Ordinary `let value = ...` is a
pure binding and rejects an effectful right-hand side. Compatible effects are
inferred through calls, including recursion and higher-order calls. Callers do
not manually thread an effect token. The compiler preserves the linear
proof-token discipline internally, but that implementation detail is not part of
the source language.

Type constructors compose by whitespace application. Row variables propagate
callback effects through higher-order types:

```txt
(List a, a -> <e> b) -> <e> List b

let apply: (I32 -> <e> I32, I32) -> <e> I32 =
  (const callback, value) => {
    result <- callback(value)
    result
  }
```

Creating an anonymous closure is pure. Invoking it introduces its inferred
latent row.

In this first row-polymorphism slice, unresolved row variables compose through
union. Intersection and difference still work for concrete rows; an unresolved
variable beneath `&` or `\` is reserved until symbolic row constraints are
implemented.

Effect rows are sets of qualified operations. A family atom expands to every
operation declared by that effect. Set expressions use these operators:

```txt
A | B  // union
A & B  // intersection
A \ B  // difference
```

`Io.read | Io.print` permits both operations, while two disjoint families such
as `Stdin & Stdout` intersect to the empty row. Parentheses group compound row
expressions. Handler discharge subtracts the handled operation set
automatically.

Rows propagate through branches, callbacks, closures, module initialization, and
exported function types. Capturing a linear host resource makes the closure
one-shot under the normal linear closure rules. The compiler rejects operations
outside an explicit row, effects in an explicitly pure arrow, incompatible
branch rows, effect-resource duplication, and authority hidden inside a reusable
closure.

Operations are selected by their declared effect name, for example `Io.read()`
or `Stdout.write_line()`. The effect row on a function type records the
operations it may perform; callers need only provide compatible runners.

Imported modules receive only the explicitly passed subset of the caller's
context:

```txt
module (!init: Init) where

const logger = import "./logger.ix"
const { write } = logger({ io: !init.io })
result <- write("hello")

return { result }
```

Loading `logger.ix` alone grants no authority. Module invocation consumes or
borrows the resources named by its declared parameters and returns its export
record.

## Ix-Defined Effects And Handlers

Plain `effect` declares operations implemented inside Ix:

```txt
effect Counter {
  get: () => I32
  add: (I32) => Unit
}
```

An effect implementation is a value whose effect name disambiguates its clause
shape. Bindings before the final implementation literal are persistent handler
state:

```txt
let counter = {
  let count = 0

  Counter {
    get: (!resume) => {
      !resume(count)
    },

    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },

    return: value => {
      { value, count }
    },
  }
}

let result = try run() with counter
```

`Counter { ... }` is an affine handler value because `Counter` names an effect,
not a data constructor. `try computation with handler` consumes that value. Use
a function returning a fresh implementation when the same definition must be
installed more than once.

The mandatory `return` clause handles ordinary completion. Operation clauses
receive the declared operation arguments followed by an affine resumption. A
clause may invoke its resumption once, return without invoking it to abort the
captured computation, pass it to other Ix code, or store it in an internal
aggregate or union. Calling a resumption reinstalls the captured handler
segment, so handlers are deep. The matched handler is inactive while its clause
runs; calling the same effect directly from that clause therefore forwards
outward.

Handlers may omit operations. An omitted operation searches the next outer
handler. Reaching the module boundary with an unresolved plain-effect operation
is a compile error; it never becomes host authority. Clause dependencies on host
effects remain in the surrounding operation row and require ordinary
`declare effect` resources.

Checked multi-shot use is explicit:

```txt
let (!left, !right) = dup !resume
```

Duplication is accepted only when every live capture is duplicable. Scalar state
is copied and frozen values are shared. Unique owners, borrows, scratch values,
host resources, and nested affine resumptions reject duplication. Once a clause
consumes or duplicates its resumption, that clause can post-process the resumed
output but cannot access the transferred handler state.

Handlers require the structured Core route; see [coverage.md](coverage.md).

## Ownership, Borrows, Freezing, And Scratchpads

The baseline backend targets ordinary structured Wasm plus linear memory. It
does not use GC, Wasm-GC, or managed fallback storage to repair uncertain
lifetimes. The compiler must prove ownership, borrow, scratch escape, promotion,
and cleanup facts before WAT emission; if a required fact is missing, the
baseline target rejects deterministically.

Runtime storage is classified with explicit facts:

```txt
scalar_local
unique_heap
borrow_view
frozen_shareable
scratch_backed
```

Scalar locals are copy values. Runtime heap values start as `unique_heap` owners
unless a more specific allocation fact applies. A unique heap value may be
moved, consumed, borrowed, frozen, returned, or dropped, but it is not
implicitly copied.

`&value` creates a non-owning read-only view tied to a lexical lifetime. A
stored view uses ordinary binding syntax.

```txt
let view = &user
```

The view cannot outlive its owner, cannot be returned or captured by an escaping
closure, and cannot be used for mutation. While a borrow is active, the borrowed
unique owner cannot be moved, mutated, consumed, or frozen. Borrow lifetimes are
bounded by blocks, loop iterations, calls, closure bodies, or scratchpad scopes.

`freeze value` consumes a unique value and produces immutable shareable storage.
Frozen values may be duplicated, returned, captured, and branch-merged. Mutation
through a frozen value is rejected. Freezing a scratch-backed value that escapes
must emit an explicit promotion/copy into non-scratch storage before the
scratchpad resets; the backend must not silently promote just because analysis
is uncertain.

`scratch { ... }` is the region-like construct. It is a lexical scratchpad for
temporary work, has a value result, and resets on every exit edge that leaves
the scratch lifetime: fallthrough, `return`, `break`, and `continue`.

```txt
let total = scratch {
  let message = "temporary"
  len(message)
}
```

A scratch result may escape only when it is scalar, already `frozen_shareable`,
explicitly promoted/frozen into non-scratch storage, or proven not to reference
scratch storage. Returning from `scratch { ... }` does not attach a live region
to the result. Attached-region values and named arenas are future explicit
features, not hidden fallback behavior for ordinary scratch returns.

Linear analysis applies only where storage or effects require it: source `!`
effect resources, `unique_heap` owners, active `borrow_view` barriers,
`scratch_backed` values, and closure-environment slots that contain those
values. Plain scalars and already-frozen values remain copy/share values.

## Loops And Recursion

`rec` is the semantic primitive for tail recursion. Recursive calls must be in
tail position.

```txt
let gcd = rec (a, b) => {
  if b == 0 {
    a
  } else {
    rec(b, a % b)
  }
}
```

Range loops iterate a half-open range with an optional step:

```txt
let sum = 0

for i in 0..4 {
  sum = sum + i
}

sum
```

A statically zero step is rejected; a dynamically zero step traps.

`loop` is an expression form for an unbounded structured loop. `break value`
returns a scalar result from the nearest `loop`, and every direct break value
must have the same source type. A loop whose direct exits all use a bare `break`
has type `Unit`; bare and valued exits cannot be mixed. Owned `Text`, `Bytes`,
aggregate, union, and closure loop results are not supported yet. `break` and
`continue` are control-flow statements, not general values. Declared host
operations and calls to ordinary effectful functions may occur in the body.

```txt
let first_even = loop {
  if candidate % 2 == 0 {
    break candidate
  } else {
    candidate = candidate + 1
    continue
  }
}
```

`for` remains statement-only. Its binders may be `_` when an index or element is
intentionally ignored. A range may omit binders entirely:

```txt
for _ in values {
  tick()
}

for 0..4 {
  work()
}
```

The wildcard binder is a no-demand binding: it does not introduce a usable local
and does not require the iterated value to be consumed by the body. `_` is
accepted for ordinary and const bindings, function parameters, record/module
destructuring, union payload patterns, and loop binders. It cannot be referenced
as an expression or marked linear as `!_`. Direct `_ <- Effect.operation()` can
discard scalar, frozen/shareable, or owned results; owned results still produce
an explicit cleanup edge. A non-scalar result from an indirect effectful
function call must still be bound until result ownership and cleanup rows can be
preserved safely after call inlining.

A fold is an ordinary function that accepts an initial accumulator and a step
function. It does not need a dedicated control-flow form; `for` remains the
simple statement form for repeated side effects or mutation.

```txt
let fold_range = (start, end, initial, const step) => {
  let state = initial

  for index in start..end {
    state = step(state, index)
  }

  state
}
```

Collection loops iterate aggregates and text:

```txt
const xs = {
  first: 10,
  second: 20
}

let sum = 0

for i, x in xs {
  sum = sum + xs[i]
}
```

`break` and `continue` are supported in static loops. `return` is treated as a
terminal function exit during static expansion, so unreachable later loop
statements are not inspected. Nested static loops keep inner `break` and
`continue` scoped to the inner loop, while inner `return` exits the function.
Loop bindings are read-only. Linear carried values must be valid on every loop
edge.

Which loop shapes expand statically, which lower to structured Wasm control
flow, and which remain reserved is tracked in [coverage.md](coverage.md).

## Indexing

Const-known aggregate indexing and typed runtime struct indexing support static
and runtime indexes.

```txt
const xs = {
  first: 10,
  second: 20
}

xs[0]
xs[i]
get(xs, i)
```

Runtime indexes trap on out-of-range values. Runtime indexing requires every
selectable slot to have a compatible value type (the homogeneous runtime-index
rule).

```txt
const pair_type = struct {
  first: Int,
  second: Int
}

let choose = (pair: pair_type, i) => {
  get(pair, i)
}
```

Pure struct update expressions rebuild the value. Index assignment over
frontend-known aggregates and typed runtime structs rebuilds the aggregate and
shadows the source name.

```txt
let xs = {
  first: 10,
  second: 20
}

xs[i] = 99
```

Static and frozen-shareable bindings are immutable; indexed assignment through
them rejects with a frozen/shareable binding diagnostic.

## Errors

`fail` is a compile-time error when executed during `comptime` or fact checking.

```txt
const has_len = t => {
  if !has(t.len) {
    fail("expected value with len")
  }

  t
}
```

`panic` is a runtime trap. It lowers to an Ic trap primitive in the scalar
backend and to WAT `unreachable` in the structured Core backend.

```txt
panic("index out of bounds")
```

Recoverable runtime errors use explicit unions.

```txt
const result_type = e => t => union {
  ok: t,
  err: e
}
```

## Lowering

The intended pipeline is:

```txt
Source
  -> Typed Core
  -> Const evaluation and specialization
  -> Structured Core
  -> Ownership, lifetime, escape, and cleanup elaboration
  -> Interaction Calculus IR
  -> Expr
  -> Mod
  -> WAT
  -> Wasm
```

Two routes are implemented today: a pure Ic route for scalar and
frontend-visible computation, and a structured Core route for statements, loops,
runtime memory, closures, handlers, and the ownership proof gate. The managed
JavaScript ABI wraps the Core route. Per-feature route coverage, including the
full supported and reserved feature lists, lives in [coverage.md](coverage.md).
