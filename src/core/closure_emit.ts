import { expect } from "../expect.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType } from "./ast.ts";
import { fresh_temp_local } from "./emit/name.ts";
import { set_local } from "./emit/local.ts";
import {
  closure_env_alignment,
  closure_env_size,
  ensure_closure_func_type,
  ensure_lifted_closure,
} from "./closure_lift.ts";
export { emit_lifted_closure_funcs } from "./closure_lift_emit.ts";
import {
  type CoreClosureEmitCtx,
  type CoreClosureEmitHooks,
} from "./closure_runtime.ts";
export {
  closure_heap_global,
  closure_table_name,
  type ClosureCapture,
  type ClosureEmitCtx,
  type CoreClosureEmitCtx,
  type CoreClosureEmitHooks,
  type CoreClosureLiftedBodyInput,
  create_closure_emit_ctx,
  type LiftedClosure,
} from "./closure_runtime.ts";
import { store_instr } from "./memory.ts";
import { emit_persistent_alloc } from "./runtime_allocator.ts";

export function emit_runtime_closure<ctx extends CoreClosureEmitCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  ctx: ctx,
  hooks: CoreClosureEmitHooks<ctx>,
): Wat {
  const fn_type = hooks.closure_fn_type(expr, ctx);
  expect(fn_type, "Cannot emit core lam expression yet");
  return emit_runtime_closure_with_type(expr, fn_type, ctx, hooks);
}

export function emit_runtime_closure_with_type<ctx extends CoreClosureEmitCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureEmitHooks<ctx>,
): Wat {
  const lift = ensure_lifted_closure(expr, fn_type, ctx, hooks);
  const name = fresh_temp_local(ctx, "closure");
  set_local(ctx.locals, name, "i32");
  ctx.heap.needed = true;
  const lines = [
    emit_persistent_alloc(
      ctx,
      expr,
      "i32.const " + closure_env_size(lift).toString(),
      closure_env_alignment(lift),
      "closure",
      "closure_env.table_index_and_capture_slots",
      "closure.value",
    ),
    "local.set $" + name,
    "local.get $" + name,
    "i32.const " + lift.table_index.toString(),
    "i32.store",
  ];

  for (const capture of lift.captures) {
    lines.push("local.get $" + name);
    lines.push(hooks.emit_expr({ tag: "var", name: capture.source_name }, ctx));
    lines.push(store_instr(capture.type, capture.offset));
  }

  lines.push("local.get $" + name);
  return lines.join("\n");
}

export function emit_dynamic_closure_call<ctx extends CoreClosureEmitCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureEmitHooks<ctx>,
): Wat {
  hooks.check_closure_call_args(expr, fn_type, ctx);
  const closures = ctx.closures;
  expect(closures, "Core closure calls require closure emit context");
  const type_name = ensure_closure_func_type(fn_type, closures);
  const name = fresh_temp_local(ctx, "closure_call");
  set_local(ctx.locals, name, "i32");
  const lines = [
    hooks.emit_expr(expr.func, ctx),
    "local.set $" + name,
    "local.get $" + name,
  ];

  for (const arg of expr.args) {
    lines.push(hooks.emit_expr(arg, ctx));
  }

  lines.push(
    "local.get $" + name,
    "i32.load",
    "call_indirect (type $" + type_name + ")",
  );
  return lines.join("\n");
}
