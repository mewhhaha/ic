import { expect } from "../../expect.ts";
import type { FrontExpr, Stmt } from "../ast.ts";
import { expect_snake_case, is_no_demand_name } from "../names.ts";
import { ParserHostImport } from "../parser_host_import.ts";

export abstract class ParserStmtControl extends ParserHostImport {
  protected parse_if_stmt(): Stmt {
    this.expect_name("Expected if");

    if (this.starts_if_let_condition()) {
      return this.parse_if_let_stmt_after_if();
    }

    const cond = this.parse_expr_without_postfix_block();
    const then_branch = this.parse_block();
    expect(then_branch.tag === "block", "Expected if body block");
    const else_branch = this.parse_optional_else_branch();

    if (else_branch) {
      return {
        tag: "expr",
        expr: { tag: "if", cond, then_branch, else_branch },
      };
    }

    return { tag: "if_stmt", cond, body: then_branch.statements };
  }

  protected parse_for_stmt(): Stmt {
    this.expect_name("Expected for");
    const first = this.peek();
    let named_binding = false;

    if (first.kind === "name") {
      const after = this.peek(1);
      named_binding = (after.kind === "symbol" && after.text === ",") ||
        (after.kind === "name" && after.text === "in");
    }

    if (!named_binding) {
      const index = this.fresh_no_demand_name();
      const start = this.parse_expr_without_postfix_block();
      this.expect_symbol("..");
      return this.parse_range_for_rest(index, start);
    }

    const index = this.expect_binding_name("Expected loop index");
    if (!is_no_demand_name(index)) {
      expect_snake_case(index, "Loop index");
    }

    if (this.match_symbol(",")) {
      const item = this.expect_binding_name("Expected collection item");
      if (!is_no_demand_name(item)) {
        expect_snake_case(item, "Collection item");
      }
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

    return this.parse_range_for_rest(index, start);
  }

  private parse_range_for_rest(index: string, start: FrontExpr): Stmt {
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

  private parse_if_let_stmt_after_if(): Stmt {
    const pattern = this.parse_if_let_condition();
    const then_branch = this.parse_block();
    expect(then_branch.tag === "block", "Expected if let body block");
    const else_branch = this.parse_optional_else_branch();

    if (else_branch) {
      if (pattern.tag === "literal") {
        return {
          tag: "expr",
          expr: {
            tag: "if",
            cond: pattern.cond,
            then_branch,
            else_branch,
          },
        };
      }

      if (pattern.tag === "pattern") {
        return {
          tag: "expr",
          expr: {
            tag: "match",
            target: pattern.target,
            arms: [
              {
                pattern: pattern.pattern,
                guard: undefined,
                body: then_branch,
              },
              {
                pattern: { tag: "wildcard", mode: "default" },
                guard: undefined,
                body: else_branch,
              },
            ],
          },
        };
      }

      return {
        tag: "expr",
        expr: {
          tag: "if_let",
          case_name: pattern.case_name,
          value_name: pattern.value_name,
          target: pattern.target,
          then_branch,
          else_branch,
        },
      };
    }

    if (pattern.tag === "literal") {
      return {
        tag: "if_stmt",
        cond: pattern.cond,
        body: then_branch.statements,
      };
    }

    if (pattern.tag === "pattern") {
      return {
        tag: "expr",
        expr: {
          tag: "match",
          target: pattern.target,
          arms: [
            {
              pattern: pattern.pattern,
              guard: undefined,
              body: then_branch,
            },
            {
              pattern: { tag: "wildcard", mode: "default" },
              guard: undefined,
              body: { tag: "unit" },
            },
          ],
        },
      };
    }

    return {
      tag: "if_let_stmt",
      case_name: pattern.case_name,
      value_name: pattern.value_name,
      target: pattern.target,
      body: then_branch.statements,
    };
  }
}
