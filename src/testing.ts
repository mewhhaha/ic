import type { AbiManifest } from "./abi.ts";
import { DuckHost } from "./host.ts";

export type DuckTestResult =
  | { name: string; status: "passed" }
  | { name: string; status: "failed"; message: string };

export async function run_duck_tests(
  source: BufferSource | WebAssembly.Module,
  manifest: AbiManifest,
): Promise<DuckTestResult[]> {
  const callables = manifest.callables;

  if (!callables) {
    throw new Error("Test ABI manifest is missing callable contracts");
  }

  const program = await DuckHost.instantiate(source, manifest);
  const results: DuckTestResult[] = [];

  try {
    for (const name of Object.keys(callables).sort()) {
      const callable = callables[name];

      if (!callable) {
        throw new Error("Missing test callable contract for " + name);
      }

      if (
        callable.params.length !== 0 || callable.result.type.tag !== "unit"
      ) {
        results.push({
          name,
          status: "failed",
          message: "Test must have type () -> Unit",
        });
        continue;
      }

      try {
        program.call(name);
        results.push({ name, status: "passed" });
      } catch (error) {
        if (error instanceof Error) {
          results.push({ name, status: "failed", message: error.message });
          continue;
        }

        results.push({ name, status: "failed", message: String(error) });
      }
    }
  } finally {
    program.dispose();
  }

  return results;
}
