import { expect } from "../expect.ts";
import type { Token, TokenKind } from "./ast.ts";
import { no_demand_name } from "./names.ts";
import { is_builtin_type_reference_name } from "./parser_support.ts";
import type { SourceSpan } from "./syntax.ts";
import type { SyntaxDiagnostic } from "./syntax.ts";
import { has_source_span, mark_source_span } from "./syntax.ts";
import { record_node_name_sites } from "./name_site.ts";
import {
  create_fixity_table,
  type FixityTable,
  type InfixFixity,
  type PrefixFixity,
} from "./fixity.ts";

export type RecoveryInterval = {
  diagnostic: SyntaxDiagnostic;
  skipped: SourceSpan;
};

export class ParseFailure extends Error {
  constructor(message: string, readonly span: SourceSpan) {
    super(message);
    this.name = "ParseFailure";
  }
}

export type ParserState = {
  index: number;
  effect_names: Set<string>;
  effect_instance_names: Set<string>;
  type_names: Set<string>;
  declaration_names: Set<string>;
  no_demand_name: number;
  affine_call_names?: Set<string>;
  allow_pascal_type_names?: number;
};

export class ParserCursor {
  protected tokens: Token[];
  protected index = 0;
  protected effect_names = new Set<string>();
  protected effect_instance_names = new Set<string>();
  protected type_names = new Set<string>();
  protected declaration_names = new Set<string>();
  protected next_no_demand_name = 0;
  protected recovering = false;
  protected recovery_diagnostics: SyntaxDiagnostic[] | undefined;
  protected recovery_intervals: RecoveryInterval[] | undefined;
  protected fixities: FixityTable = create_fixity_table();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  protected set_fixities(fixities: FixityTable): void {
    this.fixities = fixities;
  }

  protected infix_fixity(operator: string): InfixFixity | undefined {
    return this.fixities.infix.get(operator);
  }

  protected prefix_fixity(operator: string): PrefixFixity | undefined {
    return this.fixities.prefix.get(operator);
  }

  protected begin_recovery(
    diagnostics: SyntaxDiagnostic[],
    intervals: RecoveryInterval[],
  ): void {
    this.recovering = true;
    this.recovery_diagnostics = diagnostics;
    this.recovery_intervals = intervals;
  }

  protected record_recovery(
    error: unknown,
    start: number,
    failure: number,
  ): void {
    expect(
      this.recovery_diagnostics !== undefined,
      "Missing recovery diagnostics",
    );
    const failed = this.tokens[failure];
    expect(failed, "Missing failed syntax token");
    let span = failed.span;

    if (error instanceof ParseFailure) {
      span = error.span;
    }

    let message: string;

    if (error instanceof Error) {
      message = error.message;
    } else {
      message = String(error);
    }

    const diagnostic = { message, span };
    this.recovery_diagnostics.push(diagnostic);
    expect(this.recovery_intervals !== undefined, "Missing recovery intervals");
    const discarded = this.tokens[start];
    expect(discarded, "Missing failed statement token");
    this.recovery_intervals.push({
      diagnostic,
      skipped: { start: discarded.span.start, end: this.current_span().start },
    });
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
    const index = this.next_no_demand_name;
    this.next_no_demand_name += 1;
    return no_demand_name(index);
  }

  protected fresh_internal_name(prefix: string): string {
    const index = this.next_no_demand_name;
    this.next_no_demand_name += 1;
    return "@" + prefix + "_" + index.toString();
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
    return new ParseFailure(
      message + " at " + token.line.toString() + ":" +
        token.column.toString(),
      token.span,
    );
  }

  protected parser_state(): ParserState {
    return {
      index: this.index,
      effect_names: new Set(this.effect_names),
      effect_instance_names: new Set(this.effect_instance_names),
      type_names: new Set(this.type_names),
      declaration_names: new Set(this.declaration_names),
      no_demand_name: this.next_no_demand_name,
    };
  }

  protected restore_parser_state(state: ParserState): void {
    this.index = state.index;
    this.effect_names = state.effect_names;
    this.effect_instance_names = state.effect_instance_names;
    this.type_names = state.type_names;
    this.declaration_names = state.declaration_names;
    this.next_no_demand_name = state.no_demand_name;
  }

  protected current_span(): SourceSpan {
    return this.peek().span;
  }

  protected parsed_span(start: number): SourceSpan {
    const first = this.tokens[start];
    expect(first, "Missing first parsed token");
    const last = this.tokens[Math.max(start, this.index - 1)];
    expect(last, "Missing last parsed token");
    return { start: first.span.start, end: last.span.end };
  }

  protected concrete_node<node extends object>(
    start: number,
    value: node,
  ): node {
    if (has_source_span(value)) {
      return value;
    }

    record_node_name_sites(value, this.tokens.slice(start, this.index));
    return mark_source_span(value, this.parsed_span(start));
  }

  protected synchronize_statement(): void {
    let parens = 0;
    let brackets = 0;
    let braces = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (token.kind === "newline") {
        if (
          (parens === 0 && brackets === 0 && braces === 0) ||
          this.strong_statement_after_newline()
        ) {
          this.advance();
          return;
        }
      }

      if (token.kind === "symbol") {
        if (token.text === "(") parens += 1;
        if (token.text === "[") brackets += 1;
        if (token.text === "{") braces += 1;
        if (token.text === ")" && parens > 0) parens -= 1;
        if (token.text === "]" && brackets > 0) brackets -= 1;
        if (token.text === "}") {
          if (braces === 0) return;
          braces -= 1;
        }
      }

      this.advance();
    }
  }

  private strong_statement_after_newline(): boolean {
    let offset = 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    const token = this.peek(offset);

    if (token.kind !== "name") {
      return false;
    }

    const keywords = new Set([
      "break",
      "const",
      "continue",
      "declare",
      "effect",
      "extend",
      "for",
      "if",
      "import",
      "let",
      "module",
      "return",
      "duck",
      "infix",
      "infixl",
      "infixr",
      "prefix",
      "type",
    ]);

    if (keywords.has(token.text)) {
      return true;
    }

    const next = this.peek(offset + 1);
    return next.kind === "symbol" &&
      (next.text === "=" || next.text === ":=" || next.text === "<-");
  }
}
