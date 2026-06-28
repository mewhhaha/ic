import { expect } from "./expect.ts";
import type { ValType } from "./op.ts";
import type { Emit, Format } from "./trait.ts";
import { indent, type Wat } from "./wat.ts";

export type Func = {
  name: string;
  result: ValType;
  body: Wat;
};

const Func = function Func(func: Func): typeof Func & Func {
  return Object.assign(Func.bind(func), {
    fmt: (Func as any).fmt.bind(func),
  }) as unknown as typeof Func & Func;
} as any;

Func.fmt = function (this: Func): Wat {
  return `(func $${this.name} (result ${this.result})\n${
    indent(this.body, 2)
  }\n)`;
};

Func satisfies Format<Func>;

export type Mod = {
  funcs: Record<string, Func>;
  exports: string[];
};

export function Mod(mod: Mod): typeof Mod & Mod {
  return Object.assign(Mod.bind(mod), {
    emit: Mod.emit.bind(mod),
  }) as typeof Mod & Mod;
}

Mod.emit = function (this: Mod): Wat {
  const parts = ["(module"];
  const funcs: Wat[] = [];

  for (const name in this.funcs) {
    const func = this.funcs[name];
    expect(func, "Missing function: " + name);
    expect(func.name === name, "Function key/name mismatch: " + name);
    funcs.push(Func(func).fmt());
  }

  if (funcs.length > 0) {
    parts.push(indent(funcs.join("\n\n"), 2));
  }

  for (const name of this.exports) {
    expect(this.funcs[name], "Missing function for export: " + name);
    parts.push(`  (export "${name}" (func $${name}))`);
  }

  parts.push(")");
  return parts.join("\n");
};

Mod satisfies Emit<Mod, Wat>;
