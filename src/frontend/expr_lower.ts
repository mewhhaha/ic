import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Binding, Env, FrontExpr, Stmt } from "./ast.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import { structured_core_route } from "./diagnostic.ts";
import {
  lower_app_expr,
  lower_field_expr,
  lower_index_expr,
} from "./expr_lower_access.ts";
import {
  lower_lam_expr,
  lower_linear_expr,
  lower_var_expr,
} from "./expr_lower_binding.ts";
import type { ExprLowerHooks } from "./expr_lower_types.ts";
import {
  front_expr_is_static_shareable_text,
  unwrap_ownership_wrapper_expr,
} from "./ownership.ts";
import { validate_rec_tail } from "./rec.ts";
import { validate_const_expr } from "./constness.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";

export type { ExprLowerHooks } from "./expr_lower_types.ts";

export function lower_expr(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  switch (expr.tag) {
    case "num":
      return { tag: "num", type: expr.type, value: expr.value };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      throw new Error(
        "Compile-time type name cannot be emitted as an Ic result: " +
          expr.name,
      );

    case "var":
      return lower_var_expr(expr, env, hooks, lower_expr);

    case "prim": {
      if (expr.prim === "i32.eq" || expr.prim === "i32.ne") {
        const left_type = hooks.infer_expr(expr.left, env);
        const right_type = hooks.infer_expr(expr.right, env);

        if (left_type.tag === "text" && right_type.tag === "text") {
          const identity = lower_text_identity_equality(expr, env, hooks);

          if (identity) {
            return identity;
          }

          const left_text = hooks.visible_text_value(
            expr.left,
            env,
            new Set(),
          );
          const right_text = hooks.visible_text_value(
            expr.right,
            env,
            new Set(),
          );

          if (left_text && right_text) {
            const equality = lower_visible_text_equality(
              left_text,
              right_text,
              expr.prim === "i32.ne",
              env,
              hooks,
            );

            if (equality) {
              return equality;
            }
          }

          throw new Error(
            "Text equality with runtime text requires structured Core/Wasm lowering" +
              structured_core_route,
          );
        }
      }

      const text_value = hooks.visible_text_value(expr, env, new Set());

      if (text_value) {
        return lower_expr(text_value, env, hooks);
      }

      hooks.check_text_concat_operand_visibility(expr, env);
      const prim = hooks.check_numeric_primitive_operands(expr, env);
      return {
        tag: "prim",
        prim,
        args: [
          lower_numeric_primitive_operand(expr.left, prim, env, hooks),
          lower_numeric_primitive_operand(expr.right, prim, env, hooks),
        ],
      };
    }

    case "lam":
      return lower_lam_expr(expr, env, hooks, lower_expr);

    case "rec":
      validate_rec_tail(expr.body);
      throw new Error(
        "Cannot lower rec function value to Ic frontend yet" +
          structured_core_route,
      );

    case "app":
      return lower_app_expr(expr, env, hooks, lower_expr);

    case "block": {
      const local = clone_env(env);
      return hooks.lower_statements(expr.statements, 0, local);
    }

    case "comptime": {
      validate_const_expr(
        expr.expr,
        env,
        new Set(),
        "comptime expression requires compile-time values",
      );
      const value = lower_expr(expr.expr, env, hooks);
      return Ic.reduce(value);
    }

    case "borrow": {
      if (can_lower_ownership_wrapper_to_ic(expr.value, env, hooks)) {
        return lower_expr(expr.value, env, hooks);
      }

      throw new Error(
        "Cannot lower borrow view result through pure Ic" +
          structured_core_route,
      );
    }

    case "freeze": {
      if (can_lower_ownership_wrapper_to_ic(expr.value, env, hooks)) {
        return lower_expr(expr.value, env, hooks);
      }

      throw new Error(
        "Cannot lower freeze result through pure Ic" +
          structured_core_route,
      );
    }

    case "scratch": {
      if (can_lower_ownership_wrapper_to_ic(expr.body, env, hooks)) {
        return lower_expr(expr.body, env, hooks);
      }

      throw new Error(
        "Cannot lower scratch result through pure Ic" +
          structured_core_route,
      );
    }

    case "captured":
      return lower_expr(expr.expr, expr.env, hooks);

    case "with":
      throw new Error(
        "Compile-time extension value cannot be emitted as an Ic result",
      );

    case "struct_type":
      throw new Error(
        "Compile-time struct type cannot be emitted as an Ic result",
      );

    case "struct_value":
      return hooks.lower_struct_value(expr, env);

    case "struct_update":
      return lower_expr(
        hooks.apply_struct_update(expr, env),
        env,
        hooks,
      );

    case "union_type":
      throw new Error(
        "Compile-time union type cannot be emitted as an Ic result",
      );

    case "if":
      return hooks.lower_if_expr(expr, env);

    case "if_let":
      return hooks.lower_if_let(expr, env);

    case "field":
      return lower_field_expr(expr, env, hooks, lower_expr);

    case "index":
      return lower_index_expr(expr, env, hooks);

    case "union_case":
      return hooks.lower_union_case_value(expr, env);

    case "linear":
      return lower_linear_expr(expr, env, hooks, lower_expr);

    case "unsupported":
      throw new Error(
        "Cannot lower " + expr.feature + " to Ic frontend yet" +
          structured_core_route,
      );
  }
}

function lower_text_identity_equality(
  expr: Extract<FrontExpr, { tag: "prim" }>,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode | undefined {
  const left_key = text_identity_key(expr.left, env, hooks, new Set());

  if (!left_key) {
    return undefined;
  }

  const right_key = text_identity_key(expr.right, env, hooks, new Set());

  if (!right_key) {
    return undefined;
  }

  if (left_key !== right_key) {
    return undefined;
  }

  if (expr.prim === "i32.ne") {
    return { tag: "num", type: "i32", value: 0 };
  }

  return { tag: "num", type: "i32", value: 1 };
}

function text_identity_key(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
  inline_bindings: Set<Binding>,
): string | undefined {
  let current = expr;
  let current_env = env;

  while (
    current.tag === "captured" ||
    current.tag === "borrow" ||
    current.tag === "freeze" ||
    current.tag === "scratch"
  ) {
    if (current.tag === "captured") {
      current_env = current.env;
      current = current.expr;
      continue;
    }

    if (current.tag === "scratch") {
      current = current.body;
      continue;
    }

    current = current.value;
  }

  if (current.tag === "block") {
    return text_identity_block_key(
      current.statements,
      current_env,
      hooks,
      inline_bindings,
    );
  }

  if (current.tag === "app") {
    const inlined = hooks.inline_runtime_call_expr(current, current_env);

    if (!inlined) {
      return undefined;
    }

    return text_identity_key(
      inlined.expr,
      inlined.env,
      hooks,
      inline_bindings,
    );
  }

  if (current.tag !== "var") {
    return undefined;
  }

  const binding = lookup(current_env, current.name);

  if (!binding) {
    return current.name;
  }

  if (inline_bindings.has(binding) && binding.value && !binding.is_linear) {
    let value_env = current_env;

    if (binding.value_env) {
      value_env = binding.value_env;
    }

    return text_identity_key(binding.value, value_env, hooks, inline_bindings);
  }

  return binding.ic_name;
}

function text_identity_block_key(
  stmts: Stmt[],
  env: Env,
  hooks: ExprLowerHooks,
  inline_bindings: Set<Binding>,
): string | undefined {
  if (stmts.length === 0) {
    return undefined;
  }

  const local = clone_env(env);
  const last_index = stmts.length - 1;

  for (let index = 0; index < last_index; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing text identity block statement " + index);

    if (stmt.tag !== "bind") {
      return undefined;
    }

    if (stmt.kind !== "let" || stmt.is_linear) {
      return undefined;
    }

    const binding: Binding = {
      name: stmt.name,
      ic_name: fresh(local, stmt.name),
      type: { tag: "unknown" },
      is_const: false,
      is_linear: false,
      value: stmt.value,
      value_env: clone_env(local),
    };
    push_binding(local, binding);
    inline_bindings.add(binding);
  }

  const result = stmts[last_index];
  expect(result, "Missing text identity block result");
  const result_expr = text_identity_block_result_expr(result);

  if (!result_expr) {
    return undefined;
  }

  return text_identity_key(result_expr, local, hooks, inline_bindings);
}

function text_identity_block_result_expr(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function lower_numeric_primitive_operand(
  expr: FrontExpr,
  prim: Prim,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  return lower_expr_as_front_type(
    unwrap_ownership_wrapper_expr(expr),
    { tag: "int", type: numeric_primitive_operand_type(prim) },
    env,
    {
      infer_expr: hooks.infer_expr,
      lower_app_as_front_type: hooks.lower_app_as_front_type,
      lower_expr: (value, value_env) => lower_expr(value, value_env, hooks),
      resolve_annotation_type: hooks.resolve_annotation_type,
    },
  );
}

function numeric_primitive_operand_type(prim: Prim): "i32" | "i64" {
  if (prim.startsWith("i64.")) {
    return "i64";
  }

  return "i32";
}

function can_lower_ownership_wrapper_to_ic(
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
): boolean {
  const result_type = hooks.infer_expr(expr, env);

  if (result_type.tag === "int") {
    return true;
  }

  if (front_expr_is_static_shareable_text(expr, env, hooks)) {
    return true;
  }

  if (result_type.tag === "text") {
    return true;
  }

  if (result_type.tag === "struct") {
    return true;
  }

  if (result_type.tag === "union" || result_type.tag === "union_value") {
    return true;
  }

  if (result_type.tag === "fn") {
    return true;
  }

  return false;
}

function lower_visible_text_equality(
  left: FrontExpr,
  right: FrontExpr,
  invert: boolean,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode | undefined {
  if (left.tag === "text" && right.tag === "text") {
    let equal = left.value === right.value;

    if (invert) {
      equal = !equal;
    }

    let value = 0;

    if (equal) {
      value = 1;
    }

    return { tag: "num", type: "i32", value };
  }

  if (left.tag === "if") {
    const then_branch = lower_visible_text_equality(
      left.then_branch,
      right,
      invert,
      env,
      hooks,
    );
    const else_branch = lower_visible_text_equality(
      left.else_branch,
      right,
      invert,
      env,
      hooks,
    );

    if (!then_branch || !else_branch) {
      return undefined;
    }

    return lower_text_equality_branch(
      left.cond,
      then_branch,
      else_branch,
      env,
      hooks,
    );
  }

  if (right.tag === "if") {
    const then_branch = lower_visible_text_equality(
      left,
      right.then_branch,
      invert,
      env,
      hooks,
    );
    const else_branch = lower_visible_text_equality(
      left,
      right.else_branch,
      invert,
      env,
      hooks,
    );

    if (!then_branch || !else_branch) {
      return undefined;
    }

    return lower_text_equality_branch(
      right.cond,
      then_branch,
      else_branch,
      env,
      hooks,
    );
  }

  return undefined;
}

function lower_text_equality_branch(
  cond_expr: FrontExpr,
  then_branch: IcNode,
  else_branch: IcNode,
  env: Env,
  hooks: ExprLowerHooks,
): IcNode {
  const cond = Ic.reduce(lower_expr(cond_expr, env, hooks));

  if (cond.tag === "num") {
    expect(cond.type === "i32", "Text equality branch condition must be i32");
  }

  return {
    tag: "prim",
    prim: "i32.select",
    args: [then_branch, else_branch, cond],
  };
}
