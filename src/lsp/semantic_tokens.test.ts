import { assert_equals } from "../assert.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import {
  dump_semantic_tokens,
  semantic_tokens,
  semantic_tokens_delta,
} from "./semantic_tokens.ts";

function tokens(text: string, version = 1) {
  const parsed = parse_source_with_diagnostics(text);
  const index = build_binding_index(parsed, version);
  return semantic_tokens(
    parsed.source,
    parsed.syntax,
    index,
    version,
    "utf-16",
  );
}

Deno.test("semantic tokens preserve const and runtime shadow generations", () => {
  const text = "const value = 1\nvalue\nvalue = 2\nvalue\n";
  assert_equals(dump_semantic_tokens(tokens(text)), [{
    line: 0,
    character: 6,
    length: 5,
    type: "variable",
    modifiers: ["declaration", "readonly"],
  }, {
    line: 1,
    character: 0,
    length: 5,
    type: "variable",
    modifiers: ["readonly"],
  }, {
    line: 2,
    character: 0,
    length: 5,
    type: "variable",
    modifiers: ["declaration", "modification"],
  }, {
    line: 3,
    character: 0,
    length: 5,
    type: "variable",
    modifiers: [],
  }]);
});

Deno.test("semantic tokens classify types, members, effects, and linear uses", () => {
  const text = "type Box item = (.value = item)\n" +
    "effect Counter { get: () => I32 }\n" +
    "let !token = 1\n!token\n" +
    "let box: Box = (.value = 1)\nbox.value\n";
  const dump = dump_semantic_tokens(tokens(text));

  assert_equals(
    dump.filter((token) =>
      token.type !== "variable" || token.modifiers.includes("linear")
    ),
    [{
      line: 0,
      character: 5,
      length: 3,
      type: "type",
      modifiers: ["declaration"],
    }, {
      line: 0,
      character: 9,
      length: 4,
      type: "typeParameter",
      modifiers: ["declaration"],
    }, {
      line: 0,
      character: 18,
      length: 5,
      type: "property",
      modifiers: ["declaration"],
    }, {
      line: 0,
      character: 26,
      length: 4,
      type: "typeParameter",
      modifiers: [],
    }, {
      line: 1,
      character: 7,
      length: 7,
      type: "interface",
      modifiers: ["declaration"],
    }, {
      line: 1,
      character: 17,
      length: 3,
      type: "method",
      modifiers: ["declaration"],
    }, {
      line: 2,
      character: 5,
      length: 5,
      type: "variable",
      modifiers: ["declaration", "linear"],
    }, {
      line: 3,
      character: 1,
      length: 5,
      type: "variable",
      modifiers: ["linear"],
    }, {
      line: 4,
      character: 9,
      length: 3,
      type: "type",
      modifiers: [],
    }, {
      line: 4,
      character: 17,
      length: 5,
      type: "property",
      modifiers: [],
    }, {
      line: 5,
      character: 4,
      length: 5,
      type: "property",
      modifiers: [],
    }],
  );
});

Deno.test("semantic tokens mark const calls and comptime regions", () => {
  const text = "const identity = x => x\n" +
    "const first = identity(1)\n" +
    "const second = comptime identity(2)\n";
  const dump = dump_semantic_tokens(tokens(text));
  const identities = dump.filter((token) => token.type === "function");

  assert_equals(identities, [{
    line: 0,
    character: 6,
    length: 8,
    type: "function",
    modifiers: ["declaration", "readonly"],
  }, {
    line: 1,
    character: 14,
    length: 8,
    type: "function",
    modifiers: ["readonly", "comptime"],
  }, {
    line: 2,
    character: 24,
    length: 8,
    type: "function",
    modifiers: ["readonly", "comptime"],
  }]);
});

Deno.test("semantic tokens mark whitespace const calls as comptime", () => {
  const text = "const identity = x => x\n" +
    "const answer = identity 21\n";
  const dump = dump_semantic_tokens(tokens(text));
  const identity = dump.find((token) =>
    token.line === 1 && token.character === 15
  );

  assert_equals(identity?.modifiers, ["readonly", "comptime"]);
});

Deno.test("semantic tokens range and recovery retain unaffected tokens", () => {
  const text = "let before = 1\nlet = broken\nlet after = before\nafter\n";
  const parsed = parse_source_with_diagnostics(text);
  const index = build_binding_index(parsed);
  const ranged = semantic_tokens(
    parsed.source,
    parsed.syntax,
    index,
    1,
    "utf-16",
    { start: text.indexOf("let after"), end: text.length },
  );

  assert_equals(
    dump_semantic_tokens(ranged).map((token) => [token.line, token.character]),
    [[2, 4], [2, 12], [3, 0]],
  );
});

Deno.test("semantic token results are stable and delta is minimal", () => {
  const before_text = "let first = 1\nlet second = first\nsecond\n";
  const after_text = "let first = 1\nlet renamed = first\nrenamed\n";
  const first = tokens(before_text, 1);
  const repeated = tokens(before_text, 1);
  const changed = tokens(after_text, 2);

  assert_equals(repeated, first);
  const delta = semantic_tokens_delta(first, changed);
  assert_equals(delta.resultId, changed.resultId);
  assert_equals(delta.edits.length, 1);
  const edit = delta.edits[0];

  if (edit === undefined) {
    throw new Error("Missing semantic token delta edit");
  }

  assert_equals(edit.start > 0, true);
  assert_equals(edit.deleteCount < first.data.length, true);
});
