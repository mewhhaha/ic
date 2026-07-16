import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../model/runtime_union.ts";
import type { CoreOwnership } from "../model/ownership.ts";

export type {
  CoreOwnership,
  CoreOwnershipPointerReason,
} from "../model/ownership.ts";

export type CoreOwnershipHooks<ctx> = {
  bind_core_if_let_payload_fact?: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => void;
  bind_dynamic_if_let_payload?: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: ctx,
  ) => void;
  block_ctx?: (ctx: ctx) => ctx;
  closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
  collect_stmt_locals?: (stmt: CoreStmt, ctx: ctx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  dynamic_union_if?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  frozen_local?: (name: string, ctx: ctx) => boolean;
  host_import_result_ownership?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreOwnership | undefined;
  if_let_branch_ctx?: (ctx: ctx) => ctx;
  runtime_aggregate_type_expr?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_match_info?: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => RuntimeUnionTarget | undefined;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  scratch_return_ctx?: (ctx: ctx) => ctx;
  static_runtime_union_match_branch_ctx?: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => ctx;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_core_call_value?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_capture_value?: (name: string, ctx: ctx) => CoreExpr | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  scoped_static_core_call_value?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_union_case?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};
