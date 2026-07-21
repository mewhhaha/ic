import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { Source } from "../frontend.ts";

Deno.test("functional prelude folds options and results", async () => {
  const wat = Source.wat(`
const { iterate_i32, option_fold, result_fold } = import "duck:prelude/functional" ()
type IntOption = Option I32
type IntResult = Result I32 I32
const increment = value => value + 1
const double = value => value * 2
const negate = value => 0 - value
let present: IntOption = \`Some 41
const fold_option = comptime option_fold [0, increment]
const fold_result = comptime result_fold [negate, double]
let option_value = fold_option present
let success: IntResult = \`Ok 7
let failure: IntResult = \`Err 3
option_value + fold_result(success) + fold_result(failure) + iterate_i32(3, 1, double)
`);
  const instance = await instantiate_wat(wat, "prelude_functional_folds", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("functional prelude fold test omitted main");
  }

  assert_equals(main(), 61);
});

Deno.test("functional prelude composes Option category operations", async () => {
  const wat = Source.wat(`
const { option_unwrap_or } = import "duck:prelude/functional" ()
type IntOption = Option I32
const increment = (value: I32) => value + 1
const add_two_option: I32 -> IntOption = value => \`Some (value + 2)
const double_option: I32 -> IntOption = value => \`Some (value * 2)

let mapped_source: IntOption = \`Some 20
let mapped: IntOption = increment <$> mapped_source
let pure_value: IntOption = Applicative.pure 5
let bound_source: IntOption = \`Some 20
let bound: IntOption = bound_source >>= add_two_option >>= double_option
let missing_source: IntOption = \`None ()
let missing: IntOption = missing_source >>= add_two_option
let empty_value: IntOption = Alternative.empty()
let fallback: IntOption = \`Some 7
let selected: IntOption = empty_value <|> fallback

let total = option_unwrap_or(0, mapped)
total = total + option_unwrap_or(0, pure_value)
total = total + option_unwrap_or(0, bound)
total = total + option_unwrap_or(2, missing)
total + option_unwrap_or(0, selected)
`);
  const instance = await instantiate_wat(
    wat,
    "prelude_functional_option_categories",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("functional Option category test omitted main");
  }

  assert_equals(main(), 79);
});

Deno.test("AffineMonad accepts Option and rejects multi-shot List", () => {
  Source.core(`
const {} = import "duck:prelude/functional" ()
comptime AffineMonad [Option, I32, I32]
0
`);

  assert_throws(
    () =>
      Source.core(`
const {} = import "duck:prelude/functional" ()
comptime AffineMonad [List, I32, I32]
0
`),
    "Missing duck satisfaction for AffineMonad.pure_affine at List",
  );
});

Deno.test("functional prelude elaborates Option applicative callbacks", () => {
  const core = Source.core(`
const {} = import "duck:prelude/functional" ()
type IntOption = Option I32
const increment = (value: I32) => value + 1
let source: IntOption = \`Some 20
let applied: IntOption = Applicative.apply(\`Some increment, source)
if let \`Some value = applied { value } else { 0 }
`);

  assert_includes(Core.fmt(core), "if let `Some transform");
});

Deno.test("functional prelude folds recursive lists", async () => {
  const wat = Source.wat(`
const { list_fold_left, list_length, list_is_empty, list_any, list_all, list_count, list_head_or, list_last_or, list_nth_or, list_sum_i32, list_product_i32 } = import "duck:prelude/functional" ()
type IntList = List I32
type TextList = List Text

let values: IntList = \`Nil ()
for 0..100 {
  values = \`Cons [100, values]
}
let sum = list_fold_left(values, 0, (total, value) => total + value)

let length_end: IntList = \`Nil ()
let length_tail: IntList = \`Cons [2, length_end]
let length_values: IntList = \`Cons [1, length_tail]
let length = list_length(length_values)
let empty: IntList = \`Nil ()
let empty_score = if list_is_empty(empty) { 1 } else { 0 }
let any_end: IntList = \`Nil ()
let any_tail: IntList = \`Cons [2, any_end]
let any_values: IntList = \`Cons [1, any_tail]
let any_score = if list_any(any_values, value => value == 2) { 1 } else { 0 }
let all_end: IntList = \`Nil ()
let all_tail: IntList = \`Cons [4, all_end]
let all_values: IntList = \`Cons [2, all_tail]
let all_score = if list_all(all_values, value => value > 0) { 1 } else { 0 }
let count_end: IntList = \`Nil ()
let count_last: IntList = \`Cons [2, count_end]
let count_tail: IntList = \`Cons [2, count_last]
let count_values: IntList = \`Cons [1, count_tail]
let count = list_count(count_values, value => value == 2)
let head_end: IntList = \`Nil ()
let head_values: IntList = \`Cons [7, head_end]
let head = list_head_or(0, head_values)

let last_end: IntList = \`Nil ()
let last_tail: IntList = \`Cons [3, last_end]
let last_values: IntList = \`Cons [2, last_tail]
let last = list_last_or(0, last_values)
let nth_end: IntList = \`Nil ()
let nth_last: IntList = \`Cons [6, nth_end]
let nth_tail: IntList = \`Cons [5, nth_last]
let nth_values: IntList = \`Cons [4, nth_tail]
let nth = list_nth_or(0, 1, nth_values)
let missing_end: IntList = \`Nil ()
let missing_values: IntList = \`Cons [4, missing_end]
let missing = list_nth_or(9, 3, missing_values)
let sum_end: IntList = \`Nil ()
let sum_tail: IntList = \`Cons [3, sum_end]
let sum_values: IntList = \`Cons [2, sum_tail]
let short_sum = list_sum_i32(sum_values)
let product_end: IntList = \`Nil ()
let product_tail: IntList = \`Cons [3, product_end]
let product_values: IntList = \`Cons [2, product_tail]
let product = list_product_i32(product_values)

let text_end: TextList = \`Nil ()
let text_tail_node = ["second", text_end] as ListNode Text
let text_tail: TextList = \`Cons text_tail_node
let text_values_node = ["first", text_tail] as ListNode Text
let text_values: TextList = \`Cons text_values_node
let text_count = list_length(text_values)

sum + length + empty_score + any_score + all_score + count + head + last + nth + missing + short_sum + product + text_count
`);
  const instance = await instantiate_wat(wat, "prelude_functional_lists", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("functional prelude list test omitted main");
  }

  assert_equals(main(), 10_044);
  const memory = instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("functional prelude list test omitted memory");
  }

  assert_equals(memory.buffer.byteLength, 65_536);
});

Deno.test("functional prelude constructs and folds generic lists", async () => {
  const wat = Source.wat(`
const { list } = import "duck:prelude/functional" ()
type IntList = List I32
const ints = comptime list(I32)

let values: IntList = ints.empty()
for 0..100 {
  values = ints.prepend(1, values)
}
ints.fold_i32(values, 0, (total, value) => total + value)
`);
  const instance = await instantiate_wat(
    wat,
    "prelude_functional_factory",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("functional prelude factory test omitted main");
  }

  for (let iteration = 0; iteration < 100; iteration += 1) {
    assert_equals(main(), 100);
  }
  const memory = instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("functional prelude factory test omitted memory");
  }

  assert_equals(memory.buffer.byteLength, 65_536);
  assert_includes(wat, "(func $__drop_type_");
});

Deno.test("functional prelude type checks a specialized list comparator", () => {
  const core = Source.core(`
const { list } = import "duck:prelude/functional" ()
const ints = comptime list(I32)
ints.sort_by(ints.prepend(1, ints.empty()), (left, right) => left < right)
`);

  assert_equals(Core.type(core), "i32");
});
