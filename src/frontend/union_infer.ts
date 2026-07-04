import { expect } from "../expect.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import {
  type DynamicUnionCaseHooks,
  infer_dynamic_union_if_cases as infer_dynamic_union_if_cases_with_hooks,
} from "./dynamic_union_cases.ts";
import { clone_env, lookup, push_binding } from "./env.ts";
import { lookup_type_field, merge_type_fields } from "./fields.ts";
import { implicit_fallback_expr } from "./implicit_fallback.ts";
import {
  inline_union_result_call,
  type UnionCallInlineHooks,
} from "./union_call_inline.ts";
import { front_type_from_type_name } from "./types.ts";

export type UnionInferHooks = DynamicUnionCaseHooks & UnionCallInlineHooks & {
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_untyped_union_case: (
    expr: Extract<FrontExpr, { tag: "union_case" }>,
    env: Env,
  ) => TypeField | undefined;
  resolve_dynamic_union_if_target: (
    expr: FrontExpr,
    env: Env,
  ) => { expr: Extract<FrontExpr, { tag: "if" }>; env: Env } | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_union_type_value: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "union_type" }> | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
};

export function infer_dynamic_if_let_cases(
  expr: FrontExpr,
  env: Env,
  hooks: UnionInferHooks,
): TypeField[] | undefined {
  const target = hooks.resolve_dynamic_union_if_target(expr, env);

  if (!target) {
    return undefined;
  }

  return infer_dynamic_union_if_cases(target.expr, target.env, hooks);
}

export function infer_dynamic_union_if_cases(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: UnionInferHooks,
): TypeField[] | undefined {
  return infer_dynamic_union_if_cases_with_hooks(expr, env, hooks);
}

export function infer_union_cases(
  expr: FrontExpr,
  env: Env,
  hooks: UnionInferHooks,
): TypeField[] | undefined {
  if (expr.tag === "captured") {
    return infer_union_cases(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return infer_union_cases(expr.value, env, hooks);
  }

  if (expr.tag === "scratch") {
    return infer_union_cases(expr.body, env, hooks);
  }

  const target = hooks.resolve_union_value(expr, env);

  if (target) {
    const type_expr = target.expr.type_expr;

    if (type_expr) {
      const union_type = hooks.resolve_union_type_value(
        type_expr,
        target.env,
      );

      if (!union_type) {
        return undefined;
      }

      return union_type.cases;
    }

    const field = hooks.infer_untyped_union_case(target.expr, target.env);

    if (!field) {
      return undefined;
    }

    return [field];
  }

  if (expr.tag === "var") {
    const binding = lookup(env, expr.name);

    if (binding && binding.type.tag === "union_value") {
      return binding.type.cases;
    }
  }

  if (expr.tag === "if") {
    return infer_dynamic_union_if_cases(expr, env, hooks);
  }

  if (expr.tag === "if_let") {
    return infer_if_let_union_result_cases(expr, env, hooks);
  }

  if (expr.tag === "app") {
    const inlined = inline_union_result_call(expr, env, hooks);

    if (inlined) {
      return infer_union_cases(inlined.expr, inlined.env, hooks);
    }
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing union block statement");

    if (stmt.tag === "expr") {
      return infer_union_cases(stmt.expr, clone_env(env), hooks);
    }

    if (stmt.tag === "return") {
      return infer_union_cases(stmt.value, clone_env(env), hooks);
    }
  }

  if (expr.tag === "block") {
    const value = hooks.eval_simple_front_block(expr, env);

    if (value) {
      return infer_union_cases(value, env, hooks);
    }
  }

  return undefined;
}

function infer_if_let_union_result_cases(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: UnionInferHooks,
): TypeField[] | undefined {
  const target_cases = infer_union_cases(expr.target, env, hooks);

  if (!target_cases) {
    return undefined;
  }

  const then_env = clone_env(env);

  if (expr.value_name) {
    const matched = lookup_type_field(target_cases, expr.case_name);

    if (!matched) {
      throw new Error("Missing union case: " + expr.case_name);
    }

    if (matched.type_name === "Unit") {
      throw new Error("Union case has no payload: " + expr.case_name);
    }

    push_binding(then_env, {
      name: expr.value_name,
      ic_name: expr.value_name,
      type: front_type_from_type_name(matched.type_name),
      is_const: false,
      is_linear: false,
      value: undefined,
      value_env: undefined,
    });
  }

  const then_cases = infer_union_cases(expr.then_branch, then_env, hooks);
  const else_cases = infer_union_cases(expr.else_branch, env, hooks);

  if (!else_cases && expr.implicit_else && then_cases) {
    const fallback = implicit_fallback_expr(
      { tag: "union_value", cases: then_cases },
      env,
      hooks,
    );

    if (fallback) {
      return then_cases;
    }
  }

  if (!then_cases || !else_cases) {
    return undefined;
  }

  return merge_type_fields(then_cases, else_cases);
}
