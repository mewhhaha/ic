import { expect } from "../../expect.ts";
import type { Field, FrontExpr, Param, Stmt } from "../ast.ts";

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
    case "num":
    case "unit":
    case "text":
    case "type_name":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return expr;

    case "var":
      return {
        tag: "var",
        name: renamed_linear_closure_name(expr.name, renames),
      };

    case "linear":
      return {
        tag: "linear",
        name: renamed_linear_closure_name(expr.name, renames),
      };

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        left: rename_linear_closure_expr(expr.left, renames),
        right: rename_linear_closure_expr(expr.right, renames),
      };

    case "lam": {
      const local = shadow_linear_closure_params(renames, expr.params);
      return {
        tag: "lam",
        params: expr.params,
        body: rename_linear_closure_expr(expr.body, local),
      };
    }

    case "rec": {
      const local = shadow_linear_closure_params(renames, expr.params);
      return {
        tag: "rec",
        params: expr.params,
        body: rename_linear_closure_expr(expr.body, local),
      };
    }

    case "app":
      return {
        tag: "app",
        func: rename_linear_closure_expr(expr.func, renames),
        args: expr.args.map((arg) => rename_linear_closure_expr(arg, renames)),
      };

    case "block":
      return {
        tag: "block",
        statements: rename_linear_closure_block(expr.statements, renames),
      };

    case "comptime":
      return {
        tag: "comptime",
        expr: rename_linear_closure_expr(expr.expr, renames),
      };

    case "borrow":
      return {
        tag: "borrow",
        value: rename_linear_closure_expr(expr.value, renames),
      };

    case "freeze":
      return {
        tag: "freeze",
        value: rename_linear_closure_expr(expr.value, renames),
      };

    case "scratch":
      return {
        tag: "scratch",
        body: rename_linear_closure_expr(expr.body, renames),
      };

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
      return {
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
      };
    }

    case "try_with":
      return {
        tag: "try_with",
        body: rename_linear_closure_expr(expr.body, renames),
        handler: rename_linear_closure_expr(expr.handler, renames),
      };

    case "with":
      return {
        tag: "with",
        base: rename_linear_closure_expr(expr.base, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
      };

    case "struct_value":
      return {
        tag: "struct_value",
        type_expr: rename_linear_closure_expr(expr.type_expr, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
      };

    case "struct_update":
      return {
        tag: "struct_update",
        base: rename_linear_closure_expr(expr.base, renames),
        fields: rename_linear_closure_fields(expr.fields, renames),
      };

    case "if":
      return {
        tag: "if",
        cond: rename_linear_closure_expr(expr.cond, renames),
        then_branch: rename_linear_closure_expr(expr.then_branch, renames),
        else_branch: rename_linear_closure_expr(expr.else_branch, renames),
        implicit_else: expr.implicit_else,
      };

    case "if_let": {
      let then_renames = renames;

      if (expr.value_name) {
        then_renames = shadow_linear_closure_name(renames, expr.value_name);
      }

      return {
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: rename_linear_closure_expr(expr.target, renames),
        then_branch: rename_linear_closure_expr(expr.then_branch, then_renames),
        else_branch: rename_linear_closure_expr(expr.else_branch, renames),
        implicit_else: expr.implicit_else,
      };
    }

    case "field":
      return {
        tag: "field",
        object: rename_linear_closure_expr(expr.object, renames),
        name: expr.name,
      };

    case "index":
      return {
        tag: "index",
        object: rename_linear_closure_expr(expr.object, renames),
        index: rename_linear_closure_expr(expr.index, renames),
      };

    case "union_case": {
      let value: FrontExpr | undefined;
      let type_expr: FrontExpr | undefined;

      if (expr.value) {
        value = rename_linear_closure_expr(expr.value, renames);
      }

      if (expr.type_expr) {
        type_expr = rename_linear_closure_expr(expr.type_expr, renames);
      }

      return {
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
      };
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
      return {
        tag: "bind",
        kind: stmt.kind,
        name: stmt.name,
        is_linear: stmt.is_linear,
        annotation: stmt.annotation,
        effect_context: stmt.effect_context,
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "state_bind":
      return {
        tag: "state_bind",
        context: stmt.context,
        value_name: stmt.value_name,
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "bind_pattern":
      return {
        tag: "bind_pattern",
        kind: stmt.kind,
        items: stmt.items,
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "resume_dup":
      return {
        tag: "resume_dup",
        left: stmt.left,
        right: stmt.right,
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "assign":
      return {
        tag: "assign",
        name: renamed_linear_closure_name(stmt.name, renames),
        mode: stmt.mode,
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "index_assign":
      return {
        tag: "index_assign",
        name: renamed_linear_closure_name(stmt.name, renames),
        index: rename_linear_closure_expr(stmt.index, renames),
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "for_range": {
      const body_renames = shadow_linear_closure_name(renames, stmt.index);
      return {
        tag: "for_range",
        index: stmt.index,
        start: rename_linear_closure_expr(stmt.start, renames),
        end: rename_linear_closure_expr(stmt.end, renames),
        step: rename_linear_closure_expr(stmt.step, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      };
    }

    case "for_collection": {
      let body_renames = shadow_linear_closure_name(renames, stmt.item);

      if (stmt.index) {
        body_renames = shadow_linear_closure_name(body_renames, stmt.index);
      }

      return {
        tag: "for_collection",
        index: stmt.index,
        item: stmt.item,
        collection: rename_linear_closure_expr(stmt.collection, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      };
    }

    case "if_stmt":
      return {
        tag: "if_stmt",
        cond: rename_linear_closure_expr(stmt.cond, renames),
        body: rename_linear_closure_block(stmt.body, new Map(renames)),
      };

    case "if_let_stmt": {
      let body_renames = renames;

      if (stmt.value_name) {
        body_renames = shadow_linear_closure_name(renames, stmt.value_name);
      }

      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: rename_linear_closure_expr(stmt.target, renames),
        body: rename_linear_closure_block(stmt.body, body_renames),
      };
    }

    case "type_check":
      return {
        tag: "type_check",
        pattern: stmt.pattern,
        target: rename_linear_closure_expr(stmt.target, renames),
      };

    case "return":
      return {
        tag: "return",
        value: rename_linear_closure_expr(stmt.value, renames),
      };

    case "expr":
      return {
        tag: "expr",
        expr: rename_linear_closure_expr(stmt.expr, renames),
      };

    case "import":
    case "host_import":
    case "break":
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
