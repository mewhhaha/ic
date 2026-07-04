import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "./ast.ts";
import {
  front_type_from_type_name,
  is_builtin_type_name,
  same_type,
} from "./types.ts";

export type TypedBlockHooks = {
  resolve_annotation_type?: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export function single_expr_block_result(
  expr: Extract<FrontExpr, { tag: "block" }>,
): FrontExpr | undefined {
  if (expr.statements.length !== 1) {
    return undefined;
  }

  const stmt = expr.statements[0];
  expect(stmt, "Missing typed block statement");
  return block_result_expr(stmt);
}

export function simple_alias_block_value(
  expr: Extract<FrontExpr, { tag: "block" }>,
  type: FrontType,
  env: Env,
  hooks: TypedBlockHooks,
): FrontExpr | undefined {
  if (expr.statements.length !== 2) {
    return undefined;
  }

  const bind = expr.statements[0];
  const result = expr.statements[1];
  expect(bind, "Missing typed block alias binding");
  expect(result, "Missing typed block alias result");

  if (bind.tag !== "bind") {
    return undefined;
  }

  if (bind.kind !== "let") {
    return undefined;
  }

  if (bind.is_linear) {
    return undefined;
  }

  const result_expr = block_result_expr(result);

  if (!result_expr) {
    return undefined;
  }

  if (result_expr.tag !== "var" || result_expr.name !== bind.name) {
    return undefined;
  }

  if (bind.annotation) {
    let annotation_type: FrontType | undefined;

    if (hooks.resolve_annotation_type) {
      annotation_type = hooks.resolve_annotation_type(
        bind.annotation,
        env,
      );
    }

    if (!annotation_type && is_builtin_type_name(bind.annotation)) {
      annotation_type = front_type_from_type_name(bind.annotation);
    }

    if (!annotation_type) {
      return undefined;
    }

    if (!same_type(annotation_type, type)) {
      return undefined;
    }
  }

  return bind.value;
}

function block_result_expr(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}
