import { Source } from "../../src/frontend.ts";
import { ExperimentalDuckCompiler } from "./compiler.ts";

type RuntimeSample = {
  instantiate_ns: number;
  first_execution_ns: number;
};

const current_path = "experiments/gpufuck/workload/current.duck";
const gpufuck_path = "experiments/gpufuck/workload/main.duck";
const expected = 381_455_585;
const sample_count = 15;
const fresh_instances_per_sample = 200;
const warm_calls_per_sample = 100_000;

const current_compile_start = performance.now();
const current_wat = Source.wat(Source.load_fragment_file(current_path));
const current_compile_ms = performance.now() - current_compile_start;
const wat2wasm_start = performance.now();
const current_wasm = await wasm_from_wat(current_wat);
const current_wat2wasm_ms = performance.now() - wat2wasm_start;

const gpufuck_startup_start = performance.now();
const compiler = await ExperimentalDuckCompiler.create();
const gpufuck_startup_ms = performance.now() - gpufuck_startup_start;
let gpufuck_wasm: Uint8Array<ArrayBuffer>;
const gpufuck_compile_start = performance.now();

try {
  gpufuck_wasm = await compiler.compile_file(gpufuck_path);
} finally {
  compiler.destroy();
}

const gpufuck_compile_ms = performance.now() - gpufuck_compile_start;
const current_module_compile_start = performance.now();
const current_module = await WebAssembly.compile(current_wasm);
const current_module_compile_ms = performance.now() -
  current_module_compile_start;
const gpufuck_module_compile_start = performance.now();
const gpufuck_module = await WebAssembly.compile(gpufuck_wasm);
const gpufuck_module_compile_ms = performance.now() -
  gpufuck_module_compile_start;

verify_result(current_module, "current compiler", expected);
verify_result(gpufuck_module, "gpufuck compiler", expected);

const current_fresh_samples: RuntimeSample[] = [];
const gpufuck_fresh_samples: RuntimeSample[] = [];
const current_warm_samples: number[] = [];
const gpufuck_warm_samples: number[] = [];

for (let sample = 0; sample < sample_count; sample += 1) {
  current_fresh_samples.push(
    measure_fresh_instances(
      current_module,
      fresh_instances_per_sample,
      expected,
      "current compiler",
    ),
  );
  gpufuck_fresh_samples.push(
    measure_fresh_instances(
      gpufuck_module,
      fresh_instances_per_sample,
      expected,
      "gpufuck compiler",
    ),
  );
  current_warm_samples.push(
    measure_warm_calls(
      current_module,
      warm_calls_per_sample,
      expected,
      "current compiler",
    ),
  );
  gpufuck_warm_samples.push(
    measure_warm_calls(
      gpufuck_module,
      warm_calls_per_sample,
      expected,
      "gpufuck compiler",
    ),
  );
}

const current_instantiate_ns = median(
  current_fresh_samples.map((sample) => sample.instantiate_ns),
);
const gpufuck_instantiate_ns = median(
  gpufuck_fresh_samples.map((sample) => sample.instantiate_ns),
);
const current_first_execution_ns = median(
  current_fresh_samples.map((sample) => sample.first_execution_ns),
);
const gpufuck_first_execution_ns = median(
  gpufuck_fresh_samples.map((sample) => sample.first_execution_ns),
);
const current_instantiate_and_first_execution_ns = median(
  current_fresh_samples.map((sample) =>
    sample.instantiate_ns + sample.first_execution_ns
  ),
);
const gpufuck_instantiate_and_first_execution_ns = median(
  gpufuck_fresh_samples.map((sample) =>
    sample.instantiate_ns + sample.first_execution_ns
  ),
);
const current_warm_ns = median(current_warm_samples);
const gpufuck_warm_ns = median(gpufuck_warm_samples);

console.log(JSON.stringify(
  {
    workload: {
      modular_source: gpufuck_path,
      current_flattened_source: current_path,
      imported_modules: 4,
      recursive_kernel_rounds: 512,
      expected,
      sample_count,
      fresh_instances_per_sample,
      warm_calls_per_sample,
    },
    build: {
      current: {
        duck_compile_ms: current_compile_ms,
        wat2wasm_ms: current_wat2wasm_ms,
        webassembly_compile_ms: current_module_compile_ms,
        wasm_bytes: current_wasm.byteLength,
      },
      gpufuck: {
        webgpu_startup_ms: gpufuck_startup_ms,
        duck_gpu_wasm_compile_ms: gpufuck_compile_ms,
        webassembly_compile_ms: gpufuck_module_compile_ms,
        wasm_bytes: gpufuck_wasm.byteLength,
      },
    },
    runtime: {
      current: {
        instantiate_ns: current_instantiate_ns,
        first_execution_ns: current_first_execution_ns,
        instantiate_and_first_execution_ns:
          current_instantiate_and_first_execution_ns,
        warm_same_instance_ns: current_warm_ns,
      },
      gpufuck: {
        instantiate_ns: gpufuck_instantiate_ns,
        first_execution_ns: gpufuck_first_execution_ns,
        instantiate_and_first_execution_ns:
          gpufuck_instantiate_and_first_execution_ns,
        warm_same_instance_ns: gpufuck_warm_ns,
      },
      gpufuck_over_current: {
        first_execution: gpufuck_first_execution_ns /
          current_first_execution_ns,
        instantiate_and_first_execution:
          gpufuck_instantiate_and_first_execution_ns /
          current_instantiate_and_first_execution_ns,
        warm_same_instance: gpufuck_warm_ns / current_warm_ns,
      },
    },
  },
  undefined,
  2,
));

function measure_fresh_instances(
  module: WebAssembly.Module,
  count: number,
  expected_result: number,
  compiler_name: string,
): RuntimeSample {
  const mains: (() => unknown)[] = [];
  const instantiate_start = performance.now();

  for (let index = 0; index < count; index += 1) {
    const instance = new WebAssembly.Instance(module);
    mains.push(main_export(instance, compiler_name));
  }

  const instantiate_ns = (performance.now() - instantiate_start) * 1_000_000 /
    count;
  let checksum = 0;
  const execution_start = performance.now();

  for (const main of mains) {
    const result = main();

    if (typeof result !== "number") {
      throw new Error(compiler_name + " main returned a non-number");
    }

    checksum += result;
  }

  const first_execution_ns = (performance.now() - execution_start) *
    1_000_000 / count;
  require_checksum(checksum, expected_result, count, compiler_name);
  return { instantiate_ns, first_execution_ns };
}

function measure_warm_calls(
  module: WebAssembly.Module,
  count: number,
  expected_result: number,
  compiler_name: string,
): number {
  const instance = new WebAssembly.Instance(module);
  const main = main_export(instance, compiler_name);
  const first_result = main();

  if (first_result !== expected_result) {
    throw new Error(
      compiler_name + " warmup returned " + String(first_result) +
        "; expected " + expected_result.toString(),
    );
  }

  let checksum = 0;
  const start = performance.now();

  for (let index = 0; index < count; index += 1) {
    const result = main();

    if (typeof result !== "number") {
      throw new Error(compiler_name + " main returned a non-number");
    }

    checksum += result;
  }

  const elapsed = performance.now() - start;
  require_checksum(checksum, expected_result, count, compiler_name);
  return elapsed * 1_000_000 / count;
}

function verify_result(
  module: WebAssembly.Module,
  compiler_name: string,
  expected_result: number,
): void {
  const instance = new WebAssembly.Instance(module);
  const result = main_export(instance, compiler_name)();

  if (result !== expected_result) {
    throw new Error(
      compiler_name + " returned " + String(result) + "; expected " +
        expected_result.toString(),
    );
  }
}

function main_export(
  instance: WebAssembly.Instance,
  compiler_name: string,
): () => unknown {
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error(compiler_name + " output does not export main");
  }

  return main as () => unknown;
}

function require_checksum(
  checksum: number,
  expected_result: number,
  count: number,
  compiler_name: string,
): void {
  const expected_checksum = expected_result * count;

  if (checksum !== expected_checksum) {
    throw new Error(
      compiler_name + " checksum was " + checksum.toString() +
        "; expected " + expected_checksum.toString(),
    );
  }
}

async function wasm_from_wat(
  wat: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const directory = await Deno.makeTempDir({
    prefix: "ducklang-gpufuck-runtime-",
  });
  const wat_path = directory + "/workload.wat";
  const wasm_path = directory + "/workload.wasm";

  try {
    await Deno.writeTextFile(wat_path, wat);
    const output = await new Deno.Command("wat2wasm", {
      args: [wat_path, "-o", wasm_path],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!output.success) {
      throw new Error(
        "wat2wasm failed for runtime benchmark:\n" +
          new TextDecoder().decode(output.stderr),
      );
    }

    return await Deno.readFile(wasm_path);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function median(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new Error("cannot compute median of empty runtime samples");
  }

  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];

  if (value === undefined) {
    throw new Error("runtime median omitted sample " + middle.toString());
  }

  if (sorted.length % 2 === 1) {
    return value;
  }

  const previous = sorted[middle - 1];

  if (previous === undefined) {
    throw new Error("runtime median omitted lower sample");
  }

  return (previous + value) / 2;
}
