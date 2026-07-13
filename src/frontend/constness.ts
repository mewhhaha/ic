import type { Env, FrontExpr, Stmt } from "./ast.ts";
import { lookup } from "./env.ts";
import { is_builtin_type_name } from "./types.ts";

export function is_const_builtin_name(name: string): boolean {
  return name === "fail" || name === "size_of" || name === "align_of" ||
    name === "layout" || name === "is_struct" || name === "is_union" ||
    name === "has" || name === "fields_of" || name === "cases_of" ||
    name === "len" || name === "get" ||
    is_builtin_type_name(name) ||
    name === "object_type" || name === "layout_type" ||
    name === "field_offsets_type";
}

export function validate_const_expr(
  expr: FrontExpr,
  env: Env,
  bound: Set<string>,
  message: string,
): void {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "text":
    case "type_name":
      return;

    case "var": {
      if (bound.has(expr.name)) {
        return;
      }

      if (is_const_builtin_name(expr.name)) {
        return;
      }

      const binding = lookup(env, expr.name);

      if (binding && binding.is_const) {
        return;
      }

      throw new Error(message + ": " + expr.name);
    }

    case "prim":
      validate_const_expr(expr.left, env, bound, message);
      validate_const_expr(expr.right, env, bound, message);
      return;

    case "lam": {
      const local = new Set(bound);

      for (const param of expr.params) {
        local.add(param.name);
      }

      validate_const_expr(expr.body, env, local, message);
      return;
    }

    case "rec": {
      const local = new Set(bound);

      for (const param of expr.params) {
        local.add(param.name);
      }

      validate_const_expr(expr.body, env, local, message);
      return;
    }

    case "app":
      validate_const_expr(expr.func, env, bound, message);

      for (const arg of expr.args) {
        validate_const_expr(arg, env, bound, message);
      }

      return;

    case "block":
      validate_const_block(expr.statements, env, bound, message);
      return;

    case "comptime":
      validate_const_expr(expr.expr, env, bound, message);
      return;

    case "borrow":
      validate_const_expr(expr.value, env, bound, message);
      return;

    case "freeze":
      validate_const_expr(expr.value, env, bound, message);
      return;

    case "scratch":
      validate_const_expr(expr.body, env, bound, message);
      return;

    case "loop":
      throw new Error(message);

    case "captured":
      validate_const_expr(expr.expr, expr.env, bound, message);
      return;

    case "with":
      validate_const_expr(expr.base, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "struct_type":
      return;

    case "struct_value":
      validate_const_expr(expr.type_expr, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "struct_update":
      validate_const_expr(expr.base, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "union_type":
      return;

    case "if":
      validate_const_expr(expr.cond, env, bound, message);
      validate_const_expr(expr.then_branch, env, bound, message);
      validate_const_expr(expr.else_branch, env, bound, message);
      return;

    case "if_let": {
      const local = new Set(bound);
      validate_const_expr(expr.target, env, bound, message);

      if (expr.value_name) {
        local.add(expr.value_name);
      }

      validate_const_expr(expr.then_branch, env, local, message);
      validate_const_expr(expr.else_branch, env, bound, message);
      return;
    }

    case "field":
      validate_const_expr(expr.object, env, bound, message);
      return;

    case "index":
      validate_const_expr(expr.object, env, bound, message);
      validate_const_expr(expr.index, env, bound, message);
      return;

    case "union_case":
      if (expr.type_expr) {
        validate_const_expr(expr.type_expr, env, bound, message);
      }

      if (expr.value) {
        validate_const_expr(expr.value, env, bound, message);
      }

      return;

    case "linear":
      if (bound.has(expr.name)) {
        return;
      }

      throw new Error(message + ": " + expr.name);

    case "unsupported":
      return;
  }
}

function validate_const_block(
  stmts: Stmt[],
  env: Env,
  bound: Set<string>,
  message: string,
): void {
  const local = new Set(bound);

  for (const stmt of stmts) {
    if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        throw new Error(
          "Cannot evaluate linear binding at compile time: " + stmt.name,
        );
      }

      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "assign") {
      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "index_assign") {
      validate_const_expr(stmt.index, env, local, message);
      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "return") {
      validate_const_expr(stmt.value, env, local, message);
      continue;
    }

    if (stmt.tag === "expr") {
      validate_const_expr(stmt.expr, env, local, message);
      continue;
    }

    if (stmt.tag === "for_range") {
      validate_const_expr(stmt.start, env, local, message);
      validate_const_expr(stmt.end, env, local, message);
      validate_const_expr(stmt.step, env, local, message);

      const body_bound = new Set(local);
      body_bound.add(stmt.index);
      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "for_collection") {
      validate_const_expr(stmt.collection, env, local, message);

      const body_bound = new Set(local);

      if (stmt.index) {
        body_bound.add(stmt.index);
      }

      body_bound.add(stmt.item);
      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "if_stmt") {
      validate_const_expr(stmt.cond, env, local, message);
      validate_const_block(stmt.body, env, local, message);
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      validate_const_expr(stmt.target, env, local, message);

      const body_bound = new Set(local);

      if (stmt.value_name) {
        body_bound.add(stmt.value_name);
      }

      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "type_check") {
      validate_const_expr(stmt.target, env, local, message);
      continue;
    }

    if (stmt.tag === "break" || stmt.tag === "continue") {
      continue;
    }

    if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
    }
  }
}
