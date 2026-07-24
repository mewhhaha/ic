import { DuckCompiler, type DuckHostValue } from "../../src/compiler.ts";
import { type EditorRunner, live_runner } from "./host.ts";

const source_url = new URL("./editor.duck", import.meta.url);
const host_interface_url = new URL("./host.duck", import.meta.url);

export type EditorResult = {
  code: number;
};

export async function main(runner: EditorRunner): Promise<EditorResult> {
  const compiler = await DuckCompiler.create();

  try {
    const execution = await compiler.run_file(source_url.href, {
      host_interface: host_interface_url.href,
      init: runner.init,
    });
    return decode_result(execution.value);
  } finally {
    compiler.destroy();
  }
}

function decode_result(value: DuckHostValue): EditorResult {
  if (
    value.kind !== "constructor" ||
    value.fields.length !== 1
  ) {
    throw new Error("editor module must return a one-slot product");
  }

  const code = value.fields[0];

  if (
    code === undefined || code.kind !== "integer" ||
    !Number.isInteger(code.value)
  ) {
    throw new Error("editor module result code must be an integer");
  }

  return { code: code.value };
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
