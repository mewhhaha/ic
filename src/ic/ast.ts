import type { NumType, Prim } from "../op.ts";
import type { IntegerType } from "../integer.ts";

export type Ic =
  | {
    tag: "num";
    type: NumType;
    value: number | bigint;
    integer?: IntegerType;
  }
  | { tag: "text"; value: string }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: Ic[] }
  | { tag: "lam"; name: string; body: Ic }
  | { tag: "app"; func: Ic; arg: Ic }
  | { tag: "sup"; label: string; left: Ic; right: Ic }
  | { tag: "dup"; label: string; name: string; expr: Ic; body: Ic }
  | { tag: "era"; expr: Ic; body: Ic }
  | { tag: "fix"; name: string; expr: Ic; body: Ic };
