import { expect } from "../../expect.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { unwrap_ownership_wrapper_context_expr } from "../ownership.ts";
import type { StaticRecHooks } from "../rec_hooks.ts";

export function lower_static_rec_bind(
  stmt: Extract<Stmt, { tag: "bind" }>,
  local: Env,
  hooks: StaticRecHooks,
): void {
  let value = stmt.value;

  if (stmt.kind === "const") {
    value = hooks.prepare_const_value(value, local);
    hooks.push_binding(local, {
      name: stmt.name,
      ic_name: stmt.name,
      type: hooks.infer_expr(value, local),
      is_const: true,
      is_linear: stmt.is_linear,
      value,
      value_env: undefined,
    });
    return;
  }

  value = hooks.prepare_runtime_value(value, local);

  if (value.tag === "index") {
    const resolved = hooks.resolve_index_expr(value, local);

    if (resolved !== undefined) {
      value = { tag: "captured", expr: resolved.expr, env: resolved.env };
    }
  } else if (value.tag === "field") {
    const resolved = hooks.resolve_struct_field_expr(value, local);

    if (resolved !== undefined) {
      value = { tag: "captured", expr: resolved.expr, env: resolved.env };
    }
  }

  let value_type = hooks.infer_expr(value, local);

  if (stmt.annotation) {
    const annotated = hooks.apply_runtime_binding_annotation(
      stmt.annotation,
      value,
      local,
    );
    value = annotated.value;
    value_type = annotated.type;
    value = unwrap_ownership_wrapper_context_expr(value);
  }

  hooks.push_binding(local, {
    name: stmt.name,
    ic_name: hooks.fresh(local, stmt.name),
    type: value_type,
    is_const: false,
    is_linear: stmt.is_linear,
    value,
    value_env: hooks.clone_env(local),
    is_deferred: can_defer_rec_binding_value(value, value_type),
  });
}

export function lower_static_rec_assign(
  stmt: Extract<Stmt, { tag: "assign" }>,
  local: Env,
  hooks: StaticRecHooks,
): void {
  const previous = hooks.lookup(local, stmt.name);
  expect(previous, "Cannot assign unbound name: " + stmt.name);
  let value = hooks.prepare_runtime_value(stmt.value, local);
  let value_type = hooks.infer_expr(value, local);

  if (stmt.mode === "same" && !hooks.same_type(previous.type, value_type)) {
    throw new Error("Assignment changes type for " + stmt.name);
  }

  value_type = hooks.assignment_type(
    previous.type,
    value_type,
    stmt.mode,
  );

  if (stmt.mode === "same") {
    value = unwrap_ownership_wrapper_context_expr(value);
  }

  hooks.push_binding(local, {
    name: stmt.name,
    ic_name: hooks.fresh(local, stmt.name),
    type: value_type,
    is_const: false,
    is_linear: previous.is_linear,
    value,
    value_env: hooks.clone_env(local),
  });
}

export function lower_static_rec_index_assign(
  stmt: Extract<Stmt, { tag: "index_assign" }>,
  local: Env,
  hooks: StaticRecHooks,
): void {
  const value = hooks.apply_index_assignment(stmt, local);
  hooks.push_binding(local, {
    name: stmt.name,
    ic_name: hooks.fresh(local, stmt.name),
    type: hooks.infer_expr(value, local),
    is_const: false,
    is_linear: false,
    value,
    value_env: hooks.clone_env(local),
  });
}

function can_defer_rec_binding_value(
  value: FrontExpr,
  type: FrontType,
): boolean {
  if (type.tag !== "unknown") {
    return false;
  }

  if (value.tag === "captured") {
    return can_defer_rec_binding_value(value.expr, type);
  }

  return value.tag === "if" || value.tag === "if_let";
}
