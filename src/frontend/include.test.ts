import { assert_equals, assert_throws } from "../assert.ts";
import { resolve_source_imports } from "./load.ts";
import { parse_source } from "./parser.ts";
import { Source } from "./source.ts";

Deno.test("include resolves relative text before compile-time evaluation", () => {
  const text = [
    "const byte_length = text => @len(text)",
    'const size = comptime byte_length(include "./config.json")',
    "size",
  ].join("\n");
  const source = resolve_source_imports(
    parse_source(text),
    "file:///project/main.duck",
    (uri) => {
      if (uri === "file:///project/config.json") {
        return '{"answer":42}';
      }

      return undefined;
    },
  );
  const binding = source.statements[1];

  if (binding?.tag !== "bind" || binding.value.tag !== "comptime") {
    throw new Error("Expected compile-time include consumer");
  }

  const call = binding.value.expr;
  if (call.tag !== "app") {
    throw new Error("Expected compile-time parser call");
  }

  assert_equals(call.args[0], { tag: "text", value: '{"answer":42}' });
  assert_equals(Source.ic_wat(source).includes("i32.const 13"), true);
});

Deno.test("include feeds a typed compile-time parser result", () => {
  const source = resolve_source_imports(
    parse_source(`
const { struct } = import "duck:prelude" ()
type Config = struct {.length = I32}
const parse_config: Text -> Config = text => [.length = @len(text)]
const config = comptime parse_config(include "./config.json")

config.length + @describe_type(@type_of(config)).size
`),
    "file:///project/main.duck",
    (uri) => {
      if (uri === "file:///project/config.json") {
        return '{"answer":42}';
      }

      return undefined;
    },
  );
  const wat = Source.wat(source);

  assert_equals(wat.includes("i32.const 13"), true);
  assert_equals(wat.includes("i32.const 4"), true);
  assert_equals(wat.includes("i32.add"), true);
});

Deno.test("include reports the unresolved relative path", () => {
  assert_throws(
    () =>
      resolve_source_imports(
        parse_source('const config = include "./missing.json"\nconfig'),
        "file:///project/main.duck",
        () => undefined,
      ),
    "Include dependency does not exist: ./missing.json",
  );
});

Deno.test("include requires file context", () => {
  assert_throws(
    () =>
      Source.ic_wat(
        'const size = comptime @len(include "./config.json")\nsize',
      ),
    "include requires source file context; use a file-loading compiler API",
  );
});

Deno.test("source analysis reports a missing included file", () => {
  const text = 'const config = include "./missing.json"\nconfig';
  const analysis = Source.analyze(text, {
    uri: "file:///project/main.duck",
    resolve_import: () => undefined,
  });

  assert_equals(
    analysis.diagnostics[0]?.message,
    "Include dependency does not exist: ./missing.json",
  );
});

Deno.test("source analysis requires include resolution context", () => {
  const analysis = Source.analyze(
    'const config = include "./config.json"\nconfig',
  );

  assert_equals(
    analysis.diagnostics[0]?.message,
    "Cannot resolve include without a source URI and import resolver",
  );
});
