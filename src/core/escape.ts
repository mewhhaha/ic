import type { CoreOwnership } from "./model/ownership.ts";
import type { CoreStorageClass } from "./model/storage.ts";
import { core_ownership_result_text } from "./ownership.ts";
import {
  core_borrow_lifetime_decision,
  core_freeze_lifetime_decision,
  core_scratch_return_lifetime_decision,
  type CoreLifetimeDecision,
} from "./lifetime.ts";

export type CoreEscapeEdge =
  | "final_result"
  | "borrow_view"
  | "freeze"
  | "scratch_return";

export type { CoreStorageClass } from "./model/storage.ts";

export type CoreEscapeAnalysis = {
  edge: CoreEscapeEdge;
  ownership: CoreOwnership;
  storage: CoreStorageClass;
  escapes: boolean;
  decision: CoreLifetimeDecision;
};

export function core_escape_analysis(
  edge: CoreEscapeEdge,
  ownership: CoreOwnership,
): CoreEscapeAnalysis {
  const decision = core_escape_decision(edge, ownership);
  let storage: CoreStorageClass;

  if (decision.tag === "rejected") {
    storage = "rejected";
  } else {
    storage = core_storage_class(ownership);
  }

  return {
    edge,
    ownership,
    storage,
    escapes: core_ownership_escapes_scope(ownership),
    decision,
  };
}

export function core_final_result_escape_decision(
  ownership: CoreOwnership,
): CoreLifetimeDecision {
  switch (ownership.tag) {
    case "scalar_local":
      return {
        tag: "allowed",
        reason: "scalar local result does not escape linear memory",
      };

    case "unique_heap":
      return {
        tag: "allowed",
        reason: core_ownership_result_text(ownership) +
          " escapes as the owned final result",
      };

    case "frozen_shareable":
      return {
        tag: "allowed",
        reason: core_ownership_result_text(ownership) +
          " may escape as immutable shareable data",
      };

    case "borrow_view":
      return {
        tag: "rejected",
        reason: core_ownership_result_text(ownership) +
          " cannot escape as a final result",
      };

    case "scratch_backed":
      return {
        tag: "rejected",
        reason: core_ownership_result_text(ownership) +
          " may reference storage reset before the final result is used",
      };
  }
}

export function core_storage_class(
  ownership: CoreOwnership,
): CoreStorageClass {
  switch (ownership.tag) {
    case "scalar_local":
      return "scalar_local";

    case "unique_heap":
      return "persistent_unique_heap";

    case "frozen_shareable":
      if (ownership.reason === "text") {
        return "static_data";
      }

      return "frozen_heap";

    case "borrow_view":
      return "borrow_view";

    case "scratch_backed":
      return "scratch_arena";
  }
}

function core_escape_decision(
  edge: CoreEscapeEdge,
  ownership: CoreOwnership,
): CoreLifetimeDecision {
  switch (edge) {
    case "final_result":
      return core_final_result_escape_decision(ownership);

    case "borrow_view":
      return core_borrow_lifetime_decision(ownership);

    case "freeze":
      return core_freeze_lifetime_decision(ownership);

    case "scratch_return":
      return core_scratch_return_lifetime_decision(ownership);
  }
}

function core_ownership_escapes_scope(
  ownership: CoreOwnership,
): boolean {
  if (ownership.tag === "scalar_local") {
    return false;
  }

  return true;
}
