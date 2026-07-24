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

Deno.test("dependency boundaries keep the frontend independent from Core", () => {
  const graph = new Map([
    [
      "src/frontend/analyze.ts",
      new Set(["src/core/ast.ts"]),
    ],
    ["src/core/ast.ts", new Set<string>()],
  ]);

  assert_equals(dependency_violations(graph), [{
    importer: "src/frontend/analyze.ts",
    imported: "src/core/ast.ts",
    reason: "frontend stages cannot import semantic Core",
  }]);
});
