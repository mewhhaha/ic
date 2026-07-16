import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";
import { set_local } from "../emit/local.ts";
import { core_val_type_from_type_name } from "../type_static.ts";
import {
  dynamic_if_let_can_match,
  find_core_type_field,
} from "../union_static.ts";
import { core_expr_definitely_exits } from "./control.ts";
import type {
  CoreExprTypeBlockCtx,
  CoreExprTypeCtx,
  CoreExprTypeHooks,
  CoreInferExprType,
} from "./types.ts";

export function if_let_expr_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  infer_expr_type: CoreInferExprType<ctx, block_ctx>,
): ValType {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name !== expr.case_name) {
      const implicit_type = implicit_core_if_let_then_type(
        expr,
        union_case,
        ctx,
        hooks,
        infer_expr_type,
      );

      if (implicit_type) {
        return implicit_type;
      }

      return infer_expr_type(expr.else_branch, ctx, hooks);
    }

    const branch_ctx = hooks.create_block_ctx(ctx);
    hooks.bind_core_if_let_payload_fact(
      expr.value_name,
      union_case,
      branch_ctx,
    );

    return matched_if_let_expr_type(
      expr,
      branch_ctx,
      ctx,
      hooks,
      infer_expr_type,
    );
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    const cond_type = infer_expr_type(dynamic_target.cond, ctx, hooks);
    expect(
      cond_type === "i32",
      "Core dynamic if let condition must be i32",
    );

    if (!dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      const implicit_type = implicit_core_if_let_then_type(
        expr,
        dynamic_target.then_case,
        ctx,
        hooks,
        infer_expr_type,
      );

      if (implicit_type) {
        return implicit_type;
      }

      return infer_expr_type(expr.else_branch, ctx, hooks);
    }

    const branch_ctx = hooks.create_block_ctx(ctx);
    hooks.bind_dynamic_if_let_payload(
      expr.case_name,
      expr.value_name,
      dynamic_target,
      branch_ctx,
    );
    hooks.clear_optional_core_union_local(expr.value_name, branch_ctx);

    return matched_if_let_expr_type(
      expr,
      branch_ctx,
      ctx,
      hooks,
      infer_expr_type,
    );
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    throw new Error("Cannot type core if_let expression yet");
  }

  const info = hooks.runtime_union_match_info(
    expr.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );
  return matched_if_let_expr_type(
    expr,
    branch_ctx,
    ctx,
    hooks,
    infer_expr_type,
  );
}

function matched_if_let_expr_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  then_ctx: ctx,
  else_ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  infer_expr_type: CoreInferExprType<ctx, block_ctx>,
): ValType {
  const then_exits = core_expr_definitely_exits(expr.then_branch);
  const else_exits = core_expr_definitely_exits(expr.else_branch);

  if (then_exits && else_exits) {
    return "i32";
  }

  if (then_exits) {
    return infer_expr_type(expr.else_branch, else_ctx, hooks);
  }

  const then_type = infer_expr_type(expr.then_branch, then_ctx, hooks);

  if (expr.implicit_else) {
    return then_type;
  }

  if (else_exits) {
    return then_type;
  }

  const else_type = infer_expr_type(expr.else_branch, else_ctx, hooks);
  expect(then_type === else_type, "Core if let branch type mismatch");
  return then_type;
}

function implicit_core_if_let_then_type<
  ctx extends CoreExprTypeCtx,
  block_ctx extends ctx & CoreExprTypeBlockCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreExprTypeHooks<ctx, block_ctx>,
  infer_expr_type: CoreInferExprType<ctx, block_ctx>,
): ValType | undefined {
  if (!expr.implicit_else) {
    return undefined;
  }

  const type_expr = union_case.type_expr;

  if (!type_expr) {
    return undefined;
  }

  const type_value = hooks.static_type_value(type_expr, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  const matched = find_core_type_field(type_value.cases, expr.case_name);

  if (!matched) {
    throw new Error("Missing union case: " + expr.case_name);
  }

  const branch_ctx = hooks.create_block_ctx(ctx);

  if (expr.value_name) {
    if (matched.type_name === "Unit") {
      throw new Error("Union case has no payload: " + expr.case_name);
    }

    const payload_type = core_val_type_from_type_name(matched.type_name);
    expect(
      payload_type,
      "Core if let payload must have a scalar type: " + matched.type_name,
    );
    set_local(branch_ctx.locals, expr.value_name, payload_type);
    branch_ctx.statics.delete(expr.value_name);
    branch_ctx.fn_types.delete(expr.value_name);
    branch_ctx.union_locals.delete(expr.value_name);

    if (matched.type_name === "Text" || matched.type_name === "Bytes") {
      branch_ctx.text_locals.add(expr.value_name);
    } else {
      branch_ctx.text_locals.delete(expr.value_name);
    }
  }

  return infer_expr_type(expr.then_branch, branch_ctx, hooks);
}
