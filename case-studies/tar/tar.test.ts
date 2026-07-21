import { assert_equals } from "../../src/assert.ts";
import { Source } from "../../src/frontend.ts";
import { mock_runner } from "./host.ts";
import { main, tar_error_code, type TarSummary } from "./tar.ts";

const source_url = new URL("./tar.duck", import.meta.url);
const host_interface_url = new URL("./host.duck", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

Deno.test("tar case study exposes an owned archive-byte boundary", () => {
  const artifact = Source.artifact_file(source_url.href, {
    host_interface: host_interface_url.href,
  });

  assert_equals(Object.keys(artifact.abi.effects), ["Archive"]);
  assert_equals(artifact.abi.effects.Archive?.operations.read?.result, {
    type: { tag: "named", name: "ArchiveResult" },
    ownership: "unique_heap",
  });
  const archive_result = artifact.abi.types.ArchiveResult;

  if (archive_result.tag !== "union") {
    throw new Error("Expected ArchiveResult union ABI");
  }

  assert_equals(archive_result.cases[0]?.payload, { tag: "bytes" });
});

Deno.test("tar summarizes ustar headers, payload blocks, and raw path bytes", async () => {
  const archive = tar_archive([
    { name: "docs", type_flag: "5" },
    { name: "alpha.txt", content: encoder.encode("cat") },
    {
      name: "leaf.txt",
      prefix: "nested",
      content: encoder.encode("ox"),
    },
  ]);
  const runner = mock_runner(archive);

  try {
    const result = await main(runner);

    if (result.tag !== "Ok") {
      throw new Error("Expected tar summary");
    }

    assert_equals(summary_fields(result.value), {
      entry_count: 3,
      file_count: 2,
      directory_count: 1,
      other_count: 0,
      total_size: 5,
      names: ["docs", "alpha.txt", "nested/leaf.txt"],
    });
  } finally {
    runner.dispose();
  }
});

Deno.test("tar rejects a header whose checksum does not match its bytes", async () => {
  const archive = tar_archive([{
    name: "alpha",
    content: encoder.encode("a"),
  }]);
  archive[0] = 98;
  const runner = mock_runner(archive);

  try {
    assert_equals(await main(runner), {
      tag: "Err",
      value: { code: tar_error_code.checksum, offset: 0 },
    });
  } finally {
    runner.dispose();
  }
});

Deno.test("tar rejects a checksum-valid header with a malformed octal size", async () => {
  const archive = tar_archive([{
    name: "alpha",
    content: encoder.encode("a"),
  }]);
  archive[124] = 120;
  write_checksum(archive.subarray(0, 512));
  const runner = mock_runner(archive);

  try {
    assert_equals(await main(runner), {
      tag: "Err",
      value: { code: tar_error_code.invalid_size, offset: 0 },
    });
  } finally {
    runner.dispose();
  }
});

Deno.test("tar rejects payloads that end before their declared block", async () => {
  const archive = tar_archive([{
    name: "alpha",
    content: encoder.encode("cat"),
  }]);
  const truncated = archive.slice(0, 512 + 3);
  const runner = mock_runner(truncated);

  try {
    assert_equals(await main(runner), {
      tag: "Err",
      value: { code: tar_error_code.truncated_data, offset: 0 },
    });
  } finally {
    runner.dispose();
  }
});

Deno.test("tar requires the two zero-block end marker", async () => {
  const archive = tar_archive([]).slice(0, 512);
  const runner = mock_runner(archive);

  try {
    assert_equals(await main(runner), {
      tag: "Err",
      value: { code: tar_error_code.end_marker, offset: 0 },
    });
  } finally {
    runner.dispose();
  }
});

type TarFixtureEntry = {
  name: string;
  prefix?: string;
  content?: Uint8Array;
  type_flag?: "0" | "5" | "2";
};

function tar_archive(entries: TarFixtureEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    let content = new Uint8Array();

    if (entry.content !== undefined) {
      content = entry.content.slice();
    }

    let type_flag = "0";

    if (entry.type_flag !== undefined) {
      type_flag = entry.type_flag;
    }

    const header = new Uint8Array(512);
    write_text(header, 0, 100, entry.name);
    write_octal(header, 100, 8, 0o644);
    write_octal(header, 108, 8, 0);
    write_octal(header, 116, 8, 0);
    write_octal(header, 124, 12, content.byteLength);
    write_octal(header, 136, 12, 0);
    header[156] = type_flag.charCodeAt(0);
    write_text(header, 257, 6, "ustar");
    write_text(header, 263, 2, "00");

    if (entry.prefix !== undefined) {
      write_text(header, 345, 155, entry.prefix);
    }

    write_checksum(header);
    blocks.push(header, content, new Uint8Array(padding_length(content)));
  }

  blocks.push(new Uint8Array(512), new Uint8Array(512));
  return join(blocks);
}

function write_text(
  target: Uint8Array,
  offset: number,
  width: number,
  value: string,
): void {
  const bytes = encoder.encode(value);

  if (bytes.byteLength > width) {
    throw new Error("Fixture field is too long: " + value);
  }

  target.set(bytes, offset);
}

function write_octal(
  target: Uint8Array,
  offset: number,
  width: number,
  value: number,
): void {
  const digits = value.toString(8).padStart(width - 1, "0");
  write_text(target, offset, width - 1, digits);
  target[offset + width - 1] = 0;
}

function write_checksum(header: Uint8Array): void {
  header.fill(32, 148, 156);
  let checksum = 0;

  for (const byte of header) {
    checksum += byte;
  }

  const digits = checksum.toString(8).padStart(6, "0");
  write_text(header, 148, 6, digits);
  header[154] = 0;
  header[155] = 32;
}

function padding_length(content: Uint8Array): number {
  if (content.byteLength === 0 || content.byteLength % 512 === 0) {
    return 0;
  }

  return 512 - content.byteLength % 512;
}

function join(chunks: Uint8Array[]): Uint8Array {
  let length = 0;

  for (const chunk of chunks) {
    length += chunk.byteLength;
  }

  const archive = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return archive;
}

function summary_fields(summary: TarSummary): Record<string, unknown> {
  return {
    entry_count: summary.entry_count,
    file_count: summary.file_count,
    directory_count: summary.directory_count,
    other_count: summary.other_count,
    total_size: summary.total_size,
    names: decode_names(summary.names),
  };
}

function decode_names(names: Uint8Array): string[] {
  const decoded: string[] = [];
  let start = 0;

  for (let index = 0; index < names.byteLength; index += 1) {
    if (names[index] !== 0) {
      continue;
    }

    decoded.push(decoder.decode(names.slice(start, index)));
    start = index + 1;
  }

  if (start !== names.byteLength) {
    throw new Error("Tar name ledger is missing its NUL delimiter");
  }

  return decoded;
}
