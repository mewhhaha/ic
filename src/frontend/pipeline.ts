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
import {
  apply_front_function_signatures,
  infer_front_function_signatures,
} from "./signature_inference.ts";
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
import { expand_source_attributes } from "./attribute.ts";
import {
  infer_default_effect_handlers,
  source_has_implicit_try,
} from "./default_handler.ts";
import {
  source_with_import_meta,
  type SourceImportMeta,
} from "./import_meta.ts";

export type FrontendAnalysisOptions = {
  import_meta?: SourceImportMeta;
  resolve_import?: SourceImportResolver;
  uri?: string;
  warnings?: boolean;
  allow_intrinsics?: boolean;
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
  let analyzed_source = source;

  try {
    analyzed_source = source_with_expanded_attributes(
      source,
      options.import_meta,
    );
    derive_missing_source_spans(analyzed_source, { start: 0, end: 0 });
  } catch (error) {
    if (error instanceof SourceDiagnosticError) {
      diagnostics.push(error.diagnostic);
      return {
        source: analyzed_source,
        facts: source_facts(analyzed_source),
        diagnostics,
      };
    }

    throw error;
  }

  try {
    analyzed_source = instantiate_named_effects(analyzed_source);

    if (source_has_implicit_try(analyzed_source)) {
      analyzed_source = specialize_front_effects(analyzed_source);
      analyzed_source = infer_default_effect_handlers(analyzed_source);
    }
  } catch (error) {
    if (error instanceof SourceDiagnosticError) {
      diagnostics.push(error.diagnostic);
    } else {
      throw error;
    }
  }

  const facts = source_facts(analyzed_source);
  const allow_intrinsics = options.allow_intrinsics === true ||
    source_uri_allows_intrinsics(options.uri);
  const semantic_diagnostics = validate_frontend_semantics(analyzed_source, {
    warnings: options.warnings,
    allow_intrinsics: true,
  });
  diagnostics.push(...semantic_diagnostics);

  if (options.warnings === true && !allow_intrinsics) {
    diagnostics.push(
      ...validate_frontend_semantics(parsed.source, {
        warnings: true,
      }).filter((diagnostic) => diagnostic.code === "DUCK2004"),
    );
  }

  if (!contains_error(diagnostics)) {
    let inference_source = specialize_const_module_imports(
      resolve_bundled_source_imports(analyzed_source),
    );
    inference_source = infer_front_function_signatures(inference_source);
    inference_source = elaborate_front_ducks(inference_source);
    inference_source = infer_front_function_signatures(inference_source);
    const inference_facts = source_facts(inference_source);
    diagnostics.push(
      ...source_inference_diagnostics(inference_source, inference_facts),
    );
  }

  append_affine_diagnostics(analyzed_source, diagnostics);
  return { source: analyzed_source, facts, diagnostics };
}

function source_uri_allows_intrinsics(uri: string | undefined): boolean {
  if (uri === undefined) {
    return false;
  }

  const name = uri.slice(uri.lastIndexOf("/") + 1);
  return name === "prelude.duck" || name.startsWith("prelude_");
}

export function source_for_ic_route(source: Source): Source {
  source = source_with_expanded_attributes(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  source = specialize_front_effects(source);
  source = infer_default_effect_handlers(source);
  require_rank_n_types(source);
  require_condition_types(source);
  validate_atom_identities(source);
  validate_ic_route(source);
  return elaborate_source(source);
}

export function source_for_core_route(source: Source): Source {
  source = source_with_expanded_attributes(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  source = specialize_front_effects(source);
  source = infer_default_effect_handlers(source);
  require_rank_n_types(source);
  require_core_representation(source);
  source = erase_undemanded_front_bindings(elaborate_source(source));
  validate_atom_identities(source);
  validate_source_linear(source);
  return source;
}

export function source_effects(source: Source): FrontEffectAnalysis {
  source = source_with_expanded_attributes(source);
  source = specialize_front_effects(source);
  source = infer_default_effect_handlers(source);
  return analyze_front_effects(source);
}

export function source_with_expanded_attributes(
  source: Source,
  import_meta: SourceImportMeta = {},
): Source {
  source = source_with_import_meta(source, import_meta);
  const imported_source = resolve_bundled_source_imports(source);
  const inferred_source = infer_front_function_signatures(imported_source);
  const contextual_source = apply_front_function_signatures(
    source,
    inferred_source,
  );

  if (contextual_source === source) {
    source = imported_source;
  } else {
    source = resolve_bundled_source_imports(contextual_source);
  }

  source = infer_front_function_signatures(source);
  source = specialize_const_module_imports(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  return expand_source_attributes(source);
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
  source = infer_front_function_signatures(source);
  source = elaborate_front_ducks(source);
  source = infer_front_function_signatures(source);
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

function require_condition_types(source: Source): void {
  const diagnostics = validate_frontend_semantics(source);

  for (const diagnostic of diagnostics) {
    if (
      diagnostic.severity === "error" &&
      diagnostic.code === diagnostic_codes.condition_type_mismatch &&
      diagnostic.message.startsWith("If condition expects Bool")
    ) {
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
