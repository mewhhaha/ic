import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, TypeField } from "./ast.ts";
import { capture_expr } from "./capture.ts";
import { clone_env, fresh, push_binding } from "./env.ts";
import { lookup_type_field, merge_type_fields } from "./fields.ts";
import {
  front_type_for_type_name,
  infer_dynamic_union_if_cases,
} from "./if_let_common.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import {
  type DynamicUnionIfTarget,
  resolve_dynamic_union_if_target,
} from "./if_let_target.ts";
import type { IfLetHooks, ResolvedUnionValue } from "./if_let_types.ts";

export function lower_dynamic_union_if_let_result_union(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: IfLetHooks,
): IcNode | undefined {
  const target = resolve_dynamic_union_if_target(expr.target, env, hooks);

  if (target) {
    const cases = infer_dynamic_union_if_cases(target.expr, target.env, hooks);

    if (!cases) {
      return undefined;
    }

    const result_cases = infer_if_let_result_union_cases(
      expr,
      cases,
      env,
      hooks,
    );

    if (!result_cases) {
      return undefined;
    }

    return lower_dynamic_union_if_let_union_value(
      expr,
      target,
      cases,
      result_cases,
      env,
      hooks,
    );
  }

  const target_type = hooks.infer_expr(expr.target, env);

  if (target_type.tag !== "union_value") {
    return undefined;
  }

  const result_cases = infer_if_let_result_union_cases(
    expr,
    target_type.cases,
    env,
    hooks,
  );

  if (!result_cases) {
    return undefined;
  }

  return lower_if_let_union_result_value(
    expr,
    target_type.cases,
    result_cases,
    env,
    hooks,
  );
}

export function infer_if_let_result_union_cases(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): TypeField[] | undefined {
  const then_env = clone_env(env);

  if (expr.value_name) {
    const matched = lookup_type_field(cases, expr.case_name);

    if (!matched) {
      throw new Error("Missing union case: " + expr.case_name);
    }

    if (matched.type_name === "Unit") {
      throw new Error("Union case has no payload: " + expr.case_name);
    }

    push_binding(then_env, {
      name: expr.value_name,
      ic_name: expr.value_name,
      type: front_type_for_type_name(matched.type_name, then_env, hooks),
      is_const: false,
      is_linear: false,
      value: undefined,
      value_env: undefined,
    });
  }

  const then_cases = hooks.infer_union_cases(expr.then_branch, then_env);
  const else_cases = hooks.infer_union_cases(expr.else_branch, env);

  if (!then_cases || !else_cases) {
    return undefined;
  }

  return merge_type_fields(then_cases, else_cases);
}

function lower_if_let_union_result_value(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target_cases: TypeField[],
  result_cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const local = clone_env(env);
  const handler_names: string[] = [];

  for (const field of result_cases) {
    handler_names.push(fresh(local, "case_" + field.name));
  }

  let body = hooks.lower_expr(expr.target, env);

  for (const union_case of target_cases) {
    const handler = lower_if_let_union_result_handler(
      expr,
      union_case,
      result_cases,
      handler_names,
      env,
      hooks,
    );
    body = { tag: "app", func: body, arg: handler };
  }

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing union result handler " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function lower_if_let_union_result_handler(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  union_case: TypeField,
  result_cases: TypeField[],
  handler_names: string[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const handler_env = clone_env(env);
  const payload_name = fresh(handler_env, "payload_" + union_case.name);
  let body: IcNode;

  if (union_case.name === expr.case_name) {
    if (expr.value_name && union_case.type_name === "Unit") {
      throw new Error("Union case has no payload: " + expr.case_name);
    }

    if (expr.value_name) {
      push_binding(handler_env, {
        name: expr.value_name,
        ic_name: payload_name,
        type: front_type_for_type_name(
          union_case.type_name,
          handler_env,
          hooks,
        ),
        is_const: false,
        is_linear: false,
        value: undefined,
        value_env: undefined,
      });
    }

    body = lower_union_expr_with_cases(
      expr.then_branch,
      handler_env,
      result_cases,
      hooks,
    );
  } else {
    body = lower_union_expr_with_cases(
      expr.else_branch,
      handler_env,
      result_cases,
      hooks,
    );
  }

  return lower_lambda_binding(
    payload_name,
    apply_union_result_handlers(body, handler_names),
  );
}

export function lower_dynamic_union_if_let_union_value(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: DynamicUnionIfTarget,
  target_cases: TypeField[],
  result_cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const local = clone_env(env);
  const handler_names: string[] = [];

  for (const field of result_cases) {
    handler_names.push(fresh(local, "case_" + field.name));
  }

  let body: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [
      lower_dynamic_union_if_let_union_branch_expr(
        expr,
        target.expr.then_branch,
        target.env,
        target_cases,
        result_cases,
        handler_names,
        env,
        hooks,
      ),
      lower_dynamic_union_if_let_union_branch_expr(
        expr,
        target.expr.else_branch,
        target.env,
        target_cases,
        result_cases,
        handler_names,
        env,
        hooks,
      ),
      hooks.lower_expr(capture_expr(target.expr.cond, target.env), env),
    ],
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing union result handler " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function lower_dynamic_union_if_let_union_branch_expr(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  branch_expr: FrontExpr,
  branch_env: Env,
  target_cases: TypeField[],
  result_cases: TypeField[],
  handler_names: string[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  const target = hooks.resolve_union_value(branch_expr, branch_env);

  if (target) {
    return lower_dynamic_union_if_let_union_branch(
      expr,
      target,
      target_cases,
      result_cases,
      handler_names,
      env,
      hooks,
    );
  }

  const branch_type = hooks.infer_expr(branch_expr, branch_env);

  if (
    branch_type.tag !== "union_value" ||
    !same_union_cases(target_cases, branch_type.cases)
  ) {
    throw new Error("Dynamic if let target union cases must match");
  }

  let result = hooks.lower_expr(capture_expr(branch_expr, branch_env), env);

  for (const union_case of target_cases) {
    const handler = lower_if_let_union_result_handler(
      expr,
      union_case,
      result_cases,
      handler_names,
      env,
      hooks,
    );
    result = { tag: "app", func: result, arg: handler };
  }

  return result;
}

function lower_dynamic_union_if_let_union_branch(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: ResolvedUnionValue,
  target_cases: TypeField[],
  result_cases: TypeField[],
  handler_names: string[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  let result: IcNode;

  if (target.expr.name === expr.case_name) {
    result = lower_matching_if_let_union_result(
      expr,
      target,
      target_cases,
      result_cases,
      env,
      hooks,
    );
  } else {
    result = lower_union_expr_with_cases(
      expr.else_branch,
      env,
      result_cases,
      hooks,
    );
  }

  return apply_union_result_handlers(result, handler_names);
}

function lower_matching_if_let_union_result(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  target: ResolvedUnionValue,
  target_cases: TypeField[],
  result_cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  if (!expr.value_name) {
    return lower_union_expr_with_cases(
      expr.then_branch,
      env,
      result_cases,
      hooks,
    );
  }

  const matched = lookup_type_field(target_cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  if (matched.type_name === "Unit") {
    throw new Error("Union case has no payload: " + expr.case_name);
  }

  const payload = target.expr.value;
  expect(payload, "Missing union payload: " + expr.case_name);
  const branch_env = clone_env(env);
  const ic_name = fresh(branch_env, expr.value_name);

  push_binding(branch_env, {
    name: expr.value_name,
    ic_name,
    type: front_type_for_type_name(matched.type_name, branch_env, hooks),
    is_const: false,
    is_linear: false,
    value: undefined,
    value_env: undefined,
  });

  return {
    tag: "app",
    func: lower_lambda_binding(
      ic_name,
      lower_union_expr_with_cases(
        expr.then_branch,
        branch_env,
        result_cases,
        hooks,
      ),
    ),
    arg: hooks.lower_expr(payload, target.env),
  };
}

function lower_union_expr_with_cases(
  expr: FrontExpr,
  env: Env,
  cases: TypeField[],
  hooks: IfLetHooks,
): IcNode {
  const value = hooks.resolve_union_value(expr, env);

  if (value) {
    return lower_union_case_with_cases(value.expr, value.env, cases, hooks);
  }

  return hooks.lower_expr(expr, env);
}

function lower_union_case_with_cases(
  expr: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  cases: TypeField[],
  hooks: IfLetHooks,
): IcNode {
  const declared = lookup_type_field(cases, expr.name);

  if (!declared) {
    throw new Error("Missing union case: " + expr.name);
  }

  let payload: IcNode = { tag: "num", type: "i32", value: 0 };

  if (declared.type_name !== "Unit") {
    const value = expr.value;
    expect(value, "Missing union case payload: " + expr.name);
    payload = hooks.lower_expr(value, env);
  }

  const local = clone_env(env);
  const handler_names: string[] = [];

  for (const field of cases) {
    handler_names.push(fresh(local, "case_" + field.name));
  }

  let selected_index = -1;

  for (let index = 0; index < cases.length; index += 1) {
    const field = cases[index];
    expect(field, "Missing union result case " + index.toString());

    if (field.name === expr.name) {
      selected_index = index;
    }
  }

  if (selected_index < 0) {
    throw new Error("Missing union case: " + expr.name);
  }

  const selected_handler = handler_names[selected_index];
  expect(selected_handler, "Missing selected union result handler");
  let body: IcNode = {
    tag: "app",
    func: { tag: "var", name: selected_handler },
    arg: payload,
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing union result handler " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function apply_union_result_handlers(
  value: IcNode,
  handler_names: string[],
): IcNode {
  let result = value;

  for (const name of handler_names) {
    result = {
      tag: "app",
      func: result,
      arg: { tag: "var", name },
    };
  }

  return result;
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

    if (right_case.type_name !== left_case.type_name) {
      return false;
    }
  }

  return true;
}
