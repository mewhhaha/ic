import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";
import { indent_lines } from "./emit/format.ts";

export type CoreLoopEmitCtx = {
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  break_value_type: ValType | undefined;
  continue_label: string | undefined;
  scratch_loop_resets: string[];
};

export type CoreLoopEmitHooks<ctx extends CoreLoopEmitCtx> = {
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
};

export function emit_core_loop_expr<ctx extends CoreLoopEmitCtx>(
  expr: Extract<CoreExpr, { tag: "loop" }>,
  ctx: ctx,
  hooks: CoreLoopEmitHooks<ctx>,
): Wat {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const exit_label = "loop_exit_" + id.toString();
  const loop_label = "loop_" + id.toString();
  const continue_label = "loop_continue_" + id.toString();
  const result_type = hooks.expr_type(expr, ctx);
  const body_ctx: ctx = {
    ...ctx,
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
    break_label: exit_label,
    break_value_type: result_type,
    continue_label,
    scratch_loop_resets: [],
  };
  const body: string[] = [];

  for (const stmt of expr.body) {
    body.push(hooks.emit_stmt(stmt, body_ctx, false));
  }

  ctx.next_loop = body_ctx.next_loop;
  ctx.next_temp = body_ctx.next_temp;

  return [
    "block $" + exit_label + " (result " + result_type + ")",
    "  loop $" + loop_label + " (result " + result_type + ")",
    "    block $" + continue_label,
    indent_lines(body.join("\n"), 6),
    "    end",
    "    br $" + loop_label,
    "  end",
    "end",
  ].join("\n");
}
