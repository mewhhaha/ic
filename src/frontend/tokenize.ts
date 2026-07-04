import { expect } from "../expect.ts";
import type { Token } from "./ast.ts";
import { is_digit, is_name_continue, is_name_start } from "./names.ts";

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  while (index < text.length) {
    const char = text[index];
    expect(char, "Missing source character");

    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      column += 1;
    } else if (char === "\n") {
      tokens.push({ kind: "newline", text: "\n", line, column });
      index += 1;
      line += 1;
      column = 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
        column += 1;
      }
    } else if (is_digit(char)) {
      const start = index;
      const start_column = column;

      while (index < text.length) {
        const next = text[index];
        expect(next, "Missing number character");

        if (!is_digit(next)) {
          break;
        }

        index += 1;
        column += 1;
      }

      const suffix = text.slice(index, index + 3);

      if (suffix === "i32" || suffix === "i64") {
        index += 3;
        column += 3;
      }

      tokens.push({
        kind: "number",
        text: text.slice(start, index),
        line,
        column: start_column,
      });
    } else if (is_name_start(char)) {
      const start = index;
      const start_column = column;

      while (index < text.length) {
        const next = text[index];
        expect(next, "Missing name character");

        if (!is_name_continue(next)) {
          break;
        }

        index += 1;
        column += 1;
      }

      tokens.push({
        kind: "name",
        text: text.slice(start, index),
        line,
        column: start_column,
      });
    } else if (char === '"') {
      const start_column = column;
      index += 1;
      column += 1;
      let value = "";

      while (index < text.length) {
        const next = text[index];
        expect(next, "Missing string character");

        if (next === '"') {
          break;
        }

        if (next === "\\") {
          const escaped = text[index + 1];
          expect(escaped, "Unterminated string escape");

          if (escaped === "n") {
            value += "\n";
          } else if (escaped === "t") {
            value += "\t";
          } else if (escaped === "r") {
            value += "\r";
          } else if (escaped === '"' || escaped === "\\") {
            value += escaped;
          } else {
            throw new Error("Unsupported string escape: \\" + escaped);
          }

          index += 2;
          column += 2;
        } else {
          value += next;
          index += 1;
          column += 1;
        }
      }

      expect(text[index] === '"', "Unterminated string literal");
      index += 1;
      column += 1;
      tokens.push({ kind: "string", text: value, line, column: start_column });
    } else {
      const start_column = column;
      const two = text.slice(index, index + 2);

      if (
        two === "=>" || two === ":=" || two === "==" || two === ".." ||
        two === "!=" || two === "<=" || two === ">=" || two === "&&" ||
        two === "||"
      ) {
        tokens.push({ kind: "symbol", text: two, line, column: start_column });
        index += 2;
        column += 2;
      } else if ("{}()[],:.+-*%=/!<>.;".includes(char)) {
        if (char === ";") {
          tokens.push({ kind: "newline", text: "\n", line, column });
        } else {
          tokens.push({ kind: "symbol", text: char, line, column });
        }

        index += 1;
        column += 1;
      } else {
        throw new Error("Unexpected character: " + char);
      }
    }
  }

  tokens.push({ kind: "eof", text: "", line, column });
  return tokens;
}
