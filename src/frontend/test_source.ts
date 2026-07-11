// Test-only facade for legacy raw host-boundary fixtures. It is deliberately
// not re-exported by frontend.ts: user source must use declare effect + Init.
import {
  artifact_from_source_with_internal_imports_for_test,
  core_from_source_with_internal_imports_for_test,
  Source,
} from "./source.ts";
import { Core } from "../core.ts";
import type { Ic as IcNode } from "../ic/ast.ts";
import { Mod } from "../mod.ts";
import { Emit, Format } from "../trait.ts";
import { parse_source_with_host_imports_for_test } from "./parser.ts";
import type { Source as SourceNode } from "./ast.ts";

export function TestSource() {}

TestSource.parse = parse_source_with_host_imports_for_test;
TestSource.emit = Source.emit;
TestSource.fmt = Source.fmt;

TestSource.effects = function effects(
  input: string | Parameters<typeof Source.effects>[0],
) {
  if (typeof input === "string") {
    return Source.effects(TestSource.parse(input));
  }

  return Source.effects(input);
};

TestSource.compile = function compile(text: string) {
  return Source.emit(TestSource.parse(text));
};

TestSource.core = function core(
  input: string | Parameters<typeof Source.core>[0],
) {
  if (typeof input === "string") {
    return core_from_source_with_internal_imports_for_test(
      TestSource.parse(input),
    );
  }

  return core_from_source_with_internal_imports_for_test(input);
};

TestSource.mod = function mod(
  input: string | Parameters<typeof Source.mod>[0],
  name?: string,
) {
  return Core.mod(TestSource.core(input), name);
};

TestSource.wat = function wat(
  input: string | Parameters<typeof Source.wat>[0],
  name?: string,
) {
  return Mod.emit(TestSource.mod(input, name));
};

TestSource.artifact = function artifact(
  input: string | Parameters<typeof Source.artifact>[0],
  options?: Parameters<typeof Source.artifact>[1],
) {
  if (typeof input === "string") {
    return artifact_from_source_with_internal_imports_for_test(
      TestSource.parse(input),
      options,
    );
  }

  return artifact_from_source_with_internal_imports_for_test(input, options);
};

TestSource.ic_mod = function ic_mod(
  input: string | Parameters<typeof Source.ic_mod>[0],
  options?: Parameters<typeof Source.ic_mod>[1],
) {
  if (typeof input === "string") {
    return Source.ic_mod(TestSource.parse(input), options);
  }

  return Source.ic_mod(input, options);
};

TestSource.ic_wat = function ic_wat(
  input: string | Parameters<typeof Source.ic_wat>[0],
  options?: Parameters<typeof Source.ic_wat>[1],
) {
  if (typeof input === "string") {
    return Source.ic_wat(TestSource.parse(input), options);
  }

  return Source.ic_wat(input, options);
};

TestSource.load = Source.load;
TestSource.load_fragment_file = Source.load_fragment_file;
TestSource.compile_file = Source.compile_file;
TestSource.core_file = Source.core_file;
TestSource.mod_file = Source.mod_file;
TestSource.wat_file = Source.wat_file;
TestSource.artifact_file = Source.artifact_file;

Format.register<SourceNode>(TestSource);
Emit.register<SourceNode, IcNode>(TestSource);
