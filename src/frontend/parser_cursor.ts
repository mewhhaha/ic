import { expect } from "../expect.ts";
import type { Token, TokenKind } from "./ast.ts";
import { no_demand_name } from "./names.ts";
import { is_builtin_type_reference_name } from "./parser_support.ts";

export class ParserCursor {
  protected tokens: Token[];
  protected index = 0;
  protected effect_names = new Set<string>();
  protected type_names = new Set<string>();
  protected declaration_names = new Set<string>();
  #next_no_demand_name = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  protected skip_newlines(): void {
    while (this.match("newline")) {
      // consume
    }
  }

  protected match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) {
      return false;
    }

    this.advance();
    return true;
  }

  protected match_name(text: string): boolean {
    const token = this.peek();

    if (token.kind !== "name" || token.text !== text) {
      return false;
    }

    this.advance();
    return true;
  }

  protected match_symbol(text: string): boolean {
    const token = this.peek();

    if (token.kind !== "symbol" || token.text !== text) {
      return false;
    }

    this.advance();
    return true;
  }

  protected expect_symbol(text: string): void {
    if (!this.match_symbol(text)) {
      throw this.error("Expected `" + text + "`");
    }
  }

  protected expect_name(message: string): string {
    const token = this.peek();

    if (token.kind !== "name") {
      throw this.error(message);
    }

    this.advance();
    return token.text;
  }

  protected expect_binding_name(message: string): string {
    const name = this.expect_name(message);

    if (name !== "_") {
      return name;
    }

    return this.fresh_no_demand_name();
  }

  protected fresh_no_demand_name(): string {
    const index = this.#next_no_demand_name;
    this.#next_no_demand_name += 1;
    return no_demand_name(index);
  }

  protected reserve_declaration_name(name: string, label: string): void {
    expect(
      !is_builtin_type_reference_name(name),
      label + " conflicts with builtin type: " + name,
    );
    expect(
      !this.declaration_names.has(name),
      "Duplicate declaration name: " + name,
    );
    this.declaration_names.add(name);
  }

  protected is(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  protected peek(offset = 0): Token {
    const token = this.tokens[this.index + offset];
    expect(token, "Missing token");
    return token;
  }

  protected advance(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  protected find_matching(start: number, open: string, close: string): number {
    let depth = 0;

    for (let index = start; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      expect(token, "Missing token while finding match");

      if (token.kind === "symbol" && token.text === open) {
        depth += 1;
      } else if (token.kind === "symbol" && token.text === close) {
        depth -= 1;

        if (depth === 0) {
          return index;
        }
      }
    }

    throw this.error("Unterminated `" + open + "`");
  }

  protected error(message: string): Error {
    const token = this.peek();
    return new Error(
      message + " at " + token.line.toString() + ":" +
        token.column.toString(),
    );
  }
}
