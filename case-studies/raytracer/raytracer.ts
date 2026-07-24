import { DuckCompiler, type DuckHostValue } from "../../src/compiler.ts";

const source_url = new URL("./raytracer.duck", import.meta.url);

export async function render(): Promise<Uint8Array> {
  const compiler = await DuckCompiler.create();

  try {
    const execution = await compiler.run_file(source_url.href);
    return decode_ppm(execution.value);
  } finally {
    compiler.destroy();
  }
}

function decode_ppm(value: DuckHostValue): Uint8Array {
  if (value.kind !== "constructor" || value.fields.length !== 1) {
    throw new Error("ray tracer module must return a one-slot product");
  }

  const ppm = value.fields[0];

  if (ppm === undefined || ppm.kind !== "bytes") {
    throw new Error("ray tracer module PPM export must be Bytes");
  }

  return ppm.value;
}

if (import.meta.main) {
  await Deno.stdout.write(await render());
}
