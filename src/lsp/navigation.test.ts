import { assert_equals } from "../assert.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import {
  definition_location,
  document_highlights,
  import_definition_location,
  prepare_rename,
  reference_locations,
  rename_symbol,
  type_definition_location,
  workspace_symbols,
} from "./navigation.ts";
import { PositionIndex } from "./position.ts";

function indexed(text: string) {
  const parsed = parse_source_with_diagnostics(text);
  return { parsed, index: build_binding_index(parsed, 1) };
}

Deno.test("navigation keeps shadow generations separate", () => {
  const text = "let x = 0\nx\nx = x + 1\nx\n";
  const { index } = indexed(text);
  const first_reference = text.indexOf("x\nx =");
  const last_reference = text.lastIndexOf("x\n");

  assert_equals(
    definition_location(
      index,
      text,
      "file:///main.duck",
      first_reference,
      "utf-16",
    ),
    {
      uri: "file:///main.duck",
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 5 },
      },
    },
  );
  assert_equals(
    reference_locations(
      index,
      text,
      "file:///main.duck",
      first_reference,
      true,
      "utf-16",
    ).map((location) => location.range.start.line),
    [0, 1, 2],
  );
  assert_equals(
    document_highlights(index, text, first_reference, "utf-16").map((item) =>
      item.kind
    ),
    [3, 2, 2],
  );
  assert_equals(
    reference_locations(
      index,
      text,
      "file:///main.duck",
      last_reference,
      true,
      "utf-16",
    ).map((location) => location.range.start.line),
    [2, 3],
  );
});

Deno.test("document highlights distinguish linear consumption", () => {
  const text = "let !token = 1\n!token\n";
  const { index } = indexed(text);
  assert_equals(
    document_highlights(index, text, text.lastIndexOf("token"), "utf-16")
      .map((item) => item.kind),
    [3, 1],
  );
});

Deno.test("type definition follows nominal binding facts", () => {
  const text = "type Pair = [.left = Int]\n" +
    "let value: Pair = [.left = 1]\nvalue.left\n";
  const { index } = indexed(text);
  assert_equals(
    type_definition_location(
      index,
      text,
      "file:///main.duck",
      text.lastIndexOf("value"),
      "utf-16",
    ),
    {
      uri: "file:///main.duck",
      range: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 9 },
      },
    },
  );
});

Deno.test("import definitions jump to the imported file from alias references", () => {
  const text = 'const value = import "./dep.duck"\nvalue\n';
  const { parsed, index } = indexed(text);
  assert_equals(
    import_definition_location(
      parsed.source,
      index,
      "file:///main.duck",
      text.lastIndexOf("value"),
    ),
    {
      uri: "file:///dep.duck",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  );
});

Deno.test("import definitions jump to the imported file from expressions", () => {
  const text = 'let module = import "./dep.duck"\n';
  const { parsed, index } = indexed(text);

  assert_equals(
    import_definition_location(
      parsed.source,
      index,
      "file:///main.duck",
      text.indexOf("dep.duck"),
    ),
    {
      uri: "file:///dep.duck",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  );
});

Deno.test("rename edits exactly one shadow generation and preserves index shape", () => {
  const text = "let x = 0\nx\nx = x + 1\nx\n";
  const { index } = indexed(text);
  const edit = rename_symbol(
    index,
    text,
    "file:///main.duck",
    text.indexOf("x\nx ="),
    "base",
    "utf-16",
  );

  if (edit === undefined) {
    throw new Error("Expected rename edit");
  }

  assert_equals(
    edit.changes["file:///main.duck"]?.map((item) => item.range.start.line),
    [0, 1, 2],
  );
  const edits = edit.changes["file:///main.duck"];

  if (edits === undefined) {
    throw new Error("Missing shadow rename edits");
  }

  const renamed = apply_edits(text, edits);
  assert_equals(renamed, "let base = 0\nbase\nx = base + 1\nx\n");
  const renamed_index = indexed(renamed).index;
  assert_equals(index_shape(renamed_index), index_shape(index));
});

Deno.test("rename respects const capture snapshots", () => {
  const text = "let value = 1\nconst captured = () => value\n" +
    "value = 2\ncaptured() + value\n";
  const { index } = indexed(text);
  const edit = rename_symbol(
    index,
    text,
    "file:///main.duck",
    text.indexOf("value", text.indexOf("=>")),
    "snapshot",
    "utf-16",
  );

  if (edit === undefined) {
    throw new Error("Expected const-capture rename");
  }

  assert_equals(
    edit.changes["file:///main.duck"]?.map((item) => item.range.start.line),
    [0, 1],
  );
});

for (
  const fixture of [
    {
      label: "field",
      text: "type User = [.name = Text]\n" +
        "let struct { .name= Text } = User\n" +
        'let value: User = [.name = "Ada"]\nvalue.name\n',
      selected: ".name",
      replacement: "label",
      count: 4,
    },
    {
      label: "union case",
      text: "type Result = | .ok = Int\n" +
        "let value = Result.ok(1)\n" +
        "if let .ok(payload) = value { payload }\n",
      selected: ".ok",
      replacement: "success",
      count: 3,
    },
    {
      label: "effect operation",
      text: "effect Counter { get: () => I32 }\n" +
        "let run = () => Counter.get()\n" +
        "let handler = Counter { get: (!resume) => !resume(1), " +
        "return: value => value }\n",
      selected: "get:",
      replacement: "read",
      count: 3,
    },
  ]
) {
  Deno.test("rename resolves every " + fixture.label + " site", () => {
    const { index } = indexed(fixture.text);
    const selected = fixture.text.indexOf(fixture.selected) + 1;
    const edit = rename_symbol(
      index,
      fixture.text,
      "file:///main.duck",
      selected,
      fixture.replacement,
      "utf-16",
    );

    if (edit === undefined) {
      throw new Error("Expected " + fixture.label + " rename");
    }

    const edits = edit.changes["file:///main.duck"];

    if (edits === undefined) {
      throw new Error("Missing rename edits");
    }

    assert_equals(edits.length, fixture.count);
    const renamed = apply_edits(fixture.text, edits);
    assert_equals(parse_source_with_diagnostics(renamed).diagnostics, []);
    assert_equals(index_shape(indexed(renamed).index), index_shape(index));
  });
}

Deno.test("rename rejects builtins, unresolved names, and capture", () => {
  const text = "let left = 1\nlet right = left\nunknown + @len(right)\n";
  const { index } = indexed(text);
  assert_equals(
    prepare_rename(index, text, text.indexOf("len"), "utf-16"),
    undefined,
  );
  assert_equals(
    prepare_rename(index, text, text.indexOf("unknown"), "utf-16"),
    undefined,
  );
  assert_equals(
    rename_symbol(
      index,
      text,
      "file:///main.duck",
      text.indexOf("left"),
      "right",
      "utf-16",
    ),
    undefined,
  );
  assert_equals(
    rename_symbol(
      index,
      text,
      "file:///main.duck",
      text.indexOf("left"),
      "Bool",
      "utf-16",
    ),
    undefined,
  );
});

Deno.test("workspace symbols fuzzy-match declarations and members", () => {
  const first = "type Account = [.display_name = Text]\n";
  const second = "let calculate_total = 42\n";
  const first_index = indexed(first).index;
  const second_index = indexed(second).index;
  const symbols = workspace_symbols(
    [
      { uri: "file:///one.duck", text: first, index: first_index },
      { uri: "file:///two.duck", text: second, index: second_index },
    ],
    "dname",
    "utf-16",
  );

  assert_equals(symbols.map((symbol) => symbol.name), ["display_name"]);
  assert_equals(symbols[0]?.containerName, "Account");
});

function apply_edits(
  text: string,
  edits: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }[],
): string {
  const positions = new PositionIndex(text, "utf-16");
  const replacements = edits.map((edit) => ({
    start: positions.offset_from_position(edit.range.start),
    end: positions.offset_from_position(edit.range.end),
    text: edit.newText,
  })).sort((left, right) => right.start - left.start);
  let result = text;

  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text +
      result.slice(replacement.end);
  }

  return result;
}

function index_shape(index: ReturnType<typeof build_binding_index>): unknown {
  return {
    entities: [...index.entities.values()].map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      scope: entity.scope,
      owner: entity.owner,
    })),
    occurrences: [...index.occurrences.values()].map((occurrence) => ({
      role: occurrence.role,
      entity: occurrence.entity,
      unresolved: occurrence.unresolved,
    })),
    references: [...index.references.entries()],
  };
}
