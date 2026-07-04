import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type {
  CoreBackendControlFlow,
  CoreBackendControlFlowApi,
} from "./types.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import {
  emit_core_if_let_expr_dispatch,
  emit_core_if_let_stmt_dispatch,
} from "../../if_let_dispatch.ts";
import {
  bind_core_if_let_payload as bind_core_if_let_payload_with_hooks,
  bind_core_if_let_payload_fact as bind_core_if_let_payload_fact_with_hooks,
} from "../../if_let_payload.ts";
import type { StaticCtx } from "../../local_collect.ts";
import {
  create_core_backend_if_let_dispatch_hooks,
  create_core_backend_if_let_hooks,
  create_core_backend_if_let_payload_hooks,
} from "./if_let/hooks.ts";

export type CoreBackendControlFlowIfLet = Pick<
  CoreBackendControlFlow,
  "bind_core_if_let_payload_fact" | "emit_if_let_expr" | "emit_if_let_stmt"
>;

export function create_core_backend_control_flow_if_let(
  api: CoreBackendControlFlowApi,
  merge_if_else_static_assignments: CoreBackendControlFlow[
    "merge_if_else_static_assignments"
  ],
): CoreBackendControlFlowIfLet {
  const if_let_payload_hooks = create_core_backend_if_let_payload_hooks(api);
  const if_let_hooks = create_core_backend_if_let_hooks(
    api,
    bind_core_if_let_payload,
    merge_if_else_static_assignments,
  );
  const if_let_dispatch_hooks = create_core_backend_if_let_dispatch_hooks(api);

  function bind_core_if_let_payload(
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: CoreEmitCtx,
  ): { setup: Wat; ctx: CoreEmitCtx } {
    return bind_core_if_let_payload_with_hooks(
      value_name,
      union_case,
      ctx,
      if_let_payload_hooks,
    );
  }

  function bind_core_if_let_payload_fact(
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticCtx,
  ): void {
    bind_core_if_let_payload_fact_with_hooks(
      value_name,
      union_case,
      ctx,
      if_let_payload_hooks,
    );
  }

  function emit_if_let_stmt(
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_core_if_let_stmt_dispatch(
      stmt,
      ctx,
      if_let_hooks,
      if_let_dispatch_hooks,
    );
  }

  function emit_if_let_expr(
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_core_if_let_expr_dispatch(
      expr,
      ctx,
      if_let_hooks,
      if_let_dispatch_hooks,
    );
  }

  return {
    bind_core_if_let_payload_fact,
    emit_if_let_expr,
    emit_if_let_stmt,
  };
}
