import type { Env, FrontExpr, Stmt } from "./ast.ts";

export type FrontOwnershipTextHooks = {
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export function front_expr_is_static_shareable_text(
  expr: FrontExpr,
  env: Env,
  hooks: FrontOwnershipTextHooks,
): boolean {
  return hooks.visible_text_value(expr, env, new Set()) !== undefined;
}

export function unwrap_ownership_wrapper_expr(expr: FrontExpr): FrontExpr {
  let current = expr;

  while (
    current.tag === "borrow" || current.tag === "freeze" ||
    current.tag === "scratch"
  ) {
    if (current.tag === "scratch") {
      current = current.body;
    } else {
      current = current.value;
    }
  }

  return current;
}

export function unwrap_ownership_wrapper_context_expr(
  expr: FrontExpr,
): FrontExpr {
  const unwrapped = unwrap_ownership_wrapper_expr(expr);

  if (unwrapped !== expr) {
    return unwrap_ownership_wrapper_context_expr(unwrapped);
  }

  if (expr.tag === "captured") {
    return {
      tag: "captured",
      expr: unwrap_ownership_wrapper_context_expr(expr.expr),
      env: expr.env,
    };
  }

  if (expr.tag === "if") {
    return {
      tag: "if",
      cond: expr.cond,
      then_branch: unwrap_ownership_wrapper_context_expr(expr.then_branch),
      else_branch: unwrap_ownership_wrapper_context_expr(expr.else_branch),
      implicit_else: expr.implicit_else,
    };
  }

  if (expr.tag === "if_let") {
    return {
      tag: "if_let",
      case_name: expr.case_name,
      value_name: expr.value_name,
      target: expr.target,
      then_branch: unwrap_ownership_wrapper_context_expr(expr.then_branch),
      else_branch: unwrap_ownership_wrapper_context_expr(expr.else_branch),
      implicit_else: expr.implicit_else,
    };
  }

  if (expr.tag === "block") {
    return {
      tag: "block",
      statements: unwrap_ownership_wrapper_context_statements(expr.statements),
    };
  }

  return expr;
}

export function unwrap_ownership_wrapper_value(
  value: FrontExpr,
  env: Env,
): { value: FrontExpr; env: Env } {
  let current = value;
  let current_env = env;

  while (current.tag === "captured") {
    current_env = current.env;
    current = current.expr;
  }

  const unwrapped = unwrap_ownership_wrapper_context_expr(current);

  if (unwrapped === current) {
    return { value, env };
  }

  return { value: unwrapped, env: current_env };
}

function unwrap_ownership_wrapper_context_statements(stmts: Stmt[]): Stmt[] {
  const result: Stmt[] = [];

  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];

    if (!stmt) {
      continue;
    }

    const is_final = index + 1 >= stmts.length;

    if (stmt.tag === "expr" && is_final) {
      result.push({
        tag: "expr",
        expr: unwrap_ownership_wrapper_context_expr(stmt.expr),
      });
      continue;
    }

    if (stmt.tag === "return") {
      result.push({
        tag: "return",
        value: unwrap_ownership_wrapper_context_expr(stmt.value),
      });
      continue;
    }

    result.push(stmt);
  }

  return result;
}
