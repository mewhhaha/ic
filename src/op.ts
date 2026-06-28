export const OPS = {
  add: "+",
  sub: "-",
  mul: "*",
} as const;

export type Op = keyof typeof OPS;
export type ValType = "i32" | "i64";

export const WAT_OPS = {
  i32: {
    add: "i32.add",
    sub: "i32.sub",
    mul: "i32.mul",
  },
  i64: {
    add: "i64.add",
    sub: "i64.sub",
    mul: "i64.mul",
  },
} as const;

export function isOp(tag: string): tag is Op {
  return tag in OPS;
}

export function watOp(type: ValType, op: Op): string {
  return WAT_OPS[type][op];
}
