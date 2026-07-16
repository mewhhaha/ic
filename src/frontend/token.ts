import type { SourceSpan } from "../source_span.ts";

export type TokenKind =
  | "name"
  | "number"
  | "string"
  | "character"
  | "symbol"
  | "newline"
  | "comment"
  | "eof";

export type Token = {
  kind: TokenKind;
  text: string;
  /** Exact source spelling, including quotes and escapes for literals. */
  raw: string;
  /** UTF-16 source offsets, with an exclusive end. */
  span: SourceSpan;
  line: number;
  column: number;
};
