import { diagnostic_sequence } from "../diagnostic.ts";
import { Format } from "../trait.ts";
import type { Source as SourceNode } from "./ast.ts";
import type { FrontEffectAnalysis } from "./effect_analysis.ts";
import { format_source } from "./format.ts";
import { source_with_host_interface } from "./host_interface.ts";
import type { SourceImportResolver } from "./import_diagnostic.ts";
import {
  source_with_import_meta,
  type SourceImportMeta,
} from "./import_meta.ts";
import {
  load_source,
  load_source_fragment_file,
  source_file_url,
} from "./load.ts";
import {
  parse_source,
  parse_source_with_diagnostics,
  type ParseSourceResult,
} from "./parser.ts";
import { analyze_frontend, source_effects } from "./pipeline.ts";
import type { SourceDiagnostic } from "./semantic_diagnostic.ts";
import type { SyntaxDiagnostic } from "./syntax.ts";

export type Source = SourceNode;

export type SourceAnalyzeOptions = {
  host_interface?: SourceNode;
  import_meta?: SourceImportMeta;
  uri?: string;
  resolve_import?: SourceImportResolver;
  warnings?: boolean;
  allow_intrinsics?: boolean;
};

export type SourceAnalysis = {
  source: SourceNode;
  syntax: ReturnType<typeof parse_source_with_diagnostics>["syntax"];
  syntax_diagnostics: SyntaxDiagnostic[];
  diagnostics: SourceDiagnostic[];
};

export function Source() {}

Source.parse = parse_source;
Source.parse_with_diagnostics = parse_source_with_diagnostics;
Source.with_import_meta = source_with_import_meta;

Source.analyze = function analyze(
  text: string,
  options: SourceAnalyzeOptions = {},
): SourceAnalysis {
  return Source.analyze_parsed(Source.parse_with_diagnostics(text), options);
};

Source.analyze_parsed = function analyze_parsed(
  parsed: ParseSourceResult,
  options: SourceAnalyzeOptions = {},
): SourceAnalysis {
  let source = parsed.source;

  if (options.host_interface !== undefined) {
    source = source_with_host_interface(source, options.host_interface);
  }

  const analysis = analyze_frontend(parsed, source, options);

  return {
    source,
    syntax: parsed.syntax,
    syntax_diagnostics: parsed.diagnostics,
    diagnostics: diagnostic_sequence(analysis.diagnostics, options.uri),
  };
};

Source.analyze_file = function analyze_file(
  path: string,
  options: SourceAnalyzeOptions = {},
): SourceAnalysis {
  const uri = source_file_url(path);
  const text = Deno.readTextFileSync(uri);
  return Source.analyze(text, {
    ...options,
    uri: uri.href,
    resolve_import: resolve_file_import,
  });
};

Source.fmt = format_source;

Source.effects = function effects(
  input: string | SourceNode,
): FrontEffectAnalysis {
  let source: SourceNode;

  if (typeof input === "string") {
    source = Source.parse(input);
  } else {
    source = input;
  }

  return source_effects(source);
};

Source.load = load_source;
Source.load_fragment_file = load_source_fragment_file;

function resolve_file_import(uri: string): string | undefined {
  try {
    return Deno.readTextFileSync(new URL(uri));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }

    throw error;
  }
}

Format.register<SourceNode>(Source);
