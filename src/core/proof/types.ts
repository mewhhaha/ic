import type { CoreCapabilityMethodFact, CoreExpr, CoreStmt } from "../ast.ts";
import type { CoreAllocationFact, CoreAllocationPlan } from "../allocation.ts";
import type {
  CoreBorrowEdge,
  CoreBorrowPlan,
  CoreBorrowValidation,
  CoreBorrowValidationIssue,
} from "../borrow.ts";
import type { CoreCleanupPlan, CoreCleanupStep } from "../cleanup.ts";
import type {
  CoreClosureOwnershipEdge,
  CoreClosureOwnershipPlan,
} from "../closure_ownership.ts";
import type { CoreDropPlan, CoreDropStep } from "../drop.ts";
import type { CoreEscapeAnalysis } from "../escape.ts";
import type {
  CoreHostBoundaryEdge,
  CoreHostBoundaryPlan,
} from "../host_boundary.ts";
import type { CoreLifetimePlan, CoreLifetimeScope } from "../lifetime_scope.ts";
import type { CoreTransferValidationIssue } from "../transfer.ts";
import type { CoreTransferValidation } from "../transfer.ts";
import type { CoreFreezeProofEdge } from "./freeze.ts";
import type { CoreRuntimeSliceFact } from "../runtime_slice.ts";

export type CoreBaselineTarget = "core-3-nonweb";

export type CoreProofMissingEdge =
  | "active_borrow"
  | "scratch_backed_result"
  | "missing_promotion"
  | "missing_temporary_cleanup"
  | "missing_allocation_layout"
  | "unknown_host_boundary_ownership"
  | "unsupported_ownership_bearing_closure_capture"
  | "invalid_ownership_transfer"
  | "missing_collection_or_text_fact"
  | "missing_collection_fact"
  | "unsupported_codegen";

export type CoreStorageProofRow =
  | { tag: "final_result"; analysis: CoreEscapeAnalysis }
  | { tag: "allocation"; fact: CoreAllocationFact };

export type CoreCleanupProofRow = CoreCleanupStep | CoreDropStep;

export type CoreUnsupportedCodegenIssue = {
  tag: "unsupported_codegen";
  node: "stmt" | "expr";
  feature: string;
  missing_edge?:
    | "unsupported_codegen"
    | "missing_collection_or_text_fact"
    | "missing_collection_fact";
  message: string;
};

export type CoreUnsupportedCodegenHooks = {
  collection_loop_supported: (
    stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ) => boolean;
  index_assign_supported: (
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ) => boolean;
  type_value_expr: (expr: CoreExpr) => boolean;
  if_let_expr_supported: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
  ) => boolean;
  if_let_stmt_supported: (
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  ) => boolean;
  index_expr_supported: (
    expr: Extract<CoreExpr, { tag: "index" }>,
  ) => boolean;
  enter_scope?: () => void;
  exit_scope?: () => void;
  observe_stmt?: (stmt: CoreStmt) => void;
};

export type CoreProofIssue =
  | {
    tag: "borrow";
    missing_edge: "active_borrow";
    issue: CoreBorrowValidationIssue;
    message: string;
  }
  | {
    tag: "freeze";
    missing_edge: "missing_promotion";
    edge: CoreFreezeProofEdge;
    message: string;
  }
  | {
    tag: "scratch_return";
    missing_edge: "scratch_backed_result";
    step: CoreCleanupStep;
    message: string;
  }
  | {
    tag: "final_result";
    missing_edge: "active_borrow" | "scratch_backed_result";
    analysis: CoreEscapeAnalysis;
    message: string;
  }
  | {
    tag: "host_boundary";
    missing_edge: "unknown_host_boundary_ownership";
    edge: CoreHostBoundaryEdge;
    message: string;
  }
  | {
    tag: "closure_capture";
    missing_edge: "unsupported_ownership_bearing_closure_capture";
    edge: CoreClosureOwnershipEdge;
    message: string;
  }
  | {
    tag: "transfer";
    missing_edge: "invalid_ownership_transfer";
    issue: CoreTransferValidationIssue;
    message: string;
  }
  | {
    tag: "allocation_layout";
    missing_edge: "missing_allocation_layout";
    fact: CoreAllocationFact;
    message: string;
  }
  | {
    tag: "temporary_cleanup";
    missing_edge: "missing_temporary_cleanup";
    step: CoreDropStep;
    message: string;
  }
  | {
    tag: "unsupported_codegen";
    missing_edge:
      | "unsupported_codegen"
      | "missing_collection_or_text_fact"
      | "missing_collection_fact";
    issue: CoreUnsupportedCodegenIssue;
    message: string;
  };

export type CoreBaselineProof = {
  target: CoreBaselineTarget;
  target_profile: CoreBaselineTarget;
  managed_storage: "disabled";
  ok: boolean;
  storage_rows: CoreStorageProofRow[];
  lifetime_rows: CoreLifetimeScope[];
  borrow_view_rows: CoreBorrowEdge[];
  scratch_result_rows: CoreCleanupStep[];
  freeze_promotion_rows: CoreFreezeProofEdge[];
  cleanup_rows: CoreCleanupProofRow[];
  host_boundary_rows: CoreHostBoundaryEdge[];
  capability_method_rows: CoreCapabilityMethodFact[];
  runtime_slice_rows: CoreRuntimeSliceFact[];
  final_result: CoreEscapeAnalysis;
  borrows: CoreBorrowValidation;
  freeze_edges: CoreFreezeProofEdge[];
  cleanup: CoreCleanupPlan;
  closure_ownership: CoreClosureOwnershipPlan;
  drops: CoreDropPlan;
  allocations: CoreAllocationPlan;
  host_boundaries: CoreHostBoundaryPlan;
  transfers: CoreTransferValidation;
  lifetimes: CoreLifetimePlan;
  issues: CoreProofIssue[];
};

export type CoreBaselineProofInput = {
  final_result: CoreEscapeAnalysis;
  borrow_plan: CoreBorrowPlan;
  borrows: CoreBorrowValidation;
  freeze_edges: CoreFreezeProofEdge[];
  cleanup: CoreCleanupPlan;
  closure_ownership: CoreClosureOwnershipPlan;
  drops: CoreDropPlan;
  allocations: CoreAllocationPlan;
  host_boundaries: CoreHostBoundaryPlan;
  capability_method_rows: CoreCapabilityMethodFact[];
  runtime_slice_rows: CoreRuntimeSliceFact[];
  transfers: CoreTransferValidation;
  lifetimes: CoreLifetimePlan;
  unsupported_codegen: CoreUnsupportedCodegenIssue[];
};
