import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr, TypeField } from "../ast.ts";
import { capture_expr } from "../capture.ts";
import { clone_env, fresh } from "../env.ts";
import { lookup_type_field } from "../fields.ts";
import { implicit_fallback_expr } from "../implicit_fallback.ts";
import { lower_lambda_binding } from "../ic_share.ts";
import type { DynamicBranchHooks, ResolvedUnionValue } from "./types.ts";

export function lower_dynamic_union_if(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): IcNode | undefined {
  const target_expr = dynamic_union_if_with_implicit_fallback(expr, env, hooks);

  if (!target_expr) {
    return undefined;
  }

  const value = dynamic_union_if_same_case_value(target_expr, env, hooks);

  if (value) {
    return hooks.lower_union_case_value(value.expr, value.env);
  }

  return lower_dynamic_union_if_handler_value(target_expr, env, hooks);
}

export function can_lower_dynamic_union_if_as_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): boolean {
  const target_expr = dynamic_union_if_with_implicit_fallback(expr, env, hooks);

  if (!target_expr) {
    return false;
  }

  return dynamic_union_if_same_case_value(target_expr, env, hooks) !==
    undefined;
}

function dynamic_union_if_with_implicit_fallback(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): Extract<FrontExpr, { tag: "if" }> | undefined {
  if (!expr.implicit_else) {
    return expr;
  }

  const then_type = hooks.infer_expr(expr.then_branch, env);
  const fallback = implicit_fallback_expr(then_type, env, hooks);

  if (!fallback) {
    return undefined;
  }

  return {
    ...expr,
    else_branch: fallback,
    implicit_else: undefined,
  };
}

function dynamic_union_if_same_case_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): ResolvedUnionValue | undefined {
  const then_branch = hooks.resolve_union_value(expr.then_branch, env);
  const else_branch = hooks.resolve_union_value(expr.else_branch, env);

  if (!then_branch || !else_branch) {
    return undefined;
  }

  if (then_branch.expr.name !== else_branch.expr.name) {
    return undefined;
  }

  const cases = hooks.infer_dynamic_union_if_cases(expr, env);

  if (!cases) {
    return undefined;
  }

  const declared = lookup_type_field(cases, then_branch.expr.name);
  expect(declared, "Missing union case: " + then_branch.expr.name);
  let value: FrontExpr | undefined;

  if (declared.type_name !== "Unit") {
    const then_value = then_branch.expr.value;
    const else_value = else_branch.expr.value;
    expect(then_value, "Missing then union payload: " + then_branch.expr.name);
    expect(else_value, "Missing else union payload: " + else_branch.expr.name);
    value = {
      tag: "if",
      cond: expr.cond,
      then_branch: capture_expr(then_value, then_branch.env),
      else_branch: capture_expr(else_value, else_branch.env),
    };
  }

  return {
    expr: {
      tag: "union_case",
      name: then_branch.expr.name,
      value,
      type_expr: { tag: "union_type", cases },
    },
    env,
  };
}

function lower_dynamic_union_if_handler_value(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: DynamicBranchHooks,
): IcNode | undefined {
  const cases = hooks.infer_dynamic_union_if_cases(expr, env);

  if (!cases) {
    return undefined;
  }

  const local = clone_env(env);
  const handler_names: string[] = [];

  for (const field of cases) {
    handler_names.push(fresh(local, "case_" + field.name));
  }

  let body: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [
      lower_dynamic_union_if_handler_branch_expr(
        expr.then_branch,
        env,
        cases,
        handler_names,
        hooks,
      ),
      lower_dynamic_union_if_handler_branch_expr(
        expr.else_branch,
        env,
        cases,
        handler_names,
        hooks,
      ),
      hooks.lower_expr(capture_expr(expr.cond, env), env),
    ],
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing union handler " + index);
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function lower_dynamic_union_if_handler_branch_expr(
  expr: FrontExpr,
  env: Env,
  cases: TypeField[],
  handler_names: string[],
  hooks: DynamicBranchHooks,
): IcNode {
  const branch = hooks.resolve_union_value(expr, env);

  if (branch) {
    return lower_dynamic_union_if_handler_branch(
      branch,
      cases,
      handler_names,
      hooks,
    );
  }

  const branch_type = hooks.infer_expr(expr, env);

  if (branch_type.tag !== "union_value") {
    throw new Error("Cannot lower dynamic union branch as union value");
  }

  expect(
    same_union_cases(cases, branch_type.cases),
    "Dynamic union branch cases must match selected union cases",
  );

  let result = hooks.lower_expr(capture_expr(expr, env), env);

  for (const handler_name of handler_names) {
    result = {
      tag: "app",
      func: result,
      arg: { tag: "var", name: handler_name },
    };
  }

  return result;
}

function lower_dynamic_union_if_handler_branch(
  branch: ResolvedUnionValue,
  cases: TypeField[],
  handler_names: string[],
  hooks: DynamicBranchHooks,
): IcNode {
  let selected_index = -1;

  for (let index = 0; index < cases.length; index += 1) {
    const field = cases[index];
    expect(field, "Missing union case field " + index);

    if (field.name === branch.expr.name) {
      selected_index = index;
    }
  }

  if (selected_index < 0) {
    throw new Error("Missing union case: " + branch.expr.name);
  }

  const declared = cases[selected_index];
  expect(declared, "Missing selected union case");
  let payload: IcNode = { tag: "num", type: "i32", value: 0 };

  if (declared.type_name !== "Unit") {
    const value = branch.expr.value;
    expect(value, "Missing union case payload: " + branch.expr.name);
    payload = hooks.lower_expr(value, branch.env);
  }

  const selected_handler = handler_names[selected_index];
  expect(selected_handler, "Missing selected union handler");

  return {
    tag: "app",
    func: { tag: "var", name: selected_handler },
    arg: payload,
  };
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
