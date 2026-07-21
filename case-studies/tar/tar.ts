import { DuckHost, type DuckValue, Source } from "../../src/frontend.ts";
import { live_runner, type TarRunner } from "./host.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const source_url = new URL("./tar.duck", import.meta.url);
const host_interface_url = new URL("./host.duck", import.meta.url);

export const tar_error_code = {
  truncated_header: 1,
  checksum: 2,
  invalid_size: 3,
  size_out_of_range: 4,
  truncated_data: 5,
  end_marker: 6,
  total_out_of_range: 7,
} as const;

export type TarSummary = {
  entry_count: number;
  file_count: number;
  directory_count: number;
  other_count: number;
  total_size: number;
  names: Uint8Array;
};

export type TarResult =
  | { tag: "Ok"; value: TarSummary }
  | { tag: "Err"; value: { code: number; offset: number } };

export async function main(runner: TarRunner): Promise<TarResult> {
  const artifact = Source.artifact_file(source_url.href, {
    host_interface: host_interface_url.href,
  });
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    return decode_result(runner.run(program));
  } finally {
    program.dispose();
  }
}

function decode_result(value: DuckValue): TarResult {
  const module_result = expect_product(
    value,
    1,
    "tar module must return a one-slot product",
  );
  const result = expect_record(
    module_result[0],
    "tar module result is missing",
  );
  const tag = expect_string(result.tag, "tar result is missing a tag");
  const payload = result.value;

  if (tag === "Ok") {
    const summary = expect_product(payload, 6, "tar summary is missing");

    return {
      tag,
      value: {
        entry_count: expect_i32(summary[0], "tar entry count"),
        file_count: expect_i32(summary[1], "tar file count"),
        directory_count: expect_i32(summary[2], "tar directory count"),
        other_count: expect_i32(summary[3], "tar other count"),
        total_size: expect_i32(summary[4], "tar total size"),
        names: expect_bytes(summary[5], "tar names"),
      },
    };
  }

  if (tag === "Err") {
    const error = expect_product(payload, 2, "tar error is missing");

    return {
      tag,
      value: {
        code: expect_i32(error[0], "tar error code"),
        offset: expect_i32(error[1], "tar error offset"),
      },
    };
  }

  throw new Error("Unexpected tar result tag: " + tag);
}

function expect_product(
  value: DuckValue | undefined,
  length: number,
  message: string,
): DuckValue[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(message);
  }

  return value;
}

function expect_record(
  value: DuckValue | undefined,
  message: string,
): Record<string, DuckValue> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new Error(message);
  }

  return value;
}

function expect_string(value: DuckValue | undefined, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value;
}

function expect_i32(value: DuckValue | undefined, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(message);
  }

  return value;
}

function expect_bytes(
  value: DuckValue | undefined,
  message: string,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(message);
  }

  return value;
}

async function wasm_from_wat(wat: string): Promise<Uint8Array> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(encoder.encode(wat));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(
      "wat2wasm failed:\n" + decoder.decode(output.stderr) + "\n" + wat,
    );
  }

  return output.stdout;
}

if (import.meta.main) {
  const path = Deno.args[0];

  if (path === undefined || Deno.args.length !== 1) {
    throw new Error("Usage: deno run case-studies/tar/tar.ts ARCHIVE.tar");
  }

  const runner = live_runner(path);

  try {
    console.log(Deno.inspect(await main(runner), { depth: 10 }));
  } finally {
    runner.dispose();
  }
}
