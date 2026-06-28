const decoder = new TextDecoder();

function logError(label: string, bytes: Uint8Array): void {
  if (bytes.length > 0) {
    console.error(`${label}:\n${decoder.decode(bytes)}`);
  }
}

Deno.test("main writes WAT that compiles and instantiates", async () => {
  const watFile = "build/out.wat";
  const wasmFile = "build/out.wasm";

  await Deno.mkdir("build", { recursive: true });

  const runMain = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", "main.ts"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!runMain.success) {
    logError("main.ts failed", runMain.stderr);
    throw new Error("main.ts failed");
  }

  try {
    await Deno.stat(watFile);
  } catch {
    throw new Error("main.ts did not write " + watFile);
  }

  const compile = await new Deno.Command("wat2wasm", {
    args: [watFile, "-o", wasmFile],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (compile.stderr.length > 0) {
    logError("wat2wasm stderr", compile.stderr);
  }

  if (!compile.success) {
    throw new Error("wat2wasm failed");
  }

  const wasmBytes = await Deno.readFile(wasmFile);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 42) {
    throw new Error("Expected main() -> 42, got " + result);
  }
});
