import type { FrontExpr, Stmt } from "./ast.ts";

export function contains_reserved_linear_effect(
  expr: FrontExpr,
  names: Set<string>,
): boolean {
  switch (expr.tag) {
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
      return contains_reserved_linear_effect(expr.value, names);

    case "prim":
      return contains_reserved_linear_effect(expr.left, names) ||
        contains_reserved_linear_effect(expr.right, names);

    case "lam":
    case "rec":
      return false;

    case "app": {
      if (expr.func.tag === "field") {
        if (uses_linear_name(expr.func.object, names)) {
          return true;
        }
      }

      if (contains_reserved_linear_effect(expr.func, names)) {
        return true;
      }

      for (const arg of expr.args) {
        if (contains_reserved_linear_effect(arg, names)) {
          return true;
        }
      }

      return false;
    }

    case "block":
      return contains_reserved_linear_stmt(expr.statements, names);

    case "comptime":
      return contains_reserved_linear_effect(expr.expr, names);

    case "borrow":
      return contains_reserved_linear_effect(expr.value, names);

    case "freeze":
      return contains_reserved_linear_effect(expr.value, names);

    case "scratch":
      return contains_reserved_linear_effect(expr.body, names);

    case "loop":
      return contains_reserved_linear_stmt(expr.body, names);

    case "captured":
      return contains_reserved_linear_effect(expr.expr, names);

    case "handler": {
      const local = new Set(names);

      for (const state of expr.state) {
        if (contains_reserved_linear_effect(state.value, local)) {
          return true;
        }

        local.delete(state.name);
      }

      for (const clause of expr.clauses) {
        const clause_names = shadow_linear_names(local, clause.params);

        if (contains_reserved_linear_effect(clause.body, clause_names)) {
          return true;
        }
      }

      const return_names = shadow_linear_names(
        local,
        [expr.return_clause.param],
      );
      return contains_reserved_linear_effect(
        expr.return_clause.body,
        return_names,
      );
    }

    case "try_with":
      return contains_reserved_linear_effect(expr.body, names) ||
        contains_reserved_linear_effect(expr.handler, names);

    case "with": {
      if (contains_reserved_linear_effect(expr.base, names)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_reserved_linear_effect(field.value, names)) {
          return true;
        }
      }

      return false;
    }

    case "struct_value": {
      if (contains_reserved_linear_effect(expr.type_expr, names)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_reserved_linear_effect(field.value, names)) {
          return true;
        }
      }

      return false;
    }

    case "struct_update": {
      if (contains_reserved_linear_effect(expr.base, names)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_reserved_linear_effect(field.value, names)) {
          return true;
        }
      }

      return false;
    }

    case "if":
      return contains_reserved_linear_effect(expr.cond, names) ||
        contains_reserved_linear_effect(expr.then_branch, names) ||
        contains_reserved_linear_effect(expr.else_branch, names);

    case "if_let":
      return contains_reserved_linear_effect(expr.target, names) ||
        contains_reserved_linear_effect(expr.then_branch, names) ||
        contains_reserved_linear_effect(expr.else_branch, names);

    case "field":
      return contains_reserved_linear_effect(expr.object, names);

    case "index":
      return contains_reserved_linear_effect(expr.object, names) ||
        contains_reserved_linear_effect(expr.index, names);

    case "union_case":
      if (!expr.value) {
        return false;
      }

      return contains_reserved_linear_effect(expr.value, names);
  }
}

function contains_reserved_linear_stmt(
  stmts: Stmt[],
  names: Set<string>,
): boolean {
  const local = new Set(names);

  for (const stmt of stmts) {
    if (stmt.tag === "bind") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "state_bind") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "bind_pattern") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "resume_dup") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "assign") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "index_assign") {
      if (
        contains_reserved_linear_effect(stmt.index, local) ||
        contains_reserved_linear_effect(stmt.value, local)
      ) {
        return true;
      }
    } else if (stmt.tag === "return") {
      if (contains_reserved_linear_effect(stmt.value, local)) {
        return true;
      }
    } else if (stmt.tag === "expr") {
      if (contains_reserved_linear_effect(stmt.expr, local)) {
        return true;
      }
    } else if (stmt.tag === "for_range") {
      if (
        contains_reserved_linear_effect(stmt.start, local) ||
        contains_reserved_linear_effect(stmt.end, local) ||
        contains_reserved_linear_effect(stmt.step, local) ||
        contains_reserved_linear_stmt(stmt.body, local)
      ) {
        return true;
      }
    } else if (stmt.tag === "for_collection") {
      if (
        contains_reserved_linear_effect(stmt.collection, local) ||
        contains_reserved_linear_stmt(stmt.body, local)
      ) {
        return true;
      }
    } else if (stmt.tag === "if_stmt") {
      if (
        contains_reserved_linear_effect(stmt.cond, local) ||
        contains_reserved_linear_stmt(stmt.body, local)
      ) {
        return true;
      }
    } else if (stmt.tag === "if_let_stmt") {
      if (
        contains_reserved_linear_effect(stmt.target, local) ||
        contains_reserved_linear_stmt(stmt.body, local)
      ) {
        return true;
      }
    } else if (stmt.tag === "type_check") {
      if (contains_reserved_linear_effect(stmt.target, local)) {
        return true;
      }
    }

    shadow_stmt_linear_names(local, stmt);
  }

  return false;
}

export function contains_explicit_linear_use(
  expr: FrontExpr,
  names: Set<string>,
): boolean {
  return uses_linear_name(expr, names, true);
}

function uses_linear_name(
  expr: FrontExpr,
  names: Set<string>,
  explicit_only = false,
): boolean {
  switch (expr.tag) {
    case "linear":
      return names.has(expr.name);

    case "var":
      if (explicit_only) {
        return false;
      }

      return names.has(expr.name);

    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "is":
      return uses_linear_name(expr.value, names, explicit_only);

    case "prim":
      return uses_linear_name(expr.left, names, explicit_only) ||
        uses_linear_name(expr.right, names, explicit_only);

    case "lam":
    case "rec": {
      if (!explicit_only) {
        return false;
      }

      const local = shadow_linear_names(names, expr.params);
      return uses_linear_name(expr.body, local, true);
    }

    case "app": {
      if (uses_linear_name(expr.func, names, explicit_only)) {
        return true;
      }

      for (const arg of expr.args) {
        if (uses_linear_name(arg, names, explicit_only)) {
          return true;
        }
      }

      return false;
    }

    case "block":
      return stmts_use_linear_name(expr.statements, names, explicit_only);

    case "comptime":
      return uses_linear_name(expr.expr, names, explicit_only);

    case "borrow":
      return uses_linear_name(expr.value, names, explicit_only);

    case "freeze":
      return uses_linear_name(expr.value, names, explicit_only);

    case "scratch":
      return uses_linear_name(expr.body, names, explicit_only);

    case "loop":
      return stmts_use_linear_name(expr.body, names, explicit_only);

    case "captured":
      return uses_linear_name(expr.expr, names, explicit_only);

    case "handler": {
      const local = new Set(names);

      for (const state of expr.state) {
        if (uses_linear_name(state.value, local, explicit_only)) {
          return true;
        }

        local.delete(state.name);
      }

      for (const clause of expr.clauses) {
        const clause_names = shadow_linear_names(local, clause.params);

        if (uses_linear_name(clause.body, clause_names, explicit_only)) {
          return true;
        }
      }

      const return_names = shadow_linear_names(
        local,
        [expr.return_clause.param],
      );
      return uses_linear_name(
        expr.return_clause.body,
        return_names,
        explicit_only,
      );
    }

    case "try_with":
      return uses_linear_name(expr.body, names, explicit_only) ||
        uses_linear_name(expr.handler, names, explicit_only);

    case "with": {
      if (uses_linear_name(expr.base, names, explicit_only)) {
        return true;
      }

      for (const field of expr.fields) {
        if (uses_linear_name(field.value, names, explicit_only)) {
          return true;
        }
      }

      return false;
    }

    case "struct_value": {
      if (uses_linear_name(expr.type_expr, names, explicit_only)) {
        return true;
      }

      for (const field of expr.fields) {
        if (uses_linear_name(field.value, names, explicit_only)) {
          return true;
        }
      }

      return false;
    }

    case "struct_update": {
      if (uses_linear_name(expr.base, names, explicit_only)) {
        return true;
      }

      for (const field of expr.fields) {
        if (uses_linear_name(field.value, names, explicit_only)) {
          return true;
        }
      }

      return false;
    }

    case "if":
      return uses_linear_name(expr.cond, names, explicit_only) ||
        uses_linear_name(expr.then_branch, names, explicit_only) ||
        uses_linear_name(expr.else_branch, names, explicit_only);

    case "if_let": {
      let then_names = names;

      if (expr.value_name) {
        then_names = new Set(names);
        then_names.delete(expr.value_name);
      }

      return uses_linear_name(expr.target, names, explicit_only) ||
        uses_linear_name(expr.then_branch, then_names, explicit_only) ||
        uses_linear_name(expr.else_branch, names, explicit_only);
    }

    case "field":
      return uses_linear_name(expr.object, names, explicit_only);

    case "index":
      return uses_linear_name(expr.object, names, explicit_only) ||
        uses_linear_name(expr.index, names, explicit_only);

    case "union_case":
      if (!expr.value) {
        return false;
      }

      return uses_linear_name(expr.value, names, explicit_only);
  }
}

function stmt_uses_linear_name(
  stmt: Stmt,
  names: Set<string>,
  explicit_only = false,
): boolean {
  if (stmt.tag === "bind") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "state_bind") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "bind_pattern") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "resume_dup") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "assign") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "index_assign") {
    return uses_linear_name(stmt.index, names, explicit_only) ||
      uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "return") {
    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "break") {
    if (!stmt.value) {
      return false;
    }

    return uses_linear_name(stmt.value, names, explicit_only);
  }

  if (stmt.tag === "expr") {
    return uses_linear_name(stmt.expr, names, explicit_only);
  }

  if (stmt.tag === "for_range") {
    const body_names = new Set(names);
    body_names.delete(stmt.index);
    return uses_linear_name(stmt.start, names, explicit_only) ||
      uses_linear_name(stmt.end, names, explicit_only) ||
      uses_linear_name(stmt.step, names, explicit_only) ||
      stmts_use_linear_name(stmt.body, body_names, explicit_only);
  }

  if (stmt.tag === "for_collection") {
    const body_names = new Set(names);
    body_names.delete(stmt.item);

    if (stmt.index) {
      body_names.delete(stmt.index);
    }

    return uses_linear_name(stmt.collection, names, explicit_only) ||
      stmts_use_linear_name(stmt.body, body_names, explicit_only);
  }

  if (stmt.tag === "if_stmt") {
    return uses_linear_name(stmt.cond, names, explicit_only) ||
      stmts_use_linear_name(stmt.body, names, explicit_only);
  }

  if (stmt.tag === "if_let_stmt") {
    let body_names = names;

    if (stmt.value_name) {
      body_names = new Set(names);
      body_names.delete(stmt.value_name);
    }

    return uses_linear_name(stmt.target, names, explicit_only) ||
      stmts_use_linear_name(stmt.body, body_names, explicit_only);
  }

  if (stmt.tag === "type_check") {
    return uses_linear_name(stmt.target, names, explicit_only);
  }

  return false;
}

function stmts_use_linear_name(
  stmts: Stmt[],
  names: Set<string>,
  explicit_only = false,
): boolean {
  const local = new Set(names);

  for (const stmt of stmts) {
    if (stmt_uses_linear_name(stmt, local, explicit_only)) {
      return true;
    }

    shadow_stmt_linear_names(local, stmt);
  }

  return false;
}

function shadow_linear_names(
  names: Set<string>,
  binders: { name: string }[],
): Set<string> {
  const local = new Set(names);

  for (const binder of binders) {
    local.delete(binder.name);
  }

  return local;
}

function shadow_stmt_linear_names(names: Set<string>, stmt: Stmt): void {
  if (stmt.tag === "bind") {
    names.delete(stmt.name);
    return;
  }

  if (stmt.tag === "state_bind" && stmt.value_name) {
    names.delete(stmt.value_name);
    return;
  }

  if (stmt.tag === "bind_pattern") {
    for (const item of stmt.items) {
      names.delete(item.name);
    }

    return;
  }

  if (stmt.tag === "resume_dup") {
    names.delete(stmt.left);
    names.delete(stmt.right);
    return;
  }

  if (stmt.tag === "assign" && stmt.mode === "change") {
    names.delete(stmt.name);
  }
}
