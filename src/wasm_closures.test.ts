import {
  instantiate_wat,
  wat_from_core_source,
  wat_from_source,
} from "./wasm_test_util.ts";

Deno.test("frontend dynamic i64 closure branch compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let flag = false
let factor: I64 = 2i64
let choose = if flag {
  (x: I64) => x + factor
} else {
  (x: I64) => x + factor + 1i64
}

choose(40i64)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_i64_closure_branch",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 43n) {
    throw new Error("Expected main() -> 43n, got " + result);
  }
});

Deno.test("core first-class closures compile through WAT to Wasm", async () => {
  const dynamic_wat = wat_from_core_source(`
let flag = true
let f = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

f(40)
`);
  const dynamic_instance = await instantiate_wat(
    dynamic_wat,
    "core_first_class_closure_dynamic",
    {},
  );

  if (!("main" in dynamic_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_result = dynamic_instance.exports.main();

  if (dynamic_result !== 41) {
    throw new Error("Expected main() -> 41, got " + dynamic_result);
  }

  const frozen_wat = wat_from_core_source(`
let f = freeze ((x: Int) => x + 1)
f(41)
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_first_class_closure_freeze",
    {},
  );

  if (!("main" in frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const frozen_result = frozen_instance.exports.main();

  if (frozen_result !== 42) {
    throw new Error("Expected frozen main() -> 42, got " + frozen_result);
  }

  const scratch_frozen_wat = wat_from_core_source(`
let f = scratch { freeze ((x: Int) => x + 1) }
f(41)
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_first_class_closure_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 42) {
    throw new Error(
      "Expected scratch frozen main() -> 42, got " + scratch_frozen_result,
    );
  }

  const block_scratch_frozen_wat = wat_from_core_source(`
let f = scratch {
  let inner = (x: Int) => x + 1
  freeze inner
}
f(41)
`);
  const block_scratch_frozen_instance = await instantiate_wat(
    block_scratch_frozen_wat,
    "core_first_class_closure_block_scratch_freeze",
    {},
  );

  if (!("main" in block_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof block_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const block_scratch_frozen_result = block_scratch_frozen_instance.exports
    .main();

  if (block_scratch_frozen_result !== 42) {
    throw new Error(
      "Expected block scratch frozen main() -> 42, got " +
        block_scratch_frozen_result,
    );
  }

  const branch_scratch_frozen_wat = wat_from_core_source(`
let flag = false
let f = scratch {
  if flag {
    freeze ((x: Int) => x + 1)
  } else {
    freeze ((x: Int) => x + 2)
  }
}
f(41)
`);
  const branch_scratch_frozen_instance = await instantiate_wat(
    branch_scratch_frozen_wat,
    "core_first_class_closure_branch_scratch_freeze",
    {},
  );

  if (!("main" in branch_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof branch_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const branch_scratch_frozen_result = branch_scratch_frozen_instance.exports
    .main();

  if (branch_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected branch scratch frozen main() -> 43, got " +
        branch_scratch_frozen_result,
    );
  }

  const if_let_matching_wat = wat_from_core_source(`
let flag = true
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result: result_type = if flag {
  \`Ok (40)
} else {
  \`Err (1)
}

let f = if let \`Ok value = result {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`);
  const if_let_matching_instance = await instantiate_wat(
    if_let_matching_wat,
    "core_first_class_closure_if_let_matching",
    {},
  );

  if (!("main" in if_let_matching_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof if_let_matching_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const if_let_matching_result = if_let_matching_instance.exports.main();

  if (if_let_matching_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + if_let_matching_result,
    );
  }

  const if_let_fallback_wat = wat_from_core_source(`
let flag = false
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result: result_type = if flag {
  \`Ok (40)
} else {
  \`Err (1)
}

let f = if let \`Ok value = result {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`);
  const if_let_fallback_instance = await instantiate_wat(
    if_let_fallback_wat,
    "core_first_class_closure_if_let_fallback",
    {},
  );

  if (!("main" in if_let_fallback_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof if_let_fallback_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const if_let_fallback_result = if_let_fallback_instance.exports.main();

  if (if_let_fallback_result !== 3) {
    throw new Error(
      "Expected main() -> 3, got " + if_let_fallback_result,
    );
  }

  const capture_wat = wat_from_core_source(`
let flag = false
let n = 2
let f = if flag {
  (x: Int) => x + n
} else {
  (x: Int) => x + n + 1
}

n = 100
f(40)
`);
  const capture_instance = await instantiate_wat(
    capture_wat,
    "core_first_class_closure_capture",
    {},
  );

  if (!("main" in capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const capture_result = capture_instance.exports.main();

  if (capture_result !== 43) {
    throw new Error("Expected main() -> 43, got " + capture_result);
  }

  const dynamic_text_capture_wat = wat_from_core_source(`
let flag = true
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let make = (value: Text) => {
  if flag {
    (x: Int) => @len(value) + x
  } else {
    (x: Int) => x
  }
}

let f = make(message)
f(1)
`);
  const dynamic_text_capture_instance = await instantiate_wat(
    dynamic_text_capture_wat,
    "core_first_class_closure_dynamic_text_capture",
    {},
  );

  if (!("main" in dynamic_text_capture_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_text_capture_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_text_capture_result = dynamic_text_capture_instance.exports
    .main();

  if (dynamic_text_capture_result !== 4) {
    throw new Error(
      "Expected main() -> 4, got " + dynamic_text_capture_result,
    );
  }

  const captured_text_assign_wat = wat_from_core_source(`
let run = (text: Bytes, flag: Int) => {
  let f = if flag {
    (byte: Int) => {
      text[0] = byte
      text[0]
    }
  } else {
    (byte: Int) => text[0]
  }

  f(90)
}

run(@Utf8.encode("Ada"), 1)
`);
  const captured_text_assign_instance = await instantiate_wat(
    captured_text_assign_wat,
    "core_first_class_closure_captured_text_assign",
    {},
  );

  if (!("main" in captured_text_assign_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_text_assign_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_text_assign_result = captured_text_assign_instance.exports
    .main();

  if (captured_text_assign_result !== 90) {
    throw new Error(
      "Expected main() -> 90, got " + captured_text_assign_result,
    );
  }

  const captured_closure_wat = wat_from_core_source(`
let flag = true
let add = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}
let shared_add = freeze add
let run = (y: Int) => shared_add(y) + 10

run(30)
`);
  const captured_closure_instance = await instantiate_wat(
    captured_closure_wat,
    "core_first_class_closure_captures_closure",
    {},
  );

  if (!("main" in captured_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_closure_result = captured_closure_instance.exports.main();

  if (captured_closure_result !== 41) {
    throw new Error(
      "Expected main() -> 41, got " + captured_closure_result,
    );
  }

  const assigned_capture_wat = wat_from_core_source(`
let flag = true
let factor = 2
let f = if flag {
  (x: Int) => {
    factor = factor + x
    factor
  }
} else {
  (x: Int) => {
    factor = factor + x + 1
    factor
  }
}

factor = 100
f(10) + f(20) + factor
`);
  const assigned_capture_instance = await instantiate_wat(
    assigned_capture_wat,
    "core_first_class_closure_assigned_capture",
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

  const returned_closure_wat = wat_from_core_source(`
let make = n => {
  let offset = n + 1
  (x: Int) => x + offset
}

let f = make(1)
f(40)
`);
  const returned_closure_instance = await instantiate_wat(
    returned_closure_wat,
    "core_first_class_closure_returned_from_static_call",
    {},
  );

  if (!("main" in returned_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof returned_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const returned_closure_result = returned_closure_instance.exports.main();

  if (returned_closure_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + returned_closure_result,
    );
  }

  const returned_wide_closure_wat = wat_from_core_source(`
let make = (n: I64) => {
  let offset: I64 = n + 1i64
  (x: I64) => x + offset
}

let f = make(1i64)
f(40i64)
`);
  const returned_wide_closure_instance = await instantiate_wat(
    returned_wide_closure_wat,
    "core_first_class_wide_closure_returned_from_static_call",
    {},
  );

  if (!("main" in returned_wide_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof returned_wide_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const returned_wide_closure_result = returned_wide_closure_instance.exports
    .main();

  if (returned_wide_closure_result !== 42n) {
    throw new Error(
      "Expected main() -> 42n, got " + returned_wide_closure_result,
    );
  }
});
