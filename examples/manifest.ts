type ExampleHostValue =
  | { kind: "integer"; value: number }
  | { kind: "resource"; id: number };

type ExampleCapability = {
  $resource: Extract<ExampleHostValue, { kind: "resource" }>;
  [operation: string]:
    | Extract<ExampleHostValue, { kind: "resource" }>
    | (() => ExampleHostValue);
};

type ExampleInit = Record<string, ExampleCapability>;

export type ExampleRun = {
  name?: string;
  expected: number | bigint;
  init?: () => ExampleInit;
};

export type SuccessExample = {
  path: string;
  runs: ExampleRun[];
};

export type CompileFailureExample = {
  path: string;
  message: string;
};

export type TrapExample = {
  path: string;
  init?: () => ExampleInit;
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
      init: () => ({
        Input: {
          $resource: { kind: "resource", id: 1 },
          flag: () => ({ kind: "integer", value: 1 }),
        },
      }),
    },
    {
      name: "flag_false",
      expected: when_false,
      init: () => ({
        Input: {
          $resource: { kind: "resource", id: 1 },
          flag: () => ({ kind: "integer", value: 0 }),
        },
      }),
    },
  ];
}

export const success_examples: SuccessExample[] = [
  {
    path: "examples/basics/01_arithmetic_and_shadowing.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/02_type_changing_shadowing.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/03_numeric_primitives.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/04_comparisons_and_logic.duck",
    runs: run(42),
  },
  { path: "examples/basics/05_i64_pipeline.duck", runs: run(42n) },
  {
    path: "examples/basics/06_functions_and_blocks.duck",
    runs: run(42),
  },
  { path: "examples/basics/07_early_return.duck", runs: run(42) },
  {
    path: "examples/basics/08_dynamic_condition.duck",
    runs: flag_runs(21, 41),
  },
  {
    path: "examples/basics/09_literals.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/10_else_if.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/11_no_demand_bindings.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/12_value_packs_and_tuples.duck",
    runs: run(42),
  },
  {
    path: "examples/basics/13_loop_keyword.duck",
    runs: run(42),
  },

  {
    path: "examples/compile_time/01_comptime_adder.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/02_higher_order_compose.duck",
    runs: run(41),
  },
  {
    path: "examples/compile_time/03_const_parameter_twice.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/04_const_capture_snapshot.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/05_static_recursion_factorial.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/06_generic_type_constructor.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/07_struct_fact_checker.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/08_union_fact_checker.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/09_type_pattern_check.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/10_extensions_and_protocols.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/11_indexed_calculator.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/12_type_specialization.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/13_derived_nested_equality.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/14_rank_n_identity.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/15_open_imports.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/16_attributes_and_import_meta.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/17_newtypes_and_literal_types.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/18_ducks_and_operators.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/19_include_and_type_of.duck",
    runs: run(21),
  },
  {
    path: "examples/compile_time/20_variadic_value_packs.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/21_type_patterns.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/22_generic_extension.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/23_derived_sequence.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/24_comptime_stack_module.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/25_source_derive_attribute.duck",
    runs: run(42),
  },
  {
    path: "examples/compile_time/26_comptime_pipeline.duck",
    runs: run(42),
  },

  {
    path: "examples/functions/01_closure_capture.duck",
    runs: run(43),
  },
  {
    path: "examples/functions/02_returned_closure.duck",
    runs: run(42),
  },
  {
    path: "examples/functions/03_closure_local_shadow.duck",
    runs: run(42),
  },
  {
    path: "examples/functions/04_recursive_fibonacci.duck",
    runs: run(8),
  },
  {
    path: "examples/functions/05_tail_recursive_gcd.duck",
    runs: run(42),
  },
  {
    path: "examples/functions/06_runtime_selected_closure.duck",
    runs: flag_runs(22, 42),
  },
  {
    path: "examples/functions/07_selected_i64_closure.duck",
    runs: flag_runs(22n, 42n),
  },
  {
    path: "examples/functions/08_no_else_fallthrough.duck",
    runs: flag_runs(42, 1),
  },
  {
    path: "examples/functions/09_nested_control_flow.duck",
    runs: flag_runs(42, 21),
  },
  {
    path: "examples/functions/10_union_selected_closure.duck",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/functions/11_mutual_recursion.duck",
    runs: run(2),
  },
  {
    path: "examples/functions/12_let_else_return.duck",
    runs: run(49),
  },

  { path: "examples/data/01_struct_fields.duck", runs: run(39) },
  {
    path: "examples/data/02_projected_struct_update.duck",
    runs: run(42),
  },
  { path: "examples/data/03_nested_structs.duck", runs: run(42) },
  {
    path: "examples/data/04_dynamic_struct_branch.duck",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/data/05_struct_runtime_index.duck",
    runs: [
      {
        name: "first",
        expected: 20,
        init: () => ({
          Input: {
            $resource: { kind: "resource", id: 1 },
            index: () => ({ kind: "integer", value: 0 }),
          },
        }),
      },
      {
        name: "second",
        expected: 22,
        init: () => ({
          Input: {
            $resource: { kind: "resource", id: 1 },
            index: () => ({ kind: "integer", value: 1 }),
          },
        }),
      },
    ],
  },
  {
    path: "examples/data/06_struct_index_assignment.duck",
    runs: run(42),
  },
  {
    path: "examples/data/07_generic_option.duck",
    runs: run(42),
  },
  {
    path: "examples/data/08_dynamic_union_result.duck",
    runs: run(42),
  },
  {
    path: "examples/data/09_union_struct_payload.duck",
    runs: run(42),
  },
  {
    path: "examples/data/10_text_append_and_bytes.duck",
    runs: run(112),
  },
  {
    path: "examples/data/11_text_slices_and_equality.duck",
    runs: run(42),
  },
  {
    path: "examples/data/12_dynamic_text_branch.duck",
    runs: flag_runs(5, 3),
  },
  { path: "examples/data/13_type_rows.duck", runs: run(42) },
  { path: "examples/data/14_type_sets.duck", runs: run(42) },
  {
    path: "examples/data/15_packed_integers.duck",
    runs: run(2),
  },
  {
    path: "examples/data/16_struct_constructor_and_shape.duck",
    runs: run(42),
  },
  {
    path: "examples/data/17_match_patterns.duck",
    runs: run(42),
  },
  {
    path: "examples/data/18_const_value_patterns.duck",
    runs: run(42),
  },
  {
    path: "examples/data/19_recursive_union_tree.duck",
    runs: run(42),
  },

  { path: "examples/loops/01_range_sum.duck", runs: run(10) },
  {
    path: "examples/loops/02_stepped_range.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/03_dynamic_range_bound.duck",
    runs: [
      {
        name: "bound_four",
        expected: 6,
        init: () => ({
          Input: {
            $resource: { kind: "resource", id: 1 },
            bound: () => ({ kind: "integer", value: 4 }),
          },
        }),
      },
      {
        name: "bound_seven",
        expected: 21,
        init: () => ({
          Input: {
            $resource: { kind: "resource", id: 1 },
            bound: () => ({ kind: "integer", value: 7 }),
          },
        }),
      },
    ],
  },
  { path: "examples/loops/04_break.duck", runs: run(42) },
  { path: "examples/loops/05_continue.duck", runs: run(42) },
  {
    path: "examples/loops/06_nested_ranges.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/07_struct_collection.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/08_text_byte_collection.duck",
    runs: run(198),
  },
  {
    path: "examples/loops/09_loop_expression_syntax.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/10_fold_function.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/11_refutable_collection_pattern.duck",
    runs: run(6),
  },
  {
    path: "examples/loops/12_let_else_continue.duck",
    runs: run(42),
  },
  {
    path: "examples/loops/13_let_else_break.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/01_linear_scalar.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/02_borrowed_text_read.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/03_scratch_cleanup.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/04_freeze_and_share.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/05_host_ownership_contracts.duck",
    runs: [{
      expected: 42,
      init: () => ({
        Host: {
          $resource: { kind: "resource", id: 1 },
          read: () => ({ kind: "integer", value: 20 }),
          take: () => ({ kind: "integer", value: 22 }),
        },
      }),
    }],
  },
  {
    path: "examples/ownership_modules/06_multi_file_capability_app.duck",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/07_local_module_binding.duck",
    runs: run(42),
  },

  {
    path: "examples/handlers/01_local_counter.duck",
    runs: run(42),
  },
  {
    path: "examples/handlers/02_inferred_option_do.duck",
    runs: run(42),
  },
  {
    path: "examples/handlers/03_composed_default_handlers.duck",
    runs: run(42),
  },
  {
    path: "examples/handlers/04_output_builder.duck",
    runs: run(42),
  },

  {
    path: "examples/showcases/01_numeric_toolkit.duck",
    runs: run(42),
  },
  {
    path: "examples/showcases/02_text_analyzer.duck",
    runs: run(42),
  },
  {
    path: "examples/showcases/03_geometry_transform.duck",
    runs: run(42),
  },
  {
    path: "examples/showcases/04_result_pipeline.duck",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/showcases/05_linear_host_session.duck",
    runs: [{
      expected: 42,
      init: () => ({
        Host: {
          $resource: { kind: "resource", id: 1 },
          print: () => ({ kind: "integer", value: 42 }),
        },
      }),
    }],
  },
  {
    path: "examples/showcases/06_modular_score_application.duck",
    runs: run(42),
  },
  {
    path: "examples/showcases/07_domain_abstractions.duck",
    runs: run(42),
  },
  {
    path: "examples/showcases/08_command_reducer.duck",
    runs: run(42),
  },
];

export const compile_failure_examples: CompileFailureExample[] = [
  {
    path: "examples/failures/compile/01_reused_linear_value.duck",
    message: "was already consumed",
  },
  {
    path: "examples/failures/compile/02_unused_linear_value.duck",
    message: "was not consumed",
  },
  {
    path: "examples/failures/compile/03_illegal_type_change.duck",
    message: "Assignment changes type for value",
  },
  {
    path: "examples/failures/compile/04_mixed_integer_widths.duck",
    message: "Mixed i32 and i64",
  },
  {
    path: "examples/failures/compile/05_invalid_condition_type.duck",
    message: "requires a Bool or I32 condition",
  },
  {
    path: "examples/failures/compile/06_missing_struct_field.duck",
    message: "Missing struct field: age",
  },
  {
    path: "examples/failures/compile/07_invalid_union_payload.duck",
    message: "type mismatch: expected Int, received $FunctionalText",
  },
  {
    path: "examples/failures/compile/12_missing_imported_export.duck",
    message: "Missing specialized module export: missing",
  },
  {
    path: "examples/failures/compile/13_runtime_value_pattern.duck",
    message: "Value pattern requires a compile-time expression: runtime",
  },
];

export const trap_examples: TrapExample[] = [
  { path: "examples/failures/traps/01_explicit_panic.duck" },
  {
    path: "examples/failures/traps/02_text_out_of_bounds.duck",
    init: () => ({
      Input: {
        $resource: { kind: "resource", id: 1 },
        index: () => ({ kind: "integer", value: 2 }),
      },
    }),
  },
  {
    path: "examples/failures/traps/03_struct_index_out_of_bounds.duck",
    init: () => ({
      Input: {
        $resource: { kind: "resource", id: 1 },
        index: () => ({ kind: "integer", value: 3 }),
      },
    }),
  },
  {
    path: "examples/failures/traps/04_zero_range_step.duck",
    init: () => ({
      Input: {
        $resource: { kind: "resource", id: 1 },
        step: () => ({ kind: "integer", value: 0 }),
      },
    }),
  },
];

export const test_example_paths = [
  "examples/testing/01_inline_tests.duck",
];

export const dependency_paths = [
  "examples/compile_time/open_module.duck",
  "examples/ownership_modules/multi_file/score_module.duck",
  "examples/failures/compile/missing_import_dependency.duck",
  "examples/effects/01_inferred_io.duck",
  "examples/effects/02_annotated_effect_row.duck",
  "examples/effects/03_cli_stdin_stdout.duck",
  "examples/effects/multi_file/host.duck",
  "examples/effects/multi_file/logger.duck",
  "examples/effects/multi_file/main.duck",
];
