import { assert_equals, assert_includes } from "../../src/assert.ts";
import { Source } from "../../src/frontend.ts";
import { build_binding_index } from "../../src/frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../../src/frontend/parser.ts";
import { source_facts } from "../../src/frontend/source_facts.ts";
import { hover } from "../../src/lsp/hover.ts";
import { create_state, handle_message } from "../../src/lsp/server.ts";
import { main } from "./editor.ts";
import { mock_runner } from "./host.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("editor source infers local types without diagnostics", () => {
  const source_url = new URL("./editor.duck", import.meta.url);
  const host_url = new URL("./host.duck", import.meta.url);
  const analysis = Source.analyze_file(source_url.href, {
    host_interface: Source.load(host_url.href),
    warnings: true,
  });

  assert_equals(analysis.diagnostics, []);
});

Deno.test("editor opens in the language server without diagnostics", async () => {
  const source_url = new URL("./editor.duck", import.meta.url);
  const root_url = new URL("../../", import.meta.url);
  const state = create_state();
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: { rootUri: root_url.href },
  });
  const messages = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: source_url.href,
        languageId: "duck",
        version: 1,
        text: await Deno.readTextFile(source_url),
      },
    },
  }) as [{
    params: {
      diagnostics: unknown[];
    };
  }];

  assert_equals(messages[0]?.params.diagnostics, []);
});

Deno.test("editor language service retains inferred local structure", async () => {
  const source_url = new URL("./editor.duck", import.meta.url);
  const text = await Deno.readTextFile(source_url);
  const parsed = parse_source_with_diagnostics(text);
  const compiler_facts = source_facts(parsed.source);
  const inserted = compiler_facts.statements.find((statement) => {
    return statement.tag === "bind" && statement.name === "inserted";
  });

  if (inserted === undefined) {
    throw new Error("Missing inserted editor binding");
  }

  const compiler_type_before = compiler_facts.definition_type_of.get(inserted)
    ?.get("name")?.name;
  const index = build_binding_index(parsed, 1);

  assert_equals(
    source_facts(parsed.source).definition_type_of.get(inserted)?.get("name")
      ?.name,
    compiler_type_before,
  );

  assert_equals(text.includes("as PieceSplit"), false);

  for (
    const expected of [
      { needle: "left_height = piece_tree_height left", type: "I32" },
      { needle: "root = join_piece_trees", type: "PieceTree" },
      { needle: "output = output_builder", type: "OutputBuilder" },
      { needle: "mode = if let `Extend", type: "Mode" },
    ]
  ) {
    const offset = text.indexOf(expected.needle);
    const result = hover(
      parsed.source,
      parsed.syntax,
      index,
      offset,
      "utf-16",
    );

    if (result === undefined) {
      throw new Error("Missing editor hover for " + expected.needle);
    }

    assert_includes(result.contents.value, ": " + expected.type);
  }
});

Deno.test("editor inserts saves and renders through the terminal effect", async () => {
  const runner = mock_runner(encoder.encode("abc"), [
    encoder.encode("iX"),
    encoder.encode("\x1b"),
    encoder.encode("wq"),
  ]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.frames.length, 3);
    assert_equals(runner.saves.map((value) => decoder.decode(value)), [
      "Xabc",
    ]);
  } finally {
    runner.dispose();
  }
});

Deno.test("editor preserves repeated save commands in one input batch", async () => {
  const runner = mock_runner(encoder.encode("abc"), [encoder.encode("wwq")]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.saves.map((value) => decoder.decode(value)), [
      "abc",
      "abc",
    ]);
  } finally {
    runner.dispose();
  }
});

Deno.test("editor movement and deletion respect UTF-8 code point boundaries", async () => {
  const runner = mock_runner(encoder.encode("a老b"), [encoder.encode("vldwq")]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.saves.map((value) => decoder.decode(value)), ["b"]);
  } finally {
    runner.dispose();
  }
});

Deno.test("editor handles arrow keys and Ctrl-C as terminal controls", async () => {
  const runner = mock_runner(encoder.encode("abc"), [
    encoder.encode("\x1b["),
    encoder.encode("Cdw"),
    Uint8Array.of(3),
  ]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.saves.map((value) => decoder.decode(value)), ["ac"]);
  } finally {
    runner.dispose();
  }
});
