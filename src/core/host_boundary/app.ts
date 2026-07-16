import type { CoreExpr, CoreHostImport } from "../ast.ts";
import {
  core_host_import_for_app,
  type CoreHostImportCtx,
} from "../host_import.ts";
import {
  static_core_call_branch_app,
  type StaticCoreCallCtx,
} from "../static_call.ts";
import { host_boundary_arg_ownership } from "./alias.ts";
import {
  host_boundary_arg_decision,
  host_boundary_decision,
  host_import_has_ownership_transfer,
} from "./decision.ts";
import {
  host_boundary_app_with_func_alias,
  type HostBoundaryExprScanner,
  scan_static_host_boundary_call,
  static_host_boundary_app_target,
} from "./static_call.ts";
import type {
  CoreHostBoundaryArg,
  CoreHostBoundaryHooks,
  CoreHostBoundaryState,
} from "./types.ts";
import { is_core_runtime_buffer_builtin_name } from "../runtime_buffer.ts";

export function scan_host_boundary_app<
  ctx extends CoreHostImportCtx & StaticCoreCallCtx,
>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  state: CoreHostBoundaryState,
  scan_expr: HostBoundaryExprScanner<ctx>,
): void {
  const app = host_boundary_app_with_func_alias(expr, state);
  const branch_static_call = static_core_call_branch_app(app, ctx, hooks);

  if (branch_static_call) {
    scan_expr(branch_static_call, ctx, hooks, state);
    return;
  }

  scan_expr(expr.func, ctx, hooks, state);

  for (const arg of expr.args) {
    scan_expr(arg, ctx, hooks, state);
  }

  const state_target = static_host_boundary_app_target(app, state);

  if (
    state_target &&
    scan_static_host_boundary_call(
      app,
      state_target,
      ctx,
      hooks,
      state,
      scan_expr,
    )
  ) {
    return;
  }

  const target = hooks.static_core_call_target(app.func, ctx);

  if (
    target &&
    scan_static_host_boundary_call(
      app,
      target,
      ctx,
      hooks,
      state,
      scan_expr,
    )
  ) {
    return;
  }

  const rec_target = hooks.static_core_rec_target(app.func, ctx);

  if (
    rec_target &&
    scan_static_host_boundary_call(
      app,
      rec_target,
      ctx,
      hooks,
      state,
      scan_expr,
    )
  ) {
    return;
  }

  const signature = core_host_import_for_app(app, ctx);

  if (
    signature &&
    state.static_wrapper_depth > 0 &&
    host_import_has_ownership_transfer(signature)
  ) {
    return;
  }

  if (core_app_is_known(app, ctx, hooks, signature)) {
    return;
  }

  if (app.func.tag !== "var") {
    return;
  }

  const args = host_boundary_args(app, ctx, hooks, signature, state);
  const decision = host_boundary_decision(app.func.name, args, signature);
  const id = "host#" + state.next_host.toString();
  state.next_host += 1;

  state.edges.push({
    id,
    callee: app.func.name,
    signature,
    args,
    decision,
  });
}

function core_app_is_known<ctx extends CoreHostImportCtx & StaticCoreCallCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  signature: CoreHostImport | undefined,
): boolean {
  if (expr.func.tag === "var" && expr.func.name === "rec") {
    return true;
  }

  if (expr.func.tag === "var" && core_builtin_app_name(expr.func.name)) {
    return true;
  }

  if (signature) {
    return false;
  }

  if (hooks.static_core_rec_target(expr.func, ctx)) {
    return true;
  }

  if (hooks.static_core_call_value(expr, ctx)) {
    return true;
  }

  if (hooks.static_core_call_target(expr.func, ctx)) {
    return true;
  }

  if (hooks.closure_fn_type(expr.func, ctx)) {
    return true;
  }

  return false;
}

function core_builtin_app_name(name: string): boolean {
  if (name === "@len") {
    return true;
  }

  if (name === "@get") {
    return true;
  }

  if (name === "@slice") {
    return true;
  }

  if (name === "@panic") {
    return true;
  }

  if (name === "@append") {
    return true;
  }

  if (name === "@Bytes.generate") {
    return true;
  }

  if (is_core_runtime_buffer_builtin_name(name)) {
    return true;
  }

  if (name === "@runtime_i32_slice" || name === "@runtime_text_slice") {
    return true;
  }

  return false;
}

function host_boundary_args<ctx extends CoreHostImportCtx & StaticCoreCallCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreHostBoundaryHooks<ctx>,
  signature: CoreHostImport | undefined,
  state: CoreHostBoundaryState,
): CoreHostBoundaryArg[] {
  const args: CoreHostBoundaryArg[] = [];

  for (let index = 0; index < expr.args.length; index += 1) {
    const arg = expr.args[index];

    if (!arg) {
      throw new Error("Missing host/import argument " + index.toString());
    }

    const ownership = host_boundary_arg_ownership(arg, ctx, hooks, state);

    args.push({
      index,
      ownership,
      decision: host_boundary_arg_decision(ownership, signature, index),
    });
  }

  return args;
}
