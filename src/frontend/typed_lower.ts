import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type { Env, FrontExpr, FrontType, TypeField } from "./ast.ts";
import { clone_env, fresh, lookup, push_binding } from "./env.ts";
import { lookup_type_field } from "./fields.ts";
import { lower_lambda_binding } from "./ic_share.ts";
import { implicit_fallback_expr } from "./implicit_fallback.ts";
import { unwrap_ownership_wrapper_expr } from "./ownership.ts";
import {
  front_type_from_type_name,
  front_type_name,
} from "./types.ts";
import {
  simple_alias_block_value,
  single_expr_block_result,
} from "./typed_block.ts";

export type FrontTypedLowerHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_app_as_front_type?: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_annotation_type?: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
};

export type TypedFrontExpr = {
  value: FrontExpr;
  type: FrontType;
};

export function lower_expr_as_front_type(
  expr: FrontExpr,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  if (expr.tag === "captured") {
    return lower_expr_as_front_type(expr.expr, type, expr.env, hooks);
  }

  const unwrapped = unwrap_ownership_wrapper_expr(expr);

  if (unwrapped !== expr) {
    return lower_expr_as_front_type(unwrapped, type, env, hooks);
  }

  if (expr.tag === "block") {
    const alias = simple_alias_block_value(expr, type, env, hooks);

    if (alias) {
      return lower_expr_as_front_type(alias, type, env, hooks);
    }

    const result = single_expr_block_result(expr);

    if (result) {
      return lower_expr_as_front_type(result, type, env, hooks);
    }
  }

  if (expr.tag === "var") {
    const binding = lookup(env, expr.name);

    if (binding && binding.is_deferred && binding.value) {
      let value_env = env;

      if (binding.value_env) {
        value_env = binding.value_env;
      }

      return lower_expr_as_front_type(binding.value, type, value_env, hooks);
    }
  }

  if (expr.tag === "app" && hooks.lower_app_as_front_type) {
    const app = hooks.lower_app_as_front_type(expr, type, env);

    if (app) {
      return app;
    }
  }

  if (expr.tag === "if_let") {
    return lower_if_let_as_front_type(expr, type, env, hooks);
  }

  if (expr.tag !== "if") {
    return hooks.lower_expr(expr, env);
  }

  if (type.tag !== "int" && type.tag !== "text") {
    if (type.tag === "struct" || type.tag === "union_value") {
      const direct = try_lower_dynamic_if_directly(expr, env, hooks);

      if (direct) {
        return direct;
      }
    } else {
      return hooks.lower_expr(expr, env);
    }
  }

  if (
    type.tag !== "int" && type.tag !== "text" && type.tag !== "struct" &&
    type.tag !== "union_value"
  ) {
    return hooks.lower_expr(expr, env);
  }

  check_typed_if_condition(expr.cond, env, hooks);
  const cond = Ic.reduce(
    hooks.lower_expr(unwrap_ownership_wrapper_expr(expr.cond), env),
  );

  if (cond.tag === "num") {
    if (cond.type !== "i32") {
      throw new Error("If condition expects i32, got " + cond.type);
    }

    const value = cond.value;
    expect(typeof value === "number", "Expected i32 if condition");

    if (value !== 0) {
      return lower_expr_as_front_type(expr.then_branch, type, env, hooks);
    }

    return lower_expr_as_front_type(
      typed_if_else_branch(expr, type, env, hooks),
      type,
      env,
      hooks,
    );
  }

  if (type.tag === "struct") {
    if (!type.field_types) {
      return hooks.lower_expr(expr, env);
    }

    return lower_struct_if_as_front_type(
      expr,
      type.field_types,
      cond,
      env,
      hooks,
    );
  }

  if (type.tag === "union_value") {
    return lower_union_if_as_front_type(
      expr,
      type.cases,
      cond,
      env,
      hooks,
    );
  }

  let select_prim: Prim = "i32.select";

  if (type.tag === "int" && type.type === "i64") {
    select_prim = "i64.select";
  }

  return {
    tag: "prim",
    prim: select_prim,
    args: [
      lower_expr_as_front_type(expr.then_branch, type, env, hooks),
      lower_expr_as_front_type(
        typed_if_else_branch(expr, type, env, hooks),
        type,
        env,
        hooks,
      ),
      cond,
    ],
  };
}

function typed_if_else_branch(
  expr: Extract<FrontExpr, { tag: "if" }>,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
): FrontExpr {
  if (!expr.implicit_else) {
    return expr.else_branch;
  }

  const fallback = implicit_fallback_expr(type, env, {
    resolve_annotation_type: (annotation, annotation_env) => {
      if (hooks.resolve_annotation_type) {
        return hooks.resolve_annotation_type(annotation, annotation_env);
      }

      return undefined;
    },
  });
  expect(
    fallback,
    "Missing typed implicit fallback for " + front_type_name(type),
  );
  return fallback;
}

function typed_if_let_else_branch(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
): FrontExpr {
  if (!expr.implicit_else) {
    return expr.else_branch;
  }

  const fallback = implicit_fallback_expr(type, env, {
    resolve_annotation_type: (annotation, annotation_env) => {
      if (hooks.resolve_annotation_type) {
        return hooks.resolve_annotation_type(annotation, annotation_env);
      }

      return undefined;
    },
  });
  expect(
    fallback,
    "Missing typed implicit fallback for " + front_type_name(type),
  );
  return fallback;
}

function lower_if_let_as_front_type(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const direct = try_lower_if_let_directly(expr, env, hooks);

  if (direct) {
    return direct;
  }

  const target_type = hooks.infer_expr(expr.target, env);

  if (target_type.tag !== "union_value") {
    return hooks.lower_expr(expr, env);
  }

  const matched = lookup_type_field(target_type.cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  if (expr.value_name && matched.type_name === "Unit") {
    throw new Error("Union case has no payload: " + expr.case_name);
  }

  let result = hooks.lower_expr(expr.target, env);

  for (const union_case of target_type.cases) {
    result = {
      tag: "app",
      func: result,
      arg: lower_if_let_handler_as_front_type(
        expr,
        union_case,
        type,
        env,
        hooks,
      ),
    };
  }

  return result;
}

function try_lower_if_let_directly(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode | undefined {
  try {
    return hooks.lower_expr(expr, env);
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message.startsWith(
          "Cannot lower borrow view result through pure Ic",
        )
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower freeze result through pure Ic")
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower scratch result through pure Ic")
      ) {
        return undefined;
      }

      if (
        err.message.startsWith(
          "No-else if let implicit fallback supports ",
        )
      ) {
        return undefined;
      }

      if (
        err.message.startsWith(
          "Cannot lower dynamic if let branch result type ",
        )
      ) {
        return undefined;
      }
    }

    throw err;
  }
}

function lower_if_let_handler_as_front_type(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
  union_case: TypeField,
  type: FrontType,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const handler_env = clone_env(env);
  const payload_name = fresh(handler_env, "payload_" + union_case.name);
  let body_expr: FrontExpr;

  if (union_case.name === expr.case_name) {
    if (expr.value_name) {
      push_binding(handler_env, {
        name: expr.value_name,
        ic_name: payload_name,
        type: type_for_type_name(union_case.type_name, handler_env, hooks),
        is_const: false,
        is_linear: false,
        value: undefined,
        value_env: undefined,
      });
    }

    body_expr = expr.then_branch;
  } else {
    body_expr = typed_if_let_else_branch(expr, type, handler_env, hooks);
  }

  return lower_lambda_binding(
    payload_name,
    lower_expr_as_front_type(body_expr, type, handler_env, hooks),
  );
}

function lower_struct_if_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const field_values: IcNode[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing dynamic typed struct field " + index.toString());
    field_values.push(
      lower_struct_if_field_as_front_type(
        expr,
        index,
        fields,
        cond,
        env,
        hooks,
      ),
    );
  }

  return lower_struct_fields_as_ic(field_values, env);
}

function lower_struct_if_field_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  field_index: number,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const field = fields[field_index];
  expect(
    field,
    "Missing dynamic typed struct field " + field_index.toString(),
  );
  return lower_selected_ic_as_type(
    type_for_type_name(field.type_name, env, hooks),
    lower_struct_branch_field(
      expr.then_branch,
      field_index,
      fields,
      env,
      hooks,
    ),
    lower_struct_branch_field(
      typed_if_else_branch(expr, front_struct_type(fields), env, hooks),
      field_index,
      fields,
      env,
      hooks,
    ),
    cond,
    env,
    hooks,
  );
}

function front_struct_type(fields: TypeField[]): FrontType {
  const names: string[] = [];

  for (const field of fields) {
    names.push(field.name);
  }

  return { tag: "struct", fields: names, field_types: fields };
}

function lower_struct_branch_field(
  branch: FrontExpr,
  field_index: number,
  fields: TypeField[],
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  return lower_struct_value_field(
    lower_expr_as_front_type(branch, front_struct_type(fields), env, hooks),
    field_index,
    fields,
    env,
  );
}

function lower_selected_ic_as_type(
  type: FrontType,
  then_value: IcNode,
  else_value: IcNode,
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const select_prim = select_prim_for_front_type(type);

  if (select_prim) {
    return {
      tag: "prim",
      prim: select_prim,
      args: [then_value, else_value, cond],
    };
  }

  if (type.tag === "struct" && type.field_types) {
    return lower_struct_if_values_as_front_type(
      then_value,
      else_value,
      type.field_types,
      cond,
      env,
      hooks,
    );
  }

  if (type.tag === "union_value") {
    return lower_union_if_values_as_front_type(
      then_value,
      else_value,
      type.cases,
      cond,
      env,
    );
  }

  throw new Error(
    "Cannot lower dynamic if with " + front_type_name(type) +
      " branches to Ic frontend",
  );
}

function lower_struct_if_values_as_front_type(
  then_value: IcNode,
  else_value: IcNode,
  fields: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const field_values: IcNode[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing nested dynamic typed struct field " + index);
    field_values.push(
      lower_selected_ic_as_type(
        type_for_type_name(field.type_name, env, hooks),
        lower_struct_value_field(then_value, index, fields, env),
        lower_struct_value_field(else_value, index, fields, env),
        cond,
        env,
        hooks,
      ),
    );
  }

  return lower_struct_fields_as_ic(field_values, env);
}

function lower_struct_fields_as_ic(
  field_values: IcNode[],
  env: Env,
): IcNode {
  const handler_name = fresh(env, "pick");
  let body: IcNode = { tag: "var", name: handler_name };

  for (const value of field_values) {
    body = {
      tag: "app",
      func: body,
      arg: value,
    };
  }

  return lower_lambda_binding(handler_name, body);
}

function lower_struct_value_field(
  value: IcNode,
  field_index: number,
  fields: TypeField[],
  env: Env,
): IcNode {
  const names: string[] = [];

  for (const field of fields) {
    names.push(fresh(env, "field_" + field.name));
  }

  const selected_name = names[field_index];
  expect(selected_name, "Missing selected typed struct field");
  let selector: IcNode = { tag: "var", name: selected_name };

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    expect(name, "Missing typed struct selector field " + index.toString());
    selector = { tag: "lam", name, body: selector };
  }

  return {
    tag: "app",
    func: value,
    arg: selector,
  };
}

function lower_union_if_as_front_type(
  expr: Extract<FrontExpr, { tag: "if" }>,
  cases: TypeField[],
  cond: IcNode,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode {
  const type: FrontType = { tag: "union_value", cases };

  return lower_union_if_values_as_front_type(
    lower_expr_as_front_type(expr.then_branch, type, env, hooks),
    lower_expr_as_front_type(
      typed_if_else_branch(expr, type, env, hooks),
      type,
      env,
      hooks,
    ),
    cases,
    cond,
    env,
  );
}

function lower_union_if_values_as_front_type(
  then_value: IcNode,
  else_value: IcNode,
  cases: TypeField[],
  cond: IcNode,
  env: Env,
): IcNode {
  const handler_names: string[] = [];

  for (const union_case of cases) {
    handler_names.push(fresh(env, "case_" + union_case.name));
  }

  let body: IcNode = {
    tag: "prim",
    prim: "i32.select",
    args: [
      apply_union_handlers(then_value, handler_names),
      apply_union_handlers(else_value, handler_names),
      cond,
    ],
  };

  for (let index = handler_names.length - 1; index >= 0; index -= 1) {
    const name = handler_names[index];
    expect(name, "Missing typed union handler " + index.toString());
    body = lower_lambda_binding(name, body);
  }

  return body;
}

function apply_union_handlers(
  value: IcNode,
  handler_names: string[],
): IcNode {
  let result = value;

  for (const handler_name of handler_names) {
    result = {
      tag: "app",
      func: result,
      arg: { tag: "var", name: handler_name },
    };
  }

  return result;
}

function type_for_type_name(
  type_name: string,
  env: Env,
  hooks: FrontTypedLowerHooks,
): FrontType {
  if (hooks.resolve_annotation_type) {
    const resolved = hooks.resolve_annotation_type(type_name, env);

    if (resolved) {
      return resolved;
    }
  }

  return front_type_from_type_name(type_name);
}

function select_prim_for_front_type(type: FrontType): Prim | undefined {
  if (type.tag === "text") {
    return "i32.select";
  }

  if (type.tag === "int") {
    if (type.type === "i64") {
      return "i64.select";
    }

    return "i32.select";
  }

  return undefined;
}

function try_lower_dynamic_if_directly(
  expr: Extract<FrontExpr, { tag: "if" }>,
  env: Env,
  hooks: FrontTypedLowerHooks,
): IcNode | undefined {
  if (expr.implicit_else) {
    return undefined;
  }

  try {
    return hooks.lower_expr(expr, env);
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message ===
          "Cannot lower dynamic if with unknown branches to Ic frontend"
      ) {
        return undefined;
      }

      if (
        err.message ===
          "No-else if implicit fallback supports Int, I64, Text, struct, or union, got unknown"
      ) {
        return undefined;
      }

      if (
        err.message.startsWith("Cannot lower dynamic if with ") &&
        err.message.endsWith(" branches to Ic frontend")
      ) {
        return undefined;
      }
    }

    throw err;
  }
}

function check_typed_if_condition(
  expr: FrontExpr,
  env: Env,
  hooks: FrontTypedLowerHooks,
): void {
  const type = hooks.infer_expr(expr, env);

  if (type.tag === "unknown") {
    return;
  }

  if (type.tag === "int" && type.type !== "i64") {
    return;
  }

  throw new Error("If condition expects i32, got " + front_type_name(type));
}
