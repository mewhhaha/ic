import type {
  CoreBackendControlFlow,
  CoreBackendControlFlowApi,
} from "./control_flow/types.ts";
import {
  create_core_backend_control_flow_if_let,
} from "./control_flow/if_let.ts";
import {
  create_core_backend_control_flow_if_stmt,
} from "./control_flow/if_stmt.ts";
import { create_core_backend_control_flow_loop } from "./control_flow/loop.ts";

export type { CoreBackendControlFlow, CoreBackendControlFlowApi };

export function create_core_backend_control_flow(
  api: CoreBackendControlFlowApi,
): CoreBackendControlFlow {
  const loop = create_core_backend_control_flow_loop(api);
  const if_stmt = create_core_backend_control_flow_if_stmt(api);
  const if_let = create_core_backend_control_flow_if_let(
    api,
    if_stmt.merge_if_else_static_assignments,
  );

  return {
    ...loop,
    ...if_let,
    ...if_stmt,
  };
}
