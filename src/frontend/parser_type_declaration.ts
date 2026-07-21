import { expect } from "../expect.ts";
import type { FrontExpr, Token, TypeDeclaration, TypeField } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { ParserStmtBinding } from "./parser_stmt/binding.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

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
      if (this.peek().kind === "name" && this.peek().text === "packed") {
        this.expect_name("Expected packed constructor");

        if (this.peek().kind === "name" && this.peek().text === "struct") {
          this.expect_name("Expected struct constructor");
          const product = this.parse_struct_constructor_shape(name);
          return {
            tag: "type",
            name,
            params,
            body: {
              tag: "packed",
              fields: product.fields,
              positional: false,
            },
            recursive: product.recursive,
          };
        }

        expect(
          this.starts_product_type() && this.peek().text === "[",
          "Packed types use `packed [...]` or `packed struct { ... }`",
        );
        const product = this.parse_product_type(name);
        return {
          tag: "type",
          name,
          params,
          body: {
            tag: "packed",
            fields: product.body.fields,
            positional: product.body.positional,
          },
          recursive: product.recursive,
        };
      }

      if (this.peek().kind === "name" && this.peek().text === "struct") {
        this.expect_name("Expected struct constructor");
        const product = this.parse_struct_constructor_shape(name);
        const shape: FrontExpr = {
          tag: "shape",
          entries: product.fields.map((field) => ({
            label: field.name,
            value: {
              tag: "set_type",
              type_expr: parse_type_expr(tokenize(field.type_name)),
            },
          })),
        };
        return {
          tag: "type",
          name,
          params,
          body: {
            tag: "product",
            fields: product.fields,
            positional: false,
            initializer: {
              tag: "app",
              func: { tag: "var", name: "struct" },
              arg: shape,
              args: [shape],
            },
          },
          recursive: product.recursive,
        };
      }

      if (this.starts_product_type()) {
        expect(
          this.peek().text === "[",
          "Product types use `[...]`; parentheses only group types",
        );
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
        this.peek().text === "|"
      ) {
        const body_start = this.index;
        const sum = this.parse_sum_type(name, true);
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

      if (this.peek().kind === "symbol" && this.peek().text === "`") {
        const body_start = this.index;
        const sum = this.parse_sum_type(name, false);
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
      let opaque = false;

      if (this.peek().kind === "name" && this.peek().text === "newtype") {
        this.expect_name("Expected newtype constructor");
        opaque = true;
      }

      const alias = this.consume_type_member(name, new Set());
      const body: Extract<TypeDeclaration["body"], { tag: "alias" }> = {
        tag: "alias",
        type_name: alias.text,
      };

      if (opaque) {
        body.opaque = true;
      }

      return {
        tag: "type",
        name,
        params,
        body: this.concrete_node(body_start, body),
        recursive: alias.recursive,
      };
    } finally {
      this.allow_pascal_type_names -= 1;
    }
  }

  private parse_sum_type(
    declaration_name: string,
    leading_pipe: boolean,
  ): { cases: TypeField[]; recursive: boolean } {
    const cases: TypeField[] = [];
    const names = new Set<string>();
    let recursive = false;
    if (leading_pipe) {
      this.expect_symbol("|");
      this.skip_newlines();
    }

    while (true) {
      const case_start = this.index;
      this.expect_symbol("`");
      const case_name = this.expect_name("Expected sum case name");
      expect(
        /^[A-Z][A-Za-z0-9]*$/.test(case_name),
        "Sum case must use PascalCase: " + case_name,
      );
      expect(!names.has(case_name), "Duplicate sum case: " + case_name);
      names.add(case_name);
      const member = this.consume_type_member(
        declaration_name,
        new Set(["|"]),
      );
      let type_name = member.text;

      if (type_name === "[]") {
        type_name = "Unit";
      }

      if (member.recursive) {
        recursive = true;
      }

      cases.push(this.concrete_node(case_start, {
        name: case_name,
        type_name,
      }));

      if (!leading_pipe) {
        if (this.peek().kind === "symbol" && this.peek().text === "|") {
          throw this.error("Multiple-case sums require a leading `|`");
        }

        break;
      }

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
    if (leading_pipe) {
      expect(cases.length > 1, "Single-case sums omit the leading `|`");
    }
    return { cases, recursive };
  }

  private parse_struct_constructor_shape(
    declaration_name: string,
  ): { fields: TypeField[]; recursive: boolean } {
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: TypeField[] = [];
    const names = new Set<string>();
    let recursive = false;

    while (!this.match_symbol("}")) {
      const start = this.index;
      this.expect_symbol(".");
      const field_name = this.expect_name("Expected product member");
      expect_snake_case(field_name, "product member");
      expect(
        !names.has(field_name),
        "Duplicate product member: " + field_name,
      );
      names.add(field_name);
      this.expect_symbol("=");
      const member = this.consume_type_member(
        declaration_name,
        new Set([",", "}"]),
      );
      fields.push(this.concrete_node(start, {
        name: field_name,
        type_name: member.text,
      }));

      if (member.recursive) {
        recursive = true;
      }

      this.match_symbol(",");
      this.skip_newlines();
    }

    expect(fields.length > 0, "struct constructor requires a member");
    return { fields, recursive };
  }

  private parse_product_type(
    declaration_name: string,
  ): {
    body: Extract<TypeDeclaration["body"], { tag: "product" }>;
    recursive: boolean;
  } {
    const start = this.index;
    const opening = this.peek().text;
    let closing = ")";

    if (opening === "[") {
      closing = "]";
    }

    this.expect_symbol(opening);
    this.skip_newlines();
    const fields: TypeField[] = [];
    let recursive = false;

    if (this.match_symbol(closing)) {
      return {
        body: this.concrete_node(start, {
          tag: "product",
          fields,
          positional: true,
        }),
        recursive,
      };
    }

    if (this.peek().kind === "symbol" && this.peek().text === ".") {
      throw this.error(
        "Named product types use `struct { .field = Type }`",
      );
    }

    while (true) {
      const field_start = this.index;
      const field_name = "item_" + fields.length.toString();
      const member = this.consume_type_member(
        declaration_name,
        new Set([",", closing, "|"]),
      );
      fields.push(this.concrete_node(field_start, {
        name: field_name,
        type_name: member.text,
      }));

      if (member.recursive) {
        recursive = true;
      }

      if (this.match_symbol(closing)) {
        break;
      }

      if (this.peek().kind === "symbol" && this.peek().text === "|") {
        throw this.error("Cannot mix product `,` and sum `|` entries");
      }

      this.expect_symbol(",");
      this.skip_newlines();

      expect(
        !(this.peek().kind === "symbol" && this.peek().text === closing),
        "Type products do not allow a trailing comma",
      );
    }

    return {
      body: this.concrete_node(start, {
        tag: "product",
        fields,
        positional: true,
      }),
      recursive,
    };
  }

  private starts_product_type(): boolean {
    const opening = this.peek().text;

    if (
      this.peek().kind !== "symbol" ||
      (opening !== "(" && opening !== "[")
    ) {
      return false;
    }

    let closing = ")";

    if (opening === "[") {
      closing = "]";
    }

    let depth = 0;

    for (let offset = 0;; offset += 1) {
      const token = this.peek(offset);
      expect(token.kind !== "eof", "Unterminated product type");

      if (token.kind !== "symbol") {
        continue;
      }

      if (token.text === opening) {
        depth += 1;
        continue;
      }

      if (token.text === closing) {
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
