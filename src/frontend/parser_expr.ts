import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import {
  binary_prim,
  i32_expr,
  numeric_expr_type,
  parse_number_expr,
  truthy_expr,
} from "./numeric.ts";
import { ParserAggregate } from "./parser_aggregate.ts";
import {
  binary_precedence,
  can_start_struct_value,
  is_builtin_type_reference_name,
  unsupported_reserved_feature,
} from "./parser_support.ts";

export abstract class ParserExpr extends ParserAggregate {
  #stop_postfix_block = 0;

  protected abstract parse_stmt(): Stmt;

  protected parse_expr(): FrontExpr {
    return this.parse_arrow();
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
    if (this.is_rec_arrow()) {
      this.expect_name("Expected rec");
      const params = this.parse_arrow_params();
      this.expect_symbol("=>");
      return { tag: "rec", params, body: this.parse_closure_body() };
    }

    const single = this.try_single_param_arrow();

    if (single) {
      this.expect_symbol("=>");
      return { tag: "lam", params: [single], body: this.parse_closure_body() };
    }

    const params = this.try_param_list_arrow();

    if (params) {
      this.expect_symbol("=>");
      return { tag: "lam", params, body: this.parse_closure_body() };
    }

    return this.parse_binary(0);
  }

  private parse_closure_body(): FrontExpr {
    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      if (this.is_object_literal()) {
        return {
          tag: "struct_value",
          type_expr: { tag: "var", name: "object_type" },
          fields: this.parse_field_list(),
        };
      }

      return this.parse_block();
    }

    return this.parse_expr();
  }

  protected parse_block(): FrontExpr {
    this.expect_symbol("{");
    const statements: Stmt[] = [];
    this.skip_newlines();

    while (!this.match_symbol("}")) {
      expect(!this.is("eof"), "Unterminated block");
      const stmt = this.parse_stmt();
      this.skip_newlines();

      const final_expr = block_final_conditional_expr(stmt);

      if (
        final_expr && this.peek().kind === "symbol" &&
        this.peek().text === "}"
      ) {
        statements.push({ tag: "expr", expr: final_expr });
      } else {
        statements.push(stmt);
      }
    }

    return { tag: "block", statements };
  }

  private parse_binary(min_precedence: number): FrontExpr {
    let left = this.parse_unary();

    while (true) {
      const token = this.peek();

      if (token.kind !== "symbol") {
        break;
      }

      const precedence = binary_precedence(token.text);

      if (precedence < min_precedence) {
        break;
      }

      const op = this.advance().text;
      const right = this.parse_binary(precedence + 1);

      if (op === "&&") {
        left = {
          tag: "if",
          cond: truthy_expr(left),
          then_branch: truthy_expr(right),
          else_branch: i32_expr(0),
        };
      } else if (op === "||") {
        left = {
          tag: "if",
          cond: truthy_expr(left),
          then_branch: i32_expr(1),
          else_branch: truthy_expr(right),
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

  private parse_unary(): FrontExpr {
    if (this.match_name("borrow")) {
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

      if (
        next.kind === "symbol" ||
        (next.kind === "name" && after.kind === "symbol" && after.text === "(")
      ) {
        this.expect_symbol("!");
        return {
          tag: "prim",
          prim: "i32.eq",
          left: this.parse_unary(),
          right: { tag: "num", type: "i32", value: 0 },
        };
      }
    }

    return this.parse_postfix();
  }

  private parse_postfix(): FrontExpr {
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
        const name = this.expect_name("Expected field name");
        expect_snake_case(name, "Field");
        expr = { tag: "field", object: expr, name };
      } else if (this.match_symbol("[")) {
        const index = this.parse_expr();
        this.expect_symbol("]");
        expr = { tag: "index", object: expr, index };
      } else if (
        this.#stop_postfix_block === 0 && this.peek().kind === "symbol" &&
        this.peek().text === "{"
      ) {
        if (can_start_struct_value(expr)) {
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
      } else if (this.match_name("with")) {
        expr = { tag: "with", base: expr, fields: this.parse_field_list() };
      } else {
        break;
      }
    }

    return expr;
  }

  private parse_primary(): FrontExpr {
    const token = this.peek();

    if (token.kind === "name") {
      const feature = unsupported_reserved_feature(token.text);

      if (feature) {
        return this.parse_unsupported_expr(feature);
      }
    }

    if (token.kind === "number") {
      this.advance();
      return parse_number_expr(token.text);
    }

    if (token.kind === "string") {
      this.advance();
      return { tag: "text", value: token.text };
    }

    if (this.match_name("comptime")) {
      return { tag: "comptime", expr: this.parse_expr() };
    }

    if (this.match_name("if")) {
      if (this.peek().kind === "name" && this.peek().text === "let") {
        return this.parse_if_let_expr();
      }

      return this.parse_if_expr();
    }

    if (this.match_name("for")) {
      return this.parse_unsupported_expr("for");
    }

    if (this.match_name("struct")) {
      return { tag: "struct_type", fields: this.parse_type_field_list() };
    }

    if (this.match_name("union")) {
      return { tag: "union_type", cases: this.parse_type_field_list() };
    }

    if (this.match_symbol("!")) {
      const name = this.expect_name("Expected linear value name");
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

    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      if (this.is_object_literal()) {
        return {
          tag: "struct_value",
          type_expr: { tag: "var", name: "object_type" },
          fields: this.parse_field_list(),
        };
      }

      return this.parse_block();
    }

    if (this.match_symbol("(")) {
      const expr = this.parse_expr();
      this.expect_symbol(")");
      return expr;
    }

    if (token.kind === "name") {
      this.advance();
      this.expect_supported_name(token.text, "Name");

      if (!is_builtin_type_reference_name(token.text)) {
        expect_snake_case(token.text, "Name");
      }

      return { tag: "var", name: token.text };
    }

    throw this.error("Expected expression");
  }

  private parse_unsupported_expr(feature: string): FrontExpr {
    const text = this.consume_until_boundary();
    return { tag: "unsupported", feature, text };
  }

  private parse_if_expr(): FrontExpr {
    const cond = this.parse_expr_without_postfix_block();
    const then_branch = this.parse_block();

    if (!this.match_name("else")) {
      return {
        tag: "if",
        cond,
        then_branch,
        else_branch: { tag: "num", type: "i32", value: 0 },
        implicit_else: true,
      };
    }

    const else_branch = this.parse_block();
    return { tag: "if", cond, then_branch, else_branch };
  }

  private parse_if_let_expr(): FrontExpr {
    expect(this.match_name("let"), "Expected let");
    this.expect_symbol(".");
    const case_name = this.expect_name("Expected union case name");
    expect_snake_case(case_name, "Union case");
    let value_name: string | undefined;

    if (this.match_symbol("(")) {
      value_name = this.expect_name("Expected union case value name");
      expect_snake_case(value_name, "Union case value");
      this.expect_symbol(")");
    }

    this.expect_symbol("=");
    const target = this.parse_expr_without_postfix_block();
    const then_branch = this.parse_block();

    if (!this.match_name("else")) {
      return {
        tag: "if_let",
        case_name,
        value_name,
        target,
        then_branch,
        else_branch: { tag: "num", type: "i32", value: 0 },
        implicit_else: true,
      };
    }

    const else_branch = this.parse_block();
    return {
      tag: "if_let",
      case_name,
      value_name,
      target,
      then_branch,
      else_branch,
    };
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

function block_final_conditional_expr(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "if_stmt") {
    if (!block_statements_have_result(stmt.body)) {
      return undefined;
    }

    return {
      tag: "if",
      cond: stmt.cond,
      then_branch: { tag: "block", statements: stmt.body },
      else_branch: { tag: "num", type: "i32", value: 0 },
      implicit_else: true,
    };
  }

  if (stmt.tag === "if_let_stmt") {
    if (!block_statements_have_result(stmt.body)) {
      return undefined;
    }

    return {
      tag: "if_let",
      case_name: stmt.case_name,
      value_name: stmt.value_name,
      target: stmt.target,
      then_branch: { tag: "block", statements: stmt.body },
      else_branch: { tag: "num", type: "i32", value: 0 },
      implicit_else: true,
    };
  }

  return undefined;
}

function block_statements_have_result(statements: Stmt[]): boolean {
  if (statements.length === 0) {
    return false;
  }

  const last = statements[statements.length - 1];

  if (!last) {
    return false;
  }

  return last.tag === "expr";
}
