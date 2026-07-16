import {
  compiler_diagnostic,
  type CompilerDiagnostic,
  CompilerDiagnosticError,
  type CompilerDiagnosticRelated,
  type DiagnosticCode,
  type DiagnosticSeverity,
} from "../diagnostic.ts";
import { source_span } from "./syntax.ts";

export type SourceDiagnosticSeverity = DiagnosticSeverity;
export type SourceDiagnosticRelated = CompilerDiagnosticRelated;
export type SourceDiagnostic = CompilerDiagnostic;

export class SourceDiagnosticError extends CompilerDiagnosticError {
  constructor(diagnostic: SourceDiagnostic) {
    super(diagnostic);
    this.name = "SourceDiagnosticError";
  }
}

export function source_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
  related?: SourceDiagnosticRelated[],
): SourceDiagnostic {
  return compiler_diagnostic(code, message, source_span(subject), related);
}

export function related_source_diagnostic(
  message: string,
  subject: object,
): SourceDiagnosticRelated {
  return { message, span: source_span(subject) };
}

export function throw_source_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
  related?: SourceDiagnosticRelated[],
): never {
  throw new SourceDiagnosticError(
    source_diagnostic(code, message, subject, related),
  );
}
