import type { Env, FrontExpr, Stmt } from "./ast.ts";
import { is_const_builtin_name } from "./constness.ts";
import { lookup } from "./env.ts";

export function is_const_expr_known(
  expr: FrontExpr,
  env: Env,
  bound: Set<string>,
): boolean {
  switch (expr.tag) {
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "struct_type":
    case "union_type":
      return true;

    case "is":
      return is_const_expr_known(expr.value, env, bound);

    case "var": {
      if (bound.has(expr.name)) {
        return true;
      }

      if (is_const_builtin_name(expr.name)) {
        return true;
      }

      const binding = lookup(env, expr.name);

      if (binding && binding.is_const) {
        return true;
      }

      return false;
    }

    case "prim":
      return is_const_expr_known(expr.left, env, bound) &&
        is_const_expr_known(expr.right, env, bound);

    case "lam":
    case "rec": {
      const local = new Set(bound);

      for (const param of expr.params) {
        local.add(param.name);
      }

      return is_const_expr_known(expr.body, env, local);
    }

    case "app": {
      if (!is_const_expr_known(expr.func, env, bound)) {
        return false;
      }

      for (const arg of expr.args) {
        if (!is_const_expr_known(arg, env, bound)) {
          return false;
        }
      }

      return true;
    }

    case "block":
      return is_const_block_known(expr.statements, env, bound);

    case "comptime":
      return is_const_expr_known(expr.expr, env, bound);

    case "borrow":
    case "freeze":
    case "scratch":
    case "loop":
      return false;

    case "captured":
      return is_const_expr_known(expr.expr, expr.env, bound);

    case "handler":
    case "try_with":
      return false;

    case "with": {
      if (!is_const_expr_known(expr.base, env, bound)) {
        return false;
      }

      for (const field of expr.fields) {
        if (!is_const_expr_known(field.value, env, bound)) {
          return false;
        }
      }

      return true;
    }

    case "struct_value": {
      if (!is_const_expr_known(expr.type_expr, env, bound)) {
        return false;
      }

      for (const field of expr.fields) {
        if (!is_const_expr_known(field.value, env, bound)) {
          return false;
        }
      }

      return true;
    }

    case "struct_update": {
      if (!is_const_expr_known(expr.base, env, bound)) {
        return false;
      }

      for (const field of expr.fields) {
        if (!is_const_expr_known(field.value, env, bound)) {
          return false;
        }
      }

      return true;
    }

    case "if":
      return is_const_expr_known(expr.cond, env, bound) &&
        is_const_expr_known(expr.then_branch, env, bound) &&
        is_const_expr_known(expr.else_branch, env, bound);

    case "if_let": {
      if (!is_const_expr_known(expr.target, env, bound)) {
        return false;
      }

      const local = new Set(bound);

      if (expr.value_name) {
        local.add(expr.value_name);
      }

      return is_const_expr_known(expr.then_branch, env, local) &&
        is_const_expr_known(expr.else_branch, env, bound);
    }

    case "field":
      return is_const_expr_known(expr.object, env, bound);

    case "index":
      return is_const_expr_known(expr.object, env, bound) &&
        is_const_expr_known(expr.index, env, bound);

    case "union_case":
      if (expr.type_expr && !is_const_expr_known(expr.type_expr, env, bound)) {
        return false;
      }

      if (expr.value && !is_const_expr_known(expr.value, env, bound)) {
        return false;
      }

      return true;

    case "linear":
    case "unsupported":
      return false;
  }
}

function is_const_block_known(
  stmts: Stmt[],
  env: Env,
  bound: Set<string>,
): boolean {
  const local = new Set(bound);

  for (const stmt of stmts) {
    if (stmt.tag === "bind") {
      if (!is_const_expr_known(stmt.value, env, local)) {
        return false;
      }

      local.add(stmt.name);
    } else if (stmt.tag === "assign") {
      if (!is_const_expr_known(stmt.value, env, local)) {
        return false;
      }

      local.add(stmt.name);
    } else if (stmt.tag === "index_assign") {
      if (
        !is_const_expr_known(stmt.index, env, local) ||
        !is_const_expr_known(stmt.value, env, local)
      ) {
        return false;
      }

      local.add(stmt.name);
    } else if (stmt.tag === "return") {
      if (!is_const_expr_known(stmt.value, env, local)) {
        return false;
      }
    } else if (stmt.tag === "expr") {
      if (!is_const_expr_known(stmt.expr, env, local)) {
        return false;
      }
    } else if (stmt.tag === "for_range") {
      const body_bound = new Set(local);
      body_bound.add(stmt.index);

      if (
        !is_const_expr_known(stmt.start, env, local) ||
        !is_const_expr_known(stmt.end, env, local) ||
        !is_const_expr_known(stmt.step, env, local) ||
        !is_const_block_known(stmt.body, env, body_bound)
      ) {
        return false;
      }
    } else if (stmt.tag === "for_collection") {
      const body_bound = new Set(local);

      if (stmt.index) {
        body_bound.add(stmt.index);
      }

      body_bound.add(stmt.item);

      if (
        !is_const_expr_known(stmt.collection, env, local) ||
        !is_const_block_known(stmt.body, env, body_bound)
      ) {
        return false;
      }
    } else if (stmt.tag === "if_stmt") {
      if (
        !is_const_expr_known(stmt.cond, env, local) ||
        !is_const_block_known(stmt.body, env, local)
      ) {
        return false;
      }
    } else if (stmt.tag === "if_let_stmt") {
      const body_bound = new Set(local);

      if (stmt.value_name) {
        body_bound.add(stmt.value_name);
      }

      if (
        !is_const_expr_known(stmt.target, env, local) ||
        !is_const_block_known(stmt.body, env, body_bound)
      ) {
        return false;
      }
    } else if (stmt.tag === "type_check") {
      if (!is_const_expr_known(stmt.target, env, local)) {
        return false;
      }
    } else if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
    } else if (stmt.tag === "break") {
      if (stmt.value && !is_const_expr_known(stmt.value, env, local)) {
        return false;
      }

      return true;
    } else if (stmt.tag === "continue") {
      return true;
    } else {
      return false;
    }
  }

  return true;
}
