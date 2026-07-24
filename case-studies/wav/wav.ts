import { DuckCompiler, type DuckHostValue } from "../../src/compiler.ts";

const source_url = new URL("./wav.duck", import.meta.url);

export const default_output_path = "phrase.wav";

export async function render_wav(): Promise<Uint8Array> {
  const compiler = await DuckCompiler.create();

  try {
    const execution = await compiler.run_file(source_url.href);
    return decode_wav(execution.value);
  } finally {
    compiler.destroy();
  }
}

function decode_wav(value: DuckHostValue): Uint8Array {
  if (value.kind !== "constructor" || value.fields.length !== 1) {
    throw new Error("WAV module must return a one-slot product");
  }

  const wav = value.fields[0];

  if (wav === undefined || wav.kind !== "bytes") {
    throw new Error("WAV module export wav must be Bytes");
  }

  return wav.value;
}

if (import.meta.main) {
  let output_path = default_output_path;

  if (Deno.args.length === 1) {
    const path = Deno.args[0];

    if (path === undefined) {
      throw new Error("Missing WAV output path");
    }

    output_path = path;
  } else if (Deno.args.length > 1) {
    throw new Error(
      "Usage: deno run --allow-read --allow-write " +
        "case-studies/wav/wav.ts [output.wav]",
    );
  }

  const wav = await render_wav();
  await Deno.writeFile(output_path, wav);
}
