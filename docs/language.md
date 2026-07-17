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
const layout_of = t => @layout(t)
const align_to = (offset, alignment) => offset
const greet_user = user => user.name
const user_layout = @layout(user_type)
```

Built-in type-value names such as `Int`, `I64`, `Text`, `Unit`, and `Type` keep
their builtin spelling. User-defined names and type references in annotations,
field access, struct fields, union cases, `if let` payload binders, and
destructuring patterns use `snake_case`. Compiler-internal source marker names
use `snake_case`, such as `object_type`, `layout_type`, and
`field_offsets_type`.

Compiler-provided callable names use the reserved `@` prefix, such as `@append`,
`@Bytes.generate`, and `@size_of`. The prefix remains part of the name through
parsing and lowering, so an ordinary user function named `append` is distinct
from `@append`. Excluded language-family keywords such as `class`, `trait`,
`macro`, `instance`, `extends`, and `inherits` are reserved so they produce
explicit unsupported-feature diagnostics instead of becoming ordinary names.

```txt
const { struct } = comptime import "duck:prelude" ()

const user_type = struct {
  .name = Text,
  .age = Int
}

type OptionType t = | .some = t | .none
const option_type = OptionType

const functor = f_type => {
  f_type.map
  f_type
}
```

## File Modules

Every loaded `.duck` file starts with a module header and ends with an explicit
export shape. A file without inputs uses an empty header:

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
must reach a final `return { ... }`, and branch-produced export shapes must have
compatible fields and types. `Source.parse` remains a fragment parser for tests
and interactive compilation; file loading is what enforces the header and final
export shape.

An import loads a file but does not instantiate it or grant it authority.
Instantiation is a separate call with an explicit dependency shape:

```txt
const logger = import "./logger.duck"
const { .write = write } = logger { .io = !init.io }
```

Module invocation is compiler-time wiring and specialization. Its result is the
imported file's export product, so labeled product destructuring selects
exports. An `_` entry in that pattern selects no field and ignores the remaining
export shape. The entry module's final product is returned by the managed
JavaScript `DuckRunner(init).run(program)` call. A runner captures one explicit
handler set; selecting another runner swaps host or mock effects without
recompiling the module.

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
shorthand object payloads such as `.ok { .age = 40 }`. Fact-checker annotations
run the named const fact checker against the bound value's type-value. An
explicit runtime annotation can also provide type context for an otherwise
unknown runtime value, while known incompatible values still fail at the
binding. Parameter annotations follow the same rules and are enforced at the
call boundary.

```txt
let x: Int = 41
let wide: I64 = 41i64

const { struct } = comptime import "duck:prelude" ()
const user_type: has_name = struct {
  .name = Int,
  .age = Int
}

let user: user_type = [input, 0]
```

Numeric literals carry value types in Ic. Unsuffixed source integers are the
`Int`/`i32` convention. `I<N>` and `U<N>` name signed and unsigned integers of
any positive bit width; their literal suffixes are `i<N>` and `u<N>`. A literal
must fit its declared type, including the signed minimum such as `-16i5`.
Decimal fractions and exponents require the `f32` suffix. Hexadecimal integer
literals use `0x` or `0X` and may carry the same integer suffixes. Mixed-width
operands are rejected instead of converted implicitly.

```txt
let small = 42i32
let wide = 42i64
let flags = 17u5
let signed_minimum = -16i5
let identifier = 340282366920938463463374607431768211455u128
let mask = 0xff
let ratio = 1.5f32
```

Integer bitwise operations are named functions: `@bit_and`, `@bit_or`,
`@bit_xor`, `@shift_left`, and `@shift_right_u`. Each accepts two matching
integer types. The prelude operators `&&&`, `|||`, `^^^`, `<<`, and `>>` call
those functions directly. Arithmetic wraps at the declared bit width and
comparisons preserve signedness. A shift count greater than or equal to the
declared width produces zero; it does not expose Wasm's carrier-width masking.
Widths through 32 bits use an `i32` carrier and widths through 64 bits use an
`i64` carrier. Wider values use one affine Core value containing little-endian
`U32` limbs; this representation is internal and does not change source-level
integer semantics. The scalar conversion functions are explicit: `@f32_from_i32`
converts signed `I32` to `F32`, and `@i32_from_f32` truncates toward zero and
traps for NaN, infinity, or an out-of-range result. `@f32_sqrt` computes an
`F32` square root.

`@as(value, Target)` is an erased checked cast. `Target` must be a statically
known type value, and the canonical source and target types must have identical
runtime representations. This permits casts through exact aliases such as
`UserId` and `I32`, but rejects width changes and semantic mismatches such as
`I32` to `I64` or `Bool` to `I32`.

Numeric casts that deliberately change width or reinterpret bits use explicit
unsafe compiler names:

- `@unsafe_i32_wrap_i64` retains the low 32 bits of an `I64`;
- `@unsafe_i64_extend_i32_signed` sign-extends an `I32`;
- `@unsafe_i64_extend_i32_unsigned` zero-extends the same 32 bits;
- `@unsafe_i32_reinterpret_f32` and `@unsafe_f32_reinterpret_i32` preserve the
  bits while changing their numeric interpretation.

These intrinsics expose the corresponding Wasm operation exactly; they do not
perform range validation or semantic conversion.

`@integer.wrap(value, Target)` is the compiler boundary used by source numeric
conversion functions. It keeps the low `Target` bits, sign- or zero-extends when
widening according to the source type, and then interprets the result as
`Target`. Ordinary code should expose intentional conversions through a
source-defined `From` or `TryFrom` implementation rather than call the compiler
boundary directly.

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
literal. Both the ordinary Duck spelling and a parenthesized condition are
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
`Bytes` values support `@len`, `@get`, byte iteration, `@slice`, and `@append`,
and bounded borrows can cross effect calls. `Bytes.empty` is the canonical
static empty buffer. Arbitrary raw byte literals and borrowed slice views are
not supported yet.

`Text` and `Bytes` are distinct source types even though both use the same
runtime layout: an `i32` byte length followed by the bytes. They are never
converted implicitly. Use `@Utf8.encode(text)` to allocate and copy a `Text`
value into a `Bytes` value, and `@Utf8.decode(bytes)` to validate, allocate, and
copy bytes into `Text`. Decoding traps for malformed, overlong, surrogate, or
out-of-range UTF-8. Byte index assignment is supported only for `Bytes`; text
must be encoded before its bytes can be changed.

`@format_i32(value)` and `@format_i64(value)` allocate `Text` containing exact
signed decimal notation, including the minimum integer values.
`@format_f32(value, precision)` allocates fixed-point `Text` with exactly
`precision` digits after the decimal point. Precision is an `I32` from `0`
through `6`; a value outside that range traps. It rounds the binary32 magnitude
by computing `trunc(abs(value) * 10^precision + 0.5)` in Wasm before writing the
digits, so its spelling is deterministic and does not rely on a host formatter.
Negative values receive a leading `-`; negative zero formats as positive zero.
NaN, infinities, and values whose rounded scaled magnitude does not fit in
signed 64 bits trap. This is deliberately fixed-point formatting, not
shortest-round-trip conversion.

```duck
@format_f32(-12.5f32, 3) // "-12.500"
@format_f32(1.999f32, 2) // "2.00"
```

### Text Operations

Text values are UTF-8. The contract for text operations:

- `+` concatenates text values. `@append(left, right)` accepts two `Text` values
  or two `Bytes` values, but never mixes them.
- `@len(value)` is the UTF-8 byte length.
- `value[index]` and `@get(value, index)` return the UTF-8 byte at `index` as
  `i32`, trapping on out-of-range indexes.
- `@slice(value, start, end)` selects a byte range. Statically known `Text`
  slices that split a UTF-8 sequence are rejected.
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

Compile-time type values support structural `match` arms. These arms use the
same open struct and union patterns as fact checkers, and a const function that
contains them is specialized before Core lowering:

```txt
const derive_name = (const target) => match target {
  | struct { .name = Text, .. } => value => value.name
  | _ => @fail("derive_name requires a Text name field")
}

const player_name = comptime derive_name(Player)
```

Aliases are normalized before field types are compared. Type-match functions are
compile-time-only wiring: every call must provide compile-time type values, and
the unused arms do not reach generated Wasm.

Structural descriptors expose the normalized kind and layout of a type:

```txt
@describe_type(Player)
@describe_fields(Player)
@describe_cases(Result)
```

`@describe_type` contains `kind`, `name`, `size`, `align`, `stride`, `length`,
`element`, `fields`, and `cases`. Field descriptors contain `name`, `index`,
`offset`, and `type`; case descriptors additionally contain their numeric `tag`
and retain the owning union type. Product entries use an empty name when
positional. A non-applicable descriptor length is `-1`.

Descriptors can direct fixed runtime operations without introducing runtime
reflection:

```txt
const score_field = @describe_fields(Player)[1]
let player = @construct [Player, { .name = 20, .score = 40 }]
let score = @project(player, score_field)
```

`@project` becomes a fixed field or index projection. `@construct` supports
records, ordered products, and fixed arrays and validates their shape during
compilation.

Case descriptors use the same operations for unions:

```txt
const ok_case = @describe_cases(Result)[0]
let result = @construct(ok_case, 42)

if @is_case(result, ok_case) {
  @project(result, ok_case)
} else {
  0
}
```

Recursive const calls may appear in any expression position, not only in tail
position. Calls are memoized by their structural compile-time arguments.
Repeated active argument states report a recursion cycle, and a single
evaluation is limited to 10,000 recursive calls so non-terminating compilation
fails deterministically.

Descriptor traversal does not introduce a separate comptime-flavored collection
API. Define an ordinary const fold and force the derived result at the
`comptime` boundary:

```txt
const fold = rec (values, index, state, next) => {
  if index == @len(values) {
    state
  } else {
    rec(values, index + 1, next(state, values[index]), next)
  }
}

const add_field = (sum, field) => {
  value => sum(value) + @project(value, field)
}

const derive_sum = (const target) => {
  const fields = @describe_fields(target)
  fold(fields, 0, value => 0, add_field)
}

const sum_player = comptime derive_sum(Player)
```

Here `fold`, its accumulator, and the descriptors are all ordinary const values.
`comptime` retains one specific meaning: it is the explicit boundary that
requires specialization to finish during compilation. The resulting `sum_player`
closure contains only fixed field projections; neither the fold nor the
descriptors exist at runtime.

Const recursion can construct ordinary arrays with a final spread. The spread
must resolve to a closed fixed array before the `comptime` boundary finishes:

```txt
const range = rec (index, end) => {
  if index == end {
    []
  } else {
    [index, ...rec(index + 1, end)]
  }
}

const indexes = comptime range(0, 3)
```

Fixed-array lengths accept natural arithmetic over compile-time integer
bindings. They are normalized to a literal before layout and lowering:

```txt
const width = 2
type Row = [Int; width + 1]
let row: Row = [20, 1, 21]
```

An unresolved name, runtime binding, negative result, division by zero, or
unsafe-integer overflow is rejected. Arrays remain fixed-size; this does not
introduce a runtime-sized array type.

Imported modules can take explicit const parameters for deterministic build
configuration:

```txt
// dependency.duck
module (const release: Bool) where
const value = if release { 42 } else { 0 }
return { .value = value }

// main.duck
const dependency = import "./dependency.duck"
const { .value = value } = dependency true
```

Build constants are ordinary explicit inputs. Compile-time evaluation does not
implicitly read environment variables, clocks, randomness, or the network. See
`examples/compile_time/13_derived_nested_equality.duck` for a recursive
derivation that specializes equality across records, fixed arrays, and union
cases.

## Functions And Control Flow

Functions use closure syntax.

```duck
let add = (x, y) => x + y

let add_block = (x, y) => {
  x + y
}
```

Function types support explicit universal quantification. `forall` binds one or
more type variables through the following type expression, and it may occur at
any rank. Parentheses delimit a nested quantified argument or result:

```duck
const identity: forall value. value -> value = value => value

const apply_identity: (forall value. value -> value) -> I32 =
  (const identity) => identity(42)

const make_identity: Bool -> (forall value. value -> value) =
  flag => value => value
```

Binder names are alpha-equivalent, so `forall value. value -> value` and
`forall element. element -> element` denote the same type. An implementation
checked against `forall` must remain valid for every quantified type; a
monomorphic function such as `I32 -> I32` cannot satisfy that annotation.
Unannotated const functions are generalized over inference variables not fixed
by their environment. Calls instantiate those variables predicatively; Duck does
not infer impredicative instantiations.

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

The bundled source prelude is an ordinary module and is imported explicitly when
`struct` is used:

```txt
const { struct } = comptime import "duck:prelude" ()
```

Bare destructuring fields bind the same local name. Use the dotted form when
renaming, such as `{ .struct = make_struct }`.

Module export shapes and `with` updates use the same shorthand. `{ code }` means
`{ .code = code }`; keep the dotted form when the label and local expression
differ, such as `{ .status = code }`.

`struct` itself is defined in that source module without aggregate intrinsics.
It loops over the ordered shape once to build the product type and again to add
one accessor to that scoped type value for each field:

```txt
const struct = (const shape) => {
  let product_type = []

  for field in shape {
    product_type = [...product_type, field.value]
  }

  for index, field in shape {
    product_type = product_type with {
      .[field.name] = value => value[index]
    }
  }

  product_type
}
```

Each shape iteration yields a compile-time entry with `.name` and `.value`.
Leading spread appends the entry's type to the ordered product. The computed
member form `type_value with { .[name] = function }` returns a new scoped type
value with that namespace member; it does not mutate extensions for other
structs with the same slot layout. Repeat types use `[Element; Length]`
directly; there is no `array` constructor.

The root prelude also exports the type constructors and functions used by the
colon-prefixed type algebra:

```txt
const {
  newtype,
  type_extend,
  type_union,
  type_intersection,
  type_difference,
} = comptime import "duck:prelude" ()

const readable_point = Point :+ {
  .read = value => value.x
}

const numeric = I32 :| I64
const signed = numeric :- I64
```

`:+` extends a compile-time type value with namespace members or methods and
rejects incompatible collisions. `:|`, `:&`, and `:-` are union, intersection,
and difference. These operators are implicitly compile-time; the functions they
dispatch to remain ordinary Duck source. `:>` is the representation-checked
compiler boundary used to seal a value as a nominal type.

`newtype` creates a fresh nominal type while preserving the representation of
its argument:

```txt
type Centimeter = newtype I32
type Seconds = newtype I32

const distance = 42 :> Centimeter
const raw = Centimeter.unwrap distance
```

`Centimeter` and `Seconds` are not interchangeable. Sealing and the generated
`wrap`/`unwrap` functions emit no runtime conversion. Ordinary `@as` does not
cross a newtype boundary.

`packed` creates a bit-packed product type from fixed-width integer fields. It
is imported from the prelude like `struct`; the declaration supplies the
compiler-known layout while the resulting namespace contains ordinary source
functions. Fields are laid out in declaration order from most-significant to
least-significant bit, with no padding. Positional declarations generate
`item_0`, `item_1`, and so on; named declarations use their field names. Every
field also gets an immutable `with_<field>` replacement function.

```txt
const { packed } = comptime import "duck:prelude" ()

type Flags = packed [U1, U2, U5]
type Header = packed struct {
  .kind = U3,
  .urgent = U1,
  .length = U12,
}

let header: Header = Header.pack [5u3, 1u1, 120u12]
let changed = Header.with_kind [header, 2u3]
let kind: U3 = Header.kind changed
```

Packed fields must be `I<N>` or `U<N>`. Layouts through 64 bits are a single
Wasm scalar. Larger layouts use the same Core limb value as a wide unsigned
integer. Generated accessors preserve the exact field type, and direct indexing
is deliberately unavailable: this prevents a dynamic index from erasing
different field widths or signedness.

There is no source `union` function. Named sums use leading-pipe declarations:

```txt
type Result error value = | .ok = value | .err = error
```

The same explicit import also provides common source-defined functional building
blocks:

```txt
const { identity, compose, curry } =
  comptime import "duck:prelude/functional" ()

const add_two = value => value + 2
const double = value => value * 2
const combined = comptime compose [add_two, double]
```

The lightweight runtime prelude is the batteries-included bridge to common
compiler operations:

```txt
const { length, slice } = comptime import "duck:prelude/runtime" ()
let joined = left <> right
```

It exports:

- collection operations: `append`, `length`, `get`, and `slice`;
- integer bits: `bit_and`, `bit_or`, `bit_xor`, `shift_left`, and
  `shift_right_unsigned`;
- scalar conversion and formatting: `sqrt_f32`, `f32_from_i32`, `i32_from_f32`,
  `format_i32`, `format_i64`, and `format_f32`;
- managed buffers: `generate_bytes`, `encode_utf8`, and `decode_utf8`;
- the explicit runtime failure boundary `panic`;
- SIMD construction and arithmetic under the `f32x4_` prefix.

These are ordinary source-defined names over the reserved compiler functions, so
application code can use `length` while compiler internals remain visibly
prefixed as `@len`. The runtime prelude also supplies `Semigroup` instances for
`Text` and `Bytes`, and `Bits` instances for `I32` and `I64`.

Importing `duck:prelude/functional` re-exports the runtime functions and also
brings the generic `Option`, `Result`, and `Either` sum types, the `Ordering`
type, and these function combinators:

- application and composition: `identity`, `constant`, `compose`, `pipe`,
  `apply`, `reverse_apply`, `flip`, `curry`, `uncurry`, and `on`;
- products and branching: `swap`, `first`, `second`, `fanout`, and `converge`;
- sum elimination and queries: `option`, `option_unwrap_or`, `option_is_some`,
  `option_is_none`, `result_unwrap_or`, `result_is_ok`, `result_is_err`,
  `either_is_left`, and `either_is_right`.

The structural category set includes `Eq`, `Ord`, `Semigroup`, `Monoid`,
`Semiring`, `Ring`, `EuclideanRing`, `Functor`, `Apply`, `Applicative`, `Monad`,
`Bind`, `Foldable`, `Show`, `Default`, `Bounded`, `Enum`, `Alternative`,
`Bifunctor`, `Contravariant`, `Traversable`, `Category`, `Profunctor`, `From`,
`Into`, `TryFrom`, and `Bits`. `From Source Target` defines
`.from = Source -> Target`; its implementation is an extension on `Source`, and
the target is inferred from the result context. Higher-kinded roles are written
directly in duck signatures, for example `F A`, `A -> B`, and `F B`. Instances
remain ordinary lexical `extend` declarations and can be checked explicitly with
`comptime`. Higher-order combinations that produce a new closure are specialized
at `comptime`, preserving a direct runtime call.

The standard functional and bit operators are available wherever their target
prelude name or duck is in scope:

```txt
value |> transform
transform $ value
left <> right
transform <$> functor
wrapped_transform <*> wrapped_value
monad >>= next
left <|> right
bits &&& mask
bits ||| mask
bits ^^^ mask
bits << amount
bits >> amount
```

`|>` and `$` dispatch to the source-defined `pipe` and `apply` functions. Their
function operands are compile-time parameters, and their generic annotations
require the applied value to match the function input type. `<$>`, `<*>`, `>>=`,
and `<|>` dispatch through their corresponding ducks. `<>` and the bit operators
lower to their matching compiler intrinsics. Other instances are ordinary
`extend` declarations. Import `pipe` or `apply` from the functional prelude when
using its corresponding operator.

```txt
const { struct } = comptime import "duck:prelude" ()

const user_type = struct {
  .name = Text,
  .age = Int
}
```

Named generic declarations are const functions returning type-values.

```txt
type Result error value = | .ok = value | .err = error
type ParseResult = Result Text Int
```

The experimental row syntax provides named `type` declarations as surface sugar
over those same const type-values. Bracket products may be labeled or
positional:

```txt
type Vec3 = struct { .x = Int, .y = Int, .z = Int }
type Pair = [Int, Int]

let point: Vec3 = [40, 1, 1]
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
surrounding brackets. The leading `|` is required:

```txt
type Maybe a = | .just = a | .nothing

type MaybeInt = Maybe Int
```

A bare case has a `Unit` payload. Payload-bearing cases use `=`. Type parameters
elaborate to the existing compile-time type constructors, and a named alias such
as `Maybe Int` specializes one before Core lowering. The formatter emits sums in
the multiline leading-pipe form.

Ducklang supports closed top-level products, sums, aliases, and product values.
It preserves field order, union tags, and ABI layouts; it does not implement
open row variables or width subtyping. Recursive declarations are parsed but
rejected explicitly because recursive generic substitution and recursive
owned-child destruction are not implemented safely yet:

```txt
type List a = | .nil | .cons = [a, List a]
```

This reports `Recursive algebraic type declarations are not supported yet: List`
rather than emitting a partially owned recursive heap layout.

Types also compose as sets. Union, intersection, and difference use the same
operators as effect rows, with difference binding most tightly:

```txt
type Value = Int :| Text :| I64
type Number = Value :- Text
type Answer = Number :& Int

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
type Maybe a = a :| #nothing
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
type Marker = #ready :| #waiting
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
emittable. Ownership-qualified members such as `#Text :| Int` are also rejected
as runtime tagged sets for now: the current union envelope does not encode a
different ownership policy per tag, and accepting it would make destruction
unsound.

Struct construction validates field names and field types.

```txt
let user: user_type = ["Ada", 36]
```

Union constructors validate case names and payload types.

```txt
let result = parse_result_type.ok(42)
```

Fact checkers are const functions over type-values.

```txt
const has_name = t => {
  let struct { .name = Text, .. } = t
  t
}

let greet = (const t: has_name, value) => {
  @size_of(t) + value
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
  let union { .ok = Int, .. } = t
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
@has(user_type.name)
@fields_of(user_type)
@cases_of(result_type)
@is_struct(user_type)
@is_union(result_type)
@size_of(user_type)
@align_of(user_type)
@layout(user_type)
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
type NumberCalcType = | .literal = Int | .add = add_args_type
type TextCalcType = | .literal = Text

const calc_types = 0
const calc_types = calc_types with {
  .number = NumberCalcType,
  .text = TextCalcType
}

const number_calc_type = calc_types.number
const text_calc_type = calc_types.text
```

The selected union controls which constructors exist, so
`number_calc_type.add(...)` is valid while `text_calc_type.add(...)` is
rejected. This is a closed, compile-time indexed family rather than a general
GADT: abstract indices, existential packaging, and recursive indexed unions
remain reserved. See `examples/compile_time/11_indexed_calculator.duck` for the
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
record. Duck cannot construct or inspect an `Io`; JavaScript supplies an
instance through the entry `Init`. `declare` means the operations are
host-implemented. Only declared effects appear in the managed JavaScript ABI.

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
let greet: () -> <Io.read :| Io.print> Text = () => {
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
variable beneath `:&` or `:-` is reserved until symbolic row constraints are
implemented.

Effect rows are sets of qualified operations. A family atom expands to every
operation declared by that effect. Set expressions use these operators:

```txt
A :| B  // union
A :& B  // intersection
A :- B  // difference
```

`Io.read :| Io.print` permits both operations, while two disjoint families such
as `Stdin :& Stdout` intersect to the empty row. Parentheses group compound row
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

const logger = import "./logger.duck"
const { .write = write } = logger { .io = !init.io }
result <- write("hello")

return { .result = result }
```

Loading `logger.duck` alone grants no authority. Module invocation consumes or
borrows the resources named by its declared parameters and returns its export
record.

## Duck-Defined Effects And Handlers

The `duck:prelude/effects` module includes `State`, `Reader`, `Writer`, `Raise`,
`Clock`, `Random`, `Console`, `Environment`, `Resource`, `Log`, `Validation`,
`Async`, `Channel`, `Mutex`, `Semaphore`, `TaskGroup`, and `Stm`. These are
handler-defined capabilities; importing their declarations does not select a
scheduler, clock, random source, transaction store, or other authority.

An uninstantiated generic effect such as `State value` may infer its parameter
from operation arguments, operation results, and values passed to handler
resumptions. A used parameter must resolve to one concrete type throughout that
effect identity. Incompatible uses are rejected at the effect boundary. Host
effects remain concrete because their declarations define the ABI contract.

Use a named const instance when the same effect family is needed more than once:

```txt
const counter = State I32
const message = State Text

count <- counter.get()
text <- message.get()
```

The instance is `const` because it is compile-time capability identity, not
runtime state. The handler contains the runtime state. Identity is nominal, so
two `State I32` instances are still independent. Calls, effect rows, and
handlers use the lowercase instance name. A family without type parameters uses
the unit application form, such as `const wall_clock = Clock ()`.

```txt
const _ = comptime import "duck:prelude/effects" ()

const counter = State I32

let state = {
  let current = 0
  counter {
    get: (!resume) => !resume(current),
    put: (value, !resume) => {
      current = value
      !resume(())
    },
    return: value => value,
  }
}
```

`Async`, `Channel`, `Mutex`, `Semaphore`, and `TaskGroup` describe structured
concurrency operations. Their handlers own task scheduling, cancellation, and
wake-up policy. `Stm` describes transactional reads, writes, retry, and
alternative selection; its handler owns transaction logs, conflict detection,
commit, and restart. The compiler preserves the typed capability boundaries but
does not pretend that ordinary sequential state is asynchronous or atomic.

The `duck:prelude/effects/defaults` module supplies source-defined handler
factories. Import only the factories an application installs:

```txt
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

`default_state` and `default_reader` provide the ordinary local semantics.
`deterministic_clock`, `single_slot_channel`, `sequential_mutex`, and
`counting_semaphore` provide predictable sequential handlers intended for tests
and single-threaded programs. The semaphore handler assumes acquisition is
valid; it is not a blocking scheduler.

Every remaining effect has a complete adapter factory: `handle_writer`,
`handle_raise`, `handle_random`, `handle_console`, `handle_environment`,
`handle_resource`, `handle_log`, `handle_validation`, `handle_async`,
`handle_channel`, `handle_mutex`, `handle_semaphore`, `handle_task_group`, and
`handle_stm`. Their arguments implement the operations and therefore make
authority visible at the installation site:

```txt
const { handle_environment } =
  comptime import "duck:prelude/effects/defaults" ()

const lookup = name => 40
try run() with handle_environment(lookup)
```

The adapters do not manufacture platform authority. A production clock, console,
random source, scheduler, or transaction engine must still be supplied
explicitly. In particular, `handle_async` and `handle_task_group` delegate to a
real scheduler, while `handle_stm` delegates commit and retry behavior to a real
transaction engine.

Plain `effect` declares operations implemented inside Duck:

```txt
effect Counter {
  get: () => I32
  add: (I32) => Unit
}
```

Type parameters follow the effect name and are scoped across all operation
signatures:

```txt
effect State value {
  get: () => value
  put: (value) => Unit
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
captured computation, pass it to other Duck code, or store it in an internal
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
  @len(message)
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

`match` arm blocks preserve the same nearest-loop behavior. An arm may fall
through, `break value`, or `continue`; control transfers are checked per arm,
and nested loops retain their own control boundary.

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
@get(xs, i)
```

Runtime indexes trap on out-of-range values. Runtime indexing requires every
selectable slot to have a compatible value type (the homogeneous runtime-index
rule).

```txt
const { struct } = comptime import "duck:prelude" ()

const pair_type = struct {
  .first = Int,
  .second = Int
}

let choose = (pair: pair_type, i) => {
  @get(pair, i)
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

`@fail` is a compile-time error when executed during `comptime` or fact
checking.

```txt
const has_len = t => {
  if !@has(t.len) {
    @fail("expected value with len")
  }

  t
}
```

`@panic` is a runtime trap. It lowers to an Ic trap primitive in the scalar
backend and to WAT `unreachable` in the structured Core backend.

```txt
@panic("index out of bounds")
```

Recoverable runtime errors use explicit unions.

```txt
type Result error value = | .ok = value | .err = error
```

## Lowering

The frontend performs parsing, semantic validation, fact inference, linearity
checking, compile-time evaluation, and specialization. Compilation then selects
one of two backend routes:

```txt
                         -> Ic -> Expr --------->
Source -> Frontend -----|                        Mod -> WAT -> Wasm
                         -> structured Core ---->
                                              |
                                              -> managed JavaScript ABI
```

The pure Ic route is the theory-facing route for scalar, affine, and
frontend-visible computation. It performs explicit sharing and erasure,
Interaction Calculus graph reduction, a no-GC proof, and lowering to `Expr`.

The structured Core route owns statements, loops, runtime memory, closures,
handlers, and ownership/lifetime/cleanup proofs. It emits `Mod` directly; it
does not currently pass through Ic or Expr. The managed JavaScript ABI wraps the
Core module with marshaling and host-effect imports.

The route contracts and permitted dependencies are documented in
[architecture.md](architecture.md). Per-feature route coverage lives in
[coverage.md](coverage.md), and larger reserved capabilities are prioritized in
[roadmap.md](roadmap.md).
