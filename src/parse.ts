import { expect } from "./expect.ts";
import { Surface, type Surface as SurfaceNode, type Term } from "./surface.ts";
import type { Mod as ModNode } from "./mod.ts";
import { Prim, type Prim as PrimNode } from "./op.ts";
import type { Emit, Parse } from "./trait.ts";

type TokenKind =
  | "ident"
  | "num"
  | "let"
  | "export"
  | "fn"
  | "arrow"
  | "plus"
  | "minus"
  | "star"
  | "eq"
  | "semi"
  | "comma"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "amp"
  | "eof";

type Token = {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
};

export type Source = string;

export function Source() {}

Source.lex = function lex(source: Source): Token[] {
  const lexer = new Lexer(source);
  return lexer.lex();
};

Source.parse = function parse(source: Source): SurfaceNode {
  const parser = new Parser(Source.lex(source));
  return parser.parseSurface();
};

Source.emit = function emit(source: Source): ModNode {
  return Surface.emit(Source.parse(source));
};

Source satisfies Parse<Source, SurfaceNode> & Emit<Source, ModNode>;

class Lexer {
  private index = 0;
  private line = 1;
  private column = 1;

  constructor(private source: string) {}

  lex(): Token[] {
    const tokens: Token[] = [];

    while (!this.done()) {
      this.skipIgnored();

      if (this.done()) {
        break;
      }

      const char = this.peek();
      expect(char, "Missing source character");

      if (isDigit(char)) {
        tokens.push(this.number());
      } else if (isIdentStart(char)) {
        tokens.push(this.ident());
      } else {
        tokens.push(this.symbol());
      }
    }

    tokens.push({
      kind: "eof",
      text: "",
      line: this.line,
      column: this.column,
    });
    return tokens;
  }

  private skipIgnored(): void {
    while (!this.done()) {
      const char = this.peek();

      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        this.advance();
      } else if (char === "/" && this.peekNext() === "/") {
        this.skipLineComment();
      } else {
        return;
      }
    }
  }

  private skipLineComment(): void {
    while (!this.done()) {
      const char = this.peek();
      this.advance();

      if (char === "\n") {
        return;
      }
    }
  }

  private number(): Token {
    const line = this.line;
    const column = this.column;
    let text = "";

    while (!this.done()) {
      const char = this.peek();
      expect(char, "Missing number character");

      if (!isDigit(char)) {
        break;
      }

      text += this.advance();
    }

    while (!this.done()) {
      const char = this.peek();
      expect(char, "Missing number suffix character");

      if (!isIdentPart(char)) {
        break;
      }

      text += this.advance();
    }

    return { kind: "num", text, line, column };
  }

  private ident(): Token {
    const line = this.line;
    const column = this.column;
    let text = "";

    while (!this.done()) {
      const char = this.peek();
      expect(char, "Missing identifier character");

      if (!isIdentPart(char) && char !== ".") {
        break;
      }

      text += this.advance();
    }

    if (text === "let") {
      return { kind: "let", text, line, column };
    }

    if (text === "export") {
      return { kind: "export", text, line, column };
    }

    if (text === "fn") {
      return { kind: "fn", text, line, column };
    }

    return { kind: "ident", text, line, column };
  }

  private symbol(): Token {
    const line = this.line;
    const column = this.column;
    const char = this.advance();

    if (char === "=" && this.peek() === ">") {
      this.advance();
      return { kind: "arrow", text: "=>", line, column };
    }

    if (char === "+") {
      return { kind: "plus", text: char, line, column };
    }

    if (char === "-") {
      return { kind: "minus", text: char, line, column };
    }

    if (char === "*") {
      return { kind: "star", text: char, line, column };
    }

    if (char === "=") {
      return { kind: "eq", text: char, line, column };
    }

    if (char === ";") {
      return { kind: "semi", text: char, line, column };
    }

    if (char === ",") {
      return { kind: "comma", text: char, line, column };
    }

    if (char === "(") {
      return { kind: "lparen", text: char, line, column };
    }

    if (char === ")") {
      return { kind: "rparen", text: char, line, column };
    }

    if (char === "{") {
      return { kind: "lbrace", text: char, line, column };
    }

    if (char === "}") {
      return { kind: "rbrace", text: char, line, column };
    }

    if (char === "&") {
      return { kind: "amp", text: char, line, column };
    }

    throw new Error(
      "Unexpected character " + char + " at " + line + ":" + column,
    );
  }

  private advance(): string {
    const char = this.source[this.index];
    expect(char, "Cannot advance past end of input");
    this.index += 1;

    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }

    return char;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private peekNext(): string | undefined {
    return this.source[this.index + 1];
  }

  private done(): boolean {
    return this.index >= this.source.length;
  }
}

class Parser {
  private index = 0;

  constructor(private tokens: Token[]) {}

  parseSurface(): SurfaceNode {
    const statements: SurfaceNode["statements"] = [];

    while (!this.check("eof")) {
      statements.push(this.statement());
    }

    this.consume("eof", "Expected end of input");
    return { statements };
  }

  private statement(): SurfaceNode["statements"][number] {
    if (this.match("export")) {
      if (this.match("let")) {
        const name = this.consume("ident", "Expected exported let name");
        this.consume("eq", "Expected = after exported let name");
        const value = this.expr();
        this.consume("semi", "Expected ; after exported let");
        return { tag: "let", name: name.text, value, exported: true };
      }

      const name = this.consume("ident", "Expected export name");
      this.consume("eq", "Expected = after export name");
      const value = this.expr();
      this.consume("semi", "Expected ; after exported expression");
      return { tag: "expr", value, exportedAs: name.text };
    }

    if (this.match("let")) {
      const name = this.consume("ident", "Expected let name");
      this.consume("eq", "Expected = after let name");
      const value = this.expr();
      this.consume("semi", "Expected ; after let");
      return { tag: "let", name: name.text, value };
    }

    const value = this.expr();
    this.consume("semi", "Expected ; after expression");
    return { tag: "expr", value };
  }

  private expr(): Term {
    return this.letExpr();
  }

  private letExpr(): Term {
    if (this.match("let")) {
      const name = this.consume("ident", "Expected let expression name");
      this.consume("eq", "Expected = after let expression name");
      const value = this.expr();
      this.consume("semi", "Expected ; after let expression value");
      const body = this.expr();
      return { tag: "let", name: name.text, value, body };
    }

    return this.lambda();
  }

  private lambda(): Term {
    if (this.match("fn")) {
      const name = this.consume("ident", "Expected lambda parameter");
      this.consume("arrow", "Expected => after lambda parameter");
      return { tag: "lam", name: name.text, body: this.expr() };
    }

    return this.add();
  }

  private add(): Term {
    let left = this.mul();

    while (this.check("plus") || this.check("minus")) {
      const op = this.advance();
      const right = this.mul();

      if (op.kind === "plus") {
        left = { tag: "prim", prim: "i32.add", args: [left, right] };
      } else {
        left = { tag: "prim", prim: "i32.sub", args: [left, right] };
      }
    }

    return left;
  }

  private mul(): Term {
    let left = this.call();

    while (this.match("star")) {
      const right = this.call();
      left = { tag: "prim", prim: "i32.mul", args: [left, right] };
    }

    return left;
  }

  private call(): Term {
    let func = this.primary();

    while (this.match("lparen")) {
      const arg = this.expr();
      this.consume("rparen", "Expected ) after call argument");
      func = { tag: "app", func, arg };
    }

    return func;
  }

  private primary(): Term {
    if (this.match("num")) {
      return numberTerm(this.previous());
    }

    if (this.match("ident")) {
      const name = this.previous();

      if (isPrim(name.text) && this.check("lparen")) {
        return this.primCall(name.text);
      }

      return { tag: "var", name: name.text };
    }

    if (this.match("amp")) {
      const label = this.consume("ident", "Expected superposition label");
      this.consume("lbrace", "Expected { after superposition label");
      const left = this.expr();
      this.consume("comma", "Expected , between superposition branches");
      const right = this.expr();
      this.consume("rbrace", "Expected } after superposition branches");
      return { tag: "sup", label: label.text, left, right };
    }

    if (this.match("lparen")) {
      const expr = this.expr();
      this.consume("rparen", "Expected ) after expression");
      return expr;
    }

    const token = this.peek();
    throw this.error(token, "Expected expression");
  }

  private primCall(prim: PrimNode): Term {
    this.consume("lparen", "Expected ( after primitive name");
    const args: Term[] = [];

    if (!this.check("rparen")) {
      args.push(this.expr());

      while (this.match("comma")) {
        args.push(this.expr());
      }
    }

    this.consume("rparen", "Expected ) after primitive arguments");
    const expected = Prim.arity(prim);
    expect(
      args.length === expected,
      "Primitive " + prim + " expects " + expected + " arguments",
    );
    return { tag: "prim", prim, args };
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) {
      return false;
    }

    this.advance();
    return true;
  }

  private consume(kind: TokenKind, message: string): Token {
    if (this.check(kind)) {
      return this.advance();
    }

    throw this.error(this.peek(), message);
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private advance(): Token {
    const token = this.peek();

    if (!this.check("eof")) {
      this.index += 1;
    }

    return token;
  }

  private previous(): Token {
    const token = this.tokens[this.index - 1];
    expect(token, "Missing previous token");
    return token;
  }

  private peek(): Token {
    const token = this.tokens[this.index];
    expect(token, "Missing token");
    return token;
  }

  private error(token: Token, message: string): Error {
    return new Error(message + " at " + token.line + ":" + token.column);
  }
}

function numberTerm(token: Token): Term {
  if (token.text.endsWith("i32")) {
    const value = token.text.slice(0, token.text.length - 3);
    return { tag: "num", type: "i32", value: Number(value) };
  }

  if (token.text.endsWith("i64")) {
    const value = token.text.slice(0, token.text.length - 3);
    return { tag: "num", type: "i64", value: BigInt(value) };
  }

  throw new Error(
    "Numeric literal must end with i32 or i64 at " + token.line + ":" +
      token.column,
  );
}

function isPrim(text: string): text is PrimNode {
  switch (text) {
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i64.add":
    case "i64.sub":
    case "i64.mul":
      return true;
  }

  return false;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentStart(char: string): boolean {
  return (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    char === "_";
}

function isIdentPart(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}
