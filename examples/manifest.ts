import type { IxInitValue } from "../src/frontend.ts";

export type ExampleRoute = "ic" | "core" | "managed";

export type ExampleRun = {
  name?: string;
  expected: number | bigint;
  imports?: () => WebAssembly.Imports;
  init?: () => IxInitValue;
};

export type SuccessExample = {
  path: string;
  route: ExampleRoute;
  runs: ExampleRun[];
};

export type CompileFailureExample = {
  path: string;
  route: ExampleRoute;
  message: string;
};

export type TrapExample = {
  path: string;
  route: "core" | "managed";
  imports?: () => WebAssembly.Imports;
  init?: () => IxInitValue;
};

function run(expected: number | bigint): ExampleRun[] {
  return [{ expected }];
}

function flag_runs(
  when_true: number | bigint,
  when_false: number | bigint,
): ExampleRun[] {
  return [
    {
      name: "flag_true",
      expected: when_true,
      init: () => ({ input: { flag: () => 1 } }),
    },
    {
      name: "flag_false",
      expected: when_false,
      init: () => ({ input: { flag: () => 0 } }),
    },
  ];
}

export const success_examples: SuccessExample[] = [
  {
    path: "examples/basics/01_arithmetic_and_shadowing.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/02_type_changing_shadowing.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/03_numeric_primitives.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/04_comparisons_and_logic.ix",
    route: "ic",
    runs: run(42),
  },
  { path: "examples/basics/05_i64_pipeline.ix", route: "ic", runs: run(42n) },
  {
    path: "examples/basics/06_functions_and_blocks.ix",
    route: "ic",
    runs: run(42),
  },
  { path: "examples/basics/07_early_return.ix", route: "ic", runs: run(42) },
  {
    path: "examples/basics/08_dynamic_condition.ix",
    route: "managed",
    runs: flag_runs(21, 41),
  },
  {
    path: "examples/basics/09_literals.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/10_else_if.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/basics/11_no_demand_bindings.ix",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/compile_time/01_comptime_adder.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/02_higher_order_compose.ix",
    route: "ic",
    runs: run(41),
  },
  {
    path: "examples/compile_time/03_const_parameter_twice.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/04_const_capture_snapshot.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/05_static_recursion_factorial.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/06_generic_type_constructor.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/07_struct_fact_checker.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/08_union_fact_checker.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/09_type_pattern_check.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/10_extensions_and_protocols.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/11_indexed_calculator.ix",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/functions/01_closure_capture.ix",
    route: "ic",
    runs: run(43),
  },
  {
    path: "examples/functions/02_returned_closure.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/functions/03_closure_local_shadow.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/functions/04_recursive_fibonacci.ix",
    route: "core",
    runs: run(8),
  },
  {
    path: "examples/functions/05_tail_recursive_gcd.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/functions/06_runtime_selected_closure.ix",
    route: "managed",
    runs: flag_runs(22, 42),
  },
  {
    path: "examples/functions/07_selected_i64_closure.ix",
    route: "managed",
    runs: flag_runs(22n, 42n),
  },
  {
    path: "examples/functions/08_no_else_fallthrough.ix",
    route: "managed",
    runs: flag_runs(42, 1),
  },
  {
    path: "examples/functions/09_nested_control_flow.ix",
    route: "managed",
    runs: flag_runs(42, 21),
  },
  {
    path: "examples/functions/10_union_selected_closure.ix",
    route: "managed",
    runs: flag_runs(42, 42),
  },

  { path: "examples/data/01_struct_fields.ix", route: "core", runs: run(39) },
  {
    path: "examples/data/02_projected_struct_update.ix",
    route: "core",
    runs: run(42),
  },
  { path: "examples/data/03_nested_structs.ix", route: "ic", runs: run(42) },
  {
    path: "examples/data/04_dynamic_struct_branch.ix",
    route: "managed",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/data/05_struct_runtime_index.ix",
    route: "managed",
    runs: [
      {
        name: "first",
        expected: 20,
        init: () => ({ input: { index: () => 0 } }),
      },
      {
        name: "second",
        expected: 22,
        init: () => ({ input: { index: () => 1 } }),
      },
    ],
  },
  {
    path: "examples/data/06_struct_index_assignment.ix",
    route: "core",
    runs: run(42),
  },
  { path: "examples/data/07_generic_option.ix", route: "core", runs: run(42) },
  {
    path: "examples/data/08_dynamic_union_result.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/09_union_struct_payload.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/10_text_append_and_bytes.ix",
    route: "core",
    runs: run(112),
  },
  {
    path: "examples/data/11_text_slices_and_equality.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/12_dynamic_text_branch.ix",
    route: "managed",
    runs: flag_runs(5, 3),
  },
  { path: "examples/data/13_type_rows.ix", route: "core", runs: run(42) },
  { path: "examples/data/14_type_sets.ix", route: "core", runs: run(42) },

  { path: "examples/loops/01_range_sum.ix", route: "core", runs: run(10) },
  { path: "examples/loops/02_stepped_range.ix", route: "core", runs: run(42) },
  {
    path: "examples/loops/03_dynamic_range_bound.ix",
    route: "managed",
    runs: [
      {
        name: "bound_four",
        expected: 6,
        init: () => ({ input: { bound: () => 4 } }),
      },
      {
        name: "bound_seven",
        expected: 21,
        init: () => ({ input: { bound: () => 7 } }),
      },
    ],
  },
  { path: "examples/loops/04_break.ix", route: "core", runs: run(42) },
  { path: "examples/loops/05_continue.ix", route: "core", runs: run(42) },
  { path: "examples/loops/06_nested_ranges.ix", route: "core", runs: run(42) },
  {
    path: "examples/loops/07_struct_collection.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/08_text_byte_collection.ix",
    route: "core",
    runs: run(198),
  },
  {
    path: "examples/loops/09_loop_expression_syntax.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/10_fold_function.ix",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/ownership_modules/01_linear_scalar.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/02_borrowed_text_read.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/03_scratch_cleanup.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/04_freeze_and_share.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/05_host_ownership_contracts.ix",
    route: "managed",
    runs: [{
      expected: 42,
      init: () => ({ host: { read: () => 20, take: () => 22 } }),
    }],
  },
  {
    path: "examples/ownership_modules/06_multi_file_capability_app.ix",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/handlers/01_local_counter.ix",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/showcases/01_numeric_toolkit.ix",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/showcases/02_text_analyzer.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/showcases/03_geometry_transform.ix",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/showcases/04_result_pipeline.ix",
    route: "managed",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/showcases/05_linear_host_session.ix",
    route: "managed",
    runs: [{
      expected: 42,
      init: () => ({ host: { print: () => 42 } }),
    }],
  },
  {
    path: "examples/showcases/06_modular_score_application.ix",
    route: "ic",
    runs: run(42),
  },
];

export const compile_failure_examples: CompileFailureExample[] = [
  {
    path: "examples/failures/compile/01_reused_linear_value.ix",
    route: "core",
    message: "was already consumed",
  },
  {
    path: "examples/failures/compile/02_unused_linear_value.ix",
    route: "core",
    message: "was not consumed",
  },
  {
    path: "examples/failures/compile/03_illegal_type_change.ix",
    route: "ic",
    message: "Assignment changes type for value",
  },
  {
    path: "examples/failures/compile/04_mixed_integer_widths.ix",
    route: "core",
    message: "Mixed i32 and i64",
  },
  {
    path: "examples/failures/compile/05_invalid_condition_type.ix",
    route: "ic",
    message: "If condition expects Bool or I32, got Text",
  },
  {
    path: "examples/failures/compile/06_missing_struct_field.ix",
    route: "ic",
    message: "Missing struct field: age",
  },
  {
    path: "examples/failures/compile/07_invalid_union_payload.ix",
    route: "core",
    message: "expects Int, got Text",
  },
  {
    path: "examples/failures/compile/08_escaping_borrow.ix",
    route: "core",
    message: "borrow",
  },
  {
    path: "examples/failures/compile/09_freeze_while_borrowed.ix",
    route: "core",
    message: "Cannot freeze borrowed owner",
  },
  {
    path: "examples/failures/compile/10_scratch_heap_escape.ix",
    route: "core",
    message: "cannot leave scratch",
  },
  {
    path: "examples/failures/compile/11_frozen_mutation.ix",
    route: "core",
    message: "frozen",
  },
  {
    path: "examples/failures/compile/12_missing_imported_export.ix",
    route: "core",
    message: "does not export missing",
  },
];

export const trap_examples: TrapExample[] = [
  { path: "examples/failures/traps/01_explicit_panic.ix", route: "core" },
  {
    path: "examples/failures/traps/02_text_out_of_bounds.ix",
    route: "managed",
    init: () => ({ input: { index: () => 2 } }),
  },
  {
    path: "examples/failures/traps/03_struct_index_out_of_bounds.ix",
    route: "managed",
    init: () => ({ input: { index: () => 3 } }),
  },
  {
    path: "examples/failures/traps/04_zero_range_step.ix",
    route: "managed",
    init: () => ({ input: { step: () => 0 } }),
  },
];

export const dependency_paths = [
  "examples/ownership_modules/multi_file/score_module.ix",
  "examples/failures/compile/missing_import_dependency.ix",
  "examples/effects/01_inferred_io.ix",
  "examples/effects/02_annotated_effect_row.ix",
  "examples/effects/03_cli_stdin_stdout.ix",
  "examples/effects/multi_file/host.ix",
  "examples/effects/multi_file/logger.ix",
  "examples/effects/multi_file/main.ix",
];
