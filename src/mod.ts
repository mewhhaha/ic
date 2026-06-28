import { expect } from "./expect.ts";
import type { ValType } from "./op.ts";
import type { Emit, Format } from "./trait.ts";
import { indent, type Wat } from "./wat.ts";

export type Func = {
  name: string;
  result: ValType;
  body: Wat;
};

export function Func() {}

Func.fmt = function fmt(func: Func): Wat {
  return `(func $${func.name} (result ${func.result})\n${
    indent(func.body, 2)
  }\n)`;
};

Func satisfies Format<Func>;

export type Mod = {
  funcs: Record<string, Func>;
  exports: string[];
};

export function Mod() {}

Mod.emit = function emit(mod: Mod): Wat {
  const parts = ["(module"];
  const funcs: Wat[] = [];

  for (const name in mod.funcs) {
    const func = mod.funcs[name];
    expect(func, "Missing function: " + name);
    expect(func.name === name, "Function key/name mismatch: " + name);
    funcs.push(Func.fmt(func));
  }

  if (funcs.length > 0) {
    parts.push(indent(funcs.join("\n\n"), 2));
  }

  for (const name of mod.exports) {
    expect(mod.funcs[name], "Missing function for export: " + name);
    parts.push(`  (export "${name}" (func $${name}))`);
  }

  parts.push(")");
  return parts.join("\n");
};

Mod satisfies Emit<Mod, Wat>;
