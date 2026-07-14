import type { FrontExpr, Source, Stmt } from "./ast.ts";
import {
  contains_explicit_linear_use,
  contains_reserved_linear_effect,
} from "./linear_effect.ts";
import { throw_linear_diagnostic } from "./linear_state.ts";
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
  validate_source_loop_break_units(source.statements);
}

function validate_source_loop_break_units(stmts: Stmt[]): void {
  for (const stmt of stmts) {
    validate_loop_units_in_stmt(stmt);
  }
}

function validate_loop_units_in_stmt(stmt: Stmt): void {
  if (
    stmt.tag === "bind" || stmt.tag === "state_bind" ||
    stmt.tag === "bind_pattern" || stmt.tag === "resume_dup" ||
    stmt.tag === "assign"
  ) {
    validate_loop_units_in_expr(stmt.value);
    return;
  }

  if (stmt.tag === "index_assign") {
    validate_loop_units_in_expr(stmt.index);
    validate_loop_units_in_expr(stmt.value);
    return;
  }

  if (stmt.tag === "for_range") {
    validate_loop_units_in_expr(stmt.start);
    validate_loop_units_in_expr(stmt.end);
    validate_loop_units_in_expr(stmt.step);
    validate_source_loop_break_units(stmt.body);
    return;
  }

  if (stmt.tag === "for_collection") {
    validate_loop_units_in_expr(stmt.collection);
    validate_source_loop_break_units(stmt.body);
    return;
  }

  if (stmt.tag === "if_stmt") {
    validate_loop_units_in_expr(stmt.cond);
    validate_source_loop_break_units(stmt.body);
    return;
  }

  if (stmt.tag === "if_let_stmt") {
    validate_loop_units_in_expr(stmt.target);
    validate_source_loop_break_units(stmt.body);
    return;
  }

  if (stmt.tag === "type_check") {
    validate_loop_units_in_expr(stmt.target);
    return;
  }

  if (stmt.tag === "break" && stmt.value) {
    validate_loop_units_in_expr(stmt.value);
    return;
  }

  if (stmt.tag === "return") {
    validate_loop_units_in_expr(stmt.value);
    return;
  }

  if (stmt.tag === "expr") {
    validate_loop_units_in_expr(stmt.expr);
  }
}

function validate_loop_units_in_expr(expr: FrontExpr): void {
  if (expr.tag === "loop") {
    let has_unit_break = false;
    let has_value_break = false;
    collect_direct_loop_break_units(expr.body, (is_unit) => {
      if (is_unit) {
        has_unit_break = true;
      } else {
        has_value_break = true;
      }
    });
    if (has_unit_break && has_value_break) {
      throw_linear_diagnostic(
        "IX2291",
        "Loop breaks must return one source type, got Unit and value",
        expr,
      );
    }
    validate_source_loop_break_units(expr.body);
    return;
  }

  if (expr.tag === "prim") {
    validate_loop_units_in_expr(expr.left);
    validate_loop_units_in_expr(expr.right);
    return;
  }

  if (expr.tag === "product") {
    for (const entry of expr.entries) {
      validate_loop_units_in_expr(entry.value);
    }
    return;
  }

  if (expr.tag === "array") {
    for (const item of expr.items) {
      validate_loop_units_in_expr(item);
    }

    if (expr.rest !== undefined) {
      validate_loop_units_in_expr(expr.rest);
    }
    return;
  }

  if (expr.tag === "array_repeat") {
    validate_loop_units_in_expr(expr.value);
    validate_loop_units_in_expr(expr.length);
    return;
  }

  if (expr.tag === "app") {
    validate_loop_units_in_expr(expr.func);
    for (const arg of expr.args) {
      validate_loop_units_in_expr(arg);
    }
    return;
  }

  if (expr.tag === "block") {
    validate_source_loop_break_units(expr.statements);
    return;
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    validate_loop_units_in_expr(expr.expr);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    validate_loop_units_in_expr(expr.value);
    return;
  }

  if (expr.tag === "scratch") {
    validate_loop_units_in_expr(expr.body);
    return;
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    validate_loop_units_in_expr(expr.body);
    return;
  }

  if (expr.tag === "handler") {
    for (const state of expr.state) {
      validate_loop_units_in_expr(state.value);
    }
    for (const clause of expr.clauses) {
      validate_loop_units_in_expr(clause.body);
    }
    validate_loop_units_in_expr(expr.return_clause.body);
    return;
  }

  if (expr.tag === "try_with") {
    validate_loop_units_in_expr(expr.body);
    validate_loop_units_in_expr(expr.handler);
    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    validate_loop_units_in_expr(expr.base);
    for (const field of expr.fields) {
      validate_loop_units_in_expr(field.value);
    }
    return;
  }

  if (expr.tag === "struct_value") {
    validate_loop_units_in_expr(expr.type_expr);
    for (const field of expr.fields) {
      validate_loop_units_in_expr(field.value);
    }
    return;
  }

  if (expr.tag === "if") {
    validate_loop_units_in_expr(expr.cond);
    validate_loop_units_in_expr(expr.then_branch);
    validate_loop_units_in_expr(expr.else_branch);
    return;
  }

  if (expr.tag === "if_let") {
    validate_loop_units_in_expr(expr.target);
    validate_loop_units_in_expr(expr.then_branch);
    validate_loop_units_in_expr(expr.else_branch);
    return;
  }

  if (expr.tag === "field") {
    validate_loop_units_in_expr(expr.object);
    return;
  }

  if (expr.tag === "index") {
    validate_loop_units_in_expr(expr.object);
    validate_loop_units_in_expr(expr.index);
    return;
  }

  if (expr.tag === "union_case") {
    if (expr.value) {
      validate_loop_units_in_expr(expr.value);
    }
    if (expr.type_expr) {
      validate_loop_units_in_expr(expr.type_expr);
    }
    return;
  }

  if (expr.tag === "as") {
    validate_loop_units_in_expr(expr.value);
    return;
  }

  if (expr.tag === "match") {
    validate_loop_units_in_expr(expr.target);

    for (const arm of expr.arms) {
      if (arm.guard !== undefined) {
        validate_loop_units_in_expr(arm.guard);
      }

      validate_loop_units_in_expr(arm.body);
    }
  }
}

function collect_direct_loop_break_units(
  stmts: Stmt[],
  found: (is_unit: boolean) => void,
): void {
  for (const stmt of stmts) {
    if (stmt.tag === "break") {
      found(!stmt.value || stmt.value.tag === "unit");
      continue;
    }

    if (stmt.tag === "for_range" || stmt.tag === "for_collection") {
      continue;
    }

    if (stmt.tag === "if_stmt" || stmt.tag === "if_let_stmt") {
      collect_direct_loop_break_units(stmt.body, found);
      continue;
    }

    if (stmt.tag === "expr") {
      collect_loop_break_units_from_expr(stmt.expr, found);
      continue;
    }

    if (
      stmt.tag === "bind" || stmt.tag === "state_bind" ||
      stmt.tag === "bind_pattern" || stmt.tag === "resume_dup" ||
      stmt.tag === "assign"
    ) {
      collect_loop_break_units_from_expr(stmt.value, found);
    }
  }
}

function collect_loop_break_units_from_expr(
  expr: FrontExpr,
  found: (is_unit: boolean) => void,
): void {
  if (
    expr.tag === "loop" || expr.tag === "lam" || expr.tag === "rec" ||
    expr.tag === "handler" || expr.tag === "try_with"
  ) {
    return;
  }

  if (expr.tag === "block") {
    collect_direct_loop_break_units(expr.statements, found);
    return;
  }

  if (expr.tag === "if") {
    collect_loop_break_units_from_expr(expr.then_branch, found);
    collect_loop_break_units_from_expr(expr.else_branch, found);
    return;
  }

  if (expr.tag === "if_let") {
    collect_loop_break_units_from_expr(expr.then_branch, found);
    collect_loop_break_units_from_expr(expr.else_branch, found);
  }
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
      validate_linear_rest(stmt.name, stmts.slice(index + 1), stmt);
    }
  }
}

function validate_linear_stmt_lambdas(stmt: Stmt): void {
  switch (stmt.tag) {
    case "bind":
    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
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
    case "continue":
    case "unsupported":
      return;

    case "break":
      if (stmt.value) {
        validate_linear_expr_lambdas(stmt.value);
      }
      return;
  }
}

function validate_linear_expr_lambdas(expr: FrontExpr): void {
  switch (expr.tag) {
    case "lam":
      {
        const names = linear_param_names(expr);

        if (
          contains_explicit_linear_use(expr.body, names) ||
          contains_reserved_linear_effect(expr.body, names)
        ) {
          validate_linear_lam(expr);
        }
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

    case "product":
      for (const entry of expr.entries) {
        validate_linear_expr_lambdas(entry.value);
      }
      return;

    case "array":
      for (const item of expr.items) {
        validate_linear_expr_lambdas(item);
      }

      if (expr.rest !== undefined) {
        validate_linear_expr_lambdas(expr.rest);
      }
      return;

    case "array_repeat":
      validate_linear_expr_lambdas(expr.value);
      validate_linear_expr_lambdas(expr.length);
      return;

    case "import":
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

    case "loop":
      validate_linear_statements(expr.body);
      return;

    case "captured":
      validate_linear_expr_lambdas(expr.expr);
      return;

    case "handler":
      for (const state of expr.state) {
        validate_linear_expr_lambdas(state.value);
      }

      for (const clause of expr.clauses) {
        validate_linear_expr_lambdas(clause.body);
      }

      validate_linear_expr_lambdas(expr.return_clause.body);
      return;

    case "try_with":
      validate_linear_expr_lambdas(expr.body);
      validate_linear_expr_lambdas(expr.handler);
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

    case "match":
      validate_linear_expr_lambdas(expr.target);

      for (const arm of expr.arms) {
        if (arm.guard !== undefined) {
          validate_linear_expr_lambdas(arm.guard);
        }

        validate_linear_expr_lambdas(arm.body);
      }
      return;

    case "field":
      validate_linear_expr_lambdas(expr.object);
      return;

    case "index":
      validate_linear_expr_lambdas(expr.object);
      validate_linear_expr_lambdas(expr.index);
      return;

    case "is":
    case "as":
      validate_linear_expr_lambdas(expr.value);
      return;

    case "union_case":
      if (expr.value) {
        validate_linear_expr_lambdas(expr.value);
      }
      if (expr.type_expr) {
        validate_linear_expr_lambdas(expr.type_expr);
      }
      return;

    case "bool":
    case "num":
    case "atom":
    case "unit":
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
