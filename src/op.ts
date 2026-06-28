import { Emit, Fn, Format } from "./trait.ts";

export type ValType = "i32" | "i64";

export type Prim = `${"i32" | "i64"}.${"sub" | "add" | "mul"}`;
export function Prim(prim: Prim): typeof Prim & Prim {
  return Object.assign(Prim.bind(prim), {
    fmt: Prim.fmt.bind(prim),
    arity: Prim.arity.bind(prim),
    emit: Prim.emit.bind(prim),
  }) as typeof Prim & Prim;
}

Prim.fmt = function fmt(this: Prim) {
  switch (this) {
    case "i64.add":
    case "i32.add":
      return "+";
    case "i64.sub":
    case "i32.sub":
      return "-";
    case "i64.mul":
    case "i32.mul":
      return "*";
  }
};
Prim satisfies Format<Prim>;

Prim.arity = function arity(this: Prim) {
  return 2;
};
Prim satisfies Fn<Prim>;

Prim.emit = function emit(this: Prim): string {
  return this;
};
Prim satisfies Emit<Prim, string>;
