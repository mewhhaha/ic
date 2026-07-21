import { assert_equals, assert_includes } from "./assert.ts";
import { wasm_from_wat } from "./cli/compile.ts";
import { Source } from "./frontend/source.ts";
import { run_duck_tests } from "./testing.ts";

Deno.test("source test runner reports traps and continues", async () => {
  const artifact = Source.artifact(`
module () where

const failing: () -> Unit = () => @panic("failure")
const passing: () -> Unit = () => ()

return { failing, passing }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const results = await run_duck_tests(wasm, artifact.abi);

  assert_equals(results[0]?.name, "failing");
  assert_equals(results[0]?.status, "failed");

  if (results[0]?.status !== "failed") {
    throw new Error("Expected failing test result");
  }

  assert_includes(results[0].message, "unreachable");
  assert_equals(results[1], { name: "passing", status: "passed" });
});

Deno.test("source test runner rejects callable parameters", async () => {
  const artifact = Source.artifact(`
module () where

const invalid: I32 -> I32 = value => value

return { invalid }
`);
  const wasm = await wasm_from_wat(artifact.wat);
  const results = await run_duck_tests(wasm, artifact.abi);

  assert_equals(results, [{
    name: "invalid",
    status: "failed",
    message: "Test must have type () -> Unit",
  }]);
});
