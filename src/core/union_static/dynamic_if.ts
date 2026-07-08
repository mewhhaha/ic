import type { CoreExpr } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import { static_core_call_branch_app } from "../static_call.ts";
import { scoped_union_static_call_value } from "./static_call.ts";
import { static_union_case } from "./static_case.ts";
import type { CoreUnionCtx, CoreUnionHooks } from "./types.ts";

export function dynamic_union_if<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): DynamicUnionIf | undefined {
  if (expr.tag === "rec" || expr.tag === "rec_ref" || expr.tag === "lam") {
    return undefined;
  }
  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return dynamic_union_if(inlined, ctx, hooks);
  }

  const scoped = scoped_union_static_call_value(expr, ctx, hooks);

  if (scoped) {
    return dynamic_union_if(scoped.value, scoped.ctx, hooks);
  }

  if (expr.tag === "app") {
    const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

    if (branch_static_call) {
      return dynamic_union_if(branch_static_call, ctx, hooks);
    }
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value) {
      return dynamic_union_if(value, ctx, hooks);
    }
  }

  if (expr.tag === "block") {
    const stmt = expr.statements[0];

    if (!stmt) {
      return undefined;
    }

    if (expr.statements.length !== 1) {
      return undefined;
    }

    if (stmt.tag === "expr") {
      return dynamic_union_if(stmt.expr, ctx, hooks);
    }

    if (stmt.tag === "return") {
      return dynamic_union_if(stmt.value, ctx, hooks);
    }

    return undefined;
  }

  if (expr.tag !== "if") {
    return undefined;
  }

  const then_case = static_union_case(expr.then_branch, ctx, hooks);

  if (!then_case) {
    return undefined;
  }

  const else_case = static_union_case(expr.else_branch, ctx, hooks);

  if (!else_case) {
    return undefined;
  }

  return { cond: expr.cond, then_case, else_case };
}

export function dynamic_if_let_can_match(
  case_name: string,
  target: DynamicUnionIf,
): boolean {
  return target.then_case.name === case_name ||
    target.else_case.name === case_name;
}
