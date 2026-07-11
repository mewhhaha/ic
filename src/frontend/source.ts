import type { Ic as IcNode } from "../ic.ts";
import { Core, type Core as CoreNode } from "../core.ts";
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
import { validate_ic_route } from "./ic_route.ts";
import { validate_source_linear } from "./linear.ts";
import { validate_atom_identities } from "./atom.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";
import { load_source, load_source_fragment_file } from "./load.ts";
import { lower_program } from "./lower.ts";
import { parse_source } from "./parser.ts";

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

export function Source() {}

Source.parse = parse_source;

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

  const effect_source = elaborate_front_effects(source);
  const compiled_source = elaborate_front_type_sets(effect_source);
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
  return core_from_elaborated_source(
    elaborate_front_type_sets(elaborate_front_effects(source)),
  );
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

Format.register<SourceNode>(Source);
Emit.register<SourceNode, IcNode>(Source);
