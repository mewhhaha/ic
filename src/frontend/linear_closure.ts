import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import {
  canonical_linear_closure_params,
  rename_linear_closure_body,
  same_linear_closure_param_shape,
} from "./linear_closure_rename.ts";
import {
  inherit_linear_source_span,
  type LinearState,
} from "./linear_state.ts";

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
    consumed_at: Map<LinearClosureBinding, FrontExpr>;
    declarations: Map<string, object>;
  };

export function create_linear_closures(): LinearClosureEnv {
  const closures = new Map<string, LinearClosureBinding>() as LinearClosureEnv;
  closures.next_id = 0;
  closures.used = new Set();
  closures.consumed_at = new Map();
  closures.declarations = new Map();
  return closures;
}

export function clone_linear_closures(
  closures: LinearClosureEnv,
): LinearClosureEnv {
  const clone = new Map(closures) as LinearClosureEnv;
  clone.next_id = closures.next_id;
  clone.used = new Set(closures.used);
  clone.consumed_at = new Map(closures.consumed_at);
  clone.declarations = new Map(closures.declarations);
  return clone;
}

export function bind_linear_closure(
  closures: LinearClosureEnv,
  name: string,
  value: FrontExpr,
  available: LinearState,
  declaration: object,
): void {
  if (available.has(name)) {
    closures.delete(name);
    closures.declarations.delete(name);
    return;
  }

  const ref = resolve_linear_closure_ref(value, closures);

  if (ref) {
    if (ref.binding) {
      closures.set(name, ref.binding);
      closures.declarations.set(name, declaration);
      return;
    }

    closures.set(name, {
      id: closures.next_id,
      expr: ref.expr,
    });
    closures.declarations.set(name, declaration);
    closures.next_id += 1;
    return;
  }

  closures.delete(name);
  closures.declarations.delete(name);
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
  const body = inherit_linear_source_span({
    tag: "if" as const,
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
  }, value);

  return inherit_linear_source_span({
    tag: "lam" as const,
    params,
    body,
  }, value);
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
  const body = inherit_linear_source_span({
    tag: "if_let" as const,
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
  }, value);

  return inherit_linear_source_span({
    tag: "lam" as const,
    params,
    body,
  }, value);
}

export function merge_used_linear_closures(
  target: LinearClosureEnv,
  source: LinearClosureEnv,
): void {
  for (const id of source.used) {
    target.used.add(id);

    const consumed_at = source.consumed_at.get(id);

    if (consumed_at) {
      target.consumed_at.set(id, consumed_at);
    }
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
  if (value.cond.tag === "bool") {
    if (value.cond.value) {
      return value.then_branch;
    }

    return value.else_branch;
  }

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
