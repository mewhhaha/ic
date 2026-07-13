import type { Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import {
  infer_dynamic_union_if_cases as infer_dynamic_union_if_cases_with_hooks,
} from "./dynamic_union_cases.ts";
import { clone_env, fresh, push_binding } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import {
  can_implicit_fallback_type,
  implicit_fallback_expr,
} from "./implicit_fallback.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import type { IfLetHooks } from "./if_let_types.ts";
import {
  common_front_type,
  front_type_from_type_name,
  front_type_name,
  numeric_front_type,
} from "./types.ts";

export function infer_dynamic_union_if_cases(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: IfLetHooks,
): TypeField[] | undefined {
  return infer_dynamic_union_if_cases_with_hooks(expr, env, hooks);
}

export function select_prim_for_if_let(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): Prim {
  const then_type = numeric_front_type(
    infer_if_let_then_type(expr, cases, env, hooks),
  );
  let else_type = hooks.resolve_numeric_expr_type(
    expr.else_branch,
    env,
  );
  const result_type = infer_if_let_then_type(expr, cases, env, hooks);
  const fallback_type = hooks.infer_expr(expr.else_branch, env);

  if (result_type.tag === "text" && fallback_type.tag === "text") {
    return "i32.select";
  }

  if (expr.implicit_else) {
    else_type = then_type;
  }

  if (then_type === "i64" || else_type === "i64") {
    if (then_type === "i32" || else_type === "i32") {
      throw new Error("Mixed i32 and i64 if let branches");
    }

    return "i64.select";
  }

  return "i32.select";
}

export function infer_if_let_then_type(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): FrontType {
  if (!expr.value_name) {
    return hooks.infer_expr(expr.then_branch, env);
  }

  const matched = lookup_type_field(cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  if (matched.type_name === "Unit") {
    throw new Error("Union case has no payload: " + expr.case_name);
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

  return hooks.infer_expr(expr.then_branch, branch_env);
}

export function common_if_let_type(
  implicit_else: boolean | undefined,
  then_type: FrontType,
  else_type: FrontType,
): FrontType | undefined {
  const result_type = common_front_type(then_type, else_type);

  if (result_type) {
    return result_type;
  }

  if (
    implicit_else &&
    can_implicit_fallback_type(then_type)
  ) {
    return then_type;
  }

  return undefined;
}

export function lower_if_let_else_branch(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  cases: TypeField[],
  env: Env,
  hooks: IfLetHooks,
): IcNode {
  if (!expr.implicit_else) {
    return hooks.lower_expr(expr.else_branch, env);
  }

  const type = infer_if_let_then_type(expr, cases, env, hooks);

  const fallback = implicit_fallback_expr(type, env, hooks);

  if (!fallback) {
    throw new Error(
      "No-else if let implicit fallback supports Bool, Int, I64, Text, " +
        "struct, or union, got " +
        front_type_name(type),
    );
  }

  return hooks.lower_expr(fallback, env);
}

export function lower_if_let_handler(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  union_case: TypeField,
  cases: TypeField[],
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

    body = hooks.lower_expr(expr.then_branch, handler_env);
  } else {
    body = lower_if_let_else_branch(expr, cases, handler_env, hooks);
  }

  return lower_lambda_binding(payload_name, body);
}

export function front_type_for_type_name(
  type_name: string,
  env: Env,
  hooks: IfLetHooks,
): FrontType {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return resolved;
  }

  return front_type_from_type_name(type_name);
}
