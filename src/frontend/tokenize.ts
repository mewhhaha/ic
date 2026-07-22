import { expect } from "../expect.ts";
import type { Token, TokenKind } from "./ast.ts";
import { is_digit, is_name_continue, is_name_start } from "./names.ts";
import {
  make_source_syntax,
  type SourcePiece,
  type SourceSyntax,
  type SyntaxDiagnostic,
  type Trivia,
} from "./syntax.ts";

export type TokenizeOptions = {
  comments?: boolean;
};

/**
 * The compiler-facing stream. It deliberately omits trivia, except that line
 * breaks and optional comments retain their historical token representation.
 */
export function tokenize(text: string, options?: TokenizeOptions): Token[] {
  const syntax = scan_source(text);
  const diagnostic = syntax.diagnostics[0];

  if (diagnostic !== undefined) {
    throw new Error(diagnostic.message);
  }

  return source_tokens(syntax, options);
}

export function source_tokens(
  syntax: SourceSyntax,
  options?: TokenizeOptions,
): Token[] {
  const tokens: Token[] = [];

  for (const piece of syntax.pieces) {
    if (piece.tag === "token") {
      tokens.push(piece.token);
    } else if (piece.tag === "trivia" && piece.trivia.kind === "comment") {
      if (options?.comments) {
        tokens.push({
          kind: "comment",
          text: piece.trivia.raw,
          raw: piece.trivia.raw,
          span: piece.trivia.span,
          line: piece.trivia.line,
          column: piece.trivia.column,
        });
      }
    }
  }

  return tokens;
}

/** A lossless, error-tolerant scan suitable for editor-facing consumers. */
export function scan_source(text: string): SourceSyntax {
  const pieces: SourcePiece[] = [];
  const diagnostics: SyntaxDiagnostic[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (): string => {
    const char = text[index];
    expect(char !== undefined, "Missing source character");
    index += 1;

    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }

    return char;
  };

  const add_trivia = (
    kind: Trivia["kind"],
    start: number,
    start_line: number,
    start_column: number,
  ): void => {
    pieces.push({
      tag: "trivia",
      trivia: {
        kind,
        raw: text.slice(start, index),
        span: { start, end: index },
        line: start_line,
        column: start_column,
      },
    });
  };

  const add_token = (
    kind: TokenKind,
    token_text: string,
    start: number,
    start_line: number,
    start_column: number,
  ): void => {
    pieces.push({
      tag: "token",
      token: {
        kind,
        text: token_text,
        raw: text.slice(start, index),
        span: { start, end: index },
        line: start_line,
        column: start_column,
      },
    });
  };

  const add_invalid = (
    start: number,
    start_line: number,
    start_column: number,
    message: string,
  ): void => {
    const span = { start, end: index };
    const diagnostic = { message, span };
    diagnostics.push(diagnostic);
    pieces.push({
      tag: "invalid",
      raw: text.slice(start, index),
      span,
      line: start_line,
      column: start_column,
      diagnostic,
    });
  };

  while (index < text.length) {
    const char = text[index];
    expect(char !== undefined, "Missing source character");
    const start = index;
    const start_line = line;
    const start_column = column;

    if (char === " " || char === "\t" || char === "\r") {
      do {
        advance();
      } while (
        index < text.length &&
        (text[index] === " " || text[index] === "\t" || text[index] === "\r")
      );
      add_trivia("whitespace", start, start_line, start_column);
    } else if (char === "\n") {
      advance();
      add_token("newline", "\n", start, start_line, start_column);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        advance();
      }
      add_trivia("comment", start, start_line, start_column);
    } else if (is_digit(char)) {
      const hexadecimal = char === "0" &&
        (text[index + 1] === "x" || text[index + 1] === "X");
      let floating_point = false;

      if (hexadecimal) {
        advance();
        advance();
        const digit_start = index;

        while (index < text.length && is_hex_digit(text[index] as string)) {
          advance();
        }

        if (index === digit_start) {
          add_invalid(
            start,
            start_line,
            start_column,
            "Hexadecimal literal requires at least one digit",
          );
          continue;
        }
      } else {
        while (index < text.length && is_digit(text[index] as string)) {
          advance();
        }

        if (text[index] === "." && is_digit(text[index + 1] as string)) {
          floating_point = true;
          advance();

          while (index < text.length && is_digit(text[index] as string)) {
            advance();
          }
        }

        if (text[index] === "e" || text[index] === "E") {
          floating_point = true;
          advance();

          if (text[index] === "+" || text[index] === "-") {
            advance();
          }

          const exponent_start = index;

          while (index < text.length && is_digit(text[index] as string)) {
            advance();
          }

          if (index === exponent_start) {
            add_invalid(
              start,
              start_line,
              start_column,
              "Floating-point exponent requires at least one digit",
            );
            continue;
          }
        }
      }

      const fixed_integer_suffix = /^[iu][1-9][0-9]*/.exec(text.slice(index));
      const suffix = text.slice(index, index + 3);

      if (fixed_integer_suffix) {
        for (
          let suffix_index = 0;
          suffix_index < fixed_integer_suffix[0].length;
          suffix_index += 1
        ) {
          advance();
        }
      } else if (
        !hexadecimal && (suffix === "f32" || suffix === "f64")
      ) {
        advance();
        advance();
        advance();
      } else if (floating_point) {
        add_invalid(
          start,
          start_line,
          start_column,
          "Floating-point literal requires an f32 or f64 suffix",
        );
        continue;
      }

      add_token(
        "number",
        text.slice(start, index),
        start,
        start_line,
        start_column,
      );
    } else if (is_name_start(char)) {
      while (index < text.length && is_name_continue(text[index] as string)) {
        advance();
      }
      add_token(
        "name",
        text.slice(start, index),
        start,
        start_line,
        start_column,
      );
    } else if (char === '"' || char === "'") {
      scan_literal(
        char,
        text,
        advance,
        add_token,
        add_invalid,
        start,
        start_line,
        start_column,
        () => index,
      );
    } else {
      if (text.startsWith("..=", index)) {
        advance();
        advance();
        advance();
        add_token("symbol", "..=", start, start_line, start_column);
      } else if (text.startsWith("..", index)) {
        advance();
        advance();
        add_token("symbol", "..", start, start_line, start_column);
      } else if (is_operator_start_character(char)) {
        while (
          index < text.length &&
          is_operator_continuation_character(text[index] as string)
        ) {
          advance();
        }
        add_token(
          "symbol",
          text.slice(start, index),
          start,
          start_line,
          start_column,
        );
      } else if ("{}()[],:..;#@`".includes(char)) {
        advance();
        if (char === ";") {
          add_token("newline", "\n", start, start_line, start_column);
        } else {
          add_token("symbol", char, start, start_line, start_column);
        }
      } else {
        const first = text.charCodeAt(index);
        const second = text.charCodeAt(index + 1);

        if (
          first >= 0xd800 && first <= 0xdbff &&
          second >= 0xdc00 && second <= 0xdfff
        ) {
          advance();
          advance();
        } else {
          advance();
        }

        add_invalid(
          start,
          start_line,
          start_column,
          "Unexpected character: " + text.slice(start, index),
        );
      }
    }
  }

  pieces.push({
    tag: "token",
    token: {
      kind: "eof",
      text: "",
      raw: "",
      span: { start: index, end: index },
      line,
      column,
    },
  });
  return make_source_syntax(text, pieces, diagnostics);
}

function is_operator_start_character(value: string): boolean {
  return ":-!$%&*+/<=>?^|~\\".includes(value);
}

function is_operator_continuation_character(value: string): boolean {
  return value === "." || is_operator_start_character(value);
}

function is_hex_digit(value: string): boolean {
  return is_digit(value) ||
    (value >= "a" && value <= "f") ||
    (value >= "A" && value <= "F");
}

function scan_literal(
  quote: '"' | "'",
  text: string,
  advance: () => string,
  add_token: (
    kind: TokenKind,
    token_text: string,
    start: number,
    line: number,
    column: number,
  ) => void,
  add_invalid: (
    start: number,
    line: number,
    column: number,
    message: string,
  ) => void,
  start: number,
  line: number,
  column: number,
  current_index: () => number,
): void {
  let literal: "string" | "character" = "character";
  if (quote === '"') {
    literal = "string";
  }
  let value = "";
  let problem: string | undefined;
  advance();

  while (current_index() < text.length) {
    const next = text[current_index()];
    expect(next !== undefined, "Missing literal character");

    if (next === quote) {
      advance();
      if (problem !== undefined) {
        add_invalid(start, line, column, problem);
        return;
      }
      if (quote === "'") {
        const scalars = Array.from(value);
        if (scalars.length !== 1) {
          add_invalid(
            start,
            line,
            column,
            "Character literal must contain exactly one Unicode scalar value",
          );
          return;
        }
        const scalar = scalars[0];
        expect(scalar !== undefined, "Missing character literal scalar");
        const code_point = scalar.codePointAt(0);
        expect(
          code_point !== undefined,
          "Missing character literal code point",
        );
        if (code_point >= 0xd800 && code_point <= 0xdfff) {
          add_invalid(
            start,
            line,
            column,
            "Character literal must contain a Unicode scalar value",
          );
          return;
        }
      }
      let kind: TokenKind = "character";
      if (quote === '"') {
        kind = "string";
      }
      add_token(kind, value, start, line, column);
      return;
    }

    if (quote === "'" && (next === "\n" || next === "\r")) {
      add_invalid(start, line, column, "Unterminated character literal");
      return;
    }

    if (next === "\\") {
      advance();
      if (current_index() >= text.length) {
        add_invalid(start, line, column, "Unterminated " + literal + " escape");
        return;
      }
      const escaped = advance();
      const decoded = decode_literal_escape(escaped, quote);
      if (decoded === undefined) {
        if (problem === undefined) {
          problem = "Unsupported " + literal + " escape: \\" + escaped;
        }
      } else {
        value += decoded;
      }
    } else {
      value += advance();
    }
  }

  if (problem !== undefined) {
    add_invalid(start, line, column, problem);
  } else {
    add_invalid(start, line, column, "Unterminated " + literal + " literal");
  }
}

function decode_literal_escape(
  escaped: string,
  quote: '"' | "'",
): string | undefined {
  if (escaped === "n") {
    return "\n";
  }
  if (escaped === "t") {
    return "\t";
  }
  if (escaped === "r") {
    return "\r";
  }
  if (escaped === quote || escaped === "\\") {
    return escaped;
  }
  return undefined;
}
