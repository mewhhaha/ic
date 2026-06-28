import { expect } from "./expect.ts";
import type { Mod as ModNode } from "./mod.ts";
import { Prim, type Prim as PrimNode, type ValType } from "./op.ts";
import { Surface, type Surface as SurfaceNode, type Term } from "./surface.ts";
import type { Emit, Parse } from "./trait.ts";

type TokenKind =
  | "ident"
  | "num"
  | "op"
  | "intrinsic"
  | "let"
  | "export"
  | "fn"
  | "infixl"
  | "arrow"
  | "eq"
  | "colon"
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

type Operator = {
  precedence: number;
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
      } else if (char === "@") {
        tokens.push(this.intrinsic());
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

    if (text === "infixl") {
      return { kind: "infixl", text, line, column };
    }

    return { kind: "ident", text, line, column };
  }

  private intrinsic(): Token {
    const line = this.line;
    const column = this.column;
    let text = this.advance();

    while (!this.done()) {
      const char = this.peek();
      expect(char, "Missing intrinsic character");

      if (!isIdentPart(char) && char !== ".") {
        break;
      }

      text += this.advance();
    }

    return { kind: "intrinsic", text, line, column };
  }

  private symbol(): Token {
    const line = this.line;
    const column = this.column;
    const char = this.advance();

    if (char === "=" && this.peek() === ">") {
      this.advance();
      return { kind: "arrow", text: "=>", line, column };
    }

    if (char === "-" && this.peek() === ">") {
      this.advance();
      return { kind: "arrow", text: "->", line, column };
    }

    if (char === "=") {
      return { kind: "eq", text: char, line, column };
    }

    if (char === ":") {
      return { kind: "colon", text: char, line, column };
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

    if (isOperatorChar(char)) {
      return this.operator(line, column, char);
    }

    throw new Error(
      "Unexpected character " + char + " at " + line + ":" + column,
    );
  }

  private operator(line: number, column: number, first: string): Token {
    let text = first;

    while (!this.done()) {
      const char = this.peek();
      expect(char, "Missing operator character");

      if (!isOperatorChar(char)) {
        break;
      }

      text += this.advance();
    }

    return { kind: "op", text, line, column };
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
  private operators = new Map<string, Operator>();

  constructor(private tokens: Token[]) {}

  parseSurface(): SurfaceNode {
    const statements: SurfaceNode["statements"] = [];

    while (!this.check("eof")) {
      const statement = this.statement();

      if (statement !== undefined) {
        statements.push(statement);
      }
    }

    this.consume("eof", "Expected end of input");
    return { statements };
  }

  private statement(): SurfaceNode["statements"][number] | undefined {
    if (this.match("infixl")) {
      this.infix();
      return undefined;
    }

    if (this.match("export")) {
      if (this.check("fn")) {
        return this.fn(true);
      }

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

    if (this.match("fn")) {
      return this.fn(false);
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

  private infix(): void {
    const precedence = this.consume("num", "Expected infix precedence");
    const name = this.parenOperator();
    this.consume("semi", "Expected ; after infix declaration");

    this.operators.set(name, {
      precedence: Number(precedence.text),
    });
  }

  private fn(exported: boolean): SurfaceNode["statements"][number] | undefined {
    this.consume("fn", "Expected fn");
    const name = this.name();

    if (this.match("colon")) {
      this.signature();
      this.consume("semi", "Expected ; after function signature");
      return undefined;
    }

    const args: string[] = [];

    while (!this.check("eq")) {
      const arg = this.consume("ident", "Expected function argument");
      args.push(arg.text);
    }

    this.consume("eq", "Expected = before function body");
    const body = this.expr();
    this.consume("semi", "Expected ; after function definition");

    return {
      tag: "let",
      name,
      value: lambda(args, body),
      exported,
    };
  }

  private signature(): void {
    this.valueType();

    while (this.match("arrow")) {
      this.valueType();
    }
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

    return this.infixExpr(0);
  }

  private infixExpr(min: number): Term {
    let left = this.call();

    while (this.check("op")) {
      const token = this.peek();
      const operator = this.operators.get(token.text);
      expect(operator, "Operator " + token.text + " is not declared");

      if (operator.precedence < min) {
        break;
      }

      this.advance();
      const right = this.infixExpr(operator.precedence + 1);
      left = {
        tag: "app",
        func: {
          tag: "app",
          func: { tag: "var", name: token.text },
          arg: left,
        },
        arg: right,
      };
    }

    return left;
  }

  private call(): Term {
    let func = this.primary();

    while (this.startsPrimary()) {
      const arg = this.primary();
      func = { tag: "app", func, arg };
    }

    return func;
  }

  private primary(): Term {
    if (this.match("num")) {
      return numberTerm(this.previous());
    }

    if (this.match("ident")) {
      return { tag: "var", name: this.previous().text };
    }

    if (this.match("intrinsic")) {
      return this.intrinsic(this.previous());
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
      if (this.check("op")) {
        const op = this.advance();
        this.consume("rparen", "Expected ) after operator name");
        return { tag: "var", name: op.text };
      }

      const expr = this.expr();
      this.consume("rparen", "Expected ) after expression");
      return expr;
    }

    const token = this.peek();
    throw this.error(token, "Expected expression");
  }

  private intrinsic(token: Token): Term {
    const prim = intrinsicPrim(token);
    const left = this.primary();
    const right = this.primary();
    return { tag: "prim", prim, args: [left, right] };
  }

  private name(): string {
    if (this.match("ident")) {
      return this.previous().text;
    }

    return this.parenOperator();
  }

  private parenOperator(): string {
    this.consume("lparen", "Expected ( before operator name");
    const name = this.consume("op", "Expected operator name");
    this.consume("rparen", "Expected ) after operator name");
    return name.text;
  }

  private valueType(): ValType {
    const token = this.consume("ident", "Expected value type");

    if (token.text === "i32" || token.text === "i64") {
      return token.text;
    }

    throw this.error(token, "Unknown value type " + token.text);
  }

  private startsPrimary(): boolean {
    return this.check("num") || this.check("ident") ||
      this.check("intrinsic") || this.check("amp") || this.check("lparen");
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

function lambda(args: string[], body: Term): Term {
  let result = body;

  for (let index = args.length - 1; index >= 0; index -= 1) {
    const name = args[index];
    expect(name, "Missing lambda argument " + index);
    result = { tag: "lam", name, body: result };
  }

  return result;
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

function intrinsicPrim(token: Token): PrimNode {
  if (token.text === "@i32_add") {
    return "i32.add";
  }

  if (token.text === "@i32_sub") {
    return "i32.sub";
  }

  if (token.text === "@i32_mul") {
    return "i32.mul";
  }

  if (token.text === "@i64_add") {
    return "i64.add";
  }

  if (token.text === "@i64_sub") {
    return "i64.sub";
  }

  if (token.text === "@i64_mul") {
    return "i64.mul";
  }

  throw new Error(
    "Unknown compiler intrinsic " + token.text + " at " + token.line + ":" +
      token.column,
  );
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

function isOperatorChar(char: string): boolean {
  return char === "+" || char === "-" || char === "*" || char === "/" ||
    char === "%";
}
