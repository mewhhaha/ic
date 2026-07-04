import type { Ic as IcNode } from "../ic.ts";
import type { Prim } from "../op.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  Stmt,
} from "./ast.ts";
import type { TypedFrontExpr } from "./typed_lower.ts";

export type ExprLowerHooks = {
  apply_struct_update: (
    expr: Extract<FrontExpr, { tag: "struct_update" }>,
    env: Env,
  ) => FrontExpr;
  can_lower_dynamic_union_if_as_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => boolean;
  check_numeric_primitive_operands: (
    expr: Extract<FrontExpr, { tag: "prim" }>,
    env: Env,
  ) => Prim;
  check_dynamic_function_if_args: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => TypedFrontExpr[] | undefined;
  check_text_concat_operand_visibility: (
    expr: Extract<FrontExpr, { tag: "prim" }>,
    env: Env,
  ) => void;
  declared_struct_field_type: (
    object: FrontExpr,
    field_name: string,
    env: Env,
  ) => string | undefined;
  declared_struct_index_type: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => string | undefined;
  lower_builtin_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_dynamic_index_access: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_dynamic_union_if: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode | undefined;
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  lower_expr_as_declared_type: (
    expr: FrontExpr,
    env: Env,
    type_name: string | undefined,
  ) => IcNode;
  lower_if_expr: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => IcNode;
  lower_if_let: (
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    env: Env,
  ) => IcNode;
  inline_runtime_call_expr: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  lower_method_app: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_struct_field_access: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_struct_index_access: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_runtime_text_byte_index: (
    object: FrontExpr,
    index: FrontExpr,
    env: Env,
  ) => IcNode | undefined;
  lower_specialized_app: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_static_rec_app: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => IcNode | undefined;
  lower_app_as_front_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
  lower_static_text_byte_index: (
    object: FrontExpr,
    index: number,
    env: Env,
  ) => IcNode | undefined;
  lower_statements: (stmts: Stmt[], index: number, env: Env) => IcNode;
  lower_struct_value: (
    expr: Extract<FrontExpr, { tag: "struct_value" }>,
    env: Env,
  ) => IcNode;
  lower_union_case_value: (
    expr: Extract<FrontExpr, { tag: "union_case" }>,
    env: Env,
  ) => IcNode;
  requires_specialized_call: (
    expr: Extract<FrontExpr, { tag: "lam" }>,
    env: Env,
  ) => boolean;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_const_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => FrontExpr | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => { expr: FrontExpr; env: Env } | undefined;
  resolve_static_i32_expr: (
    expr: FrontExpr,
    env: Env,
  ) => number | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => { expr: FrontExpr; env: Env } | undefined;
  resolve_union_constructor_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) =>
    | { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env }
    | undefined;
  try_eval_all_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => FrontExpr | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export type LowerExprFn = (
  expr: FrontExpr,
  env: Env,
  hooks: ExprLowerHooks,
) => IcNode;
