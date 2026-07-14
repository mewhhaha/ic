import { expect } from "../expect.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { clone_env, lookup, push_binding } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { inline_union_result_call } from "./union_call_inline.ts";
import { validate_union_payload_type } from "./union_payload.ts";
import type { UnionValueHooks, UnionValueTarget } from "./union_value_types.ts";

export function resolve_union_value(
  expr: FrontExpr,
  env: Env,
  hooks: UnionValueHooks,
): UnionValueTarget | undefined {
  if (expr.tag === "captured") {
    return resolve_union_value(expr.expr, expr.env, hooks);
  }

  if (expr.tag === "union_case") {
    return { expr, env };
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return resolve_union_value(expr.value, env, hooks);
  }

  if (expr.tag === "scratch") {
    return resolve_union_value(expr.body, env, hooks);
  }

  if (expr.tag === "app") {
    const constructor = resolve_union_constructor_call(expr, env, hooks);

    if (constructor) {
      return constructor;
    }

    const inlined = inline_union_result_call(expr, env, hooks);

    if (inlined) {
      return resolve_union_value(inlined.expr, inlined.env, hooks);
    }
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing block statement");

    if (stmt.tag === "expr") {
      return resolve_union_value(stmt.expr, clone_env(env), hooks);
    }

    if (stmt.tag === "return") {
      return resolve_union_value(stmt.value, clone_env(env), hooks);
    }
  }

  if (expr.tag === "block") {
    const block = resolve_union_block_value(expr, env, hooks);

    if (block) {
      return block;
    }

    const value = hooks.eval_simple_front_block(expr, env);

    if (value) {
      return resolve_union_value(value, env, hooks);
    }
  }

  if (expr.tag === "field") {
    const constructor = resolve_union_constructor_call(
      {
        tag: "app",
        func: expr,
        args: [],
      },
      env,
      hooks,
    );

    if (constructor) {
      return constructor;
    }

    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return resolve_union_value(field.expr, field.env, hooks);
  }

  if (expr.tag === "index") {
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index === undefined) {
      return undefined;
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (!item) {
      return undefined;
    }

    return resolve_union_value(item.expr, item.env, hooks);
  }

  if (expr.tag !== "var") {
    return undefined;
  }

  const binding = lookup(env, expr.name);

  if (!binding || !binding.value) {
    return undefined;
  }

  let value_env = env;

  if (binding.value_env) {
    value_env = binding.value_env;
  }

  return resolve_union_value(binding.value, value_env, hooks);
}

function resolve_union_block_value(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  hooks: UnionValueHooks,
): UnionValueTarget | undefined {
  if (expr.statements.length <= 1) {
    return undefined;
  }

  const local = clone_env(env);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing union block statement " + index);

    if (stmt.tag === "bind") {
      if (stmt.kind !== "let" || stmt.is_linear) {
        return undefined;
      }

      const value_env = clone_env(local);
      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: hooks.infer_expr(stmt.value, value_env),
        is_const: false,
        is_linear: false,
        value: stmt.value,
        value_env,
      });
      continue;
    }

    if (stmt.tag === "expr") {
      if (index !== expr.statements.length - 1) {
        return undefined;
      }

      if (!can_resolve_union_block_result_alias(stmt.expr)) {
        return undefined;
      }

      return resolve_union_value(stmt.expr, local, hooks);
    }

    if (stmt.tag === "return") {
      if (index !== expr.statements.length - 1) {
        return undefined;
      }

      if (!can_resolve_union_block_result_alias(stmt.value)) {
        return undefined;
      }

      return resolve_union_value(stmt.value, local, hooks);
    }

    return undefined;
  }

  return undefined;
}

function can_resolve_union_block_result_alias(expr: FrontExpr): boolean {
  if (expr.tag === "var" || expr.tag === "field" || expr.tag === "index") {
    return true;
  }

  return false;
}

export function resolve_union_constructor_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: UnionValueHooks,
): UnionValueTarget | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  const union_type = resolve_union_type_value(expr.func.object, env, hooks);

  if (!union_type) {
    return undefined;
  }

  const union_case = lookup_type_field(union_type.cases, expr.func.name);

  if (!union_case) {
    throw new Error("Missing union case: " + expr.func.name);
  }

  let value: FrontExpr | undefined;
  let args = expr.args;

  if (expr.arg) {
    if (expr.arg.tag === "unit") {
      args = [];
    } else {
      args = [expr.arg];
    }
  }

  if (union_case.type_name === "Unit") {
    if (args.length !== 0) {
      throw new Error("Union case " + expr.func.name + " expects no payload");
    }
  } else {
    if (args.length !== 1) {
      throw new Error("Union case " + expr.func.name + " expects 1 payload");
    }

    value = args[0];
    expect(value, "Missing union case payload");
    validate_union_payload_type(
      expr.func.name,
      union_case.type_name,
      value,
      env,
      hooks,
    );
  }

  return {
    expr: {
      tag: "union_case",
      name: expr.func.name,
      value,
      type_expr: expr.func.object,
    },
    env,
  };
}

export function resolve_union_type_value(
  expr: FrontExpr,
  env: Env,
  hooks: UnionValueHooks,
): Extract<FrontExpr, { tag: "union_type" }> | undefined {
  const value = hooks.resolve_const_expr(expr, env);

  if (!value) {
    return undefined;
  }

  const type_value = hooks.resolve_extended_type_value(value, env);

  if (type_value.tag !== "union_type") {
    return undefined;
  }

  return type_value;
}
