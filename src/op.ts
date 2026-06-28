import type { Callable, CallableType, Emit, Format } from "./trait.ts";

export type ValType = "i32" | "i64";
type PrimOp = "add" | "sub" | "mul";

export type Prim = `${ValType}.${PrimOp}`;

export function Prim() {}

Prim.fmt = function fmt(prim: Prim): string {
  switch (prim) {
    case "i32.add":
    case "i64.add":
      return "+";

    case "i32.sub":
    case "i64.sub":
      return "-";

    case "i32.mul":
    case "i64.mul":
      return "*";
  }
};

Prim.type = function type(prim: Prim): CallableType<ValType> {
  switch (prim) {
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
      return { args: ["i32", "i32"], result: "i32" };

    case "i64.add":
    case "i64.sub":
    case "i64.mul":
      return { args: ["i64", "i64"], result: "i64" };
  }
};

Prim.arity = function arity(_prim: Prim): number {
  // return Prim.type(prim).args.length;
  // for simplicity's sake return 2 for now
  return 2;
};

Prim.emit = function emit(prim: Prim): string {
  return prim;
};

Prim satisfies Format<Prim> & Callable<Prim, ValType> & Emit<Prim, string>;
