import { Source } from "../../src/frontend.ts";
import { beginFunctionalWasmArena } from "../../../gpufuck/functional.ts";
import { ExperimentalDuckCompiler } from "./compiler.ts";

type Compilation = {
  total_ms: number;
  wasm: Uint8Array<ArrayBuffer>;
  intermediate_bytes: number;
};

const source_path = "case-studies/codex/citation_parser_fixture.duck";
const expected = 474_580_703;
const measured_rounds = 3;

const startup_start = performance.now();
const compiler = await ExperimentalDuckCompiler.create();
const startup_ms = performance.now() - startup_start;

try {
  await compile_current();
  await compile_gpufuck();

  const current_samples: Compilation[] = [];
  const gpufuck_samples: Compilation[] = [];

  for (let round = 0; round < measured_rounds; round += 1) {
    current_samples.push(await compile_current());
    gpufuck_samples.push(await compile_gpufuck());
  }

  const current = require_last(current_samples, "current");
  const current_module = await WebAssembly.compile(current.wasm);
  const current_instance = await WebAssembly.instantiate(current_module);
  const current_main = require_main(current_instance, "current");
  require_result(current_main(), "current");

  const gpufuck_execution = await compiler.run_file(source_path);
  if (
    gpufuck_execution.value.kind !== "integer" ||
    gpufuck_execution.value.value !== expected
  ) {
    throw new Error(
      "gpufuck Codex-derived workload returned " +
        JSON.stringify(gpufuck_execution.value) + "; expected " +
        expected.toString(),
    );
  }

  const current_runtime_ns = measure_calls(current_main, expected);
  const gpufuck_main = require_main(gpufuck_execution.instance, "gpufuck");
  const gpufuck_invocation = () => {
    const arena = beginFunctionalWasmArena(gpufuck_execution.instance);
    try {
      return gpufuck_main();
    } finally {
      arena.reset();
    }
  };
  const gpufuck_runtime_ns = measure_calls(gpufuck_invocation, expected);

  console.log(JSON.stringify(
    {
      workload: {
        source: source_path,
        origin: "OpenAI Codex utils/stream-parser incremental citation parser",
        expected,
        measured_rounds,
      },
      current: {
        median_source_to_wasm_ms: median(
          current_samples.map((sample) => sample.total_ms),
        ),
        wat_bytes: current.intermediate_bytes,
        wasm_bytes: current.wasm.byteLength,
        warm_recomputing_execution_ns: current_runtime_ns,
      },
      gpufuck: {
        startup_ms,
        median_source_to_wasm_ms: median(
          gpufuck_samples.map((sample) => sample.total_ms),
        ),
        wasm_bytes: require_last(gpufuck_samples, "gpufuck").wasm.byteLength,
        warm_recomputing_execution_ns: gpufuck_runtime_ns,
        execution_stats: gpufuck_execution.stats,
      },
      comparison: {
        gpufuck_over_current_compile_time: median(
          gpufuck_samples.map((sample) => sample.total_ms),
        ) / median(current_samples.map((sample) => sample.total_ms)),
        compile_speedup: median(
          current_samples.map((sample) => sample.total_ms),
        ) / median(gpufuck_samples.map((sample) => sample.total_ms)),
        gpufuck_over_current_execution_time: gpufuck_runtime_ns /
          current_runtime_ns,
        runtime_note:
          "Both main exports recompute the parser. gpufuck Text operations execute as native Wasm buffer intrinsics with an invocation arena reset after each call.",
      },
    },
    undefined,
    2,
  ));
} finally {
  compiler.destroy();
}

async function compile_current(): Promise<Compilation> {
  const start = performance.now();
  const source = Source.load_fragment_file(source_path);
  const wat = Source.wat(source);
  const wasm = await wasm_from_wat(wat);
  return {
    total_ms: performance.now() - start,
    wasm,
    intermediate_bytes: new TextEncoder().encode(wat).byteLength,
  };
}

async function compile_gpufuck(): Promise<Compilation> {
  const start = performance.now();
  const wasm = await compiler.compile_file(source_path);
  return {
    total_ms: performance.now() - start,
    wasm,
    intermediate_bytes: 0,
  };
}

async function wasm_from_wat(
  wat: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const process = new Deno.Command("wat2wasm", {
    args: ["-", "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(wat));
  await writer.close();
  const output = await process.output();

  if (!output.success) {
    throw new Error(
      "wat2wasm failed for Codex-derived benchmark:\n" +
        new TextDecoder().decode(output.stderr),
    );
  }

  return output.stdout;
}

function require_last(
  samples: readonly Compilation[],
  route: string,
): Compilation {
  const sample = samples[samples.length - 1];
  if (sample === undefined) {
    throw new Error(route + " Codex-derived benchmark omitted its last sample");
  }
  return sample;
}

function require_main(
  instance: WebAssembly.Instance,
  route: string,
): () => unknown {
  const main = instance.exports.main;
  if (typeof main !== "function") {
    throw new Error(route + " Codex-derived module omitted main");
  }
  return main as () => unknown;
}

function require_result(value: unknown, route: string): void {
  if (value !== expected) {
    throw new Error(
      route + " Codex-derived workload returned " + String(value) +
        "; expected " + expected.toString(),
    );
  }
}

function measure_calls(call: () => unknown, expected_result: number): number {
  const count = 10_000;
  let checksum = 0;
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    const value = call();
    if (typeof value !== "number") {
      throw new Error("Codex-derived runtime returned a non-number");
    }
    checksum += value;
  }
  const elapsed = performance.now() - start;
  if (checksum !== expected_result * count) {
    throw new Error("Codex-derived runtime checksum mismatch");
  }
  return elapsed * 1_000_000 / count;
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) {
    throw new Error("Codex-derived benchmark has no samples");
  }
  return value;
}
