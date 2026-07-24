import { assert_equals } from "../assert.ts";
import { format_source } from "../frontend/format.ts";
import { Source } from "../frontend.ts";
import { format_text } from "./format.ts";

Deno.test("format_text normalizes spacing around operators", () => {
  assert_equals(
    format_text("let value=1+2*3;\n"),
    "let value = 1 + 2 * 3;\n",
  );
});

Deno.test("format_text keeps unary sigils tight", () => {
  assert_equals(
    format_text("let  measure=( message :Text )=>{\n@len( &message )\n};\n"),
    "let measure = (message: Text) => {\n  @len(&message)\n};\n",
  );
});

Deno.test("format_text uses whitespace for atomic unary calls", () => {
  assert_equals(
    format_text(
      "let direct=func(a);\n" +
        "let spaced=func (a);\n" +
        "let passed=func;\n" +
        "let grouped=func(a+b);\n" +
        "let packed=func(a,b);\n",
    ),
    "let direct = func a;\n" +
      "let spaced = func a;\n" +
      "let passed = func;\n" +
      "let grouped = func(a + b);\n" +
      "let packed = func(a, b);\n",
  );
});

Deno.test("format_text separates prefix operators from fixity assignment", () => {
  assert_equals(
    format_text("prefix 80 ! = @syntax.not\n"),
    "prefix 80 ! = @syntax.not\n",
  );
});

Deno.test("format_text indents blocks by bracket depth", () => {
  assert_equals(
    format_text("for i in 1..5 {\nif i==2 {\nbreak;\n}\n}\n"),
    "for i in 1..5 {\n  if i == 2 {\n    break;\n  }\n}\n",
  );
});

Deno.test("format_text keeps compact guard blocks on one line", () => {
  const source = "for candidate in candidates {\n" +
    "if not(is_utf8_continuation candidate) { break;\n" +
    "}\n" +
    "}\n";
  const formatted = format_text(source);

  assert_equals(
    formatted,
    "for candidate in candidates {\n" +
      "  if not(is_utf8_continuation candidate) { break; }\n" +
      "}\n",
  );
  assert_equals(
    format_source(Source.parse(formatted)),
    format_source(Source.parse(source)),
  );
});

Deno.test("format_text wraps wide definitions before their value", () => {
  const source = "let update = () => {\n" +
    "if has_selection {\n" +
    "let furthest = if selection.anchor\n" +
    "> selection.head " +
    "{ selection.anchor } else { selection.head };\n" +
    "}\n" +
    "};\n";
  const formatted = format_text(source);

  assert_equals(
    formatted,
    "let update = () => {\n" +
      "  if has_selection {\n" +
      "    let furthest =\n" +
      "      if selection.anchor > selection.head " +
      "{ selection.anchor } else { selection.head };\n" +
      "  }\n" +
      "};\n",
  );
  assert_equals(
    format_source(Source.parse(formatted)),
    format_source(Source.parse(source)),
  );
});

Deno.test("format_text indents union alternatives", () => {
  assert_equals(
    format_text("type Option t =\n| `Some t\n| `None Unit\n"),
    "type Option t =\n  | `Some t\n  | `None Unit\n",
  );
});

Deno.test("format_text keeps match alternatives inside their braces", () => {
  assert_equals(
    format_text("match value {\n| `Some item => item\n| `None () => 0\n}\n"),
    "match value {\n  | `Some item => item\n  | `None () => 0\n}\n",
  );
});

Deno.test("format_text preserves comments", () => {
  assert_equals(
    format_text("//header\nlet value = 1; //trailing\n"),
    "// header\nlet value = 1; // trailing\n",
  );
});

Deno.test("format_text collapses blank runs", () => {
  assert_equals(
    format_text("\n\nlet a = 1;\n\n\n\nlet b = 2;\n\n"),
    "let a = 1;\n\nlet b = 2;\n",
  );
});

Deno.test("format_text drops blanks hugging braces", () => {
  assert_equals(
    format_text("let f = () => {\n\nlet a = 1;\na\n\n};\n"),
    "let f = () => {\n  let a = 1;\n  a\n};\n",
  );
});

Deno.test("format_text keeps effect rows tight", () => {
  assert_equals(
    format_text("let echo: () -> < Stdin :|Stdout > Text = () => {\n1\n};\n"),
    "let echo: () -> <Stdin :| Stdout> Text = () => {\n  1\n};\n",
  );
});

Deno.test("format_text preserves fixed array separators", () => {
  assert_equals(
    format_text(
      "type Pixels=[Int;2]\nlet pixels=[20;2];\nlet pack:(Int;2)=(1,2);\n",
    ),
    "type Pixels = [Int; 2]\nlet pixels = [20; 2];\n" +
      "let pack: (Int; 2) = (1, 2);\n",
  );
});

Deno.test("format_text distinguishes product arguments from indexes", () => {
  assert_equals(
    format_text("let projected=value[0];\nlet built=Point.make [1,2];\n"),
    "let projected = value[0];\nlet built = Point.make [1, 2];\n",
  );
});

Deno.test("format_text preserves the empty Bytes value", () => {
  assert_equals(
    format_text("let bytes:Bytes=Bytes.empty;\n"),
    "let bytes: Bytes = Bytes.empty;\n",
  );
});

Deno.test("format_text canonicalizes string escapes", () => {
  assert_equals(
    format_text('let message = "line\\none";\n'),
    'let message = "line\\none";\n',
  );
});

Deno.test("format_text indents multiline binding values", () => {
  assert_equals(
    format_text("let apply: Int -> Int =\n(value: Int) => {\nvalue\n};\n"),
    "let apply: Int -> Int =\n  (value: Int) => {\n    value\n  };\n",
  );
});

Deno.test("format_text composes wide products vertically", () => {
  const source = "let settings = " +
    "[.foreground_color = foreground_color, " +
    ".background_color = background_color, " +
    ".selection_color = selection_color];\n";
  const formatted = format_text(source);

  assert_equals(
    formatted,
    "let settings = [\n" +
      "  .foreground_color = foreground_color,\n" +
      "  .background_color = background_color,\n" +
      "  .selection_color = selection_color,\n" +
      "];\n",
  );

  for (const line of formatted.split("\n")) {
    assert_equals(line.length <= 100, true);
  }

  assert_equals(
    format_source(Source.parse(formatted)),
    format_source(Source.parse(source)),
  );
});

Deno.test("format_text composes a wide grouped expression vertically", () => {
  assert_equals(
    format_text(
      "let selected = choose(" +
        "very_long_foreground_configuration_with_platform_overrides + " +
        "additional_configuration_defaults);\n",
    ),
    "let selected = choose(\n" +
      "  very_long_foreground_configuration_with_platform_overrides + " +
      "additional_configuration_defaults\n" +
      ");\n",
  );
});

Deno.test("format_text only wraps expressions at parseable continuations", () => {
  const source = "let valid = first_really_long_condition_name == 1 && " +
    "second_really_long_condition_name == 2 && " +
    "third_really_long_condition_name == 3;\n";
  const formatted = format_text(source);

  assert_equals(
    format_source(Source.parse(formatted)),
    format_source(Source.parse(source)),
  );
  assert_equals(formatted.includes("\n  && "), true);
});

Deno.test("format_text preserves every bundled prelude", async () => {
  const paths: string[] = [];

  for await (const entry of Deno.readDir("src/frontend")) {
    if (entry.isFile && /^prelude.*\.duck$/.test(entry.name)) {
      paths.push("src/frontend/" + entry.name);
    }
  }

  paths.sort();

  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const formatted = format_text(source);
    assert_equals(
      format_source(Source.parse(formatted)),
      format_source(Source.parse(source)),
      "format_text changed the parse of " + path,
    );
  }
});

Deno.test("format_text preserves the examples and editor case study", async () => {
  const roots = ["examples"];
  const files: string[] = [];

  while (roots.length > 0) {
    const root = roots.pop();

    if (root === undefined) {
      continue;
    }

    for await (const entry of Deno.readDir(root)) {
      const path = root + "/" + entry.name;

      if (entry.isDirectory) {
        roots.push(path);
      } else if (entry.name.endsWith(".duck")) {
        files.push(path);
      }
    }
  }

  files.sort();
  files.push("case-studies/editor/editor.duck");
  assert_equals(files.length > 0, true);

  for (const path of files) {
    const text = await Deno.readTextFile(path);
    const formatted = format_text(text);
    assert_equals(
      format_text(formatted),
      formatted,
      "format_text is not idempotent for " + path,
    );

    let original;

    try {
      original = Source.parse(text);
    } catch {
      // Examples that do not parse today are out of formatting scope.
      continue;
    }

    const reparsed = Source.parse(formatted);
    assert_equals(
      format_source(reparsed),
      format_source(original),
      "format_text changed the parse of " + path,
    );
  }
});
