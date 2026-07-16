import { assert_equals } from "../src/assert.ts";
import {
  analyze_dependencies,
  dependency_violations,
  strongly_connected_components,
} from "./dependency-boundaries.ts";

Deno.test("repository architecture has no import cycles or layer violations", () => {
  assert_equals(
    analyze_dependencies(new URL("../src/", import.meta.url)),
    { cycles: [], violations: [] },
  );
});

Deno.test("dependency analysis reports multi-file cycles deterministically", () => {
  const graph = new Map([
    ["src/a.ts", new Set(["src/b.ts"])],
    ["src/b.ts", new Set(["src/a.ts"])],
    ["src/c.ts", new Set<string>()],
  ]);

  assert_equals(strongly_connected_components(graph), [
    ["src/a.ts", "src/b.ts"],
    ["src/c.ts"],
  ]);
});

Deno.test("dependency boundaries reject backend imports from lower layers", () => {
  const graph = new Map([
    [
      "src/core/analysis/types.ts",
      new Set(["src/core/backend/core.ts"]),
    ],
    ["src/core/backend/core.ts", new Set<string>()],
  ]);

  assert_equals(dependency_violations(graph), [{
    importer: "src/core/analysis/types.ts",
    imported: "src/core/backend/core.ts",
    reason: "Core model, analysis, and plan modules cannot import backend code",
  }]);
});
