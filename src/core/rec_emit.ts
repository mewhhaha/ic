import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreParam, CoreStmt } from "./ast.ts";
import { indent_lines } from "./emit/format.ts";

export type CoreRecEmitCtx = {
  next_loop: number;
  next_temp: number;
};

export type CoreRecEmitHooks<ctx extends CoreRecEmitCtx> = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    arg: CoreExpr,
    ctx: ctx,
  ) => CoreExpr;
  check_rec_tail_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: ctx,
  ) => void;
  create_rec_body_ctx: (ctx: ctx) => ctx;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  is_core_rec_tail_call: (
    expr: CoreExpr,
  ) => expr is Extract<CoreExpr, { tag: "app" }>;
  rec_call_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: ctx,
  ) => ValType;
};

export function emit_core_rec_call<ctx extends CoreRecEmitCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: ctx,
  hooks: CoreRecEmitHooks<ctx>,
): Wat {
  const id = ctx.next_loop;
  ctx.next_loop += 1;
  const result_type = hooks.rec_call_type(expr, target, ctx);
  const exit_label = "rec_exit_" + id.toString();
  const loop_label = "rec_loop_" + id.toString();
  const body_ctx = hooks.create_rec_body_ctx(ctx);
  const lines: string[] = [];

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core rec parameter " + index.toString());
    expect(arg, "Missing core rec argument " + index.toString());
    lines.push(
      hooks.emit_expr(
        hooks.apply_core_parameter_annotation(param, arg, ctx),
        ctx,
      ),
    );
    lines.push("local.set $" + param.name);
  }

  lines.push(
    "block $" + exit_label + " (result " + result_type + ")",
    "  loop $" + loop_label,
    indent_lines(
      emit_rec_body_expr(
        target.body,
        target,
        body_ctx,
        exit_label,
        loop_label,
        hooks,
      ),
      4,
    ),
    "    unreachable",
    "  end",
    "  unreachable",
    "end",
  );

  ctx.next_loop = body_ctx.next_loop;
  ctx.next_temp = body_ctx.next_temp;
  return lines.join("\n");
}

function emit_rec_body_expr<ctx extends CoreRecEmitCtx>(
  expr: CoreExpr,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: ctx,
  exit_label: string,
  loop_label: string,
  hooks: CoreRecEmitHooks<ctx>,
): Wat {
  if (hooks.is_core_rec_tail_call(expr)) {
    return emit_rec_tail_call(expr, target, ctx, loop_label, hooks);
  }

  if (expr.tag === "if") {
    return [
      hooks.emit_expr(expr.cond, ctx),
      "if",
      indent_lines(
        emit_rec_body_expr(
          expr.then_branch,
          target,
          ctx,
          exit_label,
          loop_label,
          hooks,
        ),
        2,
      ),
      "else",
      indent_lines(
        emit_rec_body_expr(
          expr.else_branch,
          target,
          ctx,
          exit_label,
          loop_label,
          hooks,
        ),
        2,
      ),
      "end",
    ].join("\n");
  }

  if (expr.tag === "block") {
    return emit_rec_body_block(
      expr.statements,
      target,
      ctx,
      exit_label,
      loop_label,
      hooks,
    );
  }

  return hooks.emit_expr(expr, ctx) + "\nbr $" + exit_label;
}

function emit_rec_body_block<ctx extends CoreRecEmitCtx>(
  statements: CoreStmt[],
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: ctx,
  exit_label: string,
  loop_label: string,
  hooks: CoreRecEmitHooks<ctx>,
): Wat {
  const lines: string[] = [];

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    expect(stmt, "Missing core rec body statement " + index.toString());
    const is_final = index + 1 >= statements.length;

    if (stmt.tag === "expr" && is_final) {
      lines.push(
        emit_rec_body_expr(
          stmt.expr,
          target,
          ctx,
          exit_label,
          loop_label,
          hooks,
        ),
      );
      continue;
    }

    if (stmt.tag === "return") {
      lines.push(
        emit_rec_body_expr(
          stmt.value,
          target,
          ctx,
          exit_label,
          loop_label,
          hooks,
        ),
      );
      break;
    }

    lines.push(hooks.emit_stmt(stmt, ctx, false));
  }

  return lines.join("\n");
}

function emit_rec_tail_call<ctx extends CoreRecEmitCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "rec" }>,
  ctx: ctx,
  loop_label: string,
  hooks: CoreRecEmitHooks<ctx>,
): Wat {
  hooks.check_rec_tail_call_args(expr, target, ctx);
  const lines: string[] = [];

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core rec parameter " + index.toString());
    expect(arg, "Missing core rec argument " + index.toString());
    lines.push(
      hooks.emit_expr(
        hooks.apply_core_parameter_annotation(param, arg, ctx),
        ctx,
      ),
    );
  }

  for (let index = target.params.length - 1; index >= 0; index -= 1) {
    const param = target.params[index];
    expect(param, "Missing core rec parameter " + index.toString());
    lines.push("local.set $" + param.name);
  }

  lines.push("br $" + loop_label);
  return lines.join("\n");
}
