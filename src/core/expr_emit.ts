import { expect } from "../expect.ts";
import { Prim } from "../op.ts";
import { Emit } from "../trait.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr } from "./ast.ts";
import {
  find_core_field,
  indent_lines,
  maybe_static_i32,
  static_indexed_field,
} from "./backend/util.ts";
import {
  emit_runtime_aggregate_field_load,
  emit_runtime_aggregate_field_pointer,
  emit_runtime_aggregate_value,
  runtime_aggregate_field_info,
} from "./runtime_aggregate.ts";
import { emit_core_freeze_expr } from "./expr_emit/freeze.ts";
import { emit_core_scratch_block_expr } from "./expr_emit/scratch.ts";
import type { CoreExprEmitCtx, CoreExprEmitHooks } from "./expr_emit/types.ts";

export type { CoreExprEmitCtx, CoreExprEmitHooks } from "./expr_emit/types.ts";

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

    case "rec_ref":
      // rec_ref stands for a named recursive function. It is only valid in call position
      // (handled in app_emit to emit direct 'call $name'). Appearing as a value is unsupported
      // (no runtime closure is materialized for direct-rec names). Emit unreachable to trap
      // rather than a misleading placeholder.
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
