import { expect } from "../expect.ts";
import type { FrontExpr, MatchArm, Pattern } from "./ast.ts";
import { front_literal_expr } from "./literal.ts";
import { expect_snake_case, is_no_demand_name } from "./names.ts";
import { binary_prim } from "./numeric.ts";
import { ParserAggregate } from "./parser_aggregate.ts";

type ParsedIfLetCondition =
  | {
    tag: "union";
    case_name: string;
    value_name: string | undefined;
    target: FrontExpr;
  }
  | { tag: "literal"; cond: FrontExpr }
  | { tag: "pattern"; pattern: Pattern; target: FrontExpr };

export abstract class ParserConditional extends ParserAggregate {
  protected abstract parse_expr_without_postfix_block(): FrontExpr;

  protected abstract parse_expr_before_arrow(): FrontExpr;

  protected abstract parse_block(): FrontExpr;

  protected parse_if_expr(): FrontExpr {
    const start = this.index - 1;
    const expr = this.parse_if_expr_inner();
    return this.concrete_node(start, expr);
  }

  private parse_if_expr_inner(): FrontExpr {
    const cond = this.parse_expr_without_postfix_block();
    const then_branch = this.parse_block();
    const else_branch = this.parse_optional_else_branch();

    if (!else_branch) {
      return {
        tag: "if",
        cond,
        then_branch,
        else_branch: { tag: "num", type: "i32", value: 0 },
        implicit_else: true,
      };
    }

    return { tag: "if", cond, then_branch, else_branch };
  }

  protected parse_if_let_expr(): FrontExpr {
    const start = this.index - 1;
    const expr = this.parse_if_let_expr_inner();
    return this.concrete_node(start, expr);
  }

  private parse_if_let_expr_inner(): FrontExpr {
    const pattern = this.parse_if_let_condition();
    const then_branch = this.parse_block();
    let else_branch: FrontExpr = { tag: "num", type: "i32", value: 0 };
    let implicit_else = true;
    const parsed_else = this.parse_optional_else_branch();

    if (parsed_else) {
      else_branch = parsed_else;
      implicit_else = false;
    }

    if (pattern.tag === "literal") {
      const result: Extract<FrontExpr, { tag: "if" }> = {
        tag: "if",
        cond: pattern.cond,
        then_branch,
        else_branch,
      };

      if (implicit_else) {
        result.implicit_else = true;
      }

      return result;
    }

    if (pattern.tag === "pattern") {
      return {
        tag: "match",
        target: pattern.target,
        arms: [
          { pattern: pattern.pattern, guard: undefined, body: then_branch },
          {
            pattern: { tag: "wildcard", mode: "default" },
            guard: undefined,
            body: else_branch,
          },
        ],
      };
    }

    const result: Extract<FrontExpr, { tag: "if_let" }> = {
      tag: "if_let",
      case_name: pattern.case_name,
      value_name: pattern.value_name,
      target: pattern.target,
      then_branch,
      else_branch,
    };

    if (implicit_else) {
      result.implicit_else = true;
    }

    return result;
  }

  protected parse_optional_else_branch(): FrontExpr | undefined {
    if (!this.match_name("else")) {
      return undefined;
    }

    if (!this.match_name("if")) {
      return this.parse_block();
    }

    if (this.starts_if_let_condition()) {
      return this.parse_if_let_expr();
    }

    return this.parse_if_expr();
  }

  protected starts_if_let_condition(): boolean {
    let offset = 0;

    if (this.peek().kind === "symbol" && this.peek().text === "(") {
      offset = 1;
    }

    const token = this.peek(offset);
    return token.kind === "name" && token.text === "let";
  }

  protected parse_match_expr(): FrontExpr {
    const target = this.parse_expr_without_postfix_block();
    this.skip_newlines();
    this.expect_symbol("{");
    this.skip_newlines();
    const arms: MatchArm[] = [];

    while (!this.match_symbol("}")) {
      this.expect_symbol("|");
      let pattern: import("./ast.ts").Pattern;

      if (
        this.peek().kind === "name" &&
        (this.peek().text === "struct" || this.peek().text === "union") &&
        this.peek(1).kind === "symbol" && this.peek(1).text === "{"
      ) {
        pattern = { tag: "type", pattern: this.parse_type_pattern() };
      } else {
        pattern = this.parse_pattern();
      }
      let guard: FrontExpr | undefined;

      if (this.match_name("if")) {
        guard = this.parse_expr_before_arrow();
      }

      this.expect_symbol("=>");
      let body: FrontExpr;

      if (this.peek().kind === "symbol" && this.peek().text === "{") {
        body = this.parse_block();
      } else {
        body = this.parse_expr_without_postfix_block();
      }

      arms.push({ pattern, guard, body });
      this.match_symbol(",");
      this.skip_newlines();
    }

    expect(arms.length > 0, "Match expression requires at least one arm");
    return { tag: "match", target, arms };
  }

  protected parse_if_let_condition(): ParsedIfLetCondition {
    const parenthesized = this.match_symbol("(");
    expect(this.match_name("let"), "Expected let");

    if (this.match_symbol("`")) {
      const case_name = this.expect_name("Expected union case name");
      expect(
        /^[A-Z][A-Za-z0-9]*$/.test(case_name),
        "Union case must use PascalCase: " + case_name,
      );
      let value_name: string | undefined;

      if (this.match_symbol("(")) {
        this.expect_symbol(")");
      } else {
        value_name = this.expect_binding_name(
          "Expected union case value name",
        );

        if (!is_no_demand_name(value_name)) {
          expect_snake_case(value_name, "Union case value");
        }
      }

      this.expect_symbol("=");
      const target = this.parse_expr_without_postfix_block();

      if (parenthesized) {
        this.expect_symbol(")");
      }

      return {
        tag: "union",
        case_name,
        value_name,
        target,
      };
    }

    const literal = front_literal_expr(this.peek());
    const interpolated_text = literal?.tag === "text" &&
      /\$\{[a-z_][A-Za-z0-9_]*\}/.test(literal.value);
    const alternative = this.peek(1).kind === "symbol" &&
      this.peek(1).text === "|";

    if (literal !== undefined && !interpolated_text && !alternative) {
      this.advance();
      this.expect_symbol("=");
      const target = this.parse_expr_without_postfix_block();

      if (parenthesized) {
        this.expect_symbol(")");
      }

      const prim = binary_prim("==", target, literal);
      expect(prim, "Missing literal pattern equality primitive");
      return {
        tag: "literal",
        cond: { tag: "prim", prim, left: target, right: literal },
      };
    }

    const pattern = this.parse_pattern();
    this.expect_symbol("=");
    const target = this.parse_expr_without_postfix_block();

    if (parenthesized) {
      this.expect_symbol(")");
    }

    return { tag: "pattern", pattern, target };
  }
}
