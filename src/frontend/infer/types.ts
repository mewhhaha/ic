import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "../ast.ts";

export type InferHooks = {
  check_text_concat_operand_visibility: (
    expr: Extract<FrontExpr, { tag: "prim" }>,
    env: Env,
  ) => void;
  infer_call_union_result_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  infer_static_rec_app_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  infer_specialized_app_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontType | undefined;
  infer_dynamic_union_if_cases: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => TypeField[] | undefined;
  infer_union_cases: (
    expr: FrontExpr,
    env: Env,
  ) => TypeField[] | undefined;
  maybe_struct_type_value: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "struct_type" }> | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "struct_value" }>; env: Env }
    | undefined;
  resolve_struct_value_type_fields: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => TypeField[] | undefined;
  resolve_union_constructor_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  resolve_union_type_value: (
    expr: FrontExpr,
    env: Env,
  ) => Extract<FrontExpr, { tag: "union_type" }> | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export type InferExprFn = (
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
) => FrontType;
