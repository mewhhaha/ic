import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import type { ExprLowerHooks, LowerExprFn } from "./expr_lower_types.ts";
import { format_expr } from "./format.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";
import { compiler_builtin_args } from "./compiler_builtin_args.ts";
import { expect } from "../expect.ts";
import { compiler_intrinsic_for_operator_target } from "./fixity.ts";

export function lower_app_expr(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const operator_intrinsic = compiler_intrinsic_for_operator_target(
    expr.operator_syntax?.target,
  );

  if (operator_intrinsic !== undefined) {
    return lower_app_expr(
      {
        ...expr,
        func: { tag: "var", name: operator_intrinsic },
        operator_syntax: undefined,
      },
      env,
      hooks,
      lower_expr,
    );
  }

  if (
    expr.func.tag === "var" &&
    (expr.func.name === "@cast" || expr.func.name === "@seal" ||
      expr.func.name === "@representation")
  ) {
    const cast_name = expr.func.name;
    const args = compiler_builtin_args(expr);
    expect(
      args.length === 2,
      cast_name + " expects 2 arguments, got " + args.length.toString(),
    );
    const value = args[0];
    expect(value, "Missing " + cast_name + " value argument");
    return lower_expr(value, env, hooks);
  }

  const const_value = hooks.try_eval_all_const_call(expr, env);

  if (const_value) {
    return lower_expr(const_value, env, hooks);
  }

  const rec = hooks.lower_static_rec_app(expr, env);

  if (rec) {
    return rec;
  }

  const union_value = hooks.resolve_union_constructor_call(expr, env);

  if (union_value) {
    return lower_expr(union_value.expr, union_value.env, hooks);
  }

  const method = hooks.lower_method_app(expr, env);

  if (method) {
    return method;
  }

  const visible_text = hooks.visible_text_value(expr, env, new Set());

  if (visible_text) {
    return lower_expr(visible_text, env, hooks);
  }

  const builtin = hooks.lower_builtin_call(expr, env);

  if (builtin) {
    return builtin;
  }

  const specialized = hooks.lower_specialized_app(expr, env);

  if (specialized) {
    return specialized;
  }

  const dynamic_function_if_args = hooks.check_dynamic_function_if_args(
    expr,
    env,
  );

  let result: IcNode;

  try {
    result = lower_expr(expr.func, env, hooks);
  } catch (err) {
    if (expr.func.tag === "field" && err instanceof Error) {
      const field_message = "Cannot lower field access to Ic frontend yet: " +
        expr.func.name;

      if (err.message.startsWith(field_message)) {
        throw new Error(
          "Cannot lower method call to Ic frontend yet: " +
            expr.func.name +
            structured_core_route,
        );
      }
    }

    throw err;
  }

  if (dynamic_function_if_args) {
    for (const arg of dynamic_function_if_args) {
      result = {
        tag: "app",
        func: result,
        arg: lower_expr_as_front_type(arg.value, arg.type, env, {
          infer_expr: hooks.infer_expr,
          lower_app_as_front_type: hooks.lower_app_as_front_type,
          lower_expr: (value, value_env) => lower_expr(value, value_env, hooks),
          resolve_annotation_type: hooks.resolve_annotation_type,
        }),
      };
    }

    return result;
  }

  for (const arg of expr.args) {
    result = { tag: "app", func: result, arg: lower_expr(arg, env, hooks) };
  }

  return result;
}

export function lower_field_expr(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: ExprLowerHooks,
  lower_expr: LowerExprFn,
): IcNode {
  const field = hooks.resolve_const_field_expr(expr, env);

  if (field) {
    return lower_expr(field, env, hooks);
  }

  const union_value = hooks.resolve_union_constructor_call({
    tag: "app",
    func: expr,
    args: [],
  }, env);

  if (union_value) {
    return lower_expr(union_value.expr, union_value.env, hooks);
  }

  const struct_field = hooks.resolve_struct_field_expr(expr, env);

  if (struct_field) {
    const declared = hooks.declared_struct_field_type(
      expr.object,
      expr.name,
      env,
    );
    return hooks.lower_expr_as_declared_type(
      struct_field.expr,
      struct_field.env,
      declared,
    );
  }

  const runtime_struct_field = hooks.lower_runtime_struct_field_access(
    expr,
    env,
  );

  if (runtime_struct_field) {
    return runtime_struct_field;
  }

  throw new Error(
    "Cannot lower field access to Ic frontend yet: " + expr.name +
      structured_core_route,
  );
}

export function lower_index_expr(
  expr: Extract<FrontExpr, { tag: "index" }>,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  const static_index = hooks.resolve_static_i32_expr(expr.index, env);

  if (static_index !== undefined) {
    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      const declared = hooks.declared_struct_index_type(
        expr.object,
        static_index,
        env,
      );
      return hooks.lower_expr_as_declared_type(
        item.expr,
        item.env,
        declared,
      );
    }

    const runtime_index = hooks.lower_runtime_struct_index_access(
      expr.object,
      static_index,
      env,
    );

    if (runtime_index) {
      return runtime_index;
    }

    const text_byte = hooks.lower_static_text_byte_index(
      expr.object,
      static_index,
      env,
    );

    if (text_byte) {
      return text_byte;
    }

    const runtime_text_byte = hooks.lower_runtime_text_byte_index(
      expr.object,
      expr.index,
      env,
    );

    if (runtime_text_byte) {
      return runtime_text_byte;
    }

    throw new Error(
      "Index access requires a compile-time collection value" +
        structured_core_route,
    );
  }

  const dynamic_index = hooks.lower_dynamic_index_access(
    expr.object,
    expr.index,
    env,
  );

  if (dynamic_index) {
    return dynamic_index;
  }

  const runtime_text_byte = hooks.lower_runtime_text_byte_index(
    expr.object,
    expr.index,
    env,
  );

  if (runtime_text_byte) {
    return runtime_text_byte;
  }

  throw new Error(
    "Cannot lower index access to Ic frontend yet: " +
      format_expr(expr.object) +
      structured_core_route,
  );
}
