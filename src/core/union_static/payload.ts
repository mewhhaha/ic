import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";
import { set_local } from "../emit/local.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { CoreUnionCtx, CoreUnionHooks } from "./types.ts";

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
