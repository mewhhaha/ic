import type { FrontExpr, Stmt } from "../../frontend/ast.ts";

export function validate_named_recursive_tail_binding(
  name: string,
  expr: Extract<FrontExpr, { tag: "lam" }>,
): void {
  const shadowed = new Set<string>();

  for (const param of expr.params) {
    if (param.name === name) {
      shadowed.add(name);
    }
  }

  validate_named_recursive_tail_expr(name, expr.body, shadowed, true);
}

function validate_named_recursive_tail_expr(
  name: string,
  expr: FrontExpr,
  shadowed: Set<string>,
  tail: boolean,
): void {
  if (
    expr.tag === "app" && is_named_recursive_self_call(name, expr, shadowed)
  ) {
    for (const arg of expr.args) {
      validate_named_recursive_tail_expr(name, arg, shadowed, false);
    }

    if (!tail) {
      throw new Error("Cannot lower recursive source binding to Core yet");
    }

    return;
  }

  switch (expr.tag) {
    case "bool":
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var":
      if (expr.name === name && !shadowed.has(name)) {
        throw new Error("Cannot lower recursive source binding to Core yet");
      }
      return;

    case "prim":
      validate_named_recursive_tail_expr(name, expr.left, shadowed, false);
      validate_named_recursive_tail_expr(name, expr.right, shadowed, false);
      return;

    case "lam":
    case "rec": {
      const inner_shadowed = new Set(shadowed);

      for (const param of expr.params) {
        if (param.name === name) {
          inner_shadowed.add(name);
        }
      }

      validate_named_recursive_tail_expr(
        name,
        expr.body,
        inner_shadowed,
        false,
      );
      return;
    }

    case "app":
      validate_named_recursive_tail_expr(name, expr.func, shadowed, false);

      for (const arg of expr.args) {
        validate_named_recursive_tail_expr(name, arg, shadowed, false);
      }
      return;

    case "block":
      validate_named_recursive_tail_stmts(
        name,
        expr.statements,
        new Set(shadowed),
        tail,
      );
      return;

    case "comptime":
      validate_named_recursive_tail_expr(name, expr.expr, shadowed, false);
      return;

    case "borrow":
    case "freeze":
      validate_named_recursive_tail_expr(name, expr.value, shadowed, false);
      return;

    case "scratch":
      validate_named_recursive_tail_expr(name, expr.body, shadowed, false);
      return;

    case "captured":
      validate_named_recursive_tail_expr(name, expr.expr, shadowed, tail);
      return;

    case "with":
      validate_named_recursive_tail_expr(name, expr.base, shadowed, false);
      validate_named_recursive_tail_fields(name, expr.fields, shadowed);
      return;

    case "struct_value":
      validate_named_recursive_tail_expr(name, expr.type_expr, shadowed, false);
      validate_named_recursive_tail_fields(name, expr.fields, shadowed);
      return;

    case "struct_update":
      validate_named_recursive_tail_expr(name, expr.base, shadowed, false);
      validate_named_recursive_tail_fields(name, expr.fields, shadowed);
      return;

    case "if":
      validate_named_recursive_tail_expr(name, expr.cond, shadowed, false);
      validate_named_recursive_tail_expr(
        name,
        expr.then_branch,
        new Set(shadowed),
        tail,
      );
      validate_named_recursive_tail_expr(
        name,
        expr.else_branch,
        new Set(shadowed),
        tail,
      );
      return;

    case "if_let": {
      validate_named_recursive_tail_expr(name, expr.target, shadowed, false);
      const then_shadowed = new Set(shadowed);

      if (expr.value_name === name) {
        then_shadowed.add(name);
      }

      validate_named_recursive_tail_expr(
        name,
        expr.then_branch,
        then_shadowed,
        tail,
      );
      validate_named_recursive_tail_expr(
        name,
        expr.else_branch,
        new Set(shadowed),
        tail,
      );
      return;
    }

    case "field":
      validate_named_recursive_tail_expr(name, expr.object, shadowed, false);
      return;

    case "index":
      validate_named_recursive_tail_expr(name, expr.object, shadowed, false);
      validate_named_recursive_tail_expr(name, expr.index, shadowed, false);
      return;

    case "union_case":
      if (expr.value) {
        validate_named_recursive_tail_expr(name, expr.value, shadowed, false);
      }

      if (expr.type_expr) {
        validate_named_recursive_tail_expr(
          name,
          expr.type_expr,
          shadowed,
          false,
        );
      }
      return;
  }
}

function validate_named_recursive_tail_fields(
  name: string,
  fields: { name: string; value: FrontExpr }[],
  shadowed: Set<string>,
): void {
  for (const field of fields) {
    validate_named_recursive_tail_expr(name, field.value, shadowed, false);
  }
}

function validate_named_recursive_tail_stmts(
  name: string,
  stmts: Stmt[],
  shadowed: Set<string>,
  tail: boolean,
): void {
  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];

    if (!stmt) {
      throw new Error("Missing recursive source statement " + index);
    }

    const is_tail_stmt = tail && index + 1 >= stmts.length;

    if (stmt.tag === "expr") {
      validate_named_recursive_tail_expr(
        name,
        stmt.expr,
        shadowed,
        is_tail_stmt,
      );
      continue;
    }

    if (stmt.tag === "return") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, true);
      return;
    }

    if (stmt.tag === "bind") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);

      if (stmt.name === name) {
        shadowed.add(name);
      }
      continue;
    }

    if (stmt.tag === "assign") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);

      if (stmt.name === name) {
        shadowed.add(name);
      }
      continue;
    }

    if (stmt.tag === "index_assign") {
      if (stmt.name === name && !shadowed.has(name)) {
        throw new Error("Cannot lower recursive source binding to Core yet");
      }

      validate_named_recursive_tail_expr(name, stmt.index, shadowed, false);
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);
      continue;
    }

    if (stmt.tag === "for_range") {
      validate_named_recursive_tail_expr(name, stmt.start, shadowed, false);
      validate_named_recursive_tail_expr(name, stmt.end, shadowed, false);
      validate_named_recursive_tail_expr(name, stmt.step, shadowed, false);
      const body_shadowed = new Set(shadowed);

      if (stmt.index === name) {
        body_shadowed.add(name);
      }

      validate_named_recursive_tail_stmts(
        name,
        stmt.body,
        body_shadowed,
        false,
      );
      continue;
    }

    if (stmt.tag === "for_collection") {
      validate_named_recursive_tail_expr(
        name,
        stmt.collection,
        shadowed,
        false,
      );
      const body_shadowed = new Set(shadowed);

      if (stmt.item === name) {
        body_shadowed.add(name);
      }

      if (stmt.index === name) {
        body_shadowed.add(name);
      }

      validate_named_recursive_tail_stmts(
        name,
        stmt.body,
        body_shadowed,
        false,
      );
      continue;
    }

    if (stmt.tag === "if_stmt") {
      validate_named_recursive_tail_expr(name, stmt.cond, shadowed, false);
      validate_named_recursive_tail_stmts(
        name,
        stmt.body,
        new Set(shadowed),
        false,
      );
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      validate_named_recursive_tail_expr(name, stmt.target, shadowed, false);
      const body_shadowed = new Set(shadowed);

      if (stmt.value_name === name) {
        body_shadowed.add(name);
      }

      validate_named_recursive_tail_stmts(
        name,
        stmt.body,
        body_shadowed,
        false,
      );
      continue;
    }

    if (stmt.tag === "type_check") {
      validate_named_recursive_tail_expr(name, stmt.target, shadowed, false);
    }
  }
}

function is_named_recursive_self_call(
  name: string,
  expr: Extract<FrontExpr, { tag: "app" }>,
  shadowed: Set<string>,
): boolean {
  return expr.func.tag === "var" && expr.func.name === name &&
    !shadowed.has(name);
}
