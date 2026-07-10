import type { CoreExpr } from "../ast.ts";
import { record_allocation } from "./record.ts";
import type {
  CoreAllocationHooks,
  CoreAllocationScope,
  CoreAllocationState,
} from "./types.ts";

type AllocationExprScanner<ctx> = (
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
) => void;

export function record_runtime_union_allocations<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  scan_expr: AllocationExprScanner<ctx>,
): void {
  if (value.tag === "if") {
    record_runtime_union_allocations(
      value.then_branch,
      scope,
      ctx,
      hooks,
      state,
      scan_expr,
    );
    record_runtime_union_allocations(
      value.else_branch,
      scope,
      ctx,
      hooks,
      state,
      scan_expr,
    );
    return;
  }

  const parent = record_allocation(value, "runtime_union", scope, state);

  if (value.tag !== "union_case") {
    return;
  }

  if (value.type_expr) {
    scan_expr(value.type_expr, scope, ctx, hooks, state);
  }

  if (value.value) {
    const child_start = state.facts.length;
    scan_expr(value.value, scope, ctx, hooks, state);

    if (
      parent && parent.storage === "persistent_unique_heap" &&
      hooks.closure_fn_type(value.value, ctx)
    ) {
      const children = state.facts.slice(child_start).filter((fact) => {
        return fact.reason === "closure" &&
          fact.storage === "persistent_unique_heap" &&
          fact.ownership.tag === "unique_heap";
      });
      if (children.length === 1) {
        const child = children[0];

        if (child && child.ownership.tag === "unique_heap") {
          const owned_children = parent.owned_children || [];
          owned_children.push({
            allocation_ids: [child.allocation_id],
            offset: 4,
            ownership: child.ownership,
            layout: child.layout,
          });
          parent.owned_children = owned_children;
        }
      }
    }
  }
}
