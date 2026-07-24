import { assert_equals, assert_includes } from "../src/assert.ts";
import {
  compile_failure_examples,
  dependency_paths,
  success_examples,
  type SuccessExample,
  test_example_paths,
  trap_examples,
} from "./manifest.ts";
import { corpus_feature_examples } from "./corpus_coverage.ts";
import { DuckCompiler } from "../src/compiler.ts";

Deno.test("examples use the gpufuck target", async (test) => {
  const compiler = await DuckCompiler.create();

  try {
    for (const example of success_examples) {
      await test.step("runs: " + example.path, async () => {
        await run_gpufuck_example(compiler, example);
      });
    }

    for (const example of compile_failure_examples) {
      await test.step("rejects: " + example.path, async () => {
        let message = "";

        try {
          await compiler.compile_file(example.path);
        } catch (error) {
          message = error_message(error);
        }

        if (message.length === 0) {
          throw new Error("Expected compilation to fail: " + example.path);
        }

        assert_includes(message, example.message);
      });
    }

    for (const example of trap_examples) {
      await test.step("traps: " + example.path, async () => {
        let trapped = false;

        try {
          await compiler.run_file(example.path, {
            init: example.init?.(),
          });
        } catch (error) {
          trapped = runtime_trap(error);
        }

        assert_equals(trapped, true);
      });
    }

    for (const path of test_example_paths) {
      await test.step("source tests pass: " + path, async () => {
        const results = await compiler.test_file(path);

        assert_equals(results, [
          { name: "addition_returns_the_sum", status: "passed" },
          { name: "unequal_values_are_detected", status: "passed" },
        ]);
      });
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("example manifest accounts for every .duck file", () => {
  const expected = new Set<string>();

  for (const example of success_examples) {
    expected.add(example.path);
  }

  for (const example of compile_failure_examples) {
    expected.add(example.path);
  }

  for (const example of trap_examples) {
    expected.add(example.path);
  }

  for (const path of dependency_paths) {
    expected.add(path);
  }

  for (const path of test_example_paths) {
    expected.add(path);
  }

  const actual = new Set(collect_duck_files("examples"));
  assert_equals([...actual].sort(), [...expected].sort());
  assert_equals(success_examples.length, 102);
  assert_equals(compile_failure_examples.length, 9);
  assert_equals(trap_examples.length, 4);
  assert_equals(test_example_paths.length, 1);
});

Deno.test("every tree-sitter corpus feature names runnable examples", () => {
  const corpus_features = collect_corpus_features(
    "tree-sitter-duck/test/corpus",
  );
  assert_equals(
    Object.keys(corpus_feature_examples).sort(),
    corpus_features.sort(),
  );

  const runnable_paths = new Set<string>();

  for (const example of success_examples) {
    runnable_paths.add(example.path);
  }

  for (const path of test_example_paths) {
    runnable_paths.add(path);
  }

  for (const [feature, paths] of Object.entries(corpus_feature_examples)) {
    if (paths.length === 0) {
      throw new Error("Corpus feature has no example: " + feature);
    }

    for (const path of paths) {
      if (!runnable_paths.has(path)) {
        throw new Error(
          "Corpus feature example is not runnable: " + feature + " -> " +
            path,
        );
      }
    }
  }
});

Deno.test("tree-sitter corpus covers every named syntax node", () => {
  const definitions = JSON.parse(
    Deno.readTextFileSync("tree-sitter-duck/src/node-types.json"),
  ) as { type: string; named: boolean }[];
  const covered = collect_corpus_node_types("tree-sitter-duck/test/corpus");
  const missing = definitions
    .filter((definition) => definition.named && !covered.has(definition.type))
    .map((definition) => definition.type)
    .sort();

  assert_equals(missing, []);
});

async function run_gpufuck_example(
  compiler: DuckCompiler,
  example: SuccessExample,
): Promise<void> {
  for (const example_run of example.runs) {
    const execution = await compiler.run_file(example.path, {
      init: example_run.init?.(),
    });

    assert_equals(
      numeric_example_value(execution.value, example.path),
      example_run.expected,
    );
  }
}

function numeric_example_value(
  value: Awaited<ReturnType<DuckCompiler["run_file"]>>["value"],
  path: string,
): number | bigint {
  if (
    value.kind === "integer" ||
    value.kind === "signed-integer-64" ||
    value.kind === "float-32" ||
    value.kind === "float-64"
  ) {
    return value.value;
  }

  if (value.kind === "erased") {
    return numeric_example_value(value.value, path);
  }

  if (
    value.kind === "constructor" &&
    value.name.endsWith("duck_entry_result_type") &&
    value.fields.length === 1
  ) {
    const result = value.fields[0];

    if (result === undefined) {
      throw new Error("Gpufuck entry result has no value: " + path);
    }

    return numeric_example_value(result, path);
  }

  throw new Error(
    "Gpufuck example returned " + value.kind + " instead of a number: " +
      path,
  );
}

function runtime_trap(error: unknown): boolean {
  if (error instanceof WebAssembly.RuntimeError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (runtime_trap(error.cause)) {
    return true;
  }

  return error.message.includes("trap") ||
    error.message.includes("runtime fault") ||
    error.message.includes("unreachable");
}

function collect_duck_files(path: string): string[] {
  const files: string[] = [];

  for (const entry of Deno.readDirSync(path)) {
    const child = path + "/" + entry.name;

    if (entry.isDirectory) {
      files.push(...collect_duck_files(child));
      continue;
    }

    if (entry.isFile && entry.name.endsWith(".duck")) {
      files.push(child);
    }
  }

  return files;
}

function collect_corpus_features(path: string): string[] {
  const features: string[] = [];
  const heading = /^={3,}\r?\n([^\r\n]+)\r?\n={3,}$/gm;

  for (const entry of Deno.readDirSync(path)) {
    if (!entry.isFile || !entry.name.endsWith(".txt")) {
      continue;
    }

    const corpus = Deno.readTextFileSync(path + "/" + entry.name);

    for (const match of corpus.matchAll(heading)) {
      const feature = match[1];

      if (feature === undefined) {
        throw new Error("Corpus heading is missing a name: " + entry.name);
      }

      features.push(entry.name + " / " + feature);
    }
  }

  return features;
}

function collect_corpus_node_types(path: string): Set<string> {
  const node_types = new Set<string>();
  const expected_tree = /^---\r?\n([\s\S]*?)(?=^={3,}\r?$|(?![\s\S]))/gm;
  const node = /\(([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const entry of Deno.readDirSync(path)) {
    if (!entry.isFile || !entry.name.endsWith(".txt")) {
      continue;
    }

    const corpus = Deno.readTextFileSync(path + "/" + entry.name);

    for (const tree_match of corpus.matchAll(expected_tree)) {
      const tree = tree_match[1];

      if (tree === undefined) {
        throw new Error(
          "Corpus case is missing an expected tree: " + entry.name,
        );
      }

      for (const node_match of tree.matchAll(node)) {
        const node_type = node_match[1];

        if (node_type === undefined) {
          throw new Error(
            "Corpus tree contains an unnamed node: " + entry.name,
          );
        }

        node_types.add(node_type);
      }
    }
  }

  return node_types;
}

function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
