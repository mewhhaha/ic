import type { FrontExpr, Stmt } from "../../frontend/ast.ts";
import { pattern_bindings } from "../../frontend/pattern.ts";

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
    case "atom":
    case "unit":
    case "type_name":
    case "linear":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "import":
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

    case "product":
    case "shape":
      for (const entry of expr.entries) {
        validate_named_recursive_tail_expr(
          name,
          entry.value,
          shadowed,
          false,
        );
      }
      return;

    case "array":
      for (const item of expr.items) {
        validate_named_recursive_tail_expr(name, item, shadowed, false);
      }

      if (expr.rest !== undefined) {
        validate_named_recursive_tail_expr(
          name,
          expr.rest,
          shadowed,
          false,
        );
      }
      return;

    case "array_repeat":
      validate_named_recursive_tail_expr(name, expr.value, shadowed, false);
      validate_named_recursive_tail_expr(name, expr.length, shadowed, false);
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

    case "loop":
      validate_named_recursive_tail_stmts(
        name,
        expr.body,
        new Set(shadowed),
        false,
      );
      return;

    case "captured":
      validate_named_recursive_tail_expr(name, expr.expr, shadowed, tail);
      return;

    case "handler": {
      const state_shadowed = new Set(shadowed);

      for (const state of expr.state) {
        validate_named_recursive_tail_expr(
          name,
          state.value,
          state_shadowed,
          false,
        );
        if (state.name === name) {
          state_shadowed.add(name);
        }
      }

      for (const clause of expr.clauses) {
        const clause_shadowed = new Set(state_shadowed);
        for (const param of clause.params) {
          if (param.name === name) {
            clause_shadowed.add(name);
          }
        }
        validate_named_recursive_tail_expr(
          name,
          clause.body,
          clause_shadowed,
          false,
        );
      }

      const return_shadowed = new Set(state_shadowed);
      if (expr.return_clause.param.name === name) {
        return_shadowed.add(name);
      }
      validate_named_recursive_tail_expr(
        name,
        expr.return_clause.body,
        return_shadowed,
        false,
      );
      return;
    }

    case "try_with":
      validate_named_recursive_tail_expr(name, expr.body, shadowed, false);
      validate_named_recursive_tail_expr(name, expr.handler, shadowed, false);
      return;

    case "with":
      validate_named_recursive_tail_expr(name, expr.base, shadowed, false);
      validate_named_recursive_tail_fields(name, expr.fields, shadowed);
      return;

    case "type_with":
      validate_named_recursive_tail_expr(name, expr.base, shadowed, false);
      for (const member of expr.members) {
        validate_named_recursive_tail_expr(
          name,
          member.name,
          shadowed,
          false,
        );
        validate_named_recursive_tail_expr(
          name,
          member.value,
          shadowed,
          false,
        );
      }
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

    case "as":
      validate_named_recursive_tail_expr(name, expr.value, shadowed, false);
      return;

    case "is":
      validate_named_recursive_tail_expr(name, expr.value, shadowed, false);
      return;

    case "match":
      validate_named_recursive_tail_expr(name, expr.target, shadowed, false);

      for (const arm of expr.arms) {
        const arm_shadowed = new Set(shadowed);

        for (const binding of pattern_bindings(arm.pattern)) {
          if (binding.name === name) {
            arm_shadowed.add(name);
          }
        }

        if (arm.guard !== undefined) {
          validate_named_recursive_tail_expr(
            name,
            arm.guard,
            arm_shadowed,
            false,
          );
        }

        validate_named_recursive_tail_expr(
          name,
          arm.body,
          arm_shadowed,
          tail,
        );
      }
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

  expr satisfies never;
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

    if (stmt.tag === "state_bind") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);
      if (stmt.value_name === name) {
        shadowed.add(name);
      }
      continue;
    }

    if (stmt.tag === "bind_pattern") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);
      for (const item of stmt.items) {
        if (item.name === name) {
          shadowed.add(name);
        }
      }
      continue;
    }

    if (stmt.tag === "resume_dup") {
      validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);
      if (stmt.left === name || stmt.right === name) {
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
      continue;
    }

    if (stmt.tag === "break") {
      if (stmt.value !== undefined) {
        validate_named_recursive_tail_expr(name, stmt.value, shadowed, false);
      }
      continue;
    }

    if (
      stmt.tag === "continue" || stmt.tag === "import" ||
      stmt.tag === "host_import" || stmt.tag === "unsupported"
    ) {
      continue;
    }

    stmt satisfies never;
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
