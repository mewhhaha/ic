import type { ResumeSignature, TypePattern } from "../frontend/ast.ts";
import type { Prim, ValType } from "../op.ts";

export type Core = {
  tag: "program";
  cleanup_emission?: CoreCleanupEmission[];
  capability_methods?: CoreCapabilityMethodFact[];
  host_imports?: Record<string, CoreHostImport>;
  statements: CoreStmt[];
  recFunctions?: Record<string, CoreRecFunction>;
};

export type CoreCleanupEmission = {
  step_id: string;
  allocation_ids: string[];
  edge:
    | "scope_exit"
    | "assignment_replace"
    | "discarded_expr"
    | "return_exit"
    | "break_exit"
    | "continue_exit"
    | "conditional_cleanup"
    | "loop_zero_iteration_cleanup";
  scope: string;
  owner: string | undefined;
  pointer_local: string | undefined;
  statement_index: number | undefined;
  statement_path: number[] | undefined;
  byte_size: import("./allocation.ts").CoreAllocationByteSize;
  alignment: 4 | 8;
  layout: import("./allocation.ts").CoreAllocationLayout;
  owned_children: import("./allocation.ts").CoreAllocationOwnedChild[];
};

export type CoreCapabilityMethodFact = {
  table: string;
  method: string;
  host_import: string;
  representation?: "runtime_aggregate";
};

export type CoreRecFunction = {
  params: CoreParam[];
  body: CoreExpr;
};

export type CoreHostImportArgContract =
  | { tag: "scalar" }
  | { tag: "bounded_borrow" }
  | { tag: "frozen_shareable" }
  | { tag: "ownership_transfer" };

export type CoreHostImportOwnerReason =
  | "text"
  | "closure"
  | "runtime_union"
  | "runtime_aggregate";

export type CoreHostImportResultContract =
  | { tag: "scalar" }
  | { tag: "unique_heap"; reason: CoreHostImportOwnerReason }
  | {
    tag: "frozen_shareable";
    reason: CoreHostImportOwnerReason | "freeze";
  };

export type CoreHostImport = {
  name: string;
  module: string;
  field: string;
  params: ValType[];
  result: ValType;
  result_type_expr?: CoreExpr;
  args: CoreHostImportArgContract[];
  result_owner?: CoreHostImportResultContract;
};

export type CoreFnType = {
  tag: "fn";
  params: ValType[];
  param_texts: boolean[];
  param_structs?: (CoreExpr | undefined)[];
  param_unions?: (CoreExpr | undefined)[];
  result: ValType;
  result_text: boolean;
  result_struct: CoreExpr | undefined;
  result_union: CoreExpr | undefined;
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
  | { tag: "break" }
  | { tag: "continue" }
  | { tag: "return"; value: CoreExpr }
  | { tag: "expr"; expr: CoreExpr }
  | { tag: "unsupported"; feature: string; text: string };

export type CoreExpr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "text"; value: string }
  | { tag: "type_name"; name: string }
  | { tag: "var"; name: string; resume_signature?: ResumeSignature }
  | { tag: "linear"; name: string; resume_signature?: ResumeSignature }
  | { tag: "prim"; prim: Prim; args: CoreExpr[] }
  | {
    tag: "lam";
    params: CoreParam[];
    body: CoreExpr;
    is_linear_closure?: boolean;
  }
  | { tag: "rec"; params: CoreParam[]; body: CoreExpr }
  | { tag: "rec_ref"; name: string; params: CoreParam[] }
  | {
    tag: "app";
    func: CoreExpr;
    args: CoreExpr[];
    resume_payload?: boolean;
  }
  | { tag: "block"; statements: CoreStmt[] }
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
    implicit_else?: boolean;
  }
  | {
    tag: "if_let";
    case_name: string;
    value_name: string | undefined;
    target: CoreExpr;
    then_branch: CoreExpr;
    else_branch: CoreExpr;
    implicit_else?: boolean;
  }
  | {
    tag: "field";
    object: CoreExpr;
    name: string;
    resume_signature?: ResumeSignature;
  }
  | { tag: "index"; object: CoreExpr; index: CoreExpr }
  | {
    tag: "union_case";
    name: string;
    value: CoreExpr | undefined;
    type_expr: CoreExpr | undefined;
    resume_payload?: boolean;
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
