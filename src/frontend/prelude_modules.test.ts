import { assert_equals } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { Source } from "../frontend.ts";

Deno.test("root prelude exposes source-defined boolean negation", async () => {
  const wat = Source.wat(`
const { not } = import "duck:prelude" ()
if not(false) && not(not(true)) { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_boolean_not", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("root prelude boolean test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("numeric prelude exposes focused scalar operations", async () => {
  const wat = Source.wat(`
const { min_i32, max_i32, f64_from_i32, i32_from_f64, unsafe_i32_wrap_i64 } = import "duck:prelude/numeric" ()
min_i32(7, 3) + max_i32(7, 3) + unsafe_i32_wrap_i64(5i64) + i32_from_f64(f64_from_i32(27) * 1.5f64)
`);
  const instance = await instantiate_wat(wat, "prelude_numeric", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("numeric prelude test omitted main");
  }

  assert_equals(main(), 55);
});

Deno.test("numeric prelude parses the complete U32 decimal range", async () => {
  const wat = Source.wat(`
const { parse_u32_decimal } = import "duck:prelude/numeric" ()
let maximum = parse_u32_decimal("4294967295")
let overflow = parse_u32_decimal("4294967296")
let malformed = parse_u32_decimal("12.5")
let score = if let \`Ok value = maximum { if value == 4294967295i64 { 1 } else { 0 } } else { 0 }
if let \`Err reason = overflow { if reason == "number exceeds U32" { score = score + 10 } }
if let \`Err reason = malformed { if reason == "must be a non-negative integer" { score = score + 100 } }
score
`);
  const instance = await instantiate_wat(wat, "prelude_parse_u32", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("U32 decimal parser test omitted main");
  }

  assert_equals(main(), 111);
});

Deno.test("numeric prelude accepts complete I64 decimal parsing", () => {
  const diagnostics = Source.analyze(`
const { parse_i64_decimal } = import "duck:prelude/numeric" ()
let minimum = parse_i64_decimal("-9223372036854775808")
let maximum = parse_i64_decimal("9223372036854775807")
let overflow = parse_i64_decimal("9223372036854775808")
let malformed = parse_i64_decimal("--1")
let score = if let \`Ok value = minimum { if value == -9223372036854775808i64 { 1 } else { 0 } } else { 0 }
if let \`Ok value = maximum { if value == 9223372036854775807i64 { score = score + 10 } }
if let \`Err reason = overflow { if reason == "number exceeds I64" { score = score + 100 } }
if let \`Err reason = malformed { if reason == "must be an integer" { score = score + 1000 } }
score
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("numeric prelude saturates signed I64 addition", async () => {
  const wat = Source.wat(`
const { saturating_add_i64 } = import "duck:prelude/numeric" ()
let maximum: I64 = saturating_add_i64(9223372036854775806i64, 10i64)
let minimum: I64 = saturating_add_i64(-9223372036854775807i64, -10i64)
let ordinary: I64 = saturating_add_i64(20i64, 22i64)
if maximum == 9223372036854775807i64 && minimum == -9223372036854775808i64 && ordinary == 42i64 { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_saturating_i64", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("saturating I64 addition test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("text prelude exposes focused text operations", async () => {
  const wat = Source.wat(`
const { text_contains } = import "duck:prelude/text" ()
if text_contains("ducklang", "lang") { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_text", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("text prelude test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("CSV prelude exposes focused field rendering", () => {
  const diagnostics = Source.analyze(String.raw`
const { csv_append_field, csv_escape_field, csv_format_i32 } = import "duck:prelude/csv" ()
let line = csv_append_field("", "alpha", true)
line = csv_append_field(line, "hello, \"duck\"", false)
if line == "alpha,\"hello, \"\"duck\"\"\"" && csv_escape_field("plain") == "plain" && csv_format_i32(-2147483648) == "-2147483648" { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("text prelude accepts Unicode whitespace trimming", () => {
  const diagnostics = Source.analyze(`
const { text_trim_whitespace } = import "duck:prelude/text" ()
if text_trim_whitespace("\u{3000}\u{a0} duck \u{202f}") == "duck" { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("text prelude accepts source-defined repetition", () => {
  const diagnostics = Source.analyze(`
const { text_repeat } = import "duck:prelude/text" ()
text_repeat("duck", 3)
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("text prelude splits separators and preserves empty fields", () => {
  const diagnostics = Source.analyze(`
const { text_join, text_split, text_trim_end_ascii_whitespace } = import "duck:prelude/text" ()
let parts: List Text = text_split("alpha,,omega,", ",")
if let \`Cons first_node = parts {
  let [first, first_tail] = first_node
  if let \`Cons second_node = first_tail {
    let [second, second_tail] = second_node
    if let \`Cons third_node = second_tail {
      let [third, third_tail] = third_node
      if let \`Cons fourth_node = third_tail {
        let [fourth, done] = fourth_node
        if let \`Nil () = done {
          if first == "alpha" && second == "" && third == "omega" && fourth == "" && text_join(parts, "|") == "alpha||omega|" && text_trim_end_ascii_whitespace("duck \t") == "duck" { 42 } else { 0 }
        } else { 0 }
      } else { 0 }
    } else { 0 }
  } else { 0 }
} else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("list prelude exposes focused construction and queries", () => {
  const diagnostics = Source.analyze(`
const { list, list_append, list_drop, list_length, list_nth_or, list_reverse, list_singleton, list_take } = import "duck:prelude/list" ()
const ints = comptime list(I32)
let values = ints.append(ints.singleton(20), ints.singleton(22))
let taken = ints.take(1, values)
let dropped = ints.drop(1, values)
let reversed = ints.reverse(values)
const append_ints = list_append(I32)
const drop_ints = list_drop(I32)
const length_ints = list_length(I32)
const nth_int = list_nth_or(I32)
const reverse_ints = list_reverse(I32)
const singleton_int = list_singleton(I32)
const take_ints = list_take(I32)
let standalone = append_ints(singleton_int(20), singleton_int(22))
ints.length(values) * 10000000 + ints.nth_or(0, 0, taken) * 1000000 + ints.nth_or(0, 0, dropped) * 100000 + ints.nth_or(0, 0, reversed) * 10000 + length_ints(standalone) * 1000 + nth_int(0, 0, take_ints(1, standalone)) * 100 + nth_int(0, 0, drop_ints(1, standalone)) * 10 + nth_int(0, 0, reverse_ints(standalone))
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("path prelude resolves relative and absolute paths", () => {
  const diagnostics = Source.analyze(`
const { path_basename, path_is_absolute, path_parent, path_resolve } = import "duck:prelude/path" ()
let relative = path_resolve("/repo", "src/main.ts")
let absolute = path_resolve("/repo", "C:\\\\work\\\\main.ts")
if relative == "/repo/src/main.ts" && absolute == "C:\\\\work\\\\main.ts" && path_is_absolute("/tmp/file") && path_parent("/repo/src/main.ts") == "/repo/src" && path_basename(relative) == "main.ts" { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("functional prelude accepts output-specialized list maps", () => {
  const diagnostics = Source.analyze(`
const { list_fold_left, list_map } = import "duck:prelude/functional" ()
let values: List I32 = \`Cons ([1, \`Cons ([2, \`Cons ([3, \`Nil ()])])])
let mapped: List I32 = list_map(I32, values, value => value * 10)
list_fold_left(mapped, 0, (total, value) => total * 10 + value)
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("JSON prelude exposes object and duplicate key counts", () => {
  const diagnostics = Source.analyze(`
const { json_object_empty, json_object_key_count, json_object_length, json_object_prepend, json_string } = import "duck:prelude/json" ()
let fields = json_object_prepend("step", json_string("compile"), json_object_prepend("status", json_string("pending"), json_object_prepend("step", json_string("test"), json_object_empty())))
if json_object_length(fields) == 3 && json_object_key_count("step", fields) == 2 && json_object_key_count("missing", fields) == 0 { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("JSON encoder exposes source-defined pretty output", () => {
  const diagnostics = Source.analyze(`
const { encode_json_pretty } = import "duck:prelude/json/encode" ()
const { json_array, json_array_prepend, json_object, json_object_prepend, json_string } = import "duck:prelude/json/values" ()
let values = json_array_prepend(json_string("duck"), \`Nil ())
let fields = json_object_prepend("items", json_array(values), \`Nil ())
encode_json_pretty(json_object(fields))
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("types prelude exposes compile-time struct construction", async () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude/types" ()
type Pair = struct { .left = I32, .right = I32 }
let pair: Pair = [20, 22]
pair.left + pair.right
`);
  const instance = await instantiate_wat(wat, "prelude_types", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("types prelude test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("types prelude owns common algebraic categories", async () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude/types" ()
type Wrapped = struct { .value = I32 }
type CountFieldPatch = FieldPatch I32
let selected: Option Wrapped = \`Some ([.value = 42] as Wrapped)
let update: CountFieldPatch = \`Set 1
if let \`Some wrapped = selected {
  if let \`Set increment = update { wrapped.value + increment } else { 0 }
} else {
  0
}
`);
  const instance = await instantiate_wat(wat, "prelude_type_categories", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("type categories prelude test omitted main");
  }

  assert_equals(main(), 43);
});

Deno.test("time prelude accepts RFC3339 parsing programs", () => {
  const diagnostics = Source.analyze(`
const { rfc3339_unix_seconds_or_zero } = import "duck:prelude/time" ()
@unsafe_i32_wrap_i64(rfc3339_unix_seconds_or_zero("2000-02-29T01:00:00+01:00"))
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("time prelude type checks Unix second formatting", () => {
  const diagnostics = Source.analyze(`
const { unix_seconds_utc } = import "duck:prelude/time" ()
unix_seconds_utc(1781717655i64)
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("time prelude type checks elapsed duration formatting", () => {
  const diagnostics = Source.analyze(`
const { format_microseconds_seconds_4 } = import "duck:prelude/time" ()
format_microseconds_seconds_4(1234567i64)
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("numeric prelude type checks I64 bounds", () => {
  const diagnostics = Source.analyze(`
const { min_i64, max_i64 } = import "duck:prelude/numeric" ()
min_i64(3i64, max_i64(4i64, 2i64))
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("abstractions prelude keeps domain scalars distinct", async () => {
  const wat = Source.wat(`
const { byte_offset, byte_offset_value, duration_ms, duration_ms_value, exit_code, exit_code_value, unix_time_ms, unix_time_ms_value } = import "duck:prelude/abstractions" ()
const { unsafe_i32_wrap_i64 } = import "duck:prelude/numeric" ()

let offset = byte_offset_value(byte_offset 3)
let code = exit_code_value(exit_code 4)
let duration = unsafe_i32_wrap_i64(duration_ms_value(duration_ms 5i64))
let instant = unsafe_i32_wrap_i64(unix_time_ms_value(unix_time_ms 6i64))
offset + code + duration + instant
`);
  const instance = await instantiate_wat(wat, "prelude_domain_scalars", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("domain scalar prelude test omitted main");
  }

  assert_equals(main(), 18);
});

Deno.test("abstractions prelude measures monotonic durations", () => {
  const diagnostics = Source.analyze(`
const { duration_add, duration_between, duration_ms, duration_ms_value, monotonic_ms, unix_time_ms, unix_time_seconds_from_ms, unix_time_seconds_value } = import "duck:prelude/abstractions" ()
let elapsed = duration_between(monotonic_ms(100i64), monotonic_ms(142i64))
let reversed = duration_between(monotonic_ms(142i64), monotonic_ms(100i64))
let total = duration_add(elapsed, duration_ms(8i64))
let seconds: I64 = unix_time_seconds_value(unix_time_seconds_from_ms(unix_time_ms(7000i64)))
if duration_ms_value(total) == 50i64 && duration_ms_value(reversed) == 0i64 && seconds == 7i64 { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("abstractions prelude rejects invalid fuel and spans", async () => {
  const wat = Source.wat(`
const { fuel, fuel_is_exhausted, span_is_valid } = import "duck:prelude/abstractions" ()
if fuel_is_exhausted(fuel(0)) && !span_is_valid(7, 3) { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_checked_values", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("checked abstraction prelude test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("abstractions prelude consumes fuel", async () => {
  const wat = Source.wat(`
const { consume_fuel, fuel } = import "duck:prelude/abstractions" ()
consume_fuel(fuel(3))
`);
  const instance = await instantiate_wat(wat, "prelude_fuel", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("fuel prelude test omitted main");
  }

  assert_equals(main(), 2);
});

Deno.test("abstractions prelude computes bounded exponential backoff", () => {
  const analysis = Source.analyze(`
const { duration_ms, duration_ms_value, exponential_backoff } = import "duck:prelude/abstractions" ()
let base = duration_ms(200i64)
let first = duration_ms_value(exponential_backoff(base, 1i64, 1000))
let fourth = duration_ms_value(exponential_backoff(base, 4i64, 900))
let saturated = duration_ms_value(exponential_backoff(duration_ms(9223372036854775807i64), 2i64, 1100))
if first == 200i64 && fourth == 1440i64 && saturated == 9223372036854775807i64 { 42 } else { 0 }
`);

  assert_equals(analysis.diagnostics, []);
});

Deno.test("abstractions prelude grants a one-shot claim once", () => {
  const diagnostics = Source.analyze(`
const { once, once_claim, once_is_claimed } = import "duck:prelude/abstractions" ()
let initial = once()
let first = once_claim(initial)
let second = once_claim(first.state)
if first.granted && !(second.granted) && once_is_claimed(second.state) { 42 } else { 0 }
`).diagnostics;
  assert_equals(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
});

Deno.test("abstractions prelude measures spans", async () => {
  const wat = Source.wat(`
const { span, span_length } = import "duck:prelude/abstractions" ()
span_length(span(5, 9))
`);
  const instance = await instantiate_wat(wat, "prelude_spans", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("span prelude test omitted main");
  }

  assert_equals(main(), 4);
});

Deno.test("single-constructor types construct and deconstruct one value", async () => {
  const wat = Source.wat(`
type X = \`X I32
const decrement: X -> X = value => if let \`X number = value {
  \`X (number - 1)
} else {
  \`X 0
}
if let \`X number = decrement(\`X 43) { number } else { 0 }
`);
  const instance = await instantiate_wat(wat, "single_constructor", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("single-constructor test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("abstractions prelude composes predicates and patches", async () => {
  const wat = Source.wat(`
const { patch, patch_apply, patch_compose, predicate, predicate_and, predicate_test, reducer, reducer_run } = import "duck:prelude/abstractions" ()
const positive = comptime predicate(value => value > 0)
const small = comptime predicate(value => value < 10)
const accepted = comptime predicate_and(positive, small)
const increment = comptime patch(value => value + 1)
const double = comptime patch(value => value * 2)
const update = comptime patch_compose(double, increment)
const sum = comptime reducer((state, value) => state + value)
let predicate_score = if predicate_test(accepted, 7) { 42 } else { 0 }
predicate_score + patch_apply(update, 20) + reducer_run(sum, 20, 22)
`);
  const instance = await instantiate_wat(wat, "prelude_combinators", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("abstraction combinator test omitted main");
  }

  assert_equals(main(), 126);
});

Deno.test("abstractions prelude hashes equal values consistently", async () => {
  const wat = Source.wat(`
const { hash_i32, hash_text } = import "duck:prelude/abstractions" ()
if hash_text("duck") == hash_text("duck") && hash_i32(2) != hash_i32(3) { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_hash", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("hash prelude test omitted main");
  }

  assert_equals(main(), 42);
});
