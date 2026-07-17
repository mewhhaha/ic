import { Source } from "../../src/frontend.ts";
import { ExperimentalDuckCompiler } from "./compiler.ts";

type RuntimeSample = {
  instantiate_ns: number;
  first_execution_ns: number;
};

type RuntimeTarget = {
  name: string;
  module: WebAssembly.Module;
  invocation(instance: WebAssembly.Instance): () => unknown;
};

type RuntimeMeasurement = {
  instantiate_ns: number;
  first_execution_ns: number;
  instantiate_and_first_execution_ns: number;
  warm_same_instance_ns: number;
};

const current_path = "experiments/gpufuck/workload/current.duck";
const gpufuck_path = "experiments/gpufuck/workload/main.duck";
const callable_path = "experiments/gpufuck/workload/current_callable.duck";
const retained_path = "experiments/gpufuck/workload/retained.duck";
const expected = 381_455_585;
const rounds = 512;
const sample_count = 15;
const fresh_instances_per_sample = 200;
const warm_calls_per_sample = 100_000;

const current_compile_start = performance.now();
const current_wat = Source.wat(Source.load_fragment_file(current_path));
const current_compile_ms = performance.now() - current_compile_start;
const current_wat2wasm_start = performance.now();
const current_wasm = await wasm_from_wat(current_wat);
const current_wat2wasm_ms = performance.now() - current_wat2wasm_start;

const callable_source = await Deno.readTextFile(callable_path);
const current_callable_compile_start = performance.now();
const current_callable_wat = Source.artifact(callable_source).wat;
const current_callable_compile_ms = performance.now() -
  current_callable_compile_start;
const current_callable_wat2wasm_start = performance.now();
const current_callable_wasm = await wasm_from_wat(current_callable_wat);
const current_callable_wat2wasm_ms = performance.now() -
  current_callable_wat2wasm_start;

const gpufuck_startup_start = performance.now();
const compiler = await ExperimentalDuckCompiler.create();
const gpufuck_startup_ms = performance.now() - gpufuck_startup_start;
let gpufuck_wasm: Uint8Array<ArrayBuffer>;
let gpufuck_callable_wasm: Uint8Array<ArrayBuffer>;
let gpufuck_retained_wasm: Uint8Array<ArrayBuffer>;
let gpufuck_compile_ms: number;
let gpufuck_callable_compile_ms: number;
let gpufuck_retained_compile_ms: number;

try {
  let compile_start = performance.now();
  gpufuck_wasm = await compiler.compile_file(gpufuck_path);
  gpufuck_compile_ms = performance.now() - compile_start;

  compile_start = performance.now();
  gpufuck_callable_wasm = await compiler.compile_file(callable_path);
  gpufuck_callable_compile_ms = performance.now() - compile_start;

  compile_start = performance.now();
  gpufuck_retained_wasm = await compiler.compile_file(retained_path);
  gpufuck_retained_compile_ms = performance.now() - compile_start;
} finally {
  compiler.destroy();
}

const compiled = await Promise.all([
  compile_wasm(current_wasm),
  compile_wasm(gpufuck_wasm),
  compile_wasm(current_callable_wasm),
  compile_wasm(gpufuck_callable_wasm),
  compile_wasm(gpufuck_retained_wasm),
]);
const current_module = compiled[0];
const gpufuck_module = compiled[1];
const current_callable_module = compiled[2];
const gpufuck_callable_module = compiled[3];
const gpufuck_retained_module = compiled[4];

if (
  current_module === undefined || gpufuck_module === undefined ||
  current_callable_module === undefined ||
  gpufuck_callable_module === undefined ||
  gpufuck_retained_module === undefined
) {
  throw new Error("runtime benchmark omitted a compiled WebAssembly module");
}

const targets: RuntimeTarget[] = [
  main_target("current recomputing entry", current_module.module),
  main_target("gpufuck recomputing entry", gpufuck_module.module),
  callable_target(
    "current callable",
    current_callable_module.module,
    rounds,
  ),
  callable_target(
    "gpufuck callable",
    gpufuck_callable_module.module,
    tagged_integer(rounds),
  ),
  main_target("gpufuck retained value", gpufuck_retained_module.module),
];
const runtime = measure_runtime(targets, expected);
const current_recomputing = require_measurement(runtime, targets[0]);
const gpufuck_recomputing = require_measurement(runtime, targets[1]);
const current_callable = require_measurement(runtime, targets[2]);
const gpufuck_callable = require_measurement(runtime, targets[3]);
const gpufuck_retained = require_measurement(runtime, targets[4]);

console.log(JSON.stringify(
  {
    workload: {
      modular_source: gpufuck_path,
      current_flattened_source: current_path,
      callable_source: callable_path,
      retained_source: retained_path,
      imported_modules: 4,
      recursive_kernel_rounds: rounds,
      expected,
      sample_count,
      fresh_instances_per_sample,
      warm_calls_per_sample,
    },
    build: {
      current_recomputing: {
        duck_compile_ms: current_compile_ms,
        wat2wasm_ms: current_wat2wasm_ms,
        webassembly_compile_ms: current_module.compile_ms,
        wasm_bytes: current_wasm.byteLength,
      },
      gpufuck_recomputing: {
        webgpu_startup_ms: gpufuck_startup_ms,
        duck_gpu_wasm_compile_ms: gpufuck_compile_ms,
        webassembly_compile_ms: gpufuck_module.compile_ms,
        wasm_bytes: gpufuck_wasm.byteLength,
      },
      current_callable: {
        duck_compile_ms: current_callable_compile_ms,
        wat2wasm_ms: current_callable_wat2wasm_ms,
        webassembly_compile_ms: current_callable_module.compile_ms,
        wasm_bytes: current_callable_wasm.byteLength,
      },
      gpufuck_callable: {
        duck_gpu_wasm_compile_ms: gpufuck_callable_compile_ms,
        webassembly_compile_ms: gpufuck_callable_module.compile_ms,
        wasm_bytes: gpufuck_callable_wasm.byteLength,
      },
      gpufuck_retained: {
        duck_gpu_wasm_compile_ms: gpufuck_retained_compile_ms,
        webassembly_compile_ms: gpufuck_retained_module.compile_ms,
        wasm_bytes: gpufuck_retained_wasm.byteLength,
      },
    },
    runtime: {
      recomputing_entry: {
        current: current_recomputing,
        gpufuck: gpufuck_recomputing,
        gpufuck_over_current: ratios(
          gpufuck_recomputing,
          current_recomputing,
        ),
      },
      callable: {
        contract: "both exports execute all three recursive kernels per call",
        current: current_callable,
        gpufuck: gpufuck_callable,
        gpufuck_over_current: ratios(gpufuck_callable, current_callable),
      },
      retained_value: {
        contract:
          "first call evaluates; later calls return the retained pure value",
        gpufuck: gpufuck_retained,
      },
    },
  },
  undefined,
  2,
));

function measure_runtime(
  targets: readonly RuntimeTarget[],
  expected_result: number,
): ReadonlyMap<RuntimeTarget, RuntimeMeasurement> {
  const fresh_samples = new Map<RuntimeTarget, RuntimeSample[]>();
  const warm_samples = new Map<RuntimeTarget, number[]>();
  for (const target of targets) {
    fresh_samples.set(target, []);
    warm_samples.set(target, []);
    verify_result(target, expected_result);
  }

  for (let sample = 0; sample < sample_count; sample += 1) {
    for (const target of targets) {
      fresh_samples.get(target)?.push(measure_fresh_instances(
        target,
        fresh_instances_per_sample,
        expected_result,
      ));
      warm_samples.get(target)?.push(measure_warm_calls(
        target,
        warm_calls_per_sample,
        expected_result,
      ));
    }
  }

  return new Map(targets.map((target) => {
    const fresh = fresh_samples.get(target) ?? [];
    const warm = warm_samples.get(target) ?? [];
    const instantiate_ns = median(fresh.map((sample) => sample.instantiate_ns));
    const first_execution_ns = median(
      fresh.map((sample) => sample.first_execution_ns),
    );
    return [target, {
      instantiate_ns,
      first_execution_ns,
      instantiate_and_first_execution_ns: median(
        fresh.map((sample) =>
          sample.instantiate_ns + sample.first_execution_ns
        ),
      ),
      warm_same_instance_ns: median(warm),
    }];
  }));
}

function measure_fresh_instances(
  target: RuntimeTarget,
  count: number,
  expected_result: number,
): RuntimeSample {
  const invocations: (() => unknown)[] = [];
  const instantiate_start = performance.now();
  for (let index = 0; index < count; index += 1) {
    invocations.push(
      target.invocation(new WebAssembly.Instance(target.module)),
    );
  }
  const instantiate_ns = (performance.now() - instantiate_start) * 1_000_000 /
    count;
  let checksum = 0;
  const execution_start = performance.now();
  for (const invocation of invocations) {
    checksum += numeric_result(invocation(), target.name);
  }
  const first_execution_ns = (performance.now() - execution_start) * 1_000_000 /
    count;
  require_checksum(checksum, expected_result, count, target.name);
  return { instantiate_ns, first_execution_ns };
}

function measure_warm_calls(
  target: RuntimeTarget,
  count: number,
  expected_result: number,
): number {
  const invocation = target.invocation(new WebAssembly.Instance(target.module));
  require_result(invocation(), expected_result, target.name + " warmup");
  let checksum = 0;
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    checksum += numeric_result(invocation(), target.name);
  }
  const elapsed = performance.now() - start;
  require_checksum(checksum, expected_result, count, target.name);
  return elapsed * 1_000_000 / count;
}

function main_target(name: string, module: WebAssembly.Module): RuntimeTarget {
  return {
    name,
    module,
    invocation(instance) {
      const main = instance.exports.main;
      if (typeof main !== "function") {
        throw new Error(name + " does not export main");
      }
      return main as () => unknown;
    },
  };
}

function callable_target(
  name: string,
  module: WebAssembly.Module,
  argument: number | bigint,
): RuntimeTarget {
  return {
    name,
    module,
    invocation(instance) {
      const run = instance.exports.__duck_abi_call_run;
      if (typeof run !== "function") {
        throw new Error(name + " does not export __duck_abi_call_run");
      }
      return () => run(argument);
    },
  };
}

function verify_result(target: RuntimeTarget, expected_result: number): void {
  const instance = new WebAssembly.Instance(target.module);
  require_result(target.invocation(instance)(), expected_result, target.name);
}

function require_result(
  value: unknown,
  expected_result: number,
  name: string,
): void {
  const result = numeric_result(value, name);
  if (result !== expected_result) {
    throw new Error(
      name + " returned " + result.toString() + "; expected " +
        expected_result.toString(),
    );
  }
}

function numeric_result(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new Error(name + " returned a non-number");
  }
  return value;
}

function require_checksum(
  checksum: number,
  expected_result: number,
  count: number,
  name: string,
): void {
  const expected_checksum = expected_result * count;
  if (checksum !== expected_checksum) {
    throw new Error(
      name + " checksum was " + checksum.toString() + "; expected " +
        expected_checksum.toString(),
    );
  }
}

function ratios(
  gpufuck: RuntimeMeasurement,
  current: RuntimeMeasurement,
): Record<keyof RuntimeMeasurement, number> {
  return {
    instantiate_ns: gpufuck.instantiate_ns / current.instantiate_ns,
    first_execution_ns: gpufuck.first_execution_ns / current.first_execution_ns,
    instantiate_and_first_execution_ns:
      gpufuck.instantiate_and_first_execution_ns /
      current.instantiate_and_first_execution_ns,
    warm_same_instance_ns: gpufuck.warm_same_instance_ns /
      current.warm_same_instance_ns,
  };
}

function require_measurement(
  measurements: ReadonlyMap<RuntimeTarget, RuntimeMeasurement>,
  target: RuntimeTarget | undefined,
): RuntimeMeasurement {
  const measurement = target === undefined
    ? undefined
    : measurements.get(target);
  if (measurement === undefined) {
    throw new Error("runtime benchmark omitted a target measurement");
  }
  return measurement;
}

function tagged_integer(value: number): bigint {
  return (BigInt(value) << 3n) | 1n;
}

async function compile_wasm(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ module: WebAssembly.Module; compile_ms: number }> {
  const start = performance.now();
  const module = await WebAssembly.compile(bytes);
  return { module, compile_ms: performance.now() - start };
}

async function wasm_from_wat(wat: string): Promise<Uint8Array<ArrayBuffer>> {
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
  if (sorted.length % 2 === 1) return value;
  const previous = sorted[middle - 1];
  if (previous === undefined) {
    throw new Error("runtime median omitted lower sample");
  }
  return (previous + value) / 2;
}
