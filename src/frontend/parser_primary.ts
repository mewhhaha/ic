import { expect } from "../expect.ts";
import type { FrontExpr, HandlerClause, HandlerReturnClause } from "./ast.ts";
import { front_literal_expr } from "./literal.ts";
import { expect_snake_case, is_no_demand_name } from "./names.ts";
import { ParserBlock } from "./parser_block.ts";
import {
  is_builtin_type_reference_name,
  unsupported_reserved_feature,
} from "./parser_support.ts";
import { integer_literal_fits, integer_type_name } from "../integer.ts";

export abstract class ParserPrimary extends ParserBlock {
  protected allow_signed_minimum_literal = 0;

  protected parse_primary(): FrontExpr {
    const start = this.index;
    const expr = this.parse_primary_inner();
    return this.concrete_node(start, expr);
  }

  private parse_primary_inner(): FrontExpr {
    const token = this.peek();

    if (token.kind === "name") {
      const feature = unsupported_reserved_feature(token.text);

      if (feature) {
        return this.parse_unsupported_expr(feature);
      }
    }

    const literal = front_literal_expr(token);

    if (literal) {
      if (literal.tag === "num" && literal.integer) {
        let value: bigint;

        if (typeof literal.value === "bigint") {
          value = literal.value;
        } else {
          value = BigInt(literal.value);
        }

        if (
          !integer_literal_fits(literal.integer, value) &&
          this.allow_signed_minimum_literal === 0
        ) {
          throw this.error(
            "Integer literal " + value.toString() + " is out of range for " +
              integer_type_name(literal.integer),
          );
        }
      }

      this.advance();
      return literal;
    }

    if (this.match_name("handler")) {
      throw this.error(
        "Effect handlers use `Effect { ... }` literals instead of `handler`",
      );
    }

    if (this.match_name("comptime")) {
      return { tag: "comptime", expr: this.parse_expr() };
    }

    if (this.match_name("import")) {
      const path = this.peek();
      expect(path.kind === "string", "Expected import path literal");
      this.advance();
      return { tag: "import", path: path.text };
    }

    if (this.match_name("if")) {
      if (this.starts_if_let_condition()) {
        return this.parse_if_let_expr();
      }

      return this.parse_if_expr();
    }

    if (this.match_name("match")) {
      return this.parse_match_expr();
    }

    if (
      this.peek().kind === "name" && this.peek().text === "loop" &&
      this.peek(1).kind === "symbol" && this.peek(1).text === "{"
    ) {
      this.expect_name("Expected loop");
      const body = this.parse_block();
      expect(body.tag === "block", "Expected loop body block");
      return { tag: "loop", body: body.statements };
    }

    if (this.match_name("for")) {
      return this.parse_unsupported_expr("for");
    }

    if (this.match_symbol("!")) {
      const name = this.expect_name("Expected linear value name");

      if (name === "_") {
        throw this.error("`!_` is not supported");
      }

      expect_snake_case(name, "Linear value");
      return { tag: "linear", name };
    }

    if (this.match_symbol(".")) {
      const name = this.expect_name("Expected union case name");
      expect_snake_case(name, "Union case");
      let value: FrontExpr | undefined;

      if (this.match_symbol("(")) {
        value = this.parse_expr();
        this.expect_symbol(")");
      }

      return { tag: "union_case", name, value, type_expr: undefined };
    }

    if (this.match_symbol("#")) {
      const name = this.expect_name("Expected atom name");
      expect_snake_case(name, "Atom");
      return { tag: "atom", name };
    }

    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      if (this.is_shape_literal()) {
        return this.parse_shape_value();
      }

      return this.parse_block();
    }

    if (
      token.kind === "name" && token.text === "union" &&
      this.peek(1).kind === "symbol" && this.peek(1).text === "{" &&
      this.is_shape_literal(1)
    ) {
      throw this.error("Sum types use `type Name = | ...`");
    }

    if (this.peek().kind === "symbol" && this.peek().text === "[") {
      return this.parse_bracket_value();
    }

    if (this.match_symbol("(")) {
      return this.parse_parenthesized_value();
    }

    if (this.match_symbol("@")) {
      let name = "@" + this.expect_name("Expected intrinsic name");

      while (this.match_symbol(".")) {
        name += "." + this.expect_name("Expected intrinsic member");
      }

      return { tag: "var", name };
    }

    if (token.kind === "name") {
      this.advance();

      if (token.text === "_") {
        throw this.error("Wildcard `_` cannot be used as an expression");
      }

      if (is_no_demand_name(token.text)) {
        throw this.error("No-demand binding cannot be used as an expression");
      }

      this.expect_supported_name(token.text, "Name");
      const effect_literal = (this.effect_names.has(token.text) ||
        /^[A-Z][A-Za-z0-9]*$/.test(token.text)) &&
        this.peek().kind === "symbol" && this.peek().text === "{";
      const uppercase_application = /^[A-Z][A-Za-z0-9]*$/.test(token.text) &&
        (this.peek().kind === "name" ||
          (this.peek().kind === "symbol" &&
            (this.peek().text === "(" || this.peek().text === "[")));

      if (
        !is_builtin_type_reference_name(token.text) &&
        !this.type_names.has(token.text) &&
        !this.effect_names.has(token.text) &&
        !uppercase_application &&
        !effect_literal &&
        !(
          /^[A-Z][A-Za-z0-9]*$/.test(token.text) &&
          this.peek().kind === "symbol" && this.peek().text === "."
        )
      ) {
        expect_snake_case(token.text, "Name");
      }

      return { tag: "var", name: token.text };
    }

    throw this.error("Expected expression");
  }

  protected parse_effect_handler_literal(effect: string): FrontExpr {
    this.expect_symbol("{");
    this.skip_newlines();
    const clauses: HandlerClause[] = [];
    let return_clause: HandlerReturnClause | undefined;

    while (!this.match_symbol("}")) {
      const clause_start = this.index;
      const name = this.expect_name("Expected handler clause name");
      expect_snake_case(name, "Handler clause");
      this.expect_symbol(":");
      const value = this.parse_handler_clause_lambda(name);

      if (name === "return") {
        expect(
          value.params.length === 1,
          "Handler return clause must accept exactly one parameter",
        );
        const param = value.params[0];
        expect(param, "Missing handler return parameter");
        return_clause = this.concrete_node(clause_start, {
          param,
          body: value.body,
        });
        this.match_symbol(",");
        this.skip_newlines();
        expect(
          this.match_symbol("}"),
          "Handler return clause must be final",
        );
        break;
      }

      clauses.push(this.concrete_node(clause_start, {
        name,
        params: value.params,
        body: value.body,
      }));
      this.match_symbol(",");
      this.skip_newlines();
    }

    expect(return_clause, "Handler requires a return clause");
    return { tag: "handler", effect, state: [], clauses, return_clause };
  }

  private parse_handler_clause_lambda(
    name: string,
  ): { params: import("./ast.ts").Param[]; body: FrontExpr } {
    const params = [];

    if (this.match_symbol("(")) {
      if (!this.match_symbol(")")) {
        while (true) {
          params.push(this.parse_param());

          if (this.match_symbol(")")) {
            break;
          }

          this.expect_symbol(",");
        }
      }
    } else {
      params.push(this.parse_param());
    }

    this.expect_symbol("=>");
    const previous = this.affine_call_names;
    this.affine_call_names = new Set(previous);

    for (const param of params) {
      if (param.is_linear) {
        this.affine_call_names.add(param.name);
      }
    }

    try {
      return { params, body: this.parse_expr() };
    } catch (error) {
      if (error instanceof Error) {
        error.message = "Handler clause " + name + ": " + error.message;
      }

      throw error;
    } finally {
      this.affine_call_names = previous;
    }
  }

  protected parse_unsupported_expr(feature: string): FrontExpr {
    const text = this.consume_until_boundary();
    return { tag: "unsupported", feature, text };
  }

  protected consume_until_boundary(): string {
    const parts: string[] = [];
    let depth = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (token.kind === "newline" && depth === 0) {
        break;
      }

      if (token.kind === "symbol") {
        if (token.text === "{" || token.text === "(" || token.text === "[") {
          depth += 1;
        } else if (
          token.text === "}" || token.text === ")" || token.text === "]"
        ) {
          depth -= 1;
        }
      }

      parts.push(this.advance().text);
    }

    return parts.join(" ");
  }

  protected consume_balanced_block_text(): string {
    if (this.peek().kind !== "symbol" || this.peek().text !== "{") {
      throw this.error("Expected extension object");
    }

    const parts: string[] = [];
    let depth = 0;

    while (!this.is("eof")) {
      const token = this.advance();
      parts.push(token.text);

      if (token.kind === "symbol" && token.text === "{") {
        depth += 1;
      } else if (token.kind === "symbol" && token.text === "}") {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }
    }

    expect(depth === 0, "Unterminated extension object");
    return parts.join(" ");
  }
}
