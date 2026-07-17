import { expect } from "../expect.ts";
import type { Param, Pattern, PatternMode, Token, TypeExpr } from "./ast.ts";
import { front_literal_expr } from "./literal.ts";
import {
  expect_const_binding_name,
  expect_snake_case,
  is_no_demand_name,
  is_snake_case,
} from "./names.ts";
import { ParserCursor } from "./parser_cursor.ts";
import {
  is_builtin_type_reference_name,
  unsupported_reserved_feature,
} from "./parser_support.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { record_annotation_name_sites } from "./name_site.ts";

export class ParserParams extends ParserCursor {
  protected allow_pascal_type_names = 0;
  protected affine_call_names = new Set<string>();

  protected override parser_state(): import("./parser_cursor.ts").ParserState {
    const state = super.parser_state();
    state.affine_call_names = new Set(this.affine_call_names);
    state.allow_pascal_type_names = this.allow_pascal_type_names;
    return state;
  }

  protected override restore_parser_state(
    state: import("./parser_cursor.ts").ParserState,
  ): void {
    super.restore_parser_state(state);
    expect(state.affine_call_names, "Missing affine parser checkpoint");
    expect(
      state.allow_pascal_type_names !== undefined,
      "Missing Pascal parser checkpoint",
    );
    this.affine_call_names = state.affine_call_names;
    this.allow_pascal_type_names = state.allow_pascal_type_names;
  }
  protected starts_pattern_arrow(offset = 0): boolean {
    let parens = 0;
    let brackets = 0;
    let braces = 0;

    for (
      let index = this.index + offset;
      index < this.tokens.length;
      index += 1
    ) {
      const token = this.tokens[index];
      expect(token, "Missing token while finding pattern arrow");

      if (token.kind === "eof") {
        return false;
      }

      if (token.kind === "newline") {
        if (parens > 0 || brackets > 0 || braces > 0) {
          continue;
        }

        return false;
      }

      if (token.kind !== "symbol") {
        continue;
      }

      if (
        parens === 0 && brackets === 0 && braces === 0 &&
        (token.text === "|" || token.text === "," ||
          this.infix_fixity(token.text) !== undefined)
      ) {
        return false;
      }

      if (
        token.text === "=>" && parens === 0 && brackets === 0 && braces === 0
      ) {
        return true;
      }

      if (token.text === "(") parens += 1;
      if (token.text === "[") brackets += 1;
      if (token.text === "{") braces += 1;
      if (token.text === ")") parens -= 1;
      if (token.text === "]") brackets -= 1;
      if (token.text === "}") braces -= 1;

      if (parens < 0 || brackets < 0 || braces < 0) {
        return false;
      }
    }

    return false;
  }

  protected parse_pattern(): Pattern {
    const start = this.index;
    const pattern = this.parse_pattern_inner();
    return this.concrete_node(start, pattern);
  }

  private parse_pattern_inner(): Pattern {
    let mode: PatternMode = "default";

    if (this.match_name("const")) {
      mode = "const";
    } else if (this.match_symbol("!")) {
      mode = "linear";
    }

    if (mode !== "default") {
      return this.parse_binding_pattern(mode);
    }

    const token = this.peek();
    const literal = front_literal_expr(token);

    if (literal) {
      this.advance();
      expect(
        literal.tag === "bool" || literal.tag === "num" ||
          literal.tag === "text",
        "Unsupported pattern literal",
      );
      return { tag: "literal", value: literal };
    }

    if (this.match_symbol("#")) {
      const name = this.expect_name("Expected atom pattern name");
      expect_snake_case(name, "Atom pattern");
      return { tag: "literal", value: { tag: "atom", name } };
    }

    if (this.match_symbol(".")) {
      const name = this.expect_name("Expected union case pattern name");
      expect_snake_case(name, "Union case pattern");
      let value: Pattern | undefined;

      if (this.starts_union_pattern_payload()) {
        value = this.parse_pattern();
      }

      return { tag: "union_case", name, value };
    }

    if (this.match_symbol("(")) {
      return this.parse_product_pattern();
    }

    if (this.match_symbol("[")) {
      return this.parse_bracket_pattern();
    }

    if (this.match_symbol("{")) {
      if (
        this.peek().kind === "name" ||
        (this.peek().kind === "symbol" &&
          (this.peek().text === "." || this.peek().text === "}"))
      ) {
        return this.parse_shape_pattern();
      }

      throw this.error(
        "Product patterns use `{ .name = pattern }` or positional `[...]`",
      );
    }

    if (
      token.kind === "name" && /^[A-Z][A-Za-z0-9]*$/.test(token.text)
    ) {
      this.advance();
      return { tag: "value", name: token.text };
    }

    return this.parse_binding_pattern("default");
  }

  private starts_union_pattern_payload(): boolean {
    const token = this.peek();

    if (token.kind === "newline" || token.kind === "eof") {
      return false;
    }

    if (token.kind === "name") {
      return token.text !== "if";
    }

    if (
      token.kind === "number" || token.kind === "string" ||
      token.kind === "character"
    ) {
      return true;
    }

    return token.kind === "symbol" &&
      (token.text === "!" || token.text === "." || token.text === "(" ||
        token.text === "[" || token.text === "{" || token.text === "#");
  }

  private parse_binding_pattern(mode: PatternMode): Pattern {
    const source_name = this.expect_name("Expected pattern binding");

    if (source_name === "_") {
      if (mode === "linear") {
        throw new Error("`!_` is not supported");
      }

      return { tag: "wildcard", mode };
    }

    if (mode === "const") {
      this.expect_const_binding_name(source_name);
    } else {
      this.expect_param_name(source_name);
    }

    let annotation: string | undefined;
    let type_annotation: TypeExpr | undefined;

    if (this.match_symbol(":")) {
      const parsed = this.consume_annotation();
      annotation = parsed.annotation;
      type_annotation = parsed.type_annotation;
    }

    const pattern: Extract<Pattern, { tag: "binding" }> = {
      tag: "binding",
      name: source_name,
      mode,
      annotation,
    };

    if (type_annotation) {
      pattern.type_annotation = type_annotation;
    }

    return pattern;
  }

  private parse_product_pattern(): Pattern {
    this.skip_newlines();

    if (this.match_symbol(")")) {
      return { tag: "unit" };
    }

    const entries = [this.parse_product_pattern_entry()];
    const first = entries[0];
    expect(first, "Missing parenthesized pattern");
    expect(
      first.label === undefined,
      "Product patterns use `[...]`; parentheses only group patterns",
    );

    if (this.match_symbol(")")) {
      return first.pattern;
    }

    this.expect_symbol(",");
    this.skip_newlines();

    while (true) {
      const entry = this.parse_product_pattern_entry();
      expect(
        entry.label === undefined,
        "Product patterns use `[...]`; parentheses only group named entries",
      );
      entries.push(entry);

      if (this.match_symbol(")")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();
    }

    return { tag: "product", entries, value_pack: true };
  }

  private parse_product_pattern_entry(): import("./ast.ts").ProductPatternEntry {
    let label: string | undefined;

    if (
      this.peek().kind === "symbol" && this.peek().text === "." &&
      this.peek(1).kind === "name" && this.peek(2).kind === "symbol" &&
      this.peek(2).text === "="
    ) {
      this.expect_symbol(".");
      label = this.expect_name("Expected product pattern label");
      expect_snake_case(label, "Product pattern label");
      this.expect_symbol("=");
    }

    const entry: import("./ast.ts").ProductPatternEntry = {
      pattern: this.parse_pattern(),
    };

    if (label !== undefined) {
      entry.label = label;
    }

    return entry;
  }

  private parse_bracket_pattern(): Pattern {
    this.skip_newlines();
    const items: Pattern[] = [];
    let rest: Pattern | undefined;

    if (this.match_symbol("]")) {
      return { tag: "product", entries: [] };
    }

    while (true) {
      if (this.match_rest_prefix()) {
        rest = this.parse_pattern();
        this.skip_newlines();
        this.expect_symbol("]");
        break;
      }

      items.push(this.parse_pattern());

      if (this.match_symbol("]")) {
        break;
      }

      this.expect_symbol(",");
      this.skip_newlines();
    }

    if (rest !== undefined) {
      return { tag: "array", items, rest };
    }

    return {
      tag: "product",
      entries: items.map((pattern) => ({ pattern })),
    };
  }

  private parse_shape_pattern(): Pattern {
    this.skip_newlines();
    const entries: import("./ast.ts").ProductPatternEntry[] = [];
    const names = new Set<string>();

    while (!this.match_symbol("}")) {
      const entry_start = this.index;
      const explicit = this.match_symbol(".");
      const label = this.expect_name("Expected product pattern label");
      expect_snake_case(label, "Product pattern label");
      expect(!names.has(label), "Duplicate product pattern label: " + label);
      names.add(label);
      let pattern: Pattern = {
        tag: "binding",
        name: label,
        mode: "default",
        annotation: undefined,
      };

      if (explicit && this.match_symbol("=")) {
        pattern = this.parse_pattern();
      } else if (this.match_symbol(":")) {
        const parsed = this.consume_annotation();
        pattern = {
          tag: "binding",
          name: label,
          mode: "default",
          annotation: parsed.annotation,
        };

        if (parsed.type_annotation !== undefined) {
          pattern.type_annotation = parsed.type_annotation;
        }
      }

      if (pattern.tag === "binding") {
        pattern = this.concrete_node(entry_start, pattern);
      }

      entries.push({ label, pattern });

      if (this.match_symbol(",")) {
        this.skip_newlines();
      } else {
        this.skip_newlines();
      }
    }

    return { tag: "product", entries };
  }

  protected match_rest_prefix(): boolean {
    if (
      this.peek().kind !== "symbol" || this.peek().text !== ".." ||
      this.peek(1).kind !== "symbol" || this.peek(1).text !== "."
    ) {
      return false;
    }

    this.advance();
    this.advance();
    return true;
  }

  protected parse_param(): Param {
    const start = this.index;
    const is_const = this.match_name("const");
    const is_linear = this.match_symbol("!");
    const name = this.expect_binding_name("Expected parameter name");
    let param_label = "Parameter";

    if (is_linear && is_no_demand_name(name)) {
      throw new Error("`!_` is not supported");
    }

    if (is_const) {
      param_label = "Const parameter";
    }

    if (!is_no_demand_name(name)) {
      this.expect_supported_name(name, param_label);

      if (is_const) {
        expect_snake_case(name, "Const parameter");
      } else {
        this.expect_param_name(name);
      }
    }

    let annotation: string | undefined;
    let type_annotation: TypeExpr | undefined;

    if (this.match_symbol(":")) {
      const parsed = this.consume_annotation();
      annotation = parsed.annotation;
      type_annotation = parsed.type_annotation;
    }

    const param: Param = { name, is_const, is_linear, annotation };

    if (type_annotation) {
      param.type_annotation = type_annotation;
    }

    return this.concrete_node(start, param);
  }

  protected expect_param_name(name: string): void {
    this.expect_supported_name(name, "Parameter");

    if (is_snake_case(name)) {
      return;
    }

    throw new Error("Parameter must use snake_case: " + name);
  }

  protected expect_supported_name(name: string, label: string): void {
    const feature = unsupported_reserved_feature(name);

    if (!feature) {
      return;
    }

    throw new Error(
      label + " is reserved for unsupported " + feature + ": " + name,
    );
  }

  protected expect_type_reference_name(name: string, label: string): void {
    this.expect_supported_name(name, label);

    if (is_builtin_type_reference_name(name)) {
      return;
    }

    if (this.type_names.has(name)) {
      return;
    }

    if (
      this.allow_pascal_type_names > 0 &&
      /^[A-Z][A-Za-z0-9]*$/.test(name)
    ) {
      return;
    }

    expect_snake_case(name, label);
  }

  protected expect_const_binding_name(name: string): void {
    expect_const_binding_name(name);
  }

  protected consume_annotation(): {
    annotation: string;
    type_annotation: TypeExpr | undefined;
  } {
    const tokens: Token[] = [];
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let angles = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (
        (token.kind === "newline" && token.raw !== ";") ||
        (parens === 0 && brackets === 0 && braces === 0 && angles === 0 &&
          token.kind === "name" && token.text === "if") ||
        (parens === 0 && brackets === 0 && braces === 0 && angles === 0 &&
          token.kind === "symbol" &&
          (token.text === "," || token.text === ")" || token.text === "=" ||
            token.text === "]" || token.text === "}" || token.text === "=>"))
      ) {
        break;
      }

      if (token.kind === "symbol" && token.text === "(") {
        parens += 1;
      } else if (token.kind === "symbol" && token.text === ")") {
        parens -= 1;
      } else if (token.kind === "symbol" && token.text === "[") {
        brackets += 1;
      } else if (token.kind === "symbol" && token.text === "]") {
        brackets -= 1;
      } else if (token.kind === "symbol" && token.text === "{") {
        braces += 1;
      } else if (token.kind === "symbol" && token.text === "}") {
        braces -= 1;
      } else if (token.kind === "symbol" && token.text === "<") {
        angles += 1;
      } else if (token.kind === "symbol" && token.text === ">") {
        angles -= 1;
      }

      tokens.push(this.advance());
    }

    expect(tokens.length > 0, "Expected type annotation");
    const parsed = parse_type_expr(tokens);
    record_annotation_name_sites(parsed, tokens);
    let type_annotation: TypeExpr | undefined;

    if (parsed.tag === "name") {
      this.expect_type_reference_name(parsed.name, "Type annotation");
    } else {
      type_annotation = parsed;
    }

    return { annotation: format_type_expr(parsed), type_annotation };
  }
}
