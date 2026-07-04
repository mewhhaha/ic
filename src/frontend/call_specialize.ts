import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, Stmt } from "./ast.ts";
import {
  inline_runtime_call_expr as inline_runtime_call_expr_with_hooks,
} from "./call_inline.ts";
import { is_deferred_frontend_value } from "./call_deferred.ts";
import {
  push_const_specialized_arg,
  push_runtime_specialized_arg,
  type RuntimeSpecializedArg,
} from "./call_args.ts";
import { resolve_call_target_with_env } from "./call_resolve.ts";
import { resolve_dynamic_function_if_target } from "./call_resolve.ts";
import { should_specialize_app } from "./call_specialize_decision.ts";
import type { CallSpecializeHooks } from "./call_specialize_types.ts";
import { structured_core_route } from "./diagnostic.ts";
import { clone_env } from "./env.ts";
import { lookup_field } from "./fields.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { linear_param_names, validate_linear_lam } from "./linear.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type { CallSpecializeHooks } from "./call_specialize_types.ts";
export { check_dynamic_function_if_args } from "./call_dynamic_args.ts";
export {
  inline_deferred_const_call,
  inline_runtime_call_expr,
  inline_specialized_call_expr,
} from "./call_inline.ts";
export {
  resolve_call_target,
  resolve_call_target_with_env,
} from "./call_resolve.ts";
export {
  requires_specialized_call,
  should_specialize_app,
} from "./call_specialize_decision.ts";
export { infer_call_union_result_type } from "./call_union_result.ts";
export {
  is_deferred_frontend_value,
  resolve_deferred_frontend_value,
  resolve_deferred_text_value,
} from "./call_deferred.ts";
export {
  can_eval_const_call,
  eval_const_call,
  resolve_const_call_target,
  try_eval_all_const_call,
} from "./call_const.ts";

export function lower_specialized_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): IcNode | undefined {
  const target = resolve_call_target_with_env(expr.func, env, hooks);

  if (!target) {
    return lower_deferred_dynamic_function_if_app(expr, env, hooks);
  }

  if (!should_specialize_app(target.expr, expr.args, env, hooks)) {
    const dynamic = lower_deferred_dynamic_function_if_app(expr, env, hooks);

    if (dynamic) {
      return dynamic;
    }

    return undefined;
  }

  if (expr.args.length !== target.expr.params.length) {
    throw new Error(
      "Specialized call expected " +
        target.expr.params.length.toString() +
        " arguments, got " +
        expr.args.length.toString(),
    );
  }

  const linear_names = linear_param_names(target.expr);

  if (linear_names.size > 0) {
    validate_linear_lam(target.expr);
  }

  const call_env = clone_env(target.env);
  const runtime_args: RuntimeSpecializedArg[] = [];
  const runtime_names: string[] = [];

  for (let index = 0; index < target.expr.params.length; index += 1) {
    const param = target.expr.params[index];
    expect(param, "Missing parameter " + index);
    const arg = expr.args[index];
    expect(arg, "Missing argument " + index);

    if (param.is_const) {
      push_const_specialized_arg(
        param.name,
        param.annotation,
        arg,
        env,
        call_env,
        hooks,
      );
    } else {
      push_runtime_specialized_arg(
        target.expr,
        param,
        arg,
        env,
        call_env,
        runtime_args,
        runtime_names,
        hooks,
      );
    }
  }

  if (linear_names.size > 0) {
    if (
      contains_unresolved_linear_effect(
        target.expr.body,
        linear_names,
        call_env,
        hooks,
      )
    ) {
      throw new Error(
        "Cannot lower linear function to Ic frontend yet" +
          structured_core_route,
      );
    }
  }

  let result = hooks.lower_expr(target.expr.body, call_env);

  for (let index = runtime_names.length - 1; index >= 0; index -= 1) {
    const name = runtime_names[index];
    expect(name, "Missing runtime parameter " + index);
    result = lower_lambda_binding(name, result);
  }

  for (const arg of runtime_args) {
    result = {
      tag: "app",
      func: result,
      arg: lower_expr_as_front_type(arg.value, arg.type, env, hooks),
    };
  }

  return result;
}

function lower_deferred_dynamic_function_if_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): IcNode | undefined {
  const dynamic_target = resolve_dynamic_function_if_target(
    expr.func,
    env,
    hooks,
  );

  if (!dynamic_target) {
    return undefined;
  }

  if (
    !is_deferred_frontend_value(
      dynamic_target.expr,
      dynamic_target.env,
      hooks,
    )
  ) {
    return undefined;
  }

  const inlined_dynamic = inline_runtime_call_expr_with_hooks(
    expr,
    env,
    hooks,
  );

  if (!inlined_dynamic) {
    return undefined;
  }

  return hooks.lower_expr(inlined_dynamic.expr, inlined_dynamic.env);
}

export function infer_specialized_app_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): ReturnType<CallSpecializeHooks["infer_expr"]> | undefined {
  const target = resolve_call_target_with_env(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  if (expr.args.length !== target.expr.params.length) {
    return undefined;
  }

  const call_env = clone_env(target.env);
  const runtime_args: RuntimeSpecializedArg[] = [];
  const runtime_names: string[] = [];

  for (let index = 0; index < target.expr.params.length; index += 1) {
    const param = target.expr.params[index];
    const arg = expr.args[index];
    expect(param, "Missing parameter " + index);
    expect(arg, "Missing argument " + index);

    if (param.is_linear) {
      return undefined;
    }

    if (param.is_const) {
      push_const_specialized_arg(
        param.name,
        param.annotation,
        arg,
        env,
        call_env,
        hooks,
      );
    } else {
      push_runtime_specialized_arg(
        target.expr,
        param,
        arg,
        env,
        call_env,
        runtime_args,
        runtime_names,
        hooks,
      );
    }
  }

  return hooks.infer_expr(target.expr.body, call_env);
}

function contains_unresolved_linear_effect(
  expr: FrontExpr,
  names: Set<string>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "prim":
      return contains_unresolved_linear_effect(expr.left, names, env, hooks) ||
        contains_unresolved_linear_effect(expr.right, names, env, hooks);

    case "lam":
    case "rec":
      return false;

    case "app": {
      if (expr.func.tag === "field") {
        if (uses_linear_name(expr.func.object, names)) {
          if (!known_linear_method(expr.func, env, hooks)) {
            return true;
          }
        } else if (
          contains_unresolved_linear_effect(expr.func, names, env, hooks)
        ) {
          return true;
        }
      } else if (
        contains_unresolved_linear_effect(expr.func, names, env, hooks)
      ) {
        return true;
      }

      for (const arg of expr.args) {
        if (contains_unresolved_linear_effect(arg, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "block":
      return contains_unresolved_linear_stmt(
        expr.statements,
        names,
        env,
        hooks,
      );

    case "comptime":
      return contains_unresolved_linear_effect(expr.expr, names, env, hooks);

    case "borrow":
      return contains_unresolved_linear_effect(expr.value, names, env, hooks);

    case "freeze":
      return contains_unresolved_linear_effect(expr.value, names, env, hooks);

    case "scratch":
      return contains_unresolved_linear_effect(expr.body, names, env, hooks);

    case "captured":
      return contains_unresolved_linear_effect(
        expr.expr,
        names,
        expr.env,
        hooks,
      );

    case "with": {
      if (contains_unresolved_linear_effect(expr.base, names, env, hooks)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "struct_value": {
      if (
        contains_unresolved_linear_effect(expr.type_expr, names, env, hooks)
      ) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "struct_update": {
      if (contains_unresolved_linear_effect(expr.base, names, env, hooks)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "if":
      return contains_unresolved_linear_effect(expr.cond, names, env, hooks) ||
        contains_unresolved_linear_effect(
          expr.then_branch,
          names,
          env,
          hooks,
        ) ||
        contains_unresolved_linear_effect(
          expr.else_branch,
          names,
          env,
          hooks,
        );

    case "if_let":
      return contains_unresolved_linear_effect(
        expr.target,
        names,
        env,
        hooks,
      ) ||
        contains_unresolved_linear_effect(
          expr.then_branch,
          names,
          env,
          hooks,
        ) ||
        contains_unresolved_linear_effect(
          expr.else_branch,
          names,
          env,
          hooks,
        );

    case "field":
      return contains_unresolved_linear_effect(expr.object, names, env, hooks);

    case "index":
      return contains_unresolved_linear_effect(
        expr.object,
        names,
        env,
        hooks,
      ) ||
        contains_unresolved_linear_effect(expr.index, names, env, hooks);

    case "union_case":
      if (!expr.value) {
        return false;
      }

      return contains_unresolved_linear_effect(expr.value, names, env, hooks);
  }
}

function contains_unresolved_linear_stmt(
  stmts: Stmt[],
  names: Set<string>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  for (const stmt of stmts) {
    switch (stmt.tag) {
      case "import":
      case "host_import":
      case "break":
      case "continue":
      case "type_check":
      case "unsupported":
        break;

      case "bind":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "assign":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "index_assign":
        if (
          contains_unresolved_linear_effect(stmt.index, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.value, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "expr":
        if (contains_unresolved_linear_effect(stmt.expr, names, env, hooks)) {
          return true;
        }
        break;

      case "return":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "for_range":
        if (
          contains_unresolved_linear_effect(stmt.start, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.end, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.step, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "for_collection":
        if (
          contains_unresolved_linear_effect(
            stmt.collection,
            names,
            env,
            hooks,
          ) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "if_stmt":
        if (
          contains_unresolved_linear_effect(stmt.cond, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "if_let_stmt":
        if (
          contains_unresolved_linear_effect(stmt.target, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;
    }
  }

  return false;
}

function known_linear_method(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return false;
  }

  if (target.expr.tag !== "struct_value") {
    return false;
  }

  const field = lookup_field(target.expr.fields, expr.name);

  if (!field) {
    return false;
  }

  return field.value.tag === "lam";
}

function uses_linear_name(expr: FrontExpr, names: Set<string>): boolean {
  if (expr.tag === "var" || expr.tag === "linear") {
    return names.has(expr.name);
  }

  if (expr.tag === "captured") {
    return uses_linear_name(expr.expr, names);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return uses_linear_name(expr.value, names);
  }

  if (expr.tag === "scratch") {
    return uses_linear_name(expr.body, names);
  }

  return false;
}
