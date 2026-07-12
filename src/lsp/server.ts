import { format_text } from "../fmt/format.ts";
import { parse_diagnostics } from "./diagnostics.ts";
import { document_symbols } from "./symbols.ts";
import { encode_message, MessageDecoder } from "./framing.ts";

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  // deno-lint-ignore no-explicit-any
  params?: any;
};

export type ServerState = {
  documents: Map<string, string>;
  exited: boolean;
};

export function create_state(): ServerState {
  return { documents: new Map(), exited: false };
}

// Handle one message and return the messages to send back. The transport is
// kept outside so the protocol logic stays testable.
export function handle_message(
  state: ServerState,
  message: RpcMessage,
): unknown[] {
  const method = message.method;

  if (method === undefined) {
    return [];
  }

  if (message.id !== undefined) {
    return handle_request(state, message);
  }

  return handle_notification(state, message);
}

function handle_request(state: ServerState, message: RpcMessage): unknown[] {
  if (message.method === "initialize") {
    return [respond(message, {
      capabilities: {
        textDocumentSync: 1,
        documentFormattingProvider: true,
        documentSymbolProvider: true,
      },
      serverInfo: { name: "ix-lsp", version: "0.1.0" },
    })];
  }

  if (message.method === "shutdown") {
    return [respond(message, null)];
  }

  if (message.method === "textDocument/formatting") {
    const uri = message.params?.textDocument?.uri;
    const text = uri === undefined ? undefined : state.documents.get(uri);

    if (text === undefined) {
      return [respond(message, null)];
    }

    // Refuse to format documents that do not parse; a formatter that runs
    // on broken input can only make the breakage harder to see. Say so out
    // loud — a silent refusal reads as a broken formatter.
    const failures = parse_diagnostics(text);
    const failure = failures[0];

    if (failure !== undefined) {
      return [
        {
          jsonrpc: "2.0",
          method: "window/showMessage",
          params: {
            type: 2,
            message: "ix fmt skipped: " + failure.message,
          },
        },
        respond(message, null),
      ];
    }

    const formatted = format_text(text);

    if (formatted === text) {
      return [respond(message, [])];
    }

    const lines = text.split("\n");
    return [respond(message, [{
      range: {
        start: { line: 0, character: 0 },
        end: {
          line: lines.length - 1,
          character: lines[lines.length - 1]?.length ?? 0,
        },
      },
      newText: formatted,
    }])];
  }

  if (message.method === "textDocument/documentSymbol") {
    const uri = message.params?.textDocument?.uri;
    const text = uri === undefined ? undefined : state.documents.get(uri);
    return [respond(message, text === undefined ? [] : document_symbols(text))];
  }

  return [{
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found: " + message.method },
  }];
}

function handle_notification(
  state: ServerState,
  message: RpcMessage,
): unknown[] {
  if (message.method === "exit") {
    state.exited = true;
    return [];
  }

  if (message.method === "textDocument/didOpen") {
    const document = message.params?.textDocument;

    if (document?.uri === undefined || document.text === undefined) {
      return [];
    }

    state.documents.set(document.uri, document.text);
    return [publish_diagnostics(document.uri, document.text)];
  }

  if (message.method === "textDocument/didChange") {
    const uri = message.params?.textDocument?.uri;
    const changes = message.params?.contentChanges;
    const text = Array.isArray(changes)
      ? changes[changes.length - 1]?.text
      : undefined;

    if (uri === undefined || text === undefined) {
      return [];
    }

    state.documents.set(uri, text);
    return [publish_diagnostics(uri, text)];
  }

  if (message.method === "textDocument/didClose") {
    const uri = message.params?.textDocument?.uri;

    if (uri === undefined) {
      return [];
    }

    state.documents.delete(uri);
    return [{
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    }];
  }

  return [];
}

function publish_diagnostics(uri: string, text: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: parse_diagnostics(text) },
  };
}

function respond(message: RpcMessage, result: unknown): unknown {
  return { jsonrpc: "2.0", id: message.id, result };
}

export async function run_lsp(): Promise<number> {
  const state = create_state();
  const decoder = new MessageDecoder();
  const writer = Deno.stdout.writable.getWriter();

  for await (const chunk of Deno.stdin.readable) {
    for (const message of decoder.push(chunk)) {
      const replies = handle_message(state, message as RpcMessage);

      for (const reply of replies) {
        await writer.write(encode_message(reply));
      }

      if (state.exited) {
        return 0;
      }
    }
  }

  return 0;
}
