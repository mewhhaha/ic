import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import type { CoreLamCapturePlan } from "./closure_capture.ts";
import { core_statement_cleanup_rows } from "./cleanup_emission.ts";
import { emit_core_scratch_resets } from "./scratch.ts";
import {
  static_core_call_branch_value,
  type StaticCoreCallCtx,
} from "./static_call.ts";
import type { StaticValuePlan } from "./static_values.ts";
import { static_scratch_aggregate_alias_materializes } from "./static_values.ts";
import { static_function_value } from "./type_static.ts";
import {
  mutable_static_owner_value_materializes,
  static_owner_value_materializes,
} from "./mutable_static_owner.ts";

export type CoreStmtEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  break_label: string | undefined;
  break_value_type: ValType | undefined;
  continue_label: string | undefined;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  scratch_depth?: number;
  frozen_locals?: Set<string>;
  materialized_bindings?: Set<string>;
  mutable_bindings?: Set<string>;
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
    core_assignment_value: (
      stmt: Extract<CoreStmt, { tag: "assign" }>,
      ctx: ctx,
    ) => CoreExpr;
    core_type_const_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      value: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    core_expr_has_runtime_text_fact: (value: CoreExpr, ctx: ctx) => boolean;
    core_expr_is_text: (value: CoreExpr, ctx: ctx) => boolean;
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
  const replacement_rows = core_statement_cleanup_rows(stmt).filter((row) => {
    return row.edge === "assignment_replace";
  });
  const before = replacement_rows.length === 0
    ? emit_statement_cleanup(stmt, "before", ctx)
    : "";
  let emitted = emit_core_stmt_inner(stmt, ctx, is_final, hooks);
  if (replacement_rows.length > 0) {
    emitted = emit_assignment_replacement(
      stmt,
      emitted,
      replacement_rows,
      ctx,
    );
  }
  emitted = emit_conditional_fallthrough_cleanup(stmt, emitted, ctx);
  const after = emit_statement_cleanup(stmt, "after", ctx);
  let result = [before, emitted, after].filter((line) => line !== "").join(
    "\n",
  );

  if (is_final && stmt.tag === "assign") {
    result += "\ni32.const 0";
  }

  return result;
}

function emit_assignment_replacement(
  stmt: CoreStmt,
  emitted: Wat,
  rows: ReturnType<typeof core_statement_cleanup_rows>,
  ctx: CoreStmtEmitCtx,
): Wat {
  expect(stmt.tag === "assign", "Assignment cleanup must anchor an assignment");
  expect(rows.length === 1, "Assignment must have one replacement cleanup");
  const row = rows[0];
  expect(row, "Missing assignment replacement cleanup");
  expect(
    row.replacement_value_local,
    "Assignment replacement cleanup requires a value local",
  );
  expect(
    row.replacement_old_local,
    "Assignment replacement cleanup requires an old-owner local",
  );
  expect(
    ctx.locals.has(row.replacement_value_local),
    "Missing assignment replacement value local: " +
      row.replacement_value_local,
  );
  expect(
    ctx.locals.has(row.replacement_old_local),
    "Missing assignment replacement old-owner local: " +
      row.replacement_old_local,
  );
  const assignment = "\nlocal.set $" + stmt.name;
  expect(
    emitted.endsWith(assignment),
    "Assignment replacement must end by storing its result",
  );
  const value = emitted.slice(0, -assignment.length);
  const cleanup = emit_cleanup_rows([{
    ...row,
    pointer_local: row.replacement_old_local,
  }], ctx);
  return [
    "local.get $" + stmt.name,
    "local.set $" + row.replacement_old_local,
    value,
    "local.set $" + row.replacement_value_local,
    cleanup,
    "local.get $" + row.replacement_value_local,
    "local.set $" + stmt.name,
  ].join("\n");
}

function emit_conditional_fallthrough_cleanup(
  stmt: CoreStmt,
  emitted: Wat,
  ctx: CoreStmtEmitCtx,
): Wat {
  if (stmt.tag !== "if_stmt" && stmt.tag !== "if_let_stmt") {
    return emitted;
  }

  const rows = core_statement_cleanup_rows(stmt).filter((row) => {
    return row.edge === "conditional_cleanup" &&
      row.scope.endsWith("_fallthrough");
  });
  if (rows.length === 0) {
    return emitted;
  }

  const cleanup = emit_cleanup_rows(rows, ctx);
  const indented_cleanup = cleanup.split("\n").map((line) => {
    return "  " + line;
  }).join("\n");

  if (stmt.tag === "if_let_stmt") {
    const empty_then = "\nif\n  \nelse\n";
    if (emitted.includes(empty_then)) {
      return emitted.replace(
        empty_then,
        "\nif\n" + indented_cleanup + "\nelse\n",
      );
    }

    const empty_else = "\nelse\n  \nend";
    if (emitted.includes(empty_else)) {
      return emitted.replace(
        empty_else,
        "\nelse\n" + indented_cleanup + "\nend",
      );
    }

    const suffix = "\nend";
    expect(
      emitted.endsWith(suffix),
      "Conditional if-let cleanup requires an unmatched branch",
    );
    return emitted.slice(0, -suffix.length) + "\nelse\n" +
      indented_cleanup + suffix;
  }

  const suffix = "\nend";
  expect(emitted.endsWith(suffix), "Conditional cleanup requires WAT end");
  return emitted.slice(0, -suffix.length) + "\nelse\n" +
    indented_cleanup + suffix;
}

function emit_core_stmt_inner<
  ctx extends CoreStmtEmitCtx & StaticCoreCallCtx,
>(
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
        const materialized_struct_owner = stmt.kind === "let" &&
          ctx.materialized_bindings?.has(stmt.name) === true &&
          value.tag !== "scratch" &&
          (!ctx.scratch_depth || ctx.scratch_depth === 0) &&
          plan.value.tag === "struct_value" &&
          !(
            plan.value.type_expr.tag === "var" &&
            plan.value.type_expr.name === "object_type"
          );
        if (
          static_scratch_aggregate_alias_materializes(value) ||
          materialized_struct_owner ||
          (value.tag !== "scratch" &&
            static_owner_value_materializes(plan.value, ctx)) ||
          mutable_static_owner_binding(stmt.name, plan.value, ctx)
        ) {
          ctx.statics.delete(stmt.name);
          const emitted = [
            plan.setup,
            hooks.emit_expr(plan.value, ctx),
            "local.set $" + stmt.name,
          ].filter((line) => line !== "").join("\n");
          hooks.bind_core_fn_type(stmt.name, plan.value, ctx);
          hooks.bind_core_struct_type(
            stmt.name,
            plan.value,
            stmt.annotation,
            ctx,
          );
          hooks.bind_core_union_type(
            stmt.name,
            plan.value,
            stmt.annotation,
            ctx,
          );
          bind_core_text_fact(
            stmt.name,
            plan.value,
            stmt.annotation,
            ctx,
            hooks,
          );
          bind_core_frozen_fact(stmt.name, value, ctx);
          return emitted;
        }
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
      {
        const value = hooks.core_assignment_value(stmt, ctx);

        if (hooks.is_static_value_expr(value, ctx)) {
          const plan = hooks.plan_static_value_expr(value, ctx, ctx);
          if (
            static_scratch_aggregate_alias_materializes(value) ||
            (value.tag !== "scratch" &&
              static_owner_value_materializes(plan.value, ctx)) ||
            mutable_static_owner_binding(stmt.name, plan.value, ctx)
          ) {
            ctx.statics.delete(stmt.name);
            const emitted = [
              plan.setup,
              hooks.emit_expr(plan.value, ctx),
              "local.set $" + stmt.name,
            ].filter((line) => line !== "").join("\n");
            hooks.bind_core_fn_type(stmt.name, plan.value, ctx);
            hooks.bind_core_assignment_struct_type(
              stmt.name,
              value,
              stmt.mode,
              ctx,
            );
            hooks.bind_core_assignment_union_type(
              stmt.name,
              value,
              stmt.mode,
              ctx,
            );
            bind_core_text_fact(
              stmt.name,
              plan.value,
              undefined,
              ctx,
              hooks,
            );
            bind_core_frozen_fact(stmt.name, value, ctx);
            return emitted;
          }
          ctx.statics.set(stmt.name, plan.value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return plan.setup;
        }

        ctx.statics.delete(stmt.name);
        {
          const emitted = hooks.emit_expr(value, ctx) + "\nlocal.set $" +
            stmt.name;
          hooks.bind_core_fn_type(stmt.name, value, ctx);
          hooks.bind_core_assignment_struct_type(
            stmt.name,
            value,
            stmt.mode,
            ctx,
          );
          hooks.bind_core_assignment_union_type(
            stmt.name,
            value,
            stmt.mode,
            ctx,
          );
          bind_core_text_fact(stmt.name, value, undefined, ctx, hooks);
          bind_core_frozen_fact(stmt.name, value, ctx);
          return emitted;
        }
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

    case "break": {
      expect(ctx.break_label, "Cannot emit core break outside loop");
      let break_value = "";
      if (stmt.value) {
        expect(
          ctx.break_value_type,
          "Cannot emit core break value outside value-producing loop",
        );
        break_value = hooks.emit_expr(stmt.value, ctx);
      } else {
        if (ctx.break_value_type) {
          expect(
            ctx.break_value_type === "i32",
            "Core bare loop break only produces i32 Unit",
          );
          break_value = "i32.const 0";
        }
      }
      return emit_core_control_transfer(
        join_cleanup(
          break_value,
          emit_core_scratch_resets(ctx.scratch_loop_resets),
          emit_transfer_cleanup(stmt, "break_exit", ctx),
        ),
        "br $" + ctx.break_label,
      );
    }

    case "continue":
      expect(ctx.continue_label, "Cannot emit core continue outside loop");
      return emit_core_control_transfer(
        join_cleanup(
          emit_core_scratch_resets(ctx.scratch_loop_resets),
          emit_transfer_cleanup(stmt, "continue_exit", ctx),
        ),
        "br $" + ctx.continue_label,
      );

    case "return":
      if (
        is_final && ctx.scratch_return_resets.length === 0 &&
        emit_transfer_cleanup(stmt, "return_exit", ctx) === ""
      ) {
        return hooks.emit_expr(stmt.value, ctx);
      }

      return emit_core_control_transfer(
        hooks.emit_expr(stmt.value, ctx) + "\n" +
          join_cleanup(
            emit_core_scratch_resets(ctx.scratch_return_resets),
            emit_transfer_cleanup(stmt, "return_exit", ctx),
          ),
        "return",
      );

    case "expr":
      if (is_final) {
        return hooks.emit_expr(stmt.expr, ctx);
      }

      {
        const ownerless = core_statement_cleanup_rows(stmt).filter((row) => {
          return row.edge === "discarded_expr" &&
            row.pointer_local !== undefined;
        });
        if (ownerless.length > 0) {
          expect(
            ownerless.length === 1,
            "Discarded expression must have one ownerless cleanup pointer",
          );
          const row = ownerless[0];
          expect(row, "Missing ownerless discarded-expression cleanup row");
          expect(
            row.pointer_local,
            "Missing discarded-expression cleanup local",
          );
          expect(
            ctx.locals.has(row.pointer_local),
            "Missing discarded-expression cleanup local: " + row.pointer_local,
          );
          return hooks.emit_expr(stmt.expr, ctx) + "\nlocal.set $" +
            row.pointer_local;
        }
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

function mutable_static_owner_binding(
  name: string,
  value: CoreExpr,
  ctx: CoreStmtEmitCtx,
): boolean {
  if (!ctx.mutable_bindings || !ctx.mutable_bindings.has(name)) {
    return false;
  }
  return mutable_static_owner_value_materializes(value);
}

function emit_statement_cleanup(
  stmt: CoreStmt,
  placement: "before" | "after",
  ctx: CoreStmtEmitCtx,
): Wat {
  const rows = core_statement_cleanup_rows(stmt).filter((row) => {
    if (placement === "before") {
      return row.edge === "assignment_replace";
    }
    return row.edge === "discarded_expr" ||
      (row.edge === "conditional_cleanup" &&
        !row.scope.endsWith("_fallthrough")) ||
      row.edge === "loop_zero_iteration_cleanup" ||
      row.edge === "scope_exit";
  });
  return emit_cleanup_rows(rows, ctx);
}

function emit_transfer_cleanup(
  stmt: CoreStmt,
  edge: "return_exit" | "break_exit" | "continue_exit",
  ctx: CoreStmtEmitCtx,
): Wat {
  return emit_cleanup_rows(
    core_statement_cleanup_rows(stmt).filter((row) => row.edge === edge),
    ctx,
  );
}

function emit_cleanup_rows(
  rows: ReturnType<typeof core_statement_cleanup_rows>,
  ctx: CoreStmtEmitCtx,
): Wat {
  return rows.map((row) => {
    let pointer: string;
    if (row.pointer_local) {
      expect(
        ctx.locals.has(row.pointer_local),
        "Missing cleanup pointer local: " + row.pointer_local,
      );
      pointer = "local.get $" + row.pointer_local;
    } else {
      expect(row.owner, "Cleanup row has no owner or pointer local");
      if (ctx.statics.has(row.owner)) {
        return "";
      }
      expect(
        ctx.locals.has(row.owner),
        "Missing cleanup owner local: " + row.owner,
      );
      pointer = "local.get $" + row.owner;
    }
    const lines: string[] = [];
    for (const child of row.owned_children) {
      lines.push(pointer);
      lines.push("i32.load offset=" + child.offset.toString());
      lines.push("call $__free");
      lines.push("drop");
    }
    lines.push(pointer);
    lines.push("call $__free");
    lines.push("drop");
    return lines.join("\n");
  }).filter((line) => line !== "").join("\n");
}

function join_cleanup(...items: Wat[]): Wat {
  return items.filter((line) => line !== "").join("\n");
}

function bind_core_text_fact<ctx extends CoreStmtEmitCtx & StaticCoreCallCtx>(
  name: string,
  value: CoreExpr,
  annotation: string | undefined,
  ctx: ctx,
  hooks: Pick<
    CoreStmtEmitHooks<ctx>,
    "core_expr_is_text"
  >,
): void {
  if (
    annotation === "Text" || annotation === "Bytes" ||
    hooks.core_expr_is_text(value, ctx)
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
