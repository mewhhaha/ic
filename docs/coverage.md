# Implementation Coverage

This document is the companion to [language.md](language.md). The language
contract — syntax and the semantics a program can rely on — lives there.
Everything here is implementation status: which source shapes each backend route
accepts today. This file is expected to churn as coverage broadens; the spec is
not.

## Routes

Two lowering routes are implemented, plus a managed ABI on top of the second:

- The **pure Ic route** (`Source.ic_wat`) lowers the frontend directly into
  Interaction Calculus, then `Expr`, `Mod`, and WAT. It covers scalar
  computation and a frontend-visible value subset (visible text, frontend-known
  structs/unions encoded as handler lambdas). It supports open terms such as
  `input + 1`. Before module emission, its no-GC proof accepts only scalar
  locals and frozen static data; memory loads whose address cannot be traced to
  static data reject before WAT generation.
- The **structured Core route** (`Source.core`, `Source.mod`, `Source.wat`)
  lowers source into a typed structured representation and emits Wasm control
  flow directly. It covers statements, dynamic loops, runtime text, runtime
  aggregates, first-class closures, Ix-defined handlers, and the
  ownership/lifetime proof gate.
- The **managed ABI** (`Source.artifact`, `IxRunner`, `IxHost`) wraps the Core
  route with the `ix-js-2` manifest and JavaScript marshaling for host effects.

A feature can be accepted on one route and reserved on the other. The examples
manifest (`examples/manifest.ts`) records which route each example compiles
through.

## Bindings And Annotations

Built-in scalar/type annotations are checked directly in both the frontend and
the structured Core path. When the annotation names a visible struct or union
type-value, shorthand object and union-case values are checked and given that
direct type context in both paths. For typed union annotations, declared case
payload types also flow into shorthand object payloads such as
`.ok({ age: 40 })`. The structured Core path rejects other binding annotations
until it has a fact-checker execution model. Fact-checker annotations are
checked for const type-values and frontend-known aggregate values in the
frontend. In the frontend Ic path, explicit runtime binding annotations can also
provide scalar, text, struct, or union type context for otherwise unknown
runtime values, while known incompatible values still fail at the binding.

The structured Core path also preserves closure parameter annotations and checks
built-in scalar/type parameter annotations when const/static calls are inlined.
When the parameter annotation names a visible struct or union type-value, the
same direct type context is applied at the static call boundary. This keeps
annotation failures at the call boundary instead of after parameter substitution
has erased the source parameter. In the frontend Ic path, an explicit runtime
parameter annotation can also provide type context for an otherwise unknown
runtime argument, while known incompatible argument types still fail at the call
site.

When runtime bindings or parameters carry `I64` annotations, numeric primitive
lowering uses that type context to select the corresponding i64 operation even
if both operands are names rather than i64 literals. Chained arithmetic keeps
that context through parse-time-default intermediate primitives, while explicit
mixed `i32`/`i64` operands are rejected. Dynamic branches over annotated i64
arithmetic infer the i64 result type before Ic branch lowering.

## Text

Visible text values can concatenate with `+` when both operands are
frontend-visible text literals, bindings, fields, indexes, const-call results,
simple block-local values, or dynamic text branches. This produces another
visible text value; it does not allocate arbitrary runtime strings in the
Ic/Expr path. The structured Core path preserves the same visible rule and emits
the concatenated visible text alternatives as length-prefixed UTF-8 data
pointers. It can also concatenate runtime values known to have type `Text` by
allocating a fresh length-prefixed UTF-8 text object from the runtime heap and
copying both byte ranges. Text concatenation must stay in either the visible
text subset or the structured Core runtime `Text` concat path.

Visible text equality and inequality fold to semantic `Bool` values, represented
as `i32` after frontend lowering. When one or both operands are dynamic visible
text branches, the pure Ic route lowers equality to nested `i32.select`
expressions over branch-local static comparisons. Runtime `Text` equality that
requires byte comparison lowers through structured Core/Wasm.

Text-valued `if let` expressions over statically known union cases and dynamic
union-if targets with visible branch payloads preserve visible text facts
through bindings, so later `len`, indexing, equality, and slice-style operations
stay on the pure Ic path. Inlineable unannotated helper calls that return
visible text preserve those facts as well: helper-returned `append`, `slice`,
text-producing `if`, and visible text `if let` results can still feed later
equality, `len`, indexing, and nested visible text operations on the pure Ic
path.

`slice(value, start, end)` over frontend-visible text folds when `start` and
`end` are compile-time `i32` values. If `value` is a dynamic visible text
branch, the slice is applied to each branch payload and the branch shape is
preserved. A bound visible slice result remains visible to later `len`,
indexing, equality, and nested visible operations. Runtime `Text` slices with
dynamic storage or offsets belong to structured Core/Wasm. `append(left,
right)`
follows the same visible-text subset as `+`; runtime `Text` append belongs to
structured Core/Wasm.

Text values are represented as `i32` pointers to length-prefixed UTF-8 data in
the current Ic/Expr/WAT path. `len(value)` over a runtime value known to have
type `Text` lowers to an `i32.load` from that pointer. Static indexes over
frontend-visible text values lower to `i32` UTF-8 bytes. Static indexes over
dynamic visible text branches lower branch-local out-of-range cases to
`i32.trap`, so only the selected short branch traps at runtime. In structured
Core, dynamic indexes over visible text values lower to Wasm control flow that
returns the selected UTF-8 byte and traps on out-of-range indexes. Runtime
values known to have type `Text` can also be byte-indexed in the Ic path with
either `value[index]` or `get(value, index)`; this lowers to an `i32.load8_u`
from `pointer + 4 + index`, where `pointer` addresses the length-prefixed text
object. The generated WAT guards the load with signed negative-index and length
checks, trapping on out-of-range indexes. Collection loops over frontend-visible
text values iterate UTF-8 bytes; the frontend can expand const-known text loops
to Ic, and structured Core can emit visible text loops as length-prefixed byte
loops.

## Closures And Calls

Frontend call-site specialization preserves the closure environment captured at
binding time, including for annotated runtime parameters and literal-condition
static closure branches. The Core backend can inline known `let` and `const`
closures. Statement-bodied inline calls use hidden parameter and block-local
names, so closure-local assignment and shadowing do not clobber caller locals.

First-class scalar closures with annotated scalar parameters can lower through
`Core.mod`: closure values are `i32` environment pointers, offset `0` stores a
function-table index, scalar or frozen/shareable captures are stored in
subsequent slots, captured closure signatures are preserved for later indirect
calls, and calls use `call_indirect`. Unfrozen unique aggregate, union, text,
and closure-pointer captures require the one-shot linear path or reject before
WAT. Selected first-class closure branches can derive one-sided `Int`/`I32`,
`I64`, and `Text` parameter facts from the annotated branch; Core keeps `Text`
parameter facts separate from plain `i32`, so `Int` and `Text` branches are not
silently unified. Same-type assignment to a captured scalar name lowers as a
per-call closure-local shadow for both inlined static closures and first-class
closure environments. Sequential type-changing shadowing lowers to fresh Core
locals before WAT emission, including closure-local shadows. Inlineable static
closures that index-assign captured statically shaped aggregates clone those
aggregate shapes per call before rebuilding them. Mutation through an unfrozen
unique runtime `Text` or runtime aggregate capture is rejected because a
reusable closure cannot safely snapshot that owner. Frozen captures remain
read-only; supported source-linear captures move into a one-shot environment.
Broader first-class linear closure captures remain reserved.

The frontend supports direct non-escaping local closure calls, including
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

Creating an anonymous closure is pure; invoking it introduces its inferred
latent effect row. The current runtime vertical slice specializes statically
known `const` callbacks; general escaping Ix-effect closures remain reserved
until CPS closure conversion supports them.

## Branches And Unions

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
simple const-call result.

In structured Core, `if let` statements over literal or statically bound
shorthand and typed-constructor union-case targets emit by selecting the
matching body at compile time and binding the payload locally. Core also emits
`if let` expressions and statements whose target is a direct dynamic `if` with
shorthand or typed-constructor union-case branches, or a simple const-call
result that statically inlines to that shape, choosing the matching branch at
Wasm control-flow level without materializing a runtime union value. Named
struct payloads stay as branch-local static aggregate facts in Core so field
access can scalarize inside the selected branch. When a typed Core union value
itself must be emitted, Core materializes direct typed union constructors and
direct dynamic `if` branches over typed numeric, `Text`, `Unit`, or
static-shaped struct union cases as heap values: an `i32` tag at offset `0`,
followed by scalar/text-pointer payload slots or packed struct field slots. This
runtime union object path currently covers `Int`, `I32`, `U32`, `I64`, `Text`,
`Unit`, and static-shaped struct payloads whose leaves are scalar or `Text`.
Core preserves typed union-pointer facts on annotated runtime bindings and
first-class closure-call results, so `if let` over those stored pointers lowers
to Wasm tag loads plus scalar/text-pointer or struct-field payload loads from
the materialized object.

In structured Core, statement-level dynamic `if ... else` branches can lower to
Wasm control flow when the branches update scalar locals. If both branches
assign the same static-shaped struct or visible text value, Core preserves that
static fact after the branch using the condition value captured before the
branch executes.

## Structs, Facts, And Indexing

The structured Core path validates visible `struct { ... }` and `union { ... }`
type-check patterns against compile-time type-values before eliding those
statements from generated WAT. Simple `const` aliases to visible struct or union
type-values are preserved in Core static analysis. Simple `const` aliases to
builtin type names can also be used inside Core-visible struct fields, union
payloads, and destructuring patterns. Simple const type-constructor calls that
return struct or union type-values, including curried calls like
`result_type(Text)(Int)`, are instantiated before Core type checks and WAT
emission. Non-final frontend expression statements proven to be
compile-time-only, including type-values and `with` extension expressions, are
validated as const expressions and then elided before Ic lowering.

Runtime indexes over const-known aggregates and typed runtime structs lower to
Ic `select` chains with a trap fallback for out-of-range values. Declared typed
struct fields select as `i32`, `i64`, or homogeneous `Text` data pointers even
when the field payloads are runtime values. Homogeneous visible `Text` fields
also select as `i32` data pointers, and `len` over such dynamic text indexes
selects the corresponding UTF-8 byte length. Static field and index access over
typed runtime structs lower through the same handler encoding used for typed
struct values. The structured Core emitter can scalarize field access,
static/dynamic index access, `len`, and `get` through statically bound
object/struct shapes before broader aggregate memory representation exists. It
can also emit static and dynamic byte indexes and `get(text, index)` over
visible text values with out-of-range traps.

Index assignment over frontend-known aggregates and typed runtime structs
rebuilds the aggregate and shadows the source name. Declared numeric
typed-struct fields preserve the existing integer width even when the stored
payloads are runtime values. Declared or homogeneous visible `Text` fields
rebuild through data-pointer selections. Unknown runtime collection loops,
unknown index expressions, and unknown index assignments can be preserved in
Core. The structured Core emitter can apply static and dynamic index assignments
to statically bound object/struct shapes, capturing runtime index and value
expressions in hidden locals as needed. It can also preserve visible `Text`
update values through dynamic index assignment and rebuild static-shaped struct
update expressions while preserving the original aggregate value. Inlineable
static closure calls clone captured static aggregate shapes and static aggregate
arguments before applying index-assignment rebuilds. For directly owned runtime
locals known to have type `Text`, `Core.emit` lowers byte index assignment to a
bounds-checked `i32.store8` into the length-prefixed text buffer. A reusable
closure cannot capture that unfrozen unique buffer for mutation; it must use a
supported one-shot move or reject. Fact-directed lowering for unknown runtime
collections and general memory-backed collection mutation remains reserved for
memory/codegen work.

## Loops And Recursion

The current frontend statically unrolls compile-time reducible recursive calls,
including bodies with static loops, frontend-known aggregate index assignment,
compile-time-known const parameters, and explicit runtime type context for
annotated `Text`, struct, and union rec parameters or rec-local bindings.
Static-rec result lowering preserves that text context for `len`, byte indexing,
and `get`, and preserves struct context for field projection, indexing, `get`,
dynamic struct `if` result/projection/index lowering, and dynamic
index-assignment rebuilds. It also preserves scalar and text context for dynamic
`if` results, statement-level dynamic `if`/`if let` fallthrough, and union
context for dynamic union `if` targets consumed by `if let`. The structured Core
emitter can lower scalar dynamic tail-recursive calls to Wasm `block`/`loop`
control flow by carrying recursive parameters as locals.

Range loops with compile-time-known bounds lower to Ic by static expansion.
Simple dynamic `if` or `if let` statements whose body is exactly `break` or
`continue` lower through synthesized active/step flags, so the expanded Ic
preserves runtime loop-control choices. More complex dynamic loop-control bodies
remain reserved. Dynamic range loops can be preserved in the Core structured
representation with start, end, step, body, and carried-variable facts. The
minimal Core emitter can generate Wasm control flow for scalar `i32` range
loops, evaluating start, end, and step once, rejecting statically zero steps,
trapping dynamically zero steps, and supporting local carried assignments,
no-else `if`, `break`, and `continue`. Statement-level dynamic `if ... else`
branches with scalar local assignments, compatible static-shaped struct
assignments, and visible text assignments also lower to structured Wasm
`if`/`else` control flow.

Collection loops are supported over const-known aggregate values and typed
runtime structs. Frontend-visible text values are also iterable as UTF-8 bytes.
When a closure field-selects, indexes, updates, calls `len`/`get`, or iterates
one of its parameters, visible aggregate or concrete visible `Text` arguments
can specialize the call before Ic expansion. The structured Core emitter can
unroll collection loops whose collection is a literal object/struct value, a
statically bound object/struct shape, or a dynamic `if` between compatible
statically shaped object/struct values, including when that dynamic shape is
produced by a simple const-call result, with `break` and `continue` edges.
Static-call block bodies can declare local carried values and contain those
collection loops after inlining. The Core emitter can also lower visible text
and runtime values known to have type `Text` to Wasm `block`/`loop` control flow
over the length-prefixed UTF-8 bytes. Runtime aggregate pointers with known
struct layout expose collection facts for homogeneous fields, including nested
aggregate fields such as `user.scores` when the nested inline struct fields are
homogeneous scalar values. Borrowing a non-scalar item from an aggregate-backed
collection keeps the borrow tied to the source aggregate owner and the current
loop iteration. Bounded reads inside that iteration are accepted; assigning the
view to an outer binding rejects before WAT emission, and mutating the owner
while any valid view is live is also rejected.

Dynamic conditional `break` or `continue` inside Ic-expanded static loops is
rejected explicitly. Unknown runtime collection codegen and general dynamic
structured-loop codegen are reserved for broader structured-core coverage.
Locally handled effects inside a runtime loop remain reserved until the handler
pass can lower recursive CPS control flow.

## Ownership Wrappers

On the pure Ic route, `&`, `freeze`, and `scratch` erase around scalar values,
statically visible/shareable text, frontend-known struct/union handler values,
and pure closure values. Those wrapper expressions preserve their frontend-known
type for `=` shadowing checks, so accidental type changes still reject. Unknown
owners, runtime text, and ownership-bearing heap values require structured Core
so borrow, freeze, scratch escape, and cleanup facts are available before WAT
emission. Immediate scalar text reads are the narrow exception: `len`, `get`,
and byte indexing may recursively erase `&`, `freeze`, or `scratch` around an
annotated runtime `Text` value because the wrapped value does not escape the
read.

Static and frozen-shareable text bindings are immutable; indexed assignment
through them rejects before WAT emission. Static-shaped aggregate bindings
created through `freeze { ... }` are also immutable compiler facts in the
current scalarized path; indexing mutation through them rejects with the same
frozen/shareable binding diagnostic.

Scalarized static-shaped aggregate results may leave a scratchpad when every
returned field is scalar, static/frozen data, or otherwise proven scratch-free.
Static union cases and dynamic static-union `if` results may also leave when the
condition and case payloads are scratch-free. Heap-backed aggregate, text,
union, or closure values require explicit promotion/freeze or reject before WAT
emission.

Cleanup is elaborated from facts before WAT emission. Scratch cleanup emits real
pointer resets. Unique heap drops emit `__free` calls into the reusable
free-list allocator, and their allocation/layout links keep that runtime action
explicit in the proof. Temporaries introduced during lowering follow the same
storage, lifetime, and cleanup rules as source values.

## Handlers

Ix-defined effect handlers compile only through the Core/managed-Wasm route. The
IC-only route rejects plain effects, handlers, resumptions, and Unit handler
syntax explicitly.

## Host Effects And ABI

The `Mod` layer can emit Wasm function imports, export imported functions,
define a single Wasm memory, export it, and emit active data segments. Declared
host effects lower to typed Wasm imports and opaque `i32` registry handles;
effect rows and internal proof tokens have no runtime representation.

Effect operations support scalar numeric ABI parameters/results, `&T` bounded
borrows, plain rich `T` ownership transfers, and `#T` frozen/shareable values.
Plain rich results are unique owned values. The compiler generates its internal
import descriptors during effect elaboration; source programs do not name raw
Wasm modules or fields. Effect resources remain explicit module dependencies
rather than ambient Wasm authority.

Runtime `Bytes` values support `len`, `get`, byte iteration, `slice`, and
`append` in structured Core, and bounded borrows can cross effect calls. Slices
and appends currently allocate and copy.

## Supported Ic-Lowerable Scalar Features

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
scalar/frozen captures, closures returned from scoped static calls, and
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

## Reserved

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
