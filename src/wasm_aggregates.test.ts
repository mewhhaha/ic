import {
  instantiate_wat,
  wat_from_core_source,
  wat_from_source,
} from "./wasm_test_util.ts";

Deno.test("frontend visible update closure compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let birthday = user => {
  user {
    age: user.age + 1
  }
}

birthday({
  name: "Ada",
  age: 41
}).age
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_visible_update_closure",
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

Deno.test("core static aggregate bindings compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let user = { name: 1, age: 41 }
let total = 0

for i, x in xs {
  total = total + i + x
}

total + xs[1] + user.age
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_aggregate_bindings",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 92) {
    throw new Error("Expected main() -> 92, got " + result);
  }

  const scratch_free_wat = wat_from_core_source(`
let x = 40
let user = scratch { { age: x + 1, bonus: 1 } }
user.age + user.bonus
`);
  const scratch_free_instance = await instantiate_wat(
    scratch_free_wat,
    "core_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_free_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_free_result = scratch_free_instance.exports.main();

  if (scratch_free_result !== 42) {
    throw new Error(
      "Expected scratch-free main() -> 42, got " + scratch_free_result,
    );
  }

  const annotated_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: "Ada" }
}
user.age + len(user.name)
`);
  const annotated_scratch_free_instance = await instantiate_wat(
    annotated_scratch_free_wat,
    "core_annotated_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in annotated_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof annotated_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const annotated_scratch_free_result = annotated_scratch_free_instance.exports
    .main();

  if (annotated_scratch_free_result !== 44) {
    throw new Error(
      "Expected annotated scratch-free main() -> 44, got " +
        annotated_scratch_free_result,
    );
  }

  const block_setup_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let temp: Text = freeze append("Ada", "!")
  user_type { age: 40, name: temp }
}
user.age + len(user.name)
`);
  const block_setup_scratch_free_instance = await instantiate_wat(
    block_setup_scratch_free_wat,
    "core_block_setup_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in block_setup_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof block_setup_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const block_setup_scratch_free_result = block_setup_scratch_free_instance
    .exports.main();

  if (block_setup_scratch_free_result !== 44) {
    throw new Error(
      "Expected block setup scratch-free main() -> 44, got " +
        block_setup_scratch_free_result,
    );
  }

  const block_alias_scratch_free_wat = wat_from_core_source(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let name: Text = freeze append("Ada", "!")
  let temp: user_type = user_type { age: 40, name: name }
  temp
}
user.age + len(user.name)
`);
  const block_alias_scratch_free_instance = await instantiate_wat(
    block_alias_scratch_free_wat,
    "core_block_alias_scratch_free_static_aggregate",
    {},
  );

  if (!("main" in block_alias_scratch_free_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof block_alias_scratch_free_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const block_alias_scratch_free_result = block_alias_scratch_free_instance
    .exports.main();

  if (block_alias_scratch_free_result !== 44) {
    throw new Error(
      "Expected block alias scratch-free main() -> 44, got " +
        block_alias_scratch_free_result,
    );
  }
});

Deno.test("core dynamic aggregate index expression compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 32 }
let i = 1

xs[i]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_aggregate_index_expr",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 32) {
    throw new Error("Expected main() -> 32, got " + result);
  }
});

Deno.test("core aggregate len and get compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 32 }
let i = 1

len(xs) + get(xs, i) + get(xs, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_aggregate_len_get",
    {},
  );

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
});

Deno.test("core runtime aggregate collection facts compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let i = 1
let total = 0

for index, value in pair {
  total = total + index + value
}

len(pair) * 1000 + get(pair, i) * 100 + pair[0] * 10 + total
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_collection_facts",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5242) {
    throw new Error("Expected main() -> 5242, got " + result);
  }

  const nested_wat = wat_from_core_source(`
const scores_type = struct {
  first: Int,
  second: Int
}
const user_type = struct {
  scores: scores_type,
  bonus: Int
}

let flag = 1
let make_scores = if flag {
  () => scores_type { first: 10, second: 20 }
} else {
  () => scores_type { first: 1, second: 2 }
}
let scores: scores_type = make_scores()
let make_user = if flag {
  () => user_type { scores: scores, bonus: 1 }
} else {
  () => user_type { scores: scores, bonus: 2 }
}
let user: user_type = make_user()
let total = 0

for index, score in user.scores {
  total = total + index + score
}

total + user.bonus
`);
  const nested_instance = await instantiate_wat(
    nested_wat,
    "core_runtime_aggregate_nested_collection_facts",
    {},
  );

  if (!("main" in nested_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested_instance.exports.main();

  if (nested_result !== 32) {
    throw new Error("Expected nested main() -> 32, got " + nested_result);
  }

  const control_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let total = 0

for index, value in pair {
  if index == 0 {
    continue
  }

  total = total + value

  if index == 1 {
    break
  }

  total = total + 100
}

total
`);
  const control_instance = await instantiate_wat(
    control_wat,
    "core_runtime_aggregate_collection_control",
    {},
  );

  if (!("main" in control_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof control_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const control_result = control_instance.exports.main();

  if (control_result !== 31) {
    throw new Error(
      "Expected control main() -> 31, got " + control_result,
    );
  }
});

Deno.test("core runtime aggregate scalar index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
pair[0] = 40
let i = 1
pair[i] = 2
pair.first + pair.second
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_scalar_index_assignment",
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

  const trap_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let i = 2
pair[i] = 99
pair.first
`);
  const trap_instance = await instantiate_wat(
    trap_wat,
    "core_runtime_aggregate_scalar_index_assignment_oob",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error(
    "Expected main() to trap for runtime aggregate index assignment",
  );
});

Deno.test("core runtime aggregate Text index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
names[0] = "Edsger"
let i = 1
names[i] = names.first + " Hopper"
len(names.first) * 100 + len(names.second)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_text_index_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 613) {
    throw new Error("Expected main() -> 613, got " + result);
  }
});

Deno.test("core runtime aggregate nested index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
slots[0] = pair_type { left: 10, right: 20 }
let i = 1
slots[i] = pair_type { left: 5, right: 7 }
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_nested_index_assignment",
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

Deno.test("core captured runtime aggregate nested index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
let write = if flag {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: left, right: right }
    0
  }
} else {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: right, right: left }
    0
  }
}

write(1, 5, 7)
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_captured_runtime_aggregate_nested_index_assignment",
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

Deno.test("core captured runtime aggregate Text index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let write = if flag {
  (i: Int, suffix: Text) => {
    names[i] = names.first + suffix
    len(names.second)
  }
} else {
  (i: Int, suffix: Text) => {
    names[i] = suffix
    len(names.second)
  }
}

write(1, " Hopper")
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_captured_runtime_aggregate_text_index_assignment",
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

Deno.test("core captured runtime aggregate scalar index assignment compiles through WAT to Wasm", async () => {
  const static_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = (i: Int, value: Int) => {
  pair[i] = value
  pair.first + pair.second
}

write(0, 40) + write(1, 2)
`);
  const static_instance = await instantiate_wat(
    static_wat,
    "core_captured_runtime_aggregate_static_index_assignment",
    {},
  );

  if (!("main" in static_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof static_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const static_result = static_instance.exports.main();

  if (static_result !== 113) {
    throw new Error("Expected main() -> 113, got " + static_result);
  }

  const first_class_wat = wat_from_core_source(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = if flag {
  (i: Int, value: Int) => {
    pair[i] = value
    pair.first + pair.second
  }
} else {
  (i: Int, value: Int) => {
    pair[i] = value + 1
    pair.first + pair.second
  }
}

write(0, 40) + write(1, 2)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_captured_runtime_aggregate_first_class_index_assignment",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 113) {
    throw new Error(
      "Expected main() -> 113, got " + first_class_result,
    );
  }
});

Deno.test("core runtime aggregate text collection facts compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let i = 1
let picked: Text = get(names, i)
let first: Text = names[0]
let view: Text = ""
let total = 0

for index, name in names {
  view = &name
  total = total + index + len(name)
}

len(names) * 1000 + len(picked) * 100 + len(first) * 10 + total + len(view)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_text_collection_facts",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2544) {
    throw new Error("Expected main() -> 2544, got " + result);
  }
});

Deno.test("core static aggregate runtime captures compile through WAT to Wasm", async () => {
  const struct_wat = wat_from_core_source(`
let a = 1
let xs = { first: a, second: 2 }
a = 9
xs[0] + xs[1]
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_static_aggregate_struct_capture",
    {},
  );

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (struct_result !== 3) {
    throw new Error("Expected main() -> 3, got " + struct_result);
  }

  const union_wat = wat_from_core_source(`
let payload = 41
let result = .ok(payload)
payload = 1
if let .ok(x) = result {
  x
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_static_aggregate_union_capture",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 41) {
    throw new Error("Expected main() -> 41, got " + union_result);
  }
});

Deno.test("core runtime aggregate field loads compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")

len(user.name) + user.age
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_aggregate_field_loads",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 43) {
    throw new Error("Expected main() -> 43, got " + result);
  }

  const frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let frozen: user_type = freeze user

len(frozen.name) + frozen.age
`);
  const frozen_instance = await instantiate_wat(
    frozen_wat,
    "core_runtime_aggregate_freeze",
    {},
  );

  if (!("main" in frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const frozen_result = frozen_instance.exports.main();

  if (frozen_result !== 43) {
    throw new Error("Expected frozen main() -> 43, got " + frozen_result);
  }

  const scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let user: user_type = scratch {
  freeze user_type { name: append(prefix, "da"), age: 40 }
}

len(user.name) + user.age
`);
  const scratch_frozen_instance = await instantiate_wat(
    scratch_frozen_wat,
    "core_runtime_aggregate_scratch_freeze",
    {},
  );

  if (!("main" in scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof scratch_frozen_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const scratch_frozen_result = scratch_frozen_instance.exports.main();

  if (scratch_frozen_result !== 43) {
    throw new Error(
      "Expected scratch frozen main() -> 43, got " + scratch_frozen_result,
    );
  }

  const bound_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let user: user_type = scratch {
  let temp: user_type = user_type { name: append(prefix, "da"), age: 40 }
  freeze temp
}

len(user.name) + user.age
`);
  const bound_scratch_frozen_instance = await instantiate_wat(
    bound_scratch_frozen_wat,
    "core_runtime_aggregate_bound_scratch_freeze",
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

  if (bound_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected bound scratch frozen main() -> 43, got " +
        bound_scratch_frozen_result,
    );
  }

  const existing_alias_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

len(user.name) + user.age
`);
  const existing_alias_scratch_frozen_instance = await instantiate_wat(
    existing_alias_scratch_frozen_wat,
    "core_runtime_aggregate_existing_alias_scratch_freeze",
    {},
  );

  if (!("main" in existing_alias_scratch_frozen_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (
    typeof existing_alias_scratch_frozen_instance.exports.main !== "function"
  ) {
    throw new Error("main export is not a function");
  }

  const existing_alias_scratch_frozen_result =
    existing_alias_scratch_frozen_instance.exports.main();

  if (existing_alias_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected existing alias scratch frozen main() -> 43, got " +
        existing_alias_scratch_frozen_result,
    );
  }

  const branch_assignment_scratch_frozen_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }
if flag {
  existing = user_type { name: append(prefix, "!"), age: 41 }
} else {
  existing = user_type { name: append(prefix, "?"), age: 42 }
}
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

len(user.name) + user.age
`);
  const branch_assignment_scratch_frozen_instance = await instantiate_wat(
    branch_assignment_scratch_frozen_wat,
    "core_runtime_aggregate_branch_assignment_scratch_freeze",
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

  if (branch_assignment_scratch_frozen_result !== 43) {
    throw new Error(
      "Expected branch assignment scratch frozen main() -> 43, got " +
        branch_assignment_scratch_frozen_result,
    );
  }

  const nested_wat = wat_from_core_source(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  age: Int,
  name: name_type
}

let flag = 1
let make = if flag {
  (first: Text) => user_type {
    age: 40,
    name: name_type { first: first, last: "Lovelace" }
  }
} else {
  (first: Text) => user_type {
    age: 5,
    name: name_type { first: first, last: "Hopper" }
  }
}
let user: user_type = make("Ada")
let name: name_type = user.name

len(name.first) + len(name.last) + user.age
`);
  const nested_instance = await instantiate_wat(
    nested_wat,
    "core_runtime_aggregate_nested_field_alias",
    {},
  );

  if (!("main" in nested_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof nested_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const nested_result = nested_instance.exports.main();

  if (nested_result !== 51) {
    throw new Error("Expected main() -> 51, got " + nested_result);
  }

  const captured_wat = wat_from_core_source(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 41 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let get_age = if flag {
  () => user.age
} else {
  () => user.age + 1
}

get_age()
`);
  const captured_instance = await instantiate_wat(
    captured_wat,
    "core_runtime_aggregate_closure_capture",
    {},
  );

  if (!("main" in captured_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_result = captured_instance.exports.main();

  if (captured_result !== 41) {
    throw new Error("Expected main() -> 41, got " + captured_result);
  }
});

Deno.test("core struct update compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let user = { age: 40, score: 2 }
let next = 41
let updated = user { age: next }
next = 1
updated.age + user.age + updated.score
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_struct_update",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 83) {
    throw new Error("Expected main() -> 83, got " + result);
  }
});

Deno.test("core dynamic aggregate if bindings compile through WAT to Wasm", async () => {
  const struct_wat = wat_from_core_source(`
let flag = 0
let user = if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}

flag = 1
user.age + user.score
`);
  const struct_instance = await instantiate_wat(
    struct_wat,
    "core_dynamic_struct_if_binding",
    {},
  );

  if (!("main" in struct_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof struct_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const struct_result = struct_instance.exports.main();

  if (struct_result !== 42) {
    throw new Error("Expected main() -> 42, got " + struct_result);
  }

  const union_wat = wat_from_core_source(`
let flag = 1
let payload = 41
let result = if flag {
  .ok(payload)
} else {
  .err(7)
}

flag = 0
payload = 1
if let .ok(value) = result {
  value + 1
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_dynamic_union_if_binding",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 42) {
    throw new Error("Expected main() -> 42, got " + union_result);
  }
});

Deno.test("core direct dynamic aggregate if access compiles through WAT to Wasm", async () => {
  const field_wat = wat_from_core_source(`
let flag = 0

(if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}).age
`);
  const field_instance = await instantiate_wat(
    field_wat,
    "core_direct_dynamic_struct_if_field",
    {},
  );

  if (!("main" in field_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof field_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const field_result = field_instance.exports.main();

  if (field_result !== 32) {
    throw new Error("Expected main() -> 32, got " + field_result);
  }

  const index_wat = wat_from_core_source(`
let flag = 0
let i = 1

(if flag {
  { first: 41, second: 1 }
} else {
  { first: 32, second: 10 }
})[i]
`);
  const index_instance = await instantiate_wat(
    index_wat,
    "core_direct_dynamic_struct_if_index",
    {},
  );

  if (!("main" in index_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof index_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const index_result = index_instance.exports.main();

  if (index_result !== 10) {
    throw new Error("Expected main() -> 10, got " + index_result);
  }

  const union_wat = wat_from_core_source(`
let flag = 0
let left = 41
let right = 32
let result = if flag {
  .ok(left)
} else {
  .ok(right)
}

left = 1
right = 2
if let .ok(value) = result {
  value
} else {
  0
}
`);
  const union_instance = await instantiate_wat(
    union_wat,
    "core_same_case_dynamic_union_if",
    {},
  );

  if (!("main" in union_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof union_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const union_result = union_instance.exports.main();

  if (union_result !== 32) {
    throw new Error("Expected main() -> 32, got " + union_result);
  }
});

Deno.test("core static aggregate index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let value = 32

xs[1] = value
xs[0] + xs[1]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_static_aggregate_index_assign",
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

  const captured_closure_wat = wat_from_core_source(`
let pair = { first: 1, second: 2 }
let f = i => {
  pair[i] = 40
  pair[0] + pair[1]
}

let a = f(0)
let b = f(1)
a + b + pair[0] + pair[1]
`);
  const captured_closure_instance = await instantiate_wat(
    captured_closure_wat,
    "core_captured_static_aggregate_index_assign",
    {},
  );

  if (!("main" in captured_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof captured_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const captured_closure_result = captured_closure_instance.exports.main();

  if (captured_closure_result !== 86) {
    throw new Error(
      "Expected main() -> 86, got " + captured_closure_result,
    );
  }

  const param_closure_wat = wat_from_core_source(`
let update = xs => {
  xs[0] = 40
  xs[0] + xs[1]
}

let pair = { first: 1, second: 2 }
update(pair) + pair[0] + pair[1]
`);
  const param_closure_instance = await instantiate_wat(
    param_closure_wat,
    "core_static_aggregate_param_index_assign",
    {},
  );

  if (!("main" in param_closure_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof param_closure_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const param_closure_result = param_closure_instance.exports.main();

  if (param_closure_result !== 45) {
    throw new Error("Expected main() -> 45, got " + param_closure_result);
  }
});

Deno.test("core dynamic aggregate index assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let xs = { first: 10, second: 20 }
let i = 0
let value = 32

xs[i] = value
xs[0] + xs[1]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_dynamic_aggregate_index_assign",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 52) {
    throw new Error("Expected main() -> 52, got " + result);
  }

  const text_wat = wat_from_core_source(`
let messages = { first: "Ada", second: "Grace" }
let i = 1
let next = "Edsger"

messages[i] = next
next = "Nope"
len(messages[1])
`);
  const text_instance = await instantiate_wat(
    text_wat,
    "core_dynamic_text_index_assign",
    {},
  );

  if (!("main" in text_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof text_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const text_result = text_instance.exports.main();

  if (text_result !== 6) {
    throw new Error("Expected main() -> 6, got " + text_result);
  }
});

Deno.test("core generic type constructors compile through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
const option_type = t => union {
  some: t,
  none: Unit
}

const result_type = e => t => union {
  ok: t,
  err: e
}

const parse_result_type = result_type(Text)(Int)

let direct = option_type(Int).some(40)
let typed: parse_result_type = .ok(1)

let total = if let .some(x) = direct {
  x
} else {
  0
}

if let .ok(value) = typed {
  total + value + 1
} else {
  0
}
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_generic_type_constructor",
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
