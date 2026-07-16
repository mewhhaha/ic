import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr, CoreField, CoreFnType } from "./ast.ts";
import { maybe_static_i32 } from "./analysis/static_i32.ts";
import { static_indexed_field } from "./analysis/field.ts";
import { text_byte_length } from "./text.ts";
import { static_block_result, static_type_value } from "./type_static.ts";
import type { StaticTextIfBranches } from "./model/static_value.ts";

export type { StaticTextIfBranches } from "./model/static_value.ts";

export type StaticTextCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type StaticTextHooks = {
  static_collection_fields: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => CoreField[] | undefined;
  expr_type: (expr: CoreExpr, ctx: StaticTextCtx) => ValType;
  static_union_case?: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  dynamic_union_if?: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => StaticTextUnionIf | undefined;
};

type StaticTextUnionIf = {
  cond: CoreExpr;
  then_case: Extract<CoreExpr, { tag: "union_case" }>;
  else_case: Extract<CoreExpr, { tag: "union_case" }>;
};

export function static_text_value(
  expr: CoreExpr,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  if (expr.tag === "text") {
    return expr;
  }

  const block_value = static_block_result(expr);

  if (block_value) {
    return static_text_value(block_value, ctx, hooks);
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value) {
      return static_text_value(value, ctx, hooks);
    }
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return static_text_value(expr.value, ctx, hooks);
  }

  if (expr.tag === "index") {
    return static_indexed_text_value(expr, ctx, hooks);
  }

  if (expr.tag === "prim" && expr.prim === "i32.add") {
    const left_expr = expr.args[0];
    const right_expr = expr.args[1];
    expect(left_expr, "Missing core text concat left operand");
    expect(right_expr, "Missing core text concat right operand");

    const left = static_text_value(left_expr, ctx, hooks);
    const right = static_text_value(right_expr, ctx, hooks);

    if (!left || !right) {
      return undefined;
    }

    return concat_static_text_values(left, right);
  }

  if (expr.tag === "if") {
    const branches = static_text_if_branches(expr, ctx, hooks);

    if (!branches) {
      return undefined;
    }

    return {
      tag: "if",
      cond: expr.cond,
      then_branch: branches.then_text,
      else_branch: branches.else_text,
    };
  }

  if (expr.tag === "if_let") {
    return static_text_if_let_value(expr, ctx, hooks);
  }

  return undefined;
}

export function static_text_if_branches(
  expr: Extract<CoreExpr, { tag: "if" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): StaticTextIfBranches | undefined {
  const then_text = static_text_value(expr.then_branch, ctx, hooks);

  if (!then_text) {
    return undefined;
  }

  if (expr.implicit_else) {
    return { then_text, else_text: { tag: "text", value: "" } };
  }

  const else_text = static_text_value(expr.else_branch, ctx, hooks);

  if (!else_text) {
    return undefined;
  }

  return { then_text, else_text };
}

function static_text_if_let_value(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  if (hooks.static_union_case) {
    const union_case = hooks.static_union_case(expr.target, ctx);

    if (union_case) {
      return static_text_if_let_case_value(expr, union_case, ctx, hooks);
    }
  }

  if (!hooks.dynamic_union_if) {
    return undefined;
  }

  const target = hooks.dynamic_union_if(expr.target, ctx);

  if (!target) {
    return undefined;
  }

  const then_text = static_text_if_let_case_value(
    expr,
    target.then_case,
    ctx,
    hooks,
  );

  let else_text = static_text_if_let_case_value(
    expr,
    target.else_case,
    ctx,
    hooks,
  );

  if (
    expr.implicit_else &&
    then_text &&
    !else_text &&
    target.else_case.name !== expr.case_name
  ) {
    else_text = { tag: "text", value: "" };
  }

  let resolved_then_text = then_text;

  if (
    expr.implicit_else &&
    else_text &&
    !resolved_then_text &&
    target.then_case.name !== expr.case_name
  ) {
    resolved_then_text = { tag: "text", value: "" };
  }

  if (!resolved_then_text) {
    return undefined;
  }

  if (!else_text) {
    return undefined;
  }

  return {
    tag: "if",
    cond: target.cond,
    then_branch: resolved_then_text,
    else_branch: else_text,
  };
}

function static_text_if_let_case_value(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  if (union_case.name !== expr.case_name) {
    if (
      expr.implicit_else &&
      static_if_let_matched_payload_is_text(expr, union_case, ctx)
    ) {
      return { tag: "text", value: "" };
    }

    return static_text_value(expr.else_branch, ctx, hooks);
  }

  const branch_ctx: StaticTextCtx = {
    locals: ctx.locals,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
  };

  if (expr.value_name) {
    expect(
      union_case.value,
      "Core if let payload binding requires a payload",
    );
    const payload_text = static_text_value(union_case.value, ctx, hooks);

    if (!payload_text) {
      branch_ctx.statics.delete(expr.value_name);
    } else {
      branch_ctx.statics.set(expr.value_name, payload_text);
    }
  }

  return static_text_value(expr.then_branch, branch_ctx, hooks);
}

function static_if_let_matched_payload_is_text(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: StaticTextCtx,
): boolean {
  const type_expr = union_case.type_expr;

  if (!type_expr) {
    return false;
  }

  const type_value = static_type_value(type_expr, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return false;
  }

  for (const item of type_value.cases) {
    if (item.name !== expr.case_name) {
      continue;
    }

    return item.type_name === "Text" || item.type_name === "Bytes";
  }

  return false;
}

export function static_text_length_expr(
  expr: CoreExpr,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  if (is_i32_trap_expr(expr)) {
    return expr;
  }

  if (expr.tag === "index") {
    return static_indexed_text_length_expr(expr, ctx, hooks);
  }

  const text = static_text_value(expr, ctx, hooks);

  if (!text) {
    return undefined;
  }

  if (text.tag === "text") {
    return {
      tag: "num",
      type: "i32",
      value: text_byte_length(text.value),
    };
  }

  if (text.tag === "if") {
    const then_length = static_text_length_expr(
      text.then_branch,
      ctx,
      hooks,
    );
    const else_length = static_text_length_expr(
      text.else_branch,
      ctx,
      hooks,
    );
    expect(then_length, "Missing then text length");
    expect(else_length, "Missing else text length");
    return {
      tag: "if",
      cond: text.cond,
      then_branch: then_length,
      else_branch: else_length,
    };
  }

  return undefined;
}

export function check_core_text_concat_operand_visibility(
  expr: Extract<CoreExpr, { tag: "prim" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): void {
  if (expr.prim !== "i32.add") {
    return;
  }

  const left_expr = expr.args[0];
  const right_expr = expr.args[1];
  expect(left_expr, "Missing core text concat left operand");
  expect(right_expr, "Missing core text concat right operand");

  const left = static_text_value(left_expr, ctx, hooks);
  const right = static_text_value(right_expr, ctx, hooks);

  if (left && !right) {
    throw new Error("Core text concatenation requires visible text operands");
  }

  if (!left && right) {
    throw new Error("Core text concatenation requires visible text operands");
  }
}

function static_indexed_text_value(
  expr: Extract<CoreExpr, { tag: "index" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  const fields = hooks.static_collection_fields(expr.object, ctx);

  if (!fields || fields.length === 0) {
    return undefined;
  }

  const index_type = hooks.expr_type(expr.index, ctx);
  expect(index_type === "i32", "Core text index expression index must be i32");
  const static_index = maybe_static_i32(expr.index);

  if (static_index !== undefined) {
    const field = static_indexed_field(fields, static_index);
    return static_text_value(field.value, ctx, hooks);
  }

  let result: CoreExpr = { tag: "prim", prim: "i32.trap", args: [] };

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields[index];
    expect(field, "Missing static collection field " + index.toString());
    const text = static_text_value(field.value, ctx, hooks);

    if (!text) {
      return undefined;
    }

    result = {
      tag: "if",
      cond: {
        tag: "prim",
        prim: "i32.eq",
        args: [
          expr.index,
          { tag: "num", type: "i32", value: index },
        ],
      },
      then_branch: text,
      else_branch: result,
    };
  }

  return result;
}

function static_indexed_text_length_expr(
  expr: Extract<CoreExpr, { tag: "index" }>,
  ctx: StaticTextCtx,
  hooks: StaticTextHooks,
): CoreExpr | undefined {
  const fields = hooks.static_collection_fields(expr.object, ctx);

  if (!fields || fields.length === 0) {
    return undefined;
  }

  const index_type = hooks.expr_type(expr.index, ctx);
  expect(index_type === "i32", "Core text index length index must be i32");
  const static_index = maybe_static_i32(expr.index);

  if (static_index !== undefined) {
    const field = static_indexed_field(fields, static_index);
    return static_text_length_expr(field.value, ctx, hooks);
  }

  let result: CoreExpr = { tag: "prim", prim: "i32.trap", args: [] };

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields[index];
    expect(field, "Missing static collection field " + index.toString());
    const length = static_text_length_expr(field.value, ctx, hooks);

    if (!length) {
      return undefined;
    }

    result = {
      tag: "if",
      cond: {
        tag: "prim",
        prim: "i32.eq",
        args: [
          expr.index,
          { tag: "num", type: "i32", value: index },
        ],
      },
      then_branch: length,
      else_branch: result,
    };
  }

  return result;
}

function concat_static_text_values(
  left: CoreExpr,
  right: CoreExpr,
): CoreExpr | undefined {
  if (is_i32_trap_expr(left)) {
    return left;
  }

  if (is_i32_trap_expr(right)) {
    return right;
  }

  if (left.tag === "text" && right.tag === "text") {
    return { tag: "text", value: left.value + right.value };
  }

  if (left.tag === "if") {
    const then_branch = concat_static_text_values(left.then_branch, right);
    const else_branch = concat_static_text_values(left.else_branch, right);

    if (!then_branch || !else_branch) {
      return undefined;
    }

    return {
      tag: "if",
      cond: left.cond,
      then_branch,
      else_branch,
    };
  }

  if (right.tag === "if") {
    const then_branch = concat_static_text_values(left, right.then_branch);
    const else_branch = concat_static_text_values(left, right.else_branch);

    if (!then_branch || !else_branch) {
      return undefined;
    }

    return {
      tag: "if",
      cond: right.cond,
      then_branch,
      else_branch,
    };
  }

  return undefined;
}

function is_i32_trap_expr(expr: CoreExpr): boolean {
  if (expr.tag !== "prim") {
    return false;
  }

  return expr.prim === "i32.trap";
}
