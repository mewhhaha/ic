import { expect } from "../expect.ts";
import type { Param } from "./ast.ts";
import {
  expect_const_binding_name,
  expect_snake_case,
  is_snake_case,
} from "./names.ts";
import { ParserCursor } from "./parser_cursor.ts";
import {
  is_builtin_type_reference_name,
  unsupported_reserved_feature,
} from "./parser_support.ts";

export class ParserParams extends ParserCursor {
  protected allow_pascal_type_names = 0;
  protected affine_call_names = new Set<string>();
  protected try_single_param_arrow(): Param | undefined {
    const token = this.peek();

    if (token.kind !== "name") {
      return undefined;
    }

    if (this.peek(1).kind !== "symbol" || this.peek(1).text !== "=>") {
      return undefined;
    }

    const name = this.advance().text;
    this.expect_param_name(name);
    return { name, is_const: false, is_linear: false, annotation: undefined };
  }

  protected try_param_list_arrow(): Param[] | undefined {
    if (this.peek().kind !== "symbol" || this.peek().text !== "(") {
      return undefined;
    }

    const close = this.find_matching(this.index, "(", ")");
    const after = this.tokens[close + 1];
    expect(after, "Missing token after parameter list");

    if (after.kind !== "symbol" || after.text !== "=>") {
      return undefined;
    }

    this.expect_symbol("(");
    const params: Param[] = [];

    if (!this.match_symbol(")")) {
      while (true) {
        params.push(this.parse_param());

        if (this.match_symbol(")")) {
          break;
        }

        this.expect_symbol(",");
      }
    }

    return params;
  }

  protected parse_arrow_params(): Param[] {
    if (this.peek().kind === "symbol" && this.peek().text === "(") {
      this.expect_symbol("(");
      const params: Param[] = [];

      if (!this.match_symbol(")")) {
        while (true) {
          params.push(this.parse_param());

          if (this.match_symbol(")")) {
            break;
          }

          this.expect_symbol(",");
        }
      }

      return params;
    }

    const name = this.expect_name("Expected recursive parameter");
    this.expect_param_name(name);
    return [{ name, is_const: false, is_linear: false, annotation: undefined }];
  }

  protected is_rec_arrow(): boolean {
    if (this.peek().kind !== "name" || this.peek().text !== "rec") {
      return false;
    }

    const next = this.peek(1);

    if (next.kind === "name") {
      const after = this.peek(2);
      return after.kind === "symbol" && after.text === "=>";
    }

    if (next.kind !== "symbol" || next.text !== "(") {
      return false;
    }

    const close = this.find_matching(this.index + 1, "(", ")");
    const after = this.tokens[close + 1];
    expect(after, "Missing token after recursive parameter list");
    return after.kind === "symbol" && after.text === "=>";
  }

  protected parse_param(): Param {
    const is_const = this.match_name("const");
    const is_linear = this.match_symbol("!");
    const name = this.expect_name("Expected parameter name");
    let param_label = "Parameter";

    if (is_const) {
      param_label = "Const parameter";
    }

    this.expect_supported_name(name, param_label);

    if (is_const) {
      expect_snake_case(name, "Const parameter");
    } else {
      this.expect_param_name(name);
    }

    let annotation: string | undefined;

    if (this.match_symbol(":")) {
      annotation = this.consume_annotation();
    }

    return { name, is_const, is_linear, annotation };
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

  protected consume_annotation(): string {
    const parts: string[] = [];

    while (!this.is("eof")) {
      const token = this.peek();

      if (
        token.kind === "newline" ||
        (token.kind === "symbol" &&
          (token.text === "," || token.text === ")" || token.text === "=" ||
            token.text === "=>"))
      ) {
        break;
      }

      if (token.kind === "name") {
        this.expect_type_reference_name(token.text, "Type annotation");
      }

      parts.push(this.advance().text);
    }

    expect(parts.length > 0, "Expected type annotation");
    return parts.join("");
  }
}
