import { assert_equals } from "../assert.ts";
import { encode_message, MessageDecoder } from "./framing.ts";
import type { LspPosition, LspRange } from "./position.ts";
import { parse_diagnostics } from "./diagnostics.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import { document_symbols } from "./symbols.ts";
import type { LspCompletionItem } from "./completion.ts";
import {
  create_state,
  flush_due_diagnostics,
  handle_message,
  next_diagnostic_deadline,
} from "./server.ts";

const completion_triggers = [
  ".",
  '"',
  "_",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."abcdefghijklmnopqrstuvwxyz",
];

Deno.test("message decoder reassembles split frames", () => {
  const framed = encode_message({ id: 1, method: "initialize" });
  const decoder = new MessageDecoder();
  assert_equals(decoder.push(framed.slice(0, 7)), []);
  assert_equals(decoder.push(framed.slice(7, 30)), []);
  assert_equals(decoder.push(framed.slice(30)), [{
    id: 1,
    method: "initialize",
  }]);
});

Deno.test("message decoder handles back-to-back frames", () => {
  const first = encode_message({ id: 1 });
  const second = encode_message({ id: 2 });
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  const decoder = new MessageDecoder();
  assert_equals(decoder.push(combined), [{ id: 1 }, { id: 2 }]);
});

Deno.test("parse diagnostics report positions", () => {
  const diagnostics = parse_diagnostics("let value = (1 + 2\nvalue\n");
  assert_equals(diagnostics.length, 1);
  const diagnostic = diagnostics[0];
  assert_equals(diagnostic?.severity, 1);
  assert_equals(diagnostic?.range.start.line !== undefined, true);
});

Deno.test("parse diagnostics are empty for valid programs", () => {
  assert_equals(parse_diagnostics("let value = 1\nvalue\n"), []);
});

Deno.test("document symbols cover top-level introductions", () => {
  const text = [
    "type Option t =",
    "  | `Some t",
    "  | `None Unit",
    "",
    "const factor = 2",
    "let scale = value => value * factor",
    "let total = 0",
    "",
    "effect Counter {",
    "  get: () => I32",
    "}",
    "",
    "total",
    "",
  ].join("\n");
  const parsed = parse_source_with_diagnostics(text);
  const symbols = document_symbols(parsed.source, parsed.syntax, "utf-16");
  assert_equals(
    symbols.map((symbol) => [symbol.name, symbol.kind]),
    [
      ["Option", 5],
      ["factor", 14],
      ["scale", 12],
      ["total", 13],
      ["Counter", 11],
    ],
  );
});

Deno.test("document symbols nest declaration members through broken syntax", () => {
  const prefix = "effect Counter {\n  get: () => I32\n}\n" +
    "type Result = | `Ok Int | `Error Text\n";
  const valid = parse_source_with_diagnostics(prefix + "let value = 1\n");
  const broken = parse_source_with_diagnostics(prefix + "let = broken\n");
  const valid_symbols = document_symbols(
    valid.source,
    valid.syntax,
    "utf-16",
  );
  const broken_symbols = document_symbols(
    broken.source,
    broken.syntax,
    "utf-16",
  );

  assert_equals(
    valid_symbols.slice(0, 2).map((symbol) => ({
      name: symbol.name,
      children: symbol.children.map((child) => child.name),
    })),
    [{ name: "Counter", children: ["get"] }, {
      name: "Result",
      children: ["Ok", "Error"],
    }],
  );
  assert_equals(
    broken_symbols.map((symbol) => ({
      name: symbol.name,
      children: symbol.children.map((child) => child.name),
    })),
    [{ name: "Counter", children: ["get"] }, {
      name: "Result",
      children: ["Ok", "Error"],
    }],
  );
});

Deno.test("server handles the core lifecycle", () => {
  const state = create_state();
  const initialize = handle_message(state, { id: 1, method: "initialize" });
  assert_equals(initialize.length, 1);

  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///demo.duck",
        version: 1,
        text: "let  a=1\na\n",
      },
    },
  });
  assert_equals(opened.length, 1);

  const formatting = handle_message(state, {
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///demo.duck" } },
  }) as [{ result: [{ newText: string }] }];
  assert_equals(formatting[0]?.result[0]?.newText, "let a = 1\na\n");

  const shutdown = handle_message(state, { id: 3, method: "shutdown" });
  assert_equals(shutdown, [{ jsonrpc: "2.0", id: 3, result: null }]);

  handle_message(state, { method: "exit" });
  assert_equals(state.exited, true);
});

Deno.test("server keeps externally supplied host modules responsive", async () => {
  const source_url = new URL(
    "../../case-studies/grep/grep.duck",
    import.meta.url,
  );
  const uri = source_url.href;
  const text = await Deno.readTextFile(source_url);
  const state = create_state();
  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text },
    },
  }) as [{ params: { diagnostics: Array<{ message: string }> } }];

  assert_equals(opened[0]?.params.diagnostics, []);

  const formatting = handle_message(state, {
    id: 1,
    method: "textDocument/formatting",
    params: { textDocument: { uri } },
  });
  assert_equals(formatting, [{ jsonrpc: "2.0", id: 1, result: [] }]);

  const effect_offset = text.indexOf("Process.arg_count");
  const effect_prefix = text.slice(0, effect_offset);
  const effect_line = effect_prefix.split("\n").length - 1;
  const effect_line_start = effect_prefix.lastIndexOf("\n") + 1;
  const hovered = handle_message(state, {
    id: 2,
    method: "textDocument/hover",
    params: {
      textDocument: { uri },
      position: {
        line: effect_line,
        character: effect_offset - effect_line_start + 9,
      },
    },
  }) as [{ result: { contents: { value: string } } }];

  assert_equals(
    hovered[0]?.result.contents.value,
    "**operation** `arg_count`\n\ntype: `() -> I32`\n\n" +
      "signature: `Process.arg_count() => I32`",
  );

  const result_offset = text.indexOf("write_result <-");
  const result_prefix = text.slice(0, result_offset);
  const result_line = result_prefix.split("\n").length - 1;
  const result_line_start = result_prefix.lastIndexOf("\n") + 1;
  const result_hover = handle_message(state, {
    id: 3,
    method: "textDocument/hover",
    params: {
      textDocument: { uri },
      position: {
        line: result_line,
        character: result_offset - result_line_start + 1,
      },
    },
  }) as [{ result: { contents: { value: string } } }];

  assert_equals(
    result_hover[0]?.result.contents.value,
    "```duck\nlet write_result: WriteResult\n```",
  );

  for (
    const expected of [
      { name: "pending", offset: text.indexOf("pending[index]") },
      { name: "line", offset: text.indexOf("&line") + 1 },
    ]
  ) {
    const prefix = text.slice(0, expected.offset);
    const line = prefix.split("\n").length - 1;
    const line_start = prefix.lastIndexOf("\n") + 1;
    const nested_hover = handle_message(state, {
      id: 4,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: {
          line,
          character: expected.offset - line_start + 1,
        },
      },
    }) as [{ result: { contents: { value: string } } }];

    assert_equals(
      nested_hover[0]?.result.contents.value,
      "```duck\nlet " + expected.name + ": Bytes\n```",
    );
  }

  for (
    const expected of [{ name: "first_bytes", type: "Bytes" }, {
      name: "pattern",
      type: "Text",
    }]
  ) {
    const offset = text.indexOf(expected.name);
    const prefix = text.slice(0, offset);
    const line = prefix.split("\n").length - 1;
    const line_start = prefix.lastIndexOf("\n") + 1;
    const parameter_hover = handle_message(state, {
      id: 5,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: {
          line,
          character: offset - line_start + 1,
        },
      },
    }) as [{ result: { contents: { value: string } } }];

    assert_equals(
      parameter_hover[0]?.result.contents.value,
      "```duck\n" + expected.name + ": " + expected.type + "\n```",
    );
  }

  const inlays = handle_message(state, {
    id: 6,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: text.split("\n").length - 1, character: 0 },
      },
    },
  }) as [{ result: Array<{ label: string; position: LspPosition }> }];

  assert_equals(
    inlays[0]?.result.some((hint) =>
      hint.label === ": WriteResult" && hint.position.line === result_line
    ),
    true,
  );
});

Deno.test("server refuses to format broken documents", () => {
  const state = create_state();
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///broken.duck",
        version: 1,
        text: "let value = (1\n",
      },
    },
  });
  const formatting = handle_message(state, {
    id: 1,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///broken.duck" } },
  });
  assert_equals(formatting, [{ jsonrpc: "2.0", id: 1, result: null }]);
});

Deno.test("server defaults to UTF-16 and advertises incremental sync", () => {
  const state = create_state();
  const response = handle_message(state, { id: 1, method: "initialize" });
  assert_equals(response, [{
    jsonrpc: "2.0",
    id: 1,
    result: {
      capabilities: {
        positionEncoding: "utf-16",
        textDocumentSync: {
          openClose: true,
          change: 2,
          willSave: true,
          save: { includeText: true },
        },
        documentFormattingProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        typeDefinitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: {
          resolveProvider: true,
          codeActionKinds: [
            "quickfix",
            "refactor.rewrite",
            "refactor.extract",
            "refactor.inline",
            "source.fixAll",
          ],
        },
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: completion_triggers,
        },
        hoverProvider: true,
        signatureHelpProvider: {
          triggerCharacters: ["(", ",", " "],
          retriggerCharacters: [",", " "],
        },
        inlayHintProvider: { resolveProvider: true },
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: {
          commands: [
            "duck.viewStage",
            "duck.expandComptime",
            "duck.runExample",
          ],
        },
        semanticTokensProvider: {
          legend: {
            tokenTypes: [
              "variable",
              "type",
              "typeParameter",
              "interface",
              "method",
              "enumMember",
              "property",
              "function",
            ],
            tokenModifiers: [
              "declaration",
              "readonly",
              "modification",
              "linear",
              "comptime",
            ],
          },
          range: true,
          full: { delta: true },
        },
      },
      experimental: {
        duck: {
          expandComptime: true,
          viewStage: ["ic", "expr", "mod", "wat"],
        },
      },
      serverInfo: { name: "duck-lsp", version: "0.1.0" },
    },
  }]);
});

Deno.test("server selects the first client-supported position encoding", () => {
  const state = create_state();
  const response = handle_message(state, {
    id: 1,
    method: "initialize",
    params: {
      capabilities: {
        general: { positionEncodings: ["utf-8", "utf-16"] },
      },
    },
  });
  assert_equals(state.documents.position_encoding, "utf-8");
  assert_equals(response, [{
    jsonrpc: "2.0",
    id: 1,
    result: {
      capabilities: {
        positionEncoding: "utf-8",
        textDocumentSync: {
          openClose: true,
          change: 2,
          willSave: true,
          save: { includeText: true },
        },
        documentFormattingProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        typeDefinitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: {
          resolveProvider: true,
          codeActionKinds: [
            "quickfix",
            "refactor.rewrite",
            "refactor.extract",
            "refactor.inline",
            "source.fixAll",
          ],
        },
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: completion_triggers,
        },
        hoverProvider: true,
        signatureHelpProvider: {
          triggerCharacters: ["(", ",", " "],
          retriggerCharacters: [",", " "],
        },
        inlayHintProvider: { resolveProvider: true },
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: {
          commands: [
            "duck.viewStage",
            "duck.expandComptime",
            "duck.runExample",
          ],
        },
        semanticTokensProvider: {
          legend: {
            tokenTypes: [
              "variable",
              "type",
              "typeParameter",
              "interface",
              "method",
              "enumMember",
              "property",
              "function",
            ],
            tokenModifiers: [
              "declaration",
              "readonly",
              "modification",
              "linear",
              "comptime",
            ],
          },
          range: true,
          full: { delta: true },
        },
      },
      experimental: {
        duck: {
          expandComptime: true,
          viewStage: ["ic", "expr", "mod", "wat"],
        },
      },
      serverInfo: { name: "duck-lsp", version: "0.1.0" },
    },
  }]);
});

Deno.test("server applies ordered UTF-16 incremental changes around emoji", () => {
  const state = create_state();
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///emoji.duck", version: 1, text: "a😀bc" },
    },
  });
  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: "file:///emoji.duck", version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 3 },
          },
          rangeLength: 2,
          text: "X",
        },
        {
          range: {
            start: { line: 0, character: 2 },
            end: { line: 0, character: 3 },
          },
          rangeLength: 1,
          text: "C",
        },
      ],
    },
  });
  assert_equals(state.documents.get("file:///emoji.duck"), {
    uri: "file:///emoji.duck",
    version: 2,
    text: "aXCc",
  });
});

Deno.test("server accepts full document changes as the synchronization fallback", () => {
  const state = create_state();
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///fallback.duck", version: 1, text: "old" },
    },
  });
  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: "file:///fallback.duck", version: 2 },
      contentChanges: [{ text: "new" }],
    },
  });
  assert_equals(state.documents.get("file:///fallback.duck"), {
    uri: "file:///fallback.duck",
    version: 2,
    text: "new",
  });
});

Deno.test("server accepts increasing signed document versions", () => {
  const state = create_state();
  const uri = "file:///signed.duck";
  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: -1, text: "let value = 1\n" },
    },
  });
  assert_equals(opened.length, 1);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 0 },
      contentChanges: [{ text: "let value = 2\n" }],
    },
  });
  assert_equals(state.documents.get(uri)?.version, 0);
});

Deno.test("server versions diagnostics and reuses then invalidates parse work", () => {
  let now = 100;
  const state = create_state({ debounce_ms: 50, now: () => now });
  const uri = "file:///cached.duck";
  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: "let value = 1\nvalue\n" },
    },
  });
  assert_equals(opened.length, 1);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 1);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 1);

  handle_message(state, {
    id: 1,
    method: "textDocument/formatting",
    params: { textDocument: { uri } },
  });
  handle_message(state, {
    id: 5,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri } },
  });
  assert_equals(state.documents.compute_count(uri, "source_parse"), 1);

  const changed = handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "let value = (1\n" }],
    },
  });
  assert_equals(changed, []);
  assert_equals(next_diagnostic_deadline(state), 150);
  assert_equals(flush_due_diagnostics(state, 149), []);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 1);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 1);
  now = 150;
  const published = flush_due_diagnostics(state, now) as [{
    params: { version: number };
  }];
  assert_equals(published[0]?.params.version, 2);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 2);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 2);

  handle_message(state, {
    method: "textDocument/willSave",
    params: { textDocument: { uri } },
  });
  handle_message(state, {
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri } },
  });
  assert_equals(state.documents.compute_count(uri, "source_parse"), 3);

  const saved = handle_message(state, {
    method: "textDocument/didSave",
    params: { textDocument: { uri }, text: "stale saved text" },
  });
  assert_equals(saved.length, 1);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 4);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 3);
  handle_message(state, {
    id: 3,
    method: "textDocument/formatting",
    params: { textDocument: { uri } },
  });
  assert_equals(state.documents.compute_count(uri, "source_parse"), 4);
  assert_equals(state.documents.get(uri)?.text, "let value = (1\n");

  handle_message(state, {
    method: "workspace/didChangeWatchedFiles",
    params: { changes: [{ uri, type: 2 }] },
  });
  handle_message(state, {
    id: 4,
    method: "textDocument/formatting",
    params: { textDocument: { uri } },
  });
  assert_equals(state.documents.compute_count(uri, "source_parse"), 5);
});

Deno.test("server debounces change bursts and publishes only the latest version", () => {
  let now = 0;
  const state = create_state({ debounce_ms: 40, now: () => now });
  const uri = "file:///burst.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: "let value = 1\n" },
    },
  });
  assert_equals(state.documents.compute_count(uri, "source_parse"), 1);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 1);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "let value = (1\n" }],
    },
  });
  now = 20;
  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: "let value = 3\n" }],
    },
  });

  assert_equals(next_diagnostic_deadline(state), 60);
  assert_equals(flush_due_diagnostics(state, 59), []);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 1);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 1);
  const messages = flush_due_diagnostics(state, 60) as [{
    params: { version: number; diagnostics: unknown[] };
  }];
  assert_equals(messages[0]?.params.version, 3);
  assert_equals(messages[0]?.params.diagnostics, [{
    code: "DUCK2003",
    severity: 2,
    source: "duck",
    message: "Unused runtime binding value",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 13 },
    },
  }]);
  assert_equals(state.documents.compute_count(uri, "source_parse"), 2);
  assert_equals(state.documents.compute_count(uri, "source_analysis"), 2);
  assert_equals(flush_due_diagnostics(state, 100), []);
});

Deno.test("server publishes compiler semantic diagnostics with code and version", () => {
  const state = create_state();
  const uri = "file:///semantic.duck";
  const messages = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 7,
        text: "40i64 + 2i32\n",
      },
    },
  }) as [{
    params: {
      version: number;
      diagnostics: Array<{
        code: string;
        severity: number;
        range: LspRange;
      }>;
    };
  }];

  assert_equals(messages[0]?.params.version, 7);
  assert_equals(messages[0]?.params.diagnostics, [{
    code: "DUCK2302",
    severity: 1,
    source: "duck",
    message: "Mixed i32 and i64 operands for operator +",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 12 },
    },
  }]);
});

Deno.test("server analyzes source tests with test import metadata", () => {
  const state = create_state();
  const uri = "file:///attribute-test.duck";
  const messages = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 1,
        text: 'const { test } = import "duck:prelude/attributes" ()\n' +
          "@[test]\n" +
          "const checked: I32 -> I32 = value => 40i64 + 2i32\n" +
          "0\n",
      },
    },
  }) as [{ params: { diagnostics: Array<{ code: string }> } }];

  assert_equals(
    messages[0]?.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["DUCK2302"],
  );
});

Deno.test("dependency edits invalidate and republish open importers", () => {
  let now = 0;
  const state = create_state({ debounce_ms: 25, now: () => now });
  const dependency_uri = "file:///dep.duck";
  const importer_uri = "file:///main.duck";

  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: dependency_uri,
        version: 1,
        text: "module () where\nreturn 1\n",
      },
    },
  });
  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: importer_uri,
        version: 1,
        text: 'const available = import "./dep.duck"\navailable\n',
      },
    },
  }) as [{ params: { diagnostics: unknown[] } }];
  assert_equals(opened[0]?.params.diagnostics, []);
  assert_equals(
    state.documents.compute_count(importer_uri, "source_analysis"),
    1,
  );

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: dependency_uri, version: 2 },
      contentChanges: [{ text: "const other = 1\nother\n" }],
    },
  });
  assert_equals(next_diagnostic_deadline(state), 25);
  now = 25;
  const published = flush_due_diagnostics(state, now) as Array<{
    params: {
      uri: string;
      version: number;
      diagnostics: Array<{ code: string }>;
    };
  }>;
  const importer = published.find((message) =>
    message.params.uri === importer_uri
  );

  if (importer === undefined) {
    throw new Error("Missing importer diagnostic publication");
  }

  assert_equals(importer.params.version, 1);
  assert_equals(
    importer.params.diagnostics.map((diagnostic) => diagnostic.code),
    ["DUCK2501"],
  );
  assert_equals(
    state.documents.compute_count(importer_uri, "source_analysis"),
    2,
  );
});

Deno.test("server ignores malformed and stale changes without corrupting documents", () => {
  const state = create_state();
  const uri = "file:///stable.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 2, text: "stable" } },
  });
  assert_equals(
    handle_message(state, {
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: "stale" }],
      },
    }),
    [],
  );
  assert_equals(
    handle_message(state, {
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "not a uri", version: 3 },
        contentChanges: [{ text: "broken" }],
      },
    }),
    [],
  );
  assert_equals(state.documents.get(uri), {
    uri,
    version: 2,
    text: "stable",
  });
});

Deno.test("server formats the Unicode whole-document range in the negotiated encoding", () => {
  const state = create_state();
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: {
      capabilities: {
        general: { positionEncodings: ["utf-8", "utf-16"] },
      },
    },
  });
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///unicode.duck",
        version: 1,
        text: "let  value=1\nvalue//😀",
      },
    },
  });
  const formatting = handle_message(state, {
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///unicode.duck" } },
  }) as [{ result: [{ range: { end: { line: number; character: number } } }] }];
  assert_equals(formatting[0]?.result[0]?.range.end, {
    line: 1,
    character: 11,
  });
});

Deno.test("server encodes document symbol ranges with the negotiated encoding", () => {
  const state = create_state();
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: {
      capabilities: {
        general: { positionEncodings: ["utf-8", "utf-16"] },
      },
    },
  });
  const uri = "file:///symbols.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 1,
        text: '"😀";let x = 1\n',
      },
    },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri } },
  }) as [{
    result: Array<{
      range: LspRange;
      selectionRange: LspRange;
    }>;
  }];

  assert_equals(response[0]?.result[0]?.range, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 16 },
  });
  assert_equals(response[0]?.result[0]?.selectionRange, {
    start: { line: 0, character: 11 },
    end: { line: 0, character: 12 },
  });
});

Deno.test("server navigation and rename survive an unrelated parse error", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///navigation.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 1,
        text: "let value = 1\nlet = broken\nvalue\n",
      },
    },
  });
  const position = { line: 2, character: 1 };

  assert_equals(
    handle_message(state, {
      id: 2,
      method: "textDocument/definition",
      params: { textDocument: { uri }, position },
    }),
    [{
      jsonrpc: "2.0",
      id: 2,
      result: {
        uri,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 9 },
        },
      },
    }],
  );

  const references = handle_message(state, {
    id: 3,
    method: "textDocument/references",
    params: {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    },
  }) as [{ result: Array<{ range: LspRange }> }];
  assert_equals(
    references[0]?.result.map((location) => location.range.start.line),
    [0, 2],
  );

  const highlights = handle_message(state, {
    id: 4,
    method: "textDocument/documentHighlight",
    params: { textDocument: { uri }, position },
  }) as [{ result: Array<{ kind: number }> }];
  assert_equals(highlights[0]?.result.map((item) => item.kind), [3, 2]);

  const preparation = handle_message(state, {
    id: 5,
    method: "textDocument/prepareRename",
    params: { textDocument: { uri }, position },
  }) as [{ result: { placeholder: string } }];
  assert_equals(preparation[0]?.result.placeholder, "value");

  const rename = handle_message(state, {
    id: 6,
    method: "textDocument/rename",
    params: { textDocument: { uri }, position, newName: "answer" },
  }) as [{ result: { changes: Record<string, unknown[]> } }];
  assert_equals(rename[0]?.result.changes[uri]?.length, 2);
});

Deno.test("server serves type, import, and workspace symbol navigation", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const main = "file:///main.duck";
  const other = "file:///other.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: main,
        version: 1,
        text: "type Pair = struct {.left = Int}\n" +
          "let value: Pair = [.left = 1]\nvalue.left\n",
      },
    },
  });
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: other,
        version: 1,
        text: 'const dependency = import "./dep.duck"\ndependency\n',
      },
    },
  });

  const type_definition = handle_message(state, {
    id: 2,
    method: "textDocument/typeDefinition",
    params: {
      textDocument: { uri: main },
      position: { line: 2, character: 2 },
    },
  }) as [{ result: { range: LspRange } }];
  assert_equals(type_definition[0]?.result.range.start, {
    line: 0,
    character: 5,
  });

  const imported = handle_message(state, {
    id: 3,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: other },
      position: { line: 1, character: 2 },
    },
  }) as [{ result: { uri: string } }];
  assert_equals(imported[0]?.result.uri, "file:///dep.duck");

  const workspace = handle_message(state, {
    id: 4,
    method: "workspace/symbol",
    params: { query: "lft" },
  }) as [{ result: Array<{ name: string; containerName?: string }> }];
  assert_equals(workspace[0]?.result.map((symbol) => symbol.name), ["left"]);
  assert_equals(workspace[0]?.result[0]?.containerName, "Pair");
});

Deno.test("workspace symbols include closed Duck files under the root", () => {
  const state = create_state();
  const root = new URL(
    "../../examples/ownership_modules/multi_file/",
    import.meta.url,
  ).href;
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: { rootUri: root },
  });
  const response = handle_message(state, {
    id: 2,
    method: "workspace/symbol",
    params: { query: "capab" },
  }) as [{ result: Array<{ name: string; location: { uri: string } }> }];

  assert_equals(
    response[0]?.result.some((symbol) =>
      symbol.name === "capabilities" &&
      symbol.location.uri.endsWith("score_module.duck")
    ),
    true,
  );
});

Deno.test("server completes members, import paths, and resolved docs", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///virtual/main.duck";
  const dependency = "file:///virtual/dep.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: dependency,
        version: 1,
        text: "const dependency = 1\n",
      },
    },
  });
  const text = "/// A user record.\n" +
    "type User = struct {.name = Text}\n" +
    'let user: User = [.name = "Ada"]\nuser.';
  handle_message(state, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text } },
  });
  const completed = handle_message(state, {
    id: 2,
    method: "textDocument/completion",
    params: {
      textDocument: { uri },
      position: { line: 3, character: 5 },
    },
  }) as [{ result: { isIncomplete: boolean; items: LspCompletionItem[] } }];
  assert_equals(completed[0]?.result.isIncomplete, true);
  assert_equals(completed[0]?.result.items.map((item) => item.label), [
    "name",
  ]);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'const dependency = import "d' }],
    },
  });
  const imports = handle_message(state, {
    id: 3,
    method: "textDocument/completion",
    params: {
      textDocument: { uri },
      position: { line: 0, character: 28 },
    },
  }) as [{ result: { items: LspCompletionItem[] } }];
  assert_equals(imports[0]?.result.items.map((item) => item.label), [
    "./dep.duck",
  ]);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 3 },
      contentChanges: [{
        text: "/// A user record.\ntype User = struct {.name = Text}\nUs",
      }],
    },
  });
  const types = handle_message(state, {
    id: 4,
    method: "textDocument/completion",
    params: {
      textDocument: { uri },
      position: { line: 2, character: 2 },
    },
  }) as [{ result: { items: LspCompletionItem[] } }];
  const user = types[0]?.result.items.find((item) => item.label === "User");

  if (user === undefined) {
    throw new Error("Missing User completion");
  }

  const resolved = handle_message(state, {
    id: 5,
    method: "completionItem/resolve",
    params: user,
  }) as [{ result: LspCompletionItem }];
  assert_equals(
    resolved[0]?.result.documentation?.value.includes("A user record."),
    true,
  );
});

Deno.test("server returns semantic hover and signature help", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///hover.duck";
  const hover_text = "const make_adder = n => { x => x + n }\n" +
    "const add_three = comptime make_adder(3)\n" +
    "add_three(39)\n";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: hover_text },
    },
  });
  const hovered = handle_message(state, {
    id: 2,
    method: "textDocument/hover",
    params: {
      textDocument: { uri },
      position: { line: 2, character: 2 },
    },
  }) as [{ result: { contents: { value: string } } }];
  assert_equals(
    hovered[0]?.result.contents.value.includes("`n = 3`"),
    true,
  );

  const signature_text = "let apply_const = (x, const f) => f(x)\n" +
    "apply_const(21, ";
  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: signature_text }],
    },
  });
  const signature = handle_message(state, {
    id: 3,
    method: "textDocument/signatureHelp",
    params: {
      textDocument: { uri },
      position: { line: 1, character: 16 },
    },
  }) as [{
    result: {
      activeParameter: number;
      signatures: Array<{ parameters: Array<{ label: string }> }>;
    };
  }];
  assert_equals(signature[0]?.result.activeParameter, 1);
  assert_equals(
    signature[0]?.result.signatures[0]?.parameters[1]?.label,
    "const f",
  );
});

Deno.test("server returns and resolves inlay hints in the requested range", () => {
  const state = create_state();
  const uri = "file:///hints.duck";
  handle_message(state, { id: 1, method: "initialize" });
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: "let answer = 1\nanswer\n" },
    },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 },
      },
    },
  }) as [{ result: Array<{ label: string; data: unknown }> }];
  const hint = response[0]?.result[0];

  if (hint === undefined) {
    throw new Error("Missing inferred type inlay hint");
  }

  assert_equals(hint.label, ": I32");
  const resolved = handle_message(state, {
    id: 3,
    method: "inlayHint/resolve",
    params: hint,
  }) as [{ result: { tooltip?: { value: string } } }];
  assert_equals(
    resolved[0]?.result.tooltip?.value,
    "Inferred binding type: I32",
  );
});

Deno.test("server applies initialization inlay hint settings", () => {
  const state = create_state();
  const uri = "file:///initial-hints.duck";
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: { initializationOptions: { inlayHints: { types: false } } },
  });
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: "let answer = 1\nanswer\n" },
    },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 6 },
      },
    },
  });
  assert_equals(response, [{ jsonrpc: "2.0", id: 2, result: [] }]);
});

Deno.test("server applies dynamic DUCK inlay hint settings", () => {
  const state = create_state();
  const uri = "file:///dynamic-hints.duck";
  handle_message(state, { id: 1, method: "initialize" });
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version: 1, text: "let answer = 1\nanswer\n" },
    },
  });
  handle_message(state, {
    method: "workspace/didChangeConfiguration",
    params: { settings: { duck: { inlayHints: { types: false } } } },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 6 },
      },
    },
  });
  assert_equals(response, [{ jsonrpc: "2.0", id: 2, result: [] }]);

  handle_message(state, {
    method: "workspace/didChangeConfiguration",
    params: { settings: { inlayHints: { types: true } } },
  });
  const restored = handle_message(state, {
    id: 3,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 6 },
      },
    },
  }) as [{ result: Array<{ label: string }> }];
  assert_equals(restored[0]?.result[0]?.label, ": I32");
});

Deno.test("server semantic tokens are stable, ranged, and minimally delta-updated", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///tokens.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 1,
        text: "const first = 1\nlet second = first\nsecond\n",
      },
    },
  });
  const first = handle_message(state, {
    id: 2,
    method: "textDocument/semanticTokens/full",
    params: { textDocument: { uri } },
  }) as [{ result: { resultId: string; data: number[] } }];
  const repeated = handle_message(state, {
    id: 3,
    method: "textDocument/semanticTokens/full",
    params: { textDocument: { uri } },
  });
  assert_equals(repeated, [{
    jsonrpc: "2.0",
    id: 3,
    result: first[0]?.result,
  }]);
  assert_equals(state.documents.compute_count(uri, "semantic_tokens"), 1);

  const ranged = handle_message(state, {
    id: 4,
    method: "textDocument/semanticTokens/range",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 6 },
      },
    },
  }) as [{ result: { data: number[] } }];
  assert_equals(ranged[0]?.result.data.length, 15);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{
        text: "const first = 1\nlet renamed = first\nrenamed\n",
      }],
    },
  });
  const previous_id = first[0]?.result.resultId;

  if (previous_id === undefined) {
    throw new Error("Missing initial semantic token result id");
  }

  const delta = handle_message(state, {
    id: 5,
    method: "textDocument/semanticTokens/full/delta",
    params: {
      textDocument: { uri },
      previousResultId: previous_id,
    },
  }) as [{
    result: {
      resultId: string;
      edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
    };
  }];
  assert_equals(delta[0]?.result.edits.length, 1);
  const edit = delta[0]?.result.edits[0];

  if (edit === undefined) {
    throw new Error("Missing server semantic token delta");
  }

  assert_equals(edit.start > 0, true);
  assert_equals(edit.deleteCount < first[0].result.data.length, true);
});

Deno.test("server enumerates and lazily resolves code actions", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///actions.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        version: 1,
        text: "let answer = 42\nanswer\n",
      },
    },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 10 },
      },
      context: { diagnostics: [] },
    },
  }) as [{ result: Array<Record<string, unknown>> }];
  const action = response[0]?.result.find((candidate) =>
    candidate.title === "Annotate answer with inferred type"
  );

  if (action === undefined) {
    throw new Error("Missing annotation code action");
  }

  assert_equals(action.edit, undefined);
  const resolved = handle_message(state, {
    id: 3,
    method: "codeAction/resolve",
    params: action,
  }) as [{ result: { edit: { changes: Record<string, unknown[]> } } }];
  assert_equals(resolved[0]?.result.edit.changes[uri], [{
    range: {
      start: { line: 0, character: 10 },
      end: { line: 0, character: 10 },
    },
    newText: ": I32",
  }]);

  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "let answer = 43\nanswer\n" }],
    },
  });
  const stale = handle_message(state, {
    id: 4,
    method: "codeAction/resolve",
    params: action,
  }) as [{ result: Record<string, unknown> }];
  assert_equals(stale[0]?.result.edit, undefined);
});

Deno.test("server resolves proof quick fixes in the manifest route", async () => {
  const url = new URL(
    "../../examples/failures/compile/11_frozen_mutation.duck",
    import.meta.url,
  );
  const uri = url.href;
  const text = await Deno.readTextFile(url);
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text } },
  }) as [{ params: { diagnostics: Array<Record<string, unknown>> } }];
  const diagnostic = opened[0]?.params.diagnostics.find((candidate) =>
    candidate.code === "DUCK2404"
  );

  if (diagnostic === undefined) {
    throw new Error("Missing frozen-mutation proof diagnostic");
  }

  const response = handle_message(state, {
    id: 2,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 12 },
      },
      context: { diagnostics: [diagnostic] },
    },
  }) as [{ result: Array<Record<string, unknown>> }];
  const action = response[0]?.result.find((candidate) =>
    candidate.title === "Rebuild and shadow frozen message"
  );

  if (action === undefined) {
    throw new Error("Missing frozen-mutation code action");
  }

  const resolved = handle_message(state, {
    id: 3,
    method: "codeAction/resolve",
    params: action,
  }) as [{ result: { edit?: unknown } }];
  assert_equals(resolved[0]?.result.edit === undefined, false);
});

Deno.test("server suppresses assists that fail workspace resolution", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///missing-import/main.duck";
  const text = 'let answer = 42\nconst dep = import "./missing.duck"\nanswer\n';
  handle_message(state, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text } },
  });
  const response = handle_message(state, {
    id: 2,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 10 },
      },
      context: { diagnostics: [] },
    },
  }) as [{ result: Array<Record<string, unknown>> }];
  const action = response[0]?.result.find((candidate) =>
    candidate.title === "Annotate answer with inferred type"
  );

  assert_equals(action, undefined);
});

Deno.test("server exposes comptime and pipeline powertools", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  const uri = "file:///scratch/comptime.duck";
  const text = "const make_adder = n => { x => x + n }\n" +
    "const add_three = comptime make_adder(3)\n" +
    "add_three(39)\n";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: { textDocument: { uri, version: 1, text } },
  });
  const expanded = handle_message(state, {
    id: 2,
    method: "duck/expandComptime",
    params: {
      textDocument: { uri },
      position: { line: 1, character: 35 },
    },
  }) as [{ result: { ok: boolean; value: { facts: unknown[] } } }];
  assert_equals(expanded[0]?.result.ok, true);
  assert_equals(expanded[0]?.result.value.facts, [{
    kind: "capture",
    name: "n",
    value: "3",
  }]);
  const invalid_position = handle_message(state, {
    id: 7,
    method: "duck/expandComptime",
    params: {
      textDocument: { uri },
      position: { line: 99, character: 0 },
    },
  }) as [{ result: { ok: boolean; code: string } }];
  assert_equals(invalid_position[0]?.result, {
    ok: false,
    code: "invalid_position",
    message: "position line is outside the document",
  });

  const lenses = handle_message(state, {
    id: 3,
    method: "textDocument/codeLens",
    params: { textDocument: { uri } },
  }) as [{ result: Array<{ command: { title: string } }> }];
  assert_equals(lenses[0]?.result.map((lens) => lens.command.title), [
    "▸ compile to WAT",
    "▸ expand",
  ]);

  const scalar_uri = "file:///scratch/scalar.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: scalar_uri, version: 1, text: "40 + 2\n" },
    },
  });
  const stage = handle_message(state, {
    id: 4,
    method: "duck/viewStage",
    params: { textDocument: { uri: scalar_uri }, stage: "wat" },
  }) as [{ result: { ok: boolean; value: { text: string } } }];
  assert_equals(stage[0]?.result.ok, true);
  assert_equals(stage[0]?.result.value.text.includes("i32.const 42"), true);

  const command = handle_message(state, {
    id: 5,
    method: "workspace/executeCommand",
    params: {
      command: "duck.viewStage",
      arguments: [scalar_uri, "wat"],
    },
  }) as [{ result: { ok: boolean } }];
  assert_equals(command[0]?.result.ok, true);

  const broken_uri = "file:///scratch/broken.duck";
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: broken_uri, version: 1, text: "let =" },
    },
  });
  const broken = handle_message(state, {
    id: 6,
    method: "duck/viewStage",
    params: { textDocument: { uri: broken_uri }, stage: "wat" },
  }) as [{ result: { ok: boolean; code: string } }];
  assert_equals(broken[0]?.result, {
    ok: false,
    code: "broken_source",
    message: "Source could not be parsed: Expected pattern binding at 1:5",
  });
});

Deno.test("server honors cancellation and shutdown lifecycle", () => {
  const state = create_state();
  handle_message(state, { id: 1, method: "initialize" });
  handle_message(state, {
    method: "$/cancelRequest",
    params: { id: "cancelled" },
  });
  assert_equals(
    handle_message(state, {
      id: "cancelled",
      method: "workspace/symbol",
      params: { query: "anything" },
    }),
    [{
      jsonrpc: "2.0",
      id: "cancelled",
      error: { code: -32800, message: "Request cancelled" },
    }],
  );
  assert_equals(handle_message(state, { id: 2, method: "shutdown" }), [{
    jsonrpc: "2.0",
    id: 2,
    result: null,
  }]);
  assert_equals(
    handle_message(state, {
      id: 3,
      method: "workspace/symbol",
      params: { query: "anything" },
    }),
    [{
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32600, message: "Server has shut down" },
    }],
  );
  handle_message(state, { method: "exit" });
  assert_equals(state.exited, true);
});

Deno.test("server reports workspace progress and applies workspace config", async () => {
  const root_path = await Deno.makeTempDir({ prefix: "duck-server-root-" });

  try {
    await Deno.writeTextFile(root_path + "/AGENTS.md", "workspace\n");
    await Deno.writeTextFile(root_path + "/one.duck", "let value = 1\n");
    const root = new URL("file://" + root_path + "/").href;
    const state = create_state();
    const replies = handle_message(state, {
      id: 1,
      method: "initialize",
      params: {
        rootUri: root,
        workDoneToken: "workspace-load",
        initializationOptions: {
          diagnosticsDepth: 2,
          maxReanalysisFanout: 3,
          formattingOnBrokenBuffer: true,
        },
      },
    }) as Array<{ method?: string; params?: { value: { kind: string } } }>;
    assert_equals(
      replies.filter((reply) => reply.method === "$/progress").map((reply) =>
        reply.params?.value.kind
      ),
      ["begin", "report", "end"],
    );
    assert_equals(state.workspace.file_count(), 1);
    assert_equals(state.diagnostics_depth, 2);
    assert_equals(state.max_reanalysis_fanout, 3);
    assert_equals(state.format_broken_buffers, true);

    handle_message(state, {
      method: "workspace/didChangeConfiguration",
      params: {
        settings: {
          duck: {
            diagnosticsDepth: 1,
            maxReanalysisFanout: 1,
            formattingOnBrokenBuffer: false,
          },
        },
      },
    });
    assert_equals(state.diagnostics_depth, 1);
    assert_equals(state.max_reanalysis_fanout, 1);
    assert_equals(state.format_broken_buffers, false);
  } finally {
    await Deno.remove(root_path, { recursive: true });
  }
});

Deno.test("server follows cross-file members and renames workspace-wide", async () => {
  const root_path = await Deno.makeTempDir({ prefix: "duck-server-nav-" });

  try {
    const a_text = "let exported = 1\nexported\n";
    const b_text = 'const a = import "./a.duck"\nlet value = a.exported\n';
    await Deno.writeTextFile(root_path + "/a.duck", a_text);
    await Deno.writeTextFile(root_path + "/b.duck", b_text);
    const root = new URL("file://" + root_path + "/").href;
    const a_uri = new URL("a.duck", root).href;
    const b_uri = new URL("b.duck", root).href;
    const state = create_state();
    handle_message(state, {
      id: 1,
      method: "initialize",
      params: { rootUri: root },
    });
    handle_message(state, {
      method: "textDocument/didOpen",
      params: { textDocument: { uri: b_uri, version: 1, text: b_text } },
    });
    const definition = handle_message(state, {
      id: 2,
      method: "textDocument/definition",
      params: {
        textDocument: { uri: b_uri },
        position: { line: 1, character: 16 },
      },
    }) as [{ result: { uri: string } }];
    assert_equals(definition[0]?.result.uri, a_uri);

    const references = handle_message(state, {
      id: 3,
      method: "textDocument/references",
      params: {
        textDocument: { uri: b_uri },
        position: { line: 1, character: 16 },
        context: { includeDeclaration: true },
      },
    }) as [{ result: Array<{ uri: string }> }];
    assert_equals(references[0]?.result.map((location) => location.uri), [
      a_uri,
      a_uri,
      b_uri,
    ]);

    const rename = handle_message(state, {
      id: 4,
      method: "textDocument/rename",
      params: {
        textDocument: { uri: b_uri },
        position: { line: 1, character: 16 },
        newName: "renamed",
      },
    }) as [{ result: { changes: Record<string, unknown[]> } }];
    assert_equals(rename[0]?.result.changes[a_uri].length, 2);
    assert_equals(rename[0]?.result.changes[b_uri].length, 1);
  } finally {
    await Deno.remove(root_path, { recursive: true });
  }
});

Deno.test("three-module edits reanalyze only capped reverse dependencies", () => {
  const state = create_state({ debounce_ms: 10, now: () => 100 });
  handle_message(state, {
    id: 1,
    method: "initialize",
    params: {
      initializationOptions: {
        diagnosticsDepth: 8,
        maxReanalysisFanout: 8,
      },
    },
  });
  const a = "file:///chain/a.duck";
  const b = "file:///chain/b.duck";
  const c = "file:///chain/c.duck";
  const unrelated = "file:///chain/unrelated.duck";
  const fixtures = [{ uri: a, text: "let value = 1\n" }, {
    uri: b,
    text: 'const a = import "./a.duck"\nlet b = a\n',
  }, {
    uri: c,
    text: 'const b = import "./b.duck"\nlet c = b\n',
  }, { uri: unrelated, text: "let separate = 1\n" }];

  for (const fixture of fixtures) {
    handle_message(state, {
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: fixture.uri,
          version: 1,
          text: fixture.text,
        },
      },
    });
  }

  const before = new Map(fixtures.map((fixture) => [
    fixture.uri,
    state.documents.compute_count(fixture.uri, "source_analysis"),
  ]));
  handle_message(state, {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: a, version: 2 },
      contentChanges: [{ text: "let value = 2\n" }],
    },
  });
  const published = flush_due_diagnostics(state, 110) as Array<{
    params: { uri: string };
  }>;
  assert_equals(published.map((message) => message.params.uri), [a, b, c]);
  assert_equals(state.last_reanalysis_fanout, 2);
  assert_equals(
    state.documents.compute_count(unrelated, "source_analysis"),
    before.get(unrelated),
  );
  assert_equals(
    state.documents.compute_count(b, "source_analysis"),
    Number(before.get(b)) + 1,
  );
  assert_equals(
    state.documents.compute_count(c, "source_analysis"),
    Number(before.get(c)) + 1,
  );
});

Deno.test("open dependency edits publish diagnostics for closed importers", async () => {
  const root_path = await Deno.makeTempDir({ prefix: "duck-closed-importer-" });

  try {
    await Deno.writeTextFile(root_path + "/a.duck", "let value = 1\n");
    await Deno.writeTextFile(
      root_path + "/b.duck",
      'const a = import "./a.duck"\nlet imported = a\n',
    );
    const root = new URL("file://" + root_path + "/").href;
    const a = new URL("a.duck", root).href;
    const b = new URL("b.duck", root).href;
    const state = create_state({ debounce_ms: 10, now: () => 100 });
    handle_message(state, {
      id: 1,
      method: "initialize",
      params: { rootUri: root },
    });
    handle_message(state, {
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: a, version: 1, text: "let value = 1\n" },
      },
    });
    handle_message(state, {
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: a, version: 2 },
        contentChanges: [{ text: "let value = 2\n" }],
      },
    });
    const published = flush_due_diagnostics(state, 110) as Array<{
      params: { uri: string; version?: number };
    }>;
    assert_equals(published.map((message) => message.params.uri), [a, b]);
    assert_equals(published[0]?.params.version, 2);
    assert_equals(published[1]?.params.version, undefined);
  } finally {
    await Deno.remove(root_path, { recursive: true });
  }
});
