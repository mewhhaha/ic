import { expect } from "../expect.ts";
import type { Field, FrontExpr, TypeField, TypePattern } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { ParserParams } from "./parser_params.ts";

export abstract class ParserAggregate extends ParserParams {
  protected abstract parse_expr(): FrontExpr;

  protected parse_bracket_value(): FrontExpr {
    this.expect_symbol("[");
    this.skip_newlines();
    const fields: Field[] = [];

    if (this.match_symbol("]")) {
      return {
        tag: "struct_value",
        type_expr: { tag: "var", name: "object_type" },
        fields,
        bracketed: "positional",
      };
    }

    const named = this.peek().kind === "symbol" && this.peek().text === ".";
    let index = 0;

    while (true) {
      if (named) {
        this.expect_symbol(".");
        const name = this.expect_name("Expected product field name");
        expect_snake_case(name, "Product field");
        this.expect_symbol("=");
        fields.push({ name, value: this.parse_expr() });
      } else {
        fields.push({
          name: "item_" + index.toString(),
          value: this.parse_expr(),
        });
      }

      index += 1;

      if (this.match_symbol("]")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();

      if (named) {
        expect(
          this.peek().kind === "symbol" && this.peek().text === ".",
          "Cannot mix named and positional product entries",
        );
      } else {
        expect(
          !(this.peek().kind === "symbol" && this.peek().text === "."),
          "Cannot mix positional and named product entries",
        );
      }
    }

    let bracketed: "named" | "positional" = "positional";

    if (named) {
      bracketed = "named";
    }

    return {
      tag: "struct_value",
      type_expr: { tag: "var", name: "object_type" },
      fields,
      bracketed,
    };
  }

  protected parse_field_list(): Field[] {
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: Field[] = [];

    while (!this.match_symbol("}")) {
      const name = this.expect_name("Expected field name");
      expect_snake_case(name, "Field");
      this.expect_symbol(":");
      const value = this.parse_expr();
      fields.push({ name, value });

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return fields;
  }

  protected parse_record_field_list(): Field[] {
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: Field[] = [];

    while (!this.match_symbol("}")) {
      const name = this.expect_name("Expected record field name");
      expect_snake_case(name, "Record field");
      let value: FrontExpr = { tag: "var", name };

      if (this.match_symbol(":")) {
        value = this.parse_expr();
      }

      fields.push({ name, value });

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return fields;
  }

  protected is_object_literal(): boolean {
    if (this.peek().kind !== "symbol" || this.peek().text !== "{") {
      return false;
    }

    let offset = 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    const first = this.peek(offset);

    if (first.kind !== "name") {
      return false;
    }

    offset += 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    const second = this.peek(offset);

    if (second.kind !== "symbol") {
      return false;
    }

    return second.text === ":" || second.text === ",";
  }

  protected parse_type_field_list(): TypeField[] {
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: TypeField[] = [];

    while (!this.match_symbol("}")) {
      const name = this.expect_name("Expected type field name");
      expect_snake_case(name, "Type field");
      this.expect_symbol(":");
      const type_name = this.consume_type_field_annotation();
      fields.push({ name, type_name });

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return fields;
  }

  protected parse_type_pattern(): TypePattern {
    const kind = this.expect_name("Expected type pattern");
    expect(
      kind === "struct" || kind === "union",
      "Expected struct or union type pattern",
    );
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: TypeField[] = [];
    let open = false;

    while (!this.match_symbol("}")) {
      if (this.match_symbol("..")) {
        open = true;

        if (this.match_symbol(",")) {
          this.skip_newlines();
        } else {
          this.skip_newlines();
        }

        continue;
      }

      const name = this.expect_name("Expected type pattern field name");
      expect_snake_case(name, "Type pattern field");
      this.expect_symbol(":");
      const type_name = this.consume_type_field_annotation();
      fields.push({ name, type_name });

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return { kind, fields, open };
  }

  protected consume_type_field_annotation(): string {
    const parts: string[] = [];

    while (!this.is("eof")) {
      const token = this.peek();

      if (
        token.kind === "newline" ||
        (token.kind === "symbol" &&
          (token.text === "," || token.text === "}"))
      ) {
        break;
      }

      if (token.kind === "name") {
        this.expect_type_reference_name(token.text, "Field type annotation");
      }

      parts.push(this.advance().text);
    }

    expect(parts.length > 0, "Expected field type annotation");
    return parts.join("");
  }
}
