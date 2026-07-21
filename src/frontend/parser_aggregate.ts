import { expect } from "../expect.ts";
import type {
  ComputedTypeMember,
  FrontExpr,
  ProductExprEntry,
  Token,
  TypeField,
  TypePattern,
} from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { record_name_site } from "./name_site.ts";
import { ParserParams } from "./parser_params.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";

export abstract class ParserAggregate extends ParserParams {
  protected abstract parse_expr(): FrontExpr;

  protected parse_bracket_value(): FrontExpr {
    const start = this.index;
    const value = this.parse_bracket_value_inner();
    return this.concrete_node(start, value);
  }

  private parse_bracket_value_inner(): FrontExpr {
    this.expect_symbol("[");
    this.skip_newlines();
    const entries: ProductExprEntry[] = [];

    if (this.match_symbol("]")) {
      return { tag: "product", entries: [] };
    }

    if (this.match_rest_prefix()) {
      const rest = this.parse_expr();
      this.expect_symbol(",");
      this.skip_newlines();

      while (true) {
        const entry = this.parse_product_expr_entry();
        expect(
          entry.label === undefined,
          "Product spreads cannot be combined with labels",
        );
        entries.push(entry);

        if (this.match_symbol("]")) {
          break;
        }

        this.expect_symbol(",");
        this.skip_newlines();
      }

      return {
        tag: "array",
        items: entries.map((entry) => entry.value),
        rest,
        leading_rest: true,
      };
    }

    const first = this.parse_product_expr_entry();

    if (this.match_array_separator()) {
      expect(
        first.label === undefined,
        "Repeated product values cannot have labels",
      );
      const length = this.parse_expr();
      this.expect_symbol("]");
      return { tag: "array_repeat", value: first.value, length };
    }

    entries.push(first);

    if (this.match_symbol("]")) {
      return { tag: "product", entries };
    }

    this.expect_symbol(",");
    this.skip_newlines();
    let rest: FrontExpr | undefined;

    while (true) {
      if (this.match_rest_prefix()) {
        rest = this.parse_expr();
        this.skip_newlines();
        this.expect_symbol("]");
        break;
      }

      entries.push(this.parse_product_expr_entry());

      if (this.match_symbol("]")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();
    }

    if (rest !== undefined) {
      const items = entries.map((entry) => {
        expect(
          entry.label === undefined,
          "Product spreads cannot be combined with labels",
        );
        return entry.value;
      });
      return { tag: "array", items, rest };
    }

    return { tag: "product", entries };
  }

  protected parse_shape_value(): Extract<FrontExpr, { tag: "shape" }> {
    const start = this.index;
    this.expect_symbol("{");
    this.skip_newlines();
    const entries: ProductExprEntry[] = [];
    const names = new Set<string>();

    while (!this.match_symbol("}")) {
      const entry_start = this.index;
      const explicit = this.match_symbol(".");
      const label_token = this.peek();
      const label = this.expect_name("Expected shape member name");
      expect_snake_case(label, "Shape member");
      expect(!names.has(label), "Duplicate shape member: " + label);
      names.add(label);
      let value: FrontExpr;

      if (explicit) {
        this.expect_symbol("=");
        value = this.parse_expr();
      } else {
        value = this.concrete_node(entry_start, { tag: "var", name: label });
        record_name_site(value, "name", label, label_token.span);
      }

      const entry = this.concrete_node(entry_start, {
        label,
        value,
      });
      record_name_site(entry, "name", label, label_token.span);
      entries.push(entry);

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return this.concrete_node(start, { tag: "shape", entries });
  }

  protected parse_computed_type_members(): ComputedTypeMember[] {
    this.expect_symbol("{");
    this.skip_newlines();
    const members: ComputedTypeMember[] = [];

    while (!this.match_symbol("}")) {
      this.expect_symbol(".");
      this.expect_symbol("[");
      const name = this.parse_expr();
      this.expect_symbol("]");
      this.expect_symbol("=");
      members.push({ name, value: this.parse_expr() });
      this.match_symbol(",");
      this.skip_newlines();
    }

    return members;
  }

  protected parse_parenthesized_value(): FrontExpr {
    this.skip_newlines();

    if (this.match_symbol(")")) {
      return { tag: "unit" };
    }

    const first = this.parse_product_expr_entry();

    expect(
      first.label === undefined,
      "Product values use `[...]`; parentheses only group expressions",
    );
    this.skip_newlines();

    if (this.match_symbol(")")) {
      return first.value;
    }

    this.expect_symbol(",");
    this.skip_newlines();
    const entries = [first];

    while (true) {
      const entry = this.parse_product_expr_entry();
      expect(
        entry.label === undefined,
        "Product values use `[...]`; parentheses only group named entries",
      );
      entries.push(entry);
      this.skip_newlines();

      if (this.match_symbol(")")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();
    }

    return { tag: "product", entries, value_pack: true };
  }

  protected parse_parenthesized_call(): {
    arg: FrontExpr;
    args: FrontExpr[];
  } {
    this.skip_newlines();

    if (this.match_symbol(")")) {
      return { arg: { tag: "unit" }, args: [] };
    }

    const first = this.parse_product_expr_entry();
    expect(
      first.label === undefined,
      "Product values use `[...]`; parentheses only group expressions",
    );
    this.skip_newlines();

    if (this.match_symbol(")")) {
      if (first.value.tag === "unit") {
        return { arg: first.value, args: [] };
      }

      return { arg: first.value, args: [first.value] };
    }

    this.expect_symbol(",");
    this.skip_newlines();
    const entries = [first];

    while (true) {
      const entry = this.parse_product_expr_entry();
      expect(
        entry.label === undefined,
        "Product values use `[...]`; parentheses only group named entries",
      );
      entries.push(entry);
      this.skip_newlines();

      if (this.match_symbol(")")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();
    }

    return {
      arg: { tag: "product", entries, value_pack: true },
      args: entries.map((entry) => entry.value),
    };
  }

  protected parse_product_expr_entry(): ProductExprEntry {
    let label: string | undefined;
    let label_token: Token | undefined;

    if (
      this.peek().kind === "symbol" && this.peek().text === "." &&
      this.peek(1).kind === "name" && this.peek(2).kind === "symbol" &&
      this.peek(2).text === "="
    ) {
      label_token = this.peek(1);
      this.expect_symbol(".");
      label = this.expect_name("Expected product label");
      expect_snake_case(label, "Product label");
      this.expect_symbol("=");
    }

    const entry: ProductExprEntry = { value: this.parse_expr() };

    if (label !== undefined) {
      entry.label = label;
      expect(label_token, "Missing product label token");
      record_name_site(entry, "name", label, label_token.span);
    }

    return entry;
  }

  private match_array_separator(): boolean {
    const token = this.peek();

    if (token.kind !== "newline" || token.raw !== ";") {
      return false;
    }

    this.advance();
    return true;
  }

  protected is_shape_literal(
    offset = 0,
    allow_single_shorthand = false,
  ): boolean {
    if (
      this.peek(offset).kind !== "symbol" || this.peek(offset).text !== "{"
    ) {
      return false;
    }

    offset += 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    if (
      this.peek(offset).kind === "symbol" && this.peek(offset).text === "}"
    ) {
      return true;
    }

    if (
      this.peek(offset).kind === "symbol" &&
      this.peek(offset).text === "." &&
      this.peek(offset + 1).kind === "name" &&
      this.peek(offset + 2).kind === "symbol" &&
      this.peek(offset + 2).text === "="
    ) {
      return true;
    }

    if (this.peek(offset).kind !== "name") {
      return false;
    }

    if (allow_single_shorthand) {
      return true;
    }

    offset += 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    return this.peek(offset).kind === "symbol" &&
      this.peek(offset).text === ",";
  }

  protected is_computed_type_member_literal(offset = 0): boolean {
    if (
      this.peek(offset).kind !== "symbol" || this.peek(offset).text !== "{"
    ) {
      return false;
    }

    offset += 1;

    while (this.peek(offset).kind === "newline") {
      offset += 1;
    }

    return this.peek(offset).kind === "symbol" &&
      this.peek(offset).text === "." &&
      this.peek(offset + 1).kind === "symbol" &&
      this.peek(offset + 1).text === "[";
  }

  protected parse_type_field_list(): TypeField[] {
    this.expect_symbol("{");
    this.skip_newlines();
    const fields: TypeField[] = [];

    while (!this.match_symbol("}")) {
      const field_start = this.index;
      const name_token = this.peek();
      const name = this.expect_name("Expected type field name");
      expect_snake_case(name, "Type field");
      this.expect_symbol(":");
      const annotation = this.consume_type_field_annotation();
      const field = { name, type_name: annotation.text };
      record_name_site(field, "name", name, name_token.span);
      record_type_field_annotation_sites(field, annotation.tokens);
      fields.push(this.concrete_node(field_start, field));

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return fields;
  }

  protected parse_type_pattern(): TypePattern {
    const start = this.index;
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

      this.expect_symbol(".");
      const name_token = this.peek();
      const name = this.expect_name("Expected type pattern field name");
      const field_start = this.index - 2;
      if (kind === "union") {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
          throw new Error("Union case must use PascalCase: " + name);
        }
      } else {
        expect_snake_case(name, "Type pattern field");
      }
      this.expect_symbol("=");
      const annotation = this.consume_type_field_annotation();
      const field = { name, type_name: annotation.text };
      record_name_site(field, "name", name, name_token.span);
      record_type_field_annotation_sites(field, annotation.tokens);
      fields.push(this.concrete_node(field_start, field));

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return this.concrete_node(start, { kind, fields, open });
  }

  protected consume_type_field_annotation(): { text: string; tokens: Token[] } {
    const tokens: Token[] = [];
    let brackets = 0;
    let parens = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (
        (brackets === 0 && parens === 0 && token.kind === "newline" &&
          token.raw !== ";") ||
        (brackets === 0 && parens === 0 && token.kind === "symbol" &&
          (token.text === "," || token.text === "}"))
      ) {
        break;
      }

      if (token.kind === "symbol") {
        if (token.text === "[") brackets += 1;
        if (token.text === "]") brackets -= 1;
        if (token.text === "(") parens += 1;
        if (token.text === ")") parens -= 1;
      }

      if (token.kind === "name" && token.text !== "_") {
        this.expect_type_reference_name(token.text, "Field type annotation");
      }

      tokens.push(this.advance());
    }

    expect(tokens.length > 0, "Expected field type annotation");
    return { text: format_type_expr(parse_type_expr(tokens)), tokens };
  }
}

function record_type_field_annotation_sites(
  field: TypeField,
  tokens: Token[],
): void {
  let index = 0;

  for (const token of tokens) {
    if (token.kind === "name") {
      record_name_site(field, "type_name", token.text, token.span, index);
      index += 1;
    }
  }
}
