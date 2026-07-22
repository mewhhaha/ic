import { assert_equals, assert_throws } from "../assert.ts";
import {
  derive_source_span,
  has_concrete_source_span,
  inherit_source_span,
  make_source_syntax,
  mark_source_span,
  mark_source_syntax,
  source_span,
  source_span_origin,
  source_syntax,
} from "./syntax.ts";
import { scan_source, tokenize } from "./tokenize.ts";

function reconstruct(text: string): string {
  const syntax = scan_source(text);
  let result = "";

  for (const piece of syntax.pieces) {
    if (piece.tag === "trivia") {
      result += piece.trivia.raw;
    } else if (piece.tag === "token") {
      result += piece.token.raw;
    } else {
      result += piece.raw;
    }
  }

  return result;
}

Deno.test("lossless scanner preserves trivia, literals, semicolons, and CRLF", () => {
  const text = "let x = \"a\\n😀\";\r\n\t// note\r\n'x'";
  const syntax = scan_source(text);

  assert_equals(reconstruct(text), text);
  assert_equals(syntax.diagnostics, []);
  const tokens = syntax.pieces.filter((piece) => piece.tag === "token").map((
    piece,
  ) => piece.token);
  assert_equals(tokens[3], {
    kind: "string",
    text: "a\n😀",
    raw: '"a\\n😀"',
    span: { start: 8, end: 15 },
    line: 1,
    column: 9,
  });
  assert_equals(tokens[4]?.kind, "newline");
  assert_equals(tokens[4]?.raw, ";");
  assert_equals(tokens[5]?.line, 1);
  const comment = syntax.pieces.find(
    (piece) => piece.tag === "trivia" && piece.trivia.kind === "comment",
  );
  let comment_raw: string | undefined;
  if (comment !== undefined && comment.tag === "trivia") {
    comment_raw = comment.trivia.raw;
  }
  assert_equals(comment_raw, "// note\r");
  assert_equals(tokens[8]?.span, { start: text.length, end: text.length });
  assert_equals(syntax.position_at(17), { line: 1, column: 18 });
  assert_equals(syntax.position_at(text.length), { line: 3, column: 4 });
});

Deno.test("strict tokenize retains its filtered stream and comment option", () => {
  const text = "a // note\n b;";
  assert_equals(
    tokenize(text).map((token) => [token.kind, token.text]),
    [["name", "a"], ["newline", "\n"], ["name", "b"], ["newline", "\n"], [
      "eof",
      "",
    ]],
  );
  assert_equals(
    tokenize(text, { comments: true }).map((token) => [token.kind, token.text]),
    [["name", "a"], ["comment", "// note"], ["newline", "\n"], ["name", "b"], [
      "newline",
      "\n",
    ], ["eof", ""]],
  );
  assert_throws(() => tokenize("§"), "Unexpected character: §");
  assert_throws(() => tokenize('"\\q"'), "Unsupported string escape: \\q");
});

Deno.test("scanner keeps category operators as single symbols", () => {
  assert_equals(
    tokenize("a &&& b ||| c :+ d :- e :& f :| g :> h").map((token) =>
      token.text
    ),
    [
      "a",
      "&&&",
      "b",
      "|||",
      "c",
      ":+",
      "d",
      ":-",
      "e",
      ":&",
      "f",
      ":|",
      "g",
      ":>",
      "h",
      "",
    ],
  );
});

Deno.test("scanner keeps inclusive range bounds as one symbol", () => {
  assert_equals(
    tokenize("0..=limit").map((token) => token.text),
    ["0", "..=", "limit", ""],
  );
});

Deno.test("tolerant scanner reports malformed input without dropping it", () => {
  const text = "§ \"\\q\" 'ab'";
  const syntax = scan_source(text);

  assert_equals(reconstruct(text), text);
  assert_equals(syntax.diagnostics.map((diagnostic) => diagnostic.message), [
    "Unexpected character: §",
    "Unsupported string escape: \\q",
    "Character literal must contain exactly one Unicode scalar value",
  ]);
  assert_equals(
    syntax.pieces.filter((piece) => piece.tag === "invalid").length,
    3,
  );
  const first_piece = syntax.pieces[0];
  let first_span: { start: number; end: number } | undefined;
  if (first_piece !== undefined && first_piece.tag === "invalid") {
    first_span = first_piece.span;
  }
  assert_equals(first_span, { start: 0, end: 1 });
  const final_piece = syntax.pieces.at(-1);
  let final_kind: string | undefined;
  if (final_piece !== undefined && final_piece.tag === "token") {
    final_kind = final_piece.token.kind;
  }
  assert_equals(final_kind, "eof");
});

Deno.test("tolerant scanner reports one diagnostic per invalid Unicode scalar", () => {
  const text = "😀\n";
  const syntax = scan_source(text);

  assert_equals(reconstruct(text), text);
  assert_equals(syntax.diagnostics, [{
    message: "Unexpected character: 😀",
    span: { start: 0, end: 2 },
  }]);
});

Deno.test("source metadata registries distinguish concrete and derived spans", () => {
  const root = {};
  const child = {};
  const grandchild = {};
  const syntax = make_source_syntax("abc", [], []);

  assert_throws(() => source_span(root), "Missing source span");
  assert_throws(() => source_syntax(root), "Missing source syntax");
  mark_source_span(root, { start: 0, end: 3 });
  inherit_source_span(child, root);
  derive_source_span(grandchild, { start: 1, end: 2 });
  mark_source_syntax(root, syntax);

  assert_equals(source_span(root), { start: 0, end: 3 });
  assert_equals(source_span(child), { start: 0, end: 3 });
  assert_equals(source_span_origin(root), "concrete");
  assert_equals(source_span_origin(child), "derived");
  assert_equals(has_concrete_source_span(root), true);
  assert_equals(has_concrete_source_span(grandchild), false);
  assert_equals(source_syntax(root), syntax);
  assert_throws(
    () => syntax.position_at(4),
    "Source offset is beyond source text",
  );
});
