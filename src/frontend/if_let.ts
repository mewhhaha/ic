import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { capture_expr } from "./capture.ts";
import { clone_env, fresh, push_binding } from "./env.ts";
import {
  dynamic_if_let_ic_route,
  structured_core_route,
} from "./diagnostic.ts";
import { lookup_type_field } from "./fields.ts";
import {
  bind_function_if_params,
  function_if_param_types,
  resolve_direct_lambda,
} from "./function_if.ts";
import { implicit_fallback_expr } from "./implicit_fallback.ts";
import {
  common_if_let_type,
  infer_dynamic_union_if_cases,
  infer_if_let_then_type,
  front_type_for_type_name,
  lower_if_let_else_branch,
  lower_if_let_handler,
  select_prim_for_if_let,
} from "./if_let_common.ts";
import { resolve_dynamic_union_if_target } from "./if_let_target.ts";
import {
  infer_if_let_result_union_cases,
  lower_dynamic_union_if_let_result_union,
  lower_dynamic_union_if_let_union_value,
} from "./if_let_union_result.ts";
import type { IfLetHooks, ResolvedUnionValue } from "./if_let_types.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { front_type_name } from "./types.ts";

export {
  type DynamicUnionIfTarget,
  resolve_dynamic_union_if_target,
} from "./if_let_target.ts";
export type { IfLetHooks } from "./if_let_types.ts";

export function lower_if_let(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const target = hooks.resolve_union_value(expr.target, env);

  if (!target) {
    return lower_dynamic_if_let(expr, env, hooks);
  }

  if (target.expr.name !== expr.case_name) {
    const target_type = hooks.infer_expr(expr.target, env);

    if (target_type.tag === "union_value") {
      const matched = lookup_type_field(target_type.cases, expr.case_name);

      if (matched) {
        return lower_if_let_else_branch(expr, target_type.cases, env, hooks);
      }
    }

    return hooks.lower_expr(expr.else_branch, env);
  }

  if (!expr.value_name) {
    return hooks.lower_expr(expr.then_branch, env);
  }

  const value = target.expr.value;

  if (!value) {
    throw new Error("Union case has no payload: " + expr.case_name);
  }

  const branch_env = clone_env(env);
  const ic_name = fresh(branch_env, expr.value_name);
  const target_type = hooks.infer_expr(expr.target, env);
  let value_type = hooks.infer_expr(value, target.env);

  if (target_type.tag === "union_value") {
    const matched = lookup_type_field(target_type.cases, expr.case_name);

    if (matched && matched.type_name !== "Unit") {
      value_type = front_type_for_type_name(
        matched.type_name,
        branch_env,
        hooks,
      );
    }
  }

  push_binding(branch_env, {
    name: expr.value_name,
    ic_name,
    type: value_type,
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });

  return {
    tag: "app",
    func: lower_lambda_binding(
      ic_name,
      hooks.lower_expr(expr.then_branch, branch_env),
    ),
    arg: hooks.lower_expr(value, target.env),
  };
}

function lower_dynamic_if_let(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const target_type = hooks.infer_expr(expr.target, env);

  if (target_type.tag !== "union_value") {
    const union_if = lower_dynamic_union_if_let(expr, env, hooks);

    if (union_if) {
      return union_if;
    }

    throw new Error(dynamic_if_let_ic_route);
  }

  const matched = lookup_type_field(target_type.cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  const then_type = infer_if_let_then_type(expr, target_type.cases, env, hooks);
  let target_expr = expr;
  let else_type = hooks.infer_expr(expr.else_branch, env);

  if (expr.implicit_else) {
    const fallback = implicit_fallback_expr(then_type, env, hooks);

    if (!fallback) {
      throw_no_else_if_let_implicit_fallback(then_type);
    }

    target_expr = {
      ...expr,
      else_branch: fallback,
      implicit_else: undefined,
    };
    else_type = hooks.infer_expr(fallback, env);
  }

  const branch_type = common_if_let_type(
    expr.implicit_else,
    then_type,
    else_type,
  );

  if (!branch_type) {
    const dynamic_union_if = lower_dynamic_union_if_let(
      target_expr,
      env,
      hooks,
    );

    if (dynamic_union_if) {
      return dynamic_union_if;
    }

    const union_result = lower_dynamic_union_if_let_result_union(
      target_expr,
      env,
      hooks,
    );

    if (union_result) {
      return union_result;
    }

    throw new Error("If let branches must have the same type");
  }

  const union_if = lower_dynamic_union_if_let(target_expr, env, hooks);

  if (union_if) {
    return union_if;
  }

  const handlers: IcNode[] = [];

  for (const union_case of target_type.cases) {
    handlers.push(
      lower_if_let_handler(
        target_expr,
        union_case,
        target_type.cases,
        env,
        hooks,
      ),
    );
  }

  let result = hooks.lower_expr(target_expr.target, env);

  for (const handler of handlers) {
    result = { tag: "app", func: result, arg: handler };
  }

  return result;
}

function lower_handler_encoded_if_let(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target_expr: FrontExpr,
  target_env: Env,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const handlers: IcNode[] = [];

  for (const union_case of cases) {
    handlers.push(
      lower_if_let_handler(expr, union_case, cases, env, hooks),
    );
  }

  let result = hooks.lower_expr(capture_expr(target_expr, target_env), env);

  for (const handler of handlers) {
    result = { tag: "app", func: result, arg: handler };
  }

  return result;
}

function lower_dynamic_union_if_let(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: IfLetHooks,
): IcNode | undefined {
  const target = resolve_dynamic_union_if_target(expr.target, env, hooks);

  if (!target) {
    return undefined;
  }

  const cases = infer_dynamic_union_if_cases(target.expr, target.env, hooks);

  if (!cases) {
    return undefined;
  }

  const result_type = infer_if_let_then_type(
    expr,
    cases,
    env,
    hooks,
  );
  let target_expr = expr;

  if (expr.implicit_else) {
    const fallback = implicit_fallback_expr(result_type, env, hooks);

    if (!fallback) {
      throw_no_else_if_let_implicit_fallback(result_type);
    }

    target_expr = {
      ...expr,
      else_branch: fallback,
      implicit_else: undefined,
    };
  }

  if (result_type.tag === "fn") {
    const function_result = lower_dynamic_union_if_let_function(
      target_expr,
      target,
      env,
      hooks,
    );

    if (function_result) {
      return function_result;
    }

    throw new Error(
      "Cannot lower dynamic if let function branches with incompatible " +
        "parameter shapes to Ic frontend" + structured_core_route,
    );
  }

  if (result_type.tag !== "int" && result_type.tag !== "text") {
    const union_cases = infer_if_let_result_union_cases(
      target_expr,
      cases,
      env,
      hooks,
    );

    if (union_cases) {
      return lower_dynamic_union_if_let_union_value(
        target_expr,
        target,
        cases,
        union_cases,
        env,
        hooks,
      );
    }

    const struct_value = hooks.resolve_dynamic_if_let_struct_value(
      target_expr,
      env,
    );

    if (struct_value) {
      return hooks.lower_struct_value(struct_value.expr, struct_value.env);
    }

    throw new Error(
      "Cannot lower dynamic if let branch result type " +
        front_type_name(result_type) + " to Ic frontend" +
        structured_core_route,
    );
  }

  const then_result = lower_dynamic_union_if_let_branch(
    target_expr,
    target.expr.then_branch,
    target.env,
    cases,
    env,
    hooks,
  );

  if (!then_result) {
    return undefined;
  }

  const else_result = lower_dynamic_union_if_let_branch(
    target_expr,
    target.expr.else_branch,
    target.env,
    cases,
    env,
    hooks,
  );

  if (!else_result) {
    return undefined;
  }

  const cond = hooks.lower_expr(
    capture_expr(target.expr.cond, target.env),
    env,
  );
  const select_prim = select_prim_for_if_let(
    target_expr,
    cases,
    env,
    hooks,
  );

  return {
    tag: "prim",
    prim: select_prim,
    args: [then_result, else_result, cond],
  };
}

function throw_no_else_if_let_implicit_fallback(
  type: FrontType,
): never {
  throw new Error(
    "No-else if let implicit fallback supports Int, I64, Text, " +
      "struct, or union, got " +
      front_type_name(type),
  );
}

function lower_dynamic_union_if_let_branch(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  branch_expr: FrontExpr,
  branch_env: Env,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode | undefined {
  const target = hooks.resolve_union_value(branch_expr, branch_env);

  if (target) {
    return lower_resolved_if_let_branch(
      expr,
      target,
      cases,
      env,
      hooks,
    );
  }

  const branch_type = hooks.infer_expr(branch_expr, branch_env);

  if (branch_type.tag !== "union_value") {
    return undefined;
  }

  if (!same_union_cases(cases, branch_type.cases)) {
    return undefined;
  }

  return lower_handler_encoded_if_let(
    expr,
    branch_expr,
    branch_env,
    cases,
    env,
    hooks,
  );
}

function lower_resolved_if_let_branch(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: ResolvedUnionValue,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  if (target.expr.name !== expr.case_name) {
    return lower_if_let_else_branch(expr, cases, env, hooks);
  }

  if (!expr.value_name) {
    return hooks.lower_expr(expr.then_branch, env);
  }

  const value = target.expr.value;

  if (!value) {
    throw new Error("Union case has no payload: " + expr.case_name);
  }

  const branch_env = clone_env(env);
  const ic_name = fresh(branch_env, expr.value_name);
  const matched = lookup_type_field(cases, target.expr.name);
  let value_type = hooks.infer_expr(value, target.env);

  if (matched && matched.type_name !== "Unit") {
    value_type = front_type_for_type_name(
      matched.type_name,
      branch_env,
      hooks,
    );
  }

  push_binding(branch_env, {
    name: expr.value_name,
    ic_name,
    type: value_type,
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });

  return {
    tag: "app",
    func: lower_lambda_binding(
      ic_name,
      hooks.lower_expr(expr.then_branch, branch_env),
    ),
    arg: hooks.lower_expr(value, target.env),
  };
}

function lower_dynamic_union_if_let_function(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: { expr: Extract<FrontExpr, { tag: "if" }>; env: Env },
  env: Env,
  hooks: IfLetHooks,
): IcNode | undefined {
  const then_lam = resolve_direct_lambda(expr.then_branch, env);
  const else_lam = resolve_direct_lambda(expr.else_branch, env);

  if (!then_lam || !else_lam) {
    return undefined;
  }

  const param_types = function_if_param_types(
    then_lam.expr.params,
    then_lam.env,
    else_lam.expr.params,
    else_lam.env,
    hooks,
  );

  if (!param_types) {
    return undefined;
  }

  const then_env = clone_env(then_lam.env);
  const else_env = clone_env(else_lam.env);
  const names = bind_function_if_params(
    then_lam.expr.params,
    then_env,
    else_lam.expr.params,
    else_env,
    param_types,
  );

  if (!names) {
    return undefined;
  }

  let body = hooks.lower_expr(
    {
      tag: "if_let",
      case_name: expr.case_name,
      value_name: expr.value_name,
      target: capture_expr(target.expr, target.env),
      then_branch: then_lam.expr.body,
      else_branch: capture_expr(else_lam.expr.body, else_env),
      implicit_else: expr.implicit_else,
    },
    then_env,
  );

  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    expect(name, "Missing if-let function parameter " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function same_union_cases(left: TypeField[], right: TypeField[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (const left_case of left) {
    const right_case = lookup_type_field(right, left_case.name);

    if (!right_case) {
      return false;
    }

    if (left_case.type_name !== right_case.type_name) {
      return false;
    }
  }

  return true;
}
