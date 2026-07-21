import {
  decoder,
  instantiate_wat,
  wat_from_core_source,
  wat_from_source,
} from "./wasm_test_util.ts";
import { assert_throws } from "./assert.ts";

Deno.test("frontend same-case shorthand union compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let input = true
let result = if input {
  \`Ok (40)
} else {
  \`Ok (1)
}

if let \`Ok value = result {
  value + 2
} else {
  7
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_same_case_shorthand_union",
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

Deno.test("core dynamic indexed runtime union facts compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
const { struct } = import "duck:prelude" ()
const choices_type = struct {
  .first= result_type,
  .second= result_type
}

let flag = true
let make = if flag {
  (first: result_type, second: result_type) => [.first = first, .second = second] as choices_type
} else {
  (first: result_type, second: result_type) => [.first = second, .second = first] as choices_type
}

let choices: choices_type = make(\`Ok (40), \`Err (2))
let index = 1
let picked: result_type = @get(choices, index)
if let \`Ok value = picked {
  value + 2
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_indexed_runtime_union_facts",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }
});

Deno.test("core runtime aggregate union index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= result_type,
  .second= result_type
}

let keep = "x"
let flag = true
let make_slots = if flag {
  (first: Int, second: Int) => [.first = \`Ok (first), .second = \`Err (second)] as slots_type
} else {
  (first: Int, second: Int) => [.first = \`Err (first), .second = \`Ok (second)] as slots_type
}
let slots: slots_type = make_slots(1, 2)
slots[0] = \`Err (40)
let i = 1
slots[i] = \`Ok (2)
slots
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_union_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return an aggregate pointer");
  }

  const view = new DataView(instance.exports.memory.buffer);
  const first = view.getInt32(result, true);
  const second = view.getInt32(result + 4, true);

  if (view.getInt32(first, true) !== 1) {
    throw new Error("Expected first union tag -> 1");
  }

  if (view.getInt32(first + 4, true) !== 40) {
    throw new Error("Expected first union payload -> 40");
  }

  if (view.getInt32(second, true) !== 0) {
    throw new Error("Expected second union tag -> 0");
  }

  if (view.getInt32(second + 4, true) !== 2) {
    throw new Error("Expected second union payload -> 2");
  }
});

Deno.test("core rejects first-class runtime aggregate union mutation capture", () => {
  assert_throws(
    () =>
      wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= result_type,
  .second= result_type
}

let keep = "x"
let flag = true
let make_slots = if flag {
  (first: Int, second: Int) => [.first = \`Ok (first), .second = \`Err (second)] as slots_type
} else {
  (first: Int, second: Int) => [.first = \`Err (first), .second = \`Ok (second)] as slots_type
}
let slots: slots_type = make_slots(1, 2)
let write = if flag {
  (i: Int, value: Int) => {
    slots[i] = \`Ok (value)
    0
  }
} else {
  (i: Int, value: Int) => {
    slots[i] = \`Err (value)
    0
  }
}

write(1, 2)
slots
`),
    "unique_heap runtime_aggregate capture requires linear closure " +
      "ownership support",
  );
});

Deno.test("core runtime scalar Text and struct union values compile through WAT to Wasm memory", async () => {
  const direct_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let keep = "x"

\`Ok (41)
`);
  const direct_instance = await instantiate_wat(
    direct_wat,
    "core_runtime_union_direct",
    {},
  );

  if (!("memory" in direct_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(direct_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in direct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof direct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const direct_result = direct_instance.exports.main();

  if (typeof direct_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const direct_view = new DataView(direct_instance.exports.memory.buffer);

  if (direct_view.getInt32(direct_result, true) !== 0) {
    throw new Error("Expected direct union tag -> 0");
  }

  if (direct_view.getInt32(direct_result + 4, true) !== 41) {
    throw new Error("Expected direct union payload -> 41");
  }

  const frozen_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result: result_type = freeze \`Ok (41)

if let \`Ok value = result {
  value + 1
} else {
  0
}
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_runtime_union_freeze",
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
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let result: result_type = scratch {
  freeze \`Ok (@append(prefix, "da"))
}

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_runtime_union_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 3) {
    throw new Error(
      "Expected scratch frozen main() -> 3, got " + scratch_frozen_result,
    );
  }

  const bound_scratch_frozen_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let result: result_type = scratch {
  let temp = \`Ok (@append(prefix, "da"))
  freeze temp
}

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const bound_scratch_frozen_instance = await instantiate_wat(
    bound_scratch_frozen_wat,
    "core_runtime_union_bound_scratch_freeze",
    {},
  );

  if (!("main" in bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof bound_scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const bound_scratch_frozen_result = bound_scratch_frozen_instance.exports
    .main();

  if (bound_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected bound scratch frozen main() -> 3, got " +
        bound_scratch_frozen_result,
    );
  }

  const branch_alias_scratch_frozen_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType

let flag = true
let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: result_type = if flag {
  \`Ok (@append(prefix, "da"))
} else {
  \`Err (5)
}
let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const branch_alias_scratch_frozen_instance = await instantiate_wat(
    branch_alias_scratch_frozen_wat,
    "core_runtime_union_branch_alias_scratch_freeze",
    {},
  );

  if (!("main" in branch_alias_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof branch_alias_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const branch_alias_scratch_frozen_result =
    branch_alias_scratch_frozen_instance.exports.main();

  if (branch_alias_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected branch alias scratch frozen main() -> 3, got " +
        branch_alias_scratch_frozen_result,
    );
  }

  const branch_assignment_scratch_frozen_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType

let flag = true
let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: result_type = \`Err (5)

if flag {
  existing = \`Ok (@append(prefix, "da"))
} else {
  existing = \`Err (7)
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const branch_assignment_scratch_frozen_instance = await instantiate_wat(
    branch_assignment_scratch_frozen_wat,
    "core_runtime_union_branch_assignment_scratch_freeze",
    {},
  );

  if (!("main" in branch_assignment_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof branch_assignment_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const branch_assignment_scratch_frozen_result =
    branch_assignment_scratch_frozen_instance.exports.main();

  if (branch_assignment_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected branch assignment scratch frozen main() -> 3, got " +
        branch_assignment_scratch_frozen_result,
    );
  }

  const aggregate_bound_scratch_frozen_wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let result: result_type = scratch {
  let temp = \`Ok ([.name = @append(prefix, "da"), .age = 40] as user_type)
  freeze temp
}

if let \`Ok user = result {
  @len(user.name) + user.age
} else {
  0
}
`);
  const aggregate_bound_scratch_frozen_instance = await instantiate_wat(
    aggregate_bound_scratch_frozen_wat,
    "core_runtime_union_aggregate_bound_scratch_freeze",
    {},
  );

  if (!("main" in aggregate_bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof aggregate_bound_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const aggregate_bound_scratch_frozen_result =
    aggregate_bound_scratch_frozen_instance.exports.main();

  if (aggregate_bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected aggregate bound scratch frozen main() -> 43, got " +
        aggregate_bound_scratch_frozen_result,
    );
  }

  const union_payload_bound_scratch_frozen_wat = wat_from_core_source(`
type InnerType = | \`Some Text | \`None Unit
const inner_type = InnerType
type OuterType = | \`Ok inner_type | \`Err Unit
const outer_type = OuterType

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let result: outer_type = scratch {
  let temp = \`Ok (\`Some (@append(prefix, "da")))
  freeze temp
}

if let \`Ok inner = result {
  if let \`Some value = inner {
    @len(value)
  } else {
    0
  }
} else {
  0
}
`);
  const union_payload_bound_scratch_frozen_instance = await instantiate_wat(
    union_payload_bound_scratch_frozen_wat,
    "core_runtime_union_payload_bound_scratch_freeze",
    {},
  );

  if (!("main" in union_payload_bound_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof union_payload_bound_scratch_frozen_instance.exports.main !==
      "function"
  ) {
    throw new Error("main export is not a function");
  }

  const union_payload_bound_scratch_frozen_result =
    union_payload_bound_scratch_frozen_instance.exports.main();

  if (union_payload_bound_scratch_frozen_result !== 3) {
    throw new Error(
      "Expected union payload bound scratch frozen main() -> 3, got " +
        union_payload_bound_scratch_frozen_result,
    );
  }

  const aggregate_union_field_bound_scratch_frozen_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType
const { struct } = import "duck:prelude" ()
const box_type = struct {
  .result= result_type,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let box: box_type = scratch {
  let temp = [.result = \`Ok (@append(prefix, "da")), .age = 40] as box_type
  freeze temp
}

if let \`Ok value = box.result {
  @len(value) + box.age
} else {
  0
}
`);
  const aggregate_union_field_bound_scratch_frozen_instance =
    await instantiate_wat(
      aggregate_union_field_bound_scratch_frozen_wat,
      "core_runtime_aggregate_union_field_bound_scratch_freeze",
      {},
    );

  if (
    !("main" in aggregate_union_field_bound_scratch_frozen_instance.exports)
  ) {
    throw new Error("Missing main export");
  }

  if (
    typeof aggregate_union_field_bound_scratch_frozen_instance.exports.main !==
      "function"
  ) {
    throw new Error("main export is not a function");
  }

  const aggregate_union_field_bound_scratch_frozen_result =
    aggregate_union_field_bound_scratch_frozen_instance.exports.main();

  if (aggregate_union_field_bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected aggregate union field bound scratch frozen main() -> 43, got " +
        aggregate_union_field_bound_scratch_frozen_result,
    );
  }

  const dynamic_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let keep = "x"
let flag = false

if flag {
  \`Ok (41)
} else {
  \`Err (7)
}
`);
  const dynamic_instance = await instantiate_wat(
    dynamic_wat,
    "core_runtime_union_dynamic",
    {},
  );

  if (!("memory" in dynamic_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(dynamic_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in dynamic_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof dynamic_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const dynamic_result = dynamic_instance.exports.main();

  if (typeof dynamic_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const dynamic_view = new DataView(dynamic_instance.exports.memory.buffer);

  if (dynamic_view.getInt32(dynamic_result, true) !== 1) {
    throw new Error("Expected dynamic union tag -> 1");
  }

  if (dynamic_view.getInt32(dynamic_result + 4, true) !== 7) {
    throw new Error("Expected dynamic union payload -> 7");
  }

  const wide_wat = wat_from_core_source(`
type ResultType = | \`Ok I64 | \`Err Unit
const result_type = ResultType

let keep = "x"

\`Ok (41i64)
`);
  const wide_instance = await instantiate_wat(
    wide_wat,
    "core_runtime_union_i64",
    {},
  );

  if (!("memory" in wide_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(wide_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in wide_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof wide_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const wide_result = wide_instance.exports.main();

  if (typeof wide_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const wide_view = new DataView(wide_instance.exports.memory.buffer);

  if (wide_view.getInt32(wide_result, true) !== 0) {
    throw new Error("Expected wide union tag -> 0");
  }

  if (wide_view.getBigInt64(wide_result + 4, true) !== 41n) {
    throw new Error("Expected wide union payload -> 41");
  }

  const text_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let keep = "x"

\`Ok ("Ada")
`);
  const text_instance = await instantiate_wat(
    text_wat,
    "core_runtime_union_text",
    {},
  );

  if (!("memory" in text_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(text_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text_instance.exports.main();

  if (typeof text_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const text_view = new DataView(text_instance.exports.memory.buffer);

  if (text_view.getInt32(text_result, true) !== 0) {
    throw new Error("Expected text union tag -> 0");
  }

  const text_payload = text_view.getInt32(text_result + 4, true);

  if (text_view.getInt32(text_payload, true) !== 3) {
    throw new Error("Expected text union payload length -> 3");
  }

  const struct_wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let keep = "x"

\`Ok ([.age = 40, .score = 2] as user_type)
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_runtime_union_struct",
    {},
  );

  if (!("memory" in struct_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(struct_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (typeof struct_result !== "number") {
    throw new Error("Expected main() to return a union pointer");
  }

  const struct_view = new DataView(struct_instance.exports.memory.buffer);

  if (struct_view.getInt32(struct_result, true) !== 0) {
    throw new Error("Expected struct union tag -> 0");
  }

  const struct_payload = struct_view.getInt32(struct_result + 4, true);

  if (struct_view.getInt32(struct_payload, true) !== 40) {
    throw new Error("Expected struct union age -> 40");
  }

  if (struct_view.getInt32(struct_payload + 4, true) !== 2) {
    throw new Error("Expected struct union score -> 2");
  }
});

Deno.test("core stored runtime union pointer if let compiles through WAT to Wasm", async () => {
  const matching_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = true
let make = if flag {
  (x: Int) => \`Ok (x)
} else {
  (x: Int) => \`Err (x)
}
let result: result_type = make(41)

if let \`Ok value = result {
  value + 1
} else {
  0
}
`);
  const matching = await instantiate_wat(
    matching_wat,
    "core_stored_runtime_union_match",
    {},
  );

  if (!("main" in matching.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof matching.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const matching_result = matching.exports.main();

  if (matching_result !== 42) {
    throw new Error("Expected main() -> 42, got " + matching_result);
  }

  const fallback_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = false
let make = if flag {
  (x: Int) => \`Ok (x)
} else {
  (x: Int) => \`Err (x)
}
let result: result_type = make(7)

if let \`Ok value = result {
  value + 1
} else {
  5
}
`);
  const fallback = await instantiate_wat(
    fallback_wat,
    "core_stored_runtime_union_fallback",
    {},
  );

  if (!("main" in fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const fallback_result = fallback.exports.main();

  if (fallback_result !== 5) {
    throw new Error("Expected main() -> 5, got " + fallback_result);
  }

  const captured_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = true
let make = if flag {
  (x: Int) => \`Ok (x)
} else {
  (x: Int) => \`Err (x)
}
let result: result_type = freeze make(41)
let read_result = if flag {
  (x: Int) => {
    if let \`Ok value = result {
      value + x
    } else {
      x
    }
  }
} else {
  (x: Int) => x
}

read_result(1)
`);
  const captured = await instantiate_wat(
    captured_wat,
    "core_captured_runtime_union",
    {},
  );

  if (!("main" in captured.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_result = captured.exports.main();

  if (captured_result !== 42) {
    throw new Error("Expected main() -> 42, got " + captured_result);
  }

  const text_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let flag = true
let make = if flag {
  (x: Text) => \`Ok (x)
} else {
  (x: Text) => \`Err ()
}
let result: result_type = make("Ada")

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const text = await instantiate_wat(
    text_wat,
    "core_stored_runtime_union_text",
    {},
  );

  if (!("main" in text.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text.exports.main();

  if (text_result !== 3) {
    throw new Error("Expected main() -> 3, got " + text_result);
  }

  const struct_wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let flag = true
let make = if flag {
  (name: Text) => \`Ok ([.name = name, .age = 40] as user_type)
} else {
  (name: Text) => \`Err ()
}
let result: result_type = make("Ada")

if let \`Ok user = result {
  @len(user.name) + user.age
} else {
  0
}
`);
  const struct = await instantiate_wat(
    struct_wat,
    "core_stored_runtime_union_struct",
    {},
  );

  if (!("main" in struct.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct.exports.main();

  if (struct_result !== 43) {
    throw new Error("Expected main() -> 43, got " + struct_result);
  }

  const nested_wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const name_type = struct {
  .first= Text,
  .last= Text
}
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= name_type,
  .age= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let flag = true
let make = if flag {
  (first: Text) => \`Ok ([.name = [.first = first, .last = "Lovelace"] as name_type, .age = 40] as user_type)
} else {
  (first: Text) => \`Err ()
}
let result: result_type = make("Ada")

if let \`Ok user = result {
  @len(user.name.first) + @len(user.name.last) + user.age
} else {
  0
}
`);
  const nested = await instantiate_wat(
    nested_wat,
    "core_stored_runtime_union_nested_struct",
    {},
  );

  if (!("main" in nested.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested.exports.main();

  if (nested_result !== 51) {
    throw new Error("Expected main() -> 51, got " + nested_result);
  }

  const aggregate_pointer_payload_wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let user: user_type = [.age = 40, .score = 2] as user_type
let result: result_type = \`Ok (user)

if let \`Ok found = result {
  found.age + found.score
} else {
  0
}
`);
  const aggregate_pointer_payload = await instantiate_wat(
    aggregate_pointer_payload_wat,
    "core_stored_runtime_union_aggregate_pointer_payload",
    {},
  );

  if (!("main" in aggregate_pointer_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof aggregate_pointer_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const aggregate_pointer_payload_result = aggregate_pointer_payload.exports
    .main();

  if (aggregate_pointer_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + aggregate_pointer_payload_result,
    );
  }

  const union_payload_wat = wat_from_core_source(`
type InnerType = | \`Some Int | \`None Unit
const inner_type = InnerType
type OuterType = | \`Ok inner_type | \`Err Unit
const outer_type = OuterType

let flag = true
let make = if flag {
  (value: Int) => \`Ok (\`Some (value))
} else {
  (value: Int) => \`Err ()
}
let result: outer_type = make(41)

if let \`Ok inner = result {
  if let \`Some value = inner {
    value + 1
  } else {
    0
  }
} else {
  0
}
`);
  const union_payload = await instantiate_wat(
    union_payload_wat,
    "core_stored_runtime_union_union_payload",
    {},
  );

  if (!("main" in union_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_payload_result = union_payload.exports.main();

  if (union_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + union_payload_result,
    );
  }

  const nested_union_wat = wat_from_core_source(`
type InnerType = | \`Some Int | \`None Unit
const inner_type = InnerType
const { struct } = import "duck:prelude" ()
const box_type = struct {
  .inner= inner_type,
  .bonus= Int
}
type ResultType = | \`Ok box_type | \`Err Unit
const result_type = ResultType

let flag = true
let make = if flag {
  (value: Int) => \`Ok ([.inner = \`Some (value), .bonus = 1] as box_type)
} else {
  (value: Int) => \`Err ()
}
let result: result_type = make(41)

if let \`Ok box = result {
  if let \`Some value = box.inner {
    value + box.bonus
  } else {
    0
  }
} else {
  0
}
`);
  const nested_union = await instantiate_wat(
    nested_union_wat,
    "core_stored_runtime_union_nested_union_field",
    {},
  );

  if (!("main" in nested_union.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_union.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_union_result = nested_union.exports.main();

  if (nested_union_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + nested_union_result,
    );
  }
});

Deno.test("core static if let compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let result = 0
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType
let typed_result = \`Ok (1)
let none_result = \`None ()

if let \`Ok x = \`Ok (41) {
  result = x + 1
}

if let \`Ok y = \`Err (9) {
  result = y
}

if let \`Ok z = typed_result {
  result = result + z
}

if let \`None () = none_result {
  result = result + 1
}

result
`);
  const instance = await instantiate_wat(wat_text, "core_static_if_let", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 44) {
    throw new Error("Expected main() -> 44, got " + result);
  }

  const scratch_union_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
let value = scratch { \`Ok (41) }
if let \`Ok x = value { x + 1 } else { 0 }
`);
  const scratch_union_instance = await instantiate_wat(
    scratch_union_wat,
    "core_scratch_static_union",
    {},
  );

  if (!("main" in scratch_union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_result = scratch_union_instance.exports.main();

  if (scratch_union_result !== 42) {
    throw new Error(
      "Expected scratch union main() -> 42, got " + scratch_union_result,
    );
  }

  const scratch_union_block_setup_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType
let result: result_type = scratch {
  let temp: Text = freeze @append("Ada", "!")
  \`Ok (temp)
}
if let \`Ok value = result { @len(value) } else { 0 }
`);
  const scratch_union_block_setup_instance = await instantiate_wat(
    scratch_union_block_setup_wat,
    "core_scratch_static_union_block_setup",
    {},
  );

  if (!("main" in scratch_union_block_setup_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_block_setup_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_block_setup_result = scratch_union_block_setup_instance
    .exports.main();

  if (scratch_union_block_setup_result !== 4) {
    throw new Error(
      "Expected scratch union block setup main() -> 4, got " +
        scratch_union_block_setup_result,
    );
  }

  const scratch_union_block_alias_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType
let result: result_type = scratch {
  let name: Text = freeze @append("Ada", "!")
  let temp: result_type = \`Ok (name)
  temp
}
if let \`Ok value = result { @len(value) } else { 0 }
`);
  const scratch_union_block_alias_instance = await instantiate_wat(
    scratch_union_block_alias_wat,
    "core_scratch_static_union_block_alias",
    {},
  );

  if (!("main" in scratch_union_block_alias_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_union_block_alias_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_union_block_alias_result = scratch_union_block_alias_instance
    .exports.main();

  if (scratch_union_block_alias_result !== 4) {
    throw new Error(
      "Expected scratch union block alias main() -> 4, got " +
        scratch_union_block_alias_result,
    );
  }

  const scratch_dynamic_union_wat = wat_from_core_source(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
let flag = true
let value = scratch {
  if flag {
    \`Ok (41)
  } else {
    \`Err (9)
  }
}
if let \`Ok x = value { x + 1 } else { 0 }
`);
  const scratch_dynamic_union_instance = await instantiate_wat(
    scratch_dynamic_union_wat,
    "core_scratch_dynamic_static_union",
    {},
  );

  if (!("main" in scratch_dynamic_union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_dynamic_union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_dynamic_union_result = scratch_dynamic_union_instance.exports
    .main();

  if (scratch_dynamic_union_result !== 42) {
    throw new Error(
      "Expected scratch dynamic union main() -> 42, got " +
        scratch_dynamic_union_result,
    );
  }
});

Deno.test("core static if let expressions compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let result = if let \`Ok x = \`Ok (41) {
  x + 1
} else {
  0
}

let fallback = if let \`Ok y = \`Err (9) {
  y
} else {
  5
}

result + fallback
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_if_let_expr",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 47) {
    throw new Error("Expected main() -> 47, got " + result);
  }

  const wide_fallback_wat = wat_from_core_source(`
type ResultType = | \`Ok I64 | \`Err I64
const result_type = ResultType

let result: result_type = \`Err (1i64)
let value = if let \`Ok found = result {
  found + 1i64
}

value
`);
  const wide_fallback = await instantiate_wat(
    wide_fallback_wat,
    "core_static_i64_if_let_implicit_fallback",
    {},
  );

  if (!("main" in wide_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof wide_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const wide_fallback_result = wide_fallback.exports.main();

  if (wide_fallback_result !== 0n) {
    throw new Error("Expected main() -> 0n, got " + wide_fallback_result);
  }

  const text_if_fallback_wat = wat_from_core_source(`
let flag = false
let selected: Text = if flag {
  "Ada"
}

@len(selected)
`);
  const text_if_fallback = await instantiate_wat(
    text_if_fallback_wat,
    "core_static_text_if_implicit_fallback",
    {},
  );

  if (!("main" in text_if_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_if_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_if_fallback_result = text_if_fallback.exports.main();

  if (text_if_fallback_result !== 0) {
    throw new Error(
      "Expected main() -> 0, got " + text_if_fallback_result,
    );
  }

  const text_if_let_fallback_wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

let result: result_type = \`Err ("no")
let selected: Text = if let \`Ok value = result {
  value
}

@len(selected)
`);
  const text_if_let_fallback = await instantiate_wat(
    text_if_let_fallback_wat,
    "core_static_text_if_let_implicit_fallback",
    {},
  );

  if (!("main" in text_if_let_fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_if_let_fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_if_let_fallback_result = text_if_let_fallback.exports.main();

  if (text_if_let_fallback_result !== 0) {
    throw new Error(
      "Expected main() -> 0, got " + text_if_let_fallback_result,
    );
  }
});

Deno.test("core dynamic union-if if let compiles through WAT to Wasm", async () => {
  const matching_wat = wat_from_core_source(`
let input = 1
let value = if let \`Ok x = if input {
  \`Ok (41)
} else {
  \`Err (7)
} {
  x + 1
} else {
  5
}

value
`);
  const matching = await instantiate_wat(
    matching_wat,
    "core_dynamic_union_if_let_matching",
    {},
  );

  if (!("main" in matching.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof matching.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const matching_result = matching.exports.main();

  if (matching_result !== 42) {
    throw new Error("Expected main() -> 42, got " + matching_result);
  }

  const fallback_wat = wat_from_core_source(`
let input = 0
let value = if let \`Ok x = if input {
  \`Ok (41)
} else {
  \`Err (7)
} {
  x + 1
} else {
  5
}

value
`);
  const fallback = await instantiate_wat(
    fallback_wat,
    "core_dynamic_union_if_let_fallback",
    {},
  );

  if (!("main" in fallback.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof fallback.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const fallback_result = fallback.exports.main();

  if (fallback_result !== 5) {
    throw new Error("Expected main() -> 5, got " + fallback_result);
  }

  const typed_wat = wat_from_core_source(`
let input = 1
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result = if input {
  \`Ok (40)
} else {
  \`Err (1)
}

if let \`Ok value = result {
  value + 2
} else {
  7
}
`);
  const typed = await instantiate_wat(
    typed_wat,
    "core_dynamic_typed_union_if_let",
    {},
  );

  if (!("main" in typed.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_result = typed.exports.main();

  if (typed_result !== 42) {
    throw new Error("Expected main() -> 42, got " + typed_result);
  }

  const typed_struct_payload_wat = wat_from_core_source(`
let input = 1
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | \`Ok user_type | \`Err user_type
const result_type = ResultType

let result: result_type = if input {
  \`Ok ([.age = 40, .score = 2] as user_type)
} else {
  \`Err ([.age = 5, .score = 1] as user_type)
}

if let \`Ok user = result {
  user.age + user.score
} else {
  0
}
`);
  const typed_struct_payload = await instantiate_wat(
    typed_struct_payload_wat,
    "core_dynamic_typed_struct_payload_union_if_let",
    {},
  );

  if (!("main" in typed_struct_payload.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_struct_payload.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_struct_payload_result = typed_struct_payload.exports.main();

  if (typed_struct_payload_result !== 42) {
    throw new Error(
      "Expected main() -> 42, got " + typed_struct_payload_result,
    );
  }

  const typed_wide_wat = wat_from_core_source(`
let input = 0
type ResultType = | \`Ok I64 | \`Err I64
const result_type = ResultType

let result: result_type = if input {
  \`Ok (40i64)
} else {
  \`Err (1i64)
}

let selected = if let \`Ok value = result {
  value + 2i64
}

selected
`);
  const typed_wide = await instantiate_wat(
    typed_wide_wat,
    "core_dynamic_typed_i64_union_if_let_implicit_fallback",
    {},
  );

  if (!("main" in typed_wide.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_wide.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_wide_result = typed_wide.exports.main();

  if (typed_wide_result !== 0n) {
    throw new Error("Expected main() -> 0n, got " + typed_wide_result);
  }

  const typed_text_wat = wat_from_core_source(`
let input = 0
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

let result: result_type = if input {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
}

let selected: Text = if let \`Ok value = result {
  value
}

@len(selected)
`);
  const typed_text = await instantiate_wat(
    typed_text_wat,
    "core_dynamic_typed_text_union_if_let_implicit_fallback",
    {},
  );

  if (!("main" in typed_text.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof typed_text.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const typed_text_result = typed_text.exports.main();

  if (typed_text_result !== 0) {
    throw new Error("Expected main() -> 0, got " + typed_text_result);
  }

  const const_call_wat = wat_from_core_source(`
let input = 1

type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const make_result = flag => {
  if flag {
    \`Ok (40)
  } else {
    \`Err (1)
  }
}

let result = make_result(input)

if let \`Ok value = result {
  value + 2
} else {
  7
}
`);
  const const_call = await instantiate_wat(
    const_call_wat,
    "core_dynamic_const_call_union_if_let",
    {},
  );

  if (!("main" in const_call.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof const_call.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const const_call_result = const_call.exports.main();

  if (const_call_result !== 42) {
    throw new Error("Expected main() -> 42, got " + const_call_result);
  }
});

Deno.test("frontend block-wrapped union payload compiles through WAT to Wasm", async () => {
  const wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct { .age= Int }
type ResultType = | \`Ok user_type | \`Err Unit
let seed = 41
let user: user_type = [.age = seed] as user_type
let result: ResultType = \`Ok ({
  let alias = user
  alias
})
if let \`Ok found = result { found.age } else { 0 }
`);
  const instance = await instantiate_wat(
    wat,
    "frontend_block_wrapped_union_payload",
    {},
  );
  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }
  const result = instance.exports.main();
  if (result !== 41) {
    throw new Error(
      "Expected block-wrapped payload main() -> 41, got " + result,
    );
  }
});

Deno.test(
  "frontend runtime-union Text payload closure compiles through WAT to Wasm",
  async () => {
    const wat = wat_from_core_source(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = true
let make = if flag {
  (x: Text) => \`Ok (x)
} else {
  (x: Text) => \`Err ()
}
let result: result_type = make("world")
let print_once = if let \`Ok value = result {
  () => io.print(&value)
} else {
  () => io.print("fallback")
}
io = print_once()
io
`);
    let calls = 0;
    let printed = "";
    // Initialized after instantiation; host callbacks close over this binding.
    // deno-lint-ignore prefer-const
    let memory: WebAssembly.Memory | undefined;
    const instance = await instantiate_wat(
      wat,
      "frontend_runtime_union_text_payload_closure",
      {
        env: {
          print(token: number, ptr: number): number {
            if (ptr < 0) {
              throw new Error("expected text pointer");
            }

            if (!memory) {
              throw new Error("memory export is not available");
            }

            const view = new DataView(memory.buffer);
            const length = view.getUint32(ptr, true);
            const bytes = new Uint8Array(memory.buffer, ptr + 4, length);
            printed = decoder.decode(bytes);
            calls = calls + 1;
            return token + 41;
          },
        },
      },
    );

    if (typeof instance.exports.main !== "function") {
      throw new Error("main export is not a function");
    }

    if (!("memory" in instance.exports)) {
      throw new Error("Missing memory export");
    }

    if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
      throw new Error("memory export is not a WebAssembly.Memory");
    }

    memory = instance.exports.memory;
    const result = instance.exports.main();

    if (result !== 42) {
      throw new Error("Expected main() -> 42, got " + result);
    }

    if (calls !== 1) {
      throw new Error("Expected one host print call");
    }

    if (printed !== "world") {
      throw new Error("Expected runtime union payload to print world");
    }
  },
);

Deno.test("frontend dynamic union text payload len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

let flag = true
let result = if flag {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
}

if let \`Ok value = result {
  @len(value)
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_text_payload_len",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 3) {
    throw new Error("Expected main() -> 3, got " + result);
  }
});

Deno.test("frontend dynamic union struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | \`Ok user_type | \`Err user_type
const result_type = ResultType

let flag = true
let result: result_type = if flag {
  \`Ok ([.age = 40, .score = 2] as user_type)
} else {
  \`Err ([.age = 5, .score = 1] as user_type)
}

if let \`Ok user = result {
  user.age + user.score
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_struct_payload",
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

Deno.test("frontend dynamic union nested struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const { struct } = import "duck:prelude" ()
const name_type = struct {
  .first= Text,
  .last= Text
}

const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= name_type,
  .age= Int
}

type ResultType = | \`Ok user_type | \`Err user_type
const result_type = ResultType

let flag = true
let result: result_type = if flag {
  \`Ok ([.name = [.first = "Ada", .last = "Lovelace"] as name_type, .age = 40] as user_type)
} else {
  \`Err ([.name = [.first = "Grace", .last = "Hopper"] as name_type, .age = 5] as user_type)
}

if let \`Ok user = result {
  @len(user.name.first) + @len(user.name.last) + user.age
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_nested_struct_payload",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 51) {
    throw new Error("Expected main() -> 51, got " + result);
  }
});

Deno.test("frontend dynamic union shorthand struct payload compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | \`Ok user_type | \`Err user_type
const result_type = ResultType

let flag = true
let result: result_type = if flag {
  \`Ok ([.age = 40, .score = 2])
} else {
  \`Err ([.age = 5, .score = 1])
}

if let \`Ok user = result {
  user.age + user.score
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_union_shorthand_struct_payload",
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

Deno.test("collection loop union patterns skip nonmatching elements", async () => {
  const wat_text = wat_from_core_source(`
type Maybe = | \`Some I32 | \`None Unit

let one: Maybe = \`Some (1)
let none: Maybe = \`None ()
let three: Maybe = \`Some (3)
let values = [one, none, three]
let total = 0

for index, \`Some value in values {
  total = total + index + value
}

total
`);
  const instance = await instantiate_wat(
    wat_text,
    "collection_loop_union_pattern",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing collection pattern main export");
  }

  const result = main();

  if (result !== 6) {
    throw new Error(
      "Expected matching values and original indexes to sum to 6",
    );
  }
});
