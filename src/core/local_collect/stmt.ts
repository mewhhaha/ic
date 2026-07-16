import { expect } from "../../expect.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { set_local } from "../emit/local.ts";
import { core_statement_cleanup_rows } from "../cleanup_emission.ts";
import { collect_if_else_stmt_locals } from "../local_collect_if_else.ts";
import { collect_core_if_let_stmt_locals } from "../local_collect_if_let.ts";
import {
  collect_collection_loop_stmt_locals,
  collect_range_loop_stmt_locals,
} from "../local_collect_loop.ts";
import {
  declare_runtime_text_index_assign_locals,
  runtime_text_index_assign_plan,
} from "../runtime_text.ts";
import { static_core_call_branch_value } from "../static_call.ts";
import { static_scratch_aggregate_alias_materializes } from "../static_values.ts";
import { static_function_value } from "../type_static.ts";
import {
  mutable_static_owner_value_materializes,
  static_owner_value_materializes,
} from "../mutable_static_owner.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./types.ts";

export type CoreStmtLocalCollectApi = {
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

export function collect_core_stmt_locals(
  stmt: CoreStmt,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreStmtLocalCollectApi,
): void {
  switch (stmt.tag) {
    case "bind": {
      const value = hooks.core_binding_value(stmt, ctx);
      const type_value = hooks.core_type_const_value(stmt, value, ctx);

      if (type_value) {
        ctx.locals.delete(stmt.name);
        ctx.statics.set(stmt.name, type_value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return;
      }

      if (value.tag === "rec") {
        ctx.locals.delete(stmt.name);
        ctx.statics.set(stmt.name, value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return;
      }

      if (value.tag === "rec_ref") {
        ctx.locals.delete(stmt.name);
        ctx.statics.delete(stmt.name);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return;
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
          return;
        }

        const function_value = static_function_value(value, ctx);

        if (function_value) {
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, function_value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return;
        }
      }

      if (value.tag === "lam") {
        const plan = hooks.plan_core_lam_capture(value, ctx, false);

        if (plan) {
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, plan.value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return;
        }
      }

      if (
        hooks.is_static_value_expr(value, ctx) &&
        (ctx.mutable_bindings?.has(stmt.name) !== true ||
          value.tag === "struct_value")
      ) {
        const plan = hooks.plan_static_value_expr(value, ctx, undefined);
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
          api.collect_expr_locals(plan.value, ctx, hooks);
          set_local(ctx.locals, stmt.name, hooks.expr_type(plan.value, ctx));
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
          if (
            stmt.annotation === "Text" || stmt.annotation === "Bytes" ||
            hooks.core_expr_is_text(plan.value, ctx)
          ) {
            ctx.text_locals.add(stmt.name);
          } else {
            ctx.text_locals.delete(stmt.name);
          }
          bind_core_frozen_fact(stmt.name, value, ctx);
          return;
        }
        ctx.locals.delete(stmt.name);
        ctx.statics.set(stmt.name, plan.value);
        hooks.clear_core_local_facts(stmt.name, ctx);
        return;
      }

      ctx.statics.delete(stmt.name);
      api.collect_expr_locals(value, ctx, hooks);
      set_local(ctx.locals, stmt.name, hooks.expr_type(value, ctx));
      hooks.bind_core_fn_type(stmt.name, value, ctx);
      hooks.bind_core_struct_type(stmt.name, value, stmt.annotation, ctx);
      hooks.bind_core_union_type(stmt.name, value, stmt.annotation, ctx);

      if (
        stmt.annotation === "Text" || stmt.annotation === "Bytes" ||
        hooks.core_expr_is_text(value, ctx)
      ) {
        ctx.text_locals.add(stmt.name);
      } else {
        ctx.text_locals.delete(stmt.name);
      }

      bind_core_frozen_fact(stmt.name, value, ctx);

      return;
    }

    case "assign":
      expect(
        ctx.locals.has(stmt.name) || ctx.statics.has(stmt.name),
        "Cannot assign unbound core local: " + stmt.name,
      );
      {
        const value = hooks.core_assignment_value(stmt, ctx);

        if (
          hooks.is_static_value_expr(value, ctx) &&
          (ctx.mutable_bindings?.has(stmt.name) !== true ||
            value.tag === "struct_value" ||
            value.tag === "struct_update")
        ) {
          const plan = hooks.plan_static_value_expr(
            value,
            ctx,
            undefined,
          );
          if (
            static_scratch_aggregate_alias_materializes(value) ||
            (value.tag !== "scratch" &&
              static_owner_value_materializes(plan.value, ctx)) ||
            mutable_static_owner_binding(stmt.name, plan.value, ctx)
          ) {
            ctx.statics.delete(stmt.name);
            api.collect_expr_locals(plan.value, ctx, hooks);
            set_local(ctx.locals, stmt.name, hooks.expr_type(plan.value, ctx));
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
            if (hooks.core_expr_is_text(plan.value, ctx)) {
              ctx.text_locals.add(stmt.name);
            } else {
              ctx.text_locals.delete(stmt.name);
            }
            bind_core_frozen_fact(stmt.name, value, ctx);
            declare_assignment_cleanup_locals(stmt, value, ctx, hooks);
            return;
          }
          ctx.locals.delete(stmt.name);
          ctx.statics.set(stmt.name, plan.value);
          hooks.clear_core_local_facts(stmt.name, ctx);
          return;
        }

        ctx.statics.delete(stmt.name);
        api.collect_expr_locals(value, ctx, hooks);
        set_local(ctx.locals, stmt.name, hooks.expr_type(value, ctx));
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

        if (hooks.core_expr_is_text(value, ctx)) {
          ctx.text_locals.add(stmt.name);
        } else {
          ctx.text_locals.delete(stmt.name);
        }

        bind_core_frozen_fact(stmt.name, value, ctx);

        declare_assignment_cleanup_locals(stmt, value, ctx, hooks);

        return;
      }

    case "index_assign":
      {
        const target = hooks.static_struct_binding(stmt.name, ctx);

        if (target) {
          const plan = hooks.plan_core_static_index_assign(
            target,
            stmt.index,
            stmt.value,
            ctx,
            undefined,
          );
          ctx.statics.set(stmt.name, plan.value);
          return;
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

        expect(
          ctx.locals.has(stmt.name),
          "Cannot index-assign unbound core local: " + stmt.name,
        );

        if (ctx.text_locals.has(stmt.name)) {
          api.collect_expr_locals(stmt.index, ctx, hooks);
          api.collect_expr_locals(stmt.value, ctx, hooks);
          const index_type = hooks.expr_type(stmt.index, ctx);
          const value_type = hooks.expr_type(stmt.value, ctx);
          expect(
            index_type === "i32",
            "Core text index assignment index must be i32",
          );
          expect(
            value_type === "i32",
            "Core text index assignment value must be i32",
          );
          const plan = runtime_text_index_assign_plan(ctx);
          declare_runtime_text_index_assign_locals(plan, ctx);
          return;
        }

        const type_expr = ctx.struct_locals.get(stmt.name);

        if (type_expr) {
          api.collect_expr_locals(stmt.index, ctx, hooks);
          api.collect_expr_locals(stmt.value, ctx, hooks);
          hooks.plan_core_runtime_aggregate_index_assign(
            type_expr,
            stmt,
            ctx,
          );
          return;
        }

        hooks.expr_type(stmt.index, ctx);
        hooks.expr_type(stmt.value, ctx);
      }

      return;

    case "range_loop":
      collect_range_loop_stmt_locals(stmt, ctx, hooks, {
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;

    case "collection_loop":
      collect_collection_loop_stmt_locals(stmt, ctx, hooks, {
        collect_expr_locals: api.collect_expr_locals,
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;

    case "if_stmt":
      api.collect_expr_locals(stmt.cond, ctx, hooks);
      hooks.expr_type(stmt.cond, ctx);

      for (const item of stmt.body) {
        api.collect_stmt_locals(item, ctx, hooks);
      }

      return;

    case "if_else_stmt":
      collect_if_else_stmt_locals(stmt, ctx, hooks, {
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;

    case "if_let_stmt": {
      collect_core_if_let_stmt_locals(stmt, ctx, hooks, {
        collect_expr_locals: api.collect_expr_locals,
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;
    }

    case "return":
      api.collect_expr_locals(stmt.value, ctx, hooks);
      hooks.expr_type(stmt.value, ctx);
      return;

    case "expr":
      api.collect_expr_locals(stmt.expr, ctx, hooks);
      hooks.expr_type(stmt.expr, ctx);
      for (const row of core_statement_cleanup_rows(stmt)) {
        if (row.pointer_local) {
          set_local(ctx.locals, row.pointer_local, "i32");
        }
      }
      return;

    case "type_check":
      hooks.check_core_type_pattern(stmt.pattern, stmt.target, ctx);
      return;

    case "break":
      if (stmt.value) {
        api.collect_expr_locals(stmt.value, ctx, hooks);
        hooks.expr_type(stmt.value, ctx);
      }
      return;

    case "continue":
    case "unsupported":
      return;
  }
}

function declare_assignment_cleanup_locals(
  stmt: Extract<CoreStmt, { tag: "assign" }>,
  value: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  for (const row of core_statement_cleanup_rows(stmt)) {
    if (row.edge !== "assignment_replace") {
      continue;
    }
    expect(
      row.replacement_value_local,
      "Assignment replacement cleanup requires a value local",
    );
    expect(
      row.replacement_old_local,
      "Assignment replacement cleanup requires an old-owner local",
    );
    set_local(
      ctx.locals,
      row.replacement_value_local,
      hooks.expr_type(value, ctx),
    );
    set_local(ctx.locals, row.replacement_old_local, "i32");
  }
}

function mutable_static_owner_binding(
  name: string,
  value: CoreExpr,
  ctx: CoreCtx,
): boolean {
  if (!ctx.mutable_bindings || !ctx.mutable_bindings.has(name)) {
    return false;
  }
  return mutable_static_owner_value_materializes(value);
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
