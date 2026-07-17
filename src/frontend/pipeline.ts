import {
  compiler_diagnostic,
  CompilerDiagnosticError,
  diagnostic_codes,
} from "../diagnostic.ts";
import type { Source } from "./ast.ts";
import { validate_atom_identities } from "./atom.ts";
import {
  analyze_front_effects,
  type FrontEffectAnalysis,
} from "./effect_analysis.ts";
import { elaborate_front_effects } from "./effect_elaborate.ts";
import {
  instantiate_named_effects,
  specialize_front_effects,
} from "./effect_specialize.ts";
import { elaborate_front_ducks } from "./duck_elaborate.ts";
import { erase_undemanded_front_bindings } from "./demand.ts";
import {
  type SourceImportResolver,
  validate_source_import_context,
  validate_source_imports,
} from "./import_diagnostic.ts";
import { validate_ic_route } from "./ic_route.ts";
import { validate_source_linear } from "./linear.ts";
import { resolve_bundled_source_imports } from "./load.ts";
import { specialize_const_module_imports } from "./module_specialize.ts";
import type { ParseSourceResult } from "./parser.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";
import {
  type SourceDiagnostic,
  SourceDiagnosticError,
} from "./semantic_diagnostic.ts";
import {
  source_facts,
  source_inference_diagnostics,
  type SourceFacts,
} from "./source_facts.ts";
import { derive_missing_source_spans } from "./syntax.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";

export type FrontendAnalysisOptions = {
  resolve_import?: SourceImportResolver;
  uri?: string;
  warnings?: boolean;
};

export type FrontendAnalysis = {
  source: Source;
  facts: SourceFacts;
  diagnostics: SourceDiagnostic[];
};

export function analyze_frontend(
  parsed: ParseSourceResult,
  source: Source,
  options: FrontendAnalysisOptions,
): FrontendAnalysis {
  const diagnostics = syntax_diagnostics(parsed);
  diagnostics.push(...name_and_scope_diagnostics(parsed, source, options));
  let analyzed_source = resolve_bundled_source_imports(source);

  try {
    analyzed_source = instantiate_named_effects(analyzed_source);
  } catch (error) {
    if (error instanceof SourceDiagnosticError) {
      diagnostics.push(error.diagnostic);
    } else {
      throw error;
    }
  }

  const facts = source_facts(analyzed_source);
  const semantic_diagnostics = validate_frontend_semantics(analyzed_source, {
    warnings: options.warnings,
  });
  diagnostics.push(...semantic_diagnostics);

  if (!contains_error(diagnostics)) {
    const inference_source = specialize_const_module_imports(
      resolve_bundled_source_imports(analyzed_source),
    );
    const inference_facts = source_facts(inference_source);
    diagnostics.push(
      ...source_inference_diagnostics(inference_source, inference_facts),
    );
  }

  append_affine_diagnostics(analyzed_source, diagnostics);
  return { source: analyzed_source, facts, diagnostics };
}

export function source_for_ic_route(source: Source): Source {
  source = resolve_bundled_source_imports(source);
  source = specialize_const_module_imports(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  source = specialize_front_effects(source);
  require_rank_n_types(source);
  validate_atom_identities(source);
  validate_ic_route(source);
  return elaborate_source(source);
}

export function source_for_core_route(source: Source): Source {
  source = resolve_bundled_source_imports(source);
  source = specialize_const_module_imports(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  source = specialize_front_effects(source);
  require_rank_n_types(source);
  require_core_representation(source);
  source = erase_undemanded_front_bindings(elaborate_source(source));
  validate_atom_identities(source);
  validate_source_linear(source);
  return source;
}

export function source_effects(source: Source): FrontEffectAnalysis {
  source = resolve_bundled_source_imports(source);
  source = specialize_const_module_imports(source);
  return analyze_front_effects(specialize_front_effects(source));
}

function syntax_diagnostics(parsed: ParseSourceResult): SourceDiagnostic[] {
  return parsed.diagnostics.map((diagnostic) => {
    return compiler_diagnostic(
      diagnostic_codes.syntax_error,
      diagnostic.message,
      diagnostic.span,
    );
  });
}

function name_and_scope_diagnostics(
  parsed: ParseSourceResult,
  source: Source,
  options: FrontendAnalysisOptions,
): SourceDiagnostic[] {
  if (options.uri !== undefined && options.resolve_import !== undefined) {
    return validate_source_imports(
      parsed.source,
      options.uri,
      options.resolve_import,
    );
  }

  return validate_source_import_context(source);
}

function append_affine_diagnostics(
  source: Source,
  diagnostics: SourceDiagnostic[],
): void {
  try {
    validate_source_linear(source);
  } catch (error) {
    if (error instanceof CompilerDiagnosticError) {
      diagnostics.push(error.diagnostic);
      return;
    }

    throw error;
  }
}

function elaborate_source(source: Source): Source {
  source = elaborate_front_ducks(source);
  source = elaborate_front_effects(source);
  return elaborate_front_type_sets(source);
}

function require_rank_n_types(source: Source): void {
  const diagnostics = source_inference_diagnostics(
    source,
    source_facts(source),
  );

  for (const diagnostic of diagnostics) {
    if (
      diagnostic.severity === "error" &&
      diagnostic.code === diagnostic_codes.rank_n_type_mismatch
    ) {
      throw new SourceDiagnosticError(diagnostic);
    }
  }
}

function require_core_representation(source: Source): void {
  const diagnostics = validate_frontend_semantics(source, {
    scope: "core-representation",
  });

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      throw new SourceDiagnosticError(diagnostic);
    }
  }
}

function contains_error(diagnostics: SourceDiagnostic[]): boolean {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      return true;
    }
  }

  return false;
}
