export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticCategory =
  | "syntax"
  | "names_and_liveness"
  | "compile_time_restriction"
  | "affine_use"
  | "types_and_effects"
  | "ownership_and_proof"
  | "modules_and_imports"
  | "backend_route";

export const diagnostic_registry = {
  syntax_error: diagnostic_definition(
    "DUCK1001",
    "syntax",
    "error",
  ),
  unused_binding: diagnostic_definition(
    "DUCK2003",
    "names_and_liveness",
    "warning",
  ),
  const_expression_required: diagnostic_definition(
    "DUCK2101",
    "compile_time_restriction",
    "error",
  ),
  const_capture_rejected: diagnostic_definition(
    "DUCK2102",
    "compile_time_restriction",
    "error",
  ),
  linear_value_reused: diagnostic_definition(
    "DUCK2201",
    "affine_use",
    "error",
  ),
  linear_value_unused: diagnostic_definition(
    "DUCK2202",
    "affine_use",
    "error",
  ),
  linear_capture_rejected: diagnostic_definition(
    "DUCK2203",
    "affine_use",
    "error",
  ),
  linear_value_required: diagnostic_definition(
    "DUCK2204",
    "affine_use",
    "error",
  ),
  linear_branch_mismatch: diagnostic_definition(
    "DUCK2205",
    "affine_use",
    "error",
  ),
  linear_state_mismatch: diagnostic_definition(
    "DUCK2206",
    "affine_use",
    "error",
  ),
  linear_control_flow_rejected: diagnostic_definition(
    "DUCK2207",
    "affine_use",
    "error",
  ),
  affine_form_unsupported: diagnostic_definition(
    "DUCK2290",
    "affine_use",
    "error",
  ),
  loop_break_type_mismatch: diagnostic_definition(
    "DUCK2291",
    "affine_use",
    "error",
  ),
  assignment_type_change: diagnostic_definition(
    "DUCK2301",
    "types_and_effects",
    "error",
  ),
  operand_type_mismatch: diagnostic_definition(
    "DUCK2302",
    "types_and_effects",
    "error",
  ),
  condition_type_mismatch: diagnostic_definition(
    "DUCK2303",
    "types_and_effects",
    "error",
  ),
  aggregate_field_mismatch: diagnostic_definition(
    "DUCK2304",
    "types_and_effects",
    "error",
  ),
  sum_payload_mismatch: diagnostic_definition(
    "DUCK2305",
    "types_and_effects",
    "error",
  ),
  annotation_type_mismatch: diagnostic_definition(
    "DUCK2306",
    "types_and_effects",
    "error",
  ),
  call_type_mismatch: diagnostic_definition(
    "DUCK2307",
    "types_and_effects",
    "error",
  ),
  unresolved_call_type: diagnostic_definition(
    "DUCK2310",
    "types_and_effects",
    "error",
  ),
  unresolved_annotation_type: diagnostic_definition(
    "DUCK2311",
    "types_and_effects",
    "error",
  ),
  rank_n_type_mismatch: diagnostic_definition(
    "DUCK2312",
    "types_and_effects",
    "error",
  ),
  default_handler_resolution: diagnostic_definition(
    "DUCK2313",
    "types_and_effects",
    "error",
  ),
  borrow_proof_rejected: diagnostic_definition(
    "DUCK2401",
    "ownership_and_proof",
    "error",
  ),
  freeze_proof_rejected: diagnostic_definition(
    "DUCK2402",
    "ownership_and_proof",
    "error",
  ),
  scratch_escape_rejected: diagnostic_definition(
    "DUCK2403",
    "ownership_and_proof",
    "error",
  ),
  frozen_mutation_rejected: diagnostic_definition(
    "DUCK2404",
    "ownership_and_proof",
    "error",
  ),
  import_context_missing: diagnostic_definition(
    "DUCK2500",
    "modules_and_imports",
    "error",
  ),
  import_contract_mismatch: diagnostic_definition(
    "DUCK2501",
    "modules_and_imports",
    "error",
  ),
  import_dependency_missing: diagnostic_definition(
    "DUCK2502",
    "modules_and_imports",
    "error",
  ),
  import_syntax_error: diagnostic_definition(
    "DUCK2503",
    "modules_and_imports",
    "error",
  ),
  import_cycle: diagnostic_definition(
    "DUCK2504",
    "modules_and_imports",
    "error",
  ),
  import_uri_invalid: diagnostic_definition(
    "DUCK2505",
    "modules_and_imports",
    "error",
  ),
  backend_route_unsupported: diagnostic_definition(
    "DUCK2901",
    "backend_route",
    "error",
  ),
} as const;

export type DiagnosticName = keyof typeof diagnostic_registry;
export type DiagnosticCode =
  (typeof diagnostic_registry)[DiagnosticName]["code"];
export type RegisteredDiagnostic = (typeof diagnostic_registry)[DiagnosticName];

export const diagnostic_codes: {
  readonly [name in DiagnosticName]: (typeof diagnostic_registry)[name]["code"];
} = Object.fromEntries(
  Object.entries(diagnostic_registry).map(([name, definition]) => {
    return [name, definition.code];
  }),
) as {
  readonly [name in DiagnosticName]: (typeof diagnostic_registry)[name]["code"];
};

const diagnostic_definitions_by_code = new Map<
  DiagnosticCode,
  RegisteredDiagnostic
>();

for (const definition of Object.values(diagnostic_registry)) {
  diagnostic_definitions_by_code.set(definition.code, definition);
}

export type DiagnosticSpan = {
  start: number;
  end: number;
};

export type CompilerDiagnosticRelated = {
  message: string;
  span: DiagnosticSpan;
  uri?: string;
};

export type CompilerDiagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  span: DiagnosticSpan;
  uri?: string;
  related?: CompilerDiagnosticRelated[];
};

export class CompilerDiagnosticError extends Error {
  constructor(readonly diagnostic: CompilerDiagnostic) {
    super(diagnostic.message);
    this.name = "CompilerDiagnosticError";
  }
}

export function registered_diagnostic(
  code: DiagnosticCode,
): RegisteredDiagnostic {
  const definition = diagnostic_definitions_by_code.get(code);

  if (definition === undefined) {
    throw new Error("Missing diagnostic registry entry for " + code);
  }

  return definition;
}

export function compiler_diagnostic(
  code: DiagnosticCode,
  message: string,
  span: DiagnosticSpan,
  related?: CompilerDiagnosticRelated[],
): CompilerDiagnostic {
  const diagnostic: CompilerDiagnostic = {
    code,
    severity: registered_diagnostic(code).default_severity,
    message,
    span,
  };

  if (related !== undefined) {
    diagnostic.related = related;
  }

  return diagnostic;
}

export function diagnostic_sequence(
  diagnostics: readonly CompilerDiagnostic[],
  default_uri?: string,
): CompilerDiagnostic[] {
  const normalized = diagnostics.map((diagnostic) => {
    return diagnostic_with_uri(diagnostic, default_uri);
  });
  normalized.sort(compare_diagnostics);

  const result: CompilerDiagnostic[] = [];
  const roots = new Set<string>();

  for (const diagnostic of normalized) {
    const key = diagnostic_root_key(diagnostic);

    if (roots.has(key)) {
      continue;
    }

    roots.add(key);
    result.push(diagnostic);
  }

  return result;
}

function diagnostic_definition<
  code extends string,
  category extends DiagnosticCategory,
  severity extends DiagnosticSeverity,
>(
  code: code,
  category: category,
  default_severity: severity,
): {
  code: code;
  category: category;
  default_severity: severity;
} {
  return { code, category, default_severity };
}

function diagnostic_with_uri(
  diagnostic: CompilerDiagnostic,
  default_uri: string | undefined,
): CompilerDiagnostic {
  let uri = diagnostic.uri;

  if (uri === undefined) {
    uri = default_uri;
  }

  let related: CompilerDiagnosticRelated[] | undefined;

  if (diagnostic.related !== undefined) {
    related = diagnostic.related.map((entry) => {
      let related_uri = entry.uri;

      if (related_uri === undefined) {
        related_uri = uri;
      }

      const normalized: CompilerDiagnosticRelated = {
        message: entry.message,
        span: entry.span,
      };

      if (related_uri !== undefined) {
        normalized.uri = related_uri;
      }

      return normalized;
    });
    related = related.filter((entry, index) => {
      const previous = related?.[index - 1];

      if (previous === undefined) {
        return true;
      }

      return related_diagnostic_key(entry) !== related_diagnostic_key(previous);
    });
  }

  const normalized: CompilerDiagnostic = {
    code: diagnostic.code,
    severity: registered_diagnostic(diagnostic.code).default_severity,
    message: diagnostic.message,
    span: diagnostic.span,
  };

  if (uri !== undefined) {
    normalized.uri = uri;
  }

  if (related !== undefined && related.length > 0) {
    normalized.related = related;
  }

  return normalized;
}

function compare_diagnostics(
  left: CompilerDiagnostic,
  right: CompilerDiagnostic,
): number {
  const uri_order = compare_text(left.uri, right.uri);
  if (uri_order !== 0) {
    return uri_order;
  }

  const start_order = left.span.start - right.span.start;
  if (start_order !== 0) {
    return start_order;
  }

  const end_order = left.span.end - right.span.end;
  if (end_order !== 0) {
    return end_order;
  }

  const code_order = left.code.localeCompare(right.code);
  if (code_order !== 0) {
    return code_order;
  }

  return left.message.localeCompare(right.message);
}

function compare_text(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }

  if (left === undefined) {
    return -1;
  }

  if (right === undefined) {
    return 1;
  }

  return left.localeCompare(right);
}

function diagnostic_root_key(diagnostic: CompilerDiagnostic): string {
  return optional_text_key(diagnostic.uri) + "\u0000" + diagnostic.code +
    "\u0000" +
    diagnostic.span.start.toString() + "\u0000" +
    diagnostic.span.end.toString() + "\u0000" + diagnostic.message;
}

function related_diagnostic_key(
  related: CompilerDiagnosticRelated,
): string {
  return optional_text_key(related.uri) + "\u0000" +
    related.span.start.toString() +
    "\u0000" + related.span.end.toString() + "\u0000" + related.message;
}

function optional_text_key(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  return value;
}
