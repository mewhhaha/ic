import { expect } from "../expect.ts";
import type { Token, TypeDeclaration, TypeField } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { ParserStmtBinding } from "./parser_stmt/binding.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";

export abstract class ParserTypeDeclaration extends ParserStmtBinding {
  protected parse_type_declaration(): TypeDeclaration {
    this.expect_name("Expected type");
    const name = this.expect_name("Expected type name");
    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(name),
      "Type name must use PascalCase: " + name,
    );
    this.reserve_declaration_name(name, "Type declaration");
    this.type_names.add(name);
    const params: string[] = [];

    while (!this.match_symbol("=")) {
      const param = this.expect_name("Expected type parameter or `=`");
      expect_snake_case(param, "Type parameter");
      expect(!params.includes(param), "Duplicate type parameter: " + param);
      params.push(param);
    }

    this.skip_newlines();
    this.allow_pascal_type_names += 1;

    try {
      if (this.starts_product_type()) {
        const product = this.parse_product_type(name);
        return {
          tag: "type",
          name,
          params,
          body: product.body,
          recursive: product.recursive,
        };
      }

      if (
        this.peek().kind === "symbol" &&
        (this.peek().text === "." || this.peek().text === "|")
      ) {
        const body_start = this.index;
        const sum = this.parse_sum_type(name);
        return {
          tag: "type",
          name,
          params,
          body: this.concrete_node(body_start, {
            tag: "sum",
            cases: sum.cases,
          }),
          recursive: sum.recursive,
        };
      }

      const body_start = this.index;
      const alias = this.consume_type_member(name, new Set());
      return {
        tag: "type",
        name,
        params,
        body: this.concrete_node(body_start, {
          tag: "alias",
          type_name: alias.text,
        }),
        recursive: alias.recursive,
      };
    } finally {
      this.allow_pascal_type_names -= 1;
    }
  }

  private parse_product_type(
    declaration_name: string,
  ): {
    body: Extract<TypeDeclaration["body"], { tag: "product" }>;
    recursive: boolean;
  } {
    const start = this.index;
    this.expect_symbol("(");
    this.skip_newlines();
    const fields: TypeField[] = [];
    const names = new Set<string>();
    let positional: boolean | undefined;
    let recursive = false;

    if (this.match_symbol(")")) {
      return {
        body: this.concrete_node(start, {
          tag: "product",
          fields,
          positional: true,
        }),
        recursive,
      };
    }

    while (true) {
      const field_start = this.index;
      const named = this.peek().kind === "symbol" && this.peek().text === ".";

      if (positional === undefined) {
        positional = !named;
      } else if (positional === named) {
        throw this.error("Cannot mix named and positional product entries");
      }

      let field_name: string;

      if (named) {
        this.expect_symbol(".");
        field_name = this.expect_name("Expected product field name");
        expect_snake_case(field_name, "Product field");
        this.expect_symbol("=");
      } else {
        field_name = "item_" + fields.length.toString();
      }

      expect(
        !names.has(field_name),
        "Duplicate product field: " + field_name,
      );
      names.add(field_name);
      const member = this.consume_type_member(
        declaration_name,
        new Set([",", ")", "|"]),
      );
      fields.push(this.concrete_node(field_start, {
        name: field_name,
        type_name: member.text,
      }));

      if (member.recursive) {
        recursive = true;
      }

      if (this.match_symbol(")")) {
        break;
      }

      if (this.peek().kind === "symbol" && this.peek().text === "|") {
        throw this.error("Cannot mix product `,` and sum `|` entries");
      }

      this.expect_symbol(",");
      this.skip_newlines();

      expect(
        !(this.peek().kind === "symbol" && this.peek().text === ")"),
        "Type products do not allow a trailing comma",
      );
    }

    expect(positional !== undefined, "Missing product kind");
    return {
      body: this.concrete_node(start, {
        tag: "product",
        fields,
        positional,
      }),
      recursive,
    };
  }

  private starts_product_type(): boolean {
    if (this.peek().kind !== "symbol" || this.peek().text !== "(") {
      return false;
    }

    let depth = 0;

    for (let offset = 0;; offset += 1) {
      const token = this.peek(offset);
      expect(token.kind !== "eof", "Unterminated parenthesized type");

      if (token.kind !== "symbol") {
        continue;
      }

      if (token.text === "(") {
        depth += 1;
        continue;
      }

      if (token.text === ")") {
        depth -= 1;

        if (depth === 0) {
          return offset === 1;
        }

        continue;
      }

      if (depth === 1 && (token.text === "," || token.text === ".")) {
        return true;
      }
    }
  }

  private parse_sum_type(
    declaration_name: string,
  ): { cases: TypeField[]; recursive: boolean } {
    const cases: TypeField[] = [];
    const names = new Set<string>();
    let recursive = false;
    this.match_symbol("|");
    this.skip_newlines();

    while (true) {
      const case_start = this.index;
      this.expect_symbol(".");
      const case_name = this.expect_name("Expected sum case name");
      expect_snake_case(case_name, "Sum case");
      expect(!names.has(case_name), "Duplicate sum case: " + case_name);
      names.add(case_name);
      let type_name = "Unit";

      if (this.match_symbol("=")) {
        const member = this.consume_type_member(
          declaration_name,
          new Set(["|"]),
        );
        type_name = member.text;

        if (member.recursive) {
          recursive = true;
        }
      }

      cases.push(this.concrete_node(case_start, {
        name: case_name,
        type_name,
      }));

      if (this.match_symbol("|")) {
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind !== "newline") {
        break;
      }

      this.skip_newlines();

      if (!this.match_symbol("|")) {
        break;
      }

      this.skip_newlines();
    }

    expect(cases.length > 0, "Sum type requires at least one case");
    return { cases, recursive };
  }

  private consume_type_member(
    declaration_name: string,
    ends: Set<string>,
  ): { text: string; recursive: boolean } {
    const tokens: Token[] = [];
    let brackets = 0;
    let parens = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (brackets === 0 && parens === 0) {
        if (token.kind === "newline" && token.raw !== ";") {
          break;
        }

        if (token.kind === "symbol" && ends.has(token.text)) {
          break;
        }
      }

      if (token.kind === "symbol") {
        if (token.text === "[") {
          brackets += 1;
        } else if (token.text === "]") {
          brackets -= 1;
        } else if (token.text === "(") {
          parens += 1;
        } else if (token.text === ")") {
          parens -= 1;
        }
      }

      if (token.kind === "name") {
        if (token.text !== "_") {
          this.expect_type_reference_name(token.text, "Row member type");
        }
      }

      tokens.push(this.advance());
    }

    expect(tokens.length > 0, "Expected row member type");
    expect(brackets === 0, "Unterminated product type");
    expect(parens === 0, "Unterminated parenthesized type");
    let recursive = false;

    for (const token of tokens) {
      if (token.kind === "name" && token.text === declaration_name) {
        recursive = true;
      }
    }

    return { text: format_type_expr(parse_type_expr(tokens)), recursive };
  }
}
