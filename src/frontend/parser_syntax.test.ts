import { assert_equals } from "../assert.ts";
import { parse_source, parse_source_with_diagnostics } from "./parser.ts";
import { source_span, source_span_origin, source_syntax } from "./syntax.ts";

Deno.test("tolerant parser keeps later top-level statements after failures", () => {
  const parsed = parse_source_with_diagnostics(
    "let = 1\nlet = 2\nlet = 3\nlet valid = 4\n",
  );

  assert_equals(parsed.diagnostics.length, 3);
  assert_equals(parsed.source.statements, [{
    tag: "bind",
    kind: "let",
    name: "valid",
    is_recursive: false,
    is_linear: false,
    annotation: undefined,
    pattern: {
      tag: "binding",
      name: "valid",
      mode: "default",
      annotation: undefined,
    },
    value: { tag: "num", type: "i32", value: 4 },
  }]);
  assert_equals(source_syntax(parsed.source), parsed.syntax);
  assert_equals(source_span(parsed.source), { start: 0, end: 38 });
});

Deno.test("tolerant parser recovers statements inside blocks", () => {
  const parsed = parse_source_with_diagnostics(
    "let value = {\nlet = 1\nlet kept = 2\n}\nlet after = 3\n",
  );

  assert_equals(parsed.diagnostics.length, 1);
  assert_equals(parsed.source.statements.length, 2);
  const first = parsed.source.statements[0];
  if (first === undefined) throw new Error("Missing first statement");
  if (first.tag !== "bind") throw new Error("Expected binding statement");
  if (first.value.tag !== "block") throw new Error("Expected block value");
  assert_equals(first.value.statements.length, 1);
});

Deno.test("tolerant parser recovers after an aggregate item failure", () => {
  const parsed = parse_source_with_diagnostics(
    "let broken = [1,, 2]\nlet valid = 3\n",
  );

  assert_equals(parsed.diagnostics.length, 1);
  assert_equals(parsed.source.statements.length, 1);
  const statement = parsed.source.statements[0];
  if (statement === undefined || statement.tag !== "bind") {
    throw new Error("Missing recovered binding");
  }
  assert_equals(statement.name, "valid");
});

Deno.test("recovery abandons a missing delimiter at a strong statement", () => {
  const parsed = parse_source_with_diagnostics(
    "type Pair = [\ntype Pair = Int\nlet valid = 1\n",
  );

  assert_equals(parsed.diagnostics.length, 1);
  assert_equals(parsed.source.declarations?.length, 1);
  const declaration = parsed.source.declarations?.[0];

  if (
    declaration === undefined || declaration.tag === "extend" ||
    declaration.tag === "fixity"
  ) {
    throw new Error("Missing recovered Pair declaration");
  }

  assert_equals(declaration.name, "Pair");
  assert_equals(parsed.source.statements.length, 1);
});

Deno.test("scanner and parser diagnostics remain in source order", () => {
  const parsed = parse_source_with_diagnostics(
    "let = 1\n§\nlet valid = 2\n",
  );

  assert_equals(
    parsed.diagnostics.map((diagnostic) => diagnostic.span.start),
    [4, 8],
  );
  assert_equals(parsed.source.statements.length, 1);
});

Deno.test("recovery makes progress past an unmatched closing brace", () => {
  const parsed = parse_source_with_diagnostics("}\nlet valid = 1\n");

  assert_equals(parsed.diagnostics.length, 1);
  assert_equals(parsed.source.statements.length, 1);
});

Deno.test("parser supplies spans for every reachable AST object", () => {
  const parsed = parse_source_with_diagnostics("let value = if true { 1 }\n");
  const seen = new WeakSet<object>();

  const visit = (value: object): void => {
    if (seen.has(value)) return;
    seen.add(value);
    source_span(value);

    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const entry of child) {
            if (entry !== null && typeof entry === "object") visit(entry);
          }
        } else {
          visit(child);
        }
      }
    }
  };

  visit(parsed.source);
  const statement = parsed.source.statements[0];
  if (statement === undefined) throw new Error("Missing statement");
  assert_equals(source_span_origin(statement), "concrete");
});

Deno.test("strict and tolerant parsing share syntax and concrete source spans", () => {
  const text =
    "type Pair = struct {.left = Int, .right = Int}\nlet value = 1 + 2\n";
  const strict = parse_source(text);
  const tolerant = parse_source_with_diagnostics(text);

  assert_equals(strict, tolerant.source);
  assert_equals(source_syntax(strict).text, text);
  assert_equals(source_syntax(tolerant.source).text, text);

  const declaration = strict.declarations?.[0];
  const statement = strict.statements[0];
  if (declaration === undefined) throw new Error("Missing declaration");
  if (statement === undefined) throw new Error("Missing statement");
  if (statement.tag !== "bind") throw new Error("Expected binding");
  if (statement.value.tag !== "prim") throw new Error("Expected primitive");

  assert_equals(
    text.slice(source_span(declaration).start, source_span(declaration).end),
    "type Pair = struct {.left = Int, .right = Int}",
  );
  assert_equals(
    text.slice(source_span(statement).start, source_span(statement).end),
    "let value = 1 + 2",
  );
  assert_equals(
    text.slice(
      source_span(statement.value.left).start,
      source_span(statement.value.left).end,
    ),
    "1",
  );
  assert_equals(source_span_origin(statement.value.left), "concrete");
});

Deno.test("synthetic conditional defaults retain derived spans", () => {
  const parsed = parse_source_with_diagnostics("let value = if true { 1 }\n");
  const statement = parsed.source.statements[0];
  if (statement === undefined || statement.tag !== "bind") {
    throw new Error("Missing conditional binding");
  }
  if (statement.value.tag !== "if") throw new Error("Missing conditional");
  assert_equals(source_span_origin(statement.value.else_branch), "derived");
});

Deno.test("transparent parentheses preserve the inner expression span", () => {
  const text = "let value = ((item))\n";
  const source = parse_source(text);
  const statement = source.statements[0];

  if (statement === undefined || statement.tag !== "bind") {
    throw new Error("Missing parenthesized binding");
  }

  assert_equals(source_span_origin(statement.value), "concrete");
  const span = source_span(statement.value);
  assert_equals(text.slice(span.start, span.end), "item");
});

Deno.test("declaration members retain exact concrete spans", () => {
  const text = [
    "type Pair = struct {.left = Int, .right = Int}",
    "type Maybe = | `Some Int | `None Unit",
    "declare effect Io { write: (&Text, I32) => #Text }",
    "",
  ].join("\n");
  const source = parse_source(text);
  const pair = source.declarations?.[0];
  const maybe = source.declarations?.[1];
  const effect = source.declarations?.[2];

  if (pair === undefined || pair.tag !== "type") {
    throw new Error("Missing product declaration");
  }
  if (pair.body.tag !== "product") throw new Error("Missing product body");
  if (maybe === undefined || maybe.tag !== "type") {
    throw new Error("Missing sum declaration");
  }
  if (maybe.body.tag !== "sum") throw new Error("Missing sum body");
  if (effect === undefined || effect.tag !== "effect") {
    throw new Error("Missing effect declaration");
  }

  assert_concrete_slice(text, pair.body.fields[0], ".left = Int");
  assert_concrete_slice(text, pair.body.fields[1], ".right = Int");
  assert_concrete_slice(text, maybe.body.cases[0], "`Some Int");
  assert_concrete_slice(text, maybe.body.cases[1], "`None Unit");
  const operation = effect.operations[0];
  if (operation === undefined) throw new Error("Missing effect operation");
  assert_concrete_slice(text, operation.params[0], "&Text");
  assert_concrete_slice(text, operation.params[1], "I32");
  assert_concrete_slice(text, operation.result, "#Text");
});

Deno.test("source-written aggregate and handler children retain exact spans", () => {
  const text = [
    "effect Counter { get: () => I32 }",
    "let make = value => [.result = value]",
    "let counter = Counter {",
    "  get: (!resume) => !resume(0),",
    "  return: value => value,",
    "}",
    "return { .result = make(1) }",
    "",
  ].join("\n");
  const source = parse_source(text);
  const make = source.statements[0];
  const counter = source.statements[1];
  const returned = source.statements[2];

  if (make === undefined || make.tag !== "bind" || make.value.tag !== "lam") {
    throw new Error("Missing object-returning closure");
  }
  if (make.value.body.tag !== "product") {
    throw new Error("Missing closure product body");
  }
  if (
    counter === undefined || counter.tag !== "bind" ||
    counter.value.tag !== "handler"
  ) {
    throw new Error("Missing handler binding");
  }
  if (returned === undefined || returned.tag !== "return") {
    throw new Error("Missing record return");
  }

  assert_concrete_slice(text, make.value.body, "[.result = value]");
  assert_concrete_slice(
    text,
    counter.value.clauses[0],
    "get: (!resume) => !resume(0)",
  );
  assert_concrete_slice(
    text,
    counter.value.return_clause,
    "return: value => value",
  );
  assert_concrete_slice(text, returned.value, "{ .result = make(1) }");
});

Deno.test("all parseable examples have bounded contained spans", async () => {
  const paths: string[] = [];
  await collect_duck_files("examples", paths);

  for (const path of paths) {
    const text = await Deno.readTextFile(path);
    let source;

    try {
      source = parse_source(text);
    } catch {
      continue;
    }

    const seen = new WeakSet<object>();
    const visit = (
      value: object,
      parent: { start: number; end: number },
    ): void => {
      if (seen.has(value)) return;
      seen.add(value);
      const span = source_span(value);

      if (span.start < parent.start || span.end > parent.end) {
        throw new Error("Span escapes parent in " + path);
      }

      for (const child of Object.values(value)) {
        if (child !== null && typeof child === "object") {
          if (Array.isArray(child)) {
            for (const entry of child) {
              if (entry !== null && typeof entry === "object") {
                visit(entry, span);
              }
            }
          } else {
            visit(child, span);
          }
        }
      }
    };

    visit(source, { start: 0, end: text.length });
  }
});

async function collect_duck_files(
  directory: string,
  paths: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = directory + "/" + entry.name;

    if (entry.isDirectory) {
      await collect_duck_files(path, paths);
    } else if (entry.isFile && entry.name.endsWith(".duck")) {
      paths.push(path);
    }
  }
}

function assert_concrete_slice(
  text: string,
  value: object | undefined,
  expected: string,
): void {
  if (value === undefined) {
    throw new Error("Missing source-backed declaration member");
  }

  assert_equals(source_span_origin(value), "concrete");
  const span = source_span(value);
  assert_equals(text.slice(span.start, span.end), expected);
}
