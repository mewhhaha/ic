import { assert_equals } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { Source } from "../frontend.ts";

Deno.test("runtime prelude text search helpers preserve byte offsets", async () => {
  const wat = Source.wat(`
const { text_starts_with, text_ends_with, text_find, text_contains, text_longest_suffix_prefix_length } = import "duck:prelude/runtime" ()

scratch {
let score = text_find ["x<tag>y", "<tag>"]
if text_starts_with ["ducklang", "duck"] { score = score + 10 }
if text_ends_with ["ducklang", "lang"] { score = score + 100 }
if text_contains ["functional core", "core"] { score = score + 1000 }
score + text_longest_suffix_prefix_length ["hello <oai-mem-", "<oai-mem-citation>"] * 10000
}
`);
  const instance = await instantiate_wat(wat, "prelude_text_search", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude text search test omitted main");
  }

  assert_equals(main(), 91_111);
});

Deno.test("runtime prelude escapes XML text without changing Unicode bytes", async () => {
  const wat = Source.wat(`
const { text_escape_xml } = import "duck:prelude/runtime" ()
if text_escape_xml("Mężny & <duck> \\\"'老虎") == "Mężny &amp; &lt;duck&gt; &quot;&apos;老虎" { 42 } else { 0 }
`);
  const instance = await instantiate_wat(wat, "prelude_text_escape_xml", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude XML escape test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("runtime prelude folds and predicates operate on text bytes", async () => {
  const wat = Source.wat(`
const { text_fold_i32, text_any, text_all, text_count } = import "duck:prelude/runtime" ()
const add = (state, byte) => state + byte
const digit = byte => byte >= 48 && byte <= 57
const ascii = byte => byte < 128

let folded = text_fold_i32("ABC", 0, add)
let count = text_count("a1b2", digit)
let any = if text_any("a1b2", digit) { 1 } else { 0 }
let all = if text_all("a1b2", ascii) { 1 } else { 0 }
folded * 100 + count * 10 + any + all
`);
  const instance = await instantiate_wat(wat, "prelude_text_fold", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude fold test omitted main");
  }

  assert_equals(main(), 19_822);
});

Deno.test("runtime prelude identifies ASCII whitespace bytes", async () => {
  const wat = Source.wat(`
const { text_byte_is_ascii_whitespace, text_byte_is_ascii_digit, text_byte_is_ascii_alpha, text_byte_is_ascii_alphanumeric, text_byte_is_ascii_hex_digit, text_count } = import "duck:prelude/runtime" ()
let whitespace = text_count(" a\tb\nc\r", text_byte_is_ascii_whitespace)
let digits = text_count("a1b29", text_byte_is_ascii_digit)
let alpha = text_count("aB1-", text_byte_is_ascii_alpha)
let alphanumeric = text_count("aB1-", text_byte_is_ascii_alphanumeric)
let hex_digits = text_count("09aFgZ", text_byte_is_ascii_hex_digit)
whitespace * 10000 + digits * 1000 + alpha * 100 + alphanumeric * 10 + hex_digits
`);
  const instance = await instantiate_wat(
    wat,
    "prelude_text_boundaries",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude text-boundary test omitted main");
  }

  assert_equals(main(), 43_234);
});

Deno.test("runtime prelude performs ASCII-insensitive text search", async () => {
  const wat = Source.wat(`
const { text_find_ascii_case_insensitive, text_contains_ascii_case_insensitive } = import "duck:prelude/runtime" ()
let contains = text_contains_ascii_case_insensitive(["OpenAI Codex ŻÓŁĆ", "cOdEx ŻÓŁĆ"])
let index = text_find_ascii_case_insensitive(["xxCoDeX", "codex"])
if contains && index == 2 { 42 } else { 0 }
`);
  const instance = await instantiate_wat(
    wat,
    "prelude_text_ascii_case",
    {},
  );
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude ASCII case test omitted main");
  }

  assert_equals(main(), 42);
});

Deno.test("runtime prelude splits text into ASCII words", async () => {
  const wat = Source.wat(`
const { text_ascii_words } = import "duck:prelude/runtime" ()
let words: List Text = text_ascii_words("  create_event: ID42 / Żółć  ")
if let \`Cons first_node = words {
  let [first, tail] = first_node
  if let \`Cons second_node = tail {
    let [second, tail] = second_node
    if let \`Cons third_node = tail {
      let [third, tail] = third_node
      if first == "create" && second == "event" && third == "ID42" {
        if let \`Nil () = tail { return 42 }
      }
    }
  }
}
0
`);
  const instance = await instantiate_wat(wat, "prelude_text_ascii_words", {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("runtime prelude ASCII word test omitted main");
  }

  assert_equals(main(), 42);
});
