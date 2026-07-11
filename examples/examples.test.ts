import { assert_equals, assert_includes } from "../src/assert.ts";
import { IxHost, IxRunner, type IxValue, Source } from "../src/frontend.ts";
import {
  compile_failure_examples,
  dependency_paths,
  success_examples,
  type SuccessExample,
  trap_examples,
} from "./manifest.ts";

const decoder = new TextDecoder();

for (const example of success_examples) {
  Deno.test("example runs: " + example.path, async () => {
    if (example.route === "managed") {
      await run_managed_example(example);
      return;
    }

    const wat = compile_example(example);

    for (const example_run of example.runs) {
      const imports = example_run.imports;
      let import_object: WebAssembly.Imports = {};

      if (imports !== undefined) {
        import_object = imports();
      }

      const actual = await run_wat(wat, import_object);
      assert_equals(actual, example_run.expected);
    }
  });
}

for (const example of compile_failure_examples) {
  Deno.test("example rejects: " + example.path, () => {
    let message = "";

    try {
      if (example.route === "ic") {
        Source.ic_wat(Source.load_fragment_file(example.path));
      } else {
        Source.wat(Source.load_fragment_file(example.path));
      }
    } catch (error) {
      message = error_message(error);
    }

    if (message.length === 0) {
      throw new Error("Expected compilation to fail: " + example.path);
    }

    assert_includes(message, example.message);
  });
}

for (const example of trap_examples) {
  Deno.test("example traps: " + example.path, async () => {
    let trapped = false;

    try {
      if (example.route === "managed") {
        await run_managed_trap(example);
      } else {
        const wat = Source.wat(Source.load_fragment_file(example.path));
        let imports: WebAssembly.Imports = {};

        if (example.imports !== undefined) {
          imports = example.imports();
        }

        await run_wat(wat, imports);
      }
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        trapped = true;
      } else {
        throw error;
      }
    }

    assert_equals(trapped, true);
  });
}

Deno.test("example manifest accounts for every .ix file", () => {
  const expected = new Set<string>();

  for (const example of success_examples) {
    expected.add(example.path);
  }

  for (const example of compile_failure_examples) {
    expected.add(example.path);
  }

  for (const example of trap_examples) {
    expected.add(example.path);
  }

  for (const path of dependency_paths) {
    expected.add(path);
  }

  const actual = new Set(collect_ix_files("examples"));
  assert_equals([...actual].sort(), [...expected].sort());
  assert_equals(success_examples.length, 69);
  assert_equals(compile_failure_examples.length, 12);
  assert_equals(trap_examples.length, 4);
});

function compile_example(example: SuccessExample): string {
  if (example.route === "ic") {
    return Source.ic_wat(Source.load_fragment_file(example.path));
  }

  if (example.route === "core") {
    return Source.wat(Source.load_fragment_file(example.path));
  }

  if (example.route === "managed") {
    throw new Error("Managed examples compile through Source.artifact_file");
  }

  example.route satisfies never;
  throw new Error("Unknown example route");
}

async function run_managed_example(example: SuccessExample): Promise<void> {
  const artifact = Source.artifact_file(example.path);
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await IxHost.instantiate(wasm, artifact.abi);

  try {
    for (const example_run of example.runs) {
      const init = example_run.init;

      if (!init) {
        throw new Error("Managed example is missing Init: " + example.path);
      }

      const value = IxRunner(init()).run(program);
      assert_equals(managed_result(value, example.path), example_run.expected);
    }
  } finally {
    program.dispose();
  }
}

async function run_managed_trap(
  example: (typeof trap_examples)[number],
): Promise<void> {
  const init = example.init;

  if (!init) {
    throw new Error("Managed trap example is missing Init: " + example.path);
  }

  const artifact = Source.artifact_file(example.path);
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await IxHost.instantiate(wasm, artifact.abi);

  try {
    IxRunner(init()).run(program);
  } finally {
    program.dispose();
  }
}

function managed_result(value: IxValue, path: string): number | bigint {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    value instanceof Uint8Array || !("result" in value)
  ) {
    throw new Error("Managed example must return { result }: " + path);
  }

  const result = value.result;

  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new Error("Managed example result must be numeric: " + path);
  }

  return result;
}

async function run_wat(
  wat: string,
  imports: WebAssembly.Imports,
): Promise<number | bigint> {
  const bytes = await wasm_from_wat(wat);
  const module = await WebAssembly.compile(bytes);
  const instantiated = await WebAssembly.instantiate(module, imports);
  const main = instantiated.exports.main;

  if (typeof main !== "function") {
    throw new Error("Example module does not export main");
  }

  const result = main();

  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new Error("Example main returned a non-numeric result");
  }

  return result;
}

async function wasm_from_wat(wat: string): Promise<Uint8Array<ArrayBuffer>> {
  const directory = await Deno.makeTempDir({ prefix: "binned-example-" });
  const wat_path = directory + "/example.wat";
  const wasm_path = directory + "/example.wasm";

  try {
    await Deno.writeTextFile(wat_path, wat);
    const command = new Deno.Command("wat2wasm", {
      args: [wat_path, "-o", wasm_path],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    if (!output.success) {
      throw new Error(
        "wat2wasm failed:\n" + decoder.decode(output.stderr) + "\n" + wat,
      );
    }

    const bytes = await Deno.readFile(wasm_path);
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    copy.set(bytes);
    return copy;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function collect_ix_files(path: string): string[] {
  const files: string[] = [];

  for (const entry of Deno.readDirSync(path)) {
    const child = path + "/" + entry.name;

    if (entry.isDirectory) {
      files.push(...collect_ix_files(child));
      continue;
    }

    if (entry.isFile && entry.name.endsWith(".ix")) {
      files.push(child);
    }
  }

  return files;
}

function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
