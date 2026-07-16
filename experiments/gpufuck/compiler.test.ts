import { assert_equals, assert_throws } from "../../src/assert.ts";
import { gpufuck_benchmark_cases } from "./benchmark_cases.ts";
import { encode_gpufuck_module, ExperimentalDuckCompiler } from "./compiler.ts";

Deno.test("gpufuck experiment lowers the supported scalar source shape", () => {
  const module = encode_gpufuck_module("let value = 40\nvalue + 2");

  assert_equals(module.definitionCount, 1);
  assert_equals(module.entrySymbol, 0);
  assert_equals(module.nodeCount, 5);
});

Deno.test("gpufuck experiment rejects non-i32 literals with their type and value", () => {
  assert_throws(
    () => encode_gpufuck_module("42i64"),
    "supports only i32 literals; found i64 literal 42",
  );
});

Deno.test("gpufuck experiment rejects unsupported primitives by name", () => {
  assert_throws(
    () => encode_gpufuck_module("84 % 30"),
    "does not support primitive i32.rem_s",
  );
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
  } finally {
    compiler.destroy();
  }
});
