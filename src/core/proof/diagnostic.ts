import {
  compiler_diagnostic,
  type CompilerDiagnostic,
  CompilerDiagnosticError,
  diagnostic_codes,
  type DiagnosticCode,
} from "../../diagnostic.ts";
import {
  core_diagnostic_related_subject,
  core_source_origin,
  find_core_diagnostic_subject,
  has_core_source_origin,
} from "../source_origin.ts";
import type { CoreProofIssue } from "./types.ts";

export function core_proof_diagnostic(
  issue: CoreProofIssue,
): CompilerDiagnostic | undefined {
  if (issue.tag === "borrow") {
    if (issue.issue.tag === "rejected_borrow") {
      const subject = find_core_diagnostic_subject(issue.issue.edge);
      if (!subject) {
        return undefined;
      }

      return diagnostic(
        diagnostic_codes.borrow_proof_rejected,
        issue.message,
        subject,
      );
    }

    if (issue.issue.tag === "borrowed_owner_barrier") {
      const barrier = issue.issue.barrier;
      let code: DiagnosticCode = diagnostic_codes.freeze_proof_rejected;

      if (barrier.action === "index_assign") {
        code = diagnostic_codes.frozen_mutation_rejected;
      }

      const subject = find_core_diagnostic_subject(barrier);
      if (!subject) {
        return undefined;
      }

      return diagnostic(
        code,
        issue.message,
        subject,
        core_diagnostic_related_subject(barrier),
      );
    }

    return undefined;
  }

  if (issue.tag === "freeze") {
    const subject = find_core_diagnostic_subject(issue.edge);
    if (!subject) {
      return undefined;
    }

    return diagnostic(
      diagnostic_codes.freeze_proof_rejected,
      issue.message,
      subject,
    );
  }

  if (issue.tag === "scratch_return") {
    const subject = find_core_diagnostic_subject(issue.step);
    if (!subject) {
      return undefined;
    }

    return diagnostic(
      diagnostic_codes.scratch_escape_rejected,
      issue.message,
      subject,
    );
  }

  if (
    issue.tag === "unsupported_codegen" &&
    issue.issue.feature === "index_assign"
  ) {
    const subject = find_core_diagnostic_subject(issue.issue);
    if (!subject) {
      return undefined;
    }

    return diagnostic(
      diagnostic_codes.frozen_mutation_rejected,
      issue.message,
      subject,
    );
  }

  return undefined;
}

export function core_proof_diagnostic_error(
  issue: CoreProofIssue,
): CompilerDiagnosticError | undefined {
  const diagnostic_value = core_proof_diagnostic(issue);

  if (!diagnostic_value) {
    return undefined;
  }

  return new CompilerDiagnosticError(diagnostic_value);
}

function diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: import("../source_origin.ts").CoreSourceSubject,
  related_subject?: import("../source_origin.ts").CoreSourceSubject,
): CompilerDiagnostic | undefined {
  if (!has_core_source_origin(subject)) {
    return undefined;
  }

  const result = compiler_diagnostic(
    code,
    message,
    core_source_origin(subject),
  );

  if (related_subject && has_core_source_origin(related_subject)) {
    result.related = [{
      message: "Active borrow originates here",
      span: core_source_origin(related_subject),
    }];
  }

  return result;
}
