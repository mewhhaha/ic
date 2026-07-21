import { expect } from "../../../expect.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreFnType,
  CoreStmt,
} from "../../ast.ts";
import type { CoreCtx } from "../../local_collect.ts";
import {
  materialized_static_owner_binding,
  mutable_static_owner_value_materializes,
  static_owner_value_materializes,
} from "../../mutable_static_owner.ts";
import { runtime_aggregate_type_expr } from "../../runtime_aggregate.ts";
import { set_local } from "../../emit/local.ts";
import { create_child_core_ctx, create_empty_core_ctx } from "./context.ts";
import {
  clear_drop_analysis_local_facts,
  drop_analysis_stmt_contains_freeze_consumption,
  is_drop_analysis_freeze_consumption,
} from "./drop_freeze.ts";
import {
  drop_analysis_runtime_binding_static_expr_value,
  drop_analysis_static_expr_value as graph_drop_analysis_static_expr_value,
} from "./drop_static.ts";
import {
  bind_unsafe_scratch_return_for_proof,
  core_unsafe_scratch_return_probe_error,
} from "./drop_scratch.ts";
import { core_drop_if_let_branch_ctx } from "./proof_context.ts";
import { core_unknown_host_boundary_probe_error } from "./proof_unsupported.ts";
import type { CoreBackendGraph } from "./types.ts";
import { bind_core_function_params } from "../../function_params.ts";

export function collect_core_drop_ctx(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreCtx {
  const ctx = create_empty_core_ctx(core);

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];
    expect(stmt, "Missing core statement " + index.toString());

    if (
      core.function_params !== undefined &&
      index + 1 === core.statements.length
    ) {
      bind_core_function_params(core.function_params, ctx);
    }

    if (
      index + 1 >= core.statements.length &&
      !drop_analysis_stmt_contains_freeze_consumption(stmt)
    ) {
      collect_final_analysis_stmt_locals(backend, stmt, ctx);
      continue;
    }

    collect_drop_analysis_stmt_locals(backend, stmt, ctx);
  }

  return ctx;
}

export function collect_core_borrow_ctx(
  backend: CoreBackendGraph,
  core: CoreNode,
): CoreCtx {
  const ctx = create_empty_core_ctx(core);

  for (let index = 0; index < core.statements.length; index += 1) {
    const stmt = core.statements[index];
    expect(stmt, "Missing core statement " + index.toString());

    if (
      core.function_params !== undefined &&
      index + 1 === core.statements.length
    ) {
      bind_core_function_params(core.function_params, ctx);
    }

    if (
      index + 1 >= core.statements.length &&
      !drop_analysis_stmt_contains_freeze_consumption(stmt)
    ) {
      collect_final_analysis_stmt_locals(backend, stmt, ctx);
      continue;
    }

    if (drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_drop_analysis_stmt_locals(backend, stmt, ctx);
      continue;
    }

    collect_stmt_locals_for_proof(backend, stmt, ctx);
  }

  return ctx;
}

export function collect_stmt_locals_for_proof(
  backend: CoreBackendGraph,
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  try {
    backend.local_collect.collect_stmt_locals(stmt, ctx);
  } catch (error) {
    if (core_unknown_host_boundary_probe_error(error)) {
      return;
    }

    if (core_unsafe_scratch_return_probe_error(error)) {
      bind_unsafe_scratch_return_for_proof(backend, stmt, ctx);
      return;
    }

    throw error;
  }
}

export function drop_analysis_static_expr_value(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  return graph_drop_analysis_static_expr_value(
    backend,
    expr,
    ctx,
    (stmt, block_ctx) =>
      collect_drop_analysis_stmt_locals(backend, stmt, block_ctx),
  );
}

function collect_final_analysis_stmt_locals(
  backend: CoreBackendGraph,
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  if (stmt.tag === "expr") {
    collect_expr_locals_for_proof(backend, stmt.expr, ctx);
    return;
  }

  if (stmt.tag === "return") {
    collect_expr_locals_for_proof(backend, stmt.value, ctx);
    return;
  }

  collect_stmt_locals_for_proof(backend, stmt, ctx);
}

function collect_drop_analysis_stmt_locals(
  backend: CoreBackendGraph,
  stmt: CoreStmt,
  ctx: CoreCtx,
): void {
  if (stmt.tag === "bind") {
    const value = backend.type_check.core_binding_value(stmt, ctx);

    if (stmt.kind === "const" && value.tag === "lam") {
      collect_stmt_locals_for_proof(backend, stmt, ctx);
      return;
    }

    const static_value = stmt.kind === "const"
      ? drop_analysis_static_expr_value(backend, value, ctx)
      : drop_analysis_runtime_binding_static_expr_value(
        backend,
        value,
        ctx,
        (inner_stmt, block_ctx) =>
          collect_drop_analysis_stmt_locals(backend, inner_stmt, block_ctx),
      );

    if (static_value) {
      if (
        stmt.kind === "let" && ctx.mutable_bindings &&
        ctx.mutable_bindings.has(stmt.name) &&
        backend.struct.static_struct_value(static_value, ctx) === undefined
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }

      const materialized_owner = stmt.kind === "let" &&
        value.tag !== "scratch" &&
        materialized_static_owner_binding(stmt.name, static_value, ctx);
      if (
        stmt.kind === "let" &&
        (materialized_owner ||
          (stmt.annotation !== undefined &&
            core_runtime_aggregate_type_for_ownership(
                backend,
                static_value,
                ctx,
              ) !== undefined) ||
          (value.tag !== "scratch" &&
            static_owner_value_materializes(static_value, ctx)) ||
          (mutable_static_owner_value_materializes(static_value) &&
            ctx.mutable_bindings && ctx.mutable_bindings.has(stmt.name)))
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }
      if (
        stmt.kind === "let" && static_value.tag === "lam" &&
        !drop_analysis_expr_returns_closure_value(static_value.body)
      ) {
        const fn_type = drop_analysis_closure_fn_type(
          backend,
          static_value,
          ctx,
        );

        if (fn_type) {
          bind_drop_analysis_closure(
            stmt.name,
            fn_type,
            ctx,
            static_value,
            false,
          );
          return;
        }
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.set(stmt.name, static_value);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    if (is_drop_analysis_freeze_consumption(stmt.value)) {
      const fn_type = drop_analysis_closure_fn_type(backend, stmt.value, ctx);

      if (fn_type) {
        bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, true);
        return;
      }

      if (
        backend.text.core_expr_has_runtime_text_fact(stmt.value, ctx) ||
        core_runtime_aggregate_type_for_ownership(backend, stmt.value, ctx) ||
        backend.union.runtime_union_type_expr(stmt.value, ctx)
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.delete(stmt.name);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    const fn_type = drop_analysis_closure_fn_type(backend, stmt.value, ctx);

    if (fn_type) {
      bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, false);
      return;
    }
  }

  if (stmt.tag === "assign") {
    const value = backend.type_check.core_assignment_value(stmt, ctx);
    const static_value = drop_analysis_runtime_binding_static_expr_value(
      backend,
      value,
      ctx,
      (inner_stmt, block_ctx) =>
        collect_drop_analysis_stmt_locals(backend, inner_stmt, block_ctx),
    );

    if (static_value) {
      if (
        ctx.mutable_bindings && ctx.mutable_bindings.has(stmt.name) &&
        backend.struct.static_struct_value(static_value, ctx) === undefined
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }

      if (
        (value.tag !== "scratch" &&
          static_owner_value_materializes(static_value, ctx)) ||
        (mutable_static_owner_value_materializes(static_value) &&
          ctx.mutable_bindings &&
          ctx.mutable_bindings.has(stmt.name))
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }
      if (
        static_value.tag === "lam" &&
        !drop_analysis_expr_returns_closure_value(static_value.body)
      ) {
        const fn_type = drop_analysis_closure_fn_type(
          backend,
          static_value,
          ctx,
        );

        if (fn_type) {
          bind_drop_analysis_closure(
            stmt.name,
            fn_type,
            ctx,
            static_value,
            false,
          );
          return;
        }
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.set(stmt.name, static_value);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    if (is_drop_analysis_freeze_consumption(value)) {
      const fn_type = drop_analysis_closure_fn_type(backend, value, ctx);

      if (fn_type) {
        bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, true);
        return;
      }

      if (
        backend.text.core_expr_has_runtime_text_fact(value, ctx) ||
        core_runtime_aggregate_type_for_ownership(backend, value, ctx) ||
        backend.union.runtime_union_type_expr(value, ctx)
      ) {
        collect_stmt_locals_for_proof(backend, stmt, ctx);
        return;
      }

      ctx.locals.delete(stmt.name);
      ctx.statics.delete(stmt.name);
      clear_drop_analysis_local_facts(stmt.name, ctx);
      return;
    }

    const fn_type = drop_analysis_closure_fn_type(backend, value, ctx);

    if (fn_type) {
      bind_drop_analysis_closure(stmt.name, fn_type, ctx, undefined, false);
      return;
    }
  }

  if (stmt.tag === "expr") {
    if (is_drop_analysis_freeze_consumption(stmt.expr)) {
      return;
    }

    collect_expr_locals_for_proof(backend, stmt.expr, ctx);
    return;
  }

  if (stmt.tag === "return") {
    if (is_drop_analysis_freeze_consumption(stmt.value)) {
      return;
    }

    collect_expr_locals_for_proof(backend, stmt.value, ctx);
    return;
  }

  if (stmt.tag === "if_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(backend, stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(backend, stmt.cond, ctx);

    for (const body_stmt of stmt.body) {
      collect_drop_analysis_stmt_locals(backend, body_stmt, ctx);
    }

    return;
  }

  if (stmt.tag === "if_else_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(backend, stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(backend, stmt.cond, ctx);

    for (const body_stmt of stmt.then_body) {
      collect_drop_analysis_stmt_locals(backend, body_stmt, ctx);
    }

    for (const body_stmt of stmt.else_body) {
      collect_drop_analysis_stmt_locals(backend, body_stmt, ctx);
    }

    return;
  }

  if (stmt.tag === "if_let_stmt") {
    if (!drop_analysis_stmt_contains_freeze_consumption(stmt)) {
      collect_stmt_locals_for_proof(backend, stmt, ctx);
      return;
    }

    collect_expr_locals_for_proof(backend, stmt.target, ctx);

    const branch = core_drop_if_let_branch_ctx(
      backend,
      stmt.case_name,
      stmt.value_name,
      stmt.target,
      ctx,
    );

    if (branch.tag === "skip") {
      return;
    }

    if (branch.tag === "scan") {
      for (const body_stmt of stmt.body) {
        collect_drop_analysis_stmt_locals(backend, body_stmt, branch.ctx);
      }

      ctx.next_loop = branch.ctx.next_loop;
      ctx.next_temp = branch.ctx.next_temp;
      return;
    }

    for (const body_stmt of stmt.body) {
      collect_drop_analysis_stmt_locals(backend, body_stmt, ctx);
    }

    return;
  }

  collect_stmt_locals_for_proof(backend, stmt, ctx);
}

function drop_analysis_closure_fn_type(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreFnType | undefined {
  if (expr.tag === "var") {
    const local_type = ctx.fn_types.get(expr.name);

    if (local_type) {
      return local_type;
    }

    const static_value = ctx.statics.get(expr.name);

    if (!static_value) {
      return undefined;
    }

    return drop_analysis_closure_fn_type(backend, static_value, ctx);
  }

  if (expr.tag === "block") {
    const block_ctx = create_child_core_ctx(ctx);

    for (let index = 0; index < expr.statements.length; index += 1) {
      const stmt = expr.statements[index];
      expect(
        stmt,
        "Missing core drop-analysis closure block statement " + index,
      );
      const is_final = index + 1 >= expr.statements.length;

      if (!is_final) {
        collect_drop_analysis_stmt_locals(backend, stmt, block_ctx);
        continue;
      }

      if (stmt.tag === "expr") {
        return drop_analysis_closure_fn_type(backend, stmt.expr, block_ctx);
      }

      if (stmt.tag === "return") {
        return drop_analysis_closure_fn_type(backend, stmt.value, block_ctx);
      }

      collect_drop_analysis_stmt_locals(backend, stmt, block_ctx);
      return undefined;
    }

    return undefined;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return drop_analysis_closure_fn_type(backend, expr.value, ctx);
  }

  return core_allocation_closure_fn_type(backend, expr, ctx);
}

function bind_drop_analysis_closure(
  name: string,
  fn_type: CoreFnType,
  ctx: CoreCtx,
  static_value: CoreExpr | undefined,
  frozen: boolean,
): void {
  if (static_value) {
    ctx.statics.set(name, static_value);
  } else {
    ctx.statics.delete(name);
  }

  set_local(ctx.locals, name, "i32");
  ctx.fn_types.set(name, fn_type);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
  if (ctx.frozen_locals) {
    if (frozen) {
      ctx.frozen_locals.add(name);
    } else {
      ctx.frozen_locals.delete(name);
    }
  }
}

function drop_analysis_expr_returns_closure_value(expr: CoreExpr): boolean {
  if (expr.tag === "lam") {
    return true;
  }

  if (expr.tag === "block") {
    const final_stmt = expr.statements[expr.statements.length - 1];
    expect(final_stmt, "Core drop-analysis closure-return block has no result");

    if (final_stmt.tag === "expr") {
      return drop_analysis_expr_returns_closure_value(final_stmt.expr);
    }

    if (final_stmt.tag === "return") {
      return drop_analysis_expr_returns_closure_value(final_stmt.value);
    }

    return false;
  }

  if (expr.tag === "if") {
    return drop_analysis_expr_returns_closure_value(expr.then_branch) &&
      drop_analysis_expr_returns_closure_value(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    return drop_analysis_expr_returns_closure_value(expr.then_branch) &&
      drop_analysis_expr_returns_closure_value(expr.else_branch);
  }

  return false;
}

function core_allocation_closure_fn_type(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
) {
  try {
    return backend.closure.closure_fn_type(expr, ctx);
  } catch (error) {
    if (core_runtime_aggregate_ownership_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function core_runtime_aggregate_type_for_ownership(
  backend: CoreBackendGraph,
  value: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return runtime_aggregate_type_expr(value, ctx, {
      check_closure_call_args: backend.closure.check_closure_call_args,
      closure_fn_type: backend.closure.closure_fn_type,
    });
  } catch (error) {
    if (core_runtime_aggregate_ownership_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function core_runtime_aggregate_ownership_probe_error(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Core first-class closure parameter must use a scalar annotation:",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "First-class closure ownership-qualified parameter annotations are " +
        "not supported yet:",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "Core runtime aggregate requires a static struct type",
    )
  ) {
    return true;
  }

  return false;
}

function collect_expr_locals_for_proof(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
): void {
  try {
    backend.local_collect.collect_expr_locals(expr, ctx);
  } catch (error) {
    if (core_unknown_host_boundary_probe_error(error)) {
      return;
    }

    if (core_unsafe_scratch_return_probe_error(error)) {
      return;
    }

    throw error;
  }
}
