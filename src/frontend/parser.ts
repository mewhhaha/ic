import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type {
  FrontExpr,
  FrontHostImport,
  FrontHostImportArgContract,
  FrontHostImportOwnerReason,
  FrontHostImportResultContract,
  Source as SourceNode,
  Stmt,
  Token,
} from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import {
  module_value,
  unsupported_reserved_feature,
} from "./parser_support.ts";
import { ParserExpr } from "./parser_expr.ts";
import { tokenize } from "./tokenize.ts";

export function parse_source(text: string): SourceNode {
  const parser = new Parser(tokenize(text));
  return parser.parse_program();
}

class Parser extends ParserExpr {
  constructor(tokens: Token[]) {
    super(tokens);
  }

  parse_program(): SourceNode {
    const statements: Stmt[] = [];
    this.skip_newlines();

    while (!this.is("eof")) {
      statements.push(this.parse_stmt());
      this.skip_newlines();
    }

    return { tag: "program", statements };
  }

  parse_stmt(): Stmt {
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

    if (this.peek().kind === "name" && this.peek().text === "host_import") {
      return this.parse_host_import_stmt();
    }

    if (this.match_name("return")) {
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
        return { tag: "break" };
      }

      return { tag: "continue" };
    }

    return { tag: "expr", expr: this.parse_expr() };
  }

  parse_module_bind(): Stmt {
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

  parse_import_stmt(): Stmt {
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

  parse_host_import_stmt(): Stmt {
    this.expect_name("Expected host_import");
    const name = this.expect_name("Expected host import name");
    this.expect_supported_name(name, "Host import");
    expect_snake_case(name, "Host import");
    expect(this.match_name("from"), "Expected from");
    const path = this.peek();
    expect(path.kind === "string", "Expected host import path");
    this.advance();
    const target = parse_host_import_target(path.text);
    this.expect_symbol("(");
    const params: ValType[] = [];
    const args: FrontHostImportArgContract[] = [];

    if (!this.match_symbol(")")) {
      while (true) {
        const param = this.parse_host_import_param();
        params.push(param.type);
        args.push(param.contract);

        if (this.match_symbol(")")) {
          break;
        }

        this.expect_symbol(",");
      }
    }

    this.expect_symbol("=>");
    const result = this.parse_host_import_result();
    const value: FrontHostImport = {
      name,
      module: target.module,
      field: target.field,
      params,
      result: result.type,
      args,
      result_owner: result.owner,
    };
    return { tag: "host_import", value };
  }

  private parse_host_import_param(): {
    type: ValType;
    contract: FrontHostImportArgContract;
  } {
    let contract_tag: FrontHostImportArgContract["tag"] = "scalar";

    if (this.peek().kind === "name") {
      const name = this.peek().text;

      if (is_host_import_arg_contract_name(name)) {
        this.advance();
        contract_tag = name;
      }
    }

    const type_name = this.expect_name("Expected host import parameter type");

    if (contract_tag === "scalar") {
      const type = host_import_scalar_value_type(type_name);

      if (!type) {
        throw new Error(
          "Host import parameter " + type_name +
            " needs bounded_borrow, frozen_shareable, or ownership_transfer",
        );
      }

      return { type, contract: { tag: "scalar" } };
    } else {
      const reason = host_import_owner_reason(type_name);
      return {
        type: host_import_owned_value_type(type_name),
        contract: { tag: contract_tag, reason },
      };
    }
  }

  private parse_host_import_result(): {
    type: ValType;
    owner: FrontHostImportResultContract | undefined;
  } {
    if (this.peek().kind === "name") {
      const contract_name = this.peek().text;

      if (
        contract_name === "unique_heap" ||
        contract_name === "frozen_shareable"
      ) {
        this.advance();
        const type_name = this.expect_name("Expected host import result type");
        const reason = host_import_owner_reason(type_name);
        const type = host_import_owned_value_type(type_name);

        if (contract_name === "unique_heap") {
          return { type, owner: { tag: "unique_heap", reason } };
        }

        return { type, owner: { tag: "frozen_shareable", reason } };
      }

      if (contract_name === "scalar") {
        this.advance();
      }
    }

    const type_name = this.expect_name("Expected host import result type");
    const type = host_import_scalar_value_type(type_name);

    if (!type) {
      throw new Error(
        "Host import result " + type_name +
          " needs unique_heap or frozen_shareable",
      );
    }

    return {
      type,
      owner: undefined,
    };
  }

  parse_if_stmt(): Stmt {
    this.expect_name("Expected if");

    if (this.peek().kind === "name" && this.peek().text === "let") {
      return this.parse_if_let_stmt_after_if();
    }

    const cond = this.parse_expr_without_postfix_block();
    const then_branch = this.parse_block();
    expect(then_branch.tag === "block", "Expected if body block");

    if (this.match_name("else")) {
      const else_branch = this.parse_block();
      return {
        tag: "expr",
        expr: { tag: "if", cond, then_branch, else_branch },
      };
    }

    return { tag: "if_stmt", cond, body: then_branch.statements };
  }

  parse_if_let_stmt_after_if(): Stmt {
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
    expect(then_branch.tag === "block", "Expected if let body block");

    if (this.match_name("else")) {
      const else_branch = this.parse_block();
      return {
        tag: "expr",
        expr: {
          tag: "if_let",
          case_name,
          value_name,
          target,
          then_branch,
          else_branch,
        },
      };
    }

    return {
      tag: "if_let_stmt",
      case_name,
      value_name,
      target,
      body: then_branch.statements,
    };
  }

  parse_for_stmt(): Stmt {
    this.expect_name("Expected for");
    const index = this.expect_name("Expected loop index");
    expect_snake_case(index, "Loop index");

    if (this.match_symbol(",")) {
      const item = this.expect_name("Expected collection item");
      expect_snake_case(item, "Collection item");
      expect(this.match_name("in"), "Expected in");
      const collection = this.parse_expr_without_postfix_block();
      const body = this.parse_block();
      expect(body.tag === "block", "Expected collection for body block");

      return {
        tag: "for_collection",
        index,
        item,
        collection,
        body: body.statements,
      };
    }

    expect(this.match_name("in"), "Expected in");
    const start = this.parse_expr_without_postfix_block();

    if (!this.match_symbol("..")) {
      const body = this.parse_block();
      expect(body.tag === "block", "Expected collection for body block");

      return {
        tag: "for_collection",
        index: undefined,
        item: index,
        collection: start,
        body: body.statements,
      };
    }

    const end = this.parse_expr_without_postfix_block();

    let step: FrontExpr = { tag: "num", type: "i32", value: 1 };

    if (this.match_name("by")) {
      step = this.parse_expr_without_postfix_block();
    }

    const body = this.parse_block();
    expect(body.tag === "block", "Expected for body block");
    return {
      tag: "for_range",
      index,
      start,
      end,
      step,
      body: body.statements,
    };
  }

  parse_bind(kind: "let" | "const"): Stmt {
    if (
      kind === "let" && this.peek().kind === "name" &&
      (this.peek().text === "struct" || this.peek().text === "union")
    ) {
      const pattern = this.parse_type_pattern();
      this.expect_symbol("=");
      return { tag: "type_check", pattern, target: this.parse_expr() };
    }

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

    if (kind === "const") {
      return {
        tag: "bind",
        kind,
        name,
        is_recursive,
        is_linear,
        annotation,
        value: this.parse_expr(),
      };
    }

    return {
      tag: "bind",
      kind,
      name,
      is_recursive,
      is_linear,
      annotation,
      value: this.parse_expr(),
    };
  }

  parse_unsupported_stmt(feature: string): Stmt {
    const text = this.consume_until_boundary();
    return { tag: "unsupported", feature, text };
  }
}

function parse_host_import_target(text: string): {
  module: string;
  field: string;
} {
  const dot = text.lastIndexOf(".");
  expect(dot > 0, "Expected host import path as module.field");
  expect(dot < text.length - 1, "Expected host import path as module.field");
  return {
    module: text.slice(0, dot),
    field: text.slice(dot + 1),
  };
}

function is_host_import_arg_contract_name(
  name: string,
): name is FrontHostImportArgContract["tag"] {
  if (name === "scalar") {
    return true;
  }

  if (name === "bounded_borrow") {
    return true;
  }

  if (name === "frozen_shareable") {
    return true;
  }

  if (name === "ownership_transfer") {
    return true;
  }

  return false;
}

function host_import_scalar_value_type(name: string): ValType | undefined {
  if (name === "Int" || name === "I32" || name === "U32") {
    return "i32";
  }

  if (name === "I64") {
    return "i64";
  }

  return undefined;
}

function host_import_owned_value_type(name: string): ValType {
  if (host_import_scalar_value_type(name)) {
    throw new Error("Unsupported host import owned type: " + name);
  }

  return "i32";
}

function host_import_owner_reason(
  name: string,
): FrontHostImportOwnerReason {
  if (name === "Text") {
    return "text";
  }

  if (name === "closure") {
    return "closure";
  }

  if (name === "runtime_union") {
    return "runtime_union";
  }

  if (name === "runtime_aggregate") {
    return "runtime_aggregate";
  }

  if (host_import_scalar_value_type(name)) {
    throw new Error("Unsupported host import owned type: " + name);
  }

  return { tag: "type_ref", name };
}
