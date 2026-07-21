import { expect } from "../expect.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import { assigned_stmt_names } from "./assigned_names.ts";
import { clone_core_host_imports } from "./host_import.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./local_collect/types.ts";
import type { CoreLocalCollectorCallbacks } from "./local_collect_closure.ts";

export function collect_if_else_stmt_locals(
  stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: Pick<CoreLocalCollectorCallbacks, "collect_stmt_locals">,
): void {
  const cond_type = hooks.expr_type(stmt.cond, ctx);
  expect(cond_type === "i32", "Core if else statement condition must be i32");
  const planned_cond = hooks.plan_static_capture_expr(
    "if_cond",
    stmt.cond,
    ctx,
    undefined,
  );
  const statics = new Map(ctx.statics);
  const then_ctx = create_if_branch_ctx(
    ctx,
    statics,
    ctx.fn_types,
    ctx.next_loop,
    ctx.next_temp,
  );

  for (const item of stmt.then_body) {
    callbacks.collect_stmt_locals(item, then_ctx, hooks);
  }

  const else_ctx = create_if_branch_ctx(
    ctx,
    statics,
    then_ctx.fn_types,
    then_ctx.next_loop,
    then_ctx.next_temp,
  );

  for (const item of stmt.else_body) {
    callbacks.collect_stmt_locals(item, else_ctx, hooks);
  }

  ctx.next_loop = else_ctx.next_loop;
  ctx.next_temp = else_ctx.next_temp;
  merge_branch_locals(ctx.locals, then_ctx.locals);
  merge_branch_locals(ctx.locals, else_ctx.locals);
  merge_generated_temp_facts(ctx, then_ctx);
  merge_generated_temp_facts(ctx, else_ctx);

  hooks.merge_if_else_static_assignments(
    stmt,
    planned_cond.value,
    then_ctx.statics,
    else_ctx.statics,
    ctx,
    undefined,
  );

  merge_assigned_runtime_facts(stmt, ctx, then_ctx, else_ctx);
}

export function collect_if_expr_branch_locals(
  expr: Extract<CoreExpr, { tag: "if" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: Pick<CoreLocalCollectorCallbacks, "collect_expr_locals">,
): void {
  const then_ctx = create_if_branch_ctx(
    ctx,
    ctx.statics,
    ctx.fn_types,
    ctx.next_loop,
    ctx.next_temp,
  );
  callbacks.collect_expr_locals(expr.then_branch, then_ctx, hooks);
  const else_ctx = create_if_branch_ctx(
    ctx,
    ctx.statics,
    then_ctx.fn_types,
    then_ctx.next_loop,
    then_ctx.next_temp,
  );
  callbacks.collect_expr_locals(expr.else_branch, else_ctx, hooks);

  ctx.next_loop = else_ctx.next_loop;
  ctx.next_temp = else_ctx.next_temp;
  merge_branch_locals(ctx.locals, then_ctx.locals);
  merge_branch_locals(ctx.locals, else_ctx.locals);
  merge_generated_temp_facts(ctx, then_ctx);
  merge_generated_temp_facts(ctx, else_ctx);
}

function create_if_branch_ctx(
  ctx: CoreCtx,
  statics: CoreCtx["statics"],
  fn_types: CoreCtx["fn_types"],
  next_loop: number,
  next_temp: number,
): CoreCtx {
  return {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(statics),
    fn_types: new Map(fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: ctx.materialized_bindings,
    mutable_bindings: ctx.mutable_bindings,
    next_loop,
    next_temp,
  };
}

function merge_branch_locals(
  target: CoreCtx["locals"],
  branch: CoreCtx["locals"],
): void {
  for (const [name, type] of branch) {
    const existing = target.get(name);
    if (existing !== undefined) {
      expect(existing === type, "Core if branch local type mismatch: " + name);
      continue;
    }

    target.set(name, type);
  }
}

function merge_assigned_runtime_facts(
  stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
  target: CoreCtx,
  then_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  for (const name of assigned_stmt_names(stmt)) {
    merge_assigned_text_fact(name, target, then_ctx, else_ctx);
    merge_assigned_type_fact(
      name,
      target.struct_locals,
      then_ctx.struct_locals,
      else_ctx.struct_locals,
    );
    merge_assigned_type_fact(
      name,
      target.union_locals,
      then_ctx.union_locals,
      else_ctx.union_locals,
    );
    merge_assigned_frozen_fact(name, target, then_ctx, else_ctx);
  }
}

function merge_assigned_text_fact(
  name: string,
  target: CoreCtx,
  then_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  if (then_ctx.text_locals.has(name) && else_ctx.text_locals.has(name)) {
    target.text_locals.add(name);
    return;
  }

  target.text_locals.delete(name);
}

function merge_assigned_type_fact(
  name: string,
  target: Map<string, CoreExpr>,
  then_facts: Map<string, CoreExpr>,
  else_facts: Map<string, CoreExpr>,
): void {
  const then_type = then_facts.get(name);
  const else_type = else_facts.get(name);

  if (!then_type || !else_type) {
    target.delete(name);
    return;
  }

  if (!same_core_fact_expr(then_type, else_type)) {
    target.delete(name);
    return;
  }

  target.set(name, then_type);
}

function merge_assigned_frozen_fact(
  name: string,
  target: CoreCtx,
  then_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  if (!then_ctx.frozen_locals || !else_ctx.frozen_locals) {
    if (target.frozen_locals) {
      target.frozen_locals.delete(name);
    }
    return;
  }

  if (
    then_ctx.frozen_locals.has(name) &&
    else_ctx.frozen_locals.has(name)
  ) {
    if (!target.frozen_locals) {
      target.frozen_locals = new Set();
    }

    target.frozen_locals.add(name);
    return;
  }

  if (target.frozen_locals) {
    target.frozen_locals.delete(name);
  }
}

function same_core_fact_expr(left: CoreExpr, right: CoreExpr): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function merge_generated_temp_facts(target: CoreCtx, source: CoreCtx): void {
  for (const name of source.text_locals) {
    if (is_generated_temp_name(name)) {
      target.text_locals.add(name);
    }
  }

  for (const [name, value] of source.struct_locals) {
    if (is_generated_temp_name(name)) {
      target.struct_locals.set(name, value);
    }
  }

  for (const [name, value] of source.union_locals) {
    if (is_generated_temp_name(name)) {
      target.union_locals.set(name, value);
    }
  }

  for (const [name, value] of source.fn_types) {
    if (is_generated_temp_name(name)) {
      target.fn_types.set(name, value);
    }
  }

  if (!source.frozen_locals) {
    return;
  }

  if (!target.frozen_locals) {
    target.frozen_locals = new Set();
  }

  for (const name of source.frozen_locals) {
    if (is_generated_temp_name(name)) {
      target.frozen_locals.add(name);
    }
  }
}

function is_generated_temp_name(name: string): boolean {
  return name.startsWith("_") && name.includes("#");
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function clone_optional_map<K, V>(
  value: Map<K, V> | undefined,
): Map<K, V> | undefined {
  if (!value) {
    return undefined;
  }

  return new Map(value);
}
