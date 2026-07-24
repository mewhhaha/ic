import type { TypePattern } from "../type_syntax.ts";
import type { NumType, Prim } from "../op.ts";
import type { IntegerType } from "../integer.ts";

export type Core = {
  tag: "program";
  host_imports?: string[];
  statements: CoreStmt[];
  recFunctions?: Record<string, CoreRecFunction>;
};

export type CoreRecFunction = {
  params: CoreParam[];
  body: CoreExpr;
  result_annotation?: string;
};

export type CoreStmt =
  | {
    tag: "bind";
    kind: "let" | "const";
    name: string;
    is_linear: boolean;
    annotation: string | undefined;
    value: CoreExpr;
  }
  | { tag: "assign"; name: string; mode: "same" | "change"; value: CoreExpr }
  | { tag: "index_assign"; name: string; index: CoreExpr; value: CoreExpr }
  | {
    tag: "range_loop";
    index: string;
    start: CoreExpr;
    end: CoreExpr;
    end_bound: "exclusive" | "inclusive";
    step: CoreExpr;
    carried: string[];
    body: CoreStmt[];
  }
  | {
    tag: "collection_loop";
    index: string | undefined;
    item: string;
    collection: CoreExpr;
    carried: string[];
    body: CoreStmt[];
  }
  | { tag: "if_stmt"; cond: CoreExpr; body: CoreStmt[] }
  | {
    tag: "if_else_stmt";
    cond: CoreExpr;
    then_body: CoreStmt[];
    else_body: CoreStmt[];
  }
  | {
    tag: "if_let_stmt";
    case_name: string;
    value_name: string | undefined;
    target: CoreExpr;
    body: CoreStmt[];
  }
  | { tag: "type_check"; pattern: TypePattern; target: CoreExpr }
  | { tag: "break"; value?: CoreExpr }
  | { tag: "continue" }
  | { tag: "return"; value: CoreExpr }
  | { tag: "expr"; expr: CoreExpr }
  | { tag: "unsupported"; feature: string; text: string };

export type CoreExpr = CoreExprNode;

type CoreExprNode =
  | {
    tag: "num";
    type: NumType;
    value: number | bigint;
    integer?: IntegerType;
  }
  | { tag: "text"; value: string }
  | { tag: "type_name"; name: string }
  | { tag: "var"; name: string }
  | { tag: "linear"; name: string }
  | { tag: "prim"; prim: Prim; args: CoreExpr[]; integer?: IntegerType }
  | {
    tag: "lam";
    params: CoreParam[];
    body: CoreExpr;
  }
  | {
    tag: "rec";
    params: CoreParam[];
    body: CoreExpr;
    result_annotation?: string;
  }
  | {
    tag: "rec_ref";
    name: string;
    params: CoreParam[];
    result_annotation?: string;
  }
  | {
    tag: "app";
    func: CoreExpr;
    args: CoreExpr[];
  }
  | { tag: "block"; statements: CoreStmt[] }
  | { tag: "loop"; body: CoreStmt[] }
  | { tag: "comptime"; expr: CoreExpr }
  | { tag: "borrow"; value: CoreExpr }
  | { tag: "freeze"; value: CoreExpr }
  | { tag: "scratch"; body: CoreExpr }
  | { tag: "with"; base: CoreExpr; fields: CoreField[] }
  | { tag: "struct_type"; fields: CoreTypeField[] }
  | { tag: "struct_value"; type_expr: CoreExpr; fields: CoreField[] }
  | { tag: "struct_update"; base: CoreExpr; fields: CoreField[] }
  | { tag: "union_type"; cases: CoreTypeField[] }
  | {
    tag: "if";
    cond: CoreExpr;
    then_branch: CoreExpr;
    else_branch: CoreExpr;
  }
  | {
    tag: "if_let";
    case_name: string;
    value_name: string | undefined;
    target: CoreExpr;
    then_branch: CoreExpr;
    else_branch: CoreExpr;
  }
  | {
    tag: "field";
    object: CoreExpr;
    name: string;
  }
  | { tag: "index"; object: CoreExpr; index: CoreExpr }
  | {
    tag: "union_case";
    name: string;
    value: CoreExpr | undefined;
    type_expr: CoreExpr | undefined;
  }
  | { tag: "unsupported"; feature: string; text: string };

export type CoreField = {
  name: string;
  value: CoreExpr;
};

export type CoreParam = {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
};

export type CoreTypeField = {
  name: string;
  type_name: string;
};
