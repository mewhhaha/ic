import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import { validate_source_imports } from "./import_diagnostic.ts";
import { parse_source } from "./parser.ts";

Deno.test("Source.analyze reports a nested import failure at the root expression", () => {
  const sources = new Map<string, string>([
    [
      "file:///dep.ix",
      'module () where\nconst load = () => import "./missing.ix"\nreturn { load }',
    ],
  ]);
  const text = 'const dependency = import "./dep.ix"\ndependency';
  const analysis = Source.analyze(text, {
    uri: "file:///main.ix",
    resolve_import: (uri) => sources.get(uri),
  });
  const diagnostic = analysis.diagnostics.find((entry) =>
    entry.code === "IX2502"
  );

  if (diagnostic === undefined) {
    throw new Error("Missing nested import diagnostic");
  }

  assert_equals(
    diagnostic.message,
    "Import dependency does not exist: ./missing.ix",
  );
  assert_equals(
    text.slice(diagnostic.span.start, diagnostic.span.end),
    'import "./dep.ix"',
  );
});

Deno.test("Source.analyze diagnoses cycles reached through closure bodies", () => {
  const main = 'const dependency = import "./dep.ix"\ndependency';
  const sources = new Map<string, string>([
    [
      "file:///main.ix",
      main,
    ],
    [
      "file:///dep.ix",
      'module () where\nconst load = () => import "./main.ix"\nreturn { load }',
    ],
  ]);
  const analysis = Source.analyze(main, {
    uri: "file:///main.ix",
    resolve_import: (uri) => sources.get(uri),
  });
  const diagnostic = analysis.diagnostics.find((entry) =>
    entry.code === "IX2504"
  );

  if (diagnostic === undefined) {
    throw new Error("Missing circular import diagnostic");
  }

  assert_equals(
    main.slice(diagnostic.span.start, diagnostic.span.end),
    'import "./dep.ix"',
  );
});

Deno.test("import validation skips a statically eliminated branch", () => {
  const source = parse_source(
    'const dependency = if false { import "./missing.ix" } else { import "./dep.ix" }\ndependency',
  );
  const sources = new Map<string, string>([
    ["file:///dep.ix", "module () where\nreturn {}"],
  ]);

  assert_equals(
    validate_source_imports(
      source,
      "file:///main.ix",
      (uri) => sources.get(uri),
    ),
    [],
  );
});

Deno.test("Source.analyze reports imports without URI resolution context", () => {
  const analysis = Source.analyze(
    'const dependency = import "./dep.ix"\ndependency',
  );
  const diagnostic = analysis.diagnostics.find((entry) =>
    entry.code === "IX2500"
  );

  if (diagnostic === undefined) {
    throw new Error("Missing import context diagnostic");
  }

  assert_equals(
    diagnostic.message,
    "Cannot resolve import without a source URI and import resolver",
  );
});
