import { assert_equals, assert_includes } from "../assert.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import { hover, signature_help } from "./hover.ts";

function analyzed(text: string) {
  const parsed = parse_source_with_diagnostics(text);
  return { parsed, index: build_binding_index(parsed, 1) };
}

function assert_hover_type(
  _text: string,
  analysis: ReturnType<typeof analyzed>,
  offset: number,
  expected: string,
): void {
  const result = hover(
    analysis.parsed.source,
    analysis.parsed.syntax,
    analysis.index,
    offset,
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing hover at offset " + offset);
  }

  const type_lines = result.contents.value.split("\n").filter((line) =>
    line.startsWith("type:")
  );
  assert_equals(type_lines, ["type: `" + expected + "`"]);
}

Deno.test("hover shows folded const closure captures", () => {
  const text = "const make_adder = n => {\n  x => x + n\n}\n\n" +
    "const add_three = comptime make_adder(3)\n\n" +
    "let value = add_three(29)\n";
  const { parsed, index } = analyzed(text);
  const result = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.lastIndexOf("add_three"),
    "utf-16",
  );

  assert_equals(result, {
    contents: {
      kind: "markdown",
      value: "**const closure** `add_three`\n\n" +
        "type: `function`\n\n" +
        "```ix\n(x) => x + n\n```\n\n" +
        "captures:\n- `n = 3`\n\n" +
        "latent effects: `<pure>`\n\n" +
        "ownership: `compile_time_static`",
    },
    range: {
      start: { line: 6, character: 12 },
      end: { line: 6, character: 21 },
    },
  });
});

Deno.test("hover names linear consume status and points", () => {
  const unused = "let !token = 1\n42\n";
  const unused_analysis = analyzed(unused);
  const unused_hover = hover(
    unused_analysis.parsed.source,
    unused_analysis.parsed.syntax,
    unused_analysis.index,
    unused.indexOf("token"),
    "utf-16",
  );

  if (unused_hover === undefined) {
    throw new Error("Missing unused linear hover");
  }

  assert_includes(
    unused_hover.contents.value,
    "consume status: not yet consumed",
  );

  const consumed = "let !token = 1\n!token\n";
  const consumed_analysis = analyzed(consumed);
  const consumed_hover = hover(
    consumed_analysis.parsed.source,
    consumed_analysis.parsed.syntax,
    consumed_analysis.index,
    consumed.indexOf("token"),
    "utf-16",
  );

  if (consumed_hover === undefined) {
    throw new Error("Missing consumed linear hover");
  }

  assert_includes(
    consumed_hover.contents.value,
    "consume point: line 2, column 2",
  );
});

Deno.test("hover shows declaration docs and complete layout facts", () => {
  const text = "// Point documentation.\n" +
    "type Point = [.x = I32, .wide = I64]\n";
  const { parsed, index } = analyzed(text);
  const result = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.lastIndexOf("Point"),
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing type hover");
  }

  assert_equals(
    result.contents.value,
    "**type** `Point`\n\n" +
      "Point documentation.\n\n" +
      "```ix\ntype Point = [.x = I32, .wide = I64]\n```\n\n" +
      "layout — size: `16`, align: `8`, field offsets: `x @ 0`, `wide @ 8`",
  );
});

Deno.test("hover shows inferred latent effect rows", () => {
  const text = "effect Counter { get: () => I32 }\n" +
    "let run: () -> <Counter> I32 = () => {\n" +
    "  value <- Counter.get()\n  value\n}\n";
  const { parsed, index } = analyzed(text);
  const result = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("run"),
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing effectful closure hover");
  }

  assert_includes(result.contents.value, "latent effects: `<Counter.get>`");
});

Deno.test("hover exposes frozen, scratch, and borrow provenance", () => {
  const text = 'let frozen = freeze "value"\n' +
    "let temporary = scratch { 1 }\n" +
    "let view = &frozen\n";
  const { parsed, index } = analyzed(text);

  for (
    const expected of [
      { name: "frozen", type: "Text", ownership: "frozen_shareable" },
      { name: "temporary", type: "I32", ownership: "scratch_backed" },
      { name: "view", type: "Text", ownership: "borrow_view" },
    ]
  ) {
    const result = hover(
      parsed.source,
      parsed.syntax,
      index,
      text.indexOf(expected.name),
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing wrapper hover for " + expected.name);
    }

    assert_includes(result.contents.value, expected.ownership);
    assert_includes(result.contents.value, "type: `" + expected.type + "`");
  }
});

Deno.test("hover reports Bool for boolean bindings and expressions", () => {
  const text = "let ready = true\nlet compared = 1 < 2\n";
  const { parsed, index } = analyzed(text);
  const binding = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("ready"),
    "utf-16",
  );
  const literal = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("true"),
    "utf-16",
  );
  const comparison = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("<"),
    "utf-16",
  );

  if (binding === undefined) {
    throw new Error("Missing boolean binding hover");
  }

  assert_includes(binding.contents.value, "type: `Bool`");
  assert_equals(literal, {
    contents: { kind: "markdown", value: "**expression**\n\ntype: `Bool`" },
    range: {
      start: { line: 0, character: 12 },
      end: { line: 0, character: 16 },
    },
  });
  assert_equals(comparison, {
    contents: { kind: "markdown", value: "**expression**\n\ntype: `Bool`" },
    range: {
      start: { line: 1, character: 15 },
      end: { line: 1, character: 20 },
    },
  });
});

Deno.test("hover excludes type positions from enclosing value expressions", () => {
  const text = "1 is I32\nlet f = (x: I32) => x\n";
  const { parsed, index } = analyzed(text);

  for (const offset of [text.indexOf("I32"), text.lastIndexOf("I32")]) {
    const result = hover(parsed.source, parsed.syntax, index, offset, "utf-16");
    assert_equals(result, undefined);
  }

  const is_expression = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("is"),
    "utf-16",
  );

  if (is_expression === undefined) {
    throw new Error("Missing type-test expression hover");
  }

  assert_includes(is_expression.contents.value, "type: `Bool`");

  const custom_text = "type Point = [.x = I32]\n" +
    "let point: Point = [.x = 1]\n";
  const custom_analysis = analyzed(custom_text);
  const custom_annotation = hover(
    custom_analysis.parsed.source,
    custom_analysis.parsed.syntax,
    custom_analysis.index,
    custom_text.lastIndexOf("Point"),
    "utf-16",
  );

  if (custom_annotation === undefined) {
    throw new Error("Missing resolved type annotation hover");
  }

  assert_includes(custom_annotation.contents.value, "**type** `Point`");
  assert_includes(
    custom_annotation.contents.value,
    "```ix\ntype Point = [.x = I32]\n```",
  );
});

Deno.test("handler state annotations suppress only their type token", () => {
  const text = "effect Check { test: () => Bool }\n" +
    "let checker = {\n" +
    "  let ready: Bool = true\n" +
    "  Check {\n" +
    "    test: (!resume) => !resume(ready),\n" +
    "    return: value => value,\n" +
    "  }\n" +
    "}\n";
  const analysis = analyzed(text);
  const annotation = hover(
    analysis.parsed.source,
    analysis.parsed.syntax,
    analysis.index,
    text.indexOf("Bool", text.indexOf("ready")),
    "utf-16",
  );

  assert_equals(annotation, undefined);
  assert_hover_type(text, analysis, text.indexOf("true"), "Bool");
  assert_hover_type(text, analysis, text.lastIndexOf("ready"), "Bool");
});

Deno.test("hover preserves nominal parameter annotations", () => {
  const text = "type Point = [.x = I32]\n" +
    "let f = (point: Point) => point\n";
  const { parsed, index } = analyzed(text);

  for (const offset of [text.indexOf("point"), text.lastIndexOf("point")]) {
    const result = hover(parsed.source, parsed.syntax, index, offset, "utf-16");

    if (result === undefined) {
      throw new Error("Missing parameter hover");
    }

    assert_includes(result.contents.value, "type: `Point`");
  }

  const module_text = "module (point: Point) where\n" +
    "type Point = [.x = I32]\n" +
    "point\n";
  const module_analysis = analyzed(module_text);

  for (
    const offset of [
      module_text.indexOf("point"),
      module_text.lastIndexOf("point"),
    ]
  ) {
    const result = hover(
      module_analysis.parsed.source,
      module_analysis.parsed.syntax,
      module_analysis.index,
      offset,
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing module parameter hover");
    }

    assert_includes(result.contents.value, "type: `Point`");
  }
});

Deno.test("hover infers primitive result types from operands", () => {
  const i64_text = "let a: I64 = 1i64\n" +
    "let b: I64 = 2i64\n" +
    "a + b\n";
  const i64_analysis = analyzed(i64_text);
  const i64_hover = hover(
    i64_analysis.parsed.source,
    i64_analysis.parsed.syntax,
    i64_analysis.index,
    i64_text.lastIndexOf("+"),
    "utf-16",
  );

  if (i64_hover === undefined) {
    throw new Error("Missing I64 primitive hover");
  }

  assert_includes(i64_hover.contents.value, "type: `I64`");

  const invalid_text = "true + 1\n";
  const invalid_analysis = analyzed(invalid_text);
  const invalid_hover = hover(
    invalid_analysis.parsed.source,
    invalid_analysis.parsed.syntax,
    invalid_analysis.index,
    invalid_text.indexOf("+"),
    "utf-16",
  );

  if (invalid_hover === undefined) {
    throw new Error("Missing invalid primitive hover");
  }

  assert_includes(invalid_hover.contents.value, "type: `unknown`");
});

Deno.test("hover infers results of known calls and declared fields", () => {
  const text = "type Flags = [.ready = Bool]\n" +
    "declare effect Choice { decide: (I32) => Bool }\n" +
    "let predicate: (I32) -> Bool = x => true\n" +
    "let choose = Choice.decide\n" +
    "predicate(1)\n" +
    "((x: I32) => true)(1)\n" +
    "Flags.ready\n" +
    "choose(1)\n";
  const { parsed, index } = analyzed(text);

  for (
    const expected of [
      {
        offset: text.indexOf("predicate(1)") + "predicate".length,
        type: "Bool",
      },
      { offset: text.indexOf(")(1)") + 1, type: "Bool" },
      { offset: text.indexOf("Flags.ready") + "Flags".length, type: "Bool" },
      { offset: text.indexOf("choose ="), type: "(I32) -> Bool" },
      { offset: text.lastIndexOf("choose(1)") + "choose".length, type: "Bool" },
    ]
  ) {
    const result = hover(
      parsed.source,
      parsed.syntax,
      index,
      expected.offset,
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing known expression hover at " + expected.offset);
    }

    assert_includes(result.contents.value, "type: `" + expected.type + "`");
  }
});

Deno.test("hover rejects incompatible primitive operand types", () => {
  for (
    const example of [
      { text: "1i64 + 1\n", operator: "+", type: "unknown" },
      { text: "1i64 < 1\n", operator: "<", type: "unknown" },
      { text: "true == 1\n", operator: "==", type: "unknown" },
      { text: "true < false\n", operator: "<", type: "unknown" },
      { text: "true == false\n", operator: "==", type: "Bool" },
      { text: "1i64 < 2i64\n", operator: "<", type: "Bool" },
      { text: '"left" == "right"\n', operator: "==", type: "Bool" },
    ]
  ) {
    const { parsed, index } = analyzed(example.text);
    const result = hover(
      parsed.source,
      parsed.syntax,
      index,
      example.text.indexOf(example.operator),
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing primitive hover for " + example.text.trim());
    }

    assert_includes(result.contents.value, "type: `" + example.type + "`");
  }

  const binding_text = "let mixed = 1i64 + 1\n";
  const binding_analysis = analyzed(binding_text);
  const binding = hover(
    binding_analysis.parsed.source,
    binding_analysis.parsed.syntax,
    binding_analysis.index,
    binding_text.indexOf("mixed"),
    "utf-16",
  );

  if (binding === undefined) {
    throw new Error("Missing mixed-width binding hover");
  }

  assert_includes(binding.contents.value, "type: `unknown`");
});

Deno.test("hover documentation cannot add a generated type line", () => {
  const text = "// type: misleading documentation\n" +
    "// Ordinary documentation.\n" +
    "let ready = true\n";
  const { parsed, index } = analyzed(text);
  const result = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("ready"),
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing documented binding hover");
  }

  const type_lines = result.contents.value.split("\n").filter((line) =>
    line.startsWith("type:")
  );
  assert_equals(type_lines, ["type: `Bool`"]);
  assert_includes(result.contents.value, "> type: misleading documentation");
  assert_includes(result.contents.value, "Ordinary documentation.");
});

Deno.test("hover folds boolean const values without losing their type", () => {
  const text = "const ready = comptime 2 < 3\n";
  const { parsed, index } = analyzed(text);
  const result = hover(
    parsed.source,
    parsed.syntax,
    index,
    text.indexOf("ready"),
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing folded boolean hover");
  }

  assert_includes(result.contents.value, "type: `Bool`");
  assert_includes(result.contents.value, "value:\n```ix\ntrue\n```");
  assert_includes(result.contents.value, "ownership: `scalar_local`");
});

Deno.test("hover shows one honest type line for every value entity", () => {
  const text = "type Result = .ok = Bool | .err = Text\n" +
    "declare effect Choice { decide: (I32) => Bool }\n" +
    "let identity = value => value\n" +
    "let unresolved = missing\n";
  const { parsed, index } = analyzed(text);

  for (
    const expected of [
      { name: "ok", type: "(Bool) -> Result" },
      { name: "err", type: "(Text) -> Result" },
      { name: "decide", type: "(I32) -> Bool" },
      { name: "identity", type: "function" },
      { name: "value", type: "unknown" },
      { name: "unresolved", type: "unknown" },
    ]
  ) {
    const result = hover(
      parsed.source,
      parsed.syntax,
      index,
      text.indexOf(expected.name),
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing value hover for " + expected.name);
    }

    const type_lines = result.contents.value.split("\n").filter((line) =>
      line.startsWith("type:")
    );
    assert_equals(type_lines.length, 1);
    assert_equals(type_lines[0], "type: `" + expected.type + "`");
  }
});

Deno.test("hover preserves finite type-set annotations", () => {
  const text = "type Scalar = Bool | Text\n" +
    "let named: Scalar = true\n" +
    "let inline: Bool | I32 = false\n" +
    "let invalid: Scalar = 1\n" +
    "named\ninline\ninvalid\n";
  const analysis = analyzed(text);

  assert_hover_type(text, analysis, text.lastIndexOf("named"), "Scalar");
  assert_hover_type(
    text,
    analysis,
    text.lastIndexOf("inline"),
    "Bool | I32",
  );
  assert_hover_type(text, analysis, text.lastIndexOf("invalid"), "unknown");
});

Deno.test("hover reports union case constructor types", () => {
  const text = "type Result = .ok = Bool | .err\n" +
    "let constructor = Result.ok\n" +
    "let value = Result.err\n";
  const analysis = analyzed(text);

  assert_hover_type(text, analysis, text.lastIndexOf("ok"), "(Bool) -> Result");
  assert_hover_type(text, analysis, text.lastIndexOf("err"), "Result");
});

Deno.test("hover keeps invalid recovered values unknown", () => {
  const text = "type Pair = [.ready = Bool]\n" +
    "effect Check { test: () => Bool }\n" +
    "let checker = Check { test: (!resume) => !resume(true), " +
    "return: (value: Bool) => value }\n" +
    "let bad: Pair = missing { ready: false }\n" +
    "let { absent } = { present: true }\n" +
    "let poisoned: Bool = 1\n" +
    "let f: (I32) -> Bool = x => true\n" +
    "try 1 with checker\n" +
    "bad.ready\n" +
    "absent\n" +
    "1 is Check\n" +
    "f(poisoned)\n";
  const analysis = analyzed(text);

  for (
    const offset of [
      text.indexOf("try 1"),
      text.indexOf("bad.ready") + "bad.".length,
      text.lastIndexOf("absent"),
      text.indexOf("is Check"),
      text.indexOf("f(poisoned)") + "f".length,
    ]
  ) {
    assert_hover_type(text, analysis, offset, "unknown");
  }
});

Deno.test("hover exposes unresolved declarations and invalid arities as unknown", () => {
  const text = "type Alias = missing_type\n" +
    "type Broken = [.value = missing_type]\n" +
    "effect Bad { run: (missing_type) => Bool }\n" +
    "effect Check { test: (I32) => Bool }\n" +
    "let identity = (value: Alias) => value\n" +
    "let f: (I32) -> Bool = (left, right) => true\n" +
    "let checker = Check {\n" +
    "  test: (input, !resume, extra) => true,\n" +
    "  return: value => value,\n" +
    "}\n" +
    "Broken.value\n" +
    "Bad.run\n";
  const analysis = analyzed(text);

  for (
    const offset of [
      text.indexOf("value: Alias"),
      text.indexOf("left"),
      text.indexOf("right"),
      text.indexOf("input"),
      text.indexOf("resume"),
      text.indexOf("extra"),
      text.indexOf("Broken.value") + "Broken.".length,
      text.indexOf("Bad.run") + "Bad.".length,
    ]
  ) {
    assert_hover_type(text, analysis, offset, "unknown");
  }
});

Deno.test("hover preserves legacy const aggregate types", () => {
  const text = "const flags_type = struct { ready: Bool }\n" +
    "const result_type = union { ok: Int, err: Int }\n" +
    "let flags = flags_type { ready: true }\n" +
    "let constructor = result_type.ok\n" +
    "let qualified = constructor(40)\n" +
    "let result: result_type = .ok(41)\n" +
    "if let .ok(value) = result { value } else { 0 }\n" +
    "flags.ready\n";
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("flags ="), type: "flags_type" },
      {
        offset: text.indexOf("flags_type { ready") +
          "flags_type { ready: ".length,
        type: "Bool",
      },
      {
        offset: text.indexOf("result_type.ok") + "result_type.".length,
        type: "(Int) -> result_type",
      },
      { offset: text.indexOf("qualified ="), type: "result_type" },
      { offset: text.indexOf("result: result_type"), type: "result_type" },
      { offset: text.indexOf(".ok(41)"), type: "result_type" },
      { offset: text.indexOf("value)"), type: "Int" },
      { offset: text.lastIndexOf("value"), type: "Int" },
      {
        offset: text.lastIndexOf("flags.ready") + "flags.".length,
        type: "Bool",
      },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }
});

Deno.test("hover follows nested lexical aliases and effect results", () => {
  const text = "effect Check { test: () => Bool }\n" +
    "let run = () => {\n" +
    "  let operation = Check.test\n" +
    "  let alias = operation\n" +
    "  let called = alias()\n" +
    "  state <- Check.test()\n" +
    "  called == state\n" +
    "}\n" +
    "run()\n";
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("operation ="), type: "() -> Bool" },
      { offset: text.indexOf("alias ="), type: "() -> Bool" },
      { offset: text.indexOf("alias()") + "alias".length, type: "Bool" },
      { offset: text.indexOf("called ="), type: "Bool" },
      { offset: text.indexOf("state <-"), type: "Bool" },
      { offset: text.lastIndexOf("state"), type: "Bool" },
      { offset: text.indexOf("=="), type: "Bool" },
      { offset: text.lastIndexOf("run()") + "run".length, type: "Bool" },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }
});

Deno.test("hover resolves typed parameters and higher-order calls", () => {
  const text = "let apply = (f: (I32) -> Bool) => {\n" +
    "  let alias = f\n" +
    "  alias(1)\n" +
    "}\n" +
    "let factory: () -> (I32) -> Bool = () => ((x: I32) => true)\n" +
    "let inferred_factory = () => (x => true)\n" +
    "apply(factory())\n" +
    "factory()(1)\n" +
    "inferred_factory()(1)\n";
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("f:"), type: "I32 -> Bool" },
      { offset: text.indexOf("alias ="), type: "I32 -> Bool" },
      { offset: text.indexOf("alias(1)") + "alias".length, type: "Bool" },
      {
        offset: text.indexOf("factory()(1)", text.indexOf("apply")) +
          "factory".length,
        type: "Bool",
      },
      {
        offset: text.lastIndexOf("factory()(1)") + "factory".length,
        type: "Bool",
      },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }
});

Deno.test("hover derives resumption call results from the handler return", () => {
  const text = "type Result = .done = Bool\n" +
    "effect Check { test: () => Bool }\n" +
    "let checker = Check {\n" +
    "  test: (!resume) => {\n" +
    "    let !later = !resume\n" +
    "    let completed = !later(true)\n" +
    "    completed\n" +
    "  },\n" +
    "  return: value => Result.done(value),\n" +
    "}\n";
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("resume)"), type: "(Bool) -> Result" },
      { offset: text.indexOf("later ="), type: "(Bool) -> Result" },
      {
        offset: text.indexOf("later(true)") + "later".length,
        type: "Result",
      },
      { offset: text.indexOf("completed ="), type: "Result" },
      { offset: text.lastIndexOf("completed"), type: "Result" },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }
});

Deno.test("hover resolves struct fields and indexes through product aliases", () => {
  const text = "type Pair = [.ready = Bool, .other = Bool]\n" +
    "type Alias = Pair\n" +
    "type Again = Alias\n" +
    "let declared: Again = [.ready = true, .other = false]\n" +
    "let inline = [.ready = true, .other = false]\n" +
    "let index = 1\n" +
    "declared[0]\n" +
    "declared[index]\n" +
    "inline.ready\n" +
    "inline[index]\n";
  const analysis = analyzed(text);

  for (
    const offset of [
      text.indexOf("declared[0]") + "declared".length,
      text.indexOf("declared[index]") + "declared".length,
      text.indexOf("inline.ready") + "inline".length,
      text.indexOf("inline[index]") + "inline".length,
    ]
  ) {
    assert_hover_type(text, analysis, offset, "Bool");
  }

  const mixed = "type Pair = [.ready = Bool, .wide = I64]\n" +
    "let pair: Pair = [.ready = true, .wide = 1i64]\n" +
    "pair[0]\n" +
    "pair[1]\n" +
    "pair[index]\n";
  const mixed_analysis = analyzed(mixed);
  assert_hover_type(
    mixed,
    mixed_analysis,
    mixed.indexOf("pair[0]") + "pair".length,
    "Bool",
  );
  assert_hover_type(
    mixed,
    mixed_analysis,
    mixed.indexOf("pair[1]") + "pair".length,
    "I64",
  );
  assert_hover_type(
    mixed,
    mixed_analysis,
    mixed.indexOf("pair[index]") + "pair".length,
    "unknown",
  );

  const cycle = "type Left = Right\n" +
    "type Right = Left\n" +
    "let value: Left = missing\n" +
    "value[0]\n";
  const cycle_analysis = analyzed(cycle);
  assert_hover_type(
    cycle,
    cycle_analysis,
    cycle.indexOf("value[0]") + "value".length,
    "unknown",
  );
});

Deno.test("hover preserves nominal unions and if-let payload types", () => {
  const text = "type Result = .ok = Bool | .err\n" +
    "let qualified = Result.ok(true)\n" +
    "let constructor = Result.ok\n" +
    "let alias = constructor\n" +
    "let through_alias = alias(false)\n" +
    "let unqualified = .ok(true)\n" +
    "if let .ok(payload) = through_alias { payload } else { false }\n";
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("qualified ="), type: "Result" },
      {
        offset: text.indexOf("Result.ok(true)") + "Result.ok".length,
        type: "Result",
      },
      { offset: text.indexOf("constructor ="), type: "(Bool) -> Result" },
      { offset: text.indexOf("alias ="), type: "(Bool) -> Result" },
      { offset: text.indexOf("through_alias ="), type: "Result" },
      { offset: text.indexOf("unqualified ="), type: "Result" },
      { offset: text.indexOf("payload)"), type: "Bool" },
      { offset: text.lastIndexOf("payload"), type: "Bool" },
      { offset: text.indexOf("if let"), type: "Bool" },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }
});

Deno.test("hover propagates value types through control flow and primitives", () => {
  const text = "let ready = true\n" +
    "let logical = ready && false\n" +
    "let equality = ready == false\n" +
    "let wide = 1i64\n" +
    "let comparison = wide < 2i64\n" +
    "let atoms = #a == #a\n" +
    "let units = () == ()\n" +
    "let branch = if ready { true } else { false }\n" +
    "let nested = { let local = true; local == false }\n" +
    "let repeated = loop { break true }\n";
  const analysis = analyzed(text);

  for (
    const name of [
      "ready",
      "logical",
      "equality",
      "comparison",
      "atoms",
      "units",
      "branch",
      "nested",
      "repeated",
    ]
  ) {
    assert_hover_type(text, analysis, text.indexOf(name), "Bool");
  }

  assert_hover_type(text, analysis, text.indexOf("wide ="), "I64");

  const invalid = 'let bad_logic = "x" && true\n' +
    "let bad_condition = if 1i64 { true } else { false }\n";
  const invalid_analysis = analyzed(invalid);
  assert_hover_type(
    invalid,
    invalid_analysis,
    invalid.indexOf("bad_logic"),
    "unknown",
  );
  assert_hover_type(
    invalid,
    invalid_analysis,
    invalid.indexOf("&&"),
    "unknown",
  );
  assert_hover_type(
    invalid,
    invalid_analysis,
    invalid.indexOf("bad_condition"),
    "unknown",
  );
  assert_hover_type(
    invalid,
    invalid_analysis,
    invalid.indexOf("if 1i64"),
    "unknown",
  );
});

Deno.test("hover types literals and remains safe after parse recovery", () => {
  const text = '"text"\n()\n#atom\n1\n2i64\ntrue\n';
  const analysis = analyzed(text);

  for (
    const expected of [
      { offset: text.indexOf("text"), type: "Text" },
      { offset: text.indexOf("()"), type: "Unit" },
      { offset: text.indexOf("#atom"), type: "#atom" },
      { offset: text.indexOf("1"), type: "I32" },
      { offset: text.indexOf("2i64"), type: "I64" },
      { offset: text.indexOf("true"), type: "Bool" },
    ]
  ) {
    assert_hover_type(text, analysis, expected.offset, expected.type);
  }

  const recovered = "let broken = [1,, 2]\nlet ready = true\nready\n";
  const recovered_analysis = analyzed(recovered);
  assert_hover_type(
    recovered,
    recovered_analysis,
    recovered.lastIndexOf("ready"),
    "Bool",
  );
});

Deno.test("hover exposes effect-analysis failures instead of claiming purity", () => {
  const text = "effect Check { test: () => Bool }\n" +
    "let broken = () => Check.missing()\n";
  const analysis = analyzed(text);
  const result = hover(
    analysis.parsed.source,
    analysis.parsed.syntax,
    analysis.index,
    text.indexOf("broken"),
    "utf-16",
  );

  if (result === undefined) {
    throw new Error("Missing failed-effect-analysis hover");
  }

  assert_includes(
    result.contents.value,
    "latent effects: `<effects unavailable>`",
  );
  assert_equals(
    result.contents.value.includes("latent effects: `<pure>`"),
    false,
  );
});

Deno.test("signature help tracks const parameters in an incomplete call", () => {
  const text = "// Apply a const callback.\n" +
    "let apply_const = (x, const f) => f(x)\n" +
    "const double = x => x * 2\n" +
    "apply_const(21, ";
  const { parsed, index } = analyzed(text);
  assert_equals(
    signature_help(parsed.source, parsed.syntax, index, text.length),
    {
      signatures: [{
        label: "apply_const(x, const f) <pure>",
        parameters: [{ label: "x" }, { label: "const f" }],
        activeParameter: 1,
        documentation: {
          kind: "markdown",
          value: "Apply a const callback.",
        },
      }],
      activeSignature: 0,
      activeParameter: 1,
    },
  );
});

Deno.test("signature help follows nested calls and effect operations", () => {
  const text = "// Read documentation.\n" +
    "declare effect Io { read: (Text, I32) => I32 }\n" +
    "let wrap = (value, count) => value\n" +
    'wrap(1, Io.read("x", ';
  const { parsed, index } = analyzed(text);
  assert_equals(
    signature_help(parsed.source, parsed.syntax, index, text.length),
    {
      signatures: [{
        label: "Io.read(Text, I32) => I32",
        parameters: [{ label: "Text" }, { label: "I32" }],
        activeParameter: 1,
        documentation: {
          kind: "markdown",
          value: "Read documentation.",
        },
      }],
      activeSignature: 0,
      activeParameter: 1,
    },
  );
});
