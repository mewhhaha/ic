import type { FrontExpr, Source, Stmt } from "./ast.ts";
import { contains_reserved_linear_effect } from "./linear_effect.ts";
import {
  validate_linear_lam,
  validate_linear_rec,
  validate_linear_rest,
} from "./linear_stmt.ts";

export { contains_reserved_linear_effect } from "./linear_effect.ts";
export {
  validate_linear_lam,
  validate_linear_rec,
  validate_linear_rest,
} from "./linear_stmt.ts";

export function validate_source_linear(source: Source): void {
  validate_linear_statements(source.statements);
}

export function linear_param_names(
  expr: Extract<FrontExpr, { tag: "lam" }>,
): Set<string> {
  const names = new Set<string>();

  for (const param of expr.params) {
    if (param.is_linear) {
      names.add(param.name);
    }
  }

  return names;
}

function validate_linear_statements(stmts: Stmt[]): void {
  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];

    if (!stmt) {
      continue;
    }

    validate_linear_stmt_lambdas(stmt);

    if (stmt.tag === "bind" && stmt.is_linear) {
      validate_linear_rest(stmt.name, stmts.slice(index + 1));
    }
  }
}

function validate_linear_stmt_lambdas(stmt: Stmt): void {
  switch (stmt.tag) {
    case "bind":
      validate_linear_expr_lambdas(stmt.value);
      return;

    case "assign":
      validate_linear_expr_lambdas(stmt.value);
      return;

    case "index_assign":
      validate_linear_expr_lambdas(stmt.index);
      validate_linear_expr_lambdas(stmt.value);
      return;

    case "for_range":
      validate_linear_expr_lambdas(stmt.start);
      validate_linear_expr_lambdas(stmt.end);
      validate_linear_expr_lambdas(stmt.step);
      validate_linear_statements(stmt.body);
      return;

    case "for_collection":
      validate_linear_expr_lambdas(stmt.collection);
      validate_linear_statements(stmt.body);
      return;

    case "if_stmt":
      validate_linear_expr_lambdas(stmt.cond);
      validate_linear_statements(stmt.body);
      return;

    case "if_let_stmt":
      validate_linear_expr_lambdas(stmt.target);
      validate_linear_statements(stmt.body);
      return;

    case "type_check":
      validate_linear_expr_lambdas(stmt.target);
      return;

    case "return":
      validate_linear_expr_lambdas(stmt.value);
      return;

    case "expr":
      validate_linear_expr_lambdas(stmt.expr);
      return;

    case "import":
    case "host_import":
    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function validate_linear_expr_lambdas(expr: FrontExpr): void {
  switch (expr.tag) {
    case "lam":
      if (
        contains_reserved_linear_effect(expr.body, linear_param_names(expr))
      ) {
        validate_linear_lam(expr);
      }
      validate_linear_expr_lambdas(expr.body);
      return;

    case "rec":
      if (rec_has_linear_params(expr)) {
        validate_linear_rec(expr);
      }
      validate_linear_expr_lambdas(expr.body);
      return;

    case "prim":
      validate_linear_expr_lambdas(expr.left);
      validate_linear_expr_lambdas(expr.right);
      return;

    case "app":
      validate_linear_expr_lambdas(expr.func);
      for (const arg of expr.args) {
        validate_linear_expr_lambdas(arg);
      }
      return;

    case "block":
      validate_linear_statements(expr.statements);
      return;

    case "comptime":
      validate_linear_expr_lambdas(expr.expr);
      return;

    case "borrow":
    case "freeze":
      validate_linear_expr_lambdas(expr.value);
      return;

    case "scratch":
      validate_linear_expr_lambdas(expr.body);
      return;

    case "captured":
      validate_linear_expr_lambdas(expr.expr);
      return;

    case "with":
      validate_linear_expr_lambdas(expr.base);
      for (const field of expr.fields) {
        validate_linear_expr_lambdas(field.value);
      }
      return;

    case "struct_value":
      validate_linear_expr_lambdas(expr.type_expr);
      for (const field of expr.fields) {
        validate_linear_expr_lambdas(field.value);
      }
      return;

    case "struct_update":
      validate_linear_expr_lambdas(expr.base);
      for (const field of expr.fields) {
        validate_linear_expr_lambdas(field.value);
      }
      return;

    case "if":
      validate_linear_expr_lambdas(expr.cond);
      validate_linear_expr_lambdas(expr.then_branch);
      validate_linear_expr_lambdas(expr.else_branch);
      return;

    case "if_let":
      validate_linear_expr_lambdas(expr.target);
      validate_linear_expr_lambdas(expr.then_branch);
      validate_linear_expr_lambdas(expr.else_branch);
      return;

    case "field":
      validate_linear_expr_lambdas(expr.object);
      return;

    case "index":
      validate_linear_expr_lambdas(expr.object);
      validate_linear_expr_lambdas(expr.index);
      return;

    case "union_case":
      if (expr.value) {
        validate_linear_expr_lambdas(expr.value);
      }
      if (expr.type_expr) {
        validate_linear_expr_lambdas(expr.type_expr);
      }
      return;

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;
  }
}

function rec_has_linear_params(
  expr: Extract<FrontExpr, { tag: "rec" }>,
): boolean {
  for (const param of expr.params) {
    if (param.is_linear) {
      return true;
    }
  }

  return false;
}
