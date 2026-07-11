import type { DataSegment } from "../../mod.ts";
import type { ValType } from "../../op.ts";
import { Data, Emit, Format, Typed } from "../../trait.ts";
import type { Wat } from "../../wat.ts";
import type { Source as SourceNode } from "../../frontend/ast.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreField,
  CoreHostImport,
  CoreHostImportArgContract,
  CoreHostImportOwnerReason,
  CoreHostImportResultContract,
  CoreStmt,
  CoreTypeField,
} from "../ast.ts";
import {
  core_allocations,
  core_borrows,
  core_check_borrows,
  core_check_proof,
  core_cleanup,
  core_closure_ownership,
  core_data,
  core_drops,
  core_escape,
  core_host_boundaries,
  core_lifetimes,
  core_mod,
  core_ownership,
  core_proof,
  core_type,
  core_validate_borrows,
  emit_core,
} from "./graph.ts";
import { format_core } from "../format.ts";
import { core_from_source } from "../from_source.ts";
export type {
  CoreAllocationFact,
  CoreAllocationPlan,
  CoreAllocationReason,
} from "../allocation.ts";
export type {
  CoreBorrowEdge,
  CoreBorrowPlan,
  CoreBorrowValidation,
  CoreBorrowValidationIssue,
} from "../borrow.ts";
export type { CoreCleanupPlan, CoreCleanupStep } from "../cleanup.ts";
export type {
  CoreDropEdge,
  CoreDropPlan,
  CoreDropRuntime,
  CoreDropStep,
  CoreUniqueHeapOwnership,
} from "../drop.ts";
export type { CoreEscapeAnalysis, CoreStorageClass } from "../escape.ts";
export type { CoreLifetimePlan, CoreLifetimeScope } from "../lifetime_scope.ts";
export type { CoreOwnership } from "../ownership.ts";
export type {
  CoreHostBoundaryArg,
  CoreHostBoundaryDecision,
  CoreHostBoundaryEdge,
  CoreHostBoundaryPlan,
} from "../host_boundary.ts";
export type {
  CoreBaselineProof,
  CoreBaselineTarget,
  CoreFreezeProofEdge,
  CoreProofIssue,
} from "../proof.ts";
export type {
  CoreClosureCaptureDecision,
  CoreClosureCaptureSlot,
  CoreClosureOwnershipEdge,
  CoreClosureOwnershipPlan,
} from "../closure_ownership.ts";
export type {
  CoreTransferEdge,
  CoreTransferValidation,
  CoreTransferValidationIssue,
} from "../transfer.ts";

export type Core = CoreNode;
export type {
  CoreExpr,
  CoreField,
  CoreHostImport,
  CoreHostImportArgContract,
  CoreHostImportOwnerReason,
  CoreHostImportResultContract,
  CoreStmt,
  CoreTypeField,
};

export function Core() {}

Core.from_source = function from_source(source: SourceNode): CoreNode {
  return core_from_source(source);
};

Core.fmt = format_core;

Core.type = core_type;

Core.emit = emit_core;

Core.mod = core_mod;

Core.data = core_data;

Core.ownership = core_ownership;

Core.escape = core_escape;

Core.cleanup = core_cleanup;

Core.drops = core_drops;

Core.borrows = core_borrows;

Core.validate_borrows = core_validate_borrows;

Core.check_borrows = core_check_borrows;

Core.lifetimes = core_lifetimes;

Core.allocations = core_allocations;

Core.closure_ownership = core_closure_ownership;

Core.host_boundaries = core_host_boundaries;

Core.proof = core_proof;

Core.check_proof = core_check_proof;

Format.register<CoreNode>(Core);
Typed.register<CoreNode, ValType>(Core);
Emit.register<CoreNode, Wat>(Core);
Data.register<CoreNode, DataSegment>(Core);
