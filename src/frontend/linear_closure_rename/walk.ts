import { expect } from "../../expect.ts";
import type { Field, FrontExpr, Param, Stmt } from "../ast.ts";
import {
  inherit_linear_source_span as inherit_source_span,
} from "../linear_state.ts";
import { pattern_bindings } from "../pattern.ts";

export function rename_linear_closure_body(
  body: FrontExpr,
  source_params: Param[],
  target_params: Param[],
): FrontExpr {
  const renames = new Map<string, string>();

  for (let index = 0; index < source_params.length; index += 1) {
    const source = source_params[index];
    const target = target_params[index];
    expect(source, "Missing source linear closure parameter");
    expect(target, "Missing target linear closure parameter");
    renames.set(source.name, target.name);
  }

  return rename_linear_closure_expr(body, renames);
}

function rename_linear_closure_expr(
  expr: FrontExpr,
  renames: Map<string, string>,
): FrontExpr {
  switch (expr.tag) {
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
      return expr;

    case "is":
      return inherit_source_span({
        tag: "is",
        value: rename_linear_closure_expr(expr.value, renames),
        type_expr: expr.type_expr,
      }, expr);

    case "as":
      return inherit_source_span({
        tag: "as",
        value: rename_linear_closure_expr(expr.value, renames),
        type_expr: expr.type_expr,
      }, expr);

    case "var":
      return inherit_source_span({
        tag: "var",
        name: renamed_linear_closure_name(expr.name, renames),
      }, expr);

    case "linear":
      return inherit_source_span({
        tag: "linear",
        name: renamed_linear_closure_name(expr.name, renames),
      }, expr);

    case "prim":
      return inherit_source_span({
        tag: "prim",
        prim: expr.prim,
        left: rename_linear_closure_expr(expr.left, renames),
        right: rename_linear_closure_expr(expr.right, renames),
      }, expr);

    case "lam": {
      const local = shadow_linear_closure_params(renames, expr.params);
      return inherit_source_span({
        ...expr,
        body: rename_linear_closure_expr(expr.body, local),
      }, expr);
    }

    case "rec": {
      const local = shadow_linear_closure_params(renames, expr.params);
      return inherit_source_span({
        ...expr,
        body: rename_linear_closure_expr(expr.body, local),
      }, expr);
    }

    case "app":
      return inherit_source_span({
        ...expr,
        func: rename_linear_closure_expr(expr.func, renames),
        args: expr.args.map((arg) => rename_linear_closure_expr(arg, renames)),
      }, expr);

    case "product":
    case "shape":
      return inherit_source_span({
        ...expr,
        entries: expr.entries.map((entry) => ({
          ...entry,
          value: rename_linear_closure_expr(entry.value, renames),
        })),
      }, expr);

    case "array": {
      let rest: FrontExpr | undefined;

      if (expr.rest !== undefined) {
        rest = rename_linear_closure_expr(expr.rest, renames);
      }

      return inherit_source_span({
        tag: "array",
        items: expr.items.map((item) =>
          rename_linear_closure_expr(item, renames)
        ),
        rest,
      }, expr);
    }

    case "array_repeat":
      return inherit_source_span({
        tag: "array_repeat",
        value: rename_linear_closure_expr(expr.value, renames),
        length: rename_linear_closure_expr(expr.length, renames),
      }, expr);

    case "import":
      return expr;

    case "block":
      return inherit_source_span({
        tag: "block",
        statements: rename_linear_closure_block(expr.statements, renames),
      }, expr);

    case "comptime":
      return inherit_source_span({
        tag: "comptime",
        expr: rename_linear_closure_expr(expr.expr, renames),
      }, expr);

    case "borrow":
      return inherit_source_span({
        tag: "borrow",
        value: rename_linear_closure_expr(expr.value, renames),
      }, expr);

    case "freeze":
      return inherit_source_span({
        tag: "freeze",
        value: rename_linear_closure_expr(expr.value, renames),
      }, expr);

    case "scratch":
      return inherit_source_span({
        tag: "scratch",
        body: rename_linear_closure_expr(expr.body, renames),
      }, expr);

    case "loop":
      return inherit_source_span({
        tag: "loop",
        body: rename_linear_closure_block(expr.body, renames),
      }, expr);

    case "captured":
      return expr;

    case "handler": {
      const local = new Map(renames);
      const state = expr.state.map((item) => {
        const value = rename_linear_closure_expr(item.value, local);
        local.delete(item.name);
        return { ...item, value };
      });
      const clauses = expr.clauses.map((clause) => {
        const clause_renames = shadow_linear_closure_params(
          local,
          clause.params,
        );
        return {
          ...clause,
          body: rename_linear_closure_expr(clause.body, clause_renames),
        };
      });
      const return_renames = shadow_linear_closure_name(
        local,
        expr.return_clause.param.name,
      );
      return inherit_source_span({
        ...expr,
        state,
        clauses,
        return_clause: {
          ...expr.return_clause,
          body: rename_linear_closure_expr(
            expr.return_clause.body,
            return_renames,
          ),
        },
      }, expr);
    }

    case "try_with":
      return inherit_source_span({
        tag: "try_with",
        body: rename_linear_closure_expr(expr.body, renames),
        handler: rename_linear_closure_expr(expr.handler, renames),
      }, expr);

    case "with":
      return inherit_source_span({
        tag: "with",
        base: rename_linear_closure_expr(expr.base, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
      }, expr);

    case "struct_value":
      return inherit_source_span({
        tag: "struct_value",
        type_expr: rename_linear_closure_expr(expr.type_expr, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
        bracketed: expr.bracketed,
      }, expr);

    case "struct_update":
      return inherit_source_span({
        tag: "struct_update",
        base: rename_linear_closure_expr(expr.base, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
      }, expr);

    case "type_with":
      return inherit_source_span({
        tag: "type_with",
        base: rename_linear_closure_expr(expr.base, renames),
        members: expr.members.map((member) => ({
          name: rename_linear_closure_expr(member.name, renames),
          value: rename_linear_closure_expr(member.value, renames),
        })),
      }, expr);

    case "if":
      return inherit_source_span({
        tag: "if",
        cond: rename_linear_closure_expr(expr.cond, renames),
        then_branch: rename_linear_closure_expr(expr.then_branch, renames),
        else_branch: rename_linear_closure_expr(expr.else_branch, renames),
        implicit_else: expr.implicit_else,
      }, expr);

    case "if_let": {
      let then_renames = renames;

      if (expr.value_name) {
        then_renames = shadow_linear_closure_name(renames, expr.value_name);
      }

      return inherit_source_span({
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: rename_linear_closure_expr(expr.target, renames),
        then_branch: rename_linear_closure_expr(expr.then_branch, then_renames),
        else_branch: rename_linear_closure_expr(expr.else_branch, renames),
        implicit_else: expr.implicit_else,
      }, expr);
    }

    case "match":
      return inherit_source_span({
        tag: "match",
        target: rename_linear_closure_expr(expr.target, renames),
        arms: expr.arms.map((arm) => {
          let local = renames;

          for (const binding of pattern_bindings(arm.pattern)) {
            local = shadow_linear_closure_name(local, binding.name);
          }

          let guard: FrontExpr | undefined;

          if (arm.guard !== undefined) {
            guard = rename_linear_closure_expr(arm.guard, local);
          }

          return {
            pattern: arm.pattern,
            guard,
            body: rename_linear_closure_expr(arm.body, local),
          };
        }),
      }, expr);

    case "field":
      return inherit_source_span({
        tag: "field",
        object: rename_linear_closure_expr(expr.object, renames),
        name: expr.name,
      }, expr);

    case "index":
      return inherit_source_span({
        tag: "index",
        object: rename_linear_closure_expr(expr.object, renames),
        index: rename_linear_closure_expr(expr.index, renames),
      }, expr);

    case "union_case": {
      let value: FrontExpr | undefined;
      let type_expr: FrontExpr | undefined;

      if (expr.value) {
        value = rename_linear_closure_expr(expr.value, renames);
      }

      if (expr.type_expr) {
        type_expr = rename_linear_closure_expr(expr.type_expr, renames);
      }

      return inherit_source_span({
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
      }, expr);
    }
  }
}

function rename_linear_closure_block(
  stmts: Stmt[],
  renames: Map<string, string>,
): Stmt[] {
  const local = new Map(renames);
  const result: Stmt[] = [];

  for (const stmt of stmts) {
    result.push(rename_linear_closure_stmt(stmt, local));

    if (stmt.tag === "bind") {
      local.delete(stmt.name);
      continue;
    }

    if (stmt.tag === "resume_dup") {
      local.delete(stmt.left);
      local.delete(stmt.right);
      continue;
    }
  }

  return result;
}

function rename_linear_closure_stmt(
  stmt: Stmt,
  renames: Map<string, string>,
): Stmt {
  switch (stmt.tag) {
    case "bind":
      return inherit_source_span({
        tag: "bind",
        kind: stmt.kind,
        name: stmt.name,
        is_linear: stmt.is_linear,
        annotation: stmt.annotation,
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "state_bind":
      return inherit_source_span({
        tag: "state_bind",
        value_name: stmt.value_name,
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "bind_pattern":
      return inherit_source_span({
        tag: "bind_pattern",
        kind: stmt.kind,
        items: stmt.items,
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "resume_dup":
      return inherit_source_span({
        tag: "resume_dup",
        left: stmt.left,
        right: stmt.right,
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "assign":
      return inherit_source_span({
        tag: "assign",
        name: renamed_linear_closure_name(stmt.name, renames),
        mode: stmt.mode,
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "index_assign":
      return inherit_source_span({
        tag: "index_assign",
        name: renamed_linear_closure_name(stmt.name, renames),
        index: rename_linear_closure_expr(stmt.index, renames),
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "for_range": {
      const body_renames = shadow_linear_closure_name(renames, stmt.index);
      return inherit_source_span({
        tag: "for_range",
        index: stmt.index,
        start: rename_linear_closure_expr(stmt.start, renames),
        end: rename_linear_closure_expr(stmt.end, renames),
        end_bound: stmt.end_bound,
        step: rename_linear_closure_expr(stmt.step, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      }, stmt);
    }

    case "for_collection": {
      let body_renames = shadow_linear_closure_name(renames, stmt.item);

      if (stmt.index) {
        body_renames = shadow_linear_closure_name(body_renames, stmt.index);
      }

      return inherit_source_span({
        tag: "for_collection",
        index: stmt.index,
        item: stmt.item,
        pattern: stmt.pattern,
        collection: rename_linear_closure_expr(stmt.collection, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      }, stmt);
    }

    case "if_stmt":
      return inherit_source_span({
        tag: "if_stmt",
        cond: rename_linear_closure_expr(stmt.cond, renames),
        body: rename_linear_closure_block(stmt.body, new Map(renames)),
      }, stmt);

    case "if_let_stmt": {
      let body_renames = renames;

      if (stmt.value_name) {
        body_renames = shadow_linear_closure_name(renames, stmt.value_name);
      }

      return inherit_source_span({
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: rename_linear_closure_expr(stmt.target, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      }, stmt);
    }

    case "type_check":
      return inherit_source_span({
        tag: "type_check",
        pattern: stmt.pattern,
        target: rename_linear_closure_expr(stmt.target, renames),
      }, stmt);

    case "break":
      if (!stmt.value) {
        return stmt;
      }

      return inherit_source_span({
        tag: "break",
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "return":
      return inherit_source_span({
        tag: "return",
        value: rename_linear_closure_expr(stmt.value, renames),
      }, stmt);

    case "expr":
      return inherit_source_span({
        tag: "expr",
        expr: rename_linear_closure_expr(stmt.expr, renames),
      }, stmt);

    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return stmt;
  }
}

function rename_linear_closure_fields(
  fields: Field[],
  renames: Map<string, string>,
): Field[] {
  return fields.map((field) => ({
    name: field.name,
    value: rename_linear_closure_expr(field.value, renames),
  }));
}

function renamed_linear_closure_name(
  name: string,
  renames: Map<string, string>,
): string {
  const renamed = renames.get(name);

  if (renamed) {
    return renamed;
  }

  return name;
}

function shadow_linear_closure_params(
  renames: Map<string, string>,
  params: Param[],
): Map<string, string> {
  let local = renames;

  for (const param of params) {
    local = shadow_linear_closure_name(local, param.name);
  }

  return local;
}

function shadow_linear_closure_name(
  renames: Map<string, string>,
  name: string,
): Map<string, string> {
  if (!renames.has(name)) {
    return renames;
  }

  const local = new Map(renames);
  local.delete(name);
  return local;
}
