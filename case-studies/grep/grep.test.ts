import { assert_equals } from "../../src/assert.ts";
import {
  type DuckEffectObject,
  type DuckValue,
  Source,
} from "../../src/frontend.ts";
import { main } from "./grep.ts";
import { mock_runner } from "./host.ts";

const source_url = new URL("./grep.duck", import.meta.url);
const host_interface_url = new URL("./host.duck", import.meta.url);
const fixture_url = new URL("./fixtures/input.txt", import.meta.url);

Deno.test("grep case study exposes the typed byte-stream host contract", () => {
  const artifact = Source.artifact_file(source_url.href, {
    host_interface: host_interface_url.href,
  });

  assert_equals(artifact.abi.target.profile, "core-3-nonweb");
  assert_equals(Object.keys(artifact.abi.effects), [
    "Process",
    "Walk",
    "FileReader",
    "Stdin",
    "Stdout",
    "Stderr",
  ]);
  assert_equals(
    artifact.abi.effects.FileReader?.operations.read?.result,
    {
      type: { tag: "named", name: "ReadResult" },
      ownership: "unique_heap",
    },
  );
  assert_equals(
    artifact.abi.effects.Stdout?.operations.write?.params,
    [{ type: { tag: "bytes" }, ownership: "bounded_borrow" }],
  );
  const read_result = artifact.abi.types.ReadResult;
  assert_equals(read_result.tag, "union");

  if (read_result.tag !== "union") {
    throw new Error("Expected ReadResult union ABI");
  }

  assert_equals(read_result.cases[0]?.payload, { tag: "bytes" });
});

Deno.test("grep prints matching lines as raw bytes", async () => {
  const input = new TextEncoder().encode("alpha\nneedle\nomega\nneedle tail\n");
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: { "input.bin": input },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(
      new TextDecoder().decode(concat_chunks(runner.stdout)),
      "needle\nneedle tail\n",
    );
    assert_equals(runner.stderr, []);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep returns no-match for a pattern absent from the file", async () => {
  const runner = mock_runner({
    args: ["missing", "input.bin"],
    files: { "input.bin": new TextEncoder().encode("alpha\nomega\n") },
  });

  try {
    assert_equals(await main(runner), { code: 1 });
    assert_equals(concat_chunks(runner.stdout), new Uint8Array());
  } finally {
    runner.dispose();
  }
});

Deno.test("grep returns no-match for an empty file", async () => {
  const runner = mock_runner({
    args: ["needle", "empty"],
    files: { empty: new Uint8Array() },
  });

  try {
    assert_equals(await main(runner), { code: 1 });
  } finally {
    runner.dispose();
  }
});

Deno.test("grep treats an empty pattern as matching every existing line", async () => {
  const input = new TextEncoder().encode("alpha\n\nomega\n");
  const runner = mock_runner({
    args: ["", "input.bin"],
    files: { "input.bin": input },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(concat_chunks(runner.stdout), input);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep matches UTF-8 patterns in byte-oriented input", async () => {
  const pattern = new TextEncoder().encode("é");
  const input = new Uint8Array([0xff, ...pattern, 0x0a]);
  const runner = mock_runner({
    args: ["é", "input.bin"],
    files: { "input.bin": input },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(concat_chunks(runner.stdout), input);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep rejects an invalid argument count", async () => {
  const runner = mock_runner({ args: [] });

  try {
    assert_equals(await main(runner), { code: 2 });
    assert_equals(runner.stdout, []);
    assert_equals(runner.stderr, []);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep rejects extra arguments", async () => {
  const runner = mock_runner({
    args: ["needle", "input.bin", "extra"],
    files: { "input.bin": new TextEncoder().encode("needle\n") },
  });

  try {
    assert_equals(await main(runner), { code: 2 });
    assert_equals(runner.stdout, []);
    assert_equals(call(runner.init.file_reader, "open", "input.bin"), {
      tag: "Ok",
    });
    assert_equals(call(runner.init.file_reader, "close"), undefined);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep returns an I/O error for a typed FileReader.read error", async () => {
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: { "input.bin": new TextEncoder().encode("needle\n") },
  });
  runner.init.file_reader.read = function read_error(): DuckValue {
    return {
      tag: "Err",
      value: [5, "input.bin", "mock read failure"],
    };
  };

  try {
    assert_equals(await main(runner), { code: 2 });
    assert_equals(runner.stdout, []);
    assert_equals(call(runner.init.file_reader, "open", "input.bin"), {
      tag: "Ok",
    });
    assert_equals(call(runner.init.file_reader, "close"), undefined);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep treats a closed Stdout as a successful match and stops output", async () => {
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: {
      "input.bin": new TextEncoder().encode("needle\nneedle again\n"),
    },
  });
  let writes = 0;
  runner.init.stdout.write = function closed_output(): DuckValue {
    writes += 1;
    return { tag: "Closed" };
  };

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(writes, 1);
    assert_equals(runner.stdout, []);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep returns an I/O error for a typed Stdout.write error", async () => {
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: { "input.bin": new TextEncoder().encode("needle\n") },
  });
  runner.init.stdout.write = function output_error(): DuckValue {
    return {
      tag: "Err",
      value: [5, "<stdout>", "mock output failure"],
    };
  };

  try {
    assert_equals(await main(runner), { code: 2 });
    assert_equals(runner.stdout, []);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep reports missing files as I/O errors", async () => {
  const runner = mock_runner({ args: ["needle", "missing.txt"] });

  try {
    assert_equals(await main(runner), { code: 2 });
  } finally {
    runner.dispose();
  }
});

Deno.test("grep matches a final unterminated line", async () => {
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: { "input.bin": new TextEncoder().encode("alpha\nneedle") },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(
      new TextDecoder().decode(concat_chunks(runner.stdout)),
      "needle",
    );
  } finally {
    runner.dispose();
  }
});

Deno.test("grep preserves invalid UTF-8 bytes in matching lines", async () => {
  const input = new Uint8Array([
    0xff,
    0x6e,
    0x65,
    0x65,
    0x64,
    0x6c,
    0x65,
    0x0a,
  ]);
  const runner = mock_runner({
    args: ["needle", "input.bin"],
    files: { "input.bin": input },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(concat_chunks(runner.stdout), input);
  } finally {
    runner.dispose();
  }
});

Deno.test("grep matches patterns and lines crossing the 64 KiB read boundary", async () => {
  const pattern = "p".repeat(70_000);
  const input = new TextEncoder().encode("prefix\n" + pattern + "\n");
  const runner = mock_runner({
    args: [pattern, "input.bin"],
    files: { "input.bin": input },
  });

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(concat_chunks(runner.stdout), input.slice(7));
  } finally {
    runner.dispose();
  }
});

Deno.test("mock FileReader streams chunks and reports EOF", () => {
  const runner = mock_runner({
    args: [],
    files: { "input.bin": new Uint8Array([1, 2, 3]) },
  });

  try {
    assert_equals(call(runner.init.file_reader, "open", "input.bin"), {
      tag: "Ok",
    });
    assert_equals(
      call(runner.init.file_reader, "read", 2),
      { tag: "Chunk", value: new Uint8Array([1, 2]) },
    );
    assert_equals(
      call(runner.init.file_reader, "read", 2),
      { tag: "Chunk", value: new Uint8Array([3]) },
    );
    assert_equals(call(runner.init.file_reader, "read", 2), { tag: "Eof" });
    assert_equals(call(runner.init.file_reader, "close"), undefined);
  } finally {
    runner.dispose();
  }
});

Deno.test("mock Walk yields raw DFS events and honors prune", () => {
  const runner = mock_runner({
    args: [],
    files: {
      "root/a.txt": new Uint8Array([1]),
      "root/sub/b.txt": new Uint8Array([2]),
    },
  });

  try {
    assert_equals(call(runner.init.walk, "begin", "root"), { tag: "Ok" });
    assert_equals(event_tag(call(runner.init.walk, "next")), "Enter");
    assert_equals(event_path(call(runner.init.walk, "next")), "root/a.txt");
    assert_equals(event_tag(call(runner.init.walk, "next")), "Enter");
    assert_equals(call(runner.init.walk, "prune"), undefined);
    assert_equals(event_tag(call(runner.init.walk, "next")), "Leave");
    assert_equals(event_path(call(runner.init.walk, "next")), "root");
    assert_equals(call(runner.init.walk, "next"), { tag: "Done" });
  } finally {
    runner.dispose();
  }
});

Deno.test("live grep runner matches pattern and reports exit status", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=wat2wasm",
      new URL("./grep.ts", import.meta.url).href,
      "needle",
      fixture_url.pathname,
    ],
    cwd: new URL("../../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  assert_equals(
    new TextDecoder().decode(output.stdout),
    "needle\n",
  );
  assert_equals(new TextDecoder().decode(output.stderr), "");
  assert_equals(output.code, 0);

  const no_match = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=wat2wasm",
      new URL("./grep.ts", import.meta.url).href,
      "absent",
      fixture_url.pathname,
    ],
    cwd: new URL("../../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  }).output();

  assert_equals(no_match.code, 1);
});

function call(
  effect: DuckEffectObject,
  name: string,
  ...args: DuckValue[]
): DuckValue {
  const handler = effect[name];

  if (typeof handler !== "function") {
    throw new Error("Missing mock effect method: " + name);
  }

  return handler.apply(effect, args);
}

function concat_chunks(chunks: Uint8Array[]): Uint8Array {
  let length = 0;

  for (const chunk of chunks) {
    length += chunk.byteLength;
  }

  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function event_tag(value: DuckValue): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    value instanceof Uint8Array || !("tag" in value) ||
    typeof value.tag !== "string"
  ) {
    throw new Error("Expected walk event");
  }

  return value.tag;
}

function event_path(value: DuckValue): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    value instanceof Uint8Array || !("value" in value)
  ) {
    throw new Error("Expected walk event payload");
  }

  const payload = value.value;

  if (
    !Array.isArray(payload) || payload.length !== 4 ||
    typeof payload[0] !== "string"
  ) {
    throw new Error("Expected walk event path");
  }

  return payload[0];
}
