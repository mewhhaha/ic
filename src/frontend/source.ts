import type { Ic as IcNode } from "../ic.ts";
import {
  Core,
  type Core as CoreNode,
  core_proof_diagnostic,
  type CoreProofIssue,
} from "../core.ts";
import { CompilerDiagnosticError } from "../diagnostic.ts";
import { Ic } from "../ic.ts";
import type { IcOpenOptions } from "../ic/open_term.ts";
import { Mod, type Mod as ModNode } from "../mod.ts";
import { Emit, Format } from "../trait.ts";
import type { Wat } from "../wat.ts";
import {
  type AbiManifest,
  build_abi_manifest,
  managed_abi_mod,
} from "../abi.ts";
import type { Source as SourceNode } from "./ast.ts";
import { format_source } from "./format.ts";
import {
  analyze_front_effects,
  type FrontEffectAnalysis,
} from "./effect_analysis.ts";
import { elaborate_front_effects } from "./effect_elaborate.ts";
import { diagnose_ic_route, validate_ic_route } from "./ic_route.ts";
import { validate_source_linear } from "./linear.ts";
import { validate_atom_identities } from "./atom.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";
import {
  load_source,
  load_source_fragment_file,
  resolve_source_imports,
  source_file_url,
} from "./load.ts";
import { lower_program } from "./lower.ts";
import {
  parse_source,
  parse_source_with_diagnostics,
  type ParseSourceResult,
} from "./parser.ts";
import {
  source_import_expressions,
  type SourceImportResolver,
  validate_source_import_context,
  validate_source_imports,
} from "./import_diagnostic.ts";
import { validate_frontend_semantics } from "./semantic_validation.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
  SourceDiagnosticError,
} from "./semantic_diagnostic.ts";
import {
  derive_missing_source_spans,
  type SyntaxDiagnostic,
} from "./syntax.ts";
import {
  source_facts,
  source_inference_diagnostics,
  type SourceFacts,
} from "./source_facts.ts";

export type Source = SourceNode;

export type SourceArtifact = {
  mod: ModNode;
  wat: Wat;
  abi: AbiManifest;
};

export type SourceArtifactOptions = {
  name?: string;
  host_interface?: SourceNode;
};

export type SourceArtifactFileOptions = {
  name?: string;
  host_interface?: string;
};

export type SourceAnalyzeOptions = {
  host_interface?: SourceNode;
  route?: "ic" | "core" | "managed";
  uri?: string;
  resolve_import?: SourceImportResolver;
  warnings?: boolean;
};

export type SourceAnalysis = {
  source: SourceNode;
  facts: SourceFacts;
  syntax: ReturnType<typeof parse_source_with_diagnostics>["syntax"];
  syntax_diagnostics: SyntaxDiagnostic[];
  diagnostics: SourceDiagnostic[];
};

export function Source() {}

Source.parse = parse_source;
Source.parse_with_diagnostics = parse_source_with_diagnostics;

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
    source = merge_host_interface(source, options.host_interface);
  }

  const diagnostics: SourceDiagnostic[] = [];

  for (const diagnostic of parsed.diagnostics) {
    diagnostics.push({
      code: "IX1001",
      severity: "error",
      message: diagnostic.message,
      span: diagnostic.span,
    });
  }

  if (options.uri !== undefined && options.resolve_import !== undefined) {
    diagnostics.push(...validate_source_imports(
      parsed.source,
      options.uri,
      options.resolve_import,
    ));
  } else {
    diagnostics.push(...validate_source_import_context(source));
  }

  diagnostics.push(...validate_frontend_semantics(source, {
    warnings: options.warnings,
  }));

  const facts = source_facts(source);

  if (!has_error_diagnostic(diagnostics)) {
    diagnostics.push(...source_inference_diagnostics(source, facts));
  }

  try {
    validate_source_linear(source);
  } catch (error) {
    if (error instanceof CompilerDiagnosticError) {
      diagnostics.push(error.diagnostic);
    } else {
      throw error;
    }
  }

  if (!has_error_diagnostic(diagnostics) && options.route === "ic") {
    diagnostics.push(...diagnose_ic_route(source));
  }

  if (
    !has_error_diagnostic(diagnostics) &&
    (options.route === "core" || options.route === "managed")
  ) {
    const route_source = source_for_route_analysis(source, options);

    if (route_source !== undefined) {
      diagnostics.push(...core_route_diagnostics(route_source));
    }
  }

  if (options.uri !== undefined) {
    attach_diagnostic_uri(diagnostics, options.uri);
  }

  return {
    source,
    facts,
    syntax: parsed.syntax,
    syntax_diagnostics: parsed.diagnostics,
    diagnostics,
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

Source.emit = function emit(source: SourceNode): IcNode {
  validate_atom_identities(source);
  validate_ic_route(source);
  return lower_program(elaborate_front_type_sets(source));
};

Source.fmt = format_source;

Source.effects = function effects(
  input: string | SourceNode,
): FrontEffectAnalysis {
  if (typeof input === "string") {
    return analyze_front_effects(Source.parse(input));
  }

  return analyze_front_effects(input);
};

Source.compile = function compile(text: string): IcNode {
  return Source.emit(Source.parse(text));
};

Source.core = function core(input: string | SourceNode): CoreNode {
  let source: SourceNode;

  if (typeof input === "string") {
    source = Source.parse(input);
  } else {
    source = input;
  }

  reject_public_host_imports(source);
  return core_from_source_with_internal_imports(source);
};

Source.mod = function mod(input: string | SourceNode, name = "main"): ModNode {
  return Core.mod(Source.core(input), name);
};

Source.wat = function wat(input: string | SourceNode, name = "main"): Wat {
  return Mod.emit(Source.mod(input, name));
};

Source.artifact = function artifact(
  input: string | SourceNode,
  options: string | SourceArtifactOptions = "main",
): SourceArtifact {
  let source: SourceNode;

  if (typeof input === "string") {
    source = Source.parse(input);
  } else {
    source = input;
  }

  return artifact_from_source(source, options, false);
};

function artifact_from_source(
  source: SourceNode,
  options: string | SourceArtifactOptions,
  allow_internal_imports: boolean,
): SourceArtifact {
  let name = "main";

  if (typeof options === "string") {
    name = options;
  } else {
    if (options.name) {
      name = options.name;
    }

    if (options.host_interface) {
      source = merge_host_interface(source, options.host_interface);
    }
  }

  if (!allow_internal_imports) {
    reject_public_host_imports(source);
  }

  const compiled_source = prepare_core_source(source);
  const abi = build_abi_manifest(source, compiled_source);
  const core = core_from_elaborated_source(compiled_source);
  const mod = managed_abi_mod(Core.mod(core, name), abi);
  return {
    mod,
    wat: Mod.emit(mod),
    abi,
  };
}

// These helpers are imported only by the backend fixture facade. They are not
// re-exported from frontend.ts and do not make raw imports source syntax.
export function core_from_source_with_internal_imports_for_test(
  source: SourceNode,
): CoreNode {
  return core_from_source_with_internal_imports(source);
}

export function artifact_from_source_with_internal_imports_for_test(
  source: SourceNode,
  options: string | SourceArtifactOptions = "main",
): SourceArtifact {
  return artifact_from_source(source, options, true);
}

Source.ic_mod = function ic_mod(
  input: string | SourceNode,
  options?: IcOpenOptions,
): ModNode {
  let source: SourceNode;

  if (typeof input === "string") {
    source = Source.parse(input);
  } else {
    source = input;
  }

  return Ic.mod(Source.emit(source), options);
};

Source.ic_wat = function ic_wat(
  input: string | SourceNode,
  options?: IcOpenOptions,
): Wat {
  return Mod.emit(Source.ic_mod(input, options));
};

Source.load = load_source;

Source.load_fragment_file = load_source_fragment_file;

Source.compile_file = function compile_file(path: string): IcNode {
  return Source.emit(Source.load(path));
};

Source.core_file = function core_file(path: string): CoreNode {
  return Source.core(Source.load(path));
};

Source.mod_file = function mod_file(path: string, name = "main"): ModNode {
  return Source.mod(Source.load(path), name);
};

Source.wat_file = function wat_file(path: string, name = "main"): Wat {
  return Source.wat(Source.load(path), name);
};

Source.artifact_file = function artifact_file(
  path: string,
  options: string | SourceArtifactFileOptions = "main",
): SourceArtifact {
  let source = Source.load(path);
  let name = "main";

  if (typeof options === "string") {
    name = options;
  } else {
    if (options.name) {
      name = options.name;
    }

    if (options.host_interface) {
      source = merge_host_interface(
        source,
        Source.load(options.host_interface),
      );
    }
  }

  return Source.artifact(source, name);
};

function merge_host_interface(
  source: SourceNode,
  host_interface: SourceNode,
): SourceNode {
  const host_declarations = host_interface.declarations || [];
  const source_declarations = source.declarations || [];
  const declarations = [...host_declarations, ...source_declarations];
  const names = new Set<string>();

  for (const declaration of declarations) {
    if (names.has(declaration.name)) {
      throw new Error(
        "Duplicate host interface declaration: " + declaration.name,
      );
    }

    names.add(declaration.name);
  }

  return { ...source, declarations };
}

function core_from_source_with_internal_imports(source: SourceNode): CoreNode {
  return core_from_elaborated_source(prepare_core_source(source));
}

function prepare_core_source(source: SourceNode): SourceNode {
  derive_missing_source_spans(source, { start: 0, end: 0 });
  const diagnostics = validate_frontend_semantics(source, {
    scope: "bool-representation",
  });

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      throw new SourceDiagnosticError(diagnostic);
    }
  }

  return elaborate_front_type_sets(elaborate_front_effects(source));
}

function core_from_elaborated_source(source: SourceNode): CoreNode {
  validate_atom_identities(source);
  validate_source_linear(source);
  return Core.from_source(source);
}

function reject_public_host_imports(source: SourceNode): void {
  for (const stmt of source.statements) {
    if (stmt.tag === "host_import") {
      throw new Error(
        "`host_import` is not source syntax; use `declare effect` and " +
          "provide its resource through `Init`",
      );
    }
  }
}

function attach_diagnostic_uri(
  diagnostics: SourceDiagnostic[],
  uri: string,
): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.uri === undefined) {
      diagnostic.uri = uri;
    }

    if (diagnostic.related === undefined) {
      continue;
    }

    for (const related of diagnostic.related) {
      if (related.uri === undefined) {
        related.uri = uri;
      }
    }
  }
}

function has_error_diagnostic(diagnostics: SourceDiagnostic[]): boolean {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      return true;
    }
  }

  return false;
}

function core_route_diagnostics(source: SourceNode): SourceDiagnostic[] {
  let core: CoreNode;
  let proof: ReturnType<typeof Core.proof>;

  try {
    core = core_from_source_with_internal_imports(source);
    proof = Core.proof(core);
  } catch (error) {
    if (error instanceof SourceDiagnosticError) {
      return [error.diagnostic];
    }

    const rejection = core_route_rejection_diagnostic(source, error);

    if (rejection !== undefined) {
      return [rejection];
    }

    if (is_core_route_coverage_error(error)) {
      return [];
    }

    throw error;
  }

  const diagnostics: SourceDiagnostic[] = [];
  let needs_source_origin_fallback = false;

  for (const issue of proof.issues) {
    const diagnostic = core_proof_diagnostic(issue);

    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    } else if (core_issue_has_source_diagnostic(issue)) {
      needs_source_origin_fallback = true;
    }
  }

  if (!needs_source_origin_fallback) {
    return diagnostics;
  }

  const source_core = Core.from_source(source);
  const source_proof = Core.proof(source_core);

  for (const issue of source_proof.issues) {
    const diagnostic = core_proof_diagnostic(issue);

    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  if (diagnostics.length === 0) {
    throw new Error("Core diagnostic issue has no source origin");
  }

  return diagnostics;
}

function core_route_rejection_diagnostic(
  source: SourceNode,
  error: unknown,
): SourceDiagnostic | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const type_set_binding_prefix = "Type-set binding annotation expects ";

  if (error.message.startsWith(type_set_binding_prefix)) {
    for (const declaration of source.declarations || []) {
      if (declaration.tag !== "type" || declaration.params.length === 0) {
        continue;
      }

      for (const stmt of source.statements) {
        if (
          stmt.tag === "bind" && stmt.annotation !== undefined &&
          stmt.annotation.startsWith(declaration.name + " ")
        ) {
          return source_diagnostic(
            "IX2306",
            "error",
            error.message,
            stmt.value,
          );
        }
      }
    }

    return undefined;
  }

  const closure_annotation_prefix =
    "Cannot check core first-class closure parameter annotation: ";

  if (error.message.startsWith(closure_annotation_prefix)) {
    const annotation = error.message.slice(closure_annotation_prefix.length);

    for (const declaration of source.declarations || []) {
      if (declaration.tag !== "type" || declaration.params.length === 0) {
        continue;
      }

      if (
        annotation !== declaration.name &&
        !annotation.startsWith(declaration.name + " ")
      ) {
        continue;
      }

      for (const stmt of source.statements) {
        if (stmt.tag !== "bind") {
          continue;
        }

        if (stmt.value.tag !== "lam" && stmt.value.tag !== "rec") {
          continue;
        }

        for (const param of stmt.value.params) {
          if (param.annotation === annotation) {
            return source_diagnostic(
              "IX2307",
              "error",
              error.message,
              param,
            );
          }
        }
      }
    }

    return undefined;
  }

  const unbound_core_value_prefix = "Unbound core value: ";

  if (!error.message.startsWith(unbound_core_value_prefix)) {
    return undefined;
  }

  const name = error.message.slice(unbound_core_value_prefix.length);

  for (const declaration of source.declarations || []) {
    if (
      declaration.tag === "type" && declaration.body.tag === "alias" &&
      declaration.body.type_name === name
    ) {
      return source_diagnostic(
        "IX2290",
        "error",
        "Type alias " + declaration.name + " references unknown type " + name,
        declaration,
      );
    }
  }

  return undefined;
}

function core_issue_has_source_diagnostic(issue: CoreProofIssue): boolean {
  if (
    issue.tag === "freeze" || issue.tag === "scratch_return" ||
    issue.tag === "borrow"
  ) {
    return true;
  }

  return issue.tag === "unsupported_codegen" &&
    issue.issue.feature === "index_assign";
}

function source_for_route_analysis(
  source: SourceNode,
  options: SourceAnalyzeOptions,
): SourceNode | undefined {
  if (source_import_expressions(source).length === 0) {
    return source;
  }

  if (options.uri === undefined || options.resolve_import === undefined) {
    return undefined;
  }

  return resolve_source_imports(source, options.uri, options.resolve_import);
}

function is_core_route_coverage_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith(
    "Cannot type core scratch block with non-scalar unique_heap text result yet",
  );
}

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
Emit.register<SourceNode, IcNode>(Source);
