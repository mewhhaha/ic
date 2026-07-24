import { assert_equals, assert_throws } from "../assert.ts";
import { encode_message } from "./framing.ts";
import {
  assert_golden,
  assert_golden_file,
  decode_lsp_session,
  golden_snapshot,
  LspTestClient,
  materialize_workspace_fixture,
  parse_fixture,
  parse_workspace_fixture,
} from "./test_harness.ts";
import { PositionIndex } from "./position.ts";
import { workspace_definition_location, WorkspaceModel } from "./workspace.ts";

const entry = new URL("../../duck.ts", import.meta.url).pathname;

Deno.test("fixture parser removes marker lines and records spans and expectations", () => {
  const fixture = parse_fixture(
    [
      "let answer = 41 + 1;",
      "//    ^^^^^^ definition",
      "//    ^^^^^^ hover: `I32`",
      "answer",
      "//^ reference",
    ].join("\n"),
  );

  assert_equals(fixture.source, "let answer = 41 + 1;\nanswer");
  assert_equals(fixture.spans.get("definition"), {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 10 },
  });
  assert_equals(fixture.spans.get("reference"), {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 1 },
  });
  assert_equals(fixture.expectations, [{
    range: {
      start: { line: 0, character: 4 },
      end: { line: 0, character: 10 },
    },
    kind: "hover",
    expected: "`I32`",
  }]);
});

Deno.test("fixture parser rejects a marker without source", () => {
  assert_throws(() => parse_fixture("//^ definition"), "preceding source");
});

Deno.test("session decoder handles fragmented and back-to-back frames", () => {
  const first = encode_message({ id: 1, method: "initialize" });
  const second = encode_message({ id: 2, method: "shutdown" });
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  assert_equals(
    decode_lsp_session([
      combined.slice(0, 7),
      combined.slice(7, first.length + 4),
      combined.slice(first.length + 4),
    ]),
    [{ id: 1, method: "initialize" }, { id: 2, method: "shutdown" }],
  );
});

Deno.test("golden snapshots are deterministic and compare exact output", () => {
  const value = { z: [2, 1], a: { second: true, first: false } };
  const snapshot =
    "{\n  a: {\n    first: false,\n    second: true\n  },\n  z: [\n    2,\n    1\n  ]\n}\n";

  assert_equals(golden_snapshot(value), snapshot);
  assert_golden(value, snapshot);
});

Deno.test("fixture output matches the checked-in golden file", async () => {
  const fixture = parse_fixture("let answer = 42;\n//    ^^^^^^ definition");
  await assert_golden_file(
    new URL("./fixtures/basic-definition.golden", import.meta.url),
    {
      source: fixture.source,
      spans: [...fixture.spans],
    },
  );
});

Deno.test("multi-file fixtures drive workspace navigation", async () => {
  const fixture = parse_workspace_fixture([
    "//- /a.duck",
    "let exported = 1;",
    "//    ^^^^^^^^ definition",
    "exported",
    "//- /b.duck",
    'const a = import "./a.duck";',
    "let value = a.exported;",
    "//              ^^^^^^^^ reference",
  ].join("\n"));
  const root = await Deno.makeTempDir({ prefix: "duck-harness-workspace-" });

  try {
    await Deno.writeTextFile(root + "/AGENTS.md", "workspace\n");
    const uris = await materialize_workspace_fixture(fixture, root);
    const root_uri = new URL("file://" + root + "/").href;
    const model = new WorkspaceModel([root_uri]);
    model.load([]);
    const b = fixture.files.get("/b.duck");
    const b_uri = uris.get("/b.duck");
    const a_uri = uris.get("/a.duck");

    if (b === undefined || b_uri === undefined || a_uri === undefined) {
      throw new Error("Missing materialized workspace fixture file");
    }

    const reference = b.spans.get("reference");

    if (reference === undefined) {
      throw new Error("Missing workspace fixture reference marker");
    }

    const offset = new PositionIndex(b.source, "utf-16").offset_from_position(
      reference.start,
    );
    assert_equals(
      workspace_definition_location(
        model.entries([]),
        b_uri,
        offset,
        "utf-16",
      )?.uri,
      a_uri,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("headless client sends fragmented LSP frames and finishes orderly", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());

  await client.send_fragmented(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    [1, 4, 19],
  );
  await client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await client.send({ jsonrpc: "2.0", method: "exit" });

  const session = await client.finish();
  assert_equals(session.success, true);
  assert_equals(
    session.messages.some((message) => {
      if (typeof message !== "object" || message === null) {
        return false;
      }

      return (message as { id?: unknown }).id === 1;
    }),
    true,
  );
});

Deno.test("headless server reports a non-exhaustive match and stays alive", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());
  const uri = "file:///non-exhaustive.duck";

  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await client.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        languageId: "duck",
        version: 1,
        text: "match 1 { | 1 => 10 }\n",
      },
    },
  });
  await client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "workspace/symbol",
    params: { query: "value" },
  });
  await client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
  await client.send({ jsonrpc: "2.0", method: "exit" });

  const session = await client.finish();
  assert_equals(session.success, true);
  assert_equals(new TextDecoder().decode(session.stderr), "");
  assert_equals(
    session.messages.some((message) => {
      if (typeof message !== "object" || message === null) {
        return false;
      }

      const params = (message as {
        method?: unknown;
        params?: {
          diagnostics?: Array<{ code?: unknown }>;
        };
      }).params;
      return (message as { method?: unknown }).method ===
          "textDocument/publishDiagnostics" &&
        params?.diagnostics?.some((diagnostic) =>
            diagnostic.code === "DUCK2314"
          ) === true;
    }),
    true,
  );
  assert_equals(
    session.messages.some((message) =>
      typeof message === "object" && message !== null &&
      (message as { id?: unknown }).id === 2
    ),
    true,
  );
});

Deno.test("headless client can disconnect before LSP shutdown", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());

  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  const session = await client.disconnect();
  assert_equals(session.success, true);
});

Deno.test("headless server exits nonzero when exit precedes shutdown", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());

  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await client.send({ jsonrpc: "2.0", method: "exit" });
  const session = await client.finish();
  assert_equals(session.success, false);
  assert_equals(session.code, 1);
});

Deno.test("headless server cancels a queued request over real framing", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());

  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "workspace/symbol",
    params: { query: "value" },
  });
  await client.send({
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 2 },
  });
  await client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
  await client.send({ jsonrpc: "2.0", method: "exit" });
  const session = await client.finish();
  assert_equals(session.success, true);
  const cancellation = session.messages.find((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    return (message as { id?: unknown }).id === 2;
  });
  assert_equals(cancellation, {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32800, message: "Request cancelled" },
  });
});

Deno.test("recorded rapid-edit session publishes only its latest version", async () => {
  const client = new LspTestClient(new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn());
  const uri = "file:///recorded-session.duck";
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await client.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "duck", version: 1, text: "0\n" },
    },
  });

  for (let version = 2; version <= 41; version += 1) {
    await client.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: (version - 1).toString() + "\n" }],
      },
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  await client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await client.send({ jsonrpc: "2.0", method: "exit" });
  const session = await client.finish();
  assert_equals(session.success, true);
  const diagnostics = session.messages.filter((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    return (message as { method?: unknown }).method ===
      "textDocument/publishDiagnostics";
  }) as Array<{ params: { version?: number } }>;
  const versioned = diagnostics.flatMap((message) => {
    if (message.params.version === undefined) {
      return [];
    }

    return [message.params.version];
  });
  assert_equals(versioned[versioned.length - 1], 41);
  assert_equals(
    versioned.slice(1).every((version) => version === 41),
    true,
  );
});
