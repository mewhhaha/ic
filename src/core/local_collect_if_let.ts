import type { CoreExpr, CoreStmt } from "./ast.ts";
import { assigned_stmt_names } from "./assigned_names.ts";
import { fresh_temp_local, set_local } from "./backend/util.ts";
import { clone_core_host_imports } from "./host_import.ts";
import { core_if_let_match_condition, type DynamicUnionIf } from "./if_let.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./local_collect/types.ts";
import {
  runtime_union_match_info,
  type RuntimeUnionTarget,
} from "./runtime_union.ts";
import { core_runtime_union_match_branch_ctx } from "./runtime_union_match.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";

export type CoreIfLetLocalCollectApi = {
  collect_expr_locals: (
    expr: CoreExpr,
    ctx: CoreCtx,
    hooks: CoreLocalCollectHooks,
  ) => void;
  collect_stmt_locals: (
    stmt: CoreStmt,
    ctx: CoreCtx,
    hooks: CoreLocalCollectHooks,
  ) => void;
};

export function collect_core_if_let_stmt_locals(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): void {
  const union_case = hooks.static_union_case(stmt.target, ctx);

  if (union_case) {
    if (union_case.name !== stmt.case_name) {
      return;
    }

    hooks.bind_core_if_let_payload_fact(
      stmt.value_name,
      union_case,
      ctx,
    );

    for (const item of stmt.body) {
      api.collect_stmt_locals(item, ctx, hooks);
    }

    return;
  }

  const dynamic_target = hooks.dynamic_union_if(stmt.target, ctx);

  if (dynamic_target) {
    hooks.expr_type(dynamic_target.cond, ctx);

    if (!dynamic_if_let_can_match(stmt.case_name, dynamic_target)) {
      return;
    }

    const base_statics = new Map(ctx.statics);
    const then_ctx = create_if_let_branch_ctx(ctx);
    const then_matched = collect_dynamic_if_let_stmt_case_locals(
      stmt,
      dynamic_target.then_case,
      dynamic_target,
      then_ctx,
      hooks,
      api,
    );

    const else_ctx = create_if_let_branch_ctx(ctx);
    else_ctx.fn_types = new Map(then_ctx.fn_types);
    else_ctx.next_loop = then_ctx.next_loop;
    else_ctx.next_temp = then_ctx.next_temp;
    const else_matched = collect_dynamic_if_let_stmt_case_locals(
      stmt,
      dynamic_target.else_case,
      dynamic_target,
      else_ctx,
      hooks,
      api,
    );

    ctx.next_loop = else_ctx.next_loop;
    ctx.next_temp = else_ctx.next_temp;
    merge_generated_temp_facts(ctx, then_ctx);
    merge_generated_temp_facts(ctx, else_ctx);

    let then_statics = base_statics;
    if (then_matched) {
      then_statics = then_ctx.statics;
    }

    let else_statics = base_statics;
    if (else_matched) {
      else_statics = else_ctx.statics;
    }

    hooks.merge_if_else_static_assignments(
      stmt,
      dynamic_target.cond,
      then_statics,
      else_statics,
      ctx,
      undefined,
    );

    merge_assigned_runtime_facts(stmt, ctx, then_ctx, else_ctx);

    return;
  }

  const runtime_target = hooks.runtime_union_target(stmt.target, ctx);

  if (!runtime_target) {
    return;
  }

  collect_runtime_if_let_target_locals(runtime_target, ctx, hooks, api);
  const else_ctx = create_if_let_branch_ctx(ctx);
  const info = runtime_union_match_info(
    stmt.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = core_runtime_union_match_branch_ctx(
    stmt.value_name,
    info,
    ctx,
  );

  for (const item of stmt.body) {
    api.collect_stmt_locals(item, branch_ctx, hooks);
  }

  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;
  merge_generated_temp_facts(ctx, branch_ctx);

  hooks.merge_if_else_static_assignments(
    stmt,
    core_if_let_match_condition(stmt.target, stmt.case_name),
    branch_ctx.statics,
    else_ctx.statics,
    ctx,
    undefined,
  );

  merge_assigned_runtime_facts(stmt, ctx, branch_ctx, else_ctx);
}

export function collect_core_if_let_expr_locals(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): void {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name === expr.case_name) {
      const then_ctx = create_if_let_branch_ctx(ctx);

      collect_union_case_payload_locals(union_case, then_ctx, hooks, api);
      hooks.bind_core_if_let_payload_fact(
        expr.value_name,
        union_case,
        then_ctx,
      );

      api.collect_expr_locals(expr.then_branch, then_ctx, hooks);
      ctx.next_loop = then_ctx.next_loop;
      ctx.next_temp = then_ctx.next_temp;
    }

    api.collect_expr_locals(expr.else_branch, ctx, hooks);
    return;
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    api.collect_expr_locals(dynamic_target.cond, ctx, hooks);
    collect_dynamic_if_let_expr_case_locals(
      expr,
      dynamic_target.then_case,
      dynamic_target,
      ctx,
      hooks,
      api,
    );
    collect_dynamic_if_let_expr_case_locals(
      expr,
      dynamic_target.else_case,
      dynamic_target,
      ctx,
      hooks,
      api,
    );
    return;
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    api.collect_expr_locals(expr.target, ctx, hooks);
    api.collect_expr_locals(expr.then_branch, ctx, hooks);
    api.collect_expr_locals(expr.else_branch, ctx, hooks);
    return;
  }

  collect_runtime_if_let_target_locals(runtime_target, ctx, hooks, api);

  const info = runtime_union_match_info(expr.case_name, runtime_target, ctx);
  const branch_ctx = core_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );

  api.collect_expr_locals(expr.then_branch, branch_ctx, hooks);
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;

  if (!expr.implicit_else) {
    api.collect_expr_locals(expr.else_branch, ctx, hooks);
  }
}

function collect_dynamic_if_let_expr_case_locals(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  dynamic_target: DynamicUnionIf,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): void {
  if (union_case.name !== expr.case_name) {
    if (expr.implicit_else) {
      return;
    }

    api.collect_expr_locals(expr.else_branch, ctx, hooks);
    return;
  }

  const branch_ctx = create_if_let_branch_ctx(ctx);

  collect_union_case_payload_locals(union_case, branch_ctx, hooks, api);
  hooks.bind_dynamic_if_let_payload(
    expr.case_name,
    expr.value_name,
    dynamic_target,
    branch_ctx,
  );
  api.collect_expr_locals(expr.then_branch, branch_ctx, hooks);
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;
}

function collect_dynamic_if_let_stmt_case_locals(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  dynamic_target: DynamicUnionIf,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): boolean {
  if (union_case.name !== stmt.case_name) {
    return false;
  }

  collect_union_case_payload_locals(union_case, ctx, hooks, api);
  hooks.bind_dynamic_if_let_payload(
    stmt.case_name,
    stmt.value_name,
    dynamic_target,
    ctx,
  );
  hooks.clear_optional_core_union_local(stmt.value_name, ctx);

  for (const item of stmt.body) {
    api.collect_stmt_locals(item, ctx, hooks);
  }

  return true;
}

function collect_union_case_payload_locals(
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): void {
  if (union_case.value) {
    api.collect_expr_locals(union_case.value, ctx, hooks);
  }

  if (union_case.type_expr) {
    api.collect_expr_locals(union_case.type_expr, ctx, hooks);
  }
}

function collect_runtime_if_let_target_locals(
  runtime_target: RuntimeUnionTarget,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreIfLetLocalCollectApi,
): void {
  api.collect_expr_locals(runtime_target.target, ctx, hooks);
  const name = fresh_temp_local(ctx, "union_match");
  set_local(ctx.locals, name, "i32");
}

function create_if_let_branch_ctx(ctx: CoreCtx): CoreCtx {
  return {
    locals: ctx.locals,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
  };
}

function merge_assigned_runtime_facts(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  target: CoreCtx,
  branch_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  for (const name of assigned_stmt_names(stmt)) {
    merge_assigned_text_fact(name, target, branch_ctx, else_ctx);
    merge_assigned_type_fact(
      name,
      target.struct_locals,
      branch_ctx.struct_locals,
      else_ctx.struct_locals,
    );
    merge_assigned_type_fact(
      name,
      target.union_locals,
      branch_ctx.union_locals,
      else_ctx.union_locals,
    );
    merge_assigned_frozen_fact(name, target, branch_ctx, else_ctx);
  }
}

function merge_assigned_text_fact(
  name: string,
  target: CoreCtx,
  branch_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  if (branch_ctx.text_locals.has(name) && else_ctx.text_locals.has(name)) {
    target.text_locals.add(name);
    return;
  }

  target.text_locals.delete(name);
}

function merge_assigned_type_fact(
  name: string,
  target: Map<string, CoreExpr>,
  branch_facts: Map<string, CoreExpr>,
  else_facts: Map<string, CoreExpr>,
): void {
  const branch_type = branch_facts.get(name);
  const else_type = else_facts.get(name);

  if (!branch_type || !else_type) {
    target.delete(name);
    return;
  }

  if (!same_core_fact_expr(branch_type, else_type)) {
    target.delete(name);
    return;
  }

  target.set(name, branch_type);
}

function merge_assigned_frozen_fact(
  name: string,
  target: CoreCtx,
  branch_ctx: CoreCtx,
  else_ctx: CoreCtx,
): void {
  if (!branch_ctx.frozen_locals || !else_ctx.frozen_locals) {
    if (target.frozen_locals) {
      target.frozen_locals.delete(name);
    }
    return;
  }

  if (
    branch_ctx.frozen_locals.has(name) &&
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
