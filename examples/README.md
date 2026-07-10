# Source Examples

Binned source examples use the `.ix` extension. The extension is a repository
convention, not a restriction: `Source.load`, `Source.compile_file`, and
`Source.wat_file` continue to accept any exact file path.

Run every example, expected compiler failure, and expected runtime trap with:

```sh
just examples
```

To compile one Core example from TypeScript:

```ts
import { Source } from "../src/frontend.ts";

const wat = Source.wat_file("examples/data/01_struct_fields.ix");
```

Small pure examples marked `IC` use `Source.ic_wat`; structured examples marked
`Core` use `Source.wat_file`. The executable expectations and deterministic host
stubs live in `manifest.ts`.

## Basics

| Example                          | Focus                                   | Route | Result      |
| -------------------------------- | --------------------------------------- | ----- | ----------- |
| `01_arithmetic_and_shadowing.ix` | arithmetic and same-type shadowing      | IC    | `42`        |
| `02_type_changing_shadowing.ix`  | `:=` type-changing shadowing            | IC    | `42`        |
| `03_numeric_primitives.ix`       | division, remainder, and multiplication | IC    | `42`        |
| `04_comparisons_and_logic.ix`    | comparisons and short-circuit logic     | IC    | `42`        |
| `05_i64_pipeline.ix`             | explicit `I64` arithmetic               | IC    | `42i64`     |
| `06_functions_and_blocks.ix`     | multi-argument block function           | IC    | `42`        |
| `07_early_return.ix`             | early function return                   | IC    | `42`        |
| `08_dynamic_condition.ix`        | host-driven runtime branch              | Core  | `21` / `41` |

## Compile Time

| Example                            | Focus                                         | Route | Result |
| ---------------------------------- | --------------------------------------------- | ----- | ------ |
| `01_comptime_adder.ix`             | compile-time closure construction             | IC    | `42`   |
| `02_higher_order_compose.ix`       | higher-order composition                      | IC    | `41`   |
| `03_const_parameter_twice.ix`      | const call-site specialization                | IC    | `42`   |
| `04_const_capture_snapshot.ix`     | binding-time const capture                    | IC    | `42`   |
| `05_static_recursion_factorial.ix` | statically reducible recursion                | IC    | `42`   |
| `06_generic_type_constructor.ix`   | curried union type constructor                | IC    | `42`   |
| `07_struct_fact_checker.ix`        | structural struct constraint                  | IC    | `42`   |
| `08_union_fact_checker.ix`         | structural union constraint                   | IC    | `42`   |
| `09_type_pattern_check.ix`         | compile-time type pattern                     | IC    | `42`   |
| `10_extensions_and_protocols.ix`   | lexical extension and protocol specialization | IC    | `42`   |

## Functions And Control Flow

| Example                          | Focus                             | Route | Result            |
| -------------------------------- | --------------------------------- | ----- | ----------------- |
| `01_closure_capture.ix`          | runtime capture before shadowing  | IC    | `43`              |
| `02_returned_closure.ix`         | closure returned from a function  | IC    | `42`              |
| `03_closure_local_shadow.ix`     | closure-local assignment          | IC    | `42`              |
| `04_recursive_fibonacci.ix`      | non-tail recursive function       | Core  | `8`               |
| `05_tail_recursive_gcd.ix`       | tail recursion and remainder      | Core  | `42`              |
| `06_runtime_selected_closure.ix` | runtime-selected `Int` closure    | Core  | `22` / `42`       |
| `07_selected_i64_closure.ix`     | runtime-selected `I64` closure    | Core  | `22i64` / `42i64` |
| `08_no_else_fallthrough.ix`      | dynamic no-else fallthrough       | Core  | `42` / `1`        |
| `09_nested_control_flow.ix`      | nested dynamic statements         | Core  | `42` / `21`       |
| `10_union_selected_closure.ix`   | runtime union selecting a closure | Core  | `42`              |

## Data And Text

| Example                          | Focus                                | Route | Result      |
| -------------------------------- | ------------------------------------ | ----- | ----------- |
| `01_struct_fields.ix`            | typed struct construction and fields | Core  | `39`        |
| `02_projected_struct_update.ix`  | pure struct update                   | Core  | `42`        |
| `03_nested_structs.ix`           | nested typed structures              | IC    | `42`        |
| `04_dynamic_struct_branch.ix`    | host-selected struct value           | Core  | `42`        |
| `05_struct_runtime_index.ix`     | checked runtime struct index         | Core  | `20` / `22` |
| `06_struct_index_assignment.ix`  | aggregate rebuild by index           | Core  | `42`        |
| `07_generic_option.ix`           | generic union and `if let`           | Core  | `42`        |
| `08_dynamic_union_result.ix`     | materialized runtime union           | Core  | `42`        |
| `09_union_struct_payload.ix`     | struct payload extraction            | Core  | `42`        |
| `10_text_append_and_bytes.ix`    | append, length, and UTF-8 indexing   | Core  | `112`       |
| `11_text_slices_and_equality.ix` | slicing, rebuilding, and equality    | Core  | `42`        |
| `12_dynamic_text_branch.ix`      | host-selected visible text           | Core  | `5` / `3`   |

## Loops And Collections

| Example                      | Focus                          | Route | Result     |
| ---------------------------- | ------------------------------ | ----- | ---------- |
| `01_range_sum.ix`            | range loop with carried state  | Core  | `10`       |
| `02_stepped_range.ix`        | explicit positive step         | Core  | `42`       |
| `03_dynamic_range_bound.ix`  | host-provided loop bound       | Core  | `6` / `21` |
| `04_break.ix`                | loop break                     | Core  | `42`       |
| `05_continue.ix`             | loop continue                  | Core  | `42`       |
| `06_nested_ranges.ix`        | nested loop scopes             | Core  | `42`       |
| `07_struct_collection.ix`    | aggregate collection iteration | Core  | `42`       |
| `08_text_byte_collection.ix` | UTF-8 byte iteration           | Core  | `198`      |

## Ownership And Modules

| Example                           | Focus                                                   | Route | Result |
| --------------------------------- | ------------------------------------------------------- | ----- | ------ |
| `01_linear_scalar.ix`             | exactly-once scalar consumption                         | Core  | `42`   |
| `02_borrowed_text_read.ix`        | bounded text borrow                                     | Core  | `42`   |
| `03_scratch_cleanup.ix`           | scratch lifetime returning a scalar                     | Core  | `42`   |
| `04_freeze_and_share.ix`          | immutable sharing                                       | Core  | `42`   |
| `05_host_ownership_contracts.ix`  | bounded borrow and ownership transfer ABI               | Core  | `42`   |
| `06_multi_file_capability_app.ix` | explicit dependency import and module capability object | Core  | `42`   |

## Effects

| Example                       | Focus                                    | Route | Result |
| ----------------------------- | ---------------------------------------- | ----- | ------ |
| `handlers/01_local_counter.ix` | deep stateful Ix-defined effect handler | Core  | `42`   |

## Showcases

| Example                           | Focus                                                         | Route | Result |
| --------------------------------- | ------------------------------------------------------------- | ----- | ------ |
| `01_numeric_toolkit.ix`           | composition, comptime, and recursion                          | IC    | `42`   |
| `02_text_analyzer.ix`             | slicing, append, equality, and byte loop                      | Core  | `42`   |
| `03_geometry_transform.ix`        | typed points and pure updates                                 | Core  | `42`   |
| `04_result_pipeline.ix`           | generic union with struct payload                             | Core  | `42`   |
| `05_linear_host_session.ix`       | scratch promotion, freeze, linear capability, and host borrow | Core  | `42`   |
| `06_modular_score_application.ix` | import, module application, and compile-time closure          | IC    | `42`   |

## Expected Failures

`failures/compile/` contains 12 programs that demonstrate rejected linear use,
type errors, aggregate errors, ownership violations, frozen mutation, and import
validation. `failures/traps/` contains four valid programs that trap at runtime:
explicit panic, text and struct bounds failures, and a dynamically zero loop
step. These are executable specifications and are checked by `examples.test.ts`.
