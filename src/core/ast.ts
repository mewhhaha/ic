import type { ResumeSignature, TypeExpr, TypePattern } from "../type_syntax.ts";
import type { NumType, Prim, ValType } from "../op.ts";
import type { IntegerType } from "../integer.ts";

export type Core = {
  tag: "program";
  function_params?: CoreParam[];
  cleanup_emission?: CoreCleanupEmission[];
  capability_methods?: CoreCapabilityMethodFact[];
  host_imports?: Record<string, CoreHostImport>;
  statements: CoreStmt[];
  recFunctions?: Record<string, CoreRecFunction>;
  allocation_permit_plan?: import("./model/allocation.ts").CoreAllocationPlan;
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
  replacement_value_local: string | undefined;
  replacement_old_local: string | undefined;
  statement_index: number | undefined;
  statement_path: number[] | undefined;
  byte_size: import("./model/allocation.ts").CoreAllocationByteSize;
  alignment: 4 | 8 | 16;
  layout: import("./model/allocation.ts").CoreAllocationLayout;
  owned_children: import("./model/allocation.ts").CoreAllocationOwnedChild[];
  destructor_type_expr?: CoreExpr;
  destructor?: string;
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
  result_annotation?: string;
  body_stmt?: Extract<CoreStmt, { tag: "expr" }>;
  allocation_permit_plan?: import("./model/allocation.ts").CoreAllocationPlan;
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
  param_constraints?: (string | undefined)[];
  param_structs?: (CoreExpr | undefined)[];
  param_unions?: (CoreExpr | undefined)[];
  param_fns?: (CoreFnType | undefined)[];
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
    force_materialized?: true;
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

export type CoreExpr =
  | {
    tag: "num";
    type: NumType;
    value: number | bigint;
    atom_name?: string;
    character?: string;
    integer?: IntegerType;
  }
  | { tag: "text"; value: string }
  | { tag: "type_name"; name: string }
  | { tag: "var"; name: string; resume_signature?: ResumeSignature }
  | { tag: "linear"; name: string; resume_signature?: ResumeSignature }
  | { tag: "prim"; prim: Prim; args: CoreExpr[]; integer?: IntegerType }
  | {
    tag: "lam";
    params: CoreParam[];
    body: CoreExpr;
    is_linear_closure?: boolean;
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
    resume_payload?: boolean;
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
    move?: true;
    resume_signature?: ResumeSignature;
  }
  | { tag: "index"; object: CoreExpr; index: CoreExpr; move?: true }
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
  set_member?: TypeExpr;
};
