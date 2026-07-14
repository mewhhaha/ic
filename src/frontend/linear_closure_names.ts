import type { Field, FrontExpr, Stmt } from "./ast.ts";
import { pattern_bindings } from "./pattern.ts";

export function collect_linear_closure_names(
  expr: FrontExpr,
  names: Set<string>,
): void {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "import":
    case "unsupported":
      return;

    case "type_name":
    case "var":
    case "linear":
      names.add(expr.name);
      return;

    case "prim":
      collect_linear_closure_names(expr.left, names);
      collect_linear_closure_names(expr.right, names);
      return;

    case "lam":
    case "rec":
      if (expr.pattern !== undefined) {
        for (const binding of pattern_bindings(expr.pattern)) {
          names.add(binding.name);
        }
      }

      for (const param of expr.params) {
        names.add(param.name);
      }

      collect_linear_closure_names(expr.body, names);
      return;

    case "product":
      for (const entry of expr.entries) {
        collect_linear_closure_names(entry.value, names);
      }
      return;

    case "array":
      for (const item of expr.items) {
        collect_linear_closure_names(item, names);
      }

      if (expr.rest !== undefined) {
        collect_linear_closure_names(expr.rest, names);
      }
      return;

    case "array_repeat":
      collect_linear_closure_names(expr.value, names);
      collect_linear_closure_names(expr.length, names);
      return;

    case "app":
      collect_linear_closure_names(expr.func, names);

      for (const arg of expr.args) {
        collect_linear_closure_names(arg, names);
      }

      return;

    case "block":
      collect_linear_closure_stmt_names(expr.statements, names);
      return;

    case "comptime":
      collect_linear_closure_names(expr.expr, names);
      return;

    case "borrow":
    case "freeze":
      collect_linear_closure_names(expr.value, names);
      return;

    case "scratch":
      collect_linear_closure_names(expr.body, names);
      return;

    case "loop":
      collect_linear_closure_stmt_names(expr.body, names);
      return;

    case "captured":
      collect_linear_closure_names(expr.expr, names);
      return;

    case "handler":
      for (const state of expr.state) {
        names.add(state.name);
        collect_linear_closure_names(state.value, names);
      }

      for (const clause of expr.clauses) {
        for (const param of clause.params) {
          names.add(param.name);
        }

        collect_linear_closure_names(clause.body, names);
      }

      names.add(expr.return_clause.param.name);
      collect_linear_closure_names(expr.return_clause.body, names);
      return;

    case "try_with":
      collect_linear_closure_names(expr.body, names);
      collect_linear_closure_names(expr.handler, names);
      return;

    case "with":
      collect_linear_closure_names(expr.base, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "struct_value":
      collect_linear_closure_names(expr.type_expr, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "struct_update":
      collect_linear_closure_names(expr.base, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "if":
      collect_linear_closure_names(expr.cond, names);
      collect_linear_closure_names(expr.then_branch, names);
      collect_linear_closure_names(expr.else_branch, names);
      return;

    case "if_let":
      if (expr.value_name) {
        names.add(expr.value_name);
      }

      collect_linear_closure_names(expr.target, names);
      collect_linear_closure_names(expr.then_branch, names);
      collect_linear_closure_names(expr.else_branch, names);
      return;

    case "match":
      collect_linear_closure_names(expr.target, names);

      for (const arm of expr.arms) {
        for (const binding of pattern_bindings(arm.pattern)) {
          names.add(binding.name);
        }

        if (arm.guard !== undefined) {
          collect_linear_closure_names(arm.guard, names);
        }

        collect_linear_closure_names(arm.body, names);
      }
      return;

    case "field":
      collect_linear_closure_names(expr.object, names);
      return;

    case "index":
      collect_linear_closure_names(expr.object, names);
      collect_linear_closure_names(expr.index, names);
      return;

    case "is":
    case "as":
      collect_linear_closure_names(expr.value, names);
      return;

    case "union_case":
      if (expr.value) {
        collect_linear_closure_names(expr.value, names);
      }

      if (expr.type_expr) {
        collect_linear_closure_names(expr.type_expr, names);
      }

      return;
  }
}

function collect_linear_closure_stmt_names(
  stmts: Stmt[],
  names: Set<string>,
): void {
  for (const stmt of stmts) {
    switch (stmt.tag) {
      case "bind":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "assign":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "state_bind":
        if (stmt.value_name !== undefined) {
          names.add(stmt.value_name);
        }
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "bind_pattern":
        for (const item of stmt.items) {
          names.add(item.name);
        }
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "resume_dup":
        names.add(stmt.left);
        names.add(stmt.right);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "index_assign":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.index, names);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "for_range":
        names.add(stmt.index);
        collect_linear_closure_names(stmt.start, names);
        collect_linear_closure_names(stmt.end, names);
        collect_linear_closure_names(stmt.step, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "for_collection":
        if (stmt.index) {
          names.add(stmt.index);
        }

        names.add(stmt.item);
        collect_linear_closure_names(stmt.collection, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "if_stmt":
        collect_linear_closure_names(stmt.cond, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "if_let_stmt":
        if (stmt.value_name) {
          names.add(stmt.value_name);
        }

        collect_linear_closure_names(stmt.target, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "type_check":
        collect_linear_closure_names(stmt.target, names);
        continue;

      case "return":
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "break":
        if (stmt.value !== undefined) {
          collect_linear_closure_names(stmt.value, names);
        }
        continue;

      case "expr":
        collect_linear_closure_names(stmt.expr, names);
        continue;

      case "import":
      case "host_import":
      case "continue":
      case "unsupported":
        continue;
    }
  }
}

function collect_linear_closure_field_names(
  fields: Field[],
  names: Set<string>,
): void {
  for (const field of fields) {
    collect_linear_closure_names(field.value, names);
  }
}
