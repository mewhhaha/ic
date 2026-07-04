import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr, CoreFnType, CoreStmt, CoreTypeField } from "./ast.ts";
import { set_local } from "./backend/util.ts";
import type { DynamicUnionIf } from "./if_let.ts";
import { static_core_call_branch_app } from "./static_call.ts";

export type CoreUnionCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type CoreUnionHooks<ctx extends CoreUnionCtx> = {
  block_ctx?: (ctx: ctx) => ctx;
  check_core_value_type_name: (
    label: string,
    expected_name: string,
    value: CoreExpr,
    ctx: ctx,
  ) => void;
  collect_stmt_locals?: (stmt: CoreStmt, ctx: ctx) => void;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  scoped_static_core_call_value: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_type_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
};

export function static_union_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag === "union_case") {
    return expr;
  }

  const constructor_case = static_union_constructor_case(expr, ctx, hooks);

  if (constructor_case) {
    return constructor_case;
  }

  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return static_union_case(inlined, ctx, hooks);
  }

  const scoped = scoped_union_static_call_value(expr, ctx, hooks);

  if (scoped) {
    return static_union_case(scoped.value, scoped.ctx, hooks);
  }

  if (expr.tag === "app") {
    const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

    if (branch_static_call) {
      return static_union_case(branch_static_call, ctx, hooks);
    }
  }

  const block_case = static_union_block_case(expr, ctx, hooks);

  if (block_case) {
    return block_case;
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value && value.tag === "union_case") {
      return value;
    }
  }

  return undefined;
}

function static_union_block_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    const stmt = expr.statements[0];

    if (!stmt) {
      return undefined;
    }

    if (expr.statements.length !== 1) {
      return undefined;
    }

    return static_union_final_stmt_case(stmt, ctx, hooks);
  }

  const block_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing core union block statement " + index.toString());

    const is_final = index + 1 >= expr.statements.length;

    if (is_final) {
      return static_union_final_stmt_case(stmt, block_ctx, hooks);
    }

    hooks.collect_stmt_locals(stmt, block_ctx);
  }

  return undefined;
}

function static_union_final_stmt_case<ctx extends CoreUnionCtx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (stmt.tag === "expr") {
    return static_union_case(stmt.expr, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return static_union_case(stmt.value, ctx, hooks);
  }

  return undefined;
}

export function find_core_type_field(
  fields: CoreTypeField[],
  name: string,
): CoreTypeField | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

export function dynamic_union_if<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): DynamicUnionIf | undefined {
  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return dynamic_union_if(inlined, ctx, hooks);
  }

  const scoped = scoped_union_static_call_value(expr, ctx, hooks);

  if (scoped) {
    return dynamic_union_if(scoped.value, scoped.ctx, hooks);
  }

  if (expr.tag === "app") {
    const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

    if (branch_static_call) {
      return dynamic_union_if(branch_static_call, ctx, hooks);
    }
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value) {
      return dynamic_union_if(value, ctx, hooks);
    }
  }

  if (expr.tag === "block") {
    const stmt = expr.statements[0];

    if (!stmt) {
      return undefined;
    }

    if (expr.statements.length !== 1) {
      return undefined;
    }

    if (stmt.tag === "expr") {
      return dynamic_union_if(stmt.expr, ctx, hooks);
    }

    if (stmt.tag === "return") {
      return dynamic_union_if(stmt.value, ctx, hooks);
    }

    return undefined;
  }

  if (expr.tag !== "if") {
    return undefined;
  }

  const then_case = static_union_case(expr.then_branch, ctx, hooks);

  if (!then_case) {
    return undefined;
  }

  const else_case = static_union_case(expr.else_branch, ctx, hooks);

  if (!else_case) {
    return undefined;
  }

  return { cond: expr.cond, then_case, else_case };
}

function scoped_union_static_call_value<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): { value: CoreExpr; ctx: ctx } | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  const target = hooks.static_core_call_target(expr.func, ctx);

  if (!target) {
    return undefined;
  }

  if (!hooks.static_core_call_requires_scope(target)) {
    return undefined;
  }

  return hooks.scoped_static_core_call_value(expr, target, ctx);
}

export function dynamic_if_let_can_match(
  case_name: string,
  target: DynamicUnionIf,
): boolean {
  return target.then_case.name === case_name ||
    target.else_case.name === case_name;
}

export function bind_dynamic_if_let_payload<ctx extends CoreUnionCtx>(
  case_name: string,
  value_name: string | undefined,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): void {
  if (!value_name) {
    return;
  }

  const struct_payload = dynamic_if_let_struct_payload(
    case_name,
    target,
    ctx,
    hooks,
  );

  if (struct_payload) {
    ctx.locals.delete(value_name);
    ctx.statics.set(value_name, struct_payload);
    ctx.fn_types.delete(value_name);
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.delete(value_name);
    ctx.union_locals.delete(value_name);
    return;
  }

  const aggregate_payload_type = dynamic_if_let_aggregate_payload_type(
    case_name,
    target,
    ctx,
  );

  if (aggregate_payload_type) {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.set(value_name, aggregate_payload_type);
    ctx.union_locals.delete(value_name);
    return;
  }

  const union_payload_type = dynamic_if_let_union_payload_type(
    case_name,
    target,
    ctx,
  );

  if (union_payload_type) {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.delete(value_name);
    ctx.union_locals.set(value_name, union_payload_type);
    return;
  }

  const payload_type = dynamic_if_let_payload_type(
    case_name,
    target,
    ctx,
    hooks,
  );
  expect(
    payload_type,
    "Core if let payload binding requires a scalar payload",
  );
  ctx.statics.delete(value_name);
  ctx.fn_types.delete(value_name);
  ctx.struct_locals.delete(value_name);
  ctx.union_locals.delete(value_name);
  set_local(ctx.locals, value_name, payload_type);

  if (dynamic_if_let_payload_is_text(case_name, target, ctx, hooks)) {
    ctx.text_locals.add(value_name);
  } else {
    ctx.text_locals.delete(value_name);
  }
}

function static_union_constructor_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  if (expr.func.tag !== "field") {
    return undefined;
  }

  const union_type = static_union_type(expr.func.object, ctx, hooks);

  if (!union_type) {
    return undefined;
  }

  const declared = find_core_type_field(union_type.cases, expr.func.name);
  expect(declared, "Missing union case: " + expr.func.name);
  let value: CoreExpr | undefined;

  if (declared.type_name === "Unit") {
    expect(
      expr.args.length === 0,
      "Core union case " + expr.func.name + " expects no payload",
    );
  } else {
    expect(
      expr.args.length === 1,
      "Core union case " + expr.func.name + " expects 1 payload",
    );
    value = expr.args[0];
    expect(value, "Missing core union case payload");
    hooks.check_core_value_type_name(
      "Core union case " + expr.func.name,
      declared.type_name,
      value,
      ctx,
    );
  }

  return {
    tag: "union_case",
    name: expr.func.name,
    value,
    type_expr: expr.func.object,
  };
}

function static_union_type<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_type" }> | undefined {
  const value = hooks.static_type_value(expr, ctx);

  if (value && value.tag === "union_type") {
    return value;
  }

  return undefined;
}

function dynamic_if_let_payload_type<ctx extends CoreUnionCtx>(
  case_name: string,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): ValType | undefined {
  let result: ValType | undefined;

  for (const union_case of [target.then_case, target.else_case]) {
    if (union_case.name !== case_name) {
      continue;
    }

    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );
    const payload_type = hooks.expr_type(union_case.value, ctx);

    if (!result) {
      result = payload_type;
    } else {
      expect(
        result === payload_type,
        "Core if let payload type mismatch: " + result + ", got " +
          payload_type,
      );
    }
  }

  return result;
}

function dynamic_if_let_payload_is_text<ctx extends CoreUnionCtx>(
  case_name: string,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): boolean {
  let found = false;

  for (const union_case of [target.then_case, target.else_case]) {
    if (union_case.name !== case_name) {
      continue;
    }

    found = true;
    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );

    if (!hooks.core_expr_is_text(union_case.value, ctx)) {
      return false;
    }
  }

  return found;
}

function dynamic_if_let_aggregate_payload_type<ctx extends CoreUnionCtx>(
  case_name: string,
  target: DynamicUnionIf,
  ctx: ctx,
): CoreExpr | undefined {
  let result: CoreExpr | undefined;

  for (const union_case of [target.then_case, target.else_case]) {
    if (union_case.name !== case_name) {
      continue;
    }

    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );

    const payload_type = runtime_payload_type_fact(
      union_case.value,
      ctx.struct_locals,
    );

    if (!payload_type) {
      return undefined;
    }

    if (!result) {
      result = payload_type;
      continue;
    }

    expect(
      same_core_fact_expr(result, payload_type),
      "Core if let aggregate payload type mismatch",
    );
  }

  return result;
}

function dynamic_if_let_union_payload_type<ctx extends CoreUnionCtx>(
  case_name: string,
  target: DynamicUnionIf,
  ctx: ctx,
): CoreExpr | undefined {
  let result: CoreExpr | undefined;

  for (const union_case of [target.then_case, target.else_case]) {
    if (union_case.name !== case_name) {
      continue;
    }

    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );

    const payload_type = runtime_payload_type_fact(
      union_case.value,
      ctx.union_locals,
    );

    if (!payload_type) {
      return undefined;
    }

    if (!result) {
      result = payload_type;
      continue;
    }

    expect(
      same_core_fact_expr(result, payload_type),
      "Core if let union payload type mismatch",
    );
  }

  return result;
}

function runtime_payload_type_fact(
  value: CoreExpr,
  facts: Map<string, CoreExpr>,
): CoreExpr | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return facts.get(value.name);
}

function dynamic_if_let_struct_payload<ctx extends CoreUnionCtx>(
  case_name: string,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "struct_value" | "if" }> | undefined {
  let result: CoreExpr | undefined;

  for (const union_case of [target.then_case, target.else_case]) {
    if (union_case.name !== case_name) {
      continue;
    }

    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );

    if (!result) {
      result = union_case.value;
      continue;
    }

    const left = hooks.static_struct_value(result, ctx);
    const right = hooks.static_struct_value(union_case.value, ctx);

    if (left && right) {
      return {
        tag: "if",
        cond: target.cond,
        then_branch: result,
        else_branch: union_case.value,
      };
    }

    return undefined;
  }

  if (!result) {
    return undefined;
  }

  return hooks.static_struct_value(result, ctx);
}

function same_core_fact_expr(left: CoreExpr, right: CoreExpr): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
