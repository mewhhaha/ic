import type { Ic as IcNode } from "../ic.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  TypeField,
} from "./ast.ts";
import type { CallConstHooks } from "./call_const.ts";

export type CallSpecializeHooks = CallConstHooks & {
  apply_annotation_context: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => FrontExpr;
  can_lower_dynamic_union_if_as_value: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => boolean;
  check_binding_annotation: (
    annotation: string,
    expr: FrontExpr,
    env: Env,
  ) => void;
  infer_union_cases: (expr: FrontExpr, env: Env) => TypeField[] | undefined;
  lower_app_as_front_type: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    type: FrontType,
    env: Env,
  ) => IcNode | undefined;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_annotation_type: (
    annotation: string,
    env: Env,
  ) => FrontType | undefined;
  resolve_dynamic_if_let_struct_value: (
    expr: Extract<FrontExpr, { tag: "if_let" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_dynamic_union_if_target: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_static_if_branch: (
    expr: Extract<FrontExpr, { tag: "if" }>,
    env: Env,
  ) => FrontExpr | undefined;
  resolve_struct_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};
