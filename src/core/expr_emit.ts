import { expect } from "../expect.ts";
import {
  emit_prim_call,
  prim_preserves_integer_type,
  type PrimOperandEmission,
  specialize_prim_for_integer,
} from "../op.ts";
import type { IntegerType } from "../integer.ts";
import { type Wat, wat_number } from "../wat.ts";
import type { CoreExpr } from "./ast.ts";
import { find_core_field, static_indexed_field } from "./analysis/field.ts";
import { indent_lines } from "./emit/format.ts";
import { maybe_static_i32 } from "./analysis/static_i32.ts";
import {
  emit_runtime_aggregate_field_load,
  emit_runtime_aggregate_field_move,
  emit_runtime_aggregate_field_pointer,
  emit_runtime_aggregate_value,
  runtime_aggregate_field_info,
  runtime_aggregate_index_field,
  runtime_struct_update_value,
} from "./runtime_aggregate.ts";
import { emit_core_freeze_expr } from "./expr_emit/freeze.ts";
import { emit_core_scratch_block_expr } from "./expr_emit/scratch.ts";
import { emit_core_loop_expr } from "./loop.ts";
import type { CoreExprEmitCtx, CoreExprEmitHooks } from "./expr_emit/types.ts";
import { core_expression_cleanup_rows } from "./cleanup_emission.ts";
import { core_expr_is_borrowed } from "./local_facts.ts";

export type { CoreExprEmitCtx, CoreExprEmitHooks } from "./expr_emit/types.ts";

export function emit_core_expr<ctx extends CoreExprEmitCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): Wat {
  const emitted = emit_core_expr_unwrapped(expr, ctx, hooks);
  const cleanup_rows = core_expression_cleanup_rows(expr);

  if (cleanup_rows.length === 0) {
    return emitted;
  }

  const lines = [emitted];
  for (const row of cleanup_rows) {
    expect(
      row.pointer_local,
      "Expression cleanup requires a pointer local: " + row.step_id,
    );
    expect(
      ctx.locals.has(row.pointer_local),
      "Missing expression cleanup pointer local: " + row.pointer_local,
    );
    lines.push("local.tee $" + row.pointer_local);
  }
  return lines.join("\n");
}

function emit_core_expr_unwrapped<ctx extends CoreExprEmitCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreExprEmitHooks<ctx>,
): Wat {
  switch (expr.tag) {
    case "num":
      return expr.type + ".const " + wat_number(expr.type, expr.value);

    case "text": {
      const offset = ctx.text_layout.offsets.get(expr.value);
      expect(offset !== undefined, "Missing core text data offset");
      return "i32.const " + offset.toString();
    }

    case "linear": {
      const local_type = ctx.locals.get(expr.name);

      if (local_type) {
        return "local.get $" + expr.name;
      }

      const static_value = ctx.statics.get(expr.name);
      if (static_value && static_value.tag === "freeze") {
        return emit_core_expr(static_value, ctx, hooks);
      }

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
        return emit_runtime_aggregate_value(expr, struct_value, ctx, {
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

      if (static_value) {
        if (hooks.closure_fn_type(lookup_expr, ctx)) {
          return emit_core_expr(static_value, ctx, hooks);
        }

        throw new Error("Cannot emit core static value directly: " + expr.name);
      }

      throw new Error("Unbound core local: " + expr.name);
    }

    case "var": {
      const local_type = ctx.locals.get(expr.name);

      if (local_type) {
        return "local.get $" + expr.name;
      }

      const static_value = ctx.statics.get(expr.name);
      if (static_value && static_value.tag === "freeze") {
        return emit_core_expr(static_value, ctx, hooks);
      }

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
        return emit_runtime_aggregate_value(expr, struct_value, ctx, {
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

      if (static_value) {
        if (hooks.closure_fn_type(expr, ctx)) {
          return emit_core_expr(static_value, ctx, hooks);
        }

        throw new Error("Cannot emit core static value directly: " + expr.name);
      }

      throw new Error("Unbound core local: " + expr.name);
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
      let prim = hooks.core_typed_prim(expr, ctx);

      if (expr.integer) {
        prim = specialize_prim_for_integer(prim, expr.integer.signed);
      }
      hooks.expr_type(expr, ctx);
      const operands: PrimOperandEmission[] = [];

      for (const arg of expr.args) {
        let i32_literal: number | undefined;

        if (
          arg.tag === "num" && arg.type === "i32" &&
          typeof arg.value === "number"
        ) {
          i32_literal = arg.value;
        }

        operands.push({
          wat: emit_core_expr(arg, ctx, hooks),
          i32_literal,
        });
      }

      const call = emit_prim_call(prim, operands);

      if (!expr.integer || !prim_preserves_integer_type(prim)) {
        return call;
      }

      return call + "\n" + emit_integer_normalization(expr.integer);
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
      const then_branch = emit_core_expr(expr.then_branch, ctx, hooks);
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
        indent_lines(then_branch, 2),
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

    case "rec_ref":
      // Direct-rec names are only valid in call position, where app_emit
      // lowers them to Wasm calls. No runtime closure is materialized.
      return "unreachable";

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

    case "loop":
      return emit_core_loop_expr(expr, ctx, {
        emit_stmt: hooks.emit_stmt,
        expr_type: hooks.expr_type,
      });

    case "borrow": {
      return emit_core_expr(expr.value, ctx, hooks);
    }

    case "freeze": {
      return emit_core_freeze_expr(expr, ctx, hooks, emit_core_expr_with_hooks);
    }

    case "scratch": {
      return emit_core_scratch_block_expr(
        expr,
        ctx,
        hooks,
        emit_core_expr_with_hooks,
      );
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

        if (expr.move && !core_expr_is_borrowed(expr.object, ctx)) {
          return emit_runtime_aggregate_field_move(
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

        const index = maybe_static_i32(expr.index);
        if (index !== undefined) {
          const field = runtime_aggregate_index_field(
            expr.object,
            index,
            ctx,
            {
              check_closure_call_args: hooks.check_closure_call_args,
              closure_fn_type: hooks.closure_fn_type,
            },
          );
          if (field) {
            expect(field.tag !== "unit", "Core unit index has no value");
            return emit_core_expr(
              {
                tag: "field",
                object: expr.object,
                name: field.name,
                move: expr.move,
              },
              ctx,
              hooks,
            );
          }
        }

        throw new Error("Cannot emit core index expression yet");
      }

      const index_type = hooks.expr_type(expr.index, ctx);
      expect(index_type === "i32", "Core index expression index must be i32");
      const index = maybe_static_i32(expr.index);

      if (index !== undefined) {
        const field = static_indexed_field(fields, index);
        let value = field.value;

        if (
          expr.move && value.tag === "field" &&
          !core_expr_is_borrowed(expr.object, ctx)
        ) {
          value = { ...value, move: true };
        }

        return emit_core_expr(value, ctx, hooks);
      }

      return hooks.emit_dynamic_index_expr(fields, expr.index, ctx);
    }

    case "struct_value":
      return emit_runtime_aggregate_value(expr, expr, ctx, {
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

    case "struct_update": {
      const updated = runtime_struct_update_value(expr, ctx, {
        check_closure_call_args: hooks.check_closure_call_args,
        closure_fn_type: hooks.closure_fn_type,
        static_struct_value: hooks.static_struct_value,
      });
      expect(updated, "Cannot update non-struct core value");
      return emit_runtime_aggregate_value(expr, updated, ctx, {
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
    case "union_type":
      throw new Error("Cannot emit core " + expr.tag + " expression yet");
  }

  function emit_core_expr_with_hooks(value: CoreExpr, value_ctx: ctx): Wat {
    return emit_core_expr(value, value_ctx, hooks);
  }
}

function emit_integer_normalization(integer: IntegerType): Wat {
  let carrier_width = 32;
  let prefix = "i32";

  if (integer.width > 32) {
    carrier_width = 64;
    prefix = "i64";
  }

  if (integer.width === carrier_width) {
    return "";
  }

  if (!integer.signed) {
    const mask = (1n << BigInt(integer.width)) - 1n;
    return prefix + ".const " + mask.toString() + "\n" + prefix + ".and";
  }

  const shift = carrier_width - integer.width;
  return [
    prefix + ".const " + shift.toString(),
    prefix + ".shl",
    prefix + ".const " + shift.toString(),
    prefix + ".shr_s",
  ].join("\n");
}
