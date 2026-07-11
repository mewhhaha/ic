import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { indent_lines } from "./backend/util.ts";
import type { StaticValuePlan } from "./static_values.ts";

export type CoreIfStmtCtx = {
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  next_loop: number;
  next_temp: number;
};

export type CoreIfStmtHooks<ctx extends CoreIfStmtCtx> = {
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  merge_if_else_static_assignments: (
    stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: ctx,
    emit_ctx: ctx,
  ) => Wat;
  plan_static_capture_expr: (
    prefix: string,
    value: CoreExpr,
    ctx: ctx,
    emit_ctx: ctx,
  ) => StaticValuePlan;
};

export function emit_core_if_stmt<ctx extends CoreIfStmtCtx>(
  stmt: Extract<CoreStmt, { tag: "if_stmt" }>,
  ctx: ctx,
  hooks: CoreIfStmtHooks<ctx>,
): Wat {
  const cond_type = hooks.expr_type(stmt.cond, ctx);
  expect(cond_type === "i32", "Core if statement condition must be i32");
  // The condition must be emitted before the body so plan-generated
  // temporary names replay in the order the local-collection pass
  // created them.
  const cond = hooks.emit_expr(stmt.cond, ctx);
  const body: string[] = [];

  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, ctx, false));
  }

  return [
    cond,
    "if",
    indent_lines(body.join("\n"), 2),
    "end",
  ].join("\n");
}

export function emit_core_if_else_stmt<ctx extends CoreIfStmtCtx>(
  stmt: Extract<CoreStmt, { tag: "if_else_stmt" }>,
  ctx: ctx,
  hooks: CoreIfStmtHooks<ctx>,
): Wat {
  const cond_type = hooks.expr_type(stmt.cond, ctx);
  expect(cond_type === "i32", "Core if else statement condition must be i32");
  const planned_cond = hooks.plan_static_capture_expr(
    "if_cond",
    stmt.cond,
    ctx,
    ctx,
  );
  const statics = new Map(ctx.statics);
  const then_ctx: ctx = {
    ...ctx,
    statics: new Map(statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
  };
  const then_body: string[] = [];

  for (const item of stmt.then_body) {
    then_body.push(hooks.emit_stmt(item, then_ctx, false));
  }

  const else_ctx: ctx = {
    ...ctx,
    statics: new Map(statics),
    fn_types: new Map(then_ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    next_loop: then_ctx.next_loop,
    next_temp: then_ctx.next_temp,
  };
  const else_body: string[] = [];

  for (const item of stmt.else_body) {
    else_body.push(hooks.emit_stmt(item, else_ctx, false));
  }

  ctx.next_loop = else_ctx.next_loop;
  ctx.next_temp = else_ctx.next_temp;
  merge_generated_temp_facts(ctx, then_ctx);
  merge_generated_temp_facts(ctx, else_ctx);

  const merge_setup = hooks.merge_if_else_static_assignments(
    stmt,
    planned_cond.value,
    then_ctx.statics,
    else_ctx.statics,
    ctx,
    ctx,
  );
  const lines: string[] = [];

  if (planned_cond.setup !== "") {
    lines.push(planned_cond.setup);
  }

  lines.push(
    hooks.emit_expr(planned_cond.value, ctx),
    "if",
    indent_lines(then_body.join("\n"), 2),
    "else",
    indent_lines(else_body.join("\n"), 2),
    "end",
  );

  if (merge_setup !== "") {
    lines.push(merge_setup);
  }

  return lines.join("\n");
}

function merge_generated_temp_facts<ctx extends CoreIfStmtCtx>(
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
}

function is_generated_temp_name(name: string): boolean {
  return name.startsWith("_") && name.includes("#");
}
