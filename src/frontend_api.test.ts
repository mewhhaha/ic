import { assert_equals, assert_includes } from "./assert.ts";
import {
  diagnostic_codes,
  duck_abi_version,
  DuckHost,
  DuckRunner,
  Source,
} from "./frontend.ts";
import type {
  AbiManifest,
  DuckValue,
  SourceAnalysis,
  SourceArtifact,
  SourceDiagnostic,
} from "./frontend.ts";

Deno.test("product frontend exposes the supported compiler and host surface", () => {
  const analysis: SourceAnalysis = Source.analyze("1");
  const diagnostic: SourceDiagnostic | undefined = analysis.diagnostics[0];
  const value: DuckValue = 1;
  const manifest: AbiManifest | undefined = undefined;
  const artifact: SourceArtifact | undefined = undefined;

  assert_equals(analysis.diagnostics, []);
  assert_equals(diagnostic, undefined);
  assert_equals(value, 1);
  assert_equals(manifest, undefined);
  assert_equals(artifact, undefined);
  assert_equals(diagnostic_codes.syntax_error, "DUCK1001");
  assert_equals(duck_abi_version, "duck-js-1");
  assert_equals(typeof DuckHost.instantiate, "function");
  assert_equals(typeof DuckRunner, "function");
});

Deno.test("product frontend does not export compiler internals", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ducklang-public-api-",
  });
  const path = directory + "/removed-exports.ts";
  const module_url = new URL("./frontend.ts", import.meta.url).href;
  const source = `
import type {
  BindingIndex,
  ComptimeValue,
  Core,
  FrontExpr,
  SourceFacts,
} from ${JSON.stringify(module_url)};

export type Removed = [BindingIndex, ComptimeValue, Core, FrontExpr, SourceFacts];
`;

  try {
    await Deno.writeTextFile(path, source);
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["check", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const error = new TextDecoder().decode(output.stderr);

    assert_equals(output.success, false);
    assert_includes(error, "BindingIndex");
    assert_includes(error, "ComptimeValue");
    assert_includes(error, "Core");
    assert_includes(error, "FrontExpr");
    assert_includes(error, "SourceFacts");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
