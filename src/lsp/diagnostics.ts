import type { ParseSourceResult } from "../frontend/parser.ts";
import { Source, type SourceAnalysis } from "../frontend/source.ts";
import type { SourceDiagnostic } from "../frontend/semantic_diagnostic.ts";
import { type LspRange, PositionIndex } from "./position.ts";

export type { LspPosition, LspRange } from "./position.ts";

export type LspDiagnostic = {
  range: LspRange;
  severity: number;
  source: string;
  message: string;
  code?: string;
  relatedInformation?: LspDiagnosticRelatedInformation[];
};

export type LspDiagnosticRelatedInformation = {
  location: {
    uri: string;
    range: LspRange;
  };
  message: string;
};

// Parser and scanner diagnostics retain their source offsets through the
// editor boundary; error message text is never used as location metadata.
export function parse_diagnostics(text: string): LspDiagnostic[] {
  return parse_result_diagnostics(Source.parse_with_diagnostics(text));
}

export function parse_result_diagnostics(
  parsed: ParseSourceResult,
): LspDiagnostic[] {
  const positions = new PositionIndex(parsed.syntax.text, "utf-16");
  return parsed.diagnostics.map((diagnostic) => ({
    range: error_range(
      parsed.syntax.text,
      positions,
      diagnostic.span.start,
      diagnostic.span.end,
    ),
    severity: 1,
    source: "duck",
    message: diagnostic.message,
  }));
}

export function analysis_diagnostics(
  analysis: SourceAnalysis,
  uri: string,
  encoding: import("./position.ts").PositionEncoding,
): LspDiagnostic[] {
  const positions = new PositionIndex(analysis.syntax.text, encoding);
  return analysis.diagnostics.map((diagnostic) =>
    source_diagnostic_to_lsp(
      diagnostic,
      analysis.syntax.text,
      positions,
      uri,
    )
  );
}

function source_diagnostic_to_lsp(
  diagnostic: SourceDiagnostic,
  text: string,
  positions: PositionIndex,
  default_uri: string,
): LspDiagnostic {
  let severity = 1;

  if (diagnostic.severity === "warning") {
    severity = 2;
  }

  const result: LspDiagnostic = {
    range: offset_range(text, positions, diagnostic.span),
    severity,
    source: "duck",
    code: diagnostic.code,
    message: diagnostic.message,
  };

  if (diagnostic.related !== undefined) {
    const related_information: LspDiagnosticRelatedInformation[] = [];

    for (const related of diagnostic.related) {
      let related_uri = default_uri;

      if (related.uri !== undefined) {
        related_uri = related.uri;
      }

      if (related_uri !== default_uri) {
        continue;
      }

      related_information.push({
        location: {
          uri: related_uri,
          range: offset_range(text, positions, related.span),
        },
        message: related.message,
      });
    }

    if (related_information.length > 0) {
      result.relatedInformation = related_information;
    }
  }

  return result;
}

function offset_range(
  text: string,
  positions: PositionIndex,
  span: { start: number; end: number },
): LspRange {
  const start = scalar_boundary_before(text, span.start);
  const end = scalar_boundary_after(text, span.end);
  return {
    start: positions.position_from_offset(start),
    end: positions.position_from_offset(end),
  };
}

function error_range(
  text: string,
  positions: PositionIndex,
  start_offset: number,
  end_offset: number,
): LspRange {
  start_offset = scalar_boundary_before(text, start_offset);
  end_offset = scalar_boundary_after(text, end_offset);

  return {
    start: positions.position_from_offset(start_offset),
    end: positions.position_from_offset(end_offset),
  };
}

function scalar_boundary_before(text: string, offset: number): number {
  if (
    offset > 0 && is_low_surrogate(text.charCodeAt(offset)) &&
    is_high_surrogate(text.charCodeAt(offset - 1))
  ) {
    return offset - 1;
  }

  return offset;
}

function scalar_boundary_after(text: string, offset: number): number {
  if (
    offset > 0 && offset < text.length &&
    is_high_surrogate(text.charCodeAt(offset - 1)) &&
    is_low_surrogate(text.charCodeAt(offset))
  ) {
    return offset + 1;
  }

  return offset;
}

function is_high_surrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function is_low_surrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
