import { assert_equals } from "../assert.ts";
import { expect } from "../expect.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { Source } from "../frontend/source.ts";
import { code_actions, resolve_code_action } from "./code_actions.ts";
import { analysis_diagnostics } from "./diagnostics.ts";
import { PositionIndex } from "./position.ts";

function actions(
  text: string,
  start = 0,
  end = text.length,
) {
  const analysis = Source.analyze(text);
  const parsed = Source.parse_with_diagnostics(text);
  const index = build_binding_index(parsed, 1);
  const positions = new PositionIndex(text, "utf-16");
  return {
    analysis,
    index,
    actions: code_actions(
      analysis.source,
      analysis.syntax,
      index,
      "file:///fixture.duck",
      1,
      {
        start: positions.position_from_offset(start),
        end: positions.position_from_offset(end),
      },
      analysis_diagnostics(analysis, "file:///fixture.duck", "utf-16"),
      "utf-16",
    ),
  };
}

function apply(
  text: string,
  action: ReturnType<typeof actions>["actions"][number],
) {
  const parsed = Source.parse_with_diagnostics(text);
  const resolved = resolve_code_action(action, {
    uri: "file:///fixture.duck",
    version: 1,
    text,
    parsed,
    index: build_binding_index(parsed, 1),
    encoding: "utf-16",
  });
  expect(resolved !== undefined, "Expected a resolved action");
  const edit = resolved.edit?.changes["file:///fixture.duck"]?.[0];
  expect(edit !== undefined, "Expected a workspace edit");
  const positions = new PositionIndex(text, "utf-16");
  const offsets = positions.offsets_from_range(edit.range);
  return text.slice(0, offsets.start) + edit.newText + text.slice(offsets.end);
}

Deno.test("code actions remove a pure unused linear binding", () => {
  const before = "let !token = 1;\n42\n";
  const result = actions(before);
  const action = result.actions.find((candidate) =>
    candidate.kind === "quickfix"
  );
  expect(action !== undefined, "Expected unused-linear quick fix");
  const after = apply(before, action);
  assert_equals(after, "42\n");
  assert_equals(Source.analyze(after).diagnostics, []);
});

Deno.test("code actions fix all pure unused linear bindings", () => {
  const before = "let !first = 1;\nlet !second = 2;\n42\n";
  const result = actions(before);
  const action = result.actions.find((candidate) =>
    candidate.kind === "source.fixAll"
  );

  expect(action !== undefined, "Expected unused-linear fix all");
  const after = apply(before, action);
  assert_equals(after, "42\n");
  assert_equals(Source.analyze(after).diagnostics, []);
});

Deno.test("code actions annotate inferred bindings and do not offer extraction off selection", () => {
  const before = "let answer = 42;\nanswer\n";
  const result = actions(before, 4, 10);
  const annotation = result.actions.find((candidate) =>
    candidate.title === "Annotate answer with inferred type"
  );
  expect(annotation !== undefined, "Expected annotation assist");
  assert_equals(apply(before, annotation), "let answer: I32 = 42;\nanswer\n");
  assert_equals(
    result.actions.some((candidate) => candidate.kind === "refactor.extract"),
    false,
  );
});

Deno.test("code actions annotate inferred Bool bindings", () => {
  const before = "let ready = true;\nready\n";
  const result = actions(before, 4, 9);
  const annotation = result.actions.find((candidate) =>
    candidate.title === "Annotate ready with inferred type"
  );

  expect(annotation !== undefined, "Expected Bool annotation assist");
  assert_equals(apply(before, annotation), "let ready: Bool = true;\nready\n");
});

Deno.test("code actions extract exactly a selected expression", () => {
  const before = "40 + 2\n";
  const result = actions(before, 0, 6);
  const extract = result.actions.find((candidate) =>
    candidate.kind === "refactor.extract"
  );
  expect(extract !== undefined, "Expected extract assist");
  assert_equals(apply(before, extract), "let extracted = 40 + 2;\nextracted\n");
  assert_equals(Source.analyze(apply(before, extract)).diagnostics, []);
});

Deno.test("code actions rewrite known constants and comptime expressions", () => {
  const before = "let answer = 42;\nanswer\n";
  const result = actions(before, 0, 15);
  const constant = result.actions.find((candidate) =>
    candidate.title === "Convert let answer to const"
  );
  const comptime = result.actions.find((candidate) =>
    candidate.title === "Wrap expression in comptime"
  );
  expect(constant !== undefined, "Expected const assist");
  expect(comptime !== undefined, "Expected comptime assist");
  assert_equals(apply(before, constant), "const answer = 42;\nanswer\n");
  assert_equals(apply(before, comptime), "let answer = comptime 42;\nanswer\n");
  assert_equals(Source.analyze(apply(before, constant)).diagnostics, []);
  assert_equals(Source.analyze(apply(before, comptime)).diagnostics, []);
});

Deno.test("code actions make reused scalar linear values shareable", () => {
  const before = "let !token = 41;\n!token + !token\n";
  const result = actions(before);
  const duplicate = result.actions.find((candidate) =>
    candidate.title === "Make scalar token shareable"
  );
  expect(duplicate !== undefined, "Expected linear reuse quick fix");
  assert_equals(
    apply(before, duplicate),
    "let token = 41;\n!token + !token\n",
  );
  assert_equals(Source.analyze(apply(before, duplicate)).diagnostics, []);
});

Deno.test("code actions widen mixed integer operands", () => {
  const before = "40i64 + 2i32\n";
  const result = actions(before, 0, before.length);
  const widen = result.actions.find((candidate) =>
    candidate.title === "Widen i32 operand to I64"
  );
  expect(widen !== undefined, "Expected integer widening quick fix");
  assert_equals(apply(before, widen), "40i64 + 2i64\n");
  assert_equals(Source.analyze(apply(before, widen)).diagnostics, []);
});

Deno.test("code actions complete concrete struct fields and union payloads", () => {
  const struct_before = `type User = struct {.name = Text, .age = Int}
let user: User = [.name = "Ada"];
user.age
`;
  const struct_action = actions(struct_before).actions.find((candidate) =>
    candidate.title === "Add missing field age"
  );
  expect(struct_action !== undefined, "Expected missing-field quick fix");
  assert_equals(
    apply(struct_before, struct_action),
    `type User = struct {.name = Text, .age = Int}
let user: User = [.name = "Ada", .age = 0];
user.age
`,
  );
  const union_before = "type Result = | `Ok Int | `Err Text\n" +
    'let result = `Ok ("wrong");\n';
  const union_action = actions(union_before).actions.find((candidate) =>
    candidate.title === "Replace union payload with I32 value"
  );
  expect(union_action !== undefined, "Expected union payload quick fix");
  assert_equals(
    apply(union_before, union_action),
    "type Result = | `Ok Int | `Err Text\n" +
      "let result = `Ok (0);\n",
  );
  assert_equals(
    Source.analyze(apply(struct_before, struct_action)).diagnostics,
    [],
  );
  assert_equals(
    Source.analyze(apply(union_before, union_action)).diagnostics,
    [],
  );
});

Deno.test("code actions use false for a missing Bool union payload", () => {
  const before = "type Result = | `Ok Bool | `Err Text\n" +
    "let result = `Ok (1);\n";
  const result = actions(before);
  const replacement = result.actions.find((candidate) =>
    candidate.title === "Replace union payload with Bool value"
  );

  expect(replacement !== undefined, "Expected Bool payload quick fix");
  const after = apply(before, replacement);
  assert_equals(
    after,
    "type Result = | `Ok Bool | `Err Text\n" +
      "let result = `Ok (false);\n",
  );
  assert_equals(Source.analyze(after).diagnostics, []);
});

Deno.test("code actions inline immediately consumed single-use bindings", () => {
  const before = "let answer = 42;\nanswer\n";
  const result = actions(before);
  const inline = result.actions.find((candidate) =>
    candidate.kind === "refactor.inline"
  );
  expect(inline !== undefined, "Expected inline assist");
  assert_equals(apply(before, inline), "42\n");
  assert_equals(Source.analyze(apply(before, inline)).diagnostics, []);
});

Deno.test("code actions reorder handler clauses against the effect declaration", () => {
  const before = `effect Counter { add: (I32) => Unit, get: () => I32 }
let counter = handler Counter {
  get: (!resume) => !resume(0),
  add: (value, !resume) => !resume(()),
  return: value => value,
};
`;
  const result = actions(before);
  const reorder = result.actions.find((candidate) =>
    candidate.title === "Reorder handler clauses for Counter"
  );
  expect(reorder !== undefined, "Expected handler reorder assist");
  assert_equals(
    apply(before, reorder),
    `effect Counter { add: (I32) => Unit, get: () => I32 }
let counter = handler Counter {
  add: (value, !resume) => !resume(()),
  get: (!resume) => !resume(0),
  return: value => value,
};
`,
  );
  assert_equals(Source.analyze(apply(before, reorder)).diagnostics, []);
});

Deno.test("code actions complete missing handler clauses", () => {
  const before = `effect Counter { add: (I32) => Unit, get: () => I32 }
let counter = handler Counter {
  get: (!resume) => !resume(0),
  return: value => value,
};
`;
  const result = actions(before);
  const complete = result.actions.find((candidate) =>
    candidate.title === "Complete handler for Counter"
  );
  expect(complete !== undefined, "Expected handler completion assist");
  const after = apply(before, complete);
  assert_equals(
    after,
    `effect Counter { add: (I32) => Unit, get: () => I32 }
let counter = handler Counter { add: (arg1, !resume) => !resume (), get: (!resume) => !resume 0, return: value => value };
`,
  );
  assert_equals(Source.analyze(after).diagnostics, []);
});

Deno.test("code actions use false for a missing Bool handler result", () => {
  const before = "effect Choice { decide: () => Bool }\n" +
    "let choice = handler Choice { return: value => value };\n";
  const result = actions(before);
  const complete = result.actions.find((candidate) =>
    candidate.title === "Complete handler for Choice"
  );

  expect(complete !== undefined, "Expected Bool handler completion assist");
  const after = apply(before, complete);
  assert_equals(
    after,
    `effect Choice { decide: () => Bool }
let choice = handler Choice { decide: (!resume) => !resume false, return: value => value };
`,
  );
  assert_equals(Source.analyze(after).diagnostics, []);
});

Deno.test("code actions add an explicit missing if-let case", () => {
  const before = "type Result = | `Ok Int | `Err Text\n" +
    "let result = `Ok (1);\n" +
    "if let `Ok value = result { value } else { 0 }\n";
  const result = actions(before);
  const branch = result.actions.find((candidate) =>
    candidate.title === "Add explicit `Err branch"
  );
  expect(branch !== undefined, "Expected missing-case assist");
  const after = apply(before, branch);
  assert_equals(
    after,
    "type Result = | `Ok Int | `Err Text\n" +
      "let result = `Ok (1);\n" +
      "if let `Ok value = result { value } else if let `Err value = result { 0 } else { 0 }\n",
  );
  assert_equals(Source.analyze(after).diagnostics, []);
});
