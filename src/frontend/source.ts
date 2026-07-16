import type { Ic as IcNode } from "../ic.ts";
import {
  Core,
  type Core as CoreNode,
  core_proof_diagnostic,
  type CoreProofIssue,
} from "../core.ts";
import { diagnostic_codes, diagnostic_sequence } from "../diagnostic.ts";
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
import { diagnose_ic_route } from "./ic_route.ts";
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
} from "./import_diagnostic.ts";
import { analyze_core_demand } from "../core/demand.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
  SourceDiagnosticError,
} from "./semantic_diagnostic.ts";
import type { SyntaxDiagnostic } from "./syntax.ts";
import {
  analyze_frontend,
  source_effects,
  source_for_core_route,
  source_for_ic_route,
} from "./pipeline.ts";

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

  const analysis = analyze_frontend(parsed, source, options);
  const diagnostics = analysis.diagnostics;

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

  const ordered_diagnostics = diagnostic_sequence(diagnostics, options.uri);

  return {
    source,
    syntax: parsed.syntax,
    syntax_diagnostics: parsed.diagnostics,
    diagnostics: ordered_diagnostics,
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
  return lower_program(source_for_ic_route(source));
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

  source = source_with_managed_callable_exports(source);
  const compiled_source = source_for_core_route(source);
  const abi = build_abi_manifest(source, compiled_source);
  const core = core_from_elaborated_source(compiled_source);
  const mod = managed_abi_mod(Core.mod(core, name), abi);
  return {
    mod,
    wat: Mod.emit(mod),
    abi,
  };
}

function source_with_managed_callable_exports(source: SourceNode): SourceNode {
  const final_stmt = source.statements[source.statements.length - 1];

  if (
    !final_stmt || final_stmt.tag !== "return" ||
    final_stmt.value.tag !== "struct_value"
  ) {
    return source;
  }

  const bindings = new Map<
    string,
    Extract<SourceNode["statements"][number], { tag: "bind" }>
  >();

  for (const stmt of source.statements) {
    if (stmt.tag === "bind") {
      bindings.set(stmt.name, stmt);
    }
  }

  const managed_names = new Set<string>();
  const result_fields: typeof final_stmt.value.fields = [];

  for (const field of final_stmt.value.fields) {
    if (field.value.tag !== "var") {
      result_fields.push(field);
      continue;
    }

    const binding = bindings.get(field.value.name);

    if (
      !binding || binding.type_annotation?.tag !== "arrow" ||
      (binding.value.tag !== "lam" && binding.value.tag !== "rec")
    ) {
      result_fields.push(field);
      continue;
    }

    if (field.name !== binding.name) {
      throw new Error(
        "Managed callable export field must match its binding name: " +
          field.name + " refers to " + binding.name,
      );
    }

    managed_names.add(binding.name);
  }

  if (managed_names.size === 0) {
    return source;
  }

  const effects = analyze_front_effects(source);

  for (const name of managed_names) {
    const binding = bindings.get(name);

    if (!binding || binding.type_annotation?.tag !== "arrow") {
      throw new Error("Missing managed callable binding: " + name);
    }

    const function_effects = effects.functions[name];

    if (
      binding.type_annotation.effects !== undefined ||
      (function_effects && function_effects.effects.length > 0)
    ) {
      throw new Error(
        "Managed callable exports cannot use effects yet: " + name,
      );
    }
  }

  const managed_return: typeof final_stmt = {
    ...final_stmt,
    value: { ...final_stmt.value, fields: result_fields },
  };
  const statements: SourceNode["statements"] = source.statements.map((stmt) => {
    if (stmt === final_stmt) {
      return managed_return;
    }

    if (stmt.tag === "bind" && managed_names.has(stmt.name)) {
      return { ...stmt, kind: "let", managed_export: true };
    }

    return stmt;
  });

  return { ...source, statements };
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
    if (declaration.tag === "extend" || declaration.tag === "fixity") {
      continue;
    }

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
  return core_from_elaborated_source(source_for_core_route(source));
}

function core_from_elaborated_source(source: SourceNode): CoreNode {
  return analyze_core_demand(Core.from_source(source));
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
            diagnostic_codes.annotation_type_mismatch,
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
              diagnostic_codes.call_type_mismatch,
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
        diagnostic_codes.affine_form_unsupported,
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
  if (source.module !== undefined) {
    const const_functions = new Set<string>();

    for (const stmt of source.statements) {
      if (stmt.tag !== "bind" || stmt.kind !== "const") {
        continue;
      }

      if (stmt.value.tag === "lam" || stmt.value.tag === "rec") {
        const_functions.add(stmt.name);
        continue;
      }

      if (stmt.value.tag === "var" && const_functions.has(stmt.value.name)) {
        const_functions.add(stmt.name);
      }
    }

    const final_stmt = source.statements[source.statements.length - 1];

    if (
      final_stmt?.tag === "return" &&
      final_stmt.value.tag === "struct_value"
    ) {
      for (const field of final_stmt.value.fields) {
        // Compile-time module functions are specialized at import sites and
        // have no standalone runtime result for the Core proof route.
        if (field.value.tag === "lam" || field.value.tag === "rec") {
          return undefined;
        }

        if (
          field.value.tag === "var" && const_functions.has(field.value.name)
        ) {
          return undefined;
        }
      }
    }
  }

  if (source_import_expressions(source).length === 0) {
    return source;
  }

  if (options.uri === undefined || options.resolve_import === undefined) {
    return undefined;
  }

  return resolve_source_imports(source, options.uri, options.resolve_import);
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
