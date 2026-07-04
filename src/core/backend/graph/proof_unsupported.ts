import type { Core as CoreNode } from "../../ast.ts";
import { unsupported_core_captured_assignment_message } from "../../closure_capture.ts";
import { core_escape_analysis } from "../../escape.ts";
import { core_lifetime_plan } from "../../lifetime_scope.ts";
import {
  core_baseline_proof,
  type CoreBaselineProof,
  type CoreUnsupportedCodegenIssue,
} from "../../proof.ts";

export function core_unsupported_codegen_proof(
  core: CoreNode,
  unsupported_codegen: CoreUnsupportedCodegenIssue[],
): CoreBaselineProof {
  return core_baseline_proof({
    final_result: core_escape_analysis("final_result", {
      tag: "scalar_local",
      type: "i32",
    }),
    borrows: { ok: true, issues: [] },
    freeze_edges: [],
    cleanup: { steps: [] },
    closure_ownership: { edges: [] },
    drops: { steps: [] },
    allocations: { facts: [] },
    host_boundaries: { edges: [] },
    transfers: { transfers: [], issues: [] },
    lifetimes: core_lifetime_plan(core),
    unsupported_codegen,
  });
}

export function core_unsupported_codegen_issue_from_analysis_error(
  error: unknown,
): CoreUnsupportedCodegenIssue | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const builtin_app_issue =
    core_builtin_app_unsupported_codegen_issue_from_analysis_error(error);

  if (builtin_app_issue) {
    return builtin_app_issue;
  }

  if (error.message.startsWith("Cannot index-assign unbound core local: ")) {
    return {
      tag: "unsupported_codegen",
      node: "stmt",
      feature: "index_assign",
      message: "Cannot emit core index_assign statement yet",
    };
  }

  if (
    error.message.startsWith("Cannot mutate frozen/shareable core binding: ")
  ) {
    return {
      tag: "unsupported_codegen",
      node: "stmt",
      feature: "index_assign",
      message: error.message,
    };
  }

  if (error.message === unsupported_core_captured_assignment_message) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "closure_capture",
      message: error.message,
    };
  }

  if (error.message === "Cannot update non-static core struct value") {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "struct_update",
      message: "Cannot emit core struct_update expression yet",
    };
  }

  if (error.message.startsWith("Missing host capability method: ")) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "missing_capability_method",
      message: error.message,
    };
  }

  const host_owner_result_prefix = "Core host import ";
  const host_owner_result_suffix =
    " owner result must use i32 pointer representation";

  if (
    error.message.startsWith(host_owner_result_prefix) &&
    error.message.endsWith(host_owner_result_suffix)
  ) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "host_import_result_owner",
      message: error.message,
    };
  }

  const prefix = "Cannot type core ";
  const suffix = " expression yet";

  if (!error.message.startsWith(prefix)) {
    return undefined;
  }

  if (!error.message.endsWith(suffix)) {
    return undefined;
  }

  const feature = error.message.slice(
    prefix.length,
    error.message.length - suffix.length,
  );

  if (!core_analysis_error_feature_is_unsupported_codegen(feature)) {
    return undefined;
  }

  return {
    tag: "unsupported_codegen",
    node: "expr",
    feature,
    message: "Cannot emit core " + feature + " expression yet",
  };
}

export function core_unsupported_codegen_issue_exists(
  issues: CoreUnsupportedCodegenIssue[],
  issue: CoreUnsupportedCodegenIssue | undefined,
): boolean {
  if (!issue) {
    return false;
  }

  for (const existing of issues) {
    if (
      existing.node === issue.node &&
      existing.feature === issue.feature &&
      existing.message === issue.message
    ) {
      return true;
    }
  }

  return false;
}

export function core_unknown_host_boundary_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message === "Cannot type core app expression yet") {
    return true;
  }

  if (core_probe_index_assign_error(error)) {
    return true;
  }

  return false;
}

export function core_probe_index_assign_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Cannot index-assign unbound core local: ")) {
    return true;
  }

  if (error.message === "Cannot emit core index_assign statement yet") {
    return true;
  }

  return false;
}

function core_analysis_error_feature_is_unsupported_codegen(
  feature: string,
): boolean {
  switch (feature) {
    case "field":
    case "index":
    case "if_let":
    case "lam":
    case "linear":
    case "rec":
    case "comptime":
    case "with":
    case "struct_update":
    case "unsupported":
      return true;

    case "app":
      return false;
  }

  return false;
}

function core_builtin_app_unsupported_codegen_issue_from_analysis_error(
  error: Error,
): CoreUnsupportedCodegenIssue | undefined {
  if (
    error.message === "Cannot type core len over unknown collection or text"
  ) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "app",
      message: "Cannot emit core len over unknown collection or text",
    };
  }

  if (error.message === "Cannot type core get over unknown collection") {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "app",
      message: "Cannot emit core get over unknown collection",
    };
  }

  return undefined;
}
