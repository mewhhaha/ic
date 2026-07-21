import { DuckHost, type DuckValue, Source } from "../../src/frontend.ts";
import { type EditorRunner, live_runner } from "./host.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const source_url = new URL("./editor.duck", import.meta.url);
const host_interface_url = new URL("./host.duck", import.meta.url);

export type EditorResult = {
  code: number;
};

export async function main(runner: EditorRunner): Promise<EditorResult> {
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

function decode_result(value: DuckValue): EditorResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("editor module must return a one-slot product");
  }

  const code = value[0];

  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw new Error("editor module result code must be an integer");
  }

  return { code };
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

  if (path === undefined) {
    throw new Error("Usage: deno run -A case-studies/editor/editor.ts <path>");
  }

  const runner = live_runner(path);

  try {
    const result = await main(runner);
    Deno.exitCode = result.code;
  } finally {
    runner.dispose();
  }
}
