import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { indent_lines } from "./backend/util.ts";

export type DynamicUnionIf = {
  cond: CoreExpr;
  then_case: Extract<CoreExpr, { tag: "union_case" }>;
  else_case: Extract<CoreExpr, { tag: "union_case" }>;
};

export function core_if_let_match_condition(
  target: CoreExpr,
  case_name: string,
): CoreExpr {
  return {
    tag: "if_let",
    target,
    case_name,
    value_name: undefined,
    then_branch: { tag: "num", type: "i32", value: 1 },
    else_branch: { tag: "num", type: "i32", value: 0 },
    implicit_else: false,
  };
}

export type CoreIfLetPayloadBinding<ctx> = {
  setup: Wat;
  ctx: ctx;
};

export type CoreIfLetCtx = {
  fn_types: Map<string, CoreFnType>;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  next_loop: number;
  next_temp: number;
};

export type CoreIfLetHooks<ctx extends CoreIfLetCtx> = {
  bind_payload: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => CoreIfLetPayloadBinding<ctx>;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: ctx,
    emit_ctx: ctx,
  ) => Wat;
  static_union_case: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export function emit_core_if_let_stmt<ctx extends CoreIfLetCtx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  const union_case = hooks.static_union_case(stmt.target, ctx);

  if (union_case) {
    if (union_case.name !== stmt.case_name) {
      return "";
    }

    const lines: string[] = [];

    const binding = hooks.bind_payload(stmt.value_name, union_case, ctx);
    lines.push(binding.setup);

    for (const item of stmt.body) {
      lines.push(hooks.emit_stmt(item, binding.ctx, false));
    }

    sync_if_let_ctx(ctx, binding.ctx);
    return lines.join("\n");
  }

  const dynamic_target = hooks.dynamic_union_if(stmt.target, ctx);

  if (!dynamic_target) {
    throw new Error("Cannot emit core if_let_stmt statement yet");
  }

  return emit_dynamic_if_let_stmt(stmt, dynamic_target, ctx, hooks);
}

export function emit_core_if_let_expr<ctx extends CoreIfLetCtx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name !== expr.case_name) {
      if (expr.implicit_else) {
        const result_type = hooks.expr_type(expr, ctx);
        return emit_core_if_let_implicit_else(expr, result_type, ctx, hooks);
      }

      return hooks.emit_expr(expr.else_branch, ctx);
    }

    const lines: string[] = [];

    const binding = hooks.bind_payload(expr.value_name, union_case, ctx);
    lines.push(binding.setup);

    lines.push(hooks.emit_expr(expr.then_branch, binding.ctx));
    sync_if_let_ctx(ctx, binding.ctx);
    return lines.join("\n");
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (!dynamic_target) {
    throw new Error("Cannot emit core if_let expression yet");
  }

  return emit_dynamic_if_let_expr(expr, dynamic_target, ctx, hooks);
}

function emit_dynamic_if_let_stmt<ctx extends CoreIfLetCtx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  const cond_type = hooks.expr_type(target.cond, ctx);
  expect(cond_type === "i32", "Core dynamic if let condition must be i32");
  const cond = hooks.emit_expr(target.cond, ctx);
  const base_statics = new Map(ctx.statics);
  const then_body = emit_dynamic_if_let_stmt_case(
    stmt,
    target.then_case,
    ctx,
    hooks,
  );
  let then_statics = base_statics;
  if (then_body.matched) {
    then_statics = then_body.ctx.statics;
  }

  sync_if_let_ctx(ctx, then_body.ctx);
  const else_body = emit_dynamic_if_let_stmt_case(
    stmt,
    target.else_case,
    ctx,
    hooks,
  );
  let else_statics = base_statics;
  if (else_body.matched) {
    else_statics = else_body.ctx.statics;
  }

  sync_if_let_ctx(ctx, else_body.ctx);
  merge_generated_temp_facts(ctx, then_body.ctx);
  merge_generated_temp_facts(ctx, else_body.ctx);
  const merge_setup = hooks.merge_if_else_static_assignments(
    stmt,
    target.cond,
    then_statics,
    else_statics,
    ctx,
    ctx,
  );
  const lines = [
    cond,
    "if",
    indent_lines(then_body.body, 2),
    "else",
    indent_lines(else_body.body, 2),
    "end",
  ];

  if (merge_setup !== "") {
    lines.push(merge_setup);
  }

  return lines.join("\n");
}

function emit_dynamic_if_let_stmt_case<ctx extends CoreIfLetCtx>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): { body: Wat; ctx: ctx; matched: boolean } {
  if (union_case.name !== stmt.case_name) {
    return { body: "", ctx, matched: false };
  }

  const lines: string[] = [];

  const binding = hooks.bind_payload(stmt.value_name, union_case, ctx);
  lines.push(binding.setup);

  for (const item of stmt.body) {
    lines.push(hooks.emit_stmt(item, binding.ctx, false));
  }

  return { body: lines.join("\n"), ctx: binding.ctx, matched: true };
}

function emit_dynamic_if_let_expr<ctx extends CoreIfLetCtx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  const result_type = hooks.expr_type(expr, ctx);
  const cond = hooks.emit_expr(target.cond, ctx);
  const then_branch = emit_dynamic_if_let_expr_case(
    expr,
    target.then_case,
    result_type,
    ctx,
    hooks,
  );
  const else_branch = emit_dynamic_if_let_expr_case(
    expr,
    target.else_case,
    result_type,
    ctx,
    hooks,
  );

  return [
    cond,
    "if (result " + result_type + ")",
    indent_lines(then_branch, 2),
    "else",
    indent_lines(else_branch, 2),
    "end",
  ].join("\n");
}

function emit_dynamic_if_let_expr_case<ctx extends CoreIfLetCtx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  result_type: ValType,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  if (union_case.name !== expr.case_name) {
    if (expr.implicit_else) {
      return emit_core_if_let_implicit_else(
        expr,
        result_type,
        ctx,
        hooks,
      );
    }

    return hooks.emit_expr(expr.else_branch, ctx);
  }

  const lines: string[] = [];

  const binding = hooks.bind_payload(expr.value_name, union_case, ctx);
  lines.push(binding.setup);

  lines.push(hooks.emit_expr(expr.then_branch, binding.ctx));
  sync_if_let_ctx(ctx, binding.ctx);
  return lines.join("\n");
}

function emit_core_if_let_implicit_else<ctx extends CoreIfLetCtx>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  result_type: ValType,
  ctx: ctx,
  hooks: CoreIfLetHooks<ctx>,
): Wat {
  if (hooks.core_expr_is_text(expr, ctx)) {
    return hooks.emit_expr({ tag: "text", value: "" }, ctx);
  }

  return result_type + ".const 0";
}

function sync_if_let_ctx<ctx extends CoreIfLetCtx>(
  target: ctx,
  source: ctx,
): void {
  target.next_loop = source.next_loop;
  target.next_temp = source.next_temp;
}

function merge_generated_temp_facts<ctx extends CoreIfLetCtx>(
  target: ctx,
  source: ctx,
): void {
  for (const name of source.text_locals) {
    if (is_generated_temp_name(name)) {
      target.text_locals.add(name);
    }
  }

  for (const [name, value] of source.struct_locals) {
    if (is_generated_temp_name(name)) {
      target.struct_locals.set(name, value);
    }
  }

  for (const [name, value] of source.union_locals) {
    if (is_generated_temp_name(name)) {
      target.union_locals.set(name, value);
    }
  }

  for (const [name, value] of source.fn_types) {
    if (is_generated_temp_name(name)) {
      target.fn_types.set(name, value);
    }
  }

  if (!source.frozen_locals) {
    return;
  }

  if (!target.frozen_locals) {
    target.frozen_locals = new Set();
  }

  for (const name of source.frozen_locals) {
    if (is_generated_temp_name(name)) {
      target.frozen_locals.add(name);
    }
  }
}

function is_generated_temp_name(name: string): boolean {
  return name.startsWith("_") && name.includes("#");
}
