import type { Field, FrontExpr, Param, Stmt } from "./ast.ts";

export function substitute_front_expr(
  expr: FrontExpr,
  replacements: Map<string, FrontExpr>,
): FrontExpr {
  switch (expr.tag) {
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
      return {
        tag: "is",
        value: substitute_front_expr(expr.value, replacements),
        type_expr: expr.type_expr,
      };

    case "linear": {
      const replacement = replacements.get(expr.name);

      if (replacement) {
        return replacement;
      }

      return expr;
    }

    case "var": {
      const replacement = replacements.get(expr.name);

      if (replacement) {
        return replacement;
      }

      return expr;
    }

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        left: substitute_front_expr(expr.left, replacements),
        right: substitute_front_expr(expr.right, replacements),
      };

    case "lam": {
      const local = shadow_params(replacements, expr.params);
      return {
        ...expr,
        body: substitute_front_expr(expr.body, local),
      };
    }

    case "rec": {
      const local = shadow_params(replacements, expr.params);
      return {
        tag: "rec",
        params: expr.params,
        body: substitute_front_expr(expr.body, local),
      };
    }

    case "app":
      return {
        ...expr,
        func: substitute_front_expr(expr.func, replacements),
        args: expr.args.map((arg) => substitute_front_expr(arg, replacements)),
      };

    case "block":
      return {
        tag: "block",
        statements: substitute_front_block(expr.statements, replacements),
      };

    case "comptime":
      return {
        tag: "comptime",
        expr: substitute_front_expr(expr.expr, replacements),
      };

    case "borrow":
      return {
        tag: "borrow",
        value: substitute_front_expr(expr.value, replacements),
      };

    case "freeze":
      return {
        tag: "freeze",
        value: substitute_front_expr(expr.value, replacements),
      };

    case "scratch":
      return {
        tag: "scratch",
        body: substitute_front_expr(expr.body, replacements),
      };

    case "loop":
      return {
        tag: "loop",
        body: substitute_front_block(expr.body, replacements),
      };

    case "captured":
      return expr;

    case "handler": {
      const local = new Map(replacements);
      const state = expr.state.map((item) => {
        const value = substitute_front_expr(item.value, local);
        local.delete(item.name);
        return { ...item, value };
      });
      const clauses = expr.clauses.map((clause) => {
        const clause_replacements = shadow_params(local, clause.params);
        return {
          ...clause,
          body: substitute_front_expr(clause.body, clause_replacements),
        };
      });
      const return_replacements = shadow_name(
        local,
        expr.return_clause.param.name,
      );
      return {
        ...expr,
        state,
        clauses,
        return_clause: {
          ...expr.return_clause,
          body: substitute_front_expr(
            expr.return_clause.body,
            return_replacements,
          ),
        },
      };
    }

    case "try_with":
      return {
        tag: "try_with",
        body: substitute_front_expr(expr.body, replacements),
        handler: substitute_front_expr(expr.handler, replacements),
      };

    case "with":
      return {
        tag: "with",
        base: substitute_front_expr(expr.base, replacements),
        fields: substitute_front_fields(expr.fields, replacements),
      };

    case "struct_value":
      return {
        tag: "struct_value",
        type_expr: substitute_front_expr(expr.type_expr, replacements),
        fields: substitute_front_fields(expr.fields, replacements),
        bracketed: expr.bracketed,
      };

    case "struct_update":
      return {
        tag: "struct_update",
        base: substitute_front_expr(expr.base, replacements),
        fields: substitute_front_fields(expr.fields, replacements),
      };

    case "if":
      return {
        tag: "if",
        cond: substitute_front_expr(expr.cond, replacements),
        then_branch: substitute_front_expr(expr.then_branch, replacements),
        else_branch: substitute_front_expr(expr.else_branch, replacements),
        implicit_else: expr.implicit_else,
      };

    case "if_let": {
      let then_replacements = replacements;

      if (expr.value_name) {
        then_replacements = shadow_name(replacements, expr.value_name);
      }

      return {
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: substitute_front_expr(expr.target, replacements),
        then_branch: substitute_front_expr(expr.then_branch, then_replacements),
        else_branch: substitute_front_expr(expr.else_branch, replacements),
        implicit_else: expr.implicit_else,
      };
    }

    case "field":
      return {
        tag: "field",
        object: substitute_front_expr(expr.object, replacements),
        name: expr.name,
      };

    case "index":
      return {
        tag: "index",
        object: substitute_front_expr(expr.object, replacements),
        index: substitute_front_expr(expr.index, replacements),
      };

    case "union_case": {
      let value: FrontExpr | undefined;
      let type_expr: FrontExpr | undefined;

      if (expr.value) {
        value = substitute_front_expr(expr.value, replacements);
      }

      if (expr.type_expr) {
        type_expr = substitute_front_expr(expr.type_expr, replacements);
      }

      return {
        ...expr,
        value,
        type_expr,
      };
    }
  }
}

function substitute_front_block(
  stmts: Stmt[],
  replacements: Map<string, FrontExpr>,
): Stmt[] {
  const local = new Map(replacements);
  const result: Stmt[] = [];

  for (const stmt of stmts) {
    result.push(substitute_front_stmt(stmt, local));

    if (stmt.tag === "bind") {
      local.delete(stmt.name);
      continue;
    }

    if (stmt.tag === "assign") {
      local.delete(stmt.name);
      continue;
    }

    if (stmt.tag === "index_assign") {
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

function substitute_front_stmt(
  stmt: Stmt,
  replacements: Map<string, FrontExpr>,
): Stmt {
  switch (stmt.tag) {
    case "bind":
      return {
        tag: "bind",
        kind: stmt.kind,
        name: stmt.name,
        is_recursive: stmt.is_recursive,
        is_linear: stmt.is_linear,
        annotation: stmt.annotation,
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "state_bind":
      return {
        tag: "state_bind",
        value_name: stmt.value_name,
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "bind_pattern":
      return {
        tag: "bind_pattern",
        kind: stmt.kind,
        items: stmt.items,
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "resume_dup":
      return {
        tag: "resume_dup",
        left: stmt.left,
        right: stmt.right,
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "assign":
      return {
        tag: "assign",
        name: stmt.name,
        mode: stmt.mode,
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "index_assign":
      return {
        tag: "index_assign",
        name: stmt.name,
        index: substitute_front_expr(stmt.index, replacements),
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "for_range": {
      const body_replacements = shadow_name(replacements, stmt.index);
      return {
        tag: "for_range",
        index: stmt.index,
        start: substitute_front_expr(stmt.start, replacements),
        end: substitute_front_expr(stmt.end, replacements),
        step: substitute_front_expr(stmt.step, replacements),
        body: substitute_front_block(stmt.body, body_replacements),
      };
    }

    case "for_collection": {
      let body_replacements = shadow_name(replacements, stmt.item);

      if (stmt.index) {
        body_replacements = shadow_name(body_replacements, stmt.index);
      }

      return {
        tag: "for_collection",
        index: stmt.index,
        item: stmt.item,
        collection: substitute_front_expr(stmt.collection, replacements),
        body: substitute_front_block(stmt.body, body_replacements),
      };
    }

    case "if_stmt":
      return {
        tag: "if_stmt",
        cond: substitute_front_expr(stmt.cond, replacements),
        body: substitute_front_block(stmt.body, new Map(replacements)),
      };

    case "if_let_stmt": {
      let body_replacements = replacements;

      if (stmt.value_name) {
        body_replacements = shadow_name(replacements, stmt.value_name);
      }

      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: substitute_front_expr(stmt.target, replacements),
        body: substitute_front_block(stmt.body, body_replacements),
      };
    }

    case "type_check":
      return {
        tag: "type_check",
        pattern: stmt.pattern,
        target: substitute_front_expr(stmt.target, replacements),
      };

    case "break":
      if (!stmt.value) {
        return stmt;
      }

      return {
        tag: "break",
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "return":
      return {
        tag: "return",
        value: substitute_front_expr(stmt.value, replacements),
      };

    case "expr":
      return {
        tag: "expr",
        expr: substitute_front_expr(stmt.expr, replacements),
      };

    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return stmt;
  }
}

function substitute_front_fields(
  fields: Field[],
  replacements: Map<string, FrontExpr>,
): Field[] {
  return fields.map((field) => ({
    name: field.name,
    value: substitute_front_expr(field.value, replacements),
  }));
}

function shadow_params(
  replacements: Map<string, FrontExpr>,
  params: Param[],
): Map<string, FrontExpr> {
  let local = replacements;

  for (const param of params) {
    local = shadow_name(local, param.name);
  }

  return local;
}

function shadow_name(
  replacements: Map<string, FrontExpr>,
  name: string,
): Map<string, FrontExpr> {
  if (!replacements.has(name)) {
    return replacements;
  }

  const local = new Map(replacements);
  local.delete(name);
  return local;
}
