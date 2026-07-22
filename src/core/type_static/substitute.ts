import type { TypeExpr, TypePattern } from "../../type_syntax.ts";
import type {
  CoreExpr,
  CoreField,
  CoreParam,
  CoreStmt,
  CoreTypeField,
} from "../ast.ts";

export function substitute_core_type_expr(
  expr: CoreExpr,
  type_args: Map<string, string>,
): CoreExpr {
  switch (expr.tag) {
    case "type_name":
      return {
        tag: "type_name",
        name: substitute_core_type_name(expr.name, type_args),
      };

    case "var": {
      const type_name = type_args.get(expr.name);

      if (type_name) {
        return { tag: "type_name", name: type_name };
      }

      return expr;
    }

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        args: expr.args.map((arg) => substitute_core_type_expr(arg, type_args)),
      };

    case "lam": {
      const local_type_args = scoped_type_args(type_args, expr.params);

      return {
        tag: "lam",
        params: expr.params,
        body: substitute_core_type_expr(expr.body, local_type_args),
      };
    }

    case "rec": {
      const local_type_args = scoped_type_args(type_args, expr.params);

      return {
        tag: "rec",
        params: expr.params,
        body: substitute_core_type_expr(expr.body, local_type_args),
      };
    }

    case "rec_ref":
      return expr;

    case "app":
      return {
        tag: "app",
        func: substitute_core_type_expr(expr.func, type_args),
        args: expr.args.map((arg) => substitute_core_type_expr(arg, type_args)),
        resume_payload: expr.resume_payload,
      };

    case "block":
      return {
        tag: "block",
        statements: expr.statements.map((stmt) =>
          substitute_core_type_stmt(stmt, type_args)
        ),
      };

    case "loop":
      return {
        tag: "loop",
        body: expr.body.map((stmt) =>
          substitute_core_type_stmt(stmt, type_args)
        ),
      };

    case "comptime":
      return {
        tag: "comptime",
        expr: substitute_core_type_expr(expr.expr, type_args),
      };

    case "borrow":
      return {
        tag: "borrow",
        value: substitute_core_type_expr(expr.value, type_args),
      };

    case "freeze":
      return {
        tag: "freeze",
        value: substitute_core_type_expr(expr.value, type_args),
      };

    case "scratch":
      return {
        tag: "scratch",
        body: substitute_core_type_expr(expr.body, type_args),
      };

    case "with":
      return {
        tag: "with",
        base: substitute_core_type_expr(expr.base, type_args),
        fields: expr.fields.map((field) =>
          substitute_core_type_field(field, type_args)
        ),
      };

    case "struct_type":
      return {
        tag: "struct_type",
        fields: expr.fields.map((field) =>
          substitute_core_type_decl(field, type_args)
        ),
      };

    case "struct_value":
      return {
        tag: "struct_value",
        type_expr: substitute_core_type_expr(expr.type_expr, type_args),
        fields: expr.fields.map((field) =>
          substitute_core_type_field(field, type_args)
        ),
      };

    case "struct_update":
      return {
        tag: "struct_update",
        base: substitute_core_type_expr(expr.base, type_args),
        fields: expr.fields.map((field) =>
          substitute_core_type_field(field, type_args)
        ),
      };

    case "union_type":
      return {
        tag: "union_type",
        cases: expr.cases.map((field) =>
          substitute_core_type_decl(field, type_args)
        ),
      };

    case "if":
      return {
        tag: "if",
        cond: substitute_core_type_expr(expr.cond, type_args),
        then_branch: substitute_core_type_expr(expr.then_branch, type_args),
        else_branch: substitute_core_type_expr(expr.else_branch, type_args),
        implicit_else: expr.implicit_else,
      };

    case "if_let":
      return {
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: substitute_core_type_expr(expr.target, type_args),
        then_branch: substitute_core_type_expr(expr.then_branch, type_args),
        else_branch: substitute_core_type_expr(expr.else_branch, type_args),
        implicit_else: expr.implicit_else,
      };

    case "field":
      return {
        tag: "field",
        object: substitute_core_type_expr(expr.object, type_args),
        name: expr.name,
      };

    case "index":
      return {
        tag: "index",
        object: substitute_core_type_expr(expr.object, type_args),
        index: substitute_core_type_expr(expr.index, type_args),
      };

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        value = substitute_core_type_expr(expr.value, type_args);
      }

      if (expr.type_expr) {
        type_expr = substitute_core_type_expr(expr.type_expr, type_args);
      }

      return {
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
        resume_payload: expr.resume_payload,
      };
    }

    case "num":
    case "text":
    case "linear":
    case "unsupported":
      return expr;
  }
}

function substitute_core_type_stmt(
  stmt: CoreStmt,
  type_args: Map<string, string>,
): CoreStmt {
  switch (stmt.tag) {
    case "bind": {
      let annotation: string | undefined;

      if (stmt.annotation) {
        annotation = substitute_core_type_name(stmt.annotation, type_args);
      }

      return {
        tag: "bind",
        kind: stmt.kind,
        name: stmt.name,
        is_linear: stmt.is_linear,
        annotation,
        value: substitute_core_type_expr(stmt.value, type_args),
      };
    }

    case "assign":
      return {
        tag: "assign",
        name: stmt.name,
        mode: stmt.mode,
        value: substitute_core_type_expr(stmt.value, type_args),
      };

    case "index_assign":
      return {
        tag: "index_assign",
        name: stmt.name,
        index: substitute_core_type_expr(stmt.index, type_args),
        value: substitute_core_type_expr(stmt.value, type_args),
      };

    case "range_loop":
      return {
        tag: "range_loop",
        index: stmt.index,
        start: substitute_core_type_expr(stmt.start, type_args),
        end: substitute_core_type_expr(stmt.end, type_args),
        end_bound: stmt.end_bound,
        step: substitute_core_type_expr(stmt.step, type_args),
        carried: stmt.carried,
        body: stmt.body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
      };

    case "collection_loop":
      return {
        tag: "collection_loop",
        index: stmt.index,
        item: stmt.item,
        collection: substitute_core_type_expr(stmt.collection, type_args),
        carried: stmt.carried,
        body: stmt.body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
      };

    case "if_stmt":
      return {
        tag: "if_stmt",
        cond: substitute_core_type_expr(stmt.cond, type_args),
        body: stmt.body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
      };

    case "if_else_stmt":
      return {
        tag: "if_else_stmt",
        cond: substitute_core_type_expr(stmt.cond, type_args),
        then_body: stmt.then_body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
        else_body: stmt.else_body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
      };

    case "if_let_stmt":
      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: substitute_core_type_expr(stmt.target, type_args),
        body: stmt.body.map((item) =>
          substitute_core_type_stmt(item, type_args)
        ),
      };

    case "type_check":
      return {
        tag: "type_check",
        pattern: substitute_core_type_pattern(stmt.pattern, type_args),
        target: substitute_core_type_expr(stmt.target, type_args),
      };

    case "return":
      return {
        tag: "return",
        value: substitute_core_type_expr(stmt.value, type_args),
      };

    case "expr":
      return {
        tag: "expr",
        expr: substitute_core_type_expr(stmt.expr, type_args),
      };

    case "break":
      if (!stmt.value) {
        return stmt;
      }
      return {
        tag: "break",
        value: substitute_core_type_expr(stmt.value, type_args),
      };
    case "continue":
    case "unsupported":
      return stmt;
  }
}

function substitute_core_type_field(
  field: CoreField,
  type_args: Map<string, string>,
): CoreField {
  return {
    name: field.name,
    value: substitute_core_type_expr(field.value, type_args),
  };
}

function substitute_core_type_decl(
  field: CoreTypeField,
  type_args: Map<string, string>,
): CoreTypeField {
  const result: CoreTypeField = {
    name: field.name,
    type_name: substitute_core_type_name(field.type_name, type_args),
  };

  if (field.set_member) {
    result.set_member = substitute_core_type_set_member(
      field.set_member,
      type_args,
    );
  }

  return result;
}

function substitute_core_type_set_member(
  type: TypeExpr,
  type_args: Map<string, string>,
): TypeExpr {
  switch (type.tag) {
    case "forall": {
      const scoped = new Map(type_args);

      for (const param of type.params) {
        scoped.delete(param);
      }

      return {
        ...type,
        body: substitute_core_type_set_member(type.body, scoped),
      };
    }

    case "name":
      return {
        tag: "name",
        name: substitute_core_type_name(type.name, type_args),
      };

    case "atom":
    case "literal":
    case "top":
    case "never":
      return type;

    case "frozen":
    case "borrow":
      return {
        ...type,
        value: substitute_core_type_set_member(type.value, type_args),
      };

    case "union":
    case "intersection":
    case "difference":
      return {
        ...type,
        left: substitute_core_type_set_member(type.left, type_args),
        right: substitute_core_type_set_member(type.right, type_args),
      };

    case "apply":
      return {
        tag: "apply",
        func: substitute_core_type_set_member(type.func, type_args),
        arg: substitute_core_type_set_member(type.arg, type_args),
      };

    case "tuple":
      return {
        tag: "tuple",
        items: type.items.map((item) =>
          substitute_core_type_set_member(item, type_args)
        ),
      };

    case "product":
      return {
        tag: "product",
        entries: type.entries.map((entry) => ({
          ...entry,
          type_expr: substitute_core_type_set_member(
            entry.type_expr,
            type_args,
          ),
        })),
      };

    case "array":
      return {
        ...type,
        element: substitute_core_type_set_member(type.element, type_args),
      };

    case "arrow":
      return {
        ...type,
        param: substitute_core_type_set_member(type.param, type_args),
        result: substitute_core_type_set_member(type.result, type_args),
      };
  }
}

function substitute_core_type_pattern(
  pattern: TypePattern,
  type_args: Map<string, string>,
): TypePattern {
  return {
    kind: pattern.kind,
    open: pattern.open,
    fields: pattern.fields.map((field) => ({
      name: field.name,
      type_name: substitute_core_type_name(field.type_name, type_args),
    })),
  };
}

function substitute_core_type_name(
  name: string,
  type_args: Map<string, string>,
): string {
  const type_name = type_args.get(name);

  if (type_name) {
    return type_name;
  }

  const names = name.split(" ");

  if (names.length > 1) {
    return names.map((part) => {
      const replacement = type_args.get(part);

      if (replacement) {
        return replacement;
      }

      return part;
    }).join(" ");
  }

  return name;
}

function scoped_type_args(
  type_args: Map<string, string>,
  params: CoreParam[],
): Map<string, string> {
  const scoped = new Map(type_args);

  for (const param of params) {
    scoped.delete(param.name);
  }

  return scoped;
}
