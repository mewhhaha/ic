import type { Binding, Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { assignment_type } from "../annotations.ts";
import { clone_env, lookup, push_binding } from "../env.ts";
import { lookup_type_field } from "../fields.ts";
import {
  indexed_result_type_from_fields,
  indexed_type_fields_are_text,
} from "../runtime_struct.ts";
import { front_expr_is_static_shareable_text } from "../ownership.ts";
import { common_if_type, front_type_for_type_name } from "./common.ts";
import { infer_builtin_call_type, infer_prim_result_type } from "./prim.ts";
import {
  infer_runtime_struct_field_type,
  runtime_struct_index_type,
} from "./runtime_struct.ts";
import { infer_stmt_result_with } from "./stmt.ts";
import type { InferHooks } from "./types.ts";

export function infer_front_expr(
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
): FrontType {
  switch (expr.tag) {
    case "num":
      return { tag: "int", type: expr.type };

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

    case "app": {
      if (hooks.visible_text_value(expr, env, new Set())) {
        return { tag: "text" };
      }

      const union_value = hooks.resolve_union_constructor_call(expr, env);

      if (union_value && union_value.expr.type_expr) {
        const union_type = hooks.resolve_union_type_value(
          union_value.expr.type_expr,
          union_value.env,
        );

        if (union_type) {
          return { tag: "union_value", cases: union_type.cases };
        }
      }

      const union_call = hooks.infer_call_union_result_type(expr, env);

      if (union_call) {
        return union_call;
      }

      const rec_call = hooks.infer_static_rec_app_type(expr, env);

      if (rec_call) {
        return rec_call;
      }

      const specialized_call = hooks.infer_specialized_app_type(expr, env);

      if (specialized_call) {
        return specialized_call;
      }

      const builtin_call = infer_builtin_call_type(expr, env);

      if (builtin_call) {
        return builtin_call;
      }

      return { tag: "unknown" };
    }

    case "block":
      return infer_block_type(expr.statements, env, hooks);

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

    case "if": {
      const then_type = infer_front_expr(expr.then_branch, env, hooks);
      const else_type = infer_front_expr(expr.else_branch, env, hooks);
      const result_type = common_if_type(
        expr.implicit_else,
        then_type,
        else_type,
      );

      if (result_type) {
        if (result_type.tag === "union") {
          const union_cases = hooks.infer_dynamic_union_if_cases(expr, env);

          if (union_cases) {
            return { tag: "union_value", cases: union_cases };
          }
        }

        return result_type;
      }

      const union_cases = hooks.infer_dynamic_union_if_cases(expr, env);

      if (union_cases) {
        return { tag: "union_value", cases: union_cases };
      }

      return { tag: "unknown" };
    }

    case "if_let": {
      const target_type = infer_front_expr(expr.target, env, hooks);
      const then_env = infer_if_let_then_env(expr, target_type, env, hooks);
      const then_type = infer_front_expr(expr.then_branch, then_env, hooks);
      const else_type = infer_front_expr(expr.else_branch, env, hooks);
      const result_type = common_if_type(
        expr.implicit_else,
        then_type,
        else_type,
      );

      if (result_type) {
        return result_type;
      }

      const union_cases = hooks.infer_union_cases(expr, env);

      if (union_cases) {
        return { tag: "union_value", cases: union_cases };
      }

      return { tag: "unknown" };
    }

    case "field": {
      const field = hooks.resolve_struct_field_expr(expr, env);

      if (field) {
        const field_type = infer_front_expr(field.expr, field.env, hooks);

        if (field_type.tag !== "unknown") {
          return field_type;
        }
      }

      const runtime_field_type = infer_runtime_struct_field_type(
        expr,
        env,
        hooks,
      );

      if (runtime_field_type) {
        return runtime_field_type;
      }

      return { tag: "unknown" };
    }

    case "index": {
      const static_index = hooks.resolve_static_i32_expr(expr.index, env);

      if (static_index !== undefined) {
        const item = hooks.resolve_index_expr(expr, env);

        if (item) {
          const item_type = infer_front_expr(item.expr, item.env, hooks);

          if (item_type.tag !== "unknown") {
            return item_type;
          }

          const runtime_target = hooks.resolve_runtime_struct_type(
            expr.object,
            env,
          );

          if (runtime_target) {
            return runtime_struct_index_type(
              runtime_target.fields,
              static_index,
              env,
              hooks,
            );
          }

          return item_type;
        }
      }

      const runtime_target = hooks.resolve_runtime_struct_type(
        expr.object,
        env,
      );

      if (runtime_target) {
        if (static_index !== undefined) {
          return runtime_struct_index_type(
            runtime_target.fields,
            static_index,
            env,
            hooks,
          );
        }

        if (indexed_type_fields_are_text(runtime_target.fields)) {
          return { tag: "text" };
        }

        return {
          tag: "int",
          type: indexed_result_type_from_fields(runtime_target.fields),
        };
      }

      const text = hooks.visible_text_value(expr.object, env, new Set());

      if (text) {
        return { tag: "int", type: "i32" };
      }

      const object_type = infer_front_expr(expr.object, env, hooks);

      if (object_type.tag === "text") {
        return { tag: "int", type: "i32" };
      }

      return { tag: "unknown" };
    }

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

function infer_if_let_then_env(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target_type: FrontType,
  env: Env,
  hooks: InferHooks,
): Env {
  if (target_type.tag !== "union_value") {
    return env;
  }

  if (!expr.value_name) {
    return env;
  }

  const matched = lookup_type_field(target_type.cases, expr.case_name);

  if (!matched) {
    return env;
  }

  if (matched.type_name === "Unit") {
    return env;
  }

  const branch_env = clone_env(env);
  push_binding(branch_env, {
    name: expr.value_name,
    ic_name: expr.value_name,
    type: front_type_for_type_name(matched.type_name, branch_env, hooks),
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });
  return branch_env;
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

function infer_block_type(
  statements: Stmt[],
  env: Env,
  hooks: InferHooks,
): FrontType {
  if (statements.length === 0) {
    return { tag: "unknown" };
  }

  const local = clone_env(env);
  let result: FrontType = { tag: "unknown" };

  for (const stmt of statements) {
    result = infer_stmt_result_with(stmt, local, hooks, infer_front_expr);
    record_inferred_statement(stmt, result, local, hooks);

    if (stmt.tag === "return") {
      return result;
    }
  }

  return result;
}

function record_inferred_statement(
  stmt: Stmt,
  value_type: FrontType,
  env: Env,
  hooks: InferHooks,
): void {
  if (stmt.tag === "bind") {
    let type = value_type;

    if (stmt.annotation) {
      const annotation_type = hooks.resolve_annotation_type(
        stmt.annotation,
        env,
      );

      if (annotation_type) {
        type = annotation_type;
      }
    }

    push_inferred_binding(
      stmt.name,
      type,
      stmt.kind === "const",
      stmt.is_linear,
      stmt.value,
      env,
    );
    return;
  }

  if (stmt.tag === "assign") {
    const previous = lookup(env, stmt.name);

    if (!previous) {
      return;
    }

    push_inferred_binding(
      stmt.name,
      assignment_type(previous.type, value_type, stmt.mode),
      previous.is_const,
      previous.is_linear,
      stmt.value,
      env,
    );
    return;
  }

  if (stmt.tag === "index_assign") {
    const previous = lookup(env, stmt.name);

    if (!previous) {
      return;
    }

    push_inferred_binding(
      stmt.name,
      previous.type,
      previous.is_const,
      previous.is_linear,
      undefined,
      env,
    );
  }
}

function push_inferred_binding(
  name: string,
  type: FrontType,
  is_const: boolean,
  is_linear: boolean,
  value: FrontExpr | undefined,
  env: Env,
): void {
  push_binding(env, {
    name,
    ic_name: name,
    type,
    is_const,
    is_linear,
    value,
    value_env: clone_env(env),
  });
}
