import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { indent_lines } from "../emit/format.ts";
import { set_local } from "../emit/local.ts";
import type { RuntimeUnionTarget } from "../runtime_union.ts";
import { emit_runtime_union_match_payload_setup } from "../runtime_union_payload_emit.ts";
import type { RuntimeUnionIfLetCtx, RuntimeUnionIfLetHooks } from "./types.ts";
import { core_expr_is_borrowed } from "../local_facts.ts";

export function emit_runtime_union_if_let_stmt<
  ctx extends RuntimeUnionIfLetCtx,
>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  target: RuntimeUnionTarget,
  ctx: ctx,
  hooks: RuntimeUnionIfLetHooks<ctx>,
): Wat {
  const target_code = hooks.emit_expr(target.target, ctx);
  const local_name = runtime_union_match_local(ctx);
  set_local(ctx.locals, local_name, "i32");
  const cond_name = fresh_temp_local(ctx, "if_cond");
  set_local(ctx.locals, cond_name, "i32");
  const else_statics = new Map(ctx.statics);
  const info = hooks.runtime_union_match_info(stmt.case_name, target, ctx);
  const binding = hooks.match_branch_ctx(stmt.value_name, info, ctx);
  const branch_ctx = binding.ctx;
  bind_borrowed_payload(stmt.value_name, target.target, ctx, branch_ctx);
  const body: string[] = [];
  const payload_setup = emit_runtime_union_match_payload_setup(
    local_name,
    stmt.value_name,
    info,
    binding.fields,
  );

  if (payload_setup !== "") {
    body.push(payload_setup);
  }

  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, branch_ctx, false));
  }

  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;
  for (const name of branch_ctx.text_locals) {
    if (name.startsWith("_") && name.includes("#")) {
      ctx.text_locals.add(name);
    }
  }
  for (const [name, value] of branch_ctx.struct_locals) {
    if (name.startsWith("_") && name.includes("#")) {
      ctx.struct_locals.set(name, value);
    }
  }
  for (const [name, value] of branch_ctx.union_locals) {
    if (name.startsWith("_") && name.includes("#")) {
      ctx.union_locals.set(name, value);
    }
  }
  for (const [name, value] of branch_ctx.fn_types) {
    if (name.startsWith("_") && name.includes("#")) {
      ctx.fn_types.set(name, value);
    }
  }
  if (branch_ctx.frozen_locals) {
    if (!ctx.frozen_locals) {
      ctx.frozen_locals = new Set();
    }
    for (const name of branch_ctx.frozen_locals) {
      if (name.startsWith("_") && name.includes("#")) {
        ctx.frozen_locals.add(name);
      }
    }
  }
  const merge_setup = hooks.merge_if_else_static_assignments(
    stmt,
    { tag: "var", name: cond_name },
    branch_ctx.statics,
    else_statics,
    ctx,
    ctx,
  );
  const lines = [
    target_code,
    "local.set $" + local_name,
    "local.get $" + local_name,
    "i32.load",
    "i32.const " + info.tag_value.toString(),
    "i32.eq",
    "local.set $" + cond_name,
    "local.get $" + cond_name,
    "if",
    indent_lines(body.join("\n"), 2),
    "end",
  ];

  if (merge_setup !== "") {
    lines.push(merge_setup);
  }

  return lines.join("\n");
}

export function emit_runtime_union_if_let_expr<
  ctx extends RuntimeUnionIfLetCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  target: RuntimeUnionTarget,
  ctx: ctx,
  hooks: RuntimeUnionIfLetHooks<ctx>,
): Wat {
  const result_type = hooks.expr_type(expr, ctx);
  const target_code = hooks.emit_expr(target.target, ctx);
  const local_name = runtime_union_match_local(ctx);
  set_local(ctx.locals, local_name, "i32");
  const info = hooks.runtime_union_match_info(expr.case_name, target, ctx);
  const binding = hooks.match_branch_ctx(expr.value_name, info, ctx);
  const branch_ctx = binding.ctx;
  bind_borrowed_payload(expr.value_name, target.target, ctx, branch_ctx);
  const then_lines: string[] = [];
  const payload_setup = emit_runtime_union_match_payload_setup(
    local_name,
    expr.value_name,
    info,
    binding.fields,
  );

  if (payload_setup !== "") {
    then_lines.push(payload_setup);
  }

  then_lines.push(hooks.emit_expr(expr.then_branch, branch_ctx));
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;

  let else_branch: Wat;

  if (expr.implicit_else) {
    if (hooks.core_expr_is_text(expr, ctx)) {
      else_branch = hooks.emit_expr({ tag: "text", value: "" }, ctx);
    } else {
      else_branch = result_type + ".const 0";
    }
  } else {
    else_branch = hooks.emit_expr(expr.else_branch, ctx);
  }

  return [
    target_code,
    "local.set $" + local_name,
    "local.get $" + local_name,
    "i32.load",
    "i32.const " + info.tag_value.toString(),
    "i32.eq",
    "if (result " + result_type + ")",
    indent_lines(then_lines.join("\n"), 2),
    "else",
    indent_lines(else_branch, 2),
    "end",
  ].join("\n");
}

function bind_borrowed_payload<ctx extends RuntimeUnionIfLetCtx>(
  value_name: string | undefined,
  target: CoreExpr,
  source_ctx: ctx,
  branch_ctx: ctx,
): void {
  if (!value_name || !branch_ctx.borrowed_locals) {
    return;
  }

  if (core_expr_is_borrowed(target, source_ctx)) {
    branch_ctx.borrowed_locals.add(value_name);
  }
}

function runtime_union_match_local<ctx extends RuntimeUnionIfLetCtx>(
  ctx: ctx,
): string {
  const generated = fresh_temp_local(ctx, "union_match");

  if (ctx.locals.has(generated)) {
    return generated;
  }

  const prefix = "_union_match#";
  let found: string | undefined;
  let found_index: number | undefined;

  for (const name of ctx.locals.keys()) {
    if (!name.startsWith(prefix)) {
      continue;
    }

    const index = Number(name.slice(prefix.length));
    if (!Number.isInteger(index)) {
      continue;
    }

    if (index < ctx.next_temp - 1) {
      continue;
    }

    if (found_index !== undefined && found_index <= index) {
      continue;
    }

    found = name;
    found_index = index;
  }

  if (found_index !== undefined) {
    ctx.next_temp = found_index + 1;
  }

  if (found) {
    return found;
  }

  return generated;
}
