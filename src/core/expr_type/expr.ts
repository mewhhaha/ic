import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import {
  find_core_field,
  maybe_static_i32,
  static_indexed_field,
} from "../backend/util.ts";
import {
  core_scratch_return_ownership,
  core_scratch_return_rejection_detail,
} from "../cleanup.ts";
import { static_collection_item_type } from "../index_expr.ts";
import {
  core_expr_ownership,
  core_non_scalar_ownership_message,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "../ownership.ts";
import {
  core_freeze_lifetime_decision,
  core_lifetime_rejection_message,
  core_scratch_return_lifetime_decision,
} from "../lifetime.ts";
import {
  runtime_aggregate_field_info,
  runtime_aggregate_type_expr,
} from "../runtime_aggregate.ts";
import { if_let_expr_type } from "./if_let.ts";
import { prim_expr_type } from "./prim.ts";
import type {
  CoreExprTypeBlockCtx,
  CoreExprTypeCtx,
  CoreExprTypeHooks,
} from "./types.ts";

export function stmt_result_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): ValType {
  if (stmt.tag === "expr") {
    return expr_type(stmt.expr, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return expr_type(stmt.value, ctx, hooks);
  }

  throw new Error("Core final statement does not produce a value: " + stmt.tag);
}

export function expr_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): ValType {
  switch (expr.tag) {
    case "num":
      return expr.type;

    case "text":
      return "i32";

    case "linear":
    case "var": {
      const lookup_expr: CoreExpr = { tag: "var", name: expr.name };
      const text_value = hooks.static_text_value(lookup_expr, ctx);

      if (text_value) {
        return "i32";
      }

      const union_value = hooks.core_runtime_union_value(lookup_expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      if (hooks.static_struct_value(lookup_expr, ctx)) {
        return "i32";
      }

      if (expr_type_closure_fn_type(lookup_expr, ctx, hooks)) {
        return "i32";
      }

      if (ctx.statics.has(expr.name)) {
        throw new Error("Cannot type core static value directly: " + expr.name);
      }

      const type = ctx.locals.get(expr.name);
      expect(type, "Unbound core local: " + expr.name);
      return type;
    }

    case "prim":
      return prim_expr_type(expr, ctx, hooks, expr_type);

    case "app": {
      const union_value = hooks.core_runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      return hooks.app_type(expr, ctx);
    }

    case "if": {
      const fn_type = expr_type_closure_fn_type(expr, ctx, hooks);

      if (fn_type) {
        return "i32";
      }

      const union_value = hooks.core_runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.runtime_union_value_type(union_value, ctx);
      }

      const cond_type = expr_type(expr.cond, ctx, hooks);
      expect(cond_type === "i32", "Core if condition must be i32");
      const then_type = expr_type(expr.then_branch, ctx, hooks);
      const else_type = expr_type(expr.else_branch, ctx, hooks);
      if (expr.implicit_else) {
        return then_type;
      }

      expect(then_type === else_type, "Core if branch type mismatch");
      return then_type;
    }

    case "if_let": {
      const fn_type = expr_type_closure_fn_type(expr, ctx, hooks);

      if (fn_type) {
        return "i32";
      }

      return if_let_expr_type(expr, ctx, hooks, expr_type);
    }

    case "block": {
      const final_stmt = expr.statements[expr.statements.length - 1];
      expect(final_stmt, "Core block has no result statement");
      const block_ctx = hooks.create_block_ctx(ctx);

      for (let index = 0; index + 1 < expr.statements.length; index += 1) {
        const stmt = expr.statements[index];
        expect(stmt, "Missing core block statement " + index.toString());
        hooks.collect_stmt_locals(stmt, block_ctx);
      }

      return stmt_result_type(final_stmt, block_ctx, hooks);
    }

    case "borrow": {
      const result_type = expr_type(expr.value, ctx, hooks);
      return result_type;
    }

    case "freeze": {
      const result_type = expr_type(expr.value, ctx, hooks);
      const ownership = core_expr_ownership(expr.value, ctx, {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.create_block_ctx,
        collect_stmt_locals: (stmt, value_ctx) =>
          hooks.collect_stmt_locals(stmt, value_ctx as unknown as block_ctx),
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.value) {
            return result_type;
          }

          return expr_type(value, value_ctx, hooks);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.create_block_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.core_runtime_union_value,
        runtime_aggregate_type_expr: (value, value_ctx) =>
          runtime_aggregate_type_expr(value, value_ctx, {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          }),
        static_runtime_union_match_branch_ctx:
          hooks.static_runtime_union_match_branch_ctx,
        static_struct_value: hooks.static_struct_value,
        static_union_case: hooks.static_union_case,
        static_text_value: hooks.static_text_value,
      });
      const decision = core_freeze_lifetime_decision(ownership);
      expect(
        decision.tag === "allowed",
        core_lifetime_rejection_message(
          core_non_scalar_ownership_message(
            "Cannot type core freeze value",
            ownership,
          ),
          decision,
        ),
      );
      return result_type;
    }

    case "scratch": {
      const result_type = expr_type(expr.body, ctx, hooks);
      const ownership_hooks: CoreOwnershipHooks<ctx> = {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.create_block_ctx,
        collect_stmt_locals: (stmt, value_ctx) =>
          hooks.collect_stmt_locals(stmt, value_ctx as unknown as block_ctx),
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.body) {
            return result_type;
          }

          return expr_type(value, value_ctx, hooks);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.create_block_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.core_runtime_union_value,
        runtime_aggregate_type_expr: (value, value_ctx) =>
          runtime_aggregate_type_expr(value, value_ctx, {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          }),
        static_runtime_union_match_branch_ctx:
          hooks.static_runtime_union_match_branch_ctx,
        static_struct_value: hooks.static_struct_value,
        static_union_case: hooks.static_union_case,
        static_text_value: hooks.static_text_value,
      };
      const ownership = core_scratch_return_ownership(
        expr.body,
        ctx,
        ownership_hooks,
      );
      const decision = core_scratch_return_lifetime_decision(ownership);
      const detail = core_scratch_return_rejection_detail(
        expr.body,
        ctx,
        ownership_hooks,
      );
      expect(
        decision.tag === "allowed",
        core_lifetime_rejection_message(
          core_scratch_rejection_message(
            "Cannot type core scratch block",
            ownership,
            detail,
          ),
          decision,
        ),
      );
      return result_type;
    }

    case "field": {
      const struct_value = hooks.static_struct_value(expr.object, ctx);

      if (!struct_value) {
        const field_info = runtime_aggregate_field_info(
          expr.object,
          expr.name,
          ctx,
          {
            check_closure_call_args: hooks.check_closure_call_args,
            closure_fn_type: hooks.closure_fn_type,
          },
        );

        if (!field_info) {
          throw new Error("Cannot type core field expression yet");
        }

        if (field_info.tag === "struct") {
          return "i32";
        }

        expect(field_info.tag === "value", "Core unit field has no value");
        return field_info.type;
      }

      const field = find_core_field(struct_value.fields, expr.name);
      expect(field, "Missing static core field: " + expr.name);
      return expr_type(field.value, ctx, hooks);
    }

    case "index": {
      const fields = hooks.static_collection_fields(expr.object, ctx);

      if (!fields) {
        const text_byte = hooks.static_text_byte_index_expr(expr, ctx);

        if (text_byte) {
          return expr_type(text_byte, ctx, hooks);
        }

        if (hooks.core_expr_is_text(expr.object, ctx)) {
          const index_type = expr_type(expr.index, ctx, hooks);
          expect(index_type === "i32", "Core text byte index must be i32");
          return "i32";
        }

        throw new Error("Cannot type core index expression yet");
      }

      const index_type = expr_type(expr.index, ctx, hooks);
      expect(index_type === "i32", "Core index expression index must be i32");
      const index = maybe_static_i32(expr.index);

      if (index !== undefined) {
        const field = static_indexed_field(fields, index);
        return expr_type(field.value, ctx, hooks);
      }

      const item_type = static_collection_item_type(fields, ctx, {
        expr_type: (value: CoreExpr, item_ctx: ctx) =>
          expr_type(value, item_ctx, hooks),
      });
      expect(item_type, "Core dynamic index requires non-empty collection");
      return item_type;
    }

    case "struct_value":
      return "i32";

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        throw new Error("Missing host capability method: " + expr.text);
      }

      throw new Error("Cannot type core " + expr.tag + " expression yet");

    case "type_name":
    case "rec":
    case "comptime":
    case "with":
    case "struct_type":
    case "struct_update":
    case "union_type":
      throw new Error("Cannot type core " + expr.tag + " expression yet");

    case "union_case":
      return hooks.runtime_union_value_type(expr, ctx);

    case "lam": {
      const fn_type = hooks.closure_fn_type(expr, ctx);

      if (fn_type) {
        return "i32";
      }

      throw new Error("Cannot type core " + expr.tag + " expression yet");
    }
  }
}

function expr_type_closure_fn_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
): CoreFnType | undefined {
  try {
    return hooks.closure_fn_type(expr, ctx);
  } catch (error) {
    if (expr_type_closure_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function expr_type_closure_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith(
    "Core first-class closure parameter must use a scalar annotation:",
  );
}

function core_scratch_rejection_message(
  prefix: string,
  ownership: CoreOwnership,
  detail: string | undefined,
): string {
  if (detail) {
    return prefix + " with unsafe scratch return " + detail + " and " +
      "non-scalar " + core_ownership_result_text(ownership) + " result yet";
  }

  return core_non_scalar_ownership_message(prefix, ownership);
}

function frozen_core_local<ctx extends { frozen_locals?: Set<string> }>(
  name: string,
  ctx: ctx,
): boolean {
  if (!ctx.frozen_locals) {
    return false;
  }

  return ctx.frozen_locals.has(name);
}
