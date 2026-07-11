import type { Prim, ValType } from "../op.ts";

export type Source = {
  tag: "program";
  module?: ModuleHeader;
  declarations?: Declaration[];
  statements: Stmt[];
};

export type ModuleHeader = {
  params: Param[];
};

export type Declaration =
  | EffectDeclaration
  | RecordDeclaration
  | TypeDeclaration;

export type EffectDeclaration = {
  tag: "effect";
  implementation: "host" | "ix";
  name: string;
  operations: EffectOperation[];
};

export type EffectOperation = {
  name: string;
  params: EffectParam[];
  result: EffectResult;
};

export type EffectParam = {
  type_name: string;
  ownership:
    | "scalar"
    | "bounded_borrow"
    | "frozen_shareable"
    | "ownership_transfer";
};

export type EffectResult = {
  type_name: string;
  ownership: "scalar" | "unique_heap" | "frozen_shareable";
};

export type RecordDeclaration = {
  tag: "record";
  name: string;
  fields: TypeField[];
};

export type TypeDeclaration = {
  tag: "type";
  name: string;
  params: string[];
  body:
    | { tag: "product"; fields: TypeField[]; positional: boolean }
    | { tag: "sum"; cases: TypeField[] }
    | { tag: "alias"; type_name: string };
  recursive: boolean;
};

export type EffectRef = {
  effect: string;
  operation: string;
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
  | {
    tag: "arrow";
    param: TypeExpr;
    effects: EffectRowExpr | undefined;
    result: TypeExpr;
  };

export type BindingPatternItem = {
  name: string;
  is_linear: boolean;
};

export type HandlerState = {
  name: string;
  annotation: string | undefined;
  value: FrontExpr;
};

export type HandlerClause = {
  name: string;
  params: Param[];
  body: FrontExpr;
};

export type HandlerReturnClause = {
  param: Param;
  body: FrontExpr;
};

export type ResumeSignature = {
  input_type: string;
  output_type: string;
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
    type_annotation?: TypeExpr;
    effectful?: boolean;
    value: FrontExpr;
  }
  | {
    tag: "state_bind";
    value_name: string | undefined;
    value: FrontExpr;
  }
  | {
    tag: "bind_pattern";
    kind: "let" | "const";
    items: BindingPatternItem[];
    value: FrontExpr;
  }
  | {
    tag: "resume_dup";
    left: string;
    right: string;
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
  | { tag: "break"; value?: FrontExpr }
  | { tag: "continue" }
  | { tag: "return"; value: FrontExpr }
  | { tag: "expr"; expr: FrontExpr; effectful?: boolean }
  | { tag: "unsupported"; feature: string; text: string };

export type FrontExpr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "atom"; name: string }
  | { tag: "unit" }
  | { tag: "text"; value: string }
  | { tag: "type_name"; name: string }
  | { tag: "var"; name: string; resume_signature?: ResumeSignature }
  | { tag: "prim"; prim: Prim; left: FrontExpr; right: FrontExpr }
  | { tag: "lam"; params: Param[]; body: FrontExpr }
  | { tag: "rec"; params: Param[]; body: FrontExpr }
  | {
    tag: "app";
    func: FrontExpr;
    args: FrontExpr[];
    resume_payload?: boolean;
  }
  | { tag: "block"; statements: Stmt[] }
  | { tag: "comptime"; expr: FrontExpr }
  | { tag: "borrow"; value: FrontExpr }
  | { tag: "freeze"; value: FrontExpr }
  | { tag: "scratch"; body: FrontExpr }
  | { tag: "loop"; body: Stmt[] }
  | { tag: "captured"; expr: FrontExpr; env: Env }
  | {
    tag: "handler";
    effect: string;
    state: HandlerState[];
    clauses: HandlerClause[];
    return_clause: HandlerReturnClause;
  }
  | { tag: "try_with"; body: FrontExpr; handler: FrontExpr }
  | { tag: "with"; base: FrontExpr; fields: Field[] }
  | { tag: "set_type"; type_expr: TypeExpr }
  | { tag: "struct_type"; fields: TypeField[] }
  | {
    tag: "struct_value";
    type_expr: FrontExpr;
    fields: Field[];
    bracketed?: "named" | "positional";
  }
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
  | {
    tag: "field";
    object: FrontExpr;
    name: string;
    resume_signature?: ResumeSignature;
  }
  | { tag: "index"; object: FrontExpr; index: FrontExpr }
  | { tag: "is"; value: FrontExpr; type_expr: TypeExpr }
  | {
    tag: "union_case";
    name: string;
    value: FrontExpr | undefined;
    type_expr: FrontExpr | undefined;
    resume_payload?: boolean;
  }
  | { tag: "linear"; name: string; resume_signature?: ResumeSignature }
  | { tag: "unsupported"; feature: string; text: string };

export type Param = {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
  type_annotation?: TypeExpr;
};

export type Field = {
  name: string;
  value: FrontExpr;
};

export type TypeField = {
  name: string;
  type_name: string;
  set_member?: TypeExpr;
};

export type FrontHostImportArgContract =
  | { tag: "scalar" }
  | { tag: "bounded_borrow"; reason: FrontHostImportOwnerReason }
  | { tag: "frozen_shareable"; reason: FrontHostImportOwnerReason }
  | { tag: "ownership_transfer"; reason: FrontHostImportOwnerReason };

export type FrontHostImportOwnerReason =
  | "text"
  | "bytes"
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
  | "character"
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
  | { tag: "never" }
  | { tag: "int"; type: ValType | undefined }
  | { tag: "atom"; name: string }
  | { tag: "text"; encoding?: "bytes" }
  | { tag: "type" }
  | { tag: "set"; type_expr: TypeExpr }
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
