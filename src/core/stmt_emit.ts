import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import type { CoreLamCapturePlan } from "./closure_capture.ts";
import { emit_core_scratch_resets } from "./scratch.ts";
import {
  static_core_call_branch_value,
  type StaticCoreCallCtx,
} from "./static_call.ts";
import type { StaticValuePlan } from "./static_values.ts";
import { static_function_value } from "./type_static.ts";

export type CoreStmtEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  break_label: string | undefined;
  continue_label: string | undefined;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  frozen_locals?: Set<string>;
};

export type CoreStmtEmitHooks<ctx extends CoreStmtEmitCtx & StaticCoreCallCtx> =
  {
    bind_core_assignment_union_type: (
      name: string,
      value: CoreExpr,
      mode: "same" | "change",
      ctx: ctx,
    ) => void;
    bind_core_assignment_struct_type: (
      name: string,
      value: CoreExpr,
      mode: "same" | "change",
      ctx: ctx,
    ) => void;
    bind_core_fn_type: (name: string, value: CoreExpr, ctx: ctx) => void;
    bind_core_struct_type: (
      name: string,
      value: CoreExpr,
      annotation: string | undefined,
      ctx: ctx,
    ) => void;
    bind_core_union_type: (
      name: string,
      value: CoreExpr,
      annotation: string | undefined,
      ctx: ctx,
    ) => void;
    clear_core_local_facts: (name: string, ctx: ctx) => void;
    core_binding_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      ctx: ctx,
    ) => CoreExpr;
    core_type_const_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      value: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    core_expr_has_runtime_text_fact: (value: CoreExpr, ctx: ctx) => boolean;
    emit_collection_loop: (
      stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
      ctx: ctx,
    ) => Wat;
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
    emit_if_else_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
      ctx: ctx,
    ) => Wat;
    emit_if_let_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
      ctx: ctx,
    ) => Wat;
    emit_if_stmt: (
      stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
      ctx: ctx,
    ) => Wat;
    emit_range_loop: (
      stmt: Extract<CoreStmt, { tag: "range_loop" }>,
      ctx: ctx,
    ) => Wat;
    emit_runtime_text_index_assign: (
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: ctx,
    ) => Wat;
    emit_runtime_aggregate_index_assign: (
      type_expr: CoreExpr,
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: ctx,
    ) => Wat;
    emit_static_index_assign: (
      target: Extract<CoreExpr, { tag: "struct_value" }>,
      stmt: Extract<CoreStmt, { tag: "index_assign" }>,
      ctx: ctx,
    ) => Wat;
    is_static_value_expr: (expr: CoreExpr, ctx: ctx) => boolean;
    plan_core_lam_capture: (
      expr: Extract<CoreExpr, { tag: "lam" }>,
      ctx: ctx,
      emit_setup: boolean,
    ) => CoreLamCapturePlan | undefined;
    plan_static_value_expr: (
      value: CoreExpr,
      ctx: ctx,
      emit_ctx: ctx,
    ) => StaticValuePlan;
    static_struct_binding: (
      name: string,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
    static_core_call_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  };

export function emit_core_stmt<ctx extends CoreStmtEmitCtx & StaticCoreCallCtx>(
  stmt: CoreStmt,
  ctx: ctx,
  is_final: boolean,
  hooks: CoreStmtEmitHooks<ctx>,
): Wat {
  switch (stmt.tag) {
    case "bind": {
      const value = hooks.core_binding_value(stmt, ctx);
      const type_value = hooks.core_type_const_value(stmt, value, ctx);

      if (type_value) {
        ctx.locals.delete(stmt.name);
        ctx.statics.set(stmt.name, type_value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return "";
      }

      if (value.tag === "rec") {
        ctx.locals.delete(stmt.name);
        ctx.statics.set(stmt.name, value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return "";
      }

      if (value.tag === "rec_ref") {
        ctx.locals.delete(stmt.name);
        ctx.statics.delete(stmt.name);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return "";
      }

      if (value.tag !== "lam") {
        const branch_function_value = static_core_call_branch_value(
          value,
          ctx,
          hooks,
        );

        if (branch_function_value) {
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, branch_function_value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return "";
        }

        const function_value = static_function_value(value, ctx);

        if (function_value) {
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, function_value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return "";
        }
      }

      if (value.tag === "lam") {
        const plan = hooks.plan_core_lam_capture(value, ctx, true);

        if (plan) {
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, plan.value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return plan.setup;
        }
      }

      if (hooks.is_static_value_expr(value, ctx)) {
        const plan = hooks.plan_static_value_expr(value, ctx, ctx);
        ctx.statics.set(stmt.name, plan.value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return plan.setup;
      }

      ctx.statics.delete(stmt.name);
      {
        const emitted = hooks.emit_expr(value, ctx) + "\nlocal.set $" +
          stmt.name;
        hooks.bind_core_fn_type(stmt.name, value, ctx);
        hooks.bind_core_struct_type(stmt.name, value, stmt.annotation, ctx);
        hooks.bind_core_union_type(stmt.name, value, stmt.annotation, ctx);
        bind_core_text_fact(stmt.name, value, stmt.annotation, ctx, hooks);
        bind_core_frozen_fact(stmt.name, value, ctx);
        return emitted;
      }
    }

    case "assign":
      expect(
        ctx.locals.has(stmt.name) || ctx.statics.has(stmt.name),
        "Cannot assign unbound core local: " + stmt.name,
      );

      if (hooks.is_static_value_expr(stmt.value, ctx)) {
        const plan = hooks.plan_static_value_expr(stmt.value, ctx, ctx);
        ctx.statics.set(stmt.name, plan.value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return plan.setup;
      }

      ctx.statics.delete(stmt.name);
      {
        const emitted = hooks.emit_expr(stmt.value, ctx) + "\nlocal.set $" +
          stmt.name;
        hooks.bind_core_fn_type(stmt.name, stmt.value, ctx);
        hooks.bind_core_assignment_struct_type(
          stmt.name,
          stmt.value,
          stmt.mode,
          ctx,
        );
        hooks.bind_core_assignment_union_type(
          stmt.name,
          stmt.value,
          stmt.mode,
          ctx,
        );
        bind_core_text_fact(stmt.name, stmt.value, undefined, ctx, hooks);
        bind_core_frozen_fact(stmt.name, stmt.value, ctx);
        return emitted;
      }

    case "range_loop":
      return hooks.emit_range_loop(stmt, ctx);

    case "collection_loop":
      return hooks.emit_collection_loop(stmt, ctx);

    case "if_stmt":
      return hooks.emit_if_stmt(stmt, ctx);

    case "if_else_stmt":
      return hooks.emit_if_else_stmt(stmt, ctx);

    case "if_let_stmt":
      return hooks.emit_if_let_stmt(stmt, ctx);

    case "break":
      expect(ctx.break_label, "Cannot emit core break outside loop");
      return emit_core_control_transfer(
        emit_core_scratch_resets(ctx.scratch_loop_resets),
        "br $" + ctx.break_label,
      );

    case "continue":
      expect(ctx.continue_label, "Cannot emit core continue outside loop");
      return emit_core_control_transfer(
        emit_core_scratch_resets(ctx.scratch_loop_resets),
        "br $" + ctx.continue_label,
      );

    case "return":
      if (is_final && ctx.scratch_return_resets.length === 0) {
        return hooks.emit_expr(stmt.value, ctx);
      }

      return emit_core_control_transfer(
        hooks.emit_expr(stmt.value, ctx) + "\n" +
          emit_core_scratch_resets(ctx.scratch_return_resets),
        "return",
      );

    case "expr":
      if (is_final) {
        return hooks.emit_expr(stmt.expr, ctx);
      }

      return hooks.emit_expr(stmt.expr, ctx) + "\ndrop";

    case "type_check":
      return "";

    case "index_assign": {
      const target = hooks.static_struct_binding(stmt.name, ctx);

      if (target) {
        return hooks.emit_static_index_assign(target, stmt, ctx);
      }

      if (ctx.statics.has(stmt.name)) {
        throw new Error(
          "Cannot mutate frozen/shareable core binding: " + stmt.name,
        );
      }

      if (ctx.frozen_locals && ctx.frozen_locals.has(stmt.name)) {
        throw new Error(
          "Cannot mutate frozen/shareable core binding: " + stmt.name,
        );
      }

      if (ctx.text_locals.has(stmt.name)) {
        return hooks.emit_runtime_text_index_assign(stmt, ctx);
      }

      const type_expr = ctx.struct_locals.get(stmt.name);

      if (type_expr) {
        return hooks.emit_runtime_aggregate_index_assign(type_expr, stmt, ctx);
      }

      throw new Error("Cannot emit core " + stmt.tag + " statement yet");
    }

    case "unsupported":
      throw new Error("Cannot emit core " + stmt.tag + " statement yet");
  }
}

function bind_core_text_fact<ctx extends CoreStmtEmitCtx & StaticCoreCallCtx>(
  name: string,
  value: CoreExpr,
  annotation: string | undefined,
  ctx: ctx,
  hooks: Pick<
    CoreStmtEmitHooks<ctx>,
    "core_expr_has_runtime_text_fact"
  >,
): void {
  if (
    annotation === "Text" ||
    hooks.core_expr_has_runtime_text_fact(value, ctx)
  ) {
    ctx.text_locals.add(name);
    return;
  }

  ctx.text_locals.delete(name);
}

function bind_core_frozen_fact(
  name: string,
  value: CoreExpr,
  ctx: { frozen_locals?: Set<string> },
): void {
  if (!ctx.frozen_locals) {
    return;
  }

  if (value.tag === "freeze") {
    ctx.frozen_locals.add(name);
    return;
  }

  ctx.frozen_locals.delete(name);
}

function emit_core_control_transfer(
  cleanup: Wat,
  transfer: Wat,
): Wat {
  if (cleanup === "") {
    return transfer;
  }

  return cleanup + "\n" + transfer;
}
