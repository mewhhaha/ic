export type GpufuckBenchmarkCase = {
  path: string;
  current_route: "ic" | "core";
  expected: number;
};

export const gpufuck_benchmark_cases: readonly GpufuckBenchmarkCase[] = [
  {
    path: "examples/basics/01_arithmetic_and_shadowing.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/basics/04_comparisons_and_logic.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/basics/06_functions_and_blocks.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/basics/10_else_if.duck",
    current_route: "core",
    expected: 42,
  },
  {
    path: "examples/compile_time/02_higher_order_compose.duck",
    current_route: "ic",
    expected: 41,
  },
  {
    path: "examples/compile_time/05_static_recursion_factorial.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/functions/01_closure_capture.duck",
    current_route: "ic",
    expected: 43,
  },
  {
    path: "examples/functions/02_returned_closure.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/functions/03_closure_local_shadow.duck",
    current_route: "ic",
    expected: 42,
  },
  {
    path: "examples/functions/04_recursive_fibonacci.duck",
    current_route: "core",
    expected: 8,
  },
];
