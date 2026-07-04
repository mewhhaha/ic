import type { Env, Field, FrontExpr, FrontType, Param, Stmt } from "../ast.ts";
import { capture_expr } from "../capture.ts";
import {
  resolve_dynamic_function_if_target,
  type CallTargetHooks,
} from "../call_target.ts";
import { structured_core_route } from "../diagnostic.ts";
import { clone_env, lookup, push_binding } from "../env.ts";
import {
  function_if_param_types,
  resolve_direct_lambda,
} from "../function_if.ts";
import { implicit_fallback_expr } from "../implicit_fallback.ts";
import { substitute_front_expr } from "../substitute.ts";
import {
  common_front_type,
  front_type_from_type_name,
  type_name_from_front_type,
} from "../types.ts";
import type { DynamicLoopState } from "./dynamic_control.ts";
import type { StaticLoopHooks } from "./types.ts";

export function dynamic_loop_control_value_with_implicit_fallback(
  value: FrontExpr,
  type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr {
  if (value.tag === "if" && value.implicit_else) {
    const fallback = implicit_fallback_expr(type, env, hooks);

    if (fallback) {
      return {
        ...value,
        else_branch: fallback,
        implicit_else: undefined,
      };
    }
  }

  if (value.tag === "if_let" && value.implicit_else) {
    const fallback = implicit_fallback_expr(type, env, hooks);

    if (fallback) {
      return {
        ...value,
        else_branch: fallback,
        implicit_else: undefined,
      };
    }
  }

  return value;
}

export function dynamic_loop_control_guarded_binding_value(
  name: string,
  type: FrontType,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): FrontExpr | undefined {
  if (type.tag === "union_value") {
    const fallback = dynamic_loop_control_union_type_fallback(
      name,
      type,
      env,
      hooks,
    );

    if (!fallback) {
      return undefined;
    }

    const value_env = dynamic_loop_control_typed_value_env(value, type, env);

    if (!value_env) {
      return undefined;
    }

    return {
      tag: "if",
      cond: { tag: "var", name: state.step_name },
      then_branch: capture_expr(value, value_env),
      else_branch: fallback,
    };
  }

  if (type.tag === "struct" && type.field_types) {
    return dynamic_loop_control_guarded_struct_value(
      name,
      type,
      value,
      env,
      hooks,
      state,
    );
  }

  return undefined;
}

export function dynamic_loop_control_binding_type(
  stmt: Extract<Stmt, { tag: "bind" }>,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType {
  const inferred = hooks.infer_expr(stmt.value, env);

  if (!stmt.annotation) {
    const cases = hooks.infer_union_cases(stmt.value, env);

    if (cases) {
      return { tag: "union_value", cases };
    }

    if (inferred.tag === "unknown") {
      const function_type = dynamic_loop_control_function_type(
        stmt.value,
        env,
        hooks,
      );

      if (function_type) {
        return function_type;
      }

      const app_type = dynamic_loop_control_app_result_type(
        stmt.value,
        env,
        hooks,
      );

      if (app_type) {
        return app_type;
      }
    }

    return inferred;
  }

  const annotated = hooks.resolve_annotation_type(stmt.annotation, env);

  if (!annotated) {
    return inferred;
  }

  return annotated;
}

function dynamic_loop_control_function_type(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontType, { tag: "fn" }> | undefined {
  const target = resolve_direct_lambda(value, env);

  if (target) {
    return { tag: "fn", params: target.expr.params };
  }

  const branch = dynamic_loop_control_function_if_value(value, env, hooks);

  if (!branch) {
    const if_let_branch = dynamic_loop_control_function_if_let_value(
      value,
      env,
      hooks,
    );

    if (!if_let_branch) {
      return undefined;
    }

    return { tag: "fn", params: if_let_branch.params };
  }

  return { tag: "fn", params: branch.params };
}

export function dynamic_loop_control_binding_fallback(
  name: string,
  type: FrontType,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr {
  if (type.tag !== "int") {
    if (type.tag === "fn") {
      const fallback = dynamic_loop_control_function_fallback(
        value,
        env,
        hooks,
      );

      if (fallback) {
        return fallback;
      }
    }

    if (type.tag === "text") {
      return { tag: "text", value: "" };
    }

    if (type.tag === "struct") {
      const target = hooks.resolve_struct_value(value, env);

      if (target) {
        return dynamic_loop_control_struct_fallback(
          name,
          target,
          hooks,
        );
      }

      const fallback = dynamic_loop_control_struct_type_fallback(
        name,
        type,
        env,
        hooks,
      );

      if (fallback) {
        return fallback;
      }
    }

    if (type.tag === "union_value" || type.tag === "union") {
      const target = hooks.resolve_union_value(value, env);

      if (target) {
        return dynamic_loop_control_union_fallback(
          name,
          target,
          hooks,
        );
      }

      if (type.tag === "union_value") {
        const fallback = dynamic_loop_control_union_type_fallback(
          name,
          type,
          env,
          hooks,
        );

        if (fallback) {
          return fallback;
        }
      }
    }

    if (type.tag === "unknown") {
      const resolved = dynamic_loop_control_unknown_fallback(
        name,
        value,
        env,
        hooks,
      );

      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      "Cannot lower local binding after dynamic loop control yet: " + name +
        structured_core_route,
    );
  }

  if (type.type === "i64") {
    return { tag: "num", type: "i64", value: 0n };
  }

  if (type.type === "i32") {
    return { tag: "num", type: "i32", value: 0 };
  }

  throw new Error(
    "Cannot lower local binding after dynamic loop control yet: " + name +
      structured_core_route,
  );
}

function dynamic_loop_control_unknown_fallback(
  name: string,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  if (value.tag === "num") {
    if (value.type === "i64") {
      return { tag: "num", type: "i64", value: 0n };
    }

    return { tag: "num", type: "i32", value: 0 };
  }

  const static_i32 = hooks.resolve_static_i32_expr(value, env);

  if (static_i32 !== undefined) {
    return { tag: "num", type: "i32", value: 0 };
  }

  const text_bytes = hooks.resolve_text_bytes(value, env);

  if (text_bytes) {
    return { tag: "text", value: "" };
  }

  const target = hooks.resolve_struct_value(value, env);

  if (target) {
    return dynamic_loop_control_struct_fallback(name, target, hooks);
  }

  const union_target = hooks.resolve_union_value(value, env);

  if (union_target) {
    return dynamic_loop_control_union_fallback(name, union_target, hooks);
  }

  const app_type = dynamic_loop_control_app_result_type(value, env, hooks);

  if (app_type) {
    const app_value = dynamic_loop_control_inline_app_expr(value, env, hooks);

    if (app_value) {
      return dynamic_loop_control_binding_fallback(
        name,
        app_type,
        app_value.expr,
        app_value.env,
        hooks,
      );
    }
  }

  return undefined;
}

function dynamic_loop_control_app_result_type(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType | undefined {
  const lambda_type = dynamic_loop_control_lambda_app_result_type(
    value,
    env,
    hooks,
  );

  if (lambda_type) {
    return lambda_type;
  }

  const inlined = dynamic_loop_control_inline_app_expr(value, env, hooks);

  if (!inlined) {
    return undefined;
  }

  const type = hooks.infer_expr(inlined.expr, inlined.env);

  if (type.tag === "unknown") {
    return undefined;
  }

  return type;
}

function dynamic_loop_control_lambda_app_result_type(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  const target = resolve_direct_lambda(value.func, env);

  if (target) {
    return dynamic_loop_control_single_lambda_app_result_type(
      target.expr,
      target.env,
      value.args,
      env,
      hooks,
    );
  }

  const dynamic_target = resolve_dynamic_function_if_target(
    value.func,
    env,
    dynamic_loop_control_call_target_hooks(hooks),
  );

  if (!dynamic_target) {
    return undefined;
  }

  const then_target = resolve_direct_lambda(
    dynamic_target.expr.then_branch,
    dynamic_target.env,
  );
  const else_target = resolve_direct_lambda(
    dynamic_target.expr.else_branch,
    dynamic_target.env,
  );

  if (!then_target || !else_target) {
    return undefined;
  }

  const then_type = dynamic_loop_control_single_lambda_app_result_type(
    then_target.expr,
    then_target.env,
    value.args,
    env,
    hooks,
  );
  const else_type = dynamic_loop_control_single_lambda_app_result_type(
    else_target.expr,
    else_target.env,
    value.args,
    env,
    hooks,
  );

  if (!then_type || !else_type) {
    return undefined;
  }

  return common_front_type(then_type, else_type);
}

function dynamic_loop_control_single_lambda_app_result_type(
  lambda: Extract<FrontExpr, { tag: "lam" }>,
  lambda_env: Env,
  args: FrontExpr[],
  arg_env: Env,
  hooks: StaticLoopHooks,
): FrontType | undefined {
  if (args.length !== lambda.params.length) {
    return undefined;
  }

  const call_env = clone_env(lambda_env);

  for (let index = 0; index < lambda.params.length; index += 1) {
    const param = lambda.params[index];
    const arg = args[index];

    if (!param || !arg) {
      return undefined;
    }

    if (param.is_const || param.is_linear) {
      return undefined;
    }

    const param_type = dynamic_loop_control_param_type(
      param.annotation,
      arg,
      arg_env,
      hooks,
    );

    push_binding(call_env, {
      name: param.name,
      ic_name: param.name,
      type: param_type,
      is_const: false,
      is_linear: false,
      value: capture_expr(arg, arg_env),
      value_env: call_env,
    });
  }

  const result_type = hooks.infer_expr(lambda.body, call_env);

  if (result_type.tag === "unknown") {
    return undefined;
  }

  return result_type;
}

function dynamic_loop_control_param_type(
  annotation: string | undefined,
  arg: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType {
  if (annotation) {
    const resolved = hooks.resolve_annotation_type(annotation, env);

    if (resolved) {
      return resolved;
    }

    const builtin = front_type_from_type_name(annotation);

    if (builtin.tag !== "unknown") {
      return builtin;
    }
  }

  return hooks.infer_expr(arg, env);
}

function dynamic_loop_control_inline_app_expr(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): { expr: FrontExpr; env: Env } | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  const target = resolve_direct_lambda(value.func, env);

  if (target) {
    return dynamic_loop_control_inline_lambda_app(
      target.expr,
      target.env,
      value.args,
      env,
    );
  }

  const dynamic_target = resolve_dynamic_function_if_target(
    value.func,
    env,
    dynamic_loop_control_call_target_hooks(hooks),
  );

  if (!dynamic_target) {
    return undefined;
  }

  const then_target = resolve_direct_lambda(
    dynamic_target.expr.then_branch,
    dynamic_target.env,
  );
  const else_target = resolve_direct_lambda(
    dynamic_target.expr.else_branch,
    dynamic_target.env,
  );

  if (!then_target || !else_target) {
    return undefined;
  }

  const then_body = dynamic_loop_control_inline_lambda_app(
    then_target.expr,
    then_target.env,
    value.args,
    env,
  );
  const else_body = dynamic_loop_control_inline_lambda_app(
    else_target.expr,
    else_target.env,
    value.args,
    env,
  );

  if (!then_body || !else_body) {
    return undefined;
  }

  return {
    expr: {
      tag: "if",
      cond: capture_expr(dynamic_target.expr.cond, dynamic_target.env),
      then_branch: capture_expr(then_body.expr, then_body.env),
      else_branch: capture_expr(else_body.expr, else_body.env),
    },
    env,
  };
}

function dynamic_loop_control_inline_lambda_app(
  lambda: Extract<FrontExpr, { tag: "lam" }>,
  lambda_env: Env,
  args: FrontExpr[],
  arg_env: Env,
): { expr: FrontExpr; env: Env } | undefined {
  if (args.length !== lambda.params.length) {
    return undefined;
  }

  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < lambda.params.length; index += 1) {
    const param = lambda.params[index];
    const arg = args[index];

    if (!param || !arg) {
      return undefined;
    }

    if (param.is_const || param.is_linear) {
      return undefined;
    }

    replacements.set(param.name, capture_expr(arg, arg_env));
  }

  return {
    expr: substitute_front_expr(lambda.body, replacements),
    env: lambda_env,
  };
}

function dynamic_loop_control_call_target_hooks(
  hooks: StaticLoopHooks,
): CallTargetHooks {
  return {
    resolve_const_call_target: () => undefined,
    resolve_static_if_branch: (expr, env) => {
      const cond = hooks.resolve_static_i32_expr(expr.cond, env);

      if (cond === undefined) {
        return undefined;
      }

      if (cond !== 0) {
        return expr.then_branch;
      }

      return expr.else_branch;
    },
  };
}

function dynamic_loop_control_function_fallback(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  const target = resolve_direct_lambda(value, env);

  if (target) {
    return capture_expr(target.expr, target.env);
  }

  const branch = dynamic_loop_control_function_if_value(value, env, hooks);

  if (branch) {
    return branch;
  }

  return dynamic_loop_control_function_if_let_value(value, env, hooks);
}

export function dynamic_loop_control_function_value(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr {
  const target = resolve_direct_lambda(value, env);

  if (target) {
    return capture_expr(target.expr, target.env);
  }

  const branch = dynamic_loop_control_function_if_value(value, env, hooks);

  if (branch) {
    return branch;
  }

  const if_let_branch = dynamic_loop_control_function_if_let_value(
    value,
    env,
    hooks,
  );

  if (if_let_branch) {
    return if_let_branch;
  }

  return value;
}

function dynamic_loop_control_function_if_value(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  if (value.tag !== "if") {
    return undefined;
  }

  const then_target = resolve_direct_lambda(value.then_branch, env);
  const else_target = resolve_direct_lambda(value.else_branch, env);

  if (!then_target || !else_target) {
    return undefined;
  }

  const param_types = function_if_param_types(
    then_target.expr.params,
    then_target.env,
    else_target.expr.params,
    else_target.env,
    hooks,
  );

  if (!param_types) {
    return undefined;
  }

  const params: Param[] = [];
  const then_replacements = new Map<string, FrontExpr>();
  const else_replacements = new Map<string, FrontExpr>();
  const param_names = new Set<string>();

  for (let index = 0; index < then_target.expr.params.length; index += 1) {
    const then_param = then_target.expr.params[index];
    const else_param = else_target.expr.params[index];
    const param_type = param_types[index];

    if (!then_param || !else_param || !param_type) {
      return undefined;
    }

    if (then_param.is_linear || else_param.is_linear) {
      return undefined;
    }

    const name = then_param.name;
    param_names.add(name);
    let annotation = then_param.annotation;

    if (!annotation) {
      annotation = else_param.annotation;
    }

    if (!annotation) {
      annotation = type_name_from_front_type(param_type);
    }

    params.push({
      ...then_param,
      name,
      annotation,
    });
    then_replacements.set(then_param.name, { tag: "var", name });
    else_replacements.set(else_param.name, { tag: "var", name });
  }

  const then_capture_replacements = dynamic_loop_control_capture_replacements(
    then_target.env,
    env,
    param_names,
  );
  const else_capture_replacements = dynamic_loop_control_capture_replacements(
    else_target.env,
    env,
    param_names,
  );

  if (!then_capture_replacements || !else_capture_replacements) {
    return undefined;
  }

  for (const [name, replacement] of then_capture_replacements) {
    then_replacements.set(name, replacement);
  }

  for (const [name, replacement] of else_capture_replacements) {
    else_replacements.set(name, replacement);
  }

  return {
    tag: "lam",
    params,
    body: {
      tag: "if",
      cond: value.cond,
      then_branch: substitute_front_expr(
        then_target.expr.body,
        then_replacements,
      ),
      else_branch: substitute_front_expr(
        else_target.expr.body,
        else_replacements,
      ),
    },
  };
}

function dynamic_loop_control_function_if_let_value(
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "lam" }> | undefined {
  if (value.tag !== "if_let") {
    return undefined;
  }

  if (value.implicit_else) {
    return undefined;
  }

  const then_target = resolve_direct_lambda(value.then_branch, env);
  const else_target = resolve_direct_lambda(value.else_branch, env);

  if (!then_target || !else_target) {
    return undefined;
  }

  const param_types = function_if_param_types(
    then_target.expr.params,
    then_target.env,
    else_target.expr.params,
    else_target.env,
    hooks,
  );

  if (!param_types) {
    return undefined;
  }

  const selected = dynamic_loop_control_selected_function_parts(
    then_target.expr,
    then_target.env,
    else_target.expr,
    else_target.env,
    env,
    param_types,
    hooks,
    value.value_name,
  );

  if (!selected) {
    return undefined;
  }

  return {
    tag: "lam",
    params: selected.params,
    body: {
      tag: "if_let",
      case_name: value.case_name,
      value_name: value.value_name,
      target: value.target,
      then_branch: substitute_front_expr(
        then_target.expr.body,
        selected.then_replacements,
      ),
      else_branch: substitute_front_expr(
        else_target.expr.body,
        selected.else_replacements,
      ),
      implicit_else: value.implicit_else,
    },
  };
}

function dynamic_loop_control_selected_function_parts(
  then_expr: Extract<FrontExpr, { tag: "lam" }>,
  then_env: Env,
  else_expr: Extract<FrontExpr, { tag: "lam" }>,
  else_env: Env,
  base_env: Env,
  param_types: FrontType[],
  hooks: StaticLoopHooks,
  protected_name: string | undefined,
):
  | {
    params: Param[];
    then_replacements: Map<string, FrontExpr>;
    else_replacements: Map<string, FrontExpr>;
  }
  | undefined {
  const params: Param[] = [];
  const then_replacements = new Map<string, FrontExpr>();
  const else_replacements = new Map<string, FrontExpr>();
  const protected_names = new Set<string>();

  if (protected_name) {
    protected_names.add(protected_name);
  }

  for (let index = 0; index < then_expr.params.length; index += 1) {
    const then_param = then_expr.params[index];
    const else_param = else_expr.params[index];
    const param_type = param_types[index];

    if (!then_param || !else_param || !param_type) {
      return undefined;
    }

    if (then_param.is_linear || else_param.is_linear) {
      return undefined;
    }

    const name = then_param.name;
    protected_names.add(name);
    let annotation = then_param.annotation;

    if (!annotation) {
      annotation = else_param.annotation;
    }

    if (!annotation) {
      annotation = type_name_from_front_type(param_type);
    }

    params.push({
      ...then_param,
      name,
      annotation,
    });
    then_replacements.set(then_param.name, { tag: "var", name });
    else_replacements.set(else_param.name, { tag: "var", name });
  }

  const then_capture_replacements = dynamic_loop_control_capture_replacements(
    then_env,
    base_env,
    protected_names,
  );
  const else_capture_replacements = dynamic_loop_control_capture_replacements(
    else_env,
    base_env,
    protected_names,
  );

  if (!then_capture_replacements || !else_capture_replacements) {
    return undefined;
  }

  for (const [name, replacement] of then_capture_replacements) {
    then_replacements.set(name, replacement);
  }

  for (const [name, replacement] of else_capture_replacements) {
    else_replacements.set(name, replacement);
  }

  return {
    params,
    then_replacements,
    else_replacements,
  };
}

function dynamic_loop_control_capture_replacements(
  source: Env,
  base: Env,
  protected_names: Set<string>,
): Map<string, FrontExpr> | undefined {
  const replacements = new Map<string, FrontExpr>();

  for (const scope of source.scopes) {
    for (const [name, binding] of scope) {
      if (protected_names.has(name)) {
        continue;
      }

      const base_binding = lookup(base, name);

      if (base_binding === binding) {
        continue;
      }

      if (binding.is_linear) {
        return undefined;
      }

      if (!binding.value) {
        return undefined;
      }

      let value_env = source;

      if (binding.value_env) {
        value_env = binding.value_env;
      }

      replacements.set(name, capture_expr(binding.value, value_env));
    }
  }

  return replacements;
}

function dynamic_loop_control_struct_fallback(
  name: string,
  target: {
    expr: Extract<FrontExpr, { tag: "struct_value" }>;
    env: Env;
  },
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "struct_value" }> {
  const fields: Field[] = [];

  for (const field of target.expr.fields) {
    const field_type = dynamic_loop_control_struct_field_type(
      field,
      target,
      hooks,
    );
    fields.push({
      name: field.name,
      value: dynamic_loop_control_binding_fallback(
        name + "." + field.name,
        field_type,
        field.value,
        target.env,
        hooks,
      ),
    });
  }

  return {
    tag: "struct_value",
    type_expr: capture_expr(target.expr.type_expr, target.env),
    fields,
  };
}

function dynamic_loop_control_struct_field_type(
  field: Field,
  target: {
    expr: Extract<FrontExpr, { tag: "struct_value" }>;
    env: Env;
  },
  hooks: StaticLoopHooks,
): FrontType {
  const declared = dynamic_loop_control_struct_declared_field_type(
    field.name,
    target,
    hooks,
  );

  if (declared) {
    return declared;
  }

  return hooks.infer_expr(field.value, target.env);
}

function dynamic_loop_control_struct_declared_field_type(
  name: string,
  target: {
    expr: Extract<FrontExpr, { tag: "struct_value" }>;
    env: Env;
  },
  hooks: StaticLoopHooks,
): FrontType | undefined {
  return dynamic_loop_control_struct_declared_field_type_expr(
    name,
    target.expr.type_expr,
    target.env,
    hooks,
  );
}

function dynamic_loop_control_struct_declared_field_type_expr(
  name: string,
  type_expr: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType | undefined {
  if (type_expr.tag === "captured") {
    return dynamic_loop_control_struct_declared_field_type_expr(
      name,
      type_expr.expr,
      type_expr.env,
      hooks,
    );
  }

  let fields: { name: string; type_name: string }[] | undefined;

  if (type_expr.tag === "struct_type") {
    fields = type_expr.fields;
  }

  if (type_expr.tag === "var") {
    const type = hooks.resolve_annotation_type(
      type_expr.name,
      env,
    );

    if (type && type.tag === "struct") {
      fields = type.field_types;
    }
  }

  if (!fields) {
    return undefined;
  }

  for (const field of fields) {
    if (field.name !== name) {
      continue;
    }

    const resolved = hooks.resolve_annotation_type(
      field.type_name,
      env,
    );

    if (resolved) {
      return resolved;
    }

    return front_type_from_type_name(field.type_name);
  }

  return undefined;
}

function dynamic_loop_control_union_fallback(
  name: string,
  target: {
    expr: Extract<FrontExpr, { tag: "union_case" }>;
    env: Env;
  },
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "union_case" }> {
  let value: FrontExpr | undefined;

  if (target.expr.value) {
    const payload_type = hooks.infer_expr(target.expr.value, target.env);
    value = dynamic_loop_control_binding_fallback(
      name + "." + target.expr.name,
      payload_type,
      target.expr.value,
      target.env,
      hooks,
    );
  }

  return {
    tag: "union_case",
    name: target.expr.name,
    value,
    type_expr: target.expr.type_expr
      ? capture_expr(target.expr.type_expr, target.env)
      : undefined,
  };
}

function dynamic_loop_control_guarded_struct_value(
  name: string,
  type: Extract<FrontType, { tag: "struct" }>,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): Extract<FrontExpr, { tag: "struct_value" }> | undefined {
  if (!type.field_types) {
    return undefined;
  }

  const value_env = dynamic_loop_control_typed_value_env(value, type, env);

  if (!value_env) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const field of type.field_types) {
    const field_value: FrontExpr = {
      tag: "field",
      object: value,
      name: field.name,
    };
    const guarded = dynamic_loop_control_guarded_type_name_value(
      name + "." + field.name,
      field.type_name,
      field_value,
      value_env,
      hooks,
      state,
    );

    if (!guarded) {
      return undefined;
    }

    fields.push({ name: field.name, value: guarded });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "struct_type", fields: type.field_types },
    fields,
  };
}

function dynamic_loop_control_guarded_type_name_value(
  name: string,
  type_name: string,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): FrontExpr | undefined {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return dynamic_loop_control_guarded_type_value(
      name,
      resolved,
      value,
      env,
      hooks,
      state,
    );
  }

  return dynamic_loop_control_guarded_type_value(
    name,
    front_type_from_type_name(type_name),
    value,
    env,
    hooks,
    state,
  );
}

function dynamic_loop_control_guarded_type_value(
  name: string,
  type: FrontType,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): FrontExpr | undefined {
  if (type.tag === "struct") {
    return dynamic_loop_control_guarded_struct_value(
      name,
      type,
      value,
      env,
      hooks,
      state,
    );
  }

  const fallback = dynamic_loop_control_type_fallback(
    name,
    type,
    env,
    hooks,
  );

  if (!fallback) {
    return undefined;
  }

  return {
    tag: "if",
    cond: { tag: "var", name: state.step_name },
    then_branch: capture_expr(value, env),
    else_branch: fallback,
  };
}

function dynamic_loop_control_typed_value_env(
  value: FrontExpr,
  type: FrontType,
  env: Env,
): Env | undefined {
  if (value.tag === "captured") {
    return dynamic_loop_control_typed_value_env(value.expr, type, value.env);
  }

  if (value.tag === "field") {
    return env;
  }

  if (value.tag !== "var") {
    return undefined;
  }

  const local = clone_env(env);
  const existing = lookup(env, value.name);
  let ic_name = value.name;

  if (existing) {
    ic_name = existing.ic_name;
  }

  push_binding(local, {
    name: value.name,
    ic_name,
    type,
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });
  return local;
}

function dynamic_loop_control_struct_type_fallback(
  name: string,
  type: Extract<FrontType, { tag: "struct" }>,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "struct_value" }> | undefined {
  if (!type.field_types) {
    return undefined;
  }

  const fields: Field[] = [];

  for (const field of type.field_types) {
    const value = dynamic_loop_control_type_name_fallback(
      name + "." + field.name,
      field.type_name,
      env,
      hooks,
    );

    if (!value) {
      return undefined;
    }

    fields.push({ name: field.name, value });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "struct_type", fields: type.field_types },
    fields,
  };
}

function dynamic_loop_control_union_type_fallback(
  name: string,
  type: Extract<FrontType, { tag: "union_value" }>,
  env: Env,
  hooks: StaticLoopHooks,
): Extract<FrontExpr, { tag: "union_case" }> | undefined {
  for (const union_case of type.cases) {
    if (union_case.type_name === "Unit") {
      return {
        tag: "union_case",
        name: union_case.name,
        value: undefined,
        type_expr: { tag: "union_type", cases: type.cases },
      };
    }

    const value = dynamic_loop_control_type_name_fallback(
      name + "." + union_case.name,
      union_case.type_name,
      env,
      hooks,
    );

    if (value) {
      return {
        tag: "union_case",
        name: union_case.name,
        value,
        type_expr: { tag: "union_type", cases: type.cases },
      };
    }
  }

  return undefined;
}

function dynamic_loop_control_type_name_fallback(
  name: string,
  type_name: string,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return dynamic_loop_control_type_fallback(name, resolved, env, hooks);
  }

  return dynamic_loop_control_type_fallback(
    name,
    front_type_from_type_name(type_name),
    env,
    hooks,
  );
}

function dynamic_loop_control_type_fallback(
  name: string,
  type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  if (type.tag === "int") {
    if (type.type === "i64") {
      return { tag: "num", type: "i64", value: 0n };
    }

    if (type.type === "i32") {
      return { tag: "num", type: "i32", value: 0 };
    }

    return undefined;
  }

  if (type.tag === "text") {
    return { tag: "text", value: "" };
  }

  if (type.tag === "struct") {
    return dynamic_loop_control_struct_type_fallback(name, type, env, hooks);
  }

  if (type.tag === "union_value") {
    return dynamic_loop_control_union_type_fallback(name, type, env, hooks);
  }

  return undefined;
}
