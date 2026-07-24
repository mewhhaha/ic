import type { Source as SourceNode } from "./ast.ts";
import { ParserStmt } from "./parser_stmt.ts";
import { scan_source, source_tokens } from "./tokenize.ts";
import type { SourceSyntax, SyntaxDiagnostic } from "./syntax.ts";
import { mark_source_span, mark_source_syntax } from "./syntax.ts";
import type { RecoveryInterval } from "./parser_cursor.ts";
import { collect_source_fixities } from "./fixity.ts";

export function parse_source(text: string): SourceNode {
  const syntax = scan_source(text);
  const diagnostic = syntax.diagnostics[0];

  if (diagnostic !== undefined) {
    throw new Error(diagnostic.message);
  }

  const tokens = source_tokens(syntax);
  const parser = new ParserStmt(
    tokens,
    collect_source_fixities(tokens),
  );
  const source = parser.parse_program();
  mark_source_syntax(source, syntax);
  return source;
}

export type ParseSourceResult = {
  source: SourceNode;
  diagnostics: SyntaxDiagnostic[];
  recovery_intervals: RecoveryInterval[];
  syntax: SourceSyntax;
};

export function parse_source_with_diagnostics(text: string): ParseSourceResult {
  const syntax = scan_source(text);
  const tokens = source_tokens(syntax);

  try {
    const parser = new ParserStmt(
      tokens,
      collect_source_fixities(tokens),
    );
    const parsed = parser.parse_program_with_diagnostics();
    mark_source_syntax(parsed.source, syntax);
    return {
      source: parsed.source,
      diagnostics: ordered_diagnostics(
        syntax.diagnostics,
        parsed.diagnostics,
      ),
      recovery_intervals: parsed.recovery_intervals,
      syntax,
    };
  } catch (error) {
    const eof = tokens[tokens.length - 1];
    if (eof === undefined) {
      throw new Error("Scanner did not produce EOF");
    }
    let message: string;

    if (error instanceof Error) {
      message = error.message;
    } else {
      message = String(error);
    }
    const source: SourceNode = { tag: "program", statements: [] };
    mark_source_span(source, { start: 0, end: text.length });
    mark_source_syntax(source, syntax);
    return {
      source,
      diagnostics: ordered_diagnostics(
        syntax.diagnostics,
        [{ message, span: eof.span }],
      ),
      recovery_intervals: [{
        diagnostic: { message, span: eof.span },
        skipped: { start: eof.span.start, end: eof.span.start },
      }],
      syntax,
    };
  }
}

function ordered_diagnostics(
  scanner: SyntaxDiagnostic[],
  parser: SyntaxDiagnostic[],
): SyntaxDiagnostic[] {
  return [...scanner, ...parser].sort((left, right) => {
    if (left.span.start !== right.span.start) {
      return left.span.start - right.span.start;
    }

    return left.span.end - right.span.end;
  });
}
