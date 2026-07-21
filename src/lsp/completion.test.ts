import { assert_equals, assert_includes } from "../assert.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import {
  completions,
  type LspCompletionItem,
  resolve_completion_item,
} from "./completion.ts";

function complete(text: string, options: { import_paths?: string[] } = {}) {
  const parsed = parse_source_with_diagnostics(text);
  const index = build_binding_index(parsed, 3);
  return completions(
    parsed.source,
    parsed.syntax,
    index,
    "file:///main.duck",
    text.length,
    options,
  );
}

function item_shape(item: LspCompletionItem) {
  return {
    label: item.label,
    kind: item.kind,
    detail: item.detail,
    sortText: item.sortText,
  };
}

Deno.test("completion lists exactly the known typed struct fields", () => {
  const result = complete(
    "type User = struct {.name = Text, .age = Int}\n" +
      'let user: User = [.name = "Ada", .age = 42]\nuser.',
  );

  assert_equals(result.items.map(item_shape), [{
    label: "age",
    kind: 5,
    detail: "field: Int",
    sortText: "0000_0_age",
  }, {
    label: "name",
    kind: 5,
    detail: "field: Text",
    sortText: "0000_0_name",
  }]);
});

Deno.test("completion lists declared effect operations with signatures", () => {
  const result = complete(
    "declare effect Io {\n" +
      "  read: (Text) => I32\n" +
      "  write: (Text, I32) => Unit\n" +
      "}\nIo.",
  );

  assert_equals(result.items.map(item_shape), [{
    label: "read",
    kind: 2,
    detail: "operation: (Text) => I32",
    sortText: "0000_0_read",
  }, {
    label: "write",
    kind: 2,
    detail: "operation: (Text, I32) => Unit",
    sortText: "0000_0_write",
  }]);
});

Deno.test("completion offers recovered scope names inside a broken statement", () => {
  const result = complete("let outer = 1\nlet broken =\nout");
  assert_equals(result.items.map(item_shape), [{
    label: "outer",
    kind: 6,
    detail: "runtime binding: I32",
    sortText: "0000_0_outer",
  }]);
});

Deno.test("completion ranks local scope before outer scope and keywords", () => {
  const text = "let outer = 1\nlet result = {\n  let inner = 2\n  \n}";
  const offset = text.indexOf("  \n}") + 2;
  const parsed = parse_source_with_diagnostics(text);
  const index = build_binding_index(parsed);
  const result = completions(
    parsed.source,
    parsed.syntax,
    index,
    "file:///main.duck",
    offset,
  );
  const inner = result.items.find((item) => item.label === "inner");
  const outer = result.items.find((item) => item.label === "outer");
  const keyword = result.items.find((item) => item.label === "let");

  assert_equals(inner?.sortText.startsWith("0000"), true);
  assert_equals(outer?.sortText.startsWith("0001"), true);
  assert_equals(keyword?.sortText.startsWith("9000"), true);
});

Deno.test("completion lists union constructors with payload details", () => {
  const result = complete(
    "type Result = | `Ok Int | `Error Text\n" +
      "let value: Result = `",
  );

  assert_equals(result.items.map(item_shape), [{
    label: "Error",
    kind: 20,
    detail: "case: Text",
    sortText: "0000_0_Error",
  }, {
    label: "Ok",
    kind: 20,
    detail: "case: Int",
    sortText: "0000_0_Ok",
  }]);
});

Deno.test("completion degrades unknown member receivers to no items", () => {
  assert_equals(complete("unknown.").items, []);
});

Deno.test("completion filters keyword snippets by statement prefix", () => {
  const result = complete("fo");
  assert_equals(result.items.map(item_shape), [{
    label: "for",
    kind: 15,
    detail: "Duck snippet",
    sortText: "9000_0_for",
  }]);
  assert_equals(result.items[0]?.insertTextFormat, 2);
});

Deno.test("completion lists sibling import paths deterministically", () => {
  const result = complete('let item = import "d', {
    import_paths: ["./alpha.duck", "./dep.duck", "./delta.duck"],
  });
  assert_equals(result, {
    isIncomplete: false,
    items: [{
      label: "./dep.duck",
      kind: 17,
      detail: "Duck source file",
      sortText: "00_./dep.duck",
      insertText: "./dep.duck",
    }, {
      label: "./delta.duck",
      kind: 17,
      detail: "Duck source file",
      sortText: "00_./delta.duck",
      insertText: "./delta.duck",
    }],
  });
});

Deno.test("completion lists paths inside import expressions", () => {
  const result = complete('let module = import "./d', {
    import_paths: ["./alpha.duck", "./dep.duck", "./delta.duck"],
  });

  assert_equals(result.items.map((item) => item.label), [
    "./dep.duck",
    "./delta.duck",
  ]);
});

Deno.test("completion resolve attaches doc comments and type layout", () => {
  const text = "/// Two-dimensional point.\n" +
    "type Point = struct {.x = I32, .y = I32}\nPo";
  const parsed = parse_source_with_diagnostics(text);
  const index = build_binding_index(parsed);
  const result = completions(
    parsed.source,
    parsed.syntax,
    index,
    "file:///main.duck",
    text.length,
  );
  const point = result.items.find((item) => item.label === "Point");

  if (point === undefined) {
    throw new Error("Missing Point completion");
  }

  const resolved = resolve_completion_item(
    point,
    parsed.source,
    index,
    parsed.syntax,
  );
  const documentation = resolved.documentation?.value;

  if (documentation === undefined) {
    throw new Error("Missing resolved documentation");
  }

  assert_includes(documentation, "Two-dimensional point.");
  assert_includes(documentation, "size 8");
  assert_includes(documentation, "align 4");
});

Deno.test("completion annotates linear bindings with consuming insertion", () => {
  const result = complete("let !token = 1\n");
  const token = result.items.find((item) => item.label === "!token");
  assert_equals(token?.detail, "linear !token: I32");
  assert_equals(token?.insertText, "!token");
});

Deno.test("completion offers operation and return snippets in handler bodies", () => {
  const result = complete(
    "declare effect Io {\n  read: () => I32\n  write: (Text) => Unit\n}\n" +
      "let handler = Io {\n  ",
  );
  assert_equals(result.items.map((item) => item.label), [
    "read",
    "write",
    "return",
  ]);
  assert_equals(result.items[0]?.insertText, "read: (${1:args}) => $0");
  assert_equals(result.items[0]?.insertTextFormat, 2);
});

Deno.test("completion filters runtime values out of type positions", () => {
  const result = complete(
    "type Pair = [Int, Int]\nlet runtime = 1\nlet value: ",
  );
  assert_equals(result.items.some((item) => item.label === "Pair"), true);
  assert_equals(result.items.some((item) => item.label === "runtime"), false);
  assert_equals(result.items.some((item) => item.label === "Text"), true);
});

Deno.test("completion offers Bool in type positions", () => {
  assert_equals(complete("let value: Bo").items.map(item_shape), [{
    label: "Bool",
    kind: 7,
    detail: "builtin type",
    sortText: "9000_0_Bool",
  }]);
});

Deno.test("completion offers Char in type positions", () => {
  assert_equals(complete("let value: Ch").items.map(item_shape), [{
    label: "Char",
    kind: 7,
    detail: "builtin type",
    sortText: "9000_0_Char",
  }]);
});
