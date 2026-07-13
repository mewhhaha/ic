import { expect } from "../expect.ts";
import type { FrontExpr, Token, TypeExpr } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { binary_prim, numeric_expr_type } from "./numeric.ts";
import { ParserPrimary } from "./parser_primary.ts";
import { binary_precedence, can_start_struct_value } from "./parser_support.ts";
import { parse_type_expr } from "./type_expr.ts";
import { record_annotation_name_sites, record_name_site } from "./name_site.ts";

export abstract class ParserExpr extends ParserPrimary {
  #stop_postfix_block = 0;
  #stop_try_with = 0;

  protected parse_expr(): FrontExpr {
    const start = this.index;
    const expr = this.parse_arrow();
    return this.concrete_node(start, expr);
  }

  protected parse_expr_without_postfix_block(): FrontExpr {
    this.#stop_postfix_block += 1;

    try {
      return this.parse_expr();
    } finally {
      this.#stop_postfix_block -= 1;
    }
  }

  private parse_arrow(): FrontExpr {
    const start = this.index;
    const expr = this.parse_arrow_inner();
    return this.concrete_node(start, expr);
  }

  private parse_arrow_inner(): FrontExpr {
    if (this.is_rec_arrow()) {
      this.expect_name("Expected rec");
      const params = this.parse_arrow_params();
      this.expect_symbol("=>");
      return { tag: "rec", params, body: this.parse_arrow_body(params) };
    }

    const single = this.try_single_param_arrow();

    if (single) {
      this.expect_symbol("=>");
      return {
        tag: "lam",
        params: [single],
        body: this.parse_arrow_body([single]),
      };
    }

    const params = this.try_param_list_arrow();

    if (params) {
      this.expect_symbol("=>");
      return { tag: "lam", params, body: this.parse_arrow_body(params) };
    }

    return this.parse_binary(0);
  }

  private parse_arrow_body(
    params: import("./ast.ts").Param[],
  ): FrontExpr {
    const previous = this.affine_call_names;
    this.affine_call_names = new Set(previous);

    for (const param of params) {
      if (param.is_linear) {
        this.affine_call_names.add(param.name);
      } else {
        this.affine_call_names.delete(param.name);
      }
    }

    try {
      return this.parse_closure_body();
    } finally {
      this.affine_call_names = previous;
    }
  }

  private parse_closure_body(): FrontExpr {
    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      if (this.is_object_literal()) {
        const start = this.index;
        return this.concrete_node(start, {
          tag: "struct_value",
          type_expr: { tag: "var", name: "object_type" },
          fields: this.parse_record_field_list(),
        });
      }

      return this.parse_block();
    }

    return this.parse_expr();
  }

  private parse_binary(min_precedence: number): FrontExpr {
    const start = this.index;
    const expr = this.parse_binary_inner(min_precedence);
    return this.concrete_node(start, expr);
  }

  private parse_binary_inner(min_precedence: number): FrontExpr {
    let left = this.parse_unary();

    while (true) {
      const token = this.peek();
      const is_operator = token.kind === "name" && token.text === "is";

      if (token.kind !== "symbol" && !is_operator) {
        break;
      }

      let precedence = binary_precedence(token.text);

      if (is_operator) {
        precedence = 5;
      }

      if (precedence < min_precedence) {
        break;
      }

      if (is_operator) {
        this.advance();
        left = {
          tag: "is",
          value: left,
          type_expr: this.parse_is_type_expr(),
        };
        continue;
      }

      const op = this.advance().text;
      const right = this.parse_binary(precedence + 1);

      if (op === "&&") {
        left = {
          tag: "if",
          cond: left,
          then_branch: normalize_boolean_expr(right),
          else_branch: { tag: "bool", value: false },
        };
      } else if (op === "||") {
        left = {
          tag: "if",
          cond: left,
          then_branch: { tag: "bool", value: true },
          else_branch: normalize_boolean_expr(right),
        };
      } else {
        const prim = binary_prim(op, left, right);

        if (prim) {
          left = { tag: "prim", prim, left, right };
        } else {
          left = { tag: "unsupported", feature: "operator " + op, text: op };
        }
      }
    }

    return left;
  }

  private parse_is_type_expr(): TypeExpr {
    const tokens: Token[] = [];
    let parens = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (token.kind === "newline") {
        break;
      }

      if (parens === 0 && token.kind === "symbol") {
        if (
          token.text === "{" || token.text === "}" || token.text === ")" ||
          token.text === "," || token.text === "&&" || token.text === "||" ||
          token.text === "==" || token.text === "!=" || token.text === "<" ||
          token.text === "<=" || token.text === ">" || token.text === ">=" ||
          token.text === "+" || token.text === "-" || token.text === "*" ||
          token.text === "/" || token.text === "%" || token.text === "="
        ) {
          break;
        }
      }

      if (token.kind === "symbol" && token.text === "(") {
        parens += 1;
      } else if (token.kind === "symbol" && token.text === ")") {
        parens -= 1;
      }

      tokens.push(this.advance());
    }

    expect(tokens.length > 0, "Expected type after is");
    const type_expr = parse_type_expr(tokens);
    record_annotation_name_sites(type_expr, tokens);
    return type_expr;
  }

  private parse_unary(): FrontExpr {
    const start = this.index;
    const expr = this.parse_unary_inner();
    return this.concrete_node(start, expr);
  }

  private parse_unary_inner(): FrontExpr {
    if (this.match_name("try")) {
      this.#stop_try_with += 1;
      let body: FrontExpr;

      try {
        body = this.parse_expr();
      } finally {
        this.#stop_try_with -= 1;
      }

      if (!this.match_name("with")) {
        throw this.error("Expected with after try expression");
      }

      return { tag: "try_with", body, handler: this.parse_expr() };
    }

    if (this.match_symbol("&")) {
      return { tag: "borrow", value: this.parse_unary() };
    }

    if (this.match_name("freeze")) {
      return { tag: "freeze", value: this.parse_unary() };
    }

    if (this.match_name("scratch")) {
      if (this.peek().kind !== "symbol" || this.peek().text !== "{") {
        throw this.error("Expected scratch block");
      }

      return { tag: "scratch", body: this.parse_block() };
    }

    if (this.match_symbol("-")) {
      const right = this.parse_unary();

      if (right.tag === "num") {
        if (right.type === "i64") {
          expect(typeof right.value === "bigint", "Expected i64 literal");
          return { tag: "num", type: "i64", value: -right.value };
        }

        expect(typeof right.value === "number", "Expected i32 literal");
        return { tag: "num", type: "i32", value: -right.value };
      }

      if (numeric_expr_type(right) === "i64") {
        return {
          tag: "prim",
          prim: "i64.sub",
          left: { tag: "num", type: "i64", value: 0n },
          right,
        };
      }

      return {
        tag: "prim",
        prim: "i32.sub",
        left: { tag: "num", type: "i32", value: 0 },
        right,
      };
    }

    if (this.peek().kind === "symbol" && this.peek().text === "!") {
      const next = this.peek(1);
      const after = this.peek(2);
      const non_affine_call = next.kind === "name" &&
        after.kind === "symbol" && after.text === "(" &&
        next.text !== "resume" &&
        !this.affine_call_names.has(next.text);
      const boolean_literal = next.kind === "name" &&
        (next.text === "true" || next.text === "false");

      if (next.kind === "symbol" || non_affine_call || boolean_literal) {
        this.expect_symbol("!");
        return {
          tag: "if",
          cond: this.parse_unary(),
          then_branch: { tag: "bool", value: false },
          else_branch: { tag: "bool", value: true },
        };
      }
    }

    return this.parse_postfix();
  }

  private parse_postfix(): FrontExpr {
    const start = this.index;
    const expr = this.parse_postfix_inner();
    return this.concrete_node(start, expr);
  }

  private parse_postfix_inner(): FrontExpr {
    let expr = this.parse_primary();

    while (true) {
      if (this.match_symbol("(")) {
        const args: FrontExpr[] = [];

        if (!this.match_symbol(")")) {
          while (true) {
            args.push(this.parse_expr());

            if (this.match_symbol(")")) {
              break;
            }

            this.expect_symbol(",");
          }
        }

        expr = { tag: "app", func: expr, args };
      } else if (this.match_symbol(".")) {
        const token = this.peek();
        const name = this.expect_name("Expected field name");

        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
          expect_snake_case(name, "Field");
        } else if (expr.tag !== "var" || !/^[A-Z]/.test(expr.name)) {
          expect_snake_case(name, "Field");
        }

        const field = { tag: "field" as const, object: expr, name };
        record_name_site(field, "name", name, token.span);
        expr = field;
      } else if (this.match_symbol("[")) {
        const index = this.parse_expr();
        this.expect_symbol("]");
        expr = { tag: "index", object: expr, index };
      } else if (
        this.#stop_postfix_block === 0 && this.peek().kind === "symbol" &&
        this.peek().text === "{"
      ) {
        if (expr.tag === "var" && this.effect_names.has(expr.name)) {
          expr = this.parse_effect_handler_literal(expr.name);
        } else if (can_start_struct_value(expr)) {
          expr = {
            tag: "struct_value",
            type_expr: expr,
            fields: this.parse_field_list(),
          };
        } else {
          expr = {
            tag: "struct_update",
            base: expr,
            fields: this.parse_field_list(),
          };
        }
      } else if (
        this.#stop_try_with > 0 && this.peek().kind === "name" &&
        this.peek().text === "with" &&
        !(this.peek(1).kind === "symbol" && this.peek(1).text === "{")
      ) {
        break;
      } else if (this.match_name("with")) {
        expr = { tag: "with", base: expr, fields: this.parse_field_list() };
      } else {
        break;
      }
    }

    return expr;
  }
}

function normalize_boolean_expr(expr: FrontExpr): FrontExpr {
  return {
    tag: "if",
    cond: expr,
    then_branch: { tag: "bool", value: true },
    else_branch: { tag: "bool", value: false },
  };
}
