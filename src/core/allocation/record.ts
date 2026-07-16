import type { CoreExpr } from "../ast.ts";
import { core_storage_class } from "../escape.ts";
import type {
  CoreOwnership,
  CoreOwnershipPointerReason,
} from "../ownership.ts";
import type {
  CoreAllocationReason,
  CoreAllocationScope,
  CoreAllocationState,
} from "./types.ts";
import {
  register_core_allocation_fact,
  register_core_allocation_fact_scratch_scope,
} from "./metadata.ts";
import {
  core_runtime_buffer_builtin,
  runtime_buffer_allocation,
} from "../runtime_buffer.ts";

export function record_allocation(
  expr: CoreExpr,
  reason: CoreAllocationReason,
  scope: CoreAllocationScope,
  state: CoreAllocationState,
  instance?: string,
): import("./types.ts").CoreAllocationFact | undefined {
  const key = allocation_record_key(reason, scope, instance);
  const recorded = state.recorded.get(expr);

  if (recorded) {
    if (recorded.has(key)) {
      return undefined;
    }

    recorded.add(key);
  } else {
    state.recorded.set(expr, new Set([key]));
  }

  const base: CoreOwnership = {
    tag: "unique_heap",
    reason: ownership_reason(reason),
  };
  let ownership: CoreOwnership = base;

  if (scope.scratch && reason !== "closure") {
    ownership = { tag: "scratch_backed", source: base };
  }

  const allocation_id = "allocation#" + state.next_allocation.toString();
  const layout = allocation_layout(expr, reason);
  const fact = {
    id: allocation_id,
    allocation_id,
    scope: scope.name,
    storage: core_storage_class(ownership),
    ownership,
    reason,
    expression: expr.tag,
    byte_size: layout.byte_size,
    alignment: layout.alignment,
    layout: layout.layout,
  } as import("./types.ts").CoreAllocationFact;

  if (expr.tag === "var") {
    fact.owner = expr.name;
  }
  state.next_allocation += 1;
  state.facts.push(fact);
  const value_facts = state.value_allocations.get(expr);
  if (value_facts) {
    value_facts.push(fact);
  } else {
    state.value_allocations.set(expr, [fact]);
  }
  register_core_allocation_fact(
    fact,
    expr,
    allocation_emission_site(expr, reason),
  );
  if (scope.scratch) {
    register_core_allocation_fact_scratch_scope(fact, scope.scratch);
  }
  return fact;
}

function allocation_emission_site(
  expr: CoreExpr,
  reason: CoreAllocationReason,
): string {
  if (expr.tag === "freeze") {
    return reason + ".freeze_copy";
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return "closure.value";
  }

  if (expr.tag === "struct_value") {
    return "runtime_aggregate.value";
  }

  if (expr.tag === "union_case") {
    return "runtime_union.value";
  }

  if (expr.tag === "prim") {
    return "runtime_text.concat";
  }

  if (expr.tag === "app" && expr.func.tag === "var") {
    const runtime_buffer_builtin = core_runtime_buffer_builtin(expr);

    if (runtime_buffer_builtin) {
      return runtime_buffer_allocation(runtime_buffer_builtin).emission_site;
    }

    if (expr.func.name === "@Bytes.generate") {
      return "runtime_bytes.generate";
    }

    if (expr.func.name === "@append") {
      return "runtime_text.append";
    }

    if (expr.func.name === "@slice") {
      return "runtime_text.slice";
    }

    if (
      expr.func.name === "@runtime_i32_slice" ||
      expr.func.name === "@runtime_text_slice"
    ) {
      return "runtime_slice.value";
    }
  }

  return reason + ".value";
}

function allocation_layout(
  expr: CoreExpr,
  reason: CoreAllocationReason,
): {
  byte_size: import("./types.ts").CoreAllocationByteSize;
  alignment: 4 | 8 | 16;
  layout: import("./types.ts").CoreAllocationLayout;
} {
  if (
    expr.tag === "app" && expr.func.tag === "var" &&
    (expr.func.name === "@runtime_i32_slice" ||
      expr.func.name === "@runtime_text_slice")
  ) {
    let layout: import("./types.ts").CoreAllocationLayout =
      "runtime_slice.length_and_i32_elements";
    if (expr.func.name === "@runtime_text_slice") {
      layout = "runtime_slice.length_and_frozen_text_pointers";
    }
    return {
      byte_size: { tag: "static", value: expr.args.length * 4 },
      alignment: 4,
      layout,
    };
  }

  if (reason === "closure") {
    return {
      byte_size: {
        tag: "runtime",
        formula: "align8(4 + capture_slot_bytes)",
      },
      alignment: 8,
      layout: "closure_env.table_index_and_capture_slots",
    };
  }

  if (reason === "runtime_aggregate") {
    return {
      byte_size: { tag: "runtime", formula: "aligned_field_layout_size" },
      alignment: 8,
      layout: "runtime_aggregate.aligned_fields",
    };
  }

  if (reason === "runtime_union") {
    return {
      byte_size: { tag: "runtime", formula: "4 + aligned_payload_size" },
      alignment: 4,
      layout: "runtime_union.tag_and_aligned_payload",
    };
  }

  if (reason === "runtime_bytes") {
    return {
      byte_size: { tag: "runtime", formula: "4 + runtime_byte_length" },
      alignment: 4,
      layout: "runtime_bytes.length_prefixed_u8",
    };
  }

  return {
    byte_size: { tag: "runtime", formula: "4 + runtime_byte_length" },
    alignment: 4,
    layout: "runtime_text.length_prefixed_utf8",
  };
}

function allocation_record_key(
  reason: CoreAllocationReason,
  scope: CoreAllocationScope,
  instance: string | undefined,
): string {
  let scratch = "";

  if (scope.scratch) {
    scratch = scope.scratch;
  }

  let key = scope.name + "|" + scratch + "|" + reason;
  if (instance) {
    key += "|" + instance;
  }
  return key;
}

function ownership_reason(
  reason: CoreAllocationReason,
): CoreOwnershipPointerReason {
  switch (reason) {
    case "closure":
      return "closure";

    case "runtime_aggregate":
      return "runtime_aggregate";

    case "runtime_bytes":
      return "bytes";

    case "runtime_text":
      return "text";

    case "runtime_union":
      return "runtime_union";
  }
}
