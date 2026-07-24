import { assert_equals } from "../assert.ts";
import {
  execute_powertools_command,
  powertools_code_lenses,
} from "./powertools.ts";

Deno.test("powertools discovers runnable example code lenses", () => {
  const uri = "file:///workspace/examples/compile_time/01_comptime_adder.duck";
  const lenses = powertools_code_lenses(uri);

  assert_equals(lenses.map((lens) => lens.title), ["▸ run example"]);

  const run = execute_powertools_command({
    command: "duck.runExample",
    uri,
  });
  assert_equals(run, {
    ok: true,
    value: {
      command: "deno",
      args: [
        "test",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "examples/examples.test.ts",
        "--filter",
        "example runs: examples/compile_time/01_comptime_adder.duck",
      ],
    },
  });
});

Deno.test("powertools rejects run commands outside the example manifest", () => {
  assert_equals(
    execute_powertools_command({
      command: "duck.runExample",
      uri: "file:///scratch/unknown.duck",
    }),
    {
      ok: false,
      code: "not_runnable",
      message: "This file is not a runnable manifest example",
    },
  );
});
