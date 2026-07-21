import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreFnType } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { set_local } from "../emit/local.ts";
import { unsupported_core_captured_assignment_message } from "../closure_capture.ts";
import { core_expr_assigns_name } from "../scope_analysis.ts";
import { scoped_static_core_call_expr } from "../static_call_rewrite.ts";
import { static_block_result } from "../type_static.ts";
import type { StaticValuePlan } from "../static_values/types.ts";
import { check_static_core_call_arity } from "./arity.ts";
import { core_name_use_count } from "../name_use_count.ts";
import type {
  StaticCoreCallBlockCtx,
  StaticCoreCallCtx,
  StaticCoreCallHooks,
  StaticCoreCallTempCtx,
} from "./types.ts";

export function collect_scoped_static_core_call_locals<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: block_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): void {
  const plan = scoped_static_core_call_plan<
    static_ctx,
    temp_ctx,
    block_ctx,
    emit_ctx
  >(
    expr,
    target,
    ctx,
    undefined,
    ctx,
    hooks,
  );
  hooks.collect_expr_locals(plan.value, ctx);
}

export function scoped_static_core_call_value<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): { value: CoreExpr; ctx: block_ctx } {
  const body_ctx = hooks.create_scoped_static_core_call_ctx(ctx);
  const plan = scoped_static_core_call_plan<
    static_ctx,
    temp_ctx,
    block_ctx,
    emit_ctx
  >(
    expr,
    target,
    body_ctx,
    undefined,
    undefined,
    hooks,
  );

  return {
    value: plan.value,
    ctx: body_ctx,
  };
}

export function emit_scoped_static_core_call<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: emit_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): Wat {
  const plan = scoped_static_core_call_plan<
    static_ctx,
    temp_ctx,
    block_ctx,
    emit_ctx
  >(expr, target, ctx, ctx, undefined, hooks);
  const lines: string[] = [];

  if (plan.setup !== "") {
    lines.push(plan.setup);
  }

  lines.push(hooks.emit_expr(plan.value, ctx));
  return lines.join("\n");
}

export function scoped_static_core_call_type<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): ValType {
  const body_ctx = scoped_static_core_call_ctx(expr, target, ctx, hooks);
  return hooks.expr_type(target.body, body_ctx);
}

export function scoped_static_core_call_fn_type<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): CoreFnType | undefined {
  const body_ctx = scoped_static_core_call_ctx(expr, target, ctx, hooks);
  return hooks.closure_fn_type(target.body, body_ctx);
}

function scoped_static_core_call_ctx<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: static_ctx,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): block_ctx {
  check_static_core_call_arity(expr, target);
  const body_ctx = hooks.create_scoped_static_core_call_ctx(ctx);

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core static call parameter " + index.toString());
    expect(arg, "Missing core static call argument " + index.toString());
    const value = hooks.apply_core_parameter_annotation(param, arg, ctx);
    const assigns_param = core_expr_assigns_name(target.body, param.name);
    let runtime_value = value;
    if (
      (arg.tag === "var" || arg.tag === "linear") &&
      (ctx.locals.has(arg.name) ||
        ctx.materialized_bindings?.has(arg.name) === true)
    ) {
      runtime_value = arg;
    }
    const runtime_local =
      (runtime_value.tag === "var" || runtime_value.tag === "linear") &&
      (ctx.locals.has(runtime_value.name) ||
        ctx.materialized_bindings?.has(runtime_value.name) === true);
    const uses = core_name_use_count(target.body, param.name);
    const share_repeated_demand = uses > 1 && !runtime_local &&
      runtime_value.tag !== "num" && runtime_value.tag !== "var" &&
      runtime_value.tag !== "linear" && runtime_value.tag !== "type_name";

    if (assigns_param) {
      const struct_value = hooks.static_struct_value(value, ctx);

      if (struct_value) {
        body_ctx.locals.delete(param.name);
        body_ctx.statics.set(param.name, struct_value);
        body_ctx.fn_types.delete(param.name);
        body_ctx.text_locals.delete(param.name);
        body_ctx.struct_locals.delete(param.name);
        body_ctx.union_locals.delete(param.name);
        continue;
      }
    }

    if (
      !assigns_param && !runtime_local && !share_repeated_demand &&
      hooks.is_static_value_expr(value, ctx)
    ) {
      const planned = hooks.plan_static_value_expr(
        value,
        body_ctx,
        undefined,
      );
      body_ctx.locals.delete(param.name);
      body_ctx.statics.set(param.name, planned.value);
      body_ctx.fn_types.delete(param.name);
      body_ctx.text_locals.delete(param.name);
      body_ctx.struct_locals.delete(param.name);
      body_ctx.union_locals.delete(param.name);
    } else if (!assigns_param && param.is_const) {
      const function_value = static_core_function_value(value, ctx);

      if (function_value) {
        body_ctx.locals.delete(param.name);
        body_ctx.statics.set(param.name, function_value);
        body_ctx.fn_types.delete(param.name);
        body_ctx.text_locals.delete(param.name);
        body_ctx.struct_locals.delete(param.name);
        body_ctx.union_locals.delete(param.name);
      } else {
        body_ctx.statics.delete(param.name);
        set_local(
          body_ctx.locals,
          param.name,
          hooks.expr_type(runtime_value, ctx),
        );
        hooks.bind_core_struct_type(
          param.name,
          runtime_value,
          param.annotation,
          body_ctx,
        );
        hooks.bind_core_union_type(
          param.name,
          runtime_value,
          param.annotation,
          body_ctx,
        );

        if (param.annotation === "Text" || param.annotation === "Bytes") {
          body_ctx.text_locals.add(param.name);
        } else {
          body_ctx.text_locals.delete(param.name);
        }
      }
    } else {
      body_ctx.statics.delete(param.name);
      set_local(
        body_ctx.locals,
        param.name,
        hooks.expr_type(runtime_value, ctx),
      );
      hooks.bind_core_struct_type(
        param.name,
        runtime_value,
        param.annotation,
        body_ctx,
      );
      hooks.bind_core_union_type(
        param.name,
        runtime_value,
        param.annotation,
        body_ctx,
      );

      if (param.annotation === "Text" || param.annotation === "Bytes") {
        body_ctx.text_locals.add(param.name);
      } else {
        body_ctx.text_locals.delete(param.name);
      }
    }

    if (body_ctx.borrowed_locals) {
      if (param.annotation?.startsWith("&")) {
        body_ctx.borrowed_locals.add(param.name);
      } else {
        body_ctx.borrowed_locals.delete(param.name);
      }
    }
  }

  return body_ctx;
}

function scoped_static_core_call_plan<
  static_ctx extends StaticCoreCallCtx,
  temp_ctx extends static_ctx & StaticCoreCallTempCtx,
  block_ctx extends temp_ctx & StaticCoreCallBlockCtx,
  emit_ctx extends temp_ctx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  target: Extract<CoreExpr, { tag: "lam" }>,
  ctx: temp_ctx,
  emit_ctx: emit_ctx | undefined,
  collect_ctx: block_ctx | undefined,
  hooks: StaticCoreCallHooks<static_ctx, temp_ctx, block_ctx, emit_ctx>,
): StaticValuePlan {
  check_static_core_call_arity(expr, target);
  const replacements = new Map<string, CoreExpr>();
  const setup: string[] = [];
  const capture_info = hooks.core_lam_capture_info(target, ctx);

  expect(
    !capture_info.invalid_assignment,
    unsupported_core_captured_assignment_message,
  );

  for (const assigned_name of capture_info.assigned_names) {
    const type = ctx.locals.get(assigned_name);
    expect(type, "Missing assigned captured core local: " + assigned_name);
    const name = fresh_temp_local(ctx, "capture_" + assigned_name);
    ctx.statics.delete(name);
    set_local(ctx.locals, name, type);

    if (ctx.text_locals.has(assigned_name)) {
      ctx.text_locals.add(name);
    } else {
      ctx.text_locals.delete(name);
    }

    const struct_type = ctx.struct_locals.get(assigned_name);

    if (struct_type) {
      ctx.struct_locals.set(name, struct_type);
    } else {
      ctx.struct_locals.delete(name);
    }

    const union_type = ctx.union_locals.get(assigned_name);

    if (union_type) {
      ctx.union_locals.set(name, union_type);
    } else {
      ctx.union_locals.delete(name);
    }

    const fn_type = ctx.fn_types.get(assigned_name);

    if (fn_type) {
      ctx.fn_types.set(name, fn_type);
    }

    replacements.set(assigned_name, { tag: "var", name });

    if (emit_ctx) {
      setup.push("local.get $" + assigned_name);
      setup.push("local.set $" + name);
    }
  }

  for (const assigned_name of capture_info.assigned_static_names) {
    const value = hooks.static_struct_binding(assigned_name, ctx);
    expect(value, "Missing assigned captured core static: " + assigned_name);
    const name = fresh_temp_local(ctx, "capture_" + assigned_name);
    ctx.locals.delete(name);
    ctx.statics.set(name, value);
    ctx.fn_types.delete(name);
    ctx.text_locals.delete(name);
    ctx.struct_locals.delete(name);
    ctx.union_locals.delete(name);
    replacements.set(assigned_name, { tag: "var", name });
  }

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];
    expect(param, "Missing core static call parameter " + index.toString());
    expect(arg, "Missing core static call argument " + index.toString());
    const value = hooks.apply_core_parameter_annotation(param, arg, ctx);
    const assigns_param = core_expr_assigns_name(target.body, param.name);
    let runtime_value = value;
    if (
      (arg.tag === "var" || arg.tag === "linear") &&
      (ctx.locals.has(arg.name) ||
        ctx.materialized_bindings?.has(arg.name) === true)
    ) {
      runtime_value = arg;
    }
    const runtime_local =
      (runtime_value.tag === "var" || runtime_value.tag === "linear") &&
      (ctx.locals.has(runtime_value.name) ||
        ctx.materialized_bindings?.has(runtime_value.name) === true);
    const uses = core_name_use_count(target.body, param.name);
    const share_repeated_demand = uses > 1 && !runtime_local &&
      runtime_value.tag !== "num" && runtime_value.tag !== "var" &&
      runtime_value.tag !== "linear" && runtime_value.tag !== "type_name";

    if (assigns_param) {
      const struct_value = hooks.static_struct_value(value, ctx);

      if (struct_value) {
        const planned = hooks.plan_static_value_expr(
          struct_value,
          ctx,
          emit_ctx,
        );
        const name = fresh_temp_local(ctx, "arg_" + param.name);
        ctx.locals.delete(name);
        ctx.statics.set(name, planned.value);
        ctx.fn_types.delete(name);
        ctx.text_locals.delete(name);
        ctx.struct_locals.delete(name);
        ctx.union_locals.delete(name);
        replacements.set(param.name, { tag: "var", name });

        if (planned.setup !== "") {
          setup.push(planned.setup);
        }

        continue;
      }
    }

    if (
      !assigns_param && !runtime_local && !share_repeated_demand &&
      hooks.is_static_value_expr(value, ctx)
    ) {
      const planned = hooks.plan_static_value_expr(value, ctx, emit_ctx);
      replacements.set(param.name, planned.value);

      if (planned.setup !== "") {
        setup.push(planned.setup);
      }

      continue;
    }

    if (!assigns_param && param.is_const) {
      const function_value = static_core_function_value(value, ctx);

      if (function_value) {
        replacements.set(param.name, function_value);
        continue;
      }
    }

    if (!emit_ctx && !collect_ctx && !assigns_param) {
      replacements.set(param.name, runtime_value);
      continue;
    }

    const type = hooks.expr_type(runtime_value, ctx);
    const name = fresh_temp_local(ctx, "arg_" + param.name);
    ctx.statics.delete(name);
    set_local(ctx.locals, name, type);

    if (ctx.borrowed_locals) {
      if (param.annotation?.startsWith("&")) {
        ctx.borrowed_locals.add(name);
      } else {
        ctx.borrowed_locals.delete(name);
      }
    }

    if (param.annotation === "Text" || param.annotation === "Bytes") {
      ctx.text_locals.add(name);
    } else {
      ctx.text_locals.delete(name);
    }

    hooks.bind_core_struct_type(name, runtime_value, param.annotation, ctx);
    hooks.bind_core_union_type(name, runtime_value, param.annotation, ctx);

    replacements.set(param.name, { tag: "var", name });

    if (emit_ctx) {
      setup.push(hooks.emit_expr(runtime_value, emit_ctx));
      setup.push("local.set $" + name);
    } else if (collect_ctx) {
      hooks.collect_expr_locals(runtime_value, collect_ctx);
    }
  }

  return {
    value: scoped_static_core_call_expr(target.body, replacements, ctx),
    setup: setup.join("\n"),
  };
}

function static_core_function_value<ctx extends StaticCoreCallCtx>(
  value: CoreExpr,
  ctx: ctx,
): Extract<CoreExpr, { tag: "lam" | "rec" }> | undefined {
  if (value.tag === "lam" || value.tag === "rec") {
    return value;
  }

  if (value.tag === "block") {
    const block_value = static_block_result(value);

    if (!block_value) {
      return undefined;
    }

    return static_core_function_value(block_value, ctx);
  }

  if (value.tag === "var") {
    const static_value = ctx.statics.get(value.name);

    if (!static_value) {
      return undefined;
    }

    return static_core_function_value(static_value, ctx);
  }

  return undefined;
}
