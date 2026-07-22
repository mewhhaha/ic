import type { CoreExpr, CoreField } from "../ast.ts";
import {
  runtime_union_payload,
  type RuntimeUnionPayload,
} from "../runtime_union_payload.ts";
import { static_type_value, type TypeStaticCtx } from "../type_static.ts";
import { runtime_union_type_layout } from "../runtime_union/size.ts";
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

export function runtime_union_value_materializes(value: CoreExpr): boolean {
  if (value.tag === "union_case") {
    return value.type_expr !== undefined;
  }

  if (value.tag === "if") {
    return runtime_union_value_materializes(value.then_branch) ||
      runtime_union_value_materializes(value.else_branch);
  }

  return false;
}

export function runtime_union_allocation_value<ctx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): CoreExpr | undefined {
  const runtime_value = hooks.runtime_union_value(expr, ctx);
  if (runtime_value) {
    return runtime_value;
  }

  if (expr.tag !== "app" || expr.func.tag !== "field") {
    return undefined;
  }

  const constructor = expr.func;

  const type_value = static_type_value(
    constructor.object,
    ctx as ctx & TypeStaticCtx,
  );
  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  const declared = type_value.cases.find((candidate) => {
    return candidate.name === constructor.name;
  });
  if (!declared) {
    throw new Error("Missing union case: " + constructor.name);
  }

  let value: CoreExpr | undefined;
  if (expr.args.length === 1) {
    value = expr.args[0];
  }

  return {
    tag: "union_case",
    name: constructor.name,
    value,
    type_expr: constructor.object,
  };
}

export function record_runtime_union_allocations<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  scan_expr: AllocationExprScanner<ctx>,
  allocation_instance?: string,
): void {
  if (value.tag === "if") {
    record_runtime_union_allocations(
      value.then_branch,
      scope,
      ctx,
      hooks,
      state,
      scan_expr,
      allocation_instance,
    );
    record_runtime_union_allocations(
      value.else_branch,
      scope,
      ctx,
      hooks,
      state,
      scan_expr,
      allocation_instance,
    );
    return;
  }

  if (value.tag !== "union_case") {
    if (value.tag === "app") {
      for (const arg of value.args) {
        scan_runtime_union_payload_allocations(
          arg,
          undefined,
          scope,
          ctx,
          hooks,
          state,
          scan_expr,
        );
      }
    }
    record_allocation(
      value,
      "runtime_union",
      scope,
      state,
      allocation_instance,
    );
    return;
  }

  const parent = record_allocation(
    value,
    "runtime_union",
    scope,
    state,
    allocation_instance,
  );

  let payload_offset = 4;

  if (value.type_expr) {
    const type_value = static_type_value(
      value.type_expr,
      ctx as ctx & TypeStaticCtx,
    );
    if (!type_value || type_value.tag !== "union_type") {
      throw new Error("Missing runtime union allocation type");
    }
    const layout = runtime_union_type_layout(
      type_value,
      ctx as ctx & TypeStaticCtx,
    );
    payload_offset = layout.payload_offset;

    if (parent && layout.align === 16) {
      parent.alignment = 16;
    }
  }

  if (value.value) {
    const payload = runtime_union_case_payload(value, ctx);
    if (!payload) {
      throw new Error("Missing runtime union payload allocation metadata");
    }
    const child_start = state.facts.length;
    scan_runtime_union_payload_allocations(
      value.value,
      payload,
      scope,
      ctx,
      hooks,
      state,
      scan_expr,
    );
    const children = runtime_union_direct_owned_children(
      value.value,
      payload,
      child_start,
      state,
    );
    if (parent) {
      attach_runtime_union_owned_children(parent, children, payload_offset);
    }
  }
}

export function scan_runtime_union_payload_allocations<ctx>(
  value: CoreExpr,
  payload: RuntimeUnionPayload | undefined,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  scan_expr: AllocationExprScanner<ctx>,
): void {
  if (!payload || payload.tag !== "struct") {
    scan_expr(value, scope, ctx, hooks, state);
    return;
  }

  const struct_value = hooks.static_struct_value(value, ctx);
  if (!struct_value) {
    throw new Error("Missing inline runtime union struct payload");
  }

  scan_runtime_union_inline_struct_payload(
    struct_value.fields,
    scope,
    ctx,
    hooks,
    state,
    scan_expr,
  );
}

function scan_runtime_union_inline_struct_payload<ctx>(
  fields: CoreField[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  scan_expr: AllocationExprScanner<ctx>,
): void {
  for (const field of fields) {
    const nested = hooks.static_struct_value(field.value, ctx);
    if (nested) {
      scan_runtime_union_inline_struct_payload(
        nested.fields,
        scope,
        ctx,
        hooks,
        state,
        scan_expr,
      );
      continue;
    }
    scan_expr(field.value, scope, ctx, hooks, state);
  }
}

export function runtime_union_case_payload<ctx>(
  value: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
): RuntimeUnionPayload | undefined {
  if (!value.type_expr) {
    return undefined;
  }

  const type_value = static_type_value(
    value.type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  const declared = type_value.cases.find((candidate) => {
    return candidate.name === value.name;
  });
  if (!declared) {
    throw new Error("Missing union case: " + value.name);
  }

  return runtime_union_payload(
    declared.type_name,
    ctx as ctx & TypeStaticCtx,
  );
}

function runtime_union_direct_owned_children(
  value: CoreExpr,
  payload: RuntimeUnionPayload,
  child_start: number,
  state: CoreAllocationState,
): CoreAllocationState["facts"] {
  let reason: CoreAllocationState["facts"][number]["reason"] | undefined;
  if (payload.tag === "aggregate") {
    reason = "runtime_aggregate";
  } else if (payload.tag === "value") {
    if (payload.resume) {
      reason = "closure";
    } else if (payload.text) {
      reason = "runtime_text";
    } else if (payload.union_type_expr) {
      reason = "runtime_union";
    }
  } else if (payload.tag === "struct") {
    const discovered = state.facts.slice(child_start).some((fact) => {
      return fact.storage === "persistent_unique_heap" &&
        fact.ownership.tag === "unique_heap";
    });
    if (discovered) {
      throw new Error(
        "Inline runtime union struct payload ownership metadata is unsupported",
      );
    }
  }

  if (!reason) {
    return [];
  }

  let direct = state.value_allocations.get(value);
  if (
    (!direct || direct.length === 0) &&
    (value.tag === "var" || value.tag === "linear")
  ) {
    direct = state.binding_allocations.get(value.name);
  }
  if (direct) {
    const matching = direct.filter((fact) => fact.reason === reason);
    if (matching.length > 0) {
      return matching;
    }
  }

  const fallback = state.facts.slice(child_start).find((fact) => {
    return fact.reason === reason;
  });
  if (fallback) {
    return [fallback];
  }
  return [];
}

export function attach_runtime_union_owned_children(
  parent: CoreAllocationState["facts"][number],
  candidates: CoreAllocationState["facts"],
  payload_offset: number,
): void {
  if (parent.storage !== "persistent_unique_heap") {
    return;
  }
  const children: CoreAllocationState["facts"] = [];
  const seen = new Set<string>();
  for (const fact of candidates) {
    if (seen.has(fact.allocation_id)) {
      continue;
    }
    if (
      fact.storage !== "persistent_unique_heap" ||
      fact.ownership.tag !== "unique_heap"
    ) {
      continue;
    }
    seen.add(fact.allocation_id);
    children.push(fact);
  }
  const child = children[0];
  if (!child || child.ownership.tag !== "unique_heap") {
    return;
  }
  const child_ownership = child.ownership;
  for (const candidate of children) {
    if (
      candidate.layout !== child.layout ||
      candidate.ownership.tag !== "unique_heap" ||
      candidate.ownership.reason !== child_ownership.reason
    ) {
      throw new Error("Core runtime union payload has mixed heap layouts");
    }
  }
  const owned_children = parent.owned_children || [];
  const existing = owned_children.find((candidate) => {
    return candidate.offset === payload_offset &&
      candidate.layout === child.layout &&
      candidate.ownership.reason === child_ownership.reason;
  });
  const allocation_ids = children.map((candidate) => {
    return candidate.allocation_id;
  });
  if (existing) {
    for (const allocation_id of allocation_ids) {
      if (!existing.allocation_ids.includes(allocation_id)) {
        existing.allocation_ids.push(allocation_id);
      }
    }
    return;
  }
  owned_children.push({
    allocation_ids,
    offset: payload_offset,
    ownership: child_ownership,
    layout: child.layout,
  });
  parent.owned_children = owned_children;
}
