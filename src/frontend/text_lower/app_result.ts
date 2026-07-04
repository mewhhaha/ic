import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr, FrontType, ResolvedFrontExpr } from "../ast.ts";
import { lookup } from "../env.ts";
import { lower_expr_as_front_type } from "../typed_lower.ts";
import type { TextLowerHooks } from "../text_lower_types.ts";
import { visible_text_value } from "../text_visible.ts";

const max_inline_text_app_depth = 16;

export function lower_text_app_result(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: TextLowerHooks,
  depth = 0,
): IcNode | undefined {
  if (hooks.lower_app_as_front_type) {
    const typed = hooks.lower_app_as_front_type(expr, { tag: "text" }, env);

    if (typed) {
      return typed;
    }
  }

  if (depth >= max_inline_text_app_depth) {
    return undefined;
  }

  const specialized = try_inline_specialized_text_app(expr, env, hooks);

  if (specialized) {
    const lowered = lower_inlined_text_pointer(
      specialized,
      hooks,
      depth,
    );

    if (lowered) {
      return lowered;
    }
  }

  const runtime = try_inline_runtime_text_app(expr, env, hooks);

  if (!runtime) {
    return undefined;
  }

  return lower_inlined_text_pointer(runtime, hooks, depth);
}

function lower_inlined_text_pointer(
  value: ResolvedFrontExpr,
  hooks: TextLowerHooks,
  depth: number,
): IcNode | undefined {
  if (
    !can_lower_text_pointer_expr(
      value.expr,
      value.env,
      hooks,
      new Set(),
      depth,
    )
  ) {
    return undefined;
  }

  return lower_expr_as_front_type(
    value.expr,
    { tag: "text" },
    value.env,
    {
      infer_expr: hooks.infer_expr,
      lower_app_as_front_type: (expr, type, env) =>
        lower_nested_app_as_front_type(expr, type, env, hooks, depth + 1),
      lower_expr: hooks.lower_expr,
      resolve_annotation_type: hooks.resolve_annotation_type,
    },
  );
}

function lower_nested_app_as_front_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  type: FrontType,
  env: Env,
  hooks: TextLowerHooks,
  depth: number,
): IcNode | undefined {
  if (type.tag === "text") {
    return lower_text_app_result(expr, env, hooks, depth);
  }

  if (!hooks.lower_app_as_front_type) {
    return undefined;
  }

  return hooks.lower_app_as_front_type(expr, type, env);
}

function can_lower_text_pointer_expr(
  expr: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
  seen: Set<string>,
  depth: number,
): boolean {
  if (expr.tag === "captured") {
    return can_lower_text_pointer_expr(
      expr.expr,
      expr.env,
      hooks,
      seen,
      depth,
    );
  }

  if (visible_text_value(expr, env, seen, hooks)) {
    return true;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return can_lower_text_pointer_expr(
      expr.value,
      env,
      hooks,
      seen,
      depth,
    );
  }

  if (expr.tag === "scratch") {
    return can_lower_text_pointer_expr(
      expr.body,
      env,
      hooks,
      seen,
      depth,
    );
  }

  if (expr.tag === "var") {
    return can_lower_text_pointer_var(expr, env, hooks, seen, depth);
  }

  if (expr.tag === "block") {
    return can_lower_text_pointer_block(expr, env, hooks, seen, depth);
  }

  if (expr.tag === "if") {
    if (
      !can_lower_text_pointer_expr(
        expr.then_branch,
        env,
        hooks,
        seen,
        depth,
      )
    ) {
      return false;
    }

    if (expr.implicit_else) {
      return true;
    }

    return can_lower_text_pointer_expr(
      expr.else_branch,
      env,
      hooks,
      seen,
      depth,
    );
  }

  if (expr.tag === "if_let") {
    if (
      !can_lower_text_pointer_expr(
        expr.then_branch,
        env,
        hooks,
        seen,
        depth,
      )
    ) {
      return false;
    }

    if (expr.implicit_else) {
      return true;
    }

    return can_lower_text_pointer_expr(
      expr.else_branch,
      env,
      hooks,
      seen,
      depth,
    );
  }

  if (expr.tag !== "app") {
    return false;
  }

  return lower_text_app_result(expr, env, hooks, depth + 1) !== undefined;
}

function can_lower_text_pointer_var(
  expr: Extract<FrontExpr, { tag: "var" }>,
  env: Env,
  hooks: TextLowerHooks,
  seen: Set<string>,
  depth: number,
): boolean {
  if (seen.has(expr.name)) {
    return false;
  }

  const binding = lookup(env, expr.name);

  if (!binding) {
    return true;
  }

  if (binding.type.tag === "text") {
    return true;
  }

  if (!binding.value) {
    return binding.type.tag === "unknown";
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  const next_seen = new Set(seen);
  next_seen.add(expr.name);
  return can_lower_text_pointer_expr(
    binding.value,
    value_env,
    hooks,
    next_seen,
    depth,
  );
}

function can_lower_text_pointer_block(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  hooks: TextLowerHooks,
  seen: Set<string>,
  depth: number,
): boolean {
  let value: FrontExpr | undefined;

  try {
    value = hooks.eval_simple_front_block(expr, env);
  } catch {
    value = undefined;
  }

  if (value) {
    return can_lower_text_pointer_expr(value, env, hooks, seen, depth);
  }

  if (expr.statements.length === 1) {
    const stmt = expr.statements[0];

    if (!stmt) {
      return false;
    }

    if (stmt.tag === "expr") {
      return can_lower_text_pointer_expr(stmt.expr, env, hooks, seen, depth);
    }

    if (stmt.tag === "return") {
      return can_lower_text_pointer_expr(stmt.value, env, hooks, seen, depth);
    }

    return false;
  }

  if (expr.statements.length !== 2) {
    return false;
  }

  const bind = expr.statements[0];
  const result = expr.statements[1];

  if (!bind || !result) {
    return false;
  }

  if (bind.tag !== "bind" || bind.kind !== "let" || bind.is_linear) {
    return false;
  }

  let result_expr: FrontExpr | undefined;

  if (result.tag === "expr") {
    result_expr = result.expr;
  } else if (result.tag === "return") {
    result_expr = result.value;
  } else {
    return false;
  }

  if (result_expr.tag !== "var" || result_expr.name !== bind.name) {
    return false;
  }

  return can_lower_text_pointer_expr(bind.value, env, hooks, seen, depth);
}

function try_inline_specialized_text_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: TextLowerHooks,
): ResolvedFrontExpr | undefined {
  try {
    return hooks.inline_specialized_call_expr(expr, env);
  } catch {
    return undefined;
  }
}

function try_inline_runtime_text_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: TextLowerHooks,
): ResolvedFrontExpr | undefined {
  try {
    return hooks.inline_runtime_call_expr(expr, env);
  } catch {
    return undefined;
  }
}
