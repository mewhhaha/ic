import type { Ic as IcNode } from "../ic.ts";
import { Core, type Core as CoreNode } from "../core.ts";
import { Ic } from "../ic.ts";
import type { IcOpenOptions } from "../ic/open_term.ts";
import { Mod, type Mod as ModNode } from "../mod.ts";
import type { Emit, Format } from "../trait.ts";
import type { Wat } from "../wat.ts";
import type { Source as SourceNode } from "./ast.ts";
import { format_source } from "./format.ts";
import { validate_source_linear } from "./linear.ts";
import { load_source } from "./load.ts";
import { lower_program } from "./lower.ts";
import { parse_source } from "./parser.ts";

export type Source = SourceNode;

export function Source() {}

Source.parse = parse_source;

Source.emit = lower_program;

Source.fmt = format_source;

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

  validate_source_linear(source);
  return Core.from_source(source);
};

Source.mod = function mod(input: string | SourceNode, name = "main"): ModNode {
  return Core.mod(Source.core(input), name);
};

Source.wat = function wat(input: string | SourceNode, name = "main"): Wat {
  return Mod.emit(Source.mod(input, name));
};

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

Source satisfies Format<SourceNode> & Emit<SourceNode, IcNode>;
