import { TestSource as Source } from "./frontend/test_source.ts";
import {
  instantiate_wat,
  wat_from_core_source,
  wat_from_source,
} from "./wasm_test_util.ts";

Deno.test("frontend dynamic runtime i32 slice loop compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
let length = 2
let sum = 0
for index, value in runtime_i32_slice(length, 10, 20, 30) {
  sum = sum + index + value
}
sum
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_dynamic_runtime_i32_slice_loop",
    {},
  );

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 31) {
    throw new Error("Expected runtime slice sum 31, got " + result);
  }
});

Deno.test("frontend static range loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let sum = 0

for i in 0..5 {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(wat_text, "range_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("open recursive Ic fib compiles through WAT to Wasm", async () => {
  const wat_text = Source.ic_wat(`
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(input)
`);
  const instance = await instantiate_wat(
    wat_text,
    "open_ic_recursive_fib",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main(6);

  if (result !== 8) {
    throw new Error("Expected recursive Ic main(6) -> 8, got " + result);
  }
});

Deno.test("frontend static text collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let total = 0

for byte in "Ada" {
  total = total + byte
}

total
`);
  const instance = await instantiate_wat(wat_text, "text_collection_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 262) {
    throw new Error("Expected main() -> 262, got " + result);
  }

  const runtime_arg_wat = wat_from_source(`
let sum_text = (value: Text) => {
  let total = 0

  for i, byte in value {
    total = total + i + byte
  }

  total
}

sum_text("Ada")
`);
  const runtime_arg_instance = await instantiate_wat(
    runtime_arg_wat,
    "frontend_text_collection_runtime_arg",
    {},
  );

  if (!("main" in runtime_arg_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof runtime_arg_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const runtime_arg_result = runtime_arg_instance.exports.main();

  if (runtime_arg_result !== 265) {
    throw new Error(
      "Expected main() -> 265, got " + runtime_arg_result,
    );
  }
});

Deno.test("core dynamic range loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(wat_text, "core_range_loop", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("core dynamic range step compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 6
let step = 2
let sum = 0

for i in 0..n by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 6) {
    throw new Error("Expected main() -> 6, got " + result);
  }
});

Deno.test("core negative dynamic range step compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let start = 5
let stop = 0
let step = -2
let sum = 0

for i in start..stop by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_negative_dynamic_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 9) {
    throw new Error("Expected main() -> 9, got " + result);
  }
});

Deno.test("core dynamic zero range step traps through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let step = 0
let sum = 0

for i in 0..n by step {
  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_zero_range_step",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for dynamic zero range step");
});

Deno.test("core range loop break and continue compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let n = 5
let sum = 0

for i in 0..n {
  if i == 3 {
    break
  }

  if i == 1 {
    continue
  }

  sum = sum + i
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_range_loop_edges",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2) {
    throw new Error("Expected main() -> 2, got " + result);
  }
});

Deno.test("core dynamic tail recursion compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum_down = rec (n, total) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

let input = 4
sum_down(input, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_tail_rec",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("frontend annotated dynamic tail recursion compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum_down = rec (n: Int, total: Int) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

sum_down(5, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_annotated_dynamic_tail_rec",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 15) {
    throw new Error("Expected main() -> 15, got " + result);
  }
});

Deno.test("frontend named tail recursion compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let rec sum_down = (n, total) => {
  if n == 0 {
    total
  } else {
    sum_down(n - 1, total + n)
  }
}

sum_down(5, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_named_tail_rec",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 15) {
    throw new Error("Expected main() -> 15, got " + result);
  }
});

Deno.test("core static collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let sum = 0

for i, x in { first: 10, second: 32, third: 7 } {
  if i == 1 {
    continue
  }

  if x == 7 {
    break
  }

  sum = sum + i + x
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 10) {
    throw new Error("Expected main() -> 10, got " + result);
  }
});

Deno.test("core visible text collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let total = 0

for i, byte in "Ada" {
  if i == 1 {
    continue
  }

  if byte == 97 {
    break
  }

  total = total + byte
}

total
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 65) {
    throw new Error("Expected main() -> 65, got " + result);
  }

  const closure_wat = wat_from_core_source(`
let sum_text = (value: Text) => {
  let total = 0

  for byte in value {
    total = total + byte
  }

  total
}

sum_text("Ada")
`);
  const closure_instance = await instantiate_wat(
    closure_wat,
    "core_text_collection_let_closure",
    {},
  );

  if (!("main" in closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const closure_result = closure_instance.exports.main();

  if (closure_result !== 262) {
    throw new Error("Expected main() -> 262, got " + closure_result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let sum_text = if flag {
  (value: Text) => {
    let total = 0

    for i, byte in value {
      total = total + i + byte
    }

    total
  }
} else {
  (value: Text) => len(value)
}

sum_text("Ada")
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_first_class_text_collection_loop",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 265) {
    throw new Error("Expected main() -> 265, got " + first_class_result);
  }

  const capture_wat = wat_from_core_source(`
let factor = 2
let scale = x => x + factor
factor = 3
scale(10)
`);
  const capture_instance = await instantiate_wat(
    capture_wat,
    "core_runtime_capture_let_closure",
    {},
  );

  if (!("main" in capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const capture_result = capture_instance.exports.main();

  if (capture_result !== 12) {
    throw new Error("Expected main() -> 12, got " + capture_result);
  }

  const param_assign_wat = wat_from_core_source(`
let inc = x => {
  x = x + 1
  x
}

inc(41)
`);
  const param_assign_instance = await instantiate_wat(
    param_assign_wat,
    "core_closure_parameter_assignment",
    {},
  );

  if (!("main" in param_assign_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof param_assign_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const param_assign_result = param_assign_instance.exports.main();

  if (param_assign_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + param_assign_result,
    );
  }

  const local_shadow_wat = wat_from_core_source(`
let factor = 2
let f = x => {
  let factor = x
  factor
}

f(10) + factor
`);
  const local_shadow_instance = await instantiate_wat(
    local_shadow_wat,
    "core_closure_local_shadow",
    {},
  );

  if (!("main" in local_shadow_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof local_shadow_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const local_shadow_result = local_shadow_instance.exports.main();

  if (local_shadow_result !== 12) {
    throw new Error("Expected main() -> 12, got " + local_shadow_result);
  }

  const assigned_capture_wat = wat_from_core_source(`
let factor = 2
let f = x => {
  factor = factor + x
  factor
}

factor = 100
f(10) + f(20) + factor
`);
  const assigned_capture_instance = await instantiate_wat(
    assigned_capture_wat,
    "core_static_closure_assigned_capture",
    {},
  );

  if (!("main" in assigned_capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof assigned_capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const assigned_capture_result = assigned_capture_instance.exports.main();

  if (assigned_capture_result !== 134) {
    throw new Error(
      "Expected main() -> 134, got " + assigned_capture_result,
    );
  }
});

Deno.test("core static-call block collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

const sum = (pair: pair_type) => {
  let total = 0

  for i, x in pair {
    total = total + i + x
  }

  total
}

sum({
  first: 10,
  second: 31
})
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_call_block_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected main() -> 42, got " + result);
  }
});

Deno.test("core dynamic shaped collection loop compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let sum = 0

for i, x in if flag {
  { first: 10, second: 20 }
} else {
  { first: 1, second: 2 }
} {
  sum = sum + i + x
}

sum
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_shaped_collection_loop",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 31) {
    throw new Error("Expected main() -> 31, got " + result);
  }

  const const_call_wat = wat_from_core_source(`
let flag = 1
let sum = 0

const make_xs = active => {
  if active {
    { first: 10, second: 20 }
  } else {
    { first: 1, second: 2 }
  }
}

for i, x in make_xs(flag) {
  sum = sum + i + x
}

sum
`);
  const const_call = await instantiate_wat(
    const_call_wat,
    "core_const_call_shaped_collection_loop",
    {},
  );

  if (!("main" in const_call.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof const_call.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const const_call_result = const_call.exports.main();

  if (const_call_result !== 31) {
    throw new Error("Expected main() -> 31, got " + const_call_result);
  }
});
