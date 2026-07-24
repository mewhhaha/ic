import type {
  Field,
  FrontExpr,
  Param,
  Pattern,
  Stmt,
  TypeExpr,
  TypeField,
} from "./ast.ts";
import { pattern_bindings } from "./pattern.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

export function substitute_front_expr(
  expr: FrontExpr,
  replacements: Map<string, FrontExpr>,
): FrontExpr {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "unsupported":
      return expr;

    case "set_type":
      return {
        tag: "set_type",
        type_expr: substitute_front_type_expr(expr.type_expr, replacements),
      };

    case "struct_type":
      return {
        tag: "struct_type",
        fields: substitute_front_type_fields(expr.fields, replacements),
      };

    case "union_type":
      return {
        tag: "union_type",
        cases: substitute_front_type_fields(expr.cases, replacements),
      };

    case "is":
      return {
        tag: "is",
        value: substitute_front_expr(expr.value, replacements),
        type_expr: substitute_front_type_expr(expr.type_expr, replacements),
      };

    case "as":
      return {
        tag: "as",
        value: substitute_front_expr(expr.value, replacements),
        type_expr: substitute_front_type_expr(expr.type_expr, replacements),
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
      const params = substitute_front_params(expr.params, replacements);
      const local = shadow_params(replacements, params);
      return {
        ...expr,
        pattern: substitute_optional_front_pattern(expr.pattern, replacements),
        params,
        body: substitute_front_expr(expr.body, local),
      };
    }

    case "rec": {
      const params = substitute_front_params(expr.params, replacements);
      const local = shadow_params(replacements, params);
      return {
        ...expr,
        pattern: substitute_optional_front_pattern(expr.pattern, replacements),
        params,
        body: substitute_front_expr(expr.body, local),
      };
    }

    case "app": {
      let arg = expr.arg;

      if (arg !== undefined) {
        arg = substitute_front_expr(arg, replacements);
      }

      const func = substitute_front_expr(expr.func, replacements);
      const args = expr.args.map((item) =>
        substitute_front_expr(item, replacements)
      );
      let call_args = args;

      if (
        func.tag === "lam" && args.length === 1 &&
        args[0]?.tag === "product" &&
        args[0].entries.length === func.params.length
      ) {
        call_args = args[0].entries.map((entry) => entry.value);
      }

      if (
        func.tag === "lam" &&
        func.body.tag === "app" && func.body.func.tag === "var" &&
        func.body.func.name.startsWith("@") &&
        func.params.length === call_args.length
      ) {
        const call_replacements = new Map<string, FrontExpr>();

        for (let index = 0; index < func.params.length; index += 1) {
          const param = func.params[index];
          const call_arg = call_args[index];

          if (param === undefined || call_arg === undefined) {
            throw new Error("Missing imported function argument " + index);
          }

          call_replacements.set(param.name, call_arg);
        }

        return substitute_front_expr(func.body, call_replacements);
      }

      return {
        ...expr,
        func,
        arg,
        args,
      };
    }

    case "product":
    case "shape":
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          ...entry,
          value: substitute_front_expr(entry.value, replacements),
        })),
      };

    case "array": {
      let rest: FrontExpr | undefined;

      if (expr.rest !== undefined) {
        rest = substitute_front_expr(expr.rest, replacements);
      }

      return {
        tag: "array",
        items: expr.items.map((item) =>
          substitute_front_expr(item, replacements)
        ),
        rest,
        leading_rest: expr.leading_rest,
      };
    }

    case "array_repeat":
      return {
        tag: "array_repeat",
        value: substitute_front_expr(expr.value, replacements),
        length: substitute_front_expr(expr.length, replacements),
      };

    case "import":
      return expr;

    case "block":
      return {
        tag: "block",
        statements: substitute_front_block(expr.statements, replacements),
      };

    case "comptime":
      return {
        tag: "comptime",
        expr: substitute_front_expr(expr.expr, replacements),
        implicit: expr.implicit,
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
        ...expr,
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

    case "type_with":
      return {
        tag: "type_with",
        base: substitute_front_expr(expr.base, replacements),
        members: expr.members.map((member) => ({
          name: substitute_front_expr(member.name, replacements),
          value: substitute_front_expr(member.value, replacements),
        })),
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

    case "match":
      return {
        tag: "match",
        target: substitute_front_expr(expr.target, replacements),
        arms: expr.arms.map((arm) => {
          let local = replacements;

          for (const binding of pattern_bindings(arm.pattern)) {
            local = shadow_name(local, binding.name);
          }

          let guard: FrontExpr | undefined;

          if (arm.guard !== undefined) {
            guard = substitute_front_expr(arm.guard, local);
          }

          return {
            pattern: arm.pattern,
            guard,
            body: substitute_front_expr(arm.body, local),
          };
        }),
      };

    case "field":
      return {
        ...expr,
        object: substitute_front_expr(expr.object, replacements),
      };

    case "index":
      return {
        ...expr,
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

function substitute_front_type_fields(
  fields: TypeField[],
  replacements: Map<string, FrontExpr>,
): TypeField[] {
  return fields.map((field) => ({
    ...field,
    type_name: format_type_expr(
      substitute_front_type_expr(
        parse_type_expr(tokenize(field.type_name)),
        replacements,
      ),
    ),
    set_member: substitute_optional_front_type_expr(
      field.set_member,
      replacements,
    ),
  }));
}

function substitute_front_params(
  params: Param[],
  replacements: Map<string, FrontExpr>,
): Param[] {
  return params.map((param) => ({
    ...param,
    annotation: substitute_front_annotation(param.annotation, replacements),
    type_annotation: substitute_optional_front_type_expr(
      param.type_annotation,
      replacements,
    ),
  }));
}

function substitute_optional_front_pattern(
  pattern: Pattern | undefined,
  replacements: Map<string, FrontExpr>,
): Pattern | undefined {
  if (pattern === undefined) {
    return undefined;
  }

  return substitute_front_pattern(pattern, replacements);
}

function substitute_front_pattern(
  pattern: Pattern,
  replacements: Map<string, FrontExpr>,
): Pattern {
  switch (pattern.tag) {
    case "binding":
      return {
        ...pattern,
        annotation: substitute_front_annotation(
          pattern.annotation,
          replacements,
        ),
        type_annotation: substitute_optional_front_type_expr(
          pattern.type_annotation,
          replacements,
        ),
      };

    case "or":
      return {
        ...pattern,
        alternatives: pattern.alternatives.map((alternative) => {
          return substitute_front_pattern(alternative, replacements);
        }),
      };

    case "const_value":
      return {
        ...pattern,
        value: substitute_front_expr(pattern.value, replacements),
      };

    case "union_case":
      return {
        ...pattern,
        value: substitute_optional_front_pattern(pattern.value, replacements),
      };

    case "product":
      return {
        ...pattern,
        entries: pattern.entries.map((entry) => ({
          ...entry,
          pattern: substitute_front_pattern(entry.pattern, replacements),
        })),
        rest: substitute_optional_front_pattern(pattern.rest, replacements),
      };

    case "record":
      return {
        ...pattern,
        fields: pattern.fields.map((field) => ({
          ...field,
          pattern: substitute_front_pattern(field.pattern, replacements),
        })),
        rest: substitute_optional_front_pattern(pattern.rest, replacements),
      };

    case "array":
      return {
        ...pattern,
        items: pattern.items.map((item) => {
          return substitute_front_pattern(item, replacements);
        }),
        rest: substitute_optional_front_pattern(pattern.rest, replacements),
      };

    case "wildcard":
    case "unit":
    case "literal":
    case "text_capture":
    case "value":
    case "type":
      return pattern;
  }
}

function substitute_front_annotation(
  annotation: string | undefined,
  replacements: Map<string, FrontExpr>,
): string | undefined {
  if (annotation === undefined) {
    return undefined;
  }

  return format_type_expr(
    substitute_front_type_expr(
      parse_type_expr(tokenize(annotation)),
      replacements,
    ),
  );
}

function substitute_optional_front_type_expr(
  type: TypeExpr | undefined,
  replacements: Map<string, FrontExpr>,
): TypeExpr | undefined {
  if (type === undefined) {
    return undefined;
  }

  return substitute_front_type_expr(type, replacements);
}

function substitute_front_type_expr(
  type: TypeExpr,
  replacements: Map<string, FrontExpr>,
): TypeExpr {
  if (type.tag === "name") {
    const replacement = replacements.get(type.name);

    if (replacement !== undefined) {
      const replacement_type = front_type_value_expr(replacement);

      if (replacement_type !== undefined) {
        return replacement_type;
      }
    }

    return type;
  }

  if (type.tag === "forall") {
    const local = new Map(replacements);

    for (const param of type.params) {
      local.delete(param);
    }

    return {
      ...type,
      body: substitute_front_type_expr(type.body, local),
    };
  }

  if (
    type.tag === "atom" || type.tag === "top" || type.tag === "never"
  ) {
    return type;
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    return {
      ...type,
      value: substitute_front_type_expr(type.value, replacements),
    };
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    return {
      ...type,
      left: substitute_front_type_expr(type.left, replacements),
      right: substitute_front_type_expr(type.right, replacements),
    };
  }

  if (type.tag === "apply") {
    return {
      tag: "apply",
      func: substitute_front_type_expr(type.func, replacements),
      arg: substitute_front_type_expr(type.arg, replacements),
    };
  }

  if (type.tag === "tuple") {
    return {
      tag: "tuple",
      items: type.items.map((item) =>
        substitute_front_type_expr(item, replacements)
      ),
    };
  }

  if (type.tag === "product") {
    return {
      ...type,
      entries: type.entries.map((entry) => ({
        ...entry,
        type_expr: substitute_front_type_expr(
          entry.type_expr,
          replacements,
        ),
      })),
    };
  }

  if (type.tag === "array") {
    return {
      ...type,
      element: substitute_front_type_expr(type.element, replacements),
    };
  }

  if (type.tag === "arrow") {
    return {
      ...type,
      param: substitute_front_type_expr(type.param, replacements),
      result: substitute_front_type_expr(type.result, replacements),
    };
  }

  if (type.tag === "literal") {
    return type;
  }

  const unreachable: never = type;
  void unreachable;
  throw new Error("Unknown type expression substitution");
}

function front_type_value_expr(value: FrontExpr): TypeExpr | undefined {
  if (value.tag === "var" || value.tag === "type_name") {
    return { tag: "name", name: value.name };
  }

  if (value.tag === "set_type") {
    return value.type_expr;
  }

  if (value.tag === "struct_type") {
    return {
      tag: "product",
      entries: value.fields.map((field) => {
        let type_expr = field.set_member;

        if (type_expr === undefined) {
          type_expr = parse_type_expr(tokenize(field.type_name));
        }

        return { label: field.name, type_expr };
      }),
    };
  }

  if (value.tag === "with") {
    return front_type_value_expr(value.base);
  }

  if (value.tag === "product") {
    const entries: Extract<TypeExpr, { tag: "product" }>["entries"] = [];

    for (const entry of value.entries) {
      const entry_type = front_type_value_expr(entry.value);

      if (entry_type === undefined) {
        return undefined;
      }

      entries.push({ label: entry.label, type_expr: entry_type });
    }

    return { tag: "product", entries };
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    const inner = front_type_value_expr(value.value);

    if (inner === undefined) {
      return undefined;
    }

    if (value.tag === "borrow") {
      return { tag: "borrow", value: inner };
    }

    return { tag: "frozen", value: inner };
  }

  if (value.tag !== "app") {
    return undefined;
  }

  let result = front_type_value_expr(value.func);

  if (result === undefined) {
    return undefined;
  }

  for (const arg of value.args) {
    const arg_type = front_type_value_expr(arg);

    if (arg_type === undefined) {
      return undefined;
    }

    result = { tag: "apply", func: result, arg: arg_type };
  }

  return result;
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

export function substitute_front_stmt(
  stmt: Stmt,
  replacements: Map<string, FrontExpr>,
): Stmt {
  switch (stmt.tag) {
    case "bind": {
      let else_branch: FrontExpr | undefined;

      if (stmt.else_branch !== undefined) {
        else_branch = substitute_front_expr(stmt.else_branch, replacements);
      }

      return {
        ...stmt,
        attribute_groups: stmt.attribute_groups?.map((group) => ({
          ...group,
          attributes: group.attributes.map((attribute) =>
            substitute_front_expr(attribute, replacements)
          ),
        })),
        pattern: substitute_optional_front_pattern(
          stmt.pattern,
          replacements,
        ),
        annotation: substitute_front_annotation(
          stmt.annotation,
          replacements,
        ),
        type_annotation: substitute_optional_front_type_expr(
          stmt.type_annotation,
          replacements,
        ),
        value: substitute_front_expr(stmt.value, replacements),
        else_branch,
      };
    }

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
        end_bound: stmt.end_bound,
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
        pattern: stmt.pattern,
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
