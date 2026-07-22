import type {
  AttributeGroup,
  Declaration,
  EffectDeclaration,
  EffectOperation,
  EffectParam,
  EffectResult,
  FrontExpr,
  ModuleHeader,
  Source as SourceNode,
  Stmt,
  Token,
  TypeExpr,
} from "./ast.ts";
import { expect } from "../expect.ts";
import { expect_snake_case } from "./names.ts";
import { ParserTypeDeclaration } from "./parser_type_declaration.ts";
import { unsupported_reserved_feature } from "./parser_support.ts";
import {
  derive_missing_source_spans,
  mark_source_span,
  type SyntaxDiagnostic,
} from "./syntax.ts";
import type { RecoveryInterval } from "./parser_cursor.ts";
import type { FixityTable } from "./fixity.ts";
import { is_fixity_keyword } from "./fixity.ts";
import { parse_type_expr } from "./type_expr.ts";

export class ParserStmt extends ParserTypeDeclaration {
  constructor(
    tokens: Token[],
    private readonly allow_host_imports_for_test = false,
    fixities?: FixityTable,
  ) {
    super(tokens);

    if (fixities !== undefined) {
      this.set_fixities(fixities);
    }
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
      const start = this.index;
      module = this.concrete_node(start, this.parse_module_header());
      this.skip_newlines();
    }

    while (!this.is("eof")) {
      const start = this.index;
      const attribute_groups = this.parse_attribute_groups();

      if (attribute_groups.length > 0) {
        this.skip_newlines();
      }

      if (this.peek().kind === "name" && this.peek().text === "declare") {
        declarations.push(this.concrete_node(
          start,
          this.attach_declaration_attributes(
            this.parse_declaration(),
            attribute_groups,
          ),
        ));
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "effect") {
        this.expect_name("Expected effect");
        declarations.push(
          this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_effect_declaration("duck"),
              attribute_groups,
            ),
          ),
        );
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "type") {
        declarations.push(
          this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_type_declaration(),
              attribute_groups,
            ),
          ),
        );
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "duck") {
        declarations.push(this.concrete_node(
          start,
          this.attach_declaration_attributes(
            this.parse_duck(),
            attribute_groups,
          ),
        ));
        this.skip_newlines();
        continue;
      }

      if (this.peek().kind === "name" && this.peek().text === "extend") {
        declarations.push(this.concrete_node(
          start,
          this.attach_declaration_attributes(
            this.parse_extension(),
            attribute_groups,
          ),
        ));
        this.skip_newlines();
        continue;
      }

      if (
        this.peek().kind === "name" &&
        is_fixity_keyword(this.peek().text)
      ) {
        declarations.push(this.concrete_node(
          start,
          this.attach_declaration_attributes(
            this.parse_fixity(),
            attribute_groups,
          ),
        ));
        this.skip_newlines();
        continue;
      }

      statements.push(
        this.parse_stmt_after_attributes(start, attribute_groups),
      );
      this.skip_newlines();
    }

    return this.finish_program(module, declarations, statements);
  }

  parse_program_with_diagnostics(): {
    source: SourceNode;
    diagnostics: SyntaxDiagnostic[];
    recovery_intervals: RecoveryInterval[];
  } {
    let module: ModuleHeader | undefined;
    const declarations: Declaration[] = [];
    const statements: Stmt[] = [];
    const diagnostics: SyntaxDiagnostic[] = [];
    const recovery_intervals: RecoveryInterval[] = [];
    this.begin_recovery(diagnostics, recovery_intervals);
    this.skip_newlines();

    while (!this.is("eof")) {
      const state = this.parser_state();
      const start = this.index;

      try {
        const attribute_groups = this.parse_attribute_groups();

        if (attribute_groups.length > 0) {
          this.skip_newlines();
        }

        if (
          module === undefined && this.peek().kind === "name" &&
          this.peek().text === "module" && this.peek(1).kind === "symbol" &&
          this.peek(1).text === "("
        ) {
          expect(
            attribute_groups.length === 0,
            "Module headers do not accept attributes",
          );
          module = this.concrete_node(start, this.parse_module_header());
        } else if (
          this.peek().kind === "name" && this.peek().text === "declare"
        ) {
          const declaration = this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_declaration(),
              attribute_groups,
            ),
          );
          declarations.push(declaration);
        } else if (
          this.peek().kind === "name" && this.peek().text === "effect"
        ) {
          this.expect_name("Expected effect");
          const declaration = this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_effect_declaration("duck"),
              attribute_groups,
            ),
          );
          declarations.push(declaration);
        } else if (this.peek().kind === "name" && this.peek().text === "type") {
          const declaration = this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_type_declaration(),
              attribute_groups,
            ),
          );
          declarations.push(declaration);
        } else if (
          this.peek().kind === "name" && this.peek().text === "duck"
        ) {
          declarations.push(this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_duck(),
              attribute_groups,
            ),
          ));
        } else if (
          this.peek().kind === "name" && this.peek().text === "extend"
        ) {
          declarations.push(this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_extension(),
              attribute_groups,
            ),
          ));
        } else if (
          this.peek().kind === "name" &&
          is_fixity_keyword(this.peek().text)
        ) {
          declarations.push(this.concrete_node(
            start,
            this.attach_declaration_attributes(
              this.parse_fixity(),
              attribute_groups,
            ),
          ));
        } else {
          const statement = this.parse_stmt_after_attributes(
            start,
            attribute_groups,
          );
          statements.push(statement);
        }
      } catch (error) {
        const failure = this.index;
        this.restore_parser_state(state);
        this.synchronize_statement();

        if (this.index === start && !this.is("eof")) {
          this.advance();
        }

        this.record_recovery(error, start, failure);
      }

      this.skip_newlines();
    }

    return {
      source: this.finish_program(module, declarations, statements),
      diagnostics,
      recovery_intervals,
    };
  }

  private finish_program(
    module: ModuleHeader | undefined,
    declarations: Declaration[],
    statements: Stmt[],
  ): SourceNode {
    let source: SourceNode;

    if (module || declarations.length > 0) {
      source = { tag: "program", module, declarations, statements };
    } else {
      source = { tag: "program", statements };
    }

    const first = this.tokens[0];
    const eof = this.tokens[this.tokens.length - 1];
    expect(first, "Missing first program token");
    expect(eof, "Missing EOF token");
    mark_source_span(source, { start: first.span.start, end: eof.span.end });
    derive_missing_source_spans(source, {
      start: first.span.start,
      end: eof.span.end,
    });
    return source;
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

  private parse_duck(): Declaration {
    this.expect_name("Expected duck");
    const name = this.expect_declaration_name("Duck");
    this.reserve_declaration_name(name, "Duck declaration");
    this.type_names.add(name);
    const roles: string[] = [];

    while (!(this.peek().kind === "symbol" && this.peek().text === "{")) {
      const role = this.expect_name("Expected duck role or `{`");
      expect(
        /^[A-Z][A-Za-z0-9]*$/.test(role),
        "Duck role must use PascalCase: " + role,
      );
      expect(!roles.includes(role), "Duplicate duck role: " + role);
      roles.push(role);
    }

    expect(roles.length > 0, "Duck declaration requires at least one role");
    this.expect_symbol("{");
    this.skip_newlines();
    const members: Extract<Declaration, { tag: "duck" }>["members"] = [];
    const types: Extract<Declaration, { tag: "duck" }>["types"] = [];
    const names = new Set<string>();

    this.allow_pascal_type_names += 1;

    try {
      while (!this.match_symbol("}")) {
        if (this.match_name("type")) {
          const type_name = this.expect_declaration_name("Duck type member");
          expect(!names.has(type_name), "Duplicate duck member: " + type_name);
          names.add(type_name);
          let default_type: TypeExpr | undefined;

          if (this.match_symbol("=")) {
            const annotation = this.consume_type_field_annotation();
            default_type = parse_type_expr(annotation.tokens);
          }

          types.push({ name: type_name, default_type });
          this.match_symbol(",");
          this.skip_newlines();
          continue;
        }

        this.expect_symbol(".");
        const member = this.expect_name("Expected duck member name");
        expect_snake_case(member, "Duck member");
        expect(!names.has(member), "Duplicate duck member: " + member);
        names.add(member);
        this.expect_symbol("=");
        const annotation = this.consume_type_field_annotation();
        members.push({
          name: member,
          type_expr: parse_type_expr(annotation.tokens),
        });
        this.match_symbol(",");
        this.skip_newlines();
      }
    } finally {
      this.allow_pascal_type_names -= 1;
    }

    expect(members.length > 0, "Duck declaration requires a member");
    return { tag: "duck", name, roles, types, members };
  }

  private parse_extension(): Declaration {
    this.expect_name("Expected extend");
    const type_name = this.expect_name("Expected extension type");
    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(type_name),
      "Extension type must use PascalCase: " + type_name,
    );
    const params: string[] = [];

    while (!(this.peek().kind === "symbol" && this.peek().text === "{")) {
      const param = this.expect_name("Expected extension parameter or `{`");
      expect(
        /^[A-Z][A-Za-z0-9]*$/.test(param),
        "Extension parameter must use PascalCase: " + param,
      );
      expect(
        !params.includes(param),
        "Duplicate extension parameter: " + param,
      );
      params.push(param);
    }

    this.expect_symbol("{");
    this.skip_newlines();
    const types: Extract<Declaration, { tag: "extend" }>["types"] = [];
    const fields: Extract<Declaration, { tag: "extend" }>["fields"] = [];
    const names = new Set<string>();
    this.allow_pascal_type_names += 1;

    try {
      while (!this.match_symbol("}")) {
        if (this.match_name("type")) {
          const name = this.expect_declaration_name("Extension type member");
          expect(!names.has(name), "Duplicate extension member: " + name);
          names.add(name);
          this.expect_symbol("=");
          const annotation = this.consume_type_field_annotation();
          types.push({ name, type_expr: parse_type_expr(annotation.tokens) });
        } else {
          this.expect_symbol(".");
          const name = this.expect_name("Expected extension member name");
          expect_snake_case(name, "Extension member");
          expect(!names.has(name), "Duplicate extension member: " + name);
          names.add(name);
          this.expect_symbol("=");
          fields.push({ name, value: this.parse_expr() });
        }

        this.match_symbol(",");
        this.skip_newlines();
      }
    } finally {
      this.allow_pascal_type_names -= 1;
    }

    return { tag: "extend", type_name, params, types, fields };
  }

  private parse_fixity(): Declaration {
    const keyword = this.expect_name("Expected fixity declaration");
    expect(
      is_fixity_keyword(keyword),
      "Unknown fixity declaration: " + keyword,
    );
    const precedence_token = this.peek();
    expect(
      precedence_token.kind === "number" && /^\d+$/.test(precedence_token.text),
      "Fixity precedence must be an integer from 0 to 100",
    );
    this.advance();
    const precedence = Number(precedence_token.text);
    expect(
      precedence >= 0 && precedence <= 100,
      "Fixity precedence must be an integer from 0 to 100, got " + precedence,
    );
    const operator_token = this.peek();
    expect(
      operator_token.kind === "symbol",
      "Fixity declaration requires an operator symbol",
    );
    this.advance();
    this.expect_symbol("=");
    let target_prefix = "";

    if (this.match_symbol("@")) {
      target_prefix = "@";
    }

    const target_parts = [this.expect_name("Expected fixity target")];

    while (this.match_symbol(".")) {
      target_parts.push(this.expect_name("Expected fixity target member"));
    }
    const target = target_prefix + target_parts.join(".");

    return {
      tag: "fixity",
      fixity: keyword as "infixl" | "infixr" | "infix" | "prefix",
      precedence,
      operator: operator_token.text,
      target,
    };
  }

  private parse_effect_declaration(
    implementation: "host" | "duck",
  ): EffectDeclaration {
    const name = this.expect_declaration_name("Effect");
    this.reserve_declaration_name(name, "Effect declaration");
    this.effect_names.add(name);
    const params: string[] = [];

    while (!(this.peek().kind === "symbol" && this.peek().text === "{")) {
      const param = this.expect_name("Expected effect type parameter or `{`");
      expect_snake_case(param, "Effect type parameter");
      expect(
        !params.includes(param),
        "Duplicate effect type parameter: " + param,
      );
      params.push(param);
    }

    expect(
      implementation === "duck" || params.length === 0,
      "Host effects require concrete ABI types",
    );

    this.expect_symbol("{");
    this.skip_newlines();
    const operations: EffectOperation[] = [];

    while (!this.match_symbol("}")) {
      const operation_start = this.index;
      let execution: EffectOperation["execution"];
      if (
        this.peek().kind === "name" && this.peek().text === "suspending"
      ) {
        this.expect_name("Expected `suspending`");
        execution = "suspending";
      }
      const operation = this.expect_name("Expected effect operation name");
      expect_snake_case(operation, "Effect operation");
      this.expect_symbol(":");
      const type_params: string[] = [];

      if (this.match_name("forall")) {
        while (!this.match_symbol(".")) {
          const param = this.expect_name(
            "Expected effect operation type parameter or `.`",
          );
          expect_snake_case(param, "Effect operation type parameter");
          expect(
            !type_params.includes(param),
            "Duplicate effect operation type parameter: " + param,
          );
          expect(
            !params.includes(param),
            "Effect operation type parameter shadows effect parameter: " +
              param,
          );
          type_params.push(param);
        }

        expect(
          type_params.length > 0,
          "Effect operation forall requires at least one type parameter",
        );
        expect(
          implementation === "duck",
          "Host effect operations require concrete ABI types",
        );
      }

      this.expect_symbol("(");
      const operation_params = this.parse_effect_params();
      this.expect_symbol("=>");
      const result_start = this.index;
      const result = this.concrete_node(
        result_start,
        this.parse_effect_result(this.consume_effect_type(",", "}")),
      );
      let parsed_operation: EffectOperation;
      if (execution === "suspending") {
        parsed_operation = {
          name: operation,
          type_params,
          execution,
          params: operation_params,
          result,
        };
      } else {
        parsed_operation = {
          name: operation,
          type_params,
          params: operation_params,
          result,
        };
      }
      operations.push(
        this.concrete_node(operation_start, parsed_operation),
      );
      this.match_symbol(",");
      this.skip_newlines();
    }

    return { tag: "effect", implementation, name, params, operations };
  }

  private parse_effect_params(): EffectParam[] {
    const params: EffectParam[] = [];

    if (this.match_symbol(")")) {
      return params;
    }

    while (true) {
      const start = this.index;
      params.push(this.concrete_node(
        start,
        this.parse_effect_param(this.consume_effect_type(",", ")")),
      ));

      if (this.match_symbol(")")) {
        break;
      }

      this.expect_symbol(",");
    }

    return params;
  }

  private parse_effect_param(text: string): EffectParam {
    const parts = text.split(/\s+/);

    if (parts[0] !== "&" && parts[0] !== "#") {
      if (is_legacy_effect_ownership(parts[0])) {
        throw new Error("Unknown effect parameter ownership: " + parts[0]);
      }

      let ownership: EffectParam["ownership"] = "ownership_transfer";

      if (is_effect_scalar_type(text)) {
        ownership = "scalar";
      }

      return { type_name: text, ownership };
    }

    const ownership_symbol = parts[0];
    const type_name = parts.slice(1).join("");
    expect(type_name.length > 0, "Expected effect parameter type");

    if (ownership_symbol === "&") {
      return { type_name, ownership: "bounded_borrow" };
    }

    if (ownership_symbol === "#") {
      return { type_name, ownership: "frozen_shareable" };
    }

    throw new Error("Unknown effect parameter ownership: " + ownership_symbol);
  }

  private parse_effect_result(text: string): EffectResult {
    const parts = text.split(/\s+/);

    if (parts.length > 1) {
      const ownership_symbol = parts[0];

      if (ownership_symbol === "&") {
        throw new Error("Effect results cannot use bounded borrow ownership");
      }

      if (ownership_symbol === "#") {
        const type_name = parts.slice(1).join("");
        expect(type_name.length > 0, "Expected effect result type");
        return { type_name, ownership: "frozen_shareable" };
      }

      if (is_legacy_effect_ownership(ownership_symbol)) {
        throw new Error(
          "Unknown effect result ownership: " + ownership_symbol,
        );
      }

      return { type_name: text, ownership: "unique_heap" };
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

  private parse_attribute_groups(): AttributeGroup[] {
    const groups: AttributeGroup[] = [];

    while (
      this.peek().kind === "symbol" && this.peek().text === "@" &&
      this.peek(1).kind === "symbol" && this.peek(1).text === "["
    ) {
      const start = this.index;
      const start_line = this.peek().line;
      this.expect_symbol("@");
      this.expect_symbol("[");
      this.skip_newlines();
      const attributes: FrontExpr[] = [];

      while (!this.match_symbol("]")) {
        attributes.push(this.parse_expr());
        this.skip_newlines();

        if (this.match_symbol("]")) {
          break;
        }

        this.expect_symbol(",");
        this.skip_newlines();
      }

      expect(attributes.length > 0, "Attribute groups cannot be empty");
      const group: AttributeGroup = { attributes };
      const end = this.tokens[this.index - 1];
      expect(end, "Missing attribute group closing token");

      if (end.line > start_line) {
        group.multiline = true;
      }

      groups.push(this.concrete_node(start, group));
      this.skip_newlines();
    }

    return groups;
  }

  private attach_declaration_attributes(
    declaration: Declaration,
    groups: AttributeGroup[],
  ): Declaration {
    if (groups.length > 0) {
      declaration.attribute_groups = groups;
    }

    return declaration;
  }

  private parse_stmt_after_attributes(
    start: number,
    groups: AttributeGroup[],
  ): Stmt {
    const statement = this.parse_stmt_inner();

    if (groups.length > 0) {
      expect(
        statement.tag === "bind" && statement.effectful !== true,
        "Attributes can only annotate named bindings and declarations",
      );
      statement.attribute_groups = groups;
    }

    return this.concrete_node(start, statement);
  }

  protected parse_stmt(): Stmt {
    const start = this.index;
    const attribute_groups = this.parse_attribute_groups();

    if (attribute_groups.length > 0) {
      this.skip_newlines();
    }

    return this.parse_stmt_after_attributes(start, attribute_groups);
  }

  private parse_stmt_inner(): Stmt {
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
        const value_start = this.index;
        expect(
          this.is_shape_literal(0, true),
          "Module exports and runtime shapes use `{ name }` or " +
            "`{ .name = value }`",
        );
        const shape = this.parse_shape_value();

        if (this.block_depth > 0) {
          return { tag: "return", value: shape };
        }

        return {
          tag: "return",
          value: this.concrete_node(value_start, {
            tag: "struct_value",
            type_expr: { tag: "var", name: "object_type" },
            fields: shape.entries.map((entry) => {
              expect(entry.label, "Module export requires a name");
              return { name: entry.label, value: entry.value };
            }),
          }),
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

function is_legacy_effect_ownership(name: string | undefined): boolean {
  return name === "bounded_borrow" || name === "frozen_shareable" ||
    name === "ownership_transfer" || name === "unique_heap" ||
    name === "scalar";
}

function is_effect_scalar_type(type_name: string): boolean {
  return type_name === "Unit" || type_name === "Bool" || type_name === "Char" ||
    type_name === "Int" || type_name === "I32" || type_name === "U32" ||
    type_name === "I64" || type_name === "F32" || type_name === "F64";
}
