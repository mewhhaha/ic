import { expect } from "../../expect.ts";
import type { CoreExpr } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import { substitute_core_call_expr } from "../substitute.ts";
import { core_lam_capture_info } from "./info.ts";
import type {
  CoreCaptureHooks,
  CoreCaptureTempCtx,
  CoreLamCapturePlan,
} from "./types.ts";

export function plan_core_lam_capture<ctx extends CoreCaptureTempCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
  emit_setup: boolean,
  hooks: CoreCaptureHooks<ctx>,
): CoreLamCapturePlan | undefined {
  if (expr.is_linear_closure) {
    return undefined;
  }

  const capture_info = core_lam_capture_info(expr, ctx, hooks);

  if (capture_info.invalid_assignment) {
    return undefined;
  }

  if (capture_info.names.length === 0) {
    return { value: expr, setup: "" };
  }

  const setup: string[] = [];
  const replacements = new Map<string, CoreExpr>();

  for (const name of capture_info.names) {
    const type = ctx.locals.get(name);
    expect(type, "Missing captured core local: " + name);
    const capture_name = fresh_temp_local(ctx, "capture_" + name);
    set_local(ctx.locals, capture_name, type);

    if (ctx.text_locals.has(name)) {
      ctx.text_locals.add(capture_name);
    } else {
      ctx.text_locals.delete(capture_name);
    }

    if (ctx.frozen_locals) {
      if (ctx.frozen_locals.has(name)) {
        ctx.frozen_locals.add(capture_name);
      } else {
        ctx.frozen_locals.delete(capture_name);
      }
    }

    const union_type = ctx.union_locals.get(name);

    if (union_type) {
      ctx.union_locals.set(capture_name, union_type);
    } else {
      ctx.union_locals.delete(capture_name);
    }

    const struct_type = ctx.struct_locals.get(name);

    if (struct_type) {
      ctx.struct_locals.set(capture_name, struct_type);
    } else {
      ctx.struct_locals.delete(capture_name);
    }

    const fn_type = ctx.fn_types.get(name);

    if (fn_type) {
      ctx.fn_types.set(capture_name, fn_type);
    } else {
      ctx.fn_types.delete(capture_name);
    }

    replacements.set(name, { tag: "var", name: capture_name });

    if (emit_setup) {
      setup.push("local.get $" + name);
      setup.push("local.set $" + capture_name);
    }
  }

  return {
    value: {
      tag: "lam",
      params: expr.params,
      body: substitute_core_call_expr(expr.body, replacements),
    },
    setup: setup.join("\n"),
  };
}
