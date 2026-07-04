import { expect } from "../expect.ts";
import type { Field, FrontExpr, Param, Stmt } from "./ast.ts";
import { is_builtin_type_name, same_param_annotation } from "./types.ts";

export type LinearClosureBinding = {
  id: number;
  expr: Extract<FrontExpr, { tag: "lam" }>;
};

export type LinearClosureRef = {
  binding?: LinearClosureBinding;
  expr: Extract<FrontExpr, { tag: "lam" }>;
};

export type LinearClosureEnv =
  & Map<string, LinearClosureBinding>
  & {
    next_id: number;
    used: Set<LinearClosureBinding>;
  };

export function create_linear_closures(): LinearClosureEnv {
  const closures = new Map<string, LinearClosureBinding>() as LinearClosureEnv;
  closures.next_id = 0;
  closures.used = new Set();
  return closures;
}

export function clone_linear_closures(
  closures: LinearClosureEnv,
): LinearClosureEnv {
  const clone = new Map(closures) as LinearClosureEnv;
  clone.next_id = closures.next_id;
  clone.used = new Set(closures.used);
  return clone;
}

export function bind_linear_closure(
  closures: LinearClosureEnv,
  name: string,
  value: FrontExpr,
  available: Set<string>,
): void {
  if (available.has(name)) {
    closures.delete(name);
    return;
  }

  const ref = resolve_linear_closure_ref(value, closures);

  if (ref) {
    if (ref.binding) {
      closures.set(name, ref.binding);
      return;
    }

    closures.set(name, {
      id: closures.next_id,
      expr: ref.expr,
    });
    closures.next_id += 1;
    return;
  }

  closures.delete(name);
}

export function resolve_linear_closure_expr(
  value: FrontExpr,
  closures: LinearClosureEnv,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  const ref = resolve_linear_closure_ref(value, closures);

  if (!ref) {
    return undefined;
  }

  return ref.expr;
}

export function resolve_linear_closure_ref(
  value: FrontExpr,
  closures: LinearClosureEnv,
): LinearClosureRef | undefined {
  const unwrapped = unwrap_linear_closure_value(value);

  if (unwrapped.tag === "lam") {
    return { expr: unwrapped };
  }

  if (unwrapped.tag === "if") {
    const branch = static_if_branch(unwrapped);

    if (branch) {
      return resolve_linear_closure_ref(branch, closures);
    }

    const closure = dynamic_if_linear_closure(unwrapped, closures);

    if (closure) {
      return { expr: closure };
    }
  }

  if (unwrapped.tag === "if_let") {
    const closure = dynamic_if_let_linear_closure(unwrapped, closures);

    if (closure) {
      return { expr: closure };
    }
  }

  if (unwrapped.tag === "var") {
    const binding = closures.get(unwrapped.name);

    if (binding) {
      return {
        binding,
        expr: binding.expr,
      };
    }
  }

  return undefined;
}

function dynamic_if_linear_closure(
  value: Extract<FrontExpr, { tag: "if" }>,
  closures: LinearClosureEnv,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  const then_ref = resolve_linear_closure_ref(value.then_branch, closures);
  const else_ref = resolve_linear_closure_ref(value.else_branch, closures);

  if (!then_ref || !else_ref) {
    return undefined;
  }

  if (!same_linear_closure_param_shape(then_ref.expr, else_ref.expr)) {
    return undefined;
  }

  const params = canonical_linear_closure_params(value, then_ref.expr.params);

  return {
    tag: "lam",
    params,
    body: {
      tag: "if",
      cond: value.cond,
      then_branch: rename_linear_closure_body(
        then_ref.expr.body,
        then_ref.expr.params,
        params,
      ),
      else_branch: rename_linear_closure_body(
        else_ref.expr.body,
        else_ref.expr.params,
        params,
      ),
    },
  };
}

function dynamic_if_let_linear_closure(
  value: Extract<FrontExpr, { tag: "if_let" }>,
  closures: LinearClosureEnv,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  const then_ref = resolve_linear_closure_ref(value.then_branch, closures);
  const else_ref = resolve_linear_closure_ref(value.else_branch, closures);

  if (!then_ref || !else_ref) {
    return undefined;
  }

  if (!same_linear_closure_param_shape(then_ref.expr, else_ref.expr)) {
    return undefined;
  }

  const params = canonical_linear_closure_params(value, then_ref.expr.params);

  return {
    tag: "lam",
    params,
    body: {
      tag: "if_let",
      case_name: value.case_name,
      value_name: value.value_name,
      target: value.target,
      then_branch: rename_linear_closure_body(
        then_ref.expr.body,
        then_ref.expr.params,
        params,
      ),
      else_branch: rename_linear_closure_body(
        else_ref.expr.body,
        else_ref.expr.params,
        params,
      ),
      implicit_else: value.implicit_else,
    },
  };
}

function same_linear_closure_param_shape(
  left: Extract<FrontExpr, { tag: "lam" }>,
  right: Extract<FrontExpr, { tag: "lam" }>,
): boolean {
  if (left.params.length !== right.params.length) {
    return false;
  }

  for (let index = 0; index < left.params.length; index += 1) {
    const left_param = left.params[index];
    const right_param = right.params[index];
    expect(left_param, "Missing left linear closure parameter");
    expect(right_param, "Missing right linear closure parameter");

    if (left_param.is_const !== right_param.is_const) {
      return false;
    }

    if (left_param.is_linear !== right_param.is_linear) {
      return false;
    }

    if (
      !same_linear_closure_param_annotation(
        left_param.annotation,
        right_param.annotation,
      )
    ) {
      return false;
    }
  }

  return true;
}

function same_linear_closure_param_annotation(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (same_param_annotation(left, right)) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (is_builtin_type_name(left) || is_builtin_type_name(right)) {
    return false;
  }

  return true;
}

function canonical_linear_closure_params(
  value: FrontExpr,
  params: Param[],
): Param[] {
  const used = new Set<string>();
  collect_linear_closure_names(value, used);

  return params.map((param, index) => ({
    name: fresh_linear_closure_param_name(used, index),
    is_const: param.is_const,
    is_linear: param.is_linear,
    annotation: param.annotation,
  }));
}

function fresh_linear_closure_param_name(
  used: Set<string>,
  index: number,
): string {
  let suffix = index;

  while (true) {
    const name = "__linear_closure_param#" + suffix.toString();

    if (!used.has(name)) {
      used.add(name);
      return name;
    }

    suffix += 1;
  }
}

function rename_linear_closure_body(
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

function collect_linear_closure_names(
  expr: FrontExpr,
  names: Set<string>,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "type_name":
    case "var":
    case "linear":
      names.add(expr.name);
      return;

    case "prim":
      collect_linear_closure_names(expr.left, names);
      collect_linear_closure_names(expr.right, names);
      return;

    case "lam":
    case "rec":
      for (const param of expr.params) {
        names.add(param.name);
      }

      collect_linear_closure_names(expr.body, names);
      return;

    case "app":
      collect_linear_closure_names(expr.func, names);

      for (const arg of expr.args) {
        collect_linear_closure_names(arg, names);
      }

      return;

    case "block":
      collect_linear_closure_stmt_names(expr.statements, names);
      return;

    case "comptime":
      collect_linear_closure_names(expr.expr, names);
      return;

    case "borrow":
    case "freeze":
      collect_linear_closure_names(expr.value, names);
      return;

    case "scratch":
      collect_linear_closure_names(expr.body, names);
      return;

    case "captured":
      collect_linear_closure_names(expr.expr, names);
      return;

    case "with":
      collect_linear_closure_names(expr.base, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "struct_value":
      collect_linear_closure_names(expr.type_expr, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "struct_update":
      collect_linear_closure_names(expr.base, names);
      collect_linear_closure_field_names(expr.fields, names);
      return;

    case "if":
      collect_linear_closure_names(expr.cond, names);
      collect_linear_closure_names(expr.then_branch, names);
      collect_linear_closure_names(expr.else_branch, names);
      return;

    case "if_let":
      if (expr.value_name) {
        names.add(expr.value_name);
      }

      collect_linear_closure_names(expr.target, names);
      collect_linear_closure_names(expr.then_branch, names);
      collect_linear_closure_names(expr.else_branch, names);
      return;

    case "field":
      collect_linear_closure_names(expr.object, names);
      return;

    case "index":
      collect_linear_closure_names(expr.object, names);
      collect_linear_closure_names(expr.index, names);
      return;

    case "union_case":
      if (expr.value) {
        collect_linear_closure_names(expr.value, names);
      }

      if (expr.type_expr) {
        collect_linear_closure_names(expr.type_expr, names);
      }

      return;
  }
}

function collect_linear_closure_stmt_names(
  stmts: Stmt[],
  names: Set<string>,
): void {
  for (const stmt of stmts) {
    switch (stmt.tag) {
      case "bind":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "assign":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "index_assign":
        names.add(stmt.name);
        collect_linear_closure_names(stmt.index, names);
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "for_range":
        names.add(stmt.index);
        collect_linear_closure_names(stmt.start, names);
        collect_linear_closure_names(stmt.end, names);
        collect_linear_closure_names(stmt.step, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "for_collection":
        if (stmt.index) {
          names.add(stmt.index);
        }

        names.add(stmt.item);
        collect_linear_closure_names(stmt.collection, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "if_stmt":
        collect_linear_closure_names(stmt.cond, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "if_let_stmt":
        if (stmt.value_name) {
          names.add(stmt.value_name);
        }

        collect_linear_closure_names(stmt.target, names);
        collect_linear_closure_stmt_names(stmt.body, names);
        continue;

      case "type_check":
        collect_linear_closure_names(stmt.target, names);
        continue;

      case "return":
        collect_linear_closure_names(stmt.value, names);
        continue;

      case "expr":
        collect_linear_closure_names(stmt.expr, names);
        continue;

      case "import":
      case "host_import":
      case "break":
      case "continue":
      case "unsupported":
        continue;
    }
  }
}

function collect_linear_closure_field_names(
  fields: Field[],
  names: Set<string>,
): void {
  for (const field of fields) {
    collect_linear_closure_names(field.value, names);
  }
}

export function merge_used_linear_closures(
  target: LinearClosureEnv,
  source: LinearClosureEnv,
): void {
  for (const id of source.used) {
    target.used.add(id);
  }
}

function unwrap_linear_closure_value(value: FrontExpr): FrontExpr {
  if (value.tag !== "block" || value.statements.length !== 1) {
    if (value.tag === "block") {
      const unwrapped = unwrap_simple_linear_closure_block(value.statements);

      if (unwrapped) {
        return unwrapped;
      }
    }

    return value;
  }

  const stmt = value.statements[0];
  expect(stmt, "Missing linear closure block statement");

  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return value;
}

function unwrap_simple_linear_closure_block(
  stmts: Stmt[],
): FrontExpr | undefined {
  const local = new Map<string, FrontExpr>();

  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing linear closure block statement " + index.toString());

    if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        return undefined;
      }

      local.set(
        stmt.name,
        unwrap_local_linear_closure_value(stmt.value, local),
      );
      continue;
    }

    if (stmt.tag === "assign") {
      local.set(
        stmt.name,
        unwrap_local_linear_closure_value(stmt.value, local),
      );
      continue;
    }

    if (stmt.tag === "expr") {
      return unwrap_local_linear_closure_value(stmt.expr, local);
    }

    if (stmt.tag === "return") {
      return unwrap_local_linear_closure_value(stmt.value, local);
    }

    return undefined;
  }

  return undefined;
}

function unwrap_local_linear_closure_value(
  value: FrontExpr,
  local: Map<string, FrontExpr>,
): FrontExpr {
  const unwrapped = unwrap_linear_closure_value(value);

  if (unwrapped.tag === "var") {
    const local_value = local.get(unwrapped.name);

    if (local_value) {
      return local_value;
    }
  }

  return unwrapped;
}

function static_if_branch(
  value: Extract<FrontExpr, { tag: "if" }>,
): FrontExpr | undefined {
  if (value.cond.tag !== "num") {
    return undefined;
  }

  if (value.cond.type !== "i32") {
    return undefined;
  }

  const cond = value.cond.value;
  expect(typeof cond === "number", "Expected i32 static if condition");

  if (cond !== 0) {
    return value.then_branch;
  }

  return value.else_branch;
}
