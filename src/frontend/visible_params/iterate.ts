import type { Field, FrontExpr, Stmt } from "../ast.ts";
import { expr_root_is_named } from "./root.ts";
import { shadow_pattern_names } from "../pattern.ts";

export function expr_iterates_collection_from_names(
  expr: FrontExpr,
  names: Set<string>,
): boolean {
  switch (expr.tag) {
    case "block":
      return stmts_iterate_collection_from_names(
        expr.statements,
        new Set(names),
      );

    case "lam":
    case "rec": {
      const local = new Set(names);

      for (const param of expr.params) {
        local.delete(param.name);
      }

      return expr_iterates_collection_from_names(expr.body, local);
    }

    case "prim":
      return expr_iterates_collection_from_names(expr.left, names) ||
        expr_iterates_collection_from_names(expr.right, names);

    case "app":
      if (expr_iterates_collection_from_names(expr.func, names)) {
        return true;
      }

      for (const arg of expr.args) {
        if (expr_iterates_collection_from_names(arg, names)) {
          return true;
        }
      }

      return false;

    case "product":
      for (const entry of expr.entries) {
        if (expr_iterates_collection_from_names(entry.value, names)) {
          return true;
        }
      }

      return false;

    case "array":
      for (const item of expr.items) {
        if (expr_iterates_collection_from_names(item, names)) {
          return true;
        }
      }

      if (expr.rest !== undefined) {
        return expr_iterates_collection_from_names(expr.rest, names);
      }

      return false;

    case "array_repeat":
      return expr_iterates_collection_from_names(expr.value, names) ||
        expr_iterates_collection_from_names(expr.length, names);

    case "import":
      return false;

    case "comptime":
    case "captured":
      return expr_iterates_collection_from_names(expr.expr, names);

    case "borrow":
      return expr_iterates_collection_from_names(expr.value, names);

    case "freeze":
      return expr_iterates_collection_from_names(expr.value, names);

    case "scratch":
      return expr_iterates_collection_from_names(expr.body, names);

    case "loop":
      return stmts_iterate_collection_from_names(expr.body, new Set(names));

    case "handler": {
      const handler_names = new Set(names);

      for (const state of expr.state) {
        if (
          expr_iterates_collection_from_names(state.value, handler_names)
        ) {
          return true;
        }

        handler_names.delete(state.name);
      }

      for (const clause of expr.clauses) {
        const clause_names = new Set(handler_names);

        for (const param of clause.params) {
          clause_names.delete(param.name);
        }

        if (
          expr_iterates_collection_from_names(clause.body, clause_names)
        ) {
          return true;
        }
      }

      const return_names = new Set(handler_names);
      return_names.delete(expr.return_clause.param.name);
      return expr_iterates_collection_from_names(
        expr.return_clause.body,
        return_names,
      );
    }

    case "try_with":
      return expr_iterates_collection_from_names(expr.body, names) ||
        expr_iterates_collection_from_names(expr.handler, names);

    case "with":
      if (expr_iterates_collection_from_names(expr.base, names)) {
        return true;
      }

      return fields_iterate_collection_from_names(expr.fields, names);

    case "struct_value":
      if (expr_iterates_collection_from_names(expr.type_expr, names)) {
        return true;
      }

      return fields_iterate_collection_from_names(expr.fields, names);

    case "struct_update":
      if (expr_iterates_collection_from_names(expr.base, names)) {
        return true;
      }

      return fields_iterate_collection_from_names(expr.fields, names);

    case "if":
      return expr_iterates_collection_from_names(expr.cond, names) ||
        expr_iterates_collection_from_names(expr.then_branch, names) ||
        expr_iterates_collection_from_names(expr.else_branch, names);

    case "if_let": {
      if (expr_iterates_collection_from_names(expr.target, names)) {
        return true;
      }

      if (expr_iterates_collection_from_names(expr.else_branch, names)) {
        return true;
      }

      const local = new Set(names);

      if (expr.value_name) {
        local.delete(expr.value_name);
      }

      return expr_iterates_collection_from_names(expr.then_branch, local);
    }

    case "match":
      if (expr_iterates_collection_from_names(expr.target, names)) {
        return true;
      }

      for (const arm of expr.arms) {
        const local = shadow_pattern_names(names, arm.pattern);

        if (
          arm.guard !== undefined &&
          expr_iterates_collection_from_names(arm.guard, local)
        ) {
          return true;
        }

        if (expr_iterates_collection_from_names(arm.body, local)) {
          return true;
        }
      }

      return false;

    case "field":
      return expr_iterates_collection_from_names(expr.object, names);

    case "index":
      return expr_iterates_collection_from_names(expr.object, names) ||
        expr_iterates_collection_from_names(expr.index, names);

    case "union_case":
      if (expr.value) {
        if (expr_iterates_collection_from_names(expr.value, names)) {
          return true;
        }
      }

      if (expr.type_expr) {
        return expr_iterates_collection_from_names(expr.type_expr, names);
      }

      return false;

    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "is":
    case "as":
      return expr_iterates_collection_from_names(expr.value, names);
  }
}

function fields_iterate_collection_from_names(
  fields: Field[],
  names: Set<string>,
): boolean {
  for (const field of fields) {
    if (expr_iterates_collection_from_names(field.value, names)) {
      return true;
    }
  }

  return false;
}

function stmts_iterate_collection_from_names(
  stmts: Stmt[],
  names: Set<string>,
): boolean {
  const local = new Set(names);

  for (const stmt of stmts) {
    if (stmt_iterates_collection_from_names(stmt, local)) {
      return true;
    }

    if (stmt.tag === "bind" || stmt.tag === "assign") {
      local.delete(stmt.name);
    }

    if (stmt.tag === "index_assign") {
      local.delete(stmt.name);
    }

    if (stmt.tag === "resume_dup") {
      local.delete(stmt.left);
      local.delete(stmt.right);
    }
  }

  return false;
}

function stmt_iterates_collection_from_names(
  stmt: Stmt,
  names: Set<string>,
): boolean {
  switch (stmt.tag) {
    case "bind":
      return expr_iterates_collection_from_names(stmt.value, names);

    case "assign":
      return expr_iterates_collection_from_names(stmt.value, names);

    case "index_assign":
      return expr_iterates_collection_from_names(stmt.index, names) ||
        expr_iterates_collection_from_names(stmt.value, names);

    case "for_range": {
      if (expr_iterates_collection_from_names(stmt.start, names)) {
        return true;
      }

      if (expr_iterates_collection_from_names(stmt.end, names)) {
        return true;
      }

      if (expr_iterates_collection_from_names(stmt.step, names)) {
        return true;
      }

      const local = new Set(names);
      local.delete(stmt.index);
      return stmts_iterate_collection_from_names(stmt.body, local);
    }

    case "for_collection": {
      if (expr_root_is_named(stmt.collection, names)) {
        return true;
      }

      if (expr_iterates_collection_from_names(stmt.collection, names)) {
        return true;
      }

      const local = new Set(names);
      local.delete(stmt.item);

      if (stmt.index) {
        local.delete(stmt.index);
      }

      return stmts_iterate_collection_from_names(stmt.body, local);
    }

    case "if_stmt":
      return expr_iterates_collection_from_names(stmt.cond, names) ||
        stmts_iterate_collection_from_names(stmt.body, new Set(names));

    case "if_let_stmt": {
      if (expr_iterates_collection_from_names(stmt.target, names)) {
        return true;
      }

      const local = new Set(names);

      if (stmt.value_name) {
        local.delete(stmt.value_name);
      }

      return stmts_iterate_collection_from_names(stmt.body, local);
    }

    case "return":
      return expr_iterates_collection_from_names(stmt.value, names);

    case "expr":
      return expr_iterates_collection_from_names(stmt.expr, names);

    case "state_bind":
    case "bind_pattern":
      return expr_iterates_collection_from_names(stmt.value, names);

    case "resume_dup":
      return expr_iterates_collection_from_names(stmt.value, names);

    case "type_check":
      return expr_iterates_collection_from_names(stmt.target, names);

    case "continue":
    case "import":
    case "host_import":
    case "unsupported":
      return false;

    case "break":
      if (!stmt.value) {
        return false;
      }

      return expr_iterates_collection_from_names(stmt.value, names);
  }

  stmt satisfies never;
  throw new Error("panic");
}
