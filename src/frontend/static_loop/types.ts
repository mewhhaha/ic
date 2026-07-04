import type { Env, FrontExpr, FrontType, Stmt, TypeField } from "../ast.ts";

export type LoopControl = "none" | "break" | "continue" | "return";

export type ExpandedLoopBody = {
  statements: Stmt[];
  control: LoopControl;
};

export type ForCollectionStmt = Extract<Stmt, { tag: "for_collection" }>;

export type CollectionLoopItem = {
  index: number;
  value: FrontExpr;
};

export type StaticLoopHooks = {
  eval_i32_expr: (expr: FrontExpr, env: Env, label: string) => number;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  infer_union_cases: (expr: FrontExpr, env: Env) => TypeField[] | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
  resolve_text_bytes: (expr: FrontExpr, env: Env) => number[] | undefined;
};
