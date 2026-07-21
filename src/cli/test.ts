import { Source } from "../frontend.ts";
import { run_duck_tests } from "../testing.ts";
import { wasm_from_wat } from "./compile.ts";

export async function run_tests(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] === undefined) {
    throw new Error("test expects one input .duck file");
  }

  const artifact = Source.artifact_file(args[0], {
    import_meta: { mode: { atom: "test" } },
  });
  const wasm = await wasm_from_wat(artifact.wat);
  const results = await run_duck_tests(wasm, artifact.abi);
  let failed = 0;

  for (const result of results) {
    if (result.status === "passed") {
      console.log("pass " + result.name);
      continue;
    }

    failed += 1;
    console.error("fail " + result.name + ": " + result.message);
  }

  const passed = results.length - failed;
  let test_label = "tests";

  if (results.length === 1) {
    test_label = "test";
  }

  console.log(
    results.length.toString() + " " + test_label + ", " + passed.toString() +
      " passed, " + failed.toString() + " failed",
  );

  if (failed > 0) {
    return 1;
  }

  return 0;
}
