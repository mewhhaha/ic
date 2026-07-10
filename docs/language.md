# Source Language

This document is the normalized project specification for the source frontend
that lowers into the Interaction Calculus IR.

The language is a small effect-oriented value language. Runtime code and
compile-time code use the same expression syntax. Values are immutable, while
source names may be shadowed to provide imperative flow. Host effects are opaque
values passed through explicit module contexts, and the compiler infers
operation-level effect rows. Types are compile-time values, and protocol-like
abstractions are ordinary const fact checkers.

## Naming

Runtime bindings, const bindings, function parameters, loop binders, pattern
binders, linear-value references, type-values, type constructors, fact checkers,
protocol values, fields, methods, modules, and ordinary helper functions use
`snake_case`: a lowercase letter followed by lowercase letters, digits, or
underscores.

Declared host effects and host context records use type-style names such as `Io`
and `Init`. Function-local effect context holders use a short uppercase name
such as `Fx`. The holder name is local and has no built-in spelling.

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
import logger from "./logger.ix"
const { write } = logger({ io: !init.io })
```

Module invocation is compiler-time wiring and specialization. Its result is the
imported file's export record, so ordinary record destructuring selects exports.
The entry module's final record is returned by the managed JavaScript
`program.run(init)` call.

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
otherwise unknown, `=` preserves that context for later frontend Ic lowering.
For function values, `=` compares parameter shape as part of the type: arity,
`const`/`!` flags, and annotation shape must match, while parameter names do not
matter. Built-in integer annotation aliases such as `Int`, `I32`, and `U32` are
treated as the same `i32` parameter type. For structs with known field-type
facts, `=` also compares the declared field types, so a value with the same
field names but incompatible payload types is a type change. Anonymous object
literals expose shallow field-type facts when every field has a simple known
type such as `Int`, `I64`, or `Text`. Shorthand union cases such as `.ok(1)`
also expose payload facts when the payload has a simple known type, so
`.ok(Int)` and `.ok(Text)` are different types for `=` shadowing.

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

Bindings may have annotations. Built-in scalar/type annotations are checked
directly in both the frontend and the structured Core path. When the annotation
names a visible struct or union type-value, shorthand object and union-case
values are checked and given that direct type context in both paths. For typed
union annotations, declared case payload types also flow into shorthand object
payloads such as `.ok({ age: 40 })`. The structured Core path rejects other
binding annotations until it has a fact-checker execution model. Fact-checker
annotations are checked for const type-values and frontend-known aggregate
values in the frontend. In the frontend Ic path, explicit runtime binding
annotations can also provide scalar, text, struct, or union type context for
otherwise unknown runtime values, while known incompatible values still fail at
the binding.

The structured Core path also preserves closure parameter annotations and checks
built-in scalar/type parameter annotations when const/static calls are inlined.
When the parameter annotation names a visible struct or union type-value, the
same direct type context is applied at the static call boundary. This keeps
annotation failures at the call boundary instead of after parameter substitution
has erased the source parameter. In the frontend Ic path, an explicit runtime
parameter annotation can also provide type context for an otherwise unknown
runtime argument, while known incompatible argument types still fail at the call
site.

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

Integer literals carry value types in Ic. Unsuffixed source integers are the MVP
`Int`/`i32` convention. Explicit suffixes are available for scalar lowering.
When runtime bindings or parameters carry `I64` annotations, numeric primitive
lowering uses that type context to select the corresponding i64 operation even
if both operands are names rather than i64 literals. Chained arithmetic keeps
that context through parse-time-default intermediate primitives, while explicit
mixed `i32`/`i64` operands are rejected. Dynamic branches over annotated i64
arithmetic infer the i64 result type before Ic branch lowering.

```txt
let small = 42i32
let wide = 42i64
```

Visible text values can concatenate with `+` when both operands are
frontend-visible text literals, bindings, fields, indexes, const-call results,
simple block-local values, or dynamic text branches. This produces another
visible text value; it does not allocate arbitrary runtime strings in the
Ic/Expr path. The structured Core path preserves the same visible rule and emits
the concatenated visible text alternatives as length-prefixed UTF-8 data
pointers. It can also concatenate runtime values known to have type `Text` by
allocating a fresh length-prefixed UTF-8 text object from the runtime heap and
copying both byte ranges. A value known to have type `Text` cannot be used as a
numeric primitive operand; text concatenation must stay in either the visible
text subset or the structured Core runtime `Text` concat path. Other known
non-numeric values, such as structs, unions, functions, and type-values, are
also rejected before primitive Ic lowering.

Visible text equality and inequality fold to `i32` booleans. When one or both
operands are dynamic visible text branches, the pure Ic route lowers equality to
nested `i32.select` expressions over branch-local static comparisons. Runtime
`Text` equality that requires byte comparison still belongs to structured
Core/Wasm.

Text-valued `if let` expressions over statically known union cases and dynamic
union-if targets with visible branch payloads also preserve visible text facts
through bindings, so later `len`, indexing, equality, and slice-style operations
stay on the pure Ic path.

Inlineable unannotated helper calls that return visible text preserve those
facts as well. For example, helper-returned `append`, `slice`, text-producing
`if`, and visible text `if let` results can still feed later equality, `len`,
indexing, and nested visible text operations on the pure Ic path.

`slice(value, start, end)` over frontend-visible text folds when `start` and
`end` are compile-time `i32` values. If `value` is a dynamic visible text
branch, the slice is applied to each branch payload and the branch shape is
preserved. A bound visible slice result remains visible to later `len`,
indexing, equality, and nested visible operations. Runtime `Text` slices with
dynamic storage or offsets still belong to structured Core/Wasm.

`append(left, right)` is the named text append builtin. It follows the same
visible-text subset as `+`: literals, visible bindings, fields, indexes,
const-call results, simple block-local values, and dynamic visible branches fold
through the pure Ic path. A bound visible append result remains visible to later
`len`, indexing, equality, and slice operations. Runtime `Text` append still
belongs to structured Core/Wasm.

Text values are represented as `i32` pointers to length-prefixed UTF-8 data in
the current Ic/Expr/WAT path. `len(value)` over a runtime value known to have
type `Text` lowers to an `i32.load` from that pointer. Static indexes over
frontend-visible text values lower to `i32` UTF-8 bytes. Static indexes over
dynamic visible text branches lower branch-local out-of-range cases to
`i32.trap`, so only the selected short branch traps at runtime. In structured
`Core`, dynamic indexes over visible text values lower to Wasm control flow that
returns the selected UTF-8 byte and traps on out-of-range indexes. Runtime
values known to have type `Text` can also be byte-indexed in the Ic path with
either `value[index]` or `get(value, index)`; this lowers to an `i32.load8_u`
from `pointer + 4 + index`, where `pointer` addresses the length-prefixed text
object. The generated WAT guards the load with signed negative-index and length
checks, trapping on out-of-range indexes. Collection loops over frontend-visible
text values iterate UTF-8 bytes; the frontend can expand const-known text loops
to Ic, and structured `Core` can emit visible text loops as length-prefixed byte
loops.

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

Frontend call-site specialization preserves the closure environment captured at
binding time, including for annotated runtime parameters and literal-condition
static closure branches. The Core backend can inline known `let` and `const`
closures. Runtime scalar captures are snapshotted into hidden locals when the
closure value is bound, so later shadowing does not change the captured value.
Statement-bodied inline calls use hidden parameter and block-local names, so
closure-local assignment and shadowing do not clobber caller locals. First-class
scalar closures with annotated scalar parameters can also lower through
`Core.mod`: closure values are `i32` environment pointers, offset `0` stores a
function-table index, scalar captures and captured closure pointers are
snapshotted into subsequent slots, captured closure signatures are preserved for
later indirect calls, and calls use `call_indirect`. Selected first-class
closure branches can derive one-sided `Int`/`I32`, `I64`, and `Text` parameter
facts from the annotated branch; Core keeps `Text` parameter facts separate from
plain `i32`, so `Int` and `Text` branches are not silently unified. Same-type
assignment to a captured scalar name lowers as a per-call closure-local shadow
for both inlined static closures and first-class closure environments.
Sequential type-changing shadowing lowers to fresh Core locals before WAT
emission, including closure-local shadows. Inlineable static closures that
index-assign captured statically shaped aggregates clone those aggregate shapes
per call before rebuilding them. Captured runtime `Text` byte assignment and
captured runtime aggregate scalar/`Text`/union-pointer index assignment lower
through first-class closure environments, including inline nested aggregate
fields. General first-class linear closure captures remain reserved. The
frontend does support direct non-escaping local closure calls, including
parameterized calls, simple local aliases, simple block-local aliases/direct
block calls, literal-condition static closure branches, and dynamic ordinary
function branches, including simple aliases to known closures, that eta-expand
to scalar/text-pointer Ic selects when later applied, including `I64` bodies
whose primitive type is recovered from matching parameter or capture facts.
Dynamic union-if `if let` expressions whose branches return direct non-linear
closures with compatible parameter shapes use the same lambda-selection rules.
Matching scalar parameter annotations, one-sided annotations, and
alias-equivalent annotations such as `Int`/`I32` are preserved across selected
branches. Known incompatible arguments are rejected before Ic lowering, while
unknown runtime arguments can receive the selected branch parameter context.
Selected branch calls can also feed frontend-known struct or union consumers by
inlining back into ordinary dynamic `if` expressions. These paths can consume
outer linear values when linear use is valid along each enclosing control-flow
path. Dynamic `if let` expressions that produce unannotated union results carry
their inferred union-case table into later `=` shadowing checks.

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
typed scalar zero fallback in the current Ic subset, so an `I64` then-branch
gets `0i64` while an `Int` then-branch gets `0`. A condition must be an
`Int`/i32 value when the frontend can prove its type; known text, struct, union,
function, type-value, and `I64` conditions are rejected before Ic lowering.

In structured `Core`, statement-level dynamic `if ... else` branches can lower
to Wasm control flow when the branches update scalar locals. If both branches
assign the same static-shaped struct or visible text value, `Core` preserves
that static fact after the branch using the condition value captured before the
branch executes.

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

Logical operators are boolean `if` sugar.

```txt
ready && valid
ready || fallback
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

Runtime union matching where the case is not statically known is reserved for a
structured-core union representation unless the target has a direct typed union
annotation or is a direct or statically bound dynamic `if` whose branches
construct shorthand union cases. Directly typed pure union values lower to Ic
handler lambdas. A standalone shorthand union case also lowers as a one-case Ic
handler lambda when its payload type can be inferred locally, or when the
payload is an unknown runtime value passed through the selected handler. Dynamic
`if` expressions where both branches construct the same typed or locally
inferred shorthand union case lower as handler-encoded union values by selecting
that case payload. Dynamic `if` expressions over different typed or locally
inferred union cases lower as handler-encoded Ic values by selecting between
case-handler applications, including unknown runtime payloads. They also lower
when immediately consumed by an `if let` whose branches produce numeric or
text-pointer results, including when the dynamic union expression is produced by
a const-call result or an inlineable runtime closure call and consumed later by
a bound `if let`. Text payloads selected by these dynamic union branches retain
their text facts for operations such as `len(value)`, and explicitly named
struct payloads such as `user_type { ... }` or shorthand object payloads under
declared union-case context preserve their struct fields for annotated dynamic
union branches. Branches that produce typed or locally inferred union values
lower as handler-encoded union results, including direct targets, deferred
const-call results, and inlineable runtime closure-call results. Static-rec
result lowering can apply those bound handler-encoded union results through
direct, deferred const-call, and inlineable runtime closure-call targets.
Frontend-known object or typed-struct results lower field-by-field through the
same numeric/text-pointer `if let` path, either as a projected field or as an Ic
handler-encoded aggregate value, including when the aggregate expression is a
simple const-call result. In structured `Core`, `if let` statements over literal
or statically bound shorthand and typed-constructor union-case targets emit by
selecting the matching body at compile time and binding the payload locally.
`Core` also emits `if let` expressions and statements whose target is a direct
dynamic `if` with shorthand or typed-constructor union-case branches, or a
simple const-call result that statically inlines to that shape, choosing the
matching branch at Wasm control-flow level without materializing a runtime union
value. Named struct payloads stay as branch-local static aggregate facts in Core
so field access can scalarize inside the selected branch. When a typed Core
union value itself must be emitted, Core materializes direct typed union
constructors and direct dynamic `if` branches over typed numeric, `Text`,
`Unit`, or static-shaped struct union cases as heap values: an `i32` tag at
offset `0`, followed by scalar/text-pointer payload slots or packed struct field
slots. This runtime union object path currently covers `Int`, `I32`, `U32`,
`I64`, `Text`, `Unit`, and static-shaped struct payloads whose leaves are scalar
or `Text`. Core preserves typed union-pointer facts on annotated runtime
bindings and first-class closure-call results, so `if let` over those stored
pointers lowers to Wasm tag loads plus scalar/text-pointer or struct-field
payload loads from the materialized object.

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

The structured Core path validates visible `struct { ... }` and `union { ... }`
type-check patterns against compile-time type-values before eliding those
statements from generated WAT. Simple `const` aliases to visible struct or union
type-values are preserved in Core static analysis. Simple `const` aliases to
builtin type names can also be used inside Core-visible struct fields, union
payloads, and destructuring patterns. Simple const type-constructor calls that
return struct or union type-values, including curried calls like
`result_type(Text)(Int)`, are instantiated before Core type checks and WAT
emission. In the frontend, type aliases used inside struct fields, union
payloads, and destructuring patterns preserve their binding-time environment, so
later shadowing does not change the resolved type. Non-final frontend expression
statements proven to be compile-time-only, including type-values and `with`
extension expressions, are validated as const expressions and then elided before
Ic lowering.

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
  print: (bounded_borrow Text) => Unit
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

An uppercase context holder marks an effectful function. Its name is arbitrary;
`Fx` is only the convention used in examples:

```txt
let Fx read_name = () => {
  let (!Fx, name) = Fx.read()
  name
}
```

The compiler infers the holder's minimal structural operation row. A function
without a holder is pure. An explicit annotation gives an upper bound, so every
inferred operation must belong to the annotation:

```txt
let (Fx :: { Io.read, Io.print }) greet = () => {
  let (!Fx, name) = Fx.read()
  let (!Fx, ()) = Fx.print(borrow name)
  name
}
```

Primitive effect operations consume and renew the holder's linear proof token,
which is why their result is bound with `let (!Fx, value) = ...`. A `Unit`
result uses `let (!Fx, ()) = ...`. Compatible contexts are forwarded lexically
through ordinary calls, including recursion and higher-order calls, so callers
do not manually thread `Fx` through their parameter lists.

Rows propagate through branches, callbacks, closures, module initialization, and
exported function types. Capturing a context or linear host resource makes the
closure one-shot under the normal linear closure rules. The compiler rejects
effectful calls from pure functions, operations outside an annotation, missing
token rebinding, incompatible branch rows, effect-resource duplication, and
authority hidden inside a reusable closure.

One holder may contain multiple effect resources. `Fx.read()` selects an
operation when its name is unique. When operation names collide, qualify the
effect explicitly, for example `Fx.Io.read()`. If multiple instances of the same
effect type are available, the module must narrow its context before an
unqualified operation can select an instance.

Imported modules receive only the explicitly passed subset of the caller's
context:

```txt
module (!init: Init) where

import logger from "./logger.ix"
const { write } = logger({ io: !init.io })
let result = write("hello")

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
not a data constructor. `try computation with handler` consumes that value.
Use a function returning a fresh implementation when the same definition must
be installed more than once.

The mandatory `return` clause handles ordinary completion. Operation clauses
receive the declared operation arguments followed by an affine resumption. A
clause may invoke its resumption once, return without invoking it to abort the
captured computation, pass it to other Ix code, or store it in an internal
aggregate or union. Calling a resumption reinstalls the captured handler segment,
so handlers are deep. The matched handler is inactive while its clause runs;
calling the same effect directly from that clause therefore forwards outward.

Handlers may omit operations. An omitted operation searches the next outer
handler. Reaching the module boundary with an unresolved plain-effect operation
is a compile error; it never becomes host authority. Clause dependencies on
host effects remain in the surrounding operation row and require ordinary
`declare effect` resources.

Checked multi-shot use is explicit:

```txt
let (!left, !right) = dup !resume
```

Duplication is accepted only when every live capture is duplicable. Scalar
state is copied and frozen values are shared. Unique owners, borrows, scratch
values, host resources, and nested affine resumptions reject duplication. Once
a clause consumes or duplicates its resumption, that clause can post-process
the resumed output but cannot access the transferred handler state.

Ix handlers compile only through the Core/managed-Wasm route. The IC-only route
rejects plain effects, handlers, resumptions, and Unit handler syntax explicitly.

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

`borrow value` creates a non-owning read-only view tied to a lexical lifetime. A
stored view uses ordinary binding syntax.

```txt
let view = borrow user
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

`scratch { ... }` is the MVP region-like construct. It is a lexical scratchpad
for temporary work, has a value result, and resets on every exit edge that
leaves the scratch lifetime: fallthrough, `return`, `break`, and `continue`.

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
features, not hidden fallback behavior for ordinary scratch returns. Scalarized
static-shaped aggregate results may leave a scratchpad when every returned field
is scalar, static/frozen data, or otherwise proven scratch-free. Static union
cases and dynamic static-union `if` results may also leave when the condition
and case payloads are scratch-free. Heap-backed aggregate, text, union, or
closure values still require explicit promotion/freeze or reject before WAT
emission.

Cleanup is elaborated from facts before WAT emission. Scratch cleanup emits real
pointer resets. Unique heap drops emit `__free` calls into the reusable
free-list allocator, and their allocation/layout links keep that runtime action
explicit in the proof. Temporaries introduced during lowering follow the same
storage, lifetime, and cleanup rules as source values.

Linear analysis applies only where storage or effects require it: source `!`
effect resources, `unique_heap` owners, active `borrow_view` barriers,
`scratch_backed` values, and closure-environment slots that contain those
values. Plain scalars and already-frozen values remain copy/share values.

## Loops And Recursion

`rec` is the semantic primitive for tail recursion. Recursive calls must be in
tail position. The current frontend statically unrolls compile-time reducible
recursive calls, including bodies with static loops, frontend-known aggregate
index assignment, compile-time-known const parameters, and explicit runtime type
context for annotated `Text`, struct, and union rec parameters or rec-local
bindings. Static-rec result lowering preserves that text context for `len`, byte
indexing, and `get`, and preserves struct context for field projection,
indexing, `get`, dynamic struct `if` result/projection/index lowering, and
dynamic index-assignment rebuilds. It also preserves scalar and text context for
dynamic `if` results, statement-level dynamic `if`/`if let` fallthrough, and
union context for dynamic union `if` targets consumed by `if let`. The
structured `Core` emitter can lower scalar dynamic tail-recursive calls to Wasm
`block`/`loop` control flow by carrying recursive parameters as locals.

```txt
let gcd = rec (a, b) => {
  if b == 0 {
    a
  } else {
    rec(b, a % b)
  }
}
```

Range loops with compile-time-known bounds lower to Ic by static expansion.
Simple dynamic `if` or `if let` statements whose body is exactly `break` or
`continue` lower through synthesized active/step flags, so the expanded Ic
preserves runtime loop-control choices. More complex dynamic loop-control bodies
remain reserved. Dynamic range loops can be preserved in the `Core` structured
representation with start, end, step, body, and carried-variable facts. The
minimal `Core` emitter can generate Wasm control flow for scalar `i32` range
loops, evaluating start, end, and step once, rejecting statically zero steps,
trapping dynamically zero steps, and supporting local carried assignments,
no-else `if`, `break`, and `continue`. Statement-level dynamic `if ... else`
branches with scalar local assignments, compatible static-shaped struct
assignments, and visible text assignments also lower to structured Wasm
`if`/`else` control flow.

```txt
let sum = 0

for i in 0..4 {
  sum = sum + i
}

sum
```

Collection loops are supported over const-known aggregate values and typed
runtime structs. Frontend-visible text values are also iterable as UTF-8 bytes.
When a closure field-selects, indexes, updates, calls `len`/`get`, or iterates
one of its parameters, visible aggregate or concrete visible `Text` arguments
can specialize the call before Ic expansion. The structured `Core` emitter can
unroll collection loops whose collection is a literal object/struct value, a
statically bound object/struct shape, or a dynamic `if` between compatible
statically shaped object/struct values, including when that dynamic shape is
produced by a simple const-call result, with `break` and `continue` edges.
Static-call block bodies can declare local carried values and contain those
collection loops after inlining. The `Core` emitter can also lower visible text
and runtime values known to have type `Text` to Wasm `block`/`loop` control flow
over the length-prefixed UTF-8 bytes. Runtime aggregate pointers with known
struct layout expose collection facts for homogeneous fields, including nested
aggregate fields such as `user.scores` when the nested inline struct fields are
homogeneous scalar values. Borrowing a non-scalar item from an aggregate-backed
collection keeps the borrow tied to the source aggregate owner, so mutating the
owner while the view is live is rejected.

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
statements are not inspected. Nested static loops are flattened during static
expansion: inner `break` and `continue` remain scoped to the inner loop, while
inner `return` exits the function. Statically decidable nested `if` statements
and statically known matching/non-matching `if let` statements inside static
loops can also carry `break`, `continue`, or `return`, including conditions that
depend on the statically bound loop index or payload. Dynamic conditional
`break` or `continue` inside Ic-expanded static loops is rejected explicitly.
Loop bindings are read-only. Linear carried values must be valid on every loop
edge.

Unknown runtime collection codegen and general dynamic structured-loop codegen
are reserved for broader structured-core coverage.

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

Runtime indexes over const-known aggregates and typed runtime structs lower to
Ic `select` chains with a trap fallback for out-of-range values. Declared typed
struct fields select as `i32`, `i64`, or homogeneous `Text` data pointers even
when the field payloads are runtime values. Homogeneous visible `Text` fields
also select as `i32` data pointers, and `len` over such dynamic text indexes
selects the corresponding UTF-8 byte length. Static indexes over visible text
values return UTF-8 bytes; byte indexes and `get(text, index)` over dynamic
visible text indexes select the corresponding byte with trap fallbacks. Static
field and index access over typed runtime structs lower through the same handler
encoding used for typed struct values. The structured `Core` emitter can
scalarize field access, static/dynamic index access, `len`, and `get` through
statically bound object/struct shapes before broader aggregate memory
representation exists. It can also emit static and dynamic byte indexes and
`get(text, index)` over visible text values with out-of-range traps.

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
shadows the source name. Declared numeric typed-struct fields preserve the
existing integer width even when the stored payloads are runtime values.
Declared or homogeneous visible `Text` fields rebuild through data-pointer
selections.

```txt
let xs = {
  first: 10,
  second: 20
}

xs[i] = 99
```

Unknown runtime collection loops, unknown index expressions, and unknown index
assignments can be preserved in `Core`. The structured `Core` emitter can apply
static and dynamic index assignments to statically bound object/struct shapes,
capturing runtime index and value expressions in hidden locals as needed. It can
also preserve visible `Text` update values through dynamic index assignment and
rebuild static-shaped struct update expressions while preserving the original
aggregate value. Inlineable static closure calls clone captured static aggregate
shapes and static aggregate arguments before applying index-assignment rebuilds.
For runtime locals known to have type `Text`, `Core.emit` lowers byte index
assignment to a bounds-checked `i32.store8` into the length-prefixed text
buffer, including captured runtime `Text` locals inside first-class closure
environments. Fact-directed lowering for unknown runtime collections and general
memory-backed collection mutation remains reserved for memory/codegen work.
Static and frozen-shareable text bindings are immutable; indexed assignment
through them rejects before WAT emission. Static-shaped aggregate bindings
created through `freeze { ... }` are also immutable compiler facts in the
current scalarized path; indexing mutation through them rejects with the same
frozen/shareable binding diagnostic. On the pure Ic route, `borrow`, `freeze`,
and `scratch` erase around scalar values, statically visible/shareable text,
frontend-known struct/union handler values, and pure closure values. Those
wrapper expressions preserve their frontend-known type for `=` shadowing checks,
so accidental type changes still reject. Unknown owners, runtime text, and
ownership-bearing heap values still require structured Core so borrow, freeze,
scratch escape, and cleanup facts are available before WAT emission. Immediate
scalar text reads are the narrow exception: `len`, `get`, and byte indexing may
recursively erase `borrow`, `freeze`, or `scratch` around an annotated runtime
`Text` value because the wrapped value does not escape the read.

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

The current implemented path lowers pure scalar computation directly through the
frontend into Ic, then into Expr, Mod, and WAT.

The `Mod` layer can also emit Wasm function imports, export imported functions,
define a single Wasm memory, export it, and emit active data segments. Declared
host effects lower to ordinary Wasm imports and opaque `i32` registry handles;
effect rows and renewed proof tokens have no runtime representation. The
explicit low-level source ABI declaration remains available:

```txt
host_import host_read from "env.read" (bounded_borrow Text) => I32
```

The implemented source slice supports scalar numeric ABI parameters/results,
`bounded_borrow Text`, `ownership_transfer Text`, `frozen_shareable Text`, and
host-returned `unique_heap Text` or `frozen_shareable Text`. These declarations
are available on the structured `Source.core`, `Source.mod`, and `Source.wat`
routes. Pure Ic lowering rejects them because host imports require the
structured Core/Wasm boundary checks. Effect resources are still represented as
explicit module dependencies, not ambient Wasm authority.

Supported Ic-lowerable scalar features include:

```txt
i32 and i64 arithmetic
comparisons
dynamic select
trap
Core panic to WAT unreachable
capture-free closures without const parameters
dynamic ordinary function branches with scalar/text/struct/union Ic consumers
fresh-name shadowing
explicit Ic sharing for repeated runtime bindings, parameters, and free names
known-case union payload extraction
binding-time payload capture for bound union cases
known union cases through frontend-known fields/static indexes
simple block-local frontend-known text values in visible text operations
simple block-local frontend-known struct and union values
simple const block union values and type-values
simple block-local dynamic union-if values consumed by `if let`
const specialization
const-known aggregate projection/indexing
typed runtime struct projection/indexing with runtime scalar/text payloads
static-rec dynamic scalar/text `if` result lowering
static-rec dynamic struct `if` result/projection/index lowering
static-rec statement-level dynamic `if` fallthrough
static-rec statement-level dynamic `if let` fallthrough
static-rec dynamic union `if let` result handler application
frontend-known aggregate index assignment by rebuild
dynamic typed struct `if` by field selection
dynamic frontend-known object `if` by field selection
same-case dynamic typed union `if` by payload selection
same-case shorthand dynamic union `if` as handler-encoded values
standalone inferred shorthand union cases as one-case Ic handler lambdas
unknown runtime payloads in inferred shorthand union handler values
different-case dynamic union `if` as handler-encoded Ic values
declared union-case struct payload context for shorthand object values
Ic primitive superposition propagation including unary memory loads
Ic dynamic select retagging for i64 handler-application results
different-case dynamic typed union `if` consumed by numeric/text-pointer `if let`
dynamic union `if let` producing handler-encoded union results
deferred const-call dynamic union results consumed by `if let`
inlineable runtime closure-call dynamic union results consumed by `if let`
function-valued dynamic union-if `if let` over direct non-linear closures
typed dynamic union `if let` with text-pointer results
frontend-known object/typed struct `if let` by field-wise Ic value lowering
annotated unknown runtime bindings and arguments through scalar/text/struct/union
Ic paths
known runtime text/struct/union type facts through unannotated helper calls
pure explicit function calls over linear values
declared host-effect calls with inferred operation rows
typed struct values as Ic handler lambdas
frontend-known object values as Ic handler lambdas
text literals as length-prefixed UTF-8 data pointers
visible text concatenation
static visible text byte indexing
visible aggregate and concrete visible `Text` arguments specialized into
closures that field-select, index, update, call `len`/`get`, or iterate their
parameters
Core text literals as length-prefixed UTF-8 data pointers
Core visible text concatenation as length-prefixed UTF-8 data pointers
Core runtime `Text` concatenation as heap-allocated length-prefixed UTF-8 text
Core static and dynamic visible text byte indexing
Core visible text `get` as UTF-8 byte indexing
frontend-visible text collection loops as UTF-8 byte expansion
Core visible text collection loops as length-prefixed UTF-8 byte loops
Core runtime `Text` length, byte indexing, `get`, and collection loops
dynamic indexing over visible text fields as data-pointer selects
typed runtime struct index assignment over runtime scalar/text payloads
Core dynamic indexed visible text concatenation as data-pointer selects
dynamic indexed visible text `len` as byte-length selects
Core dynamic indexed visible text `len` as byte-length selects
runtime `Text` `len` as length-prefix load
dynamic union `Text` payload `len` through Ic text-pointer selection
dynamic union named-struct payload field access through Ic handler selection
Core dynamic union named-struct payload field access through branch-local static facts
runtime `Text` byte indexing and `get` as bounds-checked length-prefix content loads
Core dynamic same-shape collection-loop unrolling
Core static-call block-local collection-loop unrolling
Core inline closure-local parameter assignment and caller-safe local shadowing
Core first-class scalar closure storage through env pointers, function tables,
captured closure pointers, closures returned from scoped static calls, and
`call_indirect`
Core dynamic tail recursion as structured loops
Source-level annotated dynamic tail recursion through `Source.wat`
Core static aggregate field/index/len/get access, collection-loop unrolling, and
runtime field/payload capture
Core static-shaped struct updates by rebuild
Core captured static aggregate index assignment by rebuild
Core statement-level dynamic `if ... else` scalar/static-shaped assignment
branches
Core const-call dynamic union results consumed by `if let`
Core typed scalar/Text/Unit/static-struct union value materialization as heap
tag plus payload slots
Core stored scalar/Text/Unit/static-struct union pointer `if let` matching by
tag/payload loads
frontend direct non-escaping local/aliased/simple-block/static-branch linear
closure captures
dynamic text `if` by data-pointer selection
`len` over frontend-visible text values and dynamic text branches
frontend visible text byte indexing and `get` over dynamic visible text indexes
```

Reserved for structured core and Wasm-oriented IR:

```txt
dynamic structured loops
runtime union payload storage/matching beyond scalar, Text, Unit, and
static-shaped structs with scalar/Text leaves
unknown dynamic `if let` outside typed, direct union-if, typed direct/simple
block helper-return, typed inlineable helper-call branch union-result, or
inlineable closure-call union-result shapes
unknown runtime collections
memory-backed index assignment beyond runtime Text bytes and runtime aggregate
scalar/Text/union-pointer/inline nested fields
general first-class linear closure captures
frontend aggregate memory/codegen representation
unknown runtime text/string operations outside the supported visible
literal/concat/data-pointer cases and runtime `Text` length, byte-load, `get`,
byte assignment, collection-loop, and Core runtime concat subset
asynchronous host effects without an explicit portable task/poll protocol
general memory-backed collection index mutation
excluded keyword families such as classes, traits, macros, instance search,
inheritance, and generic constraint clauses
```
