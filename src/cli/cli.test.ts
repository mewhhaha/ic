import { assert_equals, assert_includes } from "../assert.ts";
import { LspTestClient } from "../lsp/test_harness.ts";

const entry = new URL("../../duck.ts", import.meta.url).pathname;

Deno.test("duck fmt --stdin formats a program", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "fmt", "--stdin"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("let  a=1\na\n"));
  await writer.close();
  const output = await child.output();
  assert_equals(output.success, true);
  assert_equals(new TextDecoder().decode(output.stdout), "let a = 1\na\n");
});

Deno.test("duck lsp answers an initialize and formatting round trip", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", entry, "lsp"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const client = new LspTestClient(command.spawn());

  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  await client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  await client.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///demo.duck",
        languageId: "duck",
        version: 1,
        text: "let  answer=41+1\nanswer\n",
      },
    },
  });
  await client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri: "file:///demo.duck" },
      options: { tabSize: 2, insertSpaces: true },
    },
  });
  await client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
  await client.send({ jsonrpc: "2.0", method: "exit" });

  const output = await client.finish();
  assert_equals(output.success, true);
  // deno-lint-ignore no-explicit-any
  const messages = output.messages as any[];

  const initialize = messages.find((message) => message.id === 1);
  assert_equals(
    initialize?.result?.capabilities?.documentFormattingProvider,
    true,
  );

  const diagnostics = messages.find(
    (message) => message.method === "textDocument/publishDiagnostics",
  );
  assert_equals(diagnostics?.params?.diagnostics, []);

  const formatting = messages.find((message) => message.id === 2);
  assert_equals(
    formatting?.result?.[0]?.newText,
    "let answer = 41 + 1\nanswer\n",
  );
});

Deno.test("duck check accepts a semantically valid source file", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      entry,
      "check",
      "examples/basics/01_arithmetic_and_shadowing.duck",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  assert_equals(output.success, true);
  assert_equals(new TextDecoder().decode(output.stderr), "");
});

Deno.test("duck test runs exported source tests", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      "--allow-run=wat2wasm",
      entry,
      "test",
      "examples/testing/01_inline_tests.duck",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  assert_equals(output.success, true);
  assert_equals(
    new TextDecoder().decode(output.stdout),
    "pass addition_returns_the_sum\n" +
      "pass unequal_values_are_detected\n" +
      "2 tests, 2 passed, 0 failed\n",
  );
  assert_equals(new TextDecoder().decode(output.stderr), "");
});

Deno.test("duck test reports a failing source assertion", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ducklang-cli-test-" });
  const source_path = directory + "/failure.duck";
  await Deno.writeTextFile(
    source_path,
    "module () where\n" +
      'const { test } = import "duck:prelude/attributes" ()\n' +
      'const { assert } = import "duck:prelude/testing" ()\n' +
      "@[test]\n" +
      "const equality_holds: () -> Unit = () => assert(1 == 2)\n" +
      "return {}\n",
  );

  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--allow-read",
        "--allow-run=wat2wasm",
        entry,
        "test",
        source_path,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    assert_equals(output.success, false);
    assert_equals(
      new TextDecoder().decode(output.stdout),
      "1 test, 0 passed, 1 failed\n",
    );
    assert_includes(
      new TextDecoder().decode(output.stderr),
      "fail equality_holds: unreachable",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("duck check reports semantic diagnostics with locations", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      entry,
      "check",
      "examples/failures/compile/01_reused_linear_value.duck",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stderr = new TextDecoder().decode(output.stderr);

  assert_equals(output.success, false);
  assert_includes(
    stderr,
    "examples/failures/compile/01_reused_linear_value.duck:2:10: " +
      "error[DUCK2201]: Linear value token was already consumed",
  );
  assert_includes(stderr, ":2:1: note: First consumed here");
  assert_includes(stderr, ":1:1: note: Linear value declared here");
});

Deno.test("duck check resolves imports before reporting diagnostics", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      entry,
      "check",
      "examples/failures/compile/12_missing_imported_export.duck",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stderr = new TextDecoder().decode(output.stderr);

  assert_equals(output.success, false);
  assert_includes(
    stderr,
    "error[DUCK2501]: Import ./missing_import_dependency.duck " +
      "does not export missing",
  );
});

Deno.test("duck build emits runnable Core WAT and Wasm", async () => {
  const output_directory = await Deno.makeTempDir({
    prefix: "ducklang-cli-build-",
  });

  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--allow-read",
        "--allow-write",
        "--allow-run=wat2wasm",
        entry,
        "build",
        "examples/basics/01_arithmetic_and_shadowing.duck",
        "--emit",
        "all",
        "--out",
        output_directory,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    assert_equals(output.success, true);
    const wat_path = output_directory +
      "/01_arithmetic_and_shadowing.wat";
    const wasm_path = output_directory +
      "/01_arithmetic_and_shadowing.wasm";
    assert_includes(await Deno.readTextFile(wat_path), '(export "main"');
    const wasm = await Deno.readFile(wasm_path);
    const module = await WebAssembly.compile(wasm);
    const instance = await WebAssembly.instantiate(module);
    const main = instance.exports.main;

    if (typeof main !== "function") {
      throw new Error("Built module does not export main");
    }

    assert_equals(main(), 42);
  } finally {
    await Deno.remove(output_directory, { recursive: true });
  }
});

Deno.test("duck build emits the managed ABI manifest", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ducklang-cli-managed-",
  });
  const source_path = directory + "/answer.duck";
  const output_directory = directory + "/build";
  await Deno.writeTextFile(
    source_path,
    "module () where\nreturn { .answer = 42 }\n",
  );

  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--allow-read",
        "--allow-write",
        "--allow-run=wat2wasm",
        entry,
        "build",
        source_path,
        "--managed",
        "--out",
        output_directory,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    assert_equals(output.success, true);
    const manifest = JSON.parse(
      await Deno.readTextFile(output_directory + "/answer.abi.json"),
    );
    assert_equals(manifest.abi_version, "duck-js-1");
    await Deno.stat(output_directory + "/answer.wasm");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("duck run executes an import-free Core program", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      "--allow-run=wat2wasm",
      entry,
      "run",
      "examples/basics/01_arithmetic_and_shadowing.duck",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  assert_equals(output.success, true);
  assert_equals(new TextDecoder().decode(output.stdout), "42\n");
});
