import { expect } from "../../expect.ts";
import type { EffectContext, EffectRef, Stmt } from "../ast.ts";
import { expect_snake_case } from "../names.ts";
import { module_value } from "../parser_support.ts";
import { ParserStmtControl } from "./control.ts";

export abstract class ParserStmtBinding extends ParserStmtControl {
  protected parse_module_bind(): Stmt {
    this.expect_name("Expected module");
    const name = this.expect_name("Expected module name");
    this.expect_supported_name(name, "Module");
    expect_snake_case(name, "Module");
    this.expect_symbol("=");
    return {
      tag: "bind",
      kind: "const",
      name,
      is_linear: false,
      annotation: undefined,
      value: module_value(this.parse_expr()),
    };
  }

  protected parse_import_stmt(): Stmt {
    this.expect_name("Expected import");
    const name = this.expect_name("Expected import name");
    this.expect_supported_name(name, "Import");
    expect_snake_case(name, "Import");
    expect(this.match_name("from"), "Expected from");
    const path = this.peek();
    expect(path.kind === "string", "Expected import path");
    this.advance();
    return { tag: "import", name, path: path.text };
  }

  protected parse_bind(kind: "let" | "const"): Stmt {
    if (
      kind === "let" && this.peek().kind === "name" &&
      (this.peek().text === "struct" || this.peek().text === "union")
    ) {
      const pattern = this.parse_type_pattern();
      this.expect_symbol("=");
      return { tag: "type_check", pattern, target: this.parse_expr() };
    }

    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      return this.parse_bind_pattern(kind);
    }

    if (kind === "let" && this.is_resume_dup()) {
      return this.parse_resume_dup();
    }

    if (
      kind === "let" && this.peek().kind === "symbol" &&
      this.peek().text === "(" && this.peek(1).kind === "symbol" &&
      this.peek(1).text === "!"
    ) {
      return this.parse_state_bind();
    }

    const effect_context = this.try_effect_context();

    let is_recursive = false;

    if (kind === "let" && this.match_name("rec")) {
      is_recursive = true;
    }

    let is_linear = false;

    if (this.match_symbol("!")) {
      is_linear = true;
    }

    const name = this.expect_name("Expected binding name");
    let binding_label = "Const binding";

    if (kind === "let") {
      binding_label = "Runtime binding";
    }

    this.expect_supported_name(name, binding_label);

    if (kind === "let") {
      expect_snake_case(name, "Runtime binding");
    } else {
      this.expect_const_binding_name(name);
    }

    let annotation: string | undefined;

    if (this.match_symbol(":")) {
      annotation = this.consume_annotation();
    }

    this.expect_symbol("=");
    const value = this.parse_expr();

    if (is_linear) {
      this.affine_call_names.add(name);
    } else {
      this.affine_call_names.delete(name);
    }

    return {
      tag: "bind",
      kind,
      name,
      is_recursive,
      is_linear,
      annotation,
      effect_context,
      value,
    };
  }

  private is_resume_dup(): boolean {
    return this.peek().kind === "symbol" && this.peek().text === "(" &&
      this.peek(1).kind === "symbol" && this.peek(1).text === "!" &&
      this.peek(2).kind === "name" &&
      this.peek(3).kind === "symbol" && this.peek(3).text === "," &&
      this.peek(4).kind === "symbol" && this.peek(4).text === "!" &&
      this.peek(5).kind === "name" &&
      this.peek(6).kind === "symbol" && this.peek(6).text === ")" &&
      this.peek(7).kind === "symbol" && this.peek(7).text === "=" &&
      this.peek(8).kind === "name" && this.peek(8).text === "dup";
  }

  private parse_resume_dup(): Stmt {
    this.expect_symbol("(");
    this.expect_symbol("!");
    const left = this.expect_name("Expected left duplicated resumption");
    expect_snake_case(left, "Duplicated resumption");
    this.expect_symbol(",");
    this.expect_symbol("!");
    const right = this.expect_name("Expected right duplicated resumption");
    expect_snake_case(right, "Duplicated resumption");
    this.expect_symbol(")");
    this.expect_symbol("=");
    expect(this.match_name("dup"), "Expected dup");
    this.affine_call_names.add(left);
    this.affine_call_names.add(right);
    return { tag: "resume_dup", left, right, value: this.parse_expr() };
  }

  private parse_bind_pattern(kind: "let" | "const"): Stmt {
    this.expect_symbol("{");
    const items = [];

    while (!this.match_symbol("}")) {
      const is_linear = this.match_symbol("!");
      const name = this.expect_name("Expected destructured binding name");
      expect_snake_case(name, "Destructured binding");
      items.push({ name, is_linear });

      if (!this.match_symbol("}")) {
        this.expect_symbol(",");
      } else {
        break;
      }
    }

    this.expect_symbol("=");
    return { tag: "bind_pattern", kind, items, value: this.parse_expr() };
  }

  private parse_state_bind(): Stmt {
    this.expect_symbol("(");
    this.expect_symbol("!");
    const context = this.expect_name("Expected renewed effect context");
    this.expect_effect_context_name(context);
    this.expect_symbol(",");
    let value_name: string | undefined;

    if (this.match_symbol("(")) {
      this.expect_symbol(")");
    } else {
      value_name = this.expect_name("Expected state result binding");
      expect_snake_case(value_name, "State result binding");
    }

    this.expect_symbol(")");
    this.expect_symbol("=");
    return { tag: "state_bind", context, value_name, value: this.parse_expr() };
  }

  private try_effect_context(): EffectContext | undefined {
    if (this.peek().kind === "symbol" && this.peek().text === "(") {
      const context = this.peek(1);
      const separator = this.peek(2);

      if (
        context.kind !== "name" || separator.kind !== "symbol" ||
        separator.text !== "::"
      ) {
        return undefined;
      }

      this.expect_symbol("(");
      const name = this.expect_name("Expected effect context name");
      this.expect_effect_context_name(name);
      this.expect_symbol("::");
      this.expect_symbol("{");
      const operations: EffectRef[] = [];

      while (!this.match_symbol("}")) {
        const effect = this.expect_name("Expected effect name");
        this.expect_symbol(".");
        const operation = this.expect_name("Expected effect operation");
        expect_snake_case(operation, "Effect operation");
        operations.push({ effect, operation });

        if (!this.match_symbol("}")) {
          this.expect_symbol(",");
        } else {
          break;
        }
      }

      this.expect_symbol(")");
      return { name, operations };
    }

    const context = this.peek();
    const binding = this.peek(1);

    if (
      context.kind !== "name" || binding.kind !== "name" ||
      !/^[A-Z][A-Za-z0-9]*$/.test(context.text)
    ) {
      return undefined;
    }

    this.advance();
    return { name: context.text, operations: undefined };
  }

  private expect_effect_context_name(name: string): void {
    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(name),
      "Effect context must use PascalCase: " + name,
    );
  }

  protected parse_unsupported_stmt(feature: string): Stmt {
    const text = this.consume_until_boundary();
    return { tag: "unsupported", feature, text };
  }
}
