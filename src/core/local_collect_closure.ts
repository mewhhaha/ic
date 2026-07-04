import { expect } from "../expect.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { fresh_temp_local, set_local } from "./backend/util.ts";
import { clone_core_host_imports } from "./host_import.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./local_collect/types.ts";
import { runtime_union_match_info } from "./runtime_union.ts";
import { core_runtime_union_match_branch_ctx } from "./runtime_union_match.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";

export type CoreLocalCollectorCallbacks = {
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

export function collect_runtime_closure_locals(ctx: CoreCtx): void {
  const name = fresh_temp_local(ctx, "closure");
  set_local(ctx.locals, name, "i32");
}

export function collect_closure_call_locals(ctx: CoreCtx): void {
  const name = fresh_temp_local(ctx, "closure_call");
  set_local(ctx.locals, name, "i32");
}

export function collect_closure_value_locals_with_type(
  expr: CoreExpr,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  const actual = hooks.closure_fn_type_with_expected(expr, fn_type, ctx);
  expect(actual, "Core closure if branch must be a closure");
  expect(
    hooks.same_core_fn_type(actual, fn_type),
    "Core closure if branch type mismatch",
  );

  if (expr.tag === "lam") {
    collect_runtime_closure_locals(ctx);
    return;
  }

  if (expr.tag === "if") {
    callbacks.collect_expr_locals(expr.cond, ctx, hooks);
    collect_closure_value_locals_with_type(
      expr.then_branch,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    collect_closure_value_locals_with_type(
      expr.else_branch,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  if (expr.tag === "if_let") {
    collect_closure_if_let_value_locals_with_type(
      expr,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  if (expr.tag === "block") {
    collect_closure_block_locals_with_type(
      expr,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  if (expr.tag === "var") {
    const static_value = ctx.statics.get(expr.name);

    if (static_value) {
      collect_closure_value_locals_with_type(
        static_value,
        fn_type,
        ctx,
        hooks,
        callbacks,
      );
      return;
    }
  }

  callbacks.collect_expr_locals(expr, ctx, hooks);
}

export function collect_closure_if_let_value_locals_with_type(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name !== expr.case_name) {
      if (expr.implicit_else) {
        return;
      }

      collect_closure_value_locals_with_type(
        expr.else_branch,
        fn_type,
        ctx,
        hooks,
        callbacks,
      );
      return;
    }

    const branch_ctx = closure_if_let_branch_ctx(ctx);
    collect_union_case_payload_expr_locals(
      union_case,
      branch_ctx,
      hooks,
      callbacks,
    );
    hooks.bind_core_if_let_payload_fact(
      expr.value_name,
      union_case,
      branch_ctx,
    );
    collect_closure_value_locals_with_type(
      expr.then_branch,
      fn_type,
      branch_ctx,
      hooks,
      callbacks,
    );
    ctx.next_loop = branch_ctx.next_loop;
    ctx.next_temp = branch_ctx.next_temp;
    return;
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    callbacks.collect_expr_locals(dynamic_target.cond, ctx, hooks);

    if (!dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      if (expr.implicit_else) {
        return;
      }

      collect_closure_value_locals_with_type(
        expr.else_branch,
        fn_type,
        ctx,
        hooks,
        callbacks,
      );
      return;
    }

    collect_dynamic_closure_if_let_case_locals(
      expr,
      dynamic_target.then_case,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    collect_dynamic_closure_if_let_case_locals(
      expr,
      dynamic_target.else_case,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    callbacks.collect_expr_locals(expr.target, ctx, hooks);
    collect_closure_value_locals_with_type(
      expr.then_branch,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );

    if (!expr.implicit_else) {
      collect_closure_value_locals_with_type(
        expr.else_branch,
        fn_type,
        ctx,
        hooks,
        callbacks,
      );
    }

    return;
  }

  callbacks.collect_expr_locals(runtime_target.target, ctx, hooks);
  const name = fresh_temp_local(ctx, "union_match");
  set_local(ctx.locals, name, "i32");
  const info = runtime_union_match_info(expr.case_name, runtime_target, ctx);
  const branch_ctx = core_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );
  collect_closure_value_locals_with_type(
    expr.then_branch,
    fn_type,
    branch_ctx,
    hooks,
    callbacks,
  );
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;

  if (!expr.implicit_else) {
    collect_closure_value_locals_with_type(
      expr.else_branch,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
  }
}

function collect_dynamic_closure_if_let_case_locals(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  if (union_case.name !== expr.case_name) {
    if (expr.implicit_else) {
      return;
    }

    collect_closure_value_locals_with_type(
      expr.else_branch,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  const branch_ctx = closure_if_let_branch_ctx(ctx);
  collect_union_case_payload_expr_locals(
    union_case,
    branch_ctx,
    hooks,
    callbacks,
  );
  hooks.bind_core_if_let_payload_fact(expr.value_name, union_case, branch_ctx);
  collect_closure_value_locals_with_type(
    expr.then_branch,
    fn_type,
    branch_ctx,
    hooks,
    callbacks,
  );
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;
}

function collect_union_case_payload_expr_locals(
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  if (union_case.value) {
    callbacks.collect_expr_locals(union_case.value, ctx, hooks);
  }

  if (union_case.type_expr) {
    callbacks.collect_expr_locals(union_case.type_expr, ctx, hooks);
  }
}

function closure_if_let_branch_ctx(ctx: CoreCtx): CoreCtx {
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

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function collect_closure_block_locals_with_type(
  expr: Extract<CoreExpr, { tag: "block" }>,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing core block statement " + index);
    const is_final = index + 1 >= expr.statements.length;

    if (is_final) {
      collect_closure_stmt_locals_with_type(
        stmt,
        fn_type,
        ctx,
        hooks,
        callbacks,
      );
    } else {
      callbacks.collect_stmt_locals(stmt, ctx, hooks);
    }
  }
}

function collect_closure_stmt_locals_with_type(
  stmt: CoreStmt,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  callbacks: CoreLocalCollectorCallbacks,
): void {
  if (stmt.tag === "expr") {
    collect_closure_value_locals_with_type(
      stmt.expr,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
    return;
  }

  if (stmt.tag === "return") {
    collect_closure_value_locals_with_type(
      stmt.value,
      fn_type,
      ctx,
      hooks,
      callbacks,
    );
  }
}
