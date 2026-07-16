import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreFnType } from "../ast.ts";
import { set_local } from "../emit/local.ts";
import { unsupported_core_captured_assignment_message } from "../closure_capture.ts";
import { clone_core_host_imports } from "../host_import.ts";
import { same_runtime_aggregate_type_expr } from "../runtime_aggregate.ts";
import { same_runtime_union_type_expr } from "../runtime_union.ts";
import { closure_param_info } from "./param.ts";
import type { CoreClosureTypeCtx, CoreClosureTypeHooks } from "./types.ts";

export function core_lam_fn_type(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  const params: ValType[] = [];
  const param_texts: boolean[] = [];
  const param_constraints: (string | undefined)[] = [];
  const param_structs: (CoreExpr | undefined)[] = [];
  const param_unions: (CoreExpr | undefined)[] = [];

  for (const param of expr.params) {
    const info = closure_param_info(param, ctx, hooks);

    if (!info) {
      return undefined;
    }

    params.push(info.type);
    param_texts.push(info.is_text);
    param_constraints.push(info.constraint);
    param_structs.push(info.struct_type);
    param_unions.push(info.union_type);
  }

  const captures = hooks.core_lam_capture_names(expr, ctx);

  if (!captures) {
    throw new Error(unsupported_core_captured_assignment_message);
  }

  const body_ctx = create_lam_body_ctx(ctx);

  for (let index = 0; index < expr.params.length; index += 1) {
    const param = expr.params[index];
    const type = params[index];
    const is_text = param_texts[index];
    const struct_type = param_structs[index];
    const union_type = param_unions[index];
    expect(param, "Missing core closure parameter " + index.toString());
    expect(type, "Missing core closure parameter type " + index.toString());
    expect(
      is_text !== undefined,
      "Missing core closure parameter text fact " + index.toString(),
    );
    set_lam_param(body_ctx, param.name, type, is_text, struct_type, union_type);
  }

  const result = hooks.expr_type(expr.body, body_ctx);
  const result_text = hooks.core_expr_is_text(expr.body, body_ctx);

  return {
    tag: "fn",
    params,
    param_texts,
    ...optional_param_constraints(param_constraints),
    ...optional_param_structs(param_structs),
    ...optional_param_unions(param_unions),
    result,
    result_text,
    result_struct: hooks.runtime_aggregate_type_expr(expr.body, body_ctx),
    result_union: hooks.runtime_union_type_expr(expr.body, body_ctx),
  };
}

export function core_lam_fn_type_with_expected(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  expected: CoreFnType,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  if (expr.params.length !== expected.params.length) {
    return undefined;
  }

  const captures = hooks.core_lam_capture_names(expr, ctx);

  if (!captures) {
    throw new Error(unsupported_core_captured_assignment_message);
  }

  const body_ctx = create_lam_body_ctx(ctx);

  for (let index = 0; index < expr.params.length; index += 1) {
    const param = expr.params[index];
    const expected_type = expected.params[index];
    const expected_text = expected.param_texts[index];
    const expected_constraint = expected.param_constraints?.[index];
    const expected_struct = expected.param_structs?.[index];
    const expected_union = expected.param_unions?.[index];
    expect(param, "Missing core closure parameter " + index.toString());
    expect(
      expected_type,
      "Missing expected core closure parameter type " + index.toString(),
    );
    expect(
      expected_text !== undefined,
      "Missing expected core closure parameter text fact " + index.toString(),
    );

    const actual = closure_param_info(param, ctx, hooks);

    if (!actual && expected_constraint) {
      throw new Error(
        "Core closure if branch parameter constraint requires an explicit " +
          "annotation",
      );
    }

    if (actual) {
      expect(
        actual.type === expected_type && actual.is_text === expected_text,
        "Core closure if branch type mismatch",
      );
      expect(
        actual.constraint === expected_constraint,
        "Core closure if branch parameter constraint mismatch",
      );
      expect(
        same_runtime_aggregate_type_expr(
          actual.struct_type,
          expected_struct,
          ctx,
        ),
        "Core closure if branch parameter struct mismatch",
      );
      expect(
        same_runtime_union_type_expr(actual.union_type, expected_union, ctx),
        "Core closure if branch parameter union mismatch",
      );
    }

    set_lam_param(
      body_ctx,
      param.name,
      expected_type,
      expected_text,
      expected_struct,
      expected_union,
    );
  }

  const result = hooks.expr_type(expr.body, body_ctx);
  expect(result === expected.result, "Core closure if branch type mismatch");
  const result_text = hooks.core_expr_is_text(expr.body, body_ctx);
  expect(
    result_text === expected.result_text,
    "Core closure if branch text result mismatch",
  );
  expect(
    same_runtime_aggregate_type_expr(
      hooks.runtime_aggregate_type_expr(expr.body, body_ctx),
      expected.result_struct,
      body_ctx,
    ),
    "Core closure if branch struct result mismatch",
  );
  expect(
    same_runtime_union_type_expr(
      hooks.runtime_union_type_expr(expr.body, body_ctx),
      expected.result_union,
      body_ctx,
    ),
    "Core closure if branch union result mismatch",
  );
  return {
    tag: "fn",
    params: [...expected.params],
    param_texts: [...expected.param_texts],
    ...optional_param_constraints(expected.param_constraints),
    ...optional_param_structs(expected.param_structs),
    ...optional_param_unions(expected.param_unions),
    result,
    result_text: expected.result_text,
    result_struct: expected.result_struct,
    result_union: expected.result_union,
  };
}

function create_lam_body_ctx(ctx: CoreClosureTypeCtx): CoreClosureTypeCtx {
  return {
    locals: new Map(ctx.locals),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
  };
}

function set_lam_param(
  ctx: CoreClosureTypeCtx,
  name: string,
  type: ValType,
  is_text: boolean,
  struct_type: CoreExpr | undefined,
  union_type: CoreExpr | undefined,
): void {
  ctx.statics.delete(name);
  ctx.fn_types.delete(name);
  set_local(ctx.locals, name, type);

  if (is_text) {
    ctx.text_locals.add(name);
  } else {
    ctx.text_locals.delete(name);
  }

  if (struct_type) {
    ctx.struct_locals.set(name, struct_type);
  } else {
    ctx.struct_locals.delete(name);
  }

  if (union_type) {
    ctx.union_locals.set(name, union_type);
  } else {
    ctx.union_locals.delete(name);
  }
}

function optional_param_structs(
  values: (CoreExpr | undefined)[] | undefined,
): { param_structs: (CoreExpr | undefined)[] } | Record<string, never> {
  if (!values) {
    return {};
  }

  for (const value of values) {
    if (value) {
      return { param_structs: [...values] };
    }
  }

  return {};
}

function optional_param_constraints(
  values: (string | undefined)[] | undefined,
): { param_constraints: (string | undefined)[] } | Record<string, never> {
  if (!values) {
    return {};
  }

  for (const value of values) {
    if (value) {
      return { param_constraints: [...values] };
    }
  }

  return {};
}

function optional_param_unions(
  values: (CoreExpr | undefined)[] | undefined,
): { param_unions: (CoreExpr | undefined)[] } | Record<string, never> {
  if (!values) {
    return {};
  }

  for (const value of values) {
    if (value) {
      return { param_unions: [...values] };
    }
  }

  return {};
}
