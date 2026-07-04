import type { Prim, ValType } from "../op.ts";

export type Source = {
  tag: "program";
  statements: Stmt[];
};

export type Stmt =
  | { tag: "import"; name: string; path: string }
  | { tag: "host_import"; value: FrontHostImport }
  | {
    tag: "bind";
    kind: "let" | "const";
    name: string;
    is_recursive?: boolean;
    is_linear: boolean;
    annotation: string | undefined;
    value: FrontExpr;
  }
  | { tag: "assign"; name: string; mode: "same" | "change"; value: FrontExpr }
  | { tag: "index_assign"; name: string; index: FrontExpr; value: FrontExpr }
  | {
    tag: "for_range";
    index: string;
    start: FrontExpr;
    end: FrontExpr;
    step: FrontExpr;
    body: Stmt[];
  }
  | {
    tag: "for_collection";
    index: string | undefined;
    item: string;
    collection: FrontExpr;
    body: Stmt[];
  }
  | { tag: "if_stmt"; cond: FrontExpr; body: Stmt[] }
  | {
    tag: "if_let_stmt";
    case_name: string;
    value_name: string | undefined;
    target: FrontExpr;
    body: Stmt[];
  }
  | { tag: "type_check"; pattern: TypePattern; target: FrontExpr }
  | { tag: "break" }
  | { tag: "continue" }
  | { tag: "return"; value: FrontExpr }
  | { tag: "expr"; expr: FrontExpr }
  | { tag: "unsupported"; feature: string; text: string };

export type FrontExpr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "text"; value: string }
  | { tag: "type_name"; name: string }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; left: FrontExpr; right: FrontExpr }
  | { tag: "lam"; params: Param[]; body: FrontExpr }
  | { tag: "rec"; params: Param[]; body: FrontExpr }
  | { tag: "app"; func: FrontExpr; args: FrontExpr[] }
  | { tag: "block"; statements: Stmt[] }
  | { tag: "comptime"; expr: FrontExpr }
  | { tag: "borrow"; value: FrontExpr }
  | { tag: "freeze"; value: FrontExpr }
  | { tag: "scratch"; body: FrontExpr }
  | { tag: "captured"; expr: FrontExpr; env: Env }
  | { tag: "with"; base: FrontExpr; fields: Field[] }
  | { tag: "struct_type"; fields: TypeField[] }
  | { tag: "struct_value"; type_expr: FrontExpr; fields: Field[] }
  | { tag: "struct_update"; base: FrontExpr; fields: Field[] }
  | { tag: "union_type"; cases: TypeField[] }
  | {
    tag: "if";
    cond: FrontExpr;
    then_branch: FrontExpr;
    else_branch: FrontExpr;
    implicit_else?: boolean;
  }
  | {
    tag: "if_let";
    case_name: string;
    value_name: string | undefined;
    target: FrontExpr;
    then_branch: FrontExpr;
    else_branch: FrontExpr;
    implicit_else?: boolean;
  }
  | { tag: "field"; object: FrontExpr; name: string }
  | { tag: "index"; object: FrontExpr; index: FrontExpr }
  | {
    tag: "union_case";
    name: string;
    value: FrontExpr | undefined;
    type_expr: FrontExpr | undefined;
  }
  | { tag: "linear"; name: string }
  | { tag: "unsupported"; feature: string; text: string };

export type Param = {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
};

export type Field = {
  name: string;
  value: FrontExpr;
};

export type TypeField = {
  name: string;
  type_name: string;
};

export type FrontHostImportArgContract =
  | { tag: "scalar" }
  | { tag: "bounded_borrow"; reason: FrontHostImportOwnerReason }
  | { tag: "frozen_shareable"; reason: FrontHostImportOwnerReason }
  | { tag: "ownership_transfer"; reason: FrontHostImportOwnerReason };

export type FrontHostImportOwnerReason =
  | "text"
  | "closure"
  | "runtime_union"
  | "runtime_aggregate"
  | { tag: "type_ref"; name: string };

export type FrontHostImportResultContract =
  | { tag: "scalar" }
  | { tag: "unique_heap"; reason: FrontHostImportOwnerReason }
  | {
    tag: "frozen_shareable";
    reason: FrontHostImportOwnerReason | "freeze";
  };

export type FrontHostImport = {
  name: string;
  module: string;
  field: string;
  params: ValType[];
  result: ValType;
  args: FrontHostImportArgContract[];
  result_owner: FrontHostImportResultContract | undefined;
};

export type TypePattern = {
  kind: "struct" | "union";
  fields: TypeField[];
  open: boolean;
};

export type TokenKind =
  | "name"
  | "number"
  | "string"
  | "symbol"
  | "newline"
  | "eof";

export type Token = {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
};

export type FrontType =
  | { tag: "int"; type: ValType | undefined }
  | { tag: "text" }
  | { tag: "type" }
  | { tag: "struct"; fields: string[]; field_types: TypeField[] | undefined }
  | { tag: "union"; case_name: string }
  | { tag: "union_value"; cases: TypeField[] }
  | { tag: "unknown" }
  | { tag: "fn"; params: Param[] };

export type Binding = {
  name: string;
  ic_name: string;
  type: FrontType;
  is_const: boolean;
  is_linear: boolean;
  value: FrontExpr | undefined;
  value_env: Env | undefined;
  is_deferred?: boolean;
};

export type Env = {
  scopes: Map<string, Binding>[];
  next: Map<string, number>;
};

export type ResolvedFrontExpr = {
  expr: FrontExpr;
  env: Env;
};

export type ResolvedCallTarget = {
  expr: Extract<FrontExpr, { tag: "lam" }>;
  env: Env;
};
