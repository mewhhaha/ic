import type { CoreExpr, CoreField, CoreStmt } from "../ast.ts";
import type { CoreFnType } from "../ast.ts";
import {
  find_core_field,
  maybe_static_i32,
  static_indexed_field,
} from "../backend/util.ts";
import { collect_block_expr_locals } from "../local_collect_block.ts";
import {
  collect_closure_call_locals,
  collect_closure_if_let_value_locals_with_type,
  collect_closure_value_locals_with_type,
  collect_runtime_closure_locals,
} from "../local_collect_closure.ts";
import { collect_core_if_let_expr_locals } from "../local_collect_if_let.ts";
import { collect_core_rec_call_locals } from "../local_collect_rec.ts";
import {
  declare_runtime_text_concat_locals,
  declare_runtime_text_eq_locals,
  declare_runtime_text_slice_locals,
  runtime_text_concat_plan,
  runtime_text_eq_plan,
  runtime_text_slice_plan,
} from "../runtime_text.ts";
import {
  declare_runtime_union_freeze_copy_locals,
  runtime_union_freeze_copy_supported,
} from "../runtime_union_emit.ts";
import {
  declare_runtime_aggregate_locals,
  runtime_aggregate_freeze_copy_supported,
  runtime_aggregate_layout_for_type,
  runtime_aggregate_plan,
  type RuntimeAggregateField,
} from "../runtime_aggregate.ts";
import { core_scratch_plan, declare_core_scratch_locals } from "../scratch.ts";
import {
  static_core_call_branch_app,
  static_core_call_requires_scope,
  static_core_rec_target,
} from "../static_call.ts";
import type { CoreCtx, CoreLocalCollectHooks } from "./types.ts";

export type CoreExprLocalCollectApi = {
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

export function collect_core_expr_locals(
  expr: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreExprLocalCollectApi,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "linear":
    case "rec":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var":
      {
        const struct_value = hooks.static_struct_value(expr, ctx);

        if (struct_value) {
          const plan = runtime_aggregate_plan(ctx);
          declare_runtime_aggregate_locals(plan, ctx);
          return;
        }
      }

      const static_value = ctx.statics.get(expr.name);

      if (static_value && local_collect_closure_fn_type(expr, ctx, hooks)) {
        api.collect_expr_locals(static_value, ctx, hooks);
        return;
      }

      hooks.collect_runtime_union_value_locals(expr, ctx);
      return;

    case "lam": {
      const fn_type = local_collect_closure_fn_type(expr, ctx, hooks);

      if (fn_type) {
        collect_runtime_closure_locals(ctx);
      }

      return;
    }

    case "rec_ref":
      return;

    case "rec":
      // rec body collected via dedicated rec local collector to avoid cycles on self refs
      return;

    case "prim":
      for (const arg of expr.args) {
        api.collect_expr_locals(arg, ctx, hooks);
      }

      if (hooks.core_runtime_text_concat_operands(expr, ctx)) {
        const locals = runtime_text_concat_plan(ctx);
        declare_runtime_text_concat_locals(locals, ctx);
      }

      if (hooks.core_runtime_text_eq_operands(expr, ctx)) {
        const locals = runtime_text_eq_plan(ctx);
        declare_runtime_text_eq_locals(locals, ctx);
      }

      return;

    case "app": {
      if (hooks.collect_runtime_union_value_locals(expr, ctx)) {
        return;
      }

      const branch_static_call = static_core_call_branch_app(
        expr,
        ctx,
        hooks,
      );

      if (branch_static_call) {
        api.collect_expr_locals(branch_static_call, ctx, hooks);
        return;
      }

      const inlined = hooks.static_core_call_value(expr, ctx);

      if (inlined) {
        api.collect_expr_locals(inlined, ctx, hooks);
        return;
      }

      const target = hooks.static_core_call_target(expr.func, ctx);

      if (target && static_core_call_requires_scope(target)) {
        hooks.collect_scoped_static_core_call_locals(expr, target, ctx);
        return;
      }

      api.collect_expr_locals(expr.func, ctx, hooks);

      for (const arg of expr.args) {
        api.collect_expr_locals(arg, ctx, hooks);
      }

      if (expr.func.tag === "var" && expr.func.name === "slice") {
        const locals = runtime_text_slice_plan(ctx);
        declare_runtime_text_slice_locals(locals, ctx);
      }

      const rec_target = static_core_rec_target(expr.func, ctx);

      if (rec_target) {
        collect_core_rec_call_locals(expr, rec_target, ctx, hooks, {
          collect_expr_locals: api.collect_expr_locals,
          collect_stmt_locals: api.collect_stmt_locals,
        });
        return;
      }

      const fn_type = local_collect_closure_fn_type(expr.func, ctx, hooks);

      if (fn_type) {
        hooks.check_closure_call_args(expr, fn_type, ctx);
        collect_closure_call_locals(ctx);
      }

      if (
        expr.func.tag === "var" && expr.func.name === "append" &&
        !local_collect_closure_fn_type(expr.func, ctx, hooks)
      ) {
        const locals = runtime_text_concat_plan(ctx);
        declare_runtime_text_concat_locals(locals, ctx);
      }

      return;
    }

    case "block":
      collect_block_expr_locals(expr.statements, ctx, hooks, {
        collect_expr_locals: api.collect_expr_locals,
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;

    case "comptime":
      api.collect_expr_locals(expr.expr, ctx, hooks);
      return;

    case "borrow":
      api.collect_expr_locals(expr.value, ctx, hooks);
      return;

    case "freeze":
      api.collect_expr_locals(expr.value, ctx, hooks);

      collect_runtime_aggregate_freeze_copy_locals(expr.value, ctx, hooks);
      collect_runtime_union_freeze_copy_locals(expr.value, ctx, hooks);

      if (
        ctx.scratch_depth && ctx.scratch_depth > 0 &&
        hooks.core_expr_has_runtime_text_fact(expr.value, ctx)
      ) {
        const locals = runtime_text_slice_plan(ctx);
        declare_runtime_text_slice_locals(locals, ctx);
      }
      return;

    case "scratch": {
      const plan = core_scratch_plan(ctx);
      const scratch_depth = ctx.scratch_depth;
      if (scratch_depth === undefined) {
        ctx.scratch_depth = 1;
      } else {
        ctx.scratch_depth = scratch_depth + 1;
      }
      api.collect_expr_locals(expr.body, ctx, hooks);
      ctx.scratch_depth = scratch_depth;
      const result_type = hooks.expr_type(expr.body, ctx);
      declare_core_scratch_locals(plan, result_type, ctx);
      return;
    }

    case "with":
      api.collect_expr_locals(expr.base, ctx, hooks);
      collect_core_fields_expr_locals(expr.fields, ctx, hooks, api);
      return;

    case "struct_value":
      {
        const plan = runtime_aggregate_plan(ctx);
        declare_runtime_aggregate_locals(plan, ctx);
      }
      api.collect_expr_locals(expr.type_expr, ctx, hooks);
      collect_core_fields_expr_locals(expr.fields, ctx, hooks, api);
      return;

    case "struct_update":
      api.collect_expr_locals(expr.base, ctx, hooks);
      collect_core_fields_expr_locals(expr.fields, ctx, hooks, api);
      return;

    case "if":
      if (hooks.collect_runtime_union_value_locals(expr, ctx)) {
        return;
      }

      api.collect_expr_locals(expr.cond, ctx, hooks);
      {
        const fn_type = local_collect_closure_fn_type(expr, ctx, hooks);

        if (fn_type) {
          collect_closure_value_locals_with_type(
            expr.then_branch,
            fn_type,
            ctx,
            hooks,
            {
              collect_expr_locals: api.collect_expr_locals,
              collect_stmt_locals: api.collect_stmt_locals,
            },
          );
          collect_closure_value_locals_with_type(
            expr.else_branch,
            fn_type,
            ctx,
            hooks,
            {
              collect_expr_locals: api.collect_expr_locals,
              collect_stmt_locals: api.collect_stmt_locals,
            },
          );
          return;
        }
      }

      api.collect_expr_locals(expr.then_branch, ctx, hooks);
      api.collect_expr_locals(expr.else_branch, ctx, hooks);
      return;

    case "if_let":
      {
        const fn_type = local_collect_closure_fn_type(expr, ctx, hooks);

        if (fn_type) {
          collect_closure_if_let_value_locals_with_type(
            expr,
            fn_type,
            ctx,
            hooks,
            {
              collect_expr_locals: api.collect_expr_locals,
              collect_stmt_locals: api.collect_stmt_locals,
            },
          );
          return;
        }
      }

      collect_core_if_let_expr_locals(expr, ctx, hooks, {
        collect_expr_locals: api.collect_expr_locals,
        collect_stmt_locals: api.collect_stmt_locals,
      });
      return;

    case "field":
      {
        const struct_value = hooks.static_struct_value(expr.object, ctx);

        if (struct_value) {
          const field = find_core_field(struct_value.fields, expr.name);
          if (field) {
            api.collect_expr_locals(field.value, ctx, hooks);
          }
          return;
        }
      }

      api.collect_expr_locals(expr.object, ctx, hooks);
      return;

    case "index":
      {
        const fields = hooks.static_collection_fields(expr.object, ctx);

        if (fields) {
          api.collect_expr_locals(expr.index, ctx, hooks);
          const index = maybe_static_i32(expr.index);

          if (index !== undefined) {
            const field = static_indexed_field(fields, index);
            api.collect_expr_locals(field.value, ctx, hooks);
            return;
          }

          collect_core_fields_expr_locals(fields, ctx, hooks, api);
          return;
        }
      }

      api.collect_expr_locals(expr.object, ctx, hooks);
      api.collect_expr_locals(expr.index, ctx, hooks);
      return;

    case "union_case":
      hooks.collect_runtime_union_value_locals(expr, ctx);
      return;
  }
}

function local_collect_closure_fn_type(
  expr: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): CoreFnType | undefined {
  try {
    return hooks.closure_fn_type(expr, ctx);
  } catch (error) {
    if (local_collect_closure_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function local_collect_closure_probe_error(error: unknown): boolean {
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

  return false;
}

function collect_runtime_aggregate_freeze_copy_locals(
  value: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  if (!ctx.scratch_depth || ctx.scratch_depth <= 0) {
    return;
  }

  if (value.tag !== "var") {
    return;
  }

  const struct_value = hooks.static_struct_value(value, ctx);
  let type_expr = ctx.struct_locals.get(value.name);

  if (!type_expr && struct_value) {
    type_expr = struct_value.type_expr;
  }

  if (!type_expr) {
    return;
  }

  if (
    !runtime_aggregate_freeze_copy_supported(type_expr, ctx, {
      runtime_union_freeze_copy_supported,
    })
  ) {
    return;
  }

  if (!struct_value) {
    const plan = runtime_aggregate_plan(ctx);
    declare_runtime_aggregate_locals(plan, ctx);
  }

  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  collect_runtime_aggregate_freeze_field_copy_locals(layout.fields, ctx);
}

function collect_runtime_union_freeze_copy_locals(
  value: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): void {
  if (!ctx.scratch_depth || ctx.scratch_depth <= 0) {
    return;
  }

  if (runtime_union_freeze_can_materialize(value, ctx, hooks)) {
    return;
  }

  const type_expr = runtime_union_freeze_copy_type_expr(value, ctx, hooks);

  if (!type_expr) {
    return;
  }

  if (!runtime_union_freeze_copy_supported(type_expr, ctx)) {
    return;
  }

  declare_runtime_union_freeze_copy_locals(type_expr, ctx);
}

function runtime_union_freeze_can_materialize(
  value: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): boolean {
  const union_case = hooks.static_union_case(value, ctx);

  if (!union_case) {
    return false;
  }

  return value.tag !== "var";
}

function runtime_union_freeze_copy_type_expr(
  value: CoreExpr,
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
): CoreExpr | undefined {
  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    return union_case.type_expr;
  }

  const union_if = hooks.dynamic_union_if(value, ctx);

  if (union_if) {
    if (union_if.then_case.type_expr) {
      return union_if.then_case.type_expr;
    }

    return union_if.else_case.type_expr;
  }

  if (value.tag === "var") {
    const local_type = ctx.union_locals.get(value.name);

    if (local_type) {
      return local_type;
    }

    const static_value = ctx.statics.get(value.name);

    if (static_value) {
      return runtime_union_freeze_copy_type_expr(static_value, ctx, hooks);
    }
  }

  const target = hooks.runtime_union_target(value, ctx);

  if (target) {
    return target.type_expr;
  }

  return undefined;
}

function collect_runtime_aggregate_freeze_field_copy_locals(
  fields: RuntimeAggregateField[],
  ctx: CoreCtx,
): void {
  for (const field of fields) {
    if (field.tag === "unit") {
      continue;
    }

    if (field.tag === "struct") {
      collect_runtime_aggregate_freeze_field_copy_locals(field.fields, ctx);
      continue;
    }

    if (field.union_type_expr) {
      declare_runtime_union_freeze_copy_locals(field.union_type_expr, ctx);
      continue;
    }

    if (field.text) {
      const locals = runtime_text_slice_plan(ctx);
      declare_runtime_text_slice_locals(locals, ctx);
    }
  }
}

function collect_core_fields_expr_locals(
  fields: CoreField[],
  ctx: CoreCtx,
  hooks: CoreLocalCollectHooks,
  api: CoreExprLocalCollectApi,
): void {
  for (const field of fields) {
    api.collect_expr_locals(field.value, ctx, hooks);
  }
}
