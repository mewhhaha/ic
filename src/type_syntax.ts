export type ResumeSignature = {
  input_type: string;
  output_type: string;
};

export type EffectRowExpr =
  | { tag: "family"; name: string }
  | { tag: "operation"; effect: string; operation: string }
  | { tag: "variable"; name: string }
  | { tag: "group"; value: EffectRowExpr }
  | { tag: "union"; left: EffectRowExpr; right: EffectRowExpr }
  | { tag: "intersection"; left: EffectRowExpr; right: EffectRowExpr }
  | { tag: "difference"; left: EffectRowExpr; right: EffectRowExpr };

export type TypeExpr =
  | { tag: "name"; name: string }
  | { tag: "forall"; params: string[]; body: TypeExpr }
  | { tag: "atom"; name: string }
  | { tag: "top" }
  | { tag: "never" }
  | { tag: "frozen"; value: TypeExpr }
  | { tag: "borrow"; value: TypeExpr }
  | { tag: "union"; left: TypeExpr; right: TypeExpr }
  | { tag: "intersection"; left: TypeExpr; right: TypeExpr }
  | { tag: "difference"; left: TypeExpr; right: TypeExpr }
  | { tag: "apply"; func: TypeExpr; arg: TypeExpr }
  | { tag: "tuple"; items: TypeExpr[] }
  | { tag: "product"; entries: TypeProductEntry[] }
  | { tag: "array"; element: TypeExpr; length: ArrayLengthExpr }
  | {
    tag: "arrow";
    param: TypeExpr;
    effects: EffectRowExpr | undefined;
    result: TypeExpr;
  };

export type TypeProductEntry = {
  label?: string;
  type_expr: TypeExpr;
};

export type ArrayLengthExpr =
  | { tag: "number"; value: number }
  | { tag: "name"; name: string }
  | {
    tag: "binary";
    op: "+" | "-" | "*" | "/" | "%";
    left: ArrayLengthExpr;
    right: ArrayLengthExpr;
  };

export type TypeField = {
  name: string;
  type_name: string;
  set_member?: TypeExpr;
};

export type TypePattern = {
  kind: "struct" | "union";
  fields: TypeField[];
  open: boolean;
};
