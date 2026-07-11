import type {
  Declaration,
  EffectDeclaration,
  EffectOperation,
  EffectParam,
  EffectResult,
  ModuleHeader,
  Source as SourceNode,
  Stmt,
  Token,
} from "./ast.ts";
import { expect } from "../expect.ts";
import { expect_snake_case } from "./names.ts";
import { ParserTypeDeclaration } from "./parser_type_declaration.ts";
import { unsupported_reserved_feature } from "./parser_support.ts";

export class ParserStmt extends ParserTypeDeclaration {
  constructor(
    tokens: Token[],
    private readonly allow_host_imports_for_test = false,
  ) {
    super(tokens);
  }

  parse_program(): SourceNode {
    let module: ModuleHeader | undefined;
    const declarations: Declaration[] = [];
    const statements: Stmt[] = [];
    this.skip_newlines();

    if (
      this.peek().kind === "name" && this.peek().text === "module" &&
      this.peek(1).kind === "symbol" && this.peek(1).text === "("
    ) {
      module = this.parse_module_header();
      this.skip_newlines();
    }

    while (!this.is("eof")) {
      if (this.peek().kind === "name" && this.peek().text === "declare") {
        declarations.push(this.parse_declaration());
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "effect") {
        this.expect_name("Expected effect");
        declarations.push(this.parse_effect_declaration("ix"));
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "type") {
        declarations.push(this.parse_type_declaration());
        this.skip_newlines();
        continue;
      }

      statements.push(this.parse_stmt());
      this.skip_newlines();
    }

    if (module || declarations.length > 0) {
      return { tag: "program", module, declarations, statements };
    }

    return { tag: "program", statements };
  }

  private parse_module_header(): ModuleHeader {
    this.expect_name("Expected module");
    this.expect_symbol("(");
    const params = [];
    this.allow_pascal_type_names += 1;

    try {
      if (!this.match_symbol(")")) {
        while (true) {
          params.push(this.parse_param());

          if (this.match_symbol(")")) {
            break;
          }

          this.expect_symbol(",");
        }
      }
    } finally {
      this.allow_pascal_type_names -= 1;
    }

    expect(this.match_name("where"), "Expected where after module header");
    return { params };
  }

  private parse_declaration(): Declaration {
    this.expect_name("Expected declare");

    if (this.match_name("effect")) {
      return this.parse_effect_declaration("host");
    }

    const name = this.expect_declaration_name("Record declaration");
    this.reserve_declaration_name(name, "Record declaration");
    this.allow_pascal_type_names += 1;

    try {
      return { tag: "record", name, fields: this.parse_type_field_list() };
    } finally {
      this.allow_pascal_type_names -= 1;
    }
  }

  private parse_effect_declaration(
    implementation: "host" | "ix",
  ): EffectDeclaration {
    const name = this.expect_declaration_name("Effect");
    this.reserve_declaration_name(name, "Effect declaration");
    this.effect_names.add(name);
    this.expect_symbol("{");
    this.skip_newlines();
    const operations: EffectOperation[] = [];

    while (!this.match_symbol("}")) {
      const operation = this.expect_name("Expected effect operation name");
      expect_snake_case(operation, "Effect operation");
      this.expect_symbol(":");
      this.expect_symbol("(");
      const params = this.parse_effect_params();
      this.expect_symbol("=>");
      const result = this.parse_effect_result(
        this.consume_effect_type(",", "}"),
      );
      operations.push({ name: operation, params, result });
      this.match_symbol(",");
      this.skip_newlines();
    }

    return { tag: "effect", implementation, name, operations };
  }

  private parse_effect_params(): EffectParam[] {
    const params: EffectParam[] = [];

    if (this.match_symbol(")")) {
      return params;
    }

    while (true) {
      params.push(this.parse_effect_param(this.consume_effect_type(",", ")")));

      if (this.match_symbol(")")) {
        break;
      }

      this.expect_symbol(",");
    }

    return params;
  }

  private parse_effect_param(text: string): EffectParam {
    const parts = text.split(/\s+/);

    if (parts.length === 1) {
      if (is_effect_scalar_type(text)) {
        return { type_name: text, ownership: "scalar" };
      }

      return { type_name: text, ownership: "ownership_transfer" };
    }

    let ownership = parts[0];
    const type_name = parts.slice(1).join("");
    expect(type_name.length > 0, "Expected effect parameter type");

    if (ownership === "&") {
      ownership = "bounded_borrow";
    }

    if (ownership === "#") {
      ownership = "frozen_shareable";
    }

    expect(
      ownership === "bounded_borrow" || ownership === "frozen_shareable" ||
        ownership === "ownership_transfer",
      "Unknown effect parameter ownership: " + ownership,
    );
    return { type_name, ownership };
  }

  private parse_effect_result(text: string): EffectResult {
    const parts = text.split(/\s+/);

    if (parts.length > 1) {
      let ownership = parts[0];
      const type_name = parts.slice(1).join("");
      expect(type_name.length > 0, "Expected effect result type");

      if (ownership === "&") {
        throw new Error("Effect results cannot use bounded borrow ownership");
      }

      if (ownership === "#") {
        ownership = "frozen_shareable";
      }

      expect(
        ownership === "unique_heap" || ownership === "frozen_shareable",
        "Unknown effect result ownership: " + ownership,
      );
      return { type_name, ownership };
    }

    if (is_effect_scalar_type(text)) {
      return { type_name: text, ownership: "scalar" };
    }

    return { type_name: text, ownership: "unique_heap" };
  }

  private consume_effect_type(...ends: string[]): string {
    const parts: string[] = [];

    while (!this.is("eof")) {
      const token = this.peek();

      if (token.kind === "newline") {
        break;
      }

      if (token.kind === "symbol" && ends.includes(token.text)) {
        break;
      }

      if (ends.length === 0 && token.kind === "symbol" && token.text === "}") {
        break;
      }

      parts.push(this.advance().text);
    }

    expect(parts.length > 0, "Expected effect operation type");
    return parts.join(" ");
  }

  private expect_declaration_name(label: string): string {
    const name = this.expect_name("Expected " + label.toLowerCase() + " name");
    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(name),
      label + " must use PascalCase: " + name,
    );
    return name;
  }

  protected parse_stmt(): Stmt {
    if (this.peek().kind === "name") {
      const feature = unsupported_reserved_feature(this.peek().text);

      if (feature) {
        return this.parse_unsupported_stmt(feature);
      }
    }

    if (this.match_name("let")) {
      return this.parse_bind("let");
    }

    if (this.match_name("const")) {
      return this.parse_bind("const");
    }

    if (
      this.peek().kind === "name" && this.peek(1).kind === "symbol" &&
      this.peek(1).text === "<-"
    ) {
      return this.parse_effect_bind();
    }

    if (this.peek().kind === "name" && this.peek().text === "host_import") {
      if (!this.allow_host_imports_for_test) {
        throw new Error(
          "`host_import` is not source syntax; use `declare effect` " +
            "and provide its resource through `Init`",
        );
      }

      return this.parse_host_import_stmt();
    }

    if (this.match_name("return")) {
      if (this.peek().kind === "symbol" && this.peek().text === "{") {
        return {
          tag: "return",
          value: {
            tag: "struct_value",
            type_expr: { tag: "var", name: "object_type" },
            fields: this.parse_record_field_list(),
          },
        };
      }

      return { tag: "return", value: this.parse_expr() };
    }

    if (this.peek().kind === "name" && this.peek().text === "if") {
      return this.parse_if_stmt();
    }

    if (this.peek().kind === "name") {
      const name = this.peek().text;
      const next = this.peek(1);

      if (next.kind === "symbol" && (next.text === "=" || next.text === ":=")) {
        expect_snake_case(name, "Runtime binding");
        this.advance();
        const op = this.advance();
        const value = this.parse_expr();

        if (op.text === "=") {
          return { tag: "assign", name, mode: "same", value };
        }

        return { tag: "assign", name, mode: "change", value };
      }

      if (next.kind === "symbol" && next.text === "[") {
        const close = this.find_matching(this.index + 1, "[", "]");
        let after_index = close + 1;

        while (true) {
          const token = this.tokens[after_index];

          if (!token || token.kind !== "newline") {
            break;
          }

          after_index += 1;
        }

        const after = this.tokens[after_index];

        if (after && after.kind === "symbol" && after.text === "=") {
          expect_snake_case(name, "Runtime binding");
          this.advance();
          this.expect_symbol("[");
          const index = this.parse_expr();
          this.expect_symbol("]");
          this.expect_symbol("=");
          return { tag: "index_assign", name, index, value: this.parse_expr() };
        }
      }
    }

    if (this.peek().kind === "name" && this.peek().text === "module") {
      return this.parse_module_bind();
    }

    if (this.peek().kind === "name" && this.peek().text === "import") {
      return this.parse_import_stmt();
    }

    if (this.peek().kind === "name" && this.peek().text === "for") {
      return this.parse_for_stmt();
    }

    if (
      this.peek().kind === "name" &&
      (this.peek().text === "break" || this.peek().text === "continue")
    ) {
      const keyword = this.advance().text;

      if (keyword === "break") {
        const next = this.peek();

        if (
          next.kind !== "newline" && next.kind !== "eof" &&
          !(next.kind === "symbol" && next.text === "}")
        ) {
          return { tag: "break", value: this.parse_expr() };
        }

        return { tag: "break" };
      }

      const next = this.peek();
      expect(
        next.kind === "newline" || next.kind === "eof" ||
          (next.kind === "symbol" && next.text === "}"),
        "Continue does not accept a value",
      );

      return { tag: "continue" };
    }

    return { tag: "expr", expr: this.parse_expr() };
  }
}

function is_effect_scalar_type(type_name: string): boolean {
  return type_name === "Unit" || type_name === "Int" || type_name === "I32" ||
    type_name === "U32" || type_name === "I64";
}
