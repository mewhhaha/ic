import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type {
  FrontHostImport,
  FrontHostImportArgContract,
  FrontHostImportOwnerReason,
  FrontHostImportResultContract,
  Stmt,
} from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { ParserExpr } from "./parser_expr.ts";

export abstract class ParserHostImport extends ParserExpr {
  protected parse_host_import_stmt(): Stmt {
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

    if (this.match_symbol("&")) {
      contract_tag = "bounded_borrow";
    } else if (this.match_symbol("#")) {
      contract_tag = "frozen_shareable";
    }

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

      if (type) {
        return { type, contract: { tag: "scalar" } };
      }

      const reason = host_import_owner_reason(type_name);
      return {
        type: host_import_owned_value_type(type_name),
        contract: { tag: "ownership_transfer", reason },
      };
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
    if (this.match_symbol("&")) {
      throw new Error(
        "Host import results cannot use bounded borrow ownership",
      );
    }

    if (this.match_symbol("#")) {
      const type_name = this.expect_name("Expected host import result type");
      const reason = host_import_owner_reason(type_name);
      const type = host_import_owned_value_type(type_name);
      return { type, owner: { tag: "frozen_shareable", reason } };
    }

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

    if (type) {
      return {
        type,
        owner: undefined,
      };
    }

    const reason = host_import_owner_reason(type_name);
    return {
      type: host_import_owned_value_type(type_name),
      owner: { tag: "unique_heap", reason },
    };
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

function host_import_scalar_value_type(
  name: string,
): ValType | undefined {
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

  if (name === "Bytes") {
    return "bytes";
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
