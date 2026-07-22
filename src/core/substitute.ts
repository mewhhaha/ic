import { expect } from "../expect.ts";
import type { CoreExpr, CoreField, CoreParam, CoreStmt } from "./ast.ts";
import { record_core_expr_provenance } from "./subject_provenance.ts";

export function substitute_core_call_expr(
  expr: CoreExpr,
  replacements: Map<string, CoreExpr>,
): CoreExpr {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return expr;

    case "linear":
    case "var": {
      const replacement = replacements.get(expr.name);

      if (replacement) {
        if (replacement.tag === "var" || replacement.tag === "linear") {
          return record_core_expr_provenance({ ...replacement }, replacement);
        }

        return replacement;
      }

      return expr;
    }

    case "prim":
      return record_core_expr_provenance({
        tag: "prim",
        prim: expr.prim,
        args: expr.args.map((arg) =>
          substitute_core_call_expr(arg, replacements)
        ),
      }, expr);

    case "lam": {
      const local = shadow_core_params(replacements, expr.params);
      return record_core_expr_provenance({
        tag: "lam",
        params: expr.params,
        body: substitute_core_call_expr(expr.body, local),
        is_linear_closure: expr.is_linear_closure,
      }, expr);
    }

    case "rec": {
      const local = shadow_core_params(replacements, expr.params);
      return record_core_expr_provenance({
        tag: "rec",
        params: expr.params,
        body: substitute_core_call_expr(expr.body, local),
      }, expr);
    }

    case "rec_ref":
      return expr;

    case "app":
      return record_core_expr_provenance({
        tag: "app",
        func: substitute_core_call_expr(expr.func, replacements),
        args: expr.args.map((arg) =>
          substitute_core_call_expr(arg, replacements)
        ),
        resume_payload: expr.resume_payload,
      }, expr);

    case "block":
      return record_core_expr_provenance({
        tag: "block",
        statements: substitute_core_call_block(expr.statements, replacements),
      }, expr);

    case "loop":
      return record_core_expr_provenance({
        tag: "loop",
        body: substitute_core_call_block(expr.body, new Map(replacements)),
      }, expr);

    case "comptime":
      return record_core_expr_provenance({
        tag: "comptime",
        expr: substitute_core_call_expr(expr.expr, replacements),
      }, expr);

    case "borrow":
      return record_core_expr_provenance({
        tag: "borrow",
        value: substitute_core_call_expr(expr.value, replacements),
      }, expr);

    case "freeze":
      return record_core_expr_provenance({
        tag: "freeze",
        value: substitute_core_call_expr(expr.value, replacements),
      }, expr);

    case "scratch":
      return record_core_expr_provenance({
        tag: "scratch",
        body: substitute_core_call_expr(expr.body, replacements),
      }, expr);

    case "with":
      return record_core_expr_provenance({
        tag: "with",
        base: substitute_core_call_expr(expr.base, replacements),
        fields: substitute_core_call_fields(expr.fields, replacements),
      }, expr);

    case "struct_value":
      return record_core_expr_provenance({
        tag: "struct_value",
        type_expr: substitute_core_call_expr(expr.type_expr, replacements),
        fields: substitute_core_call_fields(expr.fields, replacements),
      }, expr);

    case "struct_update":
      return record_core_expr_provenance({
        tag: "struct_update",
        base: substitute_core_call_expr(expr.base, replacements),
        fields: substitute_core_call_fields(expr.fields, replacements),
      }, expr);

    case "if":
      return record_core_expr_provenance({
        tag: "if",
        cond: substitute_core_call_expr(expr.cond, replacements),
        then_branch: substitute_core_call_expr(expr.then_branch, replacements),
        else_branch: substitute_core_call_expr(expr.else_branch, replacements),
        implicit_else: expr.implicit_else,
      }, expr);

    case "if_let": {
      let then_replacements = replacements;

      if (expr.value_name) {
        then_replacements = shadow_core_name(replacements, expr.value_name);
      }

      return record_core_expr_provenance({
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: substitute_core_call_expr(expr.target, replacements),
        then_branch: substitute_core_call_expr(
          expr.then_branch,
          then_replacements,
        ),
        else_branch: substitute_core_call_expr(expr.else_branch, replacements),
        implicit_else: expr.implicit_else,
      }, expr);
    }

    case "field":
      return record_core_expr_provenance({
        tag: "field",
        object: substitute_core_call_expr(expr.object, replacements),
        name: expr.name,
      }, expr);

    case "index":
      return record_core_expr_provenance({
        tag: "index",
        object: substitute_core_call_expr(expr.object, replacements),
        index: substitute_core_call_expr(expr.index, replacements),
      }, expr);

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        value = substitute_core_call_expr(expr.value, replacements);
      }

      if (expr.type_expr) {
        type_expr = substitute_core_call_expr(expr.type_expr, replacements);
      }

      return record_core_expr_provenance({
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
        resume_payload: expr.resume_payload,
      }, expr);
    }
  }
}

function substitute_core_call_block(
  stmts: CoreStmt[],
  replacements: Map<string, CoreExpr>,
): CoreStmt[] {
  const local = new Map(replacements);
  const result: CoreStmt[] = [];

  for (const stmt of stmts) {
    const substituted = substitute_core_call_stmt(stmt, local);
    result.push(substituted);

    if (stmt.tag === "bind") {
      local.delete(stmt.name);
      continue;
    }

    if (stmt.tag === "assign") {
      if (substituted.tag === "assign" && substituted.name !== stmt.name) {
        continue;
      }

      local.delete(stmt.name);
      continue;
    }

    if (stmt.tag === "index_assign") {
      if (
        substituted.tag === "index_assign" && substituted.name !== stmt.name
      ) {
        continue;
      }

      local.delete(stmt.name);
      continue;
    }
  }

  return result;
}

function substitute_core_call_stmt(
  stmt: CoreStmt,
  replacements: Map<string, CoreExpr>,
): CoreStmt {
  switch (stmt.tag) {
    case "bind":
      return {
        tag: "bind",
        kind: stmt.kind,
        name: stmt.name,
        is_linear: stmt.is_linear,
        annotation: stmt.annotation,
        value: substitute_core_call_expr(stmt.value, replacements),
      };

    case "assign": {
      const value = substitute_core_call_expr(stmt.value, replacements);
      const replacement = replacement_core_var_name(
        replacements,
        stmt.name,
      );

      if (replacement && stmt.mode === "same") {
        return {
          tag: "assign",
          name: replacement,
          mode: stmt.mode,
          value,
        };
      }

      return {
        tag: "assign",
        name: stmt.name,
        mode: stmt.mode,
        value,
      };
    }

    case "index_assign": {
      const replacement = replacement_core_var_name(
        replacements,
        stmt.name,
      );
      let name = stmt.name;

      if (replacement) {
        name = replacement;
      }

      return {
        tag: "index_assign",
        name,
        index: substitute_core_call_expr(stmt.index, replacements),
        value: substitute_core_call_expr(stmt.value, replacements),
      };
    }

    case "range_loop": {
      const body_replacements = shadow_core_name(replacements, stmt.index);
      return {
        tag: "range_loop",
        index: stmt.index,
        start: substitute_core_call_expr(stmt.start, replacements),
        end: substitute_core_call_expr(stmt.end, replacements),
        end_bound: stmt.end_bound,
        step: substitute_core_call_expr(stmt.step, replacements),
        carried: stmt.carried,
        body: substitute_core_call_block(stmt.body, body_replacements),
      };
    }

    case "collection_loop": {
      let body_replacements = shadow_core_name(replacements, stmt.item);

      if (stmt.index) {
        body_replacements = shadow_core_name(body_replacements, stmt.index);
      }

      return {
        tag: "collection_loop",
        index: stmt.index,
        item: stmt.item,
        collection: substitute_core_call_expr(stmt.collection, replacements),
        carried: stmt.carried,
        body: substitute_core_call_block(stmt.body, body_replacements),
      };
    }

    case "if_stmt":
      return {
        tag: "if_stmt",
        cond: substitute_core_call_expr(stmt.cond, replacements),
        body: substitute_core_call_block(stmt.body, new Map(replacements)),
      };

    case "if_else_stmt":
      return {
        tag: "if_else_stmt",
        cond: substitute_core_call_expr(stmt.cond, replacements),
        then_body: substitute_core_call_block(
          stmt.then_body,
          new Map(replacements),
        ),
        else_body: substitute_core_call_block(
          stmt.else_body,
          new Map(replacements),
        ),
      };

    case "if_let_stmt": {
      let body_replacements = replacements;

      if (stmt.value_name) {
        body_replacements = shadow_core_name(replacements, stmt.value_name);
      }

      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: substitute_core_call_expr(stmt.target, replacements),
        body: substitute_core_call_block(stmt.body, body_replacements),
      };
    }

    case "type_check":
      return {
        tag: "type_check",
        pattern: stmt.pattern,
        target: substitute_core_call_expr(stmt.target, replacements),
      };

    case "return":
      return {
        tag: "return",
        value: substitute_core_call_expr(stmt.value, replacements),
      };

    case "expr":
      return {
        tag: "expr",
        expr: substitute_core_call_expr(stmt.expr, replacements),
      };

    case "break":
      if (!stmt.value) {
        return stmt;
      }
      return {
        tag: "break",
        value: substitute_core_call_expr(stmt.value, replacements),
      };
    case "continue":
    case "unsupported":
      return stmt;
  }
}

function substitute_core_call_fields(
  fields: CoreField[],
  replacements: Map<string, CoreExpr>,
): CoreField[] {
  return fields.map((field) => ({
    name: field.name,
    value: substitute_core_call_expr(field.value, replacements),
  }));
}

function shadow_core_params(
  replacements: Map<string, CoreExpr>,
  params: CoreParam[],
): Map<string, CoreExpr> {
  let local = replacements;

  for (const param of params) {
    local = shadow_core_name(local, param.name);
  }

  return local;
}

function shadow_core_name(
  replacements: Map<string, CoreExpr>,
  name: string,
): Map<string, CoreExpr> {
  if (!replacements.has(name)) {
    return replacements;
  }

  const local = new Map(replacements);
  local.delete(name);
  return local;
}

function replacement_core_var_name(
  replacements: Map<string, CoreExpr>,
  name: string,
): string | undefined {
  const replacement = replacements.get(name);

  if (!replacement) {
    return undefined;
  }

  expect(
    replacement.tag === "var",
    "Core call replacement must be a variable: " + name,
  );
  return replacement.name;
}
