import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import { is_object_type_expr, lookup_type_field } from "./fields.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import {
  inline_union_result_call,
  type UnionCallInlineHooks,
} from "./union_call_inline.ts";
import { front_type_name, type_name_from_front_type } from "./types.ts";

export type UnionValueHooks = UnionCallInlineHooks & {
  eval_simple_front_block: (
    expr: Extract<FrontExpr, { tag: "block" }>,
    env: Env,
  ) => FrontExpr | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_const_expr: (expr: FrontExpr, env: Env) => FrontExpr | undefined;
  resolve_extended_type_value: (expr: FrontExpr, env: Env) => FrontExpr;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
};

type UnionValueTarget = {
  expr: Extract<FrontExpr, { tag: "union_case" }>;
  env: Env;
};

export function lower_union_case_value(
  expr: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  hooks: UnionValueHooks,
): IcNode {
  let type_expr = expr.type_expr;

  if (!type_expr) {
    const field = infer_untyped_union_case(expr, env, hooks);

    type_expr = { tag: "union_type", cases: [field] };
  }

  const union_type = resolve_union_type_value(type_expr, env, hooks);
  expect(union_type, "Missing union type for case: " + expr.name);
  const declared = lookup_type_field(union_type.cases, expr.name);

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

  for (const field of union_type.cases) {
    handler_names.push(fresh(local, "case_" + field.name));
  }

  let selected_index = -1;

  for (let index = 0; index < union_type.cases.length; index += 1) {
    const field = union_type.cases[index];
    expect(field, "Missing union case field " + index);

    if (field.name === expr.name) {
      selected_index = index;
    }
  }

  if (selected_index < 0) {
    throw new Error("Missing union case: " + expr.name);
  }

  const selected_handler = handler_names[selected_index];
  expect(selected_handler, "Missing selected union handler");
  let body: IcNode = {
    tag: "app",
    func: { tag: "var", name: selected_handler },
    arg: payload,
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing union handler " + index);
    body = lower_lambda_binding(name, body);
  }

  return body;
}

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
    const constructor = resolve_union_constructor_call({
      tag: "app",
      func: expr,
      args: [],
    }, env, hooks);

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

export function infer_untyped_union_case(
  expr: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  hooks: UnionValueHooks,
): TypeField {
  if (!expr.value) {
    return { name: expr.name, type_name: "Unit" };
  }

  const explicit_type_name = explicit_payload_type_name(expr.value);

  if (explicit_type_name) {
    return { name: expr.name, type_name: explicit_type_name };
  }

  const type_name = type_name_from_front_type(
    hooks.infer_expr(expr.value, env),
  );

  if (!type_name) {
    return { name: expr.name, type_name: "unknown" };
  }

  return { name: expr.name, type_name };
}

function explicit_payload_type_name(expr: FrontExpr): string | undefined {
  if (expr.tag === "captured") {
    return explicit_payload_type_name(expr.expr);
  }

  if (expr.tag === "block" && expr.statements.length === 1) {
    const stmt = expr.statements[0];
    expect(stmt, "Missing union payload block statement");

    if (stmt.tag === "expr") {
      return explicit_payload_type_name(stmt.expr);
    }

    if (stmt.tag === "return") {
      return explicit_payload_type_name(stmt.value);
    }
  }

  if (expr.tag === "struct_value") {
    if (is_object_type_expr(expr.type_expr)) {
      return undefined;
    }

    if (expr.type_expr.tag === "var") {
      return expr.type_expr.name;
    }
  }

  if (expr.tag === "union_case") {
    if (expr.type_expr && expr.type_expr.tag === "var") {
      return expr.type_expr.name;
    }
  }

  return undefined;
}

export function resolve_union_constructor_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: UnionValueHooks,
): { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env } | undefined {
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

  if (union_case.type_name === "Unit") {
    if (expr.args.length !== 0) {
      throw new Error("Union case " + expr.func.name + " expects no payload");
    }
  } else {
    if (expr.args.length !== 1) {
      throw new Error("Union case " + expr.func.name + " expects 1 payload");
    }

    value = expr.args[0];
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

export function validate_union_payload_type(
  name: string,
  expected: string,
  value: FrontExpr,
  env: Env,
  hooks: UnionValueHooks,
): void {
  const actual = hooks.infer_expr(value, env);

  if (actual.tag === "unknown") {
    return;
  }

  if (expected === "Int" || expected === "I32" || expected === "U32") {
    if (actual.tag !== "int" || actual.type === "i64") {
      throw new Error(
        "Union case " + name + " expects " + expected + ", got " +
          front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "I64") {
    if (actual.tag !== "int" || actual.type !== "i64") {
      throw new Error(
        "Union case " + name + " expects I64, got " + front_type_name(actual),
      );
    }

    return;
  }

  if (expected === "Text") {
    if (actual.tag !== "text") {
      throw new Error(
        "Union case " + name + " expects Text, got " + front_type_name(actual),
      );
    }
  }
}

export function check_union_case_value(
  union_type: Extract<FrontExpr, { tag: "union_type" }>,
  value: Extract<FrontExpr, { tag: "union_case" }>,
  env: Env,
  hooks: UnionValueHooks,
): void {
  const declared = lookup_type_field(union_type.cases, value.name);

  if (!declared) {
    throw new Error("Missing union case: " + value.name);
  }

  if (declared.type_name === "Unit") {
    if (value.value) {
      throw new Error("Union case " + value.name + " expects no payload");
    }

    return;
  }

  const payload = value.value;

  if (!payload) {
    throw new Error("Union case " + value.name + " expects 1 payload");
  }

  validate_union_payload_type(
    value.name,
    declared.type_name,
    payload,
    env,
    hooks,
  );
}
