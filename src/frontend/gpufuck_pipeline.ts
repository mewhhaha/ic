import { diagnostic_codes } from "../diagnostic.ts";
import type { Source } from "./ast.ts";
import { validate_atom_identities } from "./atom.ts";
import { source_with_expanded_attributes } from "./attribute_expand.ts";
import { infer_default_effect_handlers } from "./default_handler.ts";
import { erase_undemanded_front_bindings } from "./demand.ts";
import { elaborate_front_ducks } from "./duck_elaborate.ts";
import { analyze_front_effects } from "./effect_analysis.ts";
import { elaborate_front_effects } from "./effect_elaborate.ts";
import { specialize_front_effects } from "./effect_specialize.ts";
import { elaborate_front_let_else } from "./let_else.ts";
import { apply_front_inferred_nominal_bindings } from "./nominal_elaborate.ts";
import { validate_source_linear } from "./linear.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";
import { SourceDiagnosticError } from "./semantic_diagnostic.ts";
import { infer_front_function_signatures } from "./signature_inference.ts";
import { source_facts, source_inference_diagnostics } from "./source_facts.ts";
import { derive_missing_source_spans } from "./syntax.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";
import {
  elaborate_front_loops,
  elaborate_front_ranges,
} from "./loop_elaborate.ts";

export function source_for_gpufuck(source: Source): Source {
  source = source_with_expanded_attributes(source);
  return expanded_source_for_gpufuck(source);
}

export function expanded_source_for_gpufuck(source: Source): Source {
  source = elaborate_source_for_gpufuck(source);
  source = erase_undemanded_front_bindings(source);
  validate_atom_identities(source);
  validate_source_linear(source);
  return source;
}

function elaborate_source_for_gpufuck(source: Source): Source {
  derive_missing_source_spans(source, { start: 0, end: 0 });
  source = specialize_front_effects(source);
  source = infer_default_effect_handlers(source);
  require_rank_n_types(source);
  require_gpufuck_representation(source);
  source = elaborate_source(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  return source;
}

function elaborate_source(source: Source): Source {
  source = elaborate_front_let_else(source);
  source = infer_front_function_signatures(source);
  const inferred_source = source;
  source = elaborate_front_ducks(source);

  if (source !== inferred_source) {
    source = infer_front_function_signatures(source);
    source = elaborate_front_ducks(source);
  }

  const effects = analyze_front_effects(source);
  const has_effects = effects.module_effects.length > 0 ||
    Object.values(effects.functions).some((func) => func.effects.length > 0);

  if (!has_effects) {
    source = elaborate_front_ranges(source);
    source = elaborate_front_loops(source);
  }

  source = apply_front_inferred_nominal_bindings(source);
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

function require_gpufuck_representation(source: Source): void {
  const diagnostics = validate_frontend_semantics(source, {
    scope: "gpufuck-representation",
  });

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      throw new SourceDiagnosticError(diagnostic);
    }
  }
}
