import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import { indent_lines } from "./emit/format.ts";

export type CoreRangeLoopCtx = {
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  continue_label: string | undefined;
  scratch_loop_resets: string[];
};

export type CoreRangeLoopHooks<ctx extends CoreRangeLoopCtx> = {
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
};

export function range_end_local(id: number): string {
  return "_range_end#" + id.toString();
}

export function range_step_local(id: number): string {
  return "_range_step#" + id.toString();
}

export function emit_core_range_loop<ctx extends CoreRangeLoopCtx>(
  stmt: Extract<CoreStmt, { tag: "range_loop" }>,
  ctx: ctx,
  hooks: CoreRangeLoopHooks<ctx>,
): Wat {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const exit_label = "range_exit_" + id.toString();
  const loop_label = "range_loop_" + id.toString();
  const continue_label = "range_continue_" + id.toString();
  const end_local = range_end_local(id);
  const step_local = range_step_local(id);
  const body_ctx: ctx = {
    ...ctx,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
    break_label: exit_label,
    continue_label,
    scratch_loop_resets: [],
  };
  const body: string[] = [];

  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, body_ctx, false));
  }

  ctx.next_loop = body_ctx.next_loop;
  ctx.next_temp = body_ctx.next_temp;

  return [
    hooks.emit_expr(stmt.start, ctx),
    "local.set $" + stmt.index,
    hooks.emit_expr(stmt.end, ctx),
    "local.set $" + end_local,
    hooks.emit_expr(stmt.step, ctx),
    "local.set $" + step_local,
    "local.get $" + step_local,
    "i32.eqz",
    "if",
    "  unreachable",
    "end",
    "block $" + exit_label,
    "  loop $" + loop_label,
    indent_lines(
      emit_range_done_condition(stmt.index, end_local, step_local),
      4,
    ),
    "    br_if $" + exit_label,
    "    block $" + continue_label,
    indent_lines(body.join("\n"), 6),
    "    end",
    "    local.get $" + stmt.index,
    "    local.get $" + step_local,
    "    i32.add",
    "    local.set $" + stmt.index,
    "    br $" + loop_label,
    "  end",
    "end",
  ].join("\n");
}

function emit_range_done_condition(
  index: string,
  end_local: string,
  step_local: string,
): Wat {
  return [
    "local.get $" + step_local,
    "i32.const 0",
    "i32.gt_s",
    "if (result i32)",
    "  local.get $" + index,
    "  local.get $" + end_local,
    "  i32.ge_s",
    "else",
    "  local.get $" + index,
    "  local.get $" + end_local,
    "  i32.le_s",
    "end",
  ].join("\n");
}
