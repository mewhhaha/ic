import { assert_equals } from "../../src/assert.ts";
import type { FunctionalWasmHostValue } from "../../../gpufuck/functional.ts";
import { gpufuck_benchmark_cases } from "./benchmark_cases.ts";
import { encode_gpufuck_module, ExperimentalDuckCompiler } from "./compiler.ts";

Deno.test("gpufuck experiment lowers the supported scalar source shape", () => {
  const module = encode_gpufuck_module("let value = 40\nvalue + 2");

  assert_equals(module.definitionCount, 1);
  assert_equals(module.entrySymbol, 0);
  assert_equals(module.evaluationProfile, "strict-eager-v1");
  assert_equals(module.nodeCount, 5);
});

Deno.test("gpufuck experiment lowers Duck numeric types", () => {
  const i64_module = encode_gpufuck_module("21i64 * 2i64");
  const f32_module = encode_gpufuck_module("20.5f32 + 21.5f32");
  const f64_module = encode_gpufuck_module("20.5f64 + 21.5f64");

  assert_equals(i64_module.nodeCount, 3);
  assert_equals(f32_module.nodeCount, 3);
  assert_equals(f64_module.nodeCount, 3);
});

Deno.test("gpufuck experiment lowers Duck remainder primitives", () => {
  const remainder_module = encode_gpufuck_module("84 % 30");

  assert_equals(remainder_module.nodeCount, 3);
});

Deno.test("gpufuck experiment lowers F32x4 through portable aggregate lanes", () => {
  const module = encode_gpufuck_module(
    "@i32_from_f32(@f32x4_extract_lane(" +
      "@f32x4_add(@f32x4(1f32, 2f32, 3f32, 4f32), " +
      "@f32x4_splat(1f32)), 2))",
  );

  assert_equals(module.definitionCount, 1);
});

Deno.test("gpufuck experiment statically links Duck module records", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "examples/showcases/06_modular_score_application.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment compiles the benchmark suite to runnable Wasm", async () => {
  const sources = await Promise.all(
    gpufuck_benchmark_cases.map((benchmark_case) =>
      Deno.readTextFile(benchmark_case.path)
    ),
  );
  const compiler = await ExperimentalDuckCompiler.create();

  try {
    const modules = await compiler.compile_batch(sources);
    assert_equals(modules.length, gpufuck_benchmark_cases.length);

    for (let index = 0; index < modules.length; index += 1) {
      const wasm = modules[index];
      const benchmark_case = gpufuck_benchmark_cases[index];

      if (wasm === undefined || benchmark_case === undefined) {
        throw new Error(
          "gpufuck test omitted benchmark module " + index.toString(),
        );
      }

      const instance = await WebAssembly.instantiate(wasm);
      const main = instance.instance.exports.main;

      if (typeof main !== "function") {
        throw new Error(
          "gpufuck output for " + benchmark_case.path +
            " does not export main",
        );
      }

      assert_equals(main(), benchmark_case.expected, benchmark_case.path);
    }

    const numeric_modules = await compiler.compile_batch([
      "21i64 * 2i64",
      "20.5f32 + 21.5f32",
      "20.5f64 + 21.5f64",
      "@i32_from_f32(@f32x4_extract_lane(" +
        "@f32x4_add(@f32x4(1f32, 2f32, 3f32, 4f32), " +
        "@f32x4_splat(1f32)), 2))",
    ]);
    const i64_instance = await WebAssembly.instantiate(numeric_modules[0]);
    const f32_instance = await WebAssembly.instantiate(numeric_modules[1]);
    const f64_instance = await WebAssembly.instantiate(numeric_modules[2]);
    const f32x4_instance = await WebAssembly.instantiate(numeric_modules[3]);
    const i64_main = i64_instance.instance.exports.main;
    const f32_main = f32_instance.instance.exports.main;
    const f64_main = f64_instance.instance.exports.main;
    const f32x4_main = f32x4_instance.instance.exports.main;

    if (
      typeof i64_main !== "function" || typeof f32_main !== "function" ||
      typeof f64_main !== "function" || typeof f32x4_main !== "function"
    ) {
      throw new Error("gpufuck numeric output does not export main");
    }

    assert_equals(i64_main(), 42n, "i64 numeric output");
    assert_equals(f32_main(), 42, "f32 numeric output");
    assert_equals(f64_main(), 42, "f64 numeric output");
    assert_equals(f32x4_main(), 4, "portable F32x4 output");

    const workload = await compiler.compile_file(
      "experiments/gpufuck/workload/main.duck",
    );
    const instantiated = await WebAssembly.instantiate(workload);
    const main = instantiated.instance.exports.main;

    if (typeof main !== "function") {
      throw new Error("gpufuck modular workload does not export main");
    }

    assert_equals(main(), 381_455_585, "modular workload");
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes structured Core, ownership, handlers, and loops", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const cases = [
    ["examples/data/09_union_struct_payload.duck", 42],
    ["examples/ownership_modules/04_freeze_and_share.duck", 42],
    ["examples/handlers/01_local_counter.duck", 42],
    ["examples/loops/06_nested_ranges.duck", 42],
    ["examples/compile_time/13_derived_nested_equality.duck", 42],
  ] as const;

  try {
    for (const [path, expected] of cases) {
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "integer",
        value: expected,
      }, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes aggregate effect capabilities", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const written: FunctionalWasmHostValue[] = [];

  try {
    const execution = await compiler.run_file(
      "examples/effects/03_cli_stdin_stdout.duck",
      {
        init: {
          Stdin: {
            $resource: { kind: "resource", id: 1 },
            read_line: () => ({ kind: "text", value: "hello" }),
          },
          Stdout: {
            $resource: { kind: "resource", id: 2 },
            write_line: (value: FunctionalWasmHostValue) => {
              written.push(value);
              return { kind: "unit" };
            },
          },
        },
      },
    );

    assert_equals(written, [{ kind: "text", value: "hello" }]);
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "text", value: "hello" }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment emits managed callables as persistent exports", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile(`
module () where

let add: (I32, I32) -> I32 = (left, right) => left + right
const sum_to: I32 -> I32 = rec (value: I32) => {
  if value == 0 { 0 } else { value + rec(value - 1) }
}
return { .add = add, .sum_to = sum_to, .answer = 42 }
`);
    const instantiated = await WebAssembly.instantiate(wasm);
    const add = instantiated.instance.exports.__duck_abi_call_add;
    const sum_to = instantiated.instance.exports.__duck_abi_call_sum_to;
    if (typeof add !== "function" || typeof sum_to !== "function") {
      throw new Error("gpufuck managed callable exports are missing");
    }

    assert_equals(add(tagged_integer(20), tagged_integer(22)), 42);
    assert_equals(sum_to(tagged_integer(6)), 21);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment resumes explicitly suspending effects", async () => {
  const source = `
module (!init: Init) where

declare effect Timer {
  suspending wait: (I32) => I32
}
declare Init { timer: Timer }

result <- Timer.wait(41)
return { .result = result + 1 }
`;
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_async(source, {
      init: {
        Timer: {
          $resource: { kind: "resource", id: 1 },
          wait: async (argument: FunctionalWasmHostValue) => argument,
        },
      },
    });
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 42 }],
    });

    try {
      await compiler.run(source, {
        init: {
          Timer: {
            $resource: { kind: "resource", id: 1 },
            wait: (argument: FunctionalWasmHostValue) => argument,
          },
        },
      });
      throw new Error("synchronous runner unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!error.message.includes("suspending")) {
        throw error;
      }
    }
  } finally {
    compiler.destroy();
  }
});

function tagged_integer(value: number): bigint {
  return (BigInt(value) << 3n) | 1n;
}
