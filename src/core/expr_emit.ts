import { expect } from "../expect.ts";
import { Prim, type Prim as PrimNode, type ValType } from "../op.ts";
import { Emit } from "../trait.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "./ast.ts";
import {
  find_core_field,
  indent_lines,
  maybe_static_i32,
  static_indexed_field,
} from "./backend/util.ts";
import {
  core_expr_ownership,
  core_non_scalar_ownership_message,
  core_ownership_result_text,
  type CoreOwnership,
  type CoreOwnershipHooks,
} from "./ownership.ts";
import { core_scratch_return_rejection_detail } from "./cleanup.ts";
import {
  core_freeze_lifetime_decision,
  core_lifetime_rejection_message,
  core_scratch_return_lifetime_decision,
} from "./lifetime.ts";
import {
  core_scratch_plan,
  type CoreScratchHeap,
  emit_core_scratch_expr,
} from "./scratch.ts";
import { emit_runtime_text_freeze_copy } from "./runtime_text.ts";
import type { DynamicUnionIf } from "./if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "./runtime_union.ts";
import {
  emit_runtime_union_freeze_copy,
  runtime_union_freeze_copy_supported,
} from "./runtime_union_emit.ts";
import {
  emit_runtime_aggregate_field_load,
  emit_runtime_aggregate_field_pointer,
  emit_runtime_aggregate_freeze_copy,
  emit_runtime_aggregate_value,
  runtime_aggregate_field_info,
  runtime_aggregate_freeze_copy_supported,
  runtime_aggregate_type_expr,
} from "./runtime_aggregate.ts";
import type { TypeStaticCtx } from "./type_static.ts";
import type { RuntimeTextEq } from "./text_facts.ts";

export type CoreExprEmitCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  heap: {
    needed: boolean;
  };
  scratch: CoreScratchHeap;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  next_loop: number;
  next_temp: number;
  text_layout: {
    offsets: Map<string, number>;
  };
};

export type CoreExprEmitHooks<ctx extends CoreExprEmitCtx> = {
  bind_core_if_let_payload_fact: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => void;
  bind_dynamic_if_let_payload: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: ctx,
  ) => void;
  check_core_text_concat_operand_visibility: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => void;
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
  core_typed_prim: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => PrimNode;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  emit_core_app: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    ctx: ctx,
  ) => Wat;
  emit_core_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    ctx: ctx,
  ) => Wat;
  emit_dynamic_index_expr: (
    fields: CoreField[],
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_closure: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_byte_index: (
    object: CoreExpr,
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_eq: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_union_value: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  is_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => boolean;
  runtime_text_eq_operands: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => RuntimeTextEq | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr | undefined,
    right: CoreExpr | undefined,
    ctx: ctx,
  ) => boolean;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => RuntimeUnionTarget | undefined;
  if_let_branch_ctx: (ctx: ctx) => ctx;
  same_runtime_union_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreField[] | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => ctx;
  static_union_case: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  static_text_byte_index_expr: (
    expr: Extract<CoreExpr, { tag: "index" }>,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_text_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
};

export function emit_core_expr<ctx extends CoreExprEmitCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): Wat {
  switch (expr.tag) {
    case "num":
      return expr.type + ".const " + expr.value.toString();

    case "text": {
      const offset = ctx.text_layout.offsets.get(expr.value);
      expect(offset !== undefined, "Missing core text data offset");
      return "i32.const " + offset.toString();
    }

    case "linear": {
      const lookup_expr: CoreExpr = { tag: "var", name: expr.name };
      const text_value = hooks.static_text_value(lookup_expr, ctx);

      if (text_value) {
        return emit_core_expr(text_value, ctx, hooks);
      }

      const union_value = hooks.runtime_union_value(lookup_expr, ctx);

      if (union_value) {
        return hooks.emit_runtime_union_value(union_value, ctx);
      }

      const struct_value = hooks.static_struct_value(lookup_expr, ctx);

      if (struct_value) {
        return emit_runtime_aggregate_value(struct_value, ctx, {
          core_expr_is_text: hooks.core_expr_is_text,
          emit_expr: emit_core_expr_with_hooks,
          expr_type: hooks.expr_type,
          runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
          runtime_union_type_expr: hooks.runtime_union_type_expr,
          same_runtime_aggregate_type_expr:
            hooks.same_runtime_aggregate_type_expr,
          same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
          static_struct_value: hooks.static_struct_value,
        });
      }

      const static_value = ctx.statics.get(expr.name);

      if (static_value) {
        if (hooks.closure_fn_type(lookup_expr, ctx)) {
          return emit_core_expr(static_value, ctx, hooks);
        }

        throw new Error("Cannot emit core static value directly: " + expr.name);
      }

      const type = ctx.locals.get(expr.name);
      expect(type, "Unbound core local: " + expr.name);
      return "local.get $" + expr.name;
    }

    case "var": {
      const text_value = hooks.static_text_value(expr, ctx);

      if (text_value) {
        return emit_core_expr(text_value, ctx, hooks);
      }

      const union_value = hooks.runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.emit_runtime_union_value(union_value, ctx);
      }

      const struct_value = hooks.static_struct_value(expr, ctx);

      if (struct_value) {
        return emit_runtime_aggregate_value(struct_value, ctx, {
          core_expr_is_text: hooks.core_expr_is_text,
          emit_expr: emit_core_expr_with_hooks,
          expr_type: hooks.expr_type,
          runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
          runtime_union_type_expr: hooks.runtime_union_type_expr,
          same_runtime_aggregate_type_expr:
            hooks.same_runtime_aggregate_type_expr,
          same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
          static_struct_value: hooks.static_struct_value,
        });
      }

      const static_value = ctx.statics.get(expr.name);

      if (static_value) {
        if (hooks.closure_fn_type(expr, ctx)) {
          return emit_core_expr(static_value, ctx, hooks);
        }

        throw new Error("Cannot emit core static value directly: " + expr.name);
      }

      const type = ctx.locals.get(expr.name);
      expect(type, "Unbound core local: " + expr.name);
      return "local.get $" + expr.name;
    }

    case "prim": {
      const text_value = hooks.static_text_value(expr, ctx);

      if (text_value) {
        return emit_core_expr(text_value, ctx, hooks);
      }

      if (hooks.is_runtime_text_concat(expr, ctx)) {
        return hooks.emit_runtime_text_concat(expr, ctx);
      }

      if (hooks.runtime_text_eq_operands(expr, ctx)) {
        return hooks.emit_runtime_text_eq(expr, ctx);
      }

      hooks.check_core_text_concat_operand_visibility(expr, ctx);
      const prim = hooks.core_typed_prim(expr, ctx);
      hooks.expr_type(expr, ctx);
      const lines: string[] = [];

      for (const arg of expr.args) {
        lines.push(emit_core_expr(arg, ctx, hooks));
      }

      lines.push(Emit.emit(Prim, prim));
      return lines.join("\n");
    }

    case "app":
      {
        const union_value = hooks.runtime_union_value(expr, ctx);

        if (union_value) {
          return hooks.emit_runtime_union_value(union_value, ctx);
        }
      }

      return hooks.emit_core_app(expr, ctx);

    case "if": {
      const union_value = hooks.runtime_union_value(expr, ctx);

      if (union_value) {
        return hooks.emit_runtime_union_value(union_value, ctx);
      }

      const result_type = hooks.expr_type(expr, ctx);
      let else_branch = emit_core_expr(expr.else_branch, ctx, hooks);

      if (expr.implicit_else) {
        if (hooks.core_expr_is_text(expr, ctx)) {
          else_branch = emit_core_expr({ tag: "text", value: "" }, ctx, hooks);
        } else {
          else_branch = result_type + ".const 0";
        }
      }

      return [
        emit_core_expr(expr.cond, ctx, hooks),
        "if (result " + result_type + ")",
        indent_lines(emit_core_expr(expr.then_branch, ctx, hooks), 2),
        "else",
        indent_lines(else_branch, 2),
        "end",
      ].join("\n");
    }

    case "if_let": {
      const text_value = hooks.static_text_value(expr, ctx);

      if (text_value) {
        return emit_core_expr(text_value, ctx, hooks);
      }

      return hooks.emit_core_if_let_expr(expr, ctx);
    }

    case "lam":
      return hooks.emit_runtime_closure(expr, ctx);

    case "block": {
      const lines: string[] = [];

      for (let index = 0; index < expr.statements.length; index += 1) {
        const stmt = expr.statements[index];
        expect(stmt, "Missing core block statement " + index);
        const is_final = index + 1 >= expr.statements.length;
        lines.push(hooks.emit_stmt(stmt, ctx, is_final));
      }

      return lines.join("\n");
    }

    case "borrow": {
      return emit_core_expr(expr.value, ctx, hooks);
    }

    case "freeze": {
      const result_type = hooks.expr_type(expr.value, ctx);
      const ownership = core_expr_ownership(expr.value, ctx, {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.if_let_branch_ctx,
        collect_stmt_locals: hooks.collect_stmt_locals,
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.value) {
            return result_type;
          }

          return hooks.expr_type(value, value_ctx);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.if_let_branch_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.runtime_union_value,
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
            "Cannot emit core freeze value",
            ownership,
          ),
          decision,
        ),
      );

      if (ownership.tag === "unique_heap" && ownership.reason === "text") {
        return emit_core_freeze_text_value(expr.value, ctx, hooks);
      }

      if (
        ownership.tag === "unique_heap" &&
        ownership.reason === "runtime_aggregate" &&
        emit_core_freeze_can_materialize_runtime_aggregate(
          expr.value,
          ctx,
          hooks,
        )
      ) {
        return emit_core_freeze_persistent_value(expr.value, ctx, hooks);
      }

      if (
        ownership.tag === "unique_heap" &&
        ownership.reason === "runtime_aggregate" &&
        emit_core_freeze_can_copy_runtime_aggregate(expr.value, ctx, hooks)
      ) {
        const type_expr = hooks.runtime_aggregate_type_expr(expr.value, ctx);
        expect(type_expr, "Missing runtime aggregate freeze-copy type");
        return emit_runtime_aggregate_freeze_copy(expr.value, type_expr, ctx, {
          core_expr_is_text: hooks.core_expr_is_text,
          emit_expr: emit_core_expr_with_hooks,
          expr_type: hooks.expr_type,
          runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
          runtime_union_type_expr: hooks.runtime_union_type_expr,
          same_runtime_aggregate_type_expr:
            hooks.same_runtime_aggregate_type_expr,
          same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
          emit_runtime_union_freeze_copy:
            emit_runtime_aggregate_nested_union_freeze_copy,
          static_struct_value: hooks.static_struct_value,
        });
      }

      if (
        ownership.tag === "unique_heap" &&
        ownership.reason === "runtime_union" &&
        emit_core_freeze_can_materialize_runtime_union(expr.value, ctx, hooks)
      ) {
        return emit_core_freeze_persistent_value(expr.value, ctx, hooks);
      }

      if (
        ownership.tag === "unique_heap" &&
        ownership.reason === "runtime_union" &&
        emit_core_freeze_can_copy_runtime_union(expr.value, ctx, hooks)
      ) {
        const type_expr = hooks.runtime_union_type_expr(expr.value, ctx);
        expect(type_expr, "Missing runtime union freeze-copy type");
        return emit_runtime_union_freeze_copy(expr.value, type_expr, ctx, {
          core_expr_is_text: hooks.core_expr_is_text,
          emit_expr: emit_core_expr_with_hooks,
          expr_type: hooks.expr_type,
          runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
          runtime_union_type_expr: hooks.runtime_union_type_expr,
          same_runtime_aggregate_type_expr:
            hooks.same_runtime_aggregate_type_expr,
          same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
          static_struct_value: hooks.static_struct_value,
        });
      }

      return emit_core_expr(expr.value, ctx, hooks);
    }

    case "scratch": {
      const result_type = hooks.expr_type(expr.body, ctx);
      const ownership_hooks: CoreOwnershipHooks<ctx> = {
        closure_fn_type: hooks.closure_fn_type,
        core_expr_is_text: hooks.core_expr_is_text,
        bind_core_if_let_payload_fact: hooks.bind_core_if_let_payload_fact,
        bind_dynamic_if_let_payload: hooks.bind_dynamic_if_let_payload,
        block_ctx: hooks.if_let_branch_ctx,
        collect_stmt_locals: hooks.collect_stmt_locals,
        dynamic_union_if: hooks.dynamic_union_if,
        expr_type: (value, value_ctx) => {
          if (value === expr.body) {
            return result_type;
          }

          return hooks.expr_type(value, value_ctx);
        },
        frozen_local: frozen_core_local,
        if_let_branch_ctx: hooks.if_let_branch_ctx,
        runtime_union_match_info: hooks.runtime_union_match_info,
        runtime_union_target: hooks.runtime_union_target,
        runtime_union_value: hooks.runtime_union_value,
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
      const ownership = core_expr_ownership(expr.body, ctx, ownership_hooks);
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
            "Cannot emit core scratch block",
            ownership,
            detail,
          ),
          decision,
        ),
      );
      const plan = core_scratch_plan(ctx);
      ctx.scratch_return_resets.push(plan.base);
      ctx.scratch_loop_resets.push(plan.base);
      const body = emit_core_expr(expr.body, ctx, hooks);
      const loop_reset = ctx.scratch_loop_resets.pop();
      const return_reset = ctx.scratch_return_resets.pop();
      expect(
        loop_reset === plan.base,
        "Core scratch loop cleanup stack mismatch",
      );
      expect(
        return_reset === plan.base,
        "Core scratch return cleanup stack mismatch",
      );
      return emit_core_scratch_expr(body, plan, result_type, ctx);
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
          throw new Error("Cannot emit core field expression yet");
        }

        if (field_info.tag === "struct") {
          return emit_runtime_aggregate_field_pointer(
            expr.object,
            expr.name,
            ctx,
            {
              check_closure_call_args: hooks.check_closure_call_args,
              closure_fn_type: hooks.closure_fn_type,
              emit_expr: emit_core_expr_with_hooks,
            },
          );
        }

        return emit_runtime_aggregate_field_load(expr.object, expr.name, ctx, {
          check_closure_call_args: hooks.check_closure_call_args,
          closure_fn_type: hooks.closure_fn_type,
          emit_expr: emit_core_expr_with_hooks,
        });
      }

      const field = find_core_field(struct_value.fields, expr.name);
      expect(field, "Missing static core field: " + expr.name);
      return emit_core_expr(field.value, ctx, hooks);
    }

    case "index": {
      const fields = hooks.static_collection_fields(expr.object, ctx);

      if (!fields) {
        const text_byte = hooks.static_text_byte_index_expr(expr, ctx);

        if (text_byte) {
          return emit_core_expr(text_byte, ctx, hooks);
        }

        if (hooks.core_expr_is_text(expr.object, ctx)) {
          return hooks.emit_runtime_text_byte_index(
            expr.object,
            expr.index,
            ctx,
          );
        }

        throw new Error("Cannot emit core index expression yet");
      }

      const index_type = hooks.expr_type(expr.index, ctx);
      expect(index_type === "i32", "Core index expression index must be i32");
      const index = maybe_static_i32(expr.index);

      if (index !== undefined) {
        const field = static_indexed_field(fields, index);
        return emit_core_expr(field.value, ctx, hooks);
      }

      return hooks.emit_dynamic_index_expr(fields, expr.index, ctx);
    }

    case "struct_value":
      return emit_runtime_aggregate_value(expr, ctx, {
        core_expr_is_text: hooks.core_expr_is_text,
        emit_expr: emit_core_expr_with_hooks,
        expr_type: hooks.expr_type,
        runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
        runtime_union_type_expr: hooks.runtime_union_type_expr,
        same_runtime_aggregate_type_expr:
          hooks.same_runtime_aggregate_type_expr,
        same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
        static_struct_value: hooks.static_struct_value,
      });

    case "union_case":
      return hooks.emit_runtime_union_value(expr, ctx);

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        throw new Error("Missing host capability method: " + expr.text);
      }

      throw new Error("Cannot emit core " + expr.tag + " expression yet");

    case "type_name":
    case "rec":
    case "comptime":
    case "with":
    case "struct_type":
    case "struct_update":
    case "union_type":
      throw new Error("Cannot emit core " + expr.tag + " expression yet");
  }

  function emit_core_expr_with_hooks(value: CoreExpr, value_ctx: ctx): Wat {
    return emit_core_expr(value, value_ctx, hooks);
  }
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

function emit_core_freeze_text_value<ctx extends CoreExprEmitCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): Wat {
  if (ctx.scratch_return_resets.length > 0) {
    return emit_runtime_text_freeze_copy(value, ctx, {
      emit_expr: (expr, expr_ctx) => emit_core_expr(expr, expr_ctx, hooks),
    });
  }

  return emit_core_expr(value, ctx, hooks);
}

function emit_core_freeze_can_materialize_runtime_aggregate<
  ctx extends CoreExprEmitCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): boolean {
  if (hooks.static_struct_value(value, ctx)) {
    return value.tag === "struct_value";
  }

  return false;
}

function emit_core_freeze_can_copy_runtime_aggregate<
  ctx extends CoreExprEmitCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): boolean {
  if (ctx.scratch_return_resets.length === 0) {
    return false;
  }

  if (emit_core_freeze_can_materialize_runtime_aggregate(value, ctx, hooks)) {
    return false;
  }

  const type_expr = hooks.runtime_aggregate_type_expr(value, ctx);

  if (!type_expr) {
    return false;
  }

  return runtime_aggregate_freeze_copy_supported(
    type_expr,
    ctx as ctx & TypeStaticCtx,
    {
      runtime_union_freeze_copy_supported,
    },
  );
}

function emit_runtime_aggregate_nested_union_freeze_copy<
  ctx extends CoreExprEmitCtx & TypeStaticCtx,
>(
  source: CoreExpr,
  type_expr: CoreExpr,
  ctx: ctx,
  hooks: {
    core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
    expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
    runtime_aggregate_type_expr: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    runtime_union_type_expr: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    same_runtime_aggregate_type_expr: (
      left: CoreExpr | undefined,
      right: CoreExpr | undefined,
      ctx: ctx,
    ) => boolean;
    same_runtime_union_type_expr: (
      left: CoreExpr,
      right: CoreExpr,
      ctx: ctx,
    ) => boolean;
    static_struct_value: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  },
): Wat {
  return emit_runtime_union_freeze_copy(source, type_expr, ctx, {
    core_expr_is_text: hooks.core_expr_is_text,
    emit_expr: hooks.emit_expr,
    expr_type: hooks.expr_type,
    runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
    runtime_union_type_expr: hooks.runtime_union_type_expr,
    same_runtime_aggregate_type_expr: hooks.same_runtime_aggregate_type_expr,
    same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
    static_struct_value: hooks.static_struct_value,
  });
}

function emit_core_freeze_can_materialize_runtime_union<
  ctx extends CoreExprEmitCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): boolean {
  const union_value = hooks.runtime_union_value(value, ctx);

  if (!union_value) {
    return false;
  }

  return value.tag !== "var" && union_value.tag === "union_case";
}

function emit_core_freeze_can_copy_runtime_union<
  ctx extends CoreExprEmitCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): boolean {
  if (ctx.scratch_return_resets.length === 0) {
    return false;
  }

  if (emit_core_freeze_can_materialize_runtime_union(value, ctx, hooks)) {
    return false;
  }

  const type_expr = hooks.runtime_union_type_expr(value, ctx);

  if (!type_expr) {
    return false;
  }

  return runtime_union_freeze_copy_supported(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
}

function emit_core_freeze_persistent_value<ctx extends CoreExprEmitCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): Wat {
  if (ctx.scratch_return_resets.length === 0) {
    return emit_core_expr(value, ctx, hooks);
  }

  const scratch_return_resets = ctx.scratch_return_resets;
  ctx.scratch_return_resets = [];

  try {
    return emit_core_expr(value, ctx, hooks);
  } finally {
    ctx.scratch_return_resets = scratch_return_resets;
  }
}
