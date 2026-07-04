# Type Values, Structs, Unions, And Facts

## Goal

Implement type-values, type constructors, structs, unions, destructuring, and
structural fact checking.

## Source Sections

- Types as Values
- Structs and Unions
- Destructuring and Fact Checking
- Error Model

## Work

- Treat named types as `const` bindings.
- Parse struct type values:

```txt
const user_type = struct {
  name: Text,
  age: Int
}
```

- Parse union type values:

```txt
const result_type = e => t => union {
  ok: t,
  err: e
}
```

- Support runtime construction of structs and union cases.
- Support `if let` pattern matching for union cases.
- Implement destructuring checks over type-values:

```txt
const has_name = t => {
  let struct { name: Text, .. } = t
  t
}
```

- Represent structural facts such as field existence, field type, struct/union
  kind, size, and alignment.
- Extend runtime aggregate facts with storage and lifetime information when
  values are materialized: scalarized static facts, `unique_heap` aggregate or
  union owners, `frozen_shareable` aggregates, `borrow_view` projections, and
  `scratch_backed` payloads.
- Make field and payload ownership explicit. Reading a scalar field copies the
  scalar; reading an owned field moves, borrows, or rejects according to the
  owner facts; reading a frozen field remains shareable.
- A struct or union value produced inside `scratch {}` can leave the scratchpad
  only when every field or payload is scalar, frozen/shareable, explicitly
  promoted/frozen, or proven scratch-free. Otherwise it rejects before WAT
  emission.

## Acceptance Criteria

- Type-values are available to compile-time code.
- Type constructors are const functions returning type-values.
- Struct construction checks field names and field types.
- Union construction checks case payloads.
- Fact checkers can be used through parameter annotations.
- Conflicting facts fail at compile time.
- Aggregate facts that touch runtime storage include enough ownership rows for
  the no-GC proof gate. Unsupported field/payload ownership or scratch escapes
  reject deterministically.

## Verification

- Add parser/type tests for `struct`, `union`, and generic type constructors.
- Add tests for valid and invalid struct fields.
- Add tests for valid and invalid union case construction.
- Add fact-checker tests for `has_name`.
- Add aggregate ownership tests for field/payload scratch escape, frozen
  sharing, borrow projection lifetime, unique payload movement, and
  `managed_storage: "disabled"` proof output.

## Implementation Status

- Implemented named type-values, struct and union type-values, simple const
  aliases to visible type-values and builtin type names in Core static analysis,
  binding-time type-alias capture inside frontend type fields and destructuring
  patterns, generic type constructors, typed struct construction, typed union
  constructors, known-case union matching with runtime payloads, binding-time
  payload capture for bound union cases, and frontend-known field/static-index
  projections, direct typed pure union matching via Ic handler lambdas, dynamic
  frontend-known object `if` field selection, same-case dynamic typed or locally
  inferred shorthand union `if` payload selection, different-case dynamic typed
  or locally inferred shorthand union `if` as handler-encoded Ic values,
  different-case dynamic typed union `if` consumed by numeric/text-pointer
  `if let`, locally inferred shorthand dynamic union cases consumed by `if let`
  both directly and through statically bound dynamic `if` values and inlineable
  runtime closure calls, typed dynamic union branches with explicitly named
  struct payloads consumed by `if let` field access, typed struct values as Ic
  handler lambdas, frontend-known object values as Ic handler lambdas,
  frontend-known object/typed-struct dynamic `if let` values by field-wise Ic
  handler lowering, simple block-local frontend-known struct/union values
  consumed by field/index access or known-case `if let`, simple const block
  union values and type-values, simple block-local dynamic union-if values
  consumed by `if let`, known runtime struct/union type facts through
  unannotated frontend helper-call specialization, and deferred const-call
  aggregate results consumed by field/index access.
- Frontend struct type-value resolution, declared struct-value validation,
  frontend-known struct-value discovery, declared field-type discovery, pure
  struct-update rebuilds, and handler-encoded struct-value Ic lowering live in
  `src/frontend/struct_values.ts`.
- Implemented direct struct/union annotation context for shorthand aggregate
  values, so `.ok(1)`, object literals, and dynamic `if` expressions whose
  branches construct cases of the annotated union can become typed values at
  annotated bindings and call sites. Typed union annotations also apply declared
  case payload context to shorthand object payloads, so `.ok({ ... })` can bind
  a named struct payload without spelling the constructor at the value site. The
  structured Core path applies the same direct context for visible struct/union
  type-values before WAT emission, keeps visible `Text` payloads from those
  dynamic union values available to later `if let` text operations after
  shadowing, and preserves explicit named struct payload types in frontend
  dynamic union case-shape inference. Core dynamic union-if `if let` lowering
  keeps named struct payloads, including shorthand object payloads resolved from
  declared case context, as branch-local static aggregate facts.
- Frontend union construction, typed constructor validation, union type-value
  resolution, and shorthand union-case inference live in
  `src/frontend/union_values.ts`; dynamic union branch case-shape inference
  lives in `src/frontend/union_infer.ts` with shared dynamic union-if case
  merging in `src/frontend/dynamic_union_cases.ts`. Frontend `if let`
  orchestration lives in `src/frontend/if_let.ts`, shared typed `if let` helpers
  live in `src/frontend/if_let_common.ts`, and handler-encoded union-result
  lowering lives in `src/frontend/if_let_union_result.ts`.
  `src/frontend/lower_graph.ts` supplies the environment-sensitive expression,
  field, and index resolution hooks behind the public `src/frontend/lower.ts`
  facade.
- Implemented structural facts and builtins including `has`, `fields_of`,
  `cases_of`, `size_of`, `align_of`, `is_struct`, `is_union`, and `layout`.
  Their compile-time evaluation lives in `src/frontend/const_builtin.ts`, with
  `src/frontend/lower_graph.ts` supplying environment-sensitive lookup hooks.
- Implemented destructuring fact checkers over type-values, binding fact-checker
  annotations, runtime struct parameter annotations, and typed-union parameter
  annotations checked at call-site specialization. Direct struct/union binding
  and parameter annotations can also type otherwise unknown frontend runtime
  values for Ic handler lowering. Structured Core preserves closure parameter
  annotations and checks built-in scalar/type parameter annotations when static
  calls are inlined. Direct struct/union type-value parameter annotations
  provide static call argument context in Core.
- Non-final frontend expression statements proven to be compile-time-only,
  including type-values and `with` extension expressions, are validated as const
  expressions and elided before Ic lowering, while final type-value program
  results still fail because they have no runtime Ic representation.
- `Core.emit` keeps type-level const bindings available to static Core analysis
  including simple const aliases, resolves builtin type-name aliases in
  fields/patterns, and validates visible struct/union `type_check` patterns
  before eliding them from generated WAT.
- `Core.emit` instantiates simple const type-constructor calls returning
  struct/union type-values, including curried calls such as
  `result_type(Text)(Int)`, before direct annotation checks, typed union
  constructor checks, and WAT emission.
- `Core.emit` checks direct struct/union type-value binding annotations for
  shorthand aggregate values and dynamic typed union-if values, then stores the
  typed static value in Core analysis.
- Core-side static struct-value resolution, static struct updates, dynamic
  struct-if reshaping, and static collection-field projection live in
  `src/core/struct_static.ts`, with backend expression-type and static-call
  hooks.
- Frontend typed no-payload union cases now lower as either
  `option_type.none()` or `option_type.none`. The field form is accepted only
  when the named case is declared `Unit`; payload cases still require an
  explicit constructor call with one argument.
- Frontend annotated runtime struct field and index projection facts now survive
  pure-Ic ownership wrappers. A value known through `let user: user_type = ...`
  can be projected through `borrow`, `freeze`, or a simple value-returning
  `scratch { user }` wrapper without losing the declared struct field table.
- `Core.emit` snapshots runtime payload values for statically bound shorthand
  and typed-constructor union cases before later shadowing can change the source
  binding.
- `Core.emit` materializes typed scalar/`Text`/`Unit` and static-shaped struct
  union values as heap objects with an `i32` tag at offset `0`, scalar/text
  pointer payload slots, union-pointer payload slots, or packed struct-field
  slots, and an `i32` pointer result for direct typed constructors and direct
  dynamic `if` branches over typed union cases.
- Tests cover generic constructors, valid/invalid struct and union fields,
  binding-time type-alias capture, structural facts, `has_name`-style fact
  checkers, binding annotations, contextual shorthand union constructors, Core
  static-call parameter annotation checks including direct struct/union
  parameter context, runtime struct parameter annotations, typed-union parameter
  annotations, typed dynamic `if let` over pure union values with numeric and
  text-pointer results, same-case dynamic typed union `if` expressions,
  same-case locally inferred shorthand dynamic union values, standalone inferred
  shorthand union cases including unknown runtime payloads, different-case
  dynamic typed or locally inferred shorthand union `if` values including
  unknown runtime payloads, and different-case dynamic typed union `if` consumed
  by numeric/text-pointer `if let`, including named-struct payload field access
  through explicit typed constructors, shorthand object case payloads, and typed
  unknown union-value branches matched by dynamic `if let`, including annotated
  helper calls that return dynamic `if` values over typed union parameters,
  dynamic union `if let` expressions that produce handler-encoded union results,
  including direct shorthand union cases, deferred const-call results,
  inlineable runtime closure calls whose local case table can be inferred from
  dynamic `if` branches, and dynamic `if` branches whose union cases are
  produced by inlineable identity or constructor helper calls, typed union case
  tables preserved through direct and simple block-bodied inlineable helper
  returns into `if let`, static-rec application of those bound handler-encoded
  union results including user-defined struct payload field facts,
  frontend-known object/typed-struct `if let` value lowering, plus Core direct
  and statically bound dynamic union-if `if let` lowering over shorthand and
  typed constructor branches, including named-struct payload field access, Core
  scalar/`Text`/`Unit` and aggregate-pointer struct runtime union object
  materialization, frontend nested struct payload field access through typed
  dynamic unions, and Core stored scalar/`Text`/`Unit`/aggregate-pointer
  struct/union-pointer matching including direct union-pointer payloads and
  union-pointer leaves inside aggregate payloads, with type-check elision
  through WAT-to-Wasm.
- Final codegen for general aggregate memory representation and runtime union
  payload storage/matching outside the implemented scalar, `Text`, `Unit`,
  union-pointer, and aggregate-pointer struct payload cases remains reserved.
