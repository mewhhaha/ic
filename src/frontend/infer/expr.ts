import type { Binding, Env, FrontExpr, FrontType } from "../ast.ts";
import { lookup } from "../env.ts";
import { front_expr_is_static_shareable_text } from "../ownership.ts";
import { infer_app_expr_type } from "./app.ts";
import { infer_block_type } from "./block.ts";
import { infer_if_expr_type, infer_if_let_expr_type } from "./control.ts";
import { infer_field_type, infer_index_type } from "./access.ts";
import { infer_prim_result_type } from "./prim.ts";
import type { InferHooks } from "./types.ts";

export function infer_front_expr(
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
): FrontType {
  switch (expr.tag) {
    case "num":
      return { tag: "int", type: expr.type };

    case "unit":
      return { tag: "int", type: "i32" };

    case "text":
      return { tag: "text" };

    case "type_name":
      return { tag: "type" };

    case "var": {
      const binding = lookup(env, expr.name);

      if (binding) {
        if (binding.type.tag === "unknown") {
          const value_type = infer_binding_value_type(binding, hooks);

          if (value_type) {
            return value_type;
          }
        }

        return binding.type;
      }

      return { tag: "unknown" };
    }

    case "prim":
      if (hooks.visible_text_value(expr, env, new Set())) {
        return { tag: "text" };
      }

      hooks.check_text_concat_operand_visibility(expr, env);
      return {
        tag: "int",
        type: infer_prim_result_type(expr, env, hooks, infer_front_expr),
      };

    case "lam":
      return { tag: "fn", params: expr.params };

    case "rec":
      return { tag: "fn", params: expr.params };

    case "app":
      return infer_app_expr_type(expr, env, hooks);

    case "block":
      return infer_block_type(expr.statements, env, hooks, infer_front_expr);

    case "comptime":
      return infer_front_expr(expr.expr, env, hooks);

    case "borrow":
    case "freeze": {
      const result_type = infer_front_expr(expr.value, env, hooks);

      if (result_type.tag === "int") {
        return result_type;
      }

      if (front_expr_is_static_shareable_text(expr.value, env, hooks)) {
        return { tag: "text" };
      }

      if (result_type.tag === "text") {
        return result_type;
      }

      if (
        result_type.tag === "struct" ||
        result_type.tag === "union" ||
        result_type.tag === "union_value" ||
        result_type.tag === "fn"
      ) {
        return result_type;
      }

      return { tag: "unknown" };
    }

    case "scratch": {
      const result_type = infer_front_expr(expr.body, env, hooks);

      if (result_type.tag === "int") {
        return result_type;
      }

      if (front_expr_is_static_shareable_text(expr.body, env, hooks)) {
        return { tag: "text" };
      }

      if (result_type.tag === "text") {
        return result_type;
      }

      if (
        result_type.tag === "struct" ||
        result_type.tag === "union" ||
        result_type.tag === "union_value" ||
        result_type.tag === "fn"
      ) {
        return result_type;
      }

      return { tag: "unknown" };
    }

    case "captured":
      return infer_front_expr(expr.expr, expr.env, hooks);

    case "handler":
      throw new Error(
        "Handler expression must be elaborated before frontend inference",
      );

    case "try_with":
      throw new Error(
        "Try-with expression must be elaborated before frontend inference",
      );

    case "with":
      return infer_front_expr(expr.base, env, hooks);

    case "struct_type":
      return { tag: "type" };

    case "struct_value":
      return {
        tag: "struct",
        fields: expr.fields.map((field) => field.name),
        field_types: hooks.resolve_struct_value_type_fields(expr, env),
      };

    case "struct_update": {
      const struct_type = hooks.maybe_struct_type_value(expr.base, env);

      if (struct_type) {
        return infer_front_expr(
          {
            tag: "struct_value",
            type_expr: expr.base,
            fields: expr.fields,
          },
          env,
          hooks,
        );
      }

      const target = hooks.resolve_struct_value(expr.base, env);

      if (!target) {
        return { tag: "unknown" };
      }

      return infer_front_expr(target.expr, target.env, hooks);
    }

    case "union_type":
      return { tag: "type" };

    case "if":
      return infer_if_expr_type(expr, env, hooks, infer_front_expr);

    case "if_let":
      return infer_if_let_expr_type(expr, env, hooks, infer_front_expr);

    case "field":
      return infer_field_type(expr, env, hooks, infer_front_expr);

    case "index":
      return infer_index_type(expr, env, hooks, infer_front_expr);

    case "union_case": {
      if (expr.type_expr) {
        const union_type = hooks.resolve_union_type_value(expr.type_expr, env);

        if (union_type) {
          return { tag: "union_value", cases: union_type.cases };
        }
      }

      const union_cases = hooks.infer_union_cases(expr, env);

      if (union_cases) {
        return { tag: "union_value", cases: union_cases };
      }

      return { tag: "union", case_name: expr.name };
    }

    case "linear": {
      const binding = lookup(env, expr.name);

      if (binding) {
        return binding.type;
      }

      return { tag: "unknown" };
    }

    case "unsupported":
      return { tag: "unknown" };
  }
}

function infer_binding_value_type(
  binding: Binding,
  hooks: InferHooks,
): FrontType | undefined {
  if (!binding.value || !binding.value_env) {
    return undefined;
  }

  return infer_front_expr(binding.value, binding.value_env, hooks);
}
