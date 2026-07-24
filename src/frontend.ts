export { Source } from "./frontend/source.ts";
export type {
  SourceAnalysis,
  SourceAnalyzeOptions,
} from "./frontend/source.ts";
export type { ParseSourceResult } from "./frontend/parser.ts";
export type { SourceImportResolver } from "./frontend/import_diagnostic.ts";
export type {
  SourceImportMeta,
  SourceImportMetaAtom,
  SourceImportMetaLiteral,
} from "./frontend/import_meta.ts";
export type {
  SourcePosition,
  SourceSpan,
  SourceSyntax,
  SyntaxDiagnostic,
} from "./frontend/syntax.ts";

export {
  compiler_diagnostic,
  CompilerDiagnosticError,
  diagnostic_codes,
  diagnostic_registry,
  diagnostic_sequence,
  registered_diagnostic,
} from "./diagnostic.ts";
export type {
  CompilerDiagnostic,
  CompilerDiagnosticRelated,
  DiagnosticCategory,
  DiagnosticCode,
  DiagnosticName,
  DiagnosticSeverity,
  DiagnosticSpan,
  RegisteredDiagnostic,
} from "./diagnostic.ts";
export { SourceDiagnosticError } from "./frontend/semantic_diagnostic.ts";
export type {
  SourceDiagnostic,
  SourceDiagnosticRelated,
  SourceDiagnosticSeverity,
} from "./frontend/semantic_diagnostic.ts";
