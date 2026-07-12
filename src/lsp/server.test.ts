import { assert_equals } from "../assert.ts";
import { encode_message, MessageDecoder } from "./framing.ts";
import { parse_diagnostics } from "./diagnostics.ts";
import { document_symbols } from "./symbols.ts";
import { create_state, handle_message } from "./server.ts";

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
    "  | .some = t",
    "  | .none",
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
  const symbols = document_symbols(text);
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

Deno.test("server handles the core lifecycle", () => {
  const state = create_state();
  const initialize = handle_message(state, { id: 1, method: "initialize" });
  assert_equals(initialize.length, 1);

  const opened = handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///demo.ix", text: "let  a=1\na\n" },
    },
  });
  assert_equals(opened.length, 1);

  const formatting = handle_message(state, {
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///demo.ix" } },
  }) as [{ result: [{ newText: string }] }];
  assert_equals(formatting[0]?.result[0]?.newText, "let a = 1\na\n");

  const shutdown = handle_message(state, { id: 3, method: "shutdown" });
  assert_equals(shutdown, [{ jsonrpc: "2.0", id: 3, result: null }]);

  handle_message(state, { method: "exit" });
  assert_equals(state.exited, true);
});

Deno.test("server refuses to format broken documents", () => {
  const state = create_state();
  handle_message(state, {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: "file:///broken.ix", text: "let value = (1\n" },
    },
  });
  const formatting = handle_message(state, {
    id: 1,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///broken.ix" } },
  }) as [{ method: string; params: { message: string } }, unknown];
  assert_equals(formatting.length, 2);
  assert_equals(formatting[0]?.method, "window/showMessage");
  assert_equals(
    formatting[0]?.params.message.startsWith("ix fmt skipped:"),
    true,
  );
  assert_equals(formatting[1], { jsonrpc: "2.0", id: 1, result: null });
});
